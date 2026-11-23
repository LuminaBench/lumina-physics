import { expect, test } from '@playwright/test';
import { PuddleContacts } from '../modules/wet-road/puddle-contacts';
import { openScene, watchConsole } from './helpers';

const surface = { heightAt: () => 0, puddleDepth: (x: number) => x >= 0 ? 0.018 : 0 };

test('outsole entry, planted foot, dry margins, stationary wheels and packet expiry', () => {
  const pool = new PuddleContacts(surface), foot = pool.contact('foot');
  const point = { x: 0.4, y: 0.3, z: 0 }, velocity = { x: 0, y: -1.5, z: 0 };
  foot.sample(point, velocity, 1 / 60);
  expect(pool.activeCount).toBe(0);
  point.y = 0.01;
  for (let i = 0; i < 70; i++) { foot.sample(point, velocity, 1 / 60); pool.update(1 / 60); }
  expect(pool.activeCount).toBe(1);
  foot.reset();
  foot.sample({ ...point, x: -1 }, velocity, 1 / 60);
  const wheel = pool.contact('wheel');
  const parked = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 60; i++) wheel.sample(point, parked, 1 / 60);
  expect(pool.activeCount).toBe(1);
  pool.update(1);
  expect(pool.activeCount).toBe(0);
});

test('a rolling bicycle samples the same wet path at 30, 60 and 120 Hz', () => {
  const travel = (hz: number) => {
    const pool = new PuddleContacts(surface), wheel = pool.contact('wheel', 0.04);
    const p = { x: -0.45, y: 0.002, z: 0 }, v = { x: 2, y: 0, z: 0 };
    for (let i = 0; i <= hz; i++) {
      p.x = -0.45 + 2 * i / hz;
      wheel.sample(p, v, 1 / hz);
      pool.update(1 / hz);
    }
    return pool.activeCount;
  };
  const count = travel(30);
  expect(count).toBeGreaterThan(5); expect(travel(60)).toBe(count); expect(travel(120)).toBe(count);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' submerged road paint shifts by the refracted path through real water depth', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    const shift = await page.evaluate(async () => {
      const { engine, scene: { road } } = (window as any).lumina, T = (window as any).THREE, n = T.TSL;
      engine.stop();
      const sample = (degrees: number, metres: number) => {
        const a = degrees * Math.PI / 180;
        return road.contacts.bedXZNode(n.vec2(0), n.vec3(Math.sin(a), Math.cos(a), 0), n.vec3(0, 1, 0), n.float(metres)).x;
      };
      const mat = new T.NodeMaterial(); mat.fragmentNode = n.vec4(sample(0, 0.05), sample(75, 0.05), sample(75, 0), 1);
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const r = engine.renderer, prev = r.getRenderTarget();
      try {
        r.setRenderTarget(target); new T.QuadMesh(mat).render(r); r.setRenderTarget(prev);
        return Array.from(await r.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)) as number[];
      } finally { r.setRenderTarget(prev); mat.dispose(); target.dispose(); }
    });
    const transmitted = Math.asin(Math.sin(75 * Math.PI / 180) / 1.333);
    expect(shift[0]).toBeCloseTo(0, 6);
    expect(shift[1]).toBeCloseTo(-0.05 * Math.tan(transmitted), 5);
    expect(shift[2]).toBeCloseTo(0, 6); expect(log.errors).toEqual([]);
  });
  test(backend + ' footstep changes the puddle gradient beside the contact and decays to zero', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    const samples = await page.evaluate(async () => {
      const { engine, scene: { road } } = (window as any).lumina, T = (window as any).THREE;
      engine.stop(); road.contacts.update(4);
      road.params.flood = 0.92; road.vehicleLighting = false;
      const foot = road.contacts.contact('foot'), pos = new T.Vector3(-3.2, 0, 85);
      pos.y = road.heightAt(pos.x, pos.z); const v = new T.Vector3(0, -1.5, 0);
      const n = T.TSL, xz = n.vec2(n.uv().x.mul(0.6).add(pos.x), pos.z);
      const mat = new T.NodeMaterial(); mat.fragmentNode = n.vec4(road.contacts.slopeNode(xz), 0, 1);
      const target = new T.RenderTarget(64, 1, { type: T.FloatType, depthBuffer: false });
      const quad = new T.QuadMesh(mat), r = engine.renderer, old = r.getRenderTarget();
      async function read() {
        r.setRenderTarget(target); quad.render(r); r.setRenderTarget(old);
        const data = await r.readRenderTargetPixelsAsync(target, 0, 0, 64, 1);
        const slopes = Array.from({ length: 64 }, (_, i) => Math.abs(data[4 * i]));
        return { near: Math.max(...slopes.slice(0, 24)), far: Math.max(...slopes.slice(-9)) };
      }
      try {
        const before = await read();
        foot.sample(pos, v, 1 / 60);
        road.update(0.12);
        const wave = await read();
        road.update(2);
        return { before, wave, after: await read() };
      } finally { r.setRenderTarget(old); target.dispose(); mat.dispose(); }
    });
    expect(samples.before.near).toBe(0);
    expect(samples.wave.near).toBeGreaterThan(0.012);
    expect(samples.wave.far).toBeLessThan(0.001);
    expect(samples.after.near).toBe(0);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' hair moving with a uniform breeze settles like hair in still air', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'river', 'high', backend);
    const read = await page.evaluate(async () => {
      const { engine, scene: { strands } } = (window as any).lumina, T = (window as any).THREE;
      engine.stop();
      async function run(headSpeed: number, windSpeed: number) {
        const system = new strands.constructor(engine, { groundY: -2, detail: 1 });
        const head = new T.Group(); head.position.set(0, 45, 0);
        const hair = system.hair({ seed: 2, count: 16, segments: 4, length: [0.32, 0.32], follow: head, flutter: 0.8 });
        engine.wind.set(0, windSpeed, 0); engine.wind.update(0);
        try {
          const dt = 1 / 60;
          for (let i = 0; i < 168; i++) {
            head.position.x += headSpeed * dt;
            engine.camera.position.set(head.position.x, 45, 2);
            engine.camera.lookAt(head.position); engine.camera.updateMatrixWorld();
            system.update(dt, i * dt);
          }
          const b = system.backend, f = hair.record, pos = b.kind === 'gpu'
            ? new Float32Array(await engine.renderer.getArrayBufferAsync(b.pos.value)) : b.pos;
          let offset = 0;
          for (let i = 0; i < f.strandCount; i++) {
            const root = 4 * (f.nodeOffset + i * f.nodesPerStrand);
            offset += pos[root + 4 * (f.nodesPerStrand - 1)] - pos[root];
          }
          return offset / f.strandCount;
        } finally { system.dispose(); }
      }
      return { calm: await run(0, 0), carried: await run(2, 2), headwind: await run(2, 0) };
    });
    expect(Math.abs(read.carried - read.calm)).toBeLessThan(0.018);
    expect(read.carried - read.headwind).toBeGreaterThan(0.035);
    expect(log.errors).toEqual([]);
  });
  test(backend + ' attached hair hangs below its scalp while roots follow an animated parent', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'river', 'high', backend);
    const sample = await page.evaluate(async () => {
      const { engine, scene: { strands } } = (window as any).lumina, T = (window as any).THREE;
      engine.stop();
      const System = strands.constructor, solver = new System(engine, { groundY: -5, detail: 1 });
      const head = new T.Group(); head.position.set(0, 4, 0);
      const f = solver.hair({ count: 40, segments: 5, length: [0.28, 0.32], follow: head });
      const cam = engine.camera; cam.position.set(0, 4, 2); cam.lookAt(head.position);
      engine.wind.speed = 0;
      async function meanY() {
        const b = solver.backend;
        const pos = b.kind === 'gpu' ? new Float32Array(await engine.renderer.getArrayBufferAsync(b.pos.value)) : b.pos;
        let tip = 0, root = 0;
        for (let s = 0; s < f.record.strandCount; s++) {
          const i = 4 * (f.record.nodeOffset + s * f.record.nodesPerStrand) + 1;
          root += pos[i]; tip += pos[i + 4 * (f.record.nodesPerStrand - 1)] - pos[i];
        }
        return { drop: tip / f.record.strandCount, root: root / f.record.strandCount };
      }
      try {
        for (let i = 0; i < 45; i++) solver.update(1 / 60, i / 60);
        const initial = await meanY();
        for (let i = 0; i < 24; i++) { head.position.y += 0.01; solver.update(1 / 60, (i + 45) / 60); }
        return { initial, moving: await meanY() };
      } finally { solver.dispose(); }
    });
    expect(sample.initial.drop).toBeLessThan(-0.10);
    expect(sample.moving.root - sample.initial.root).toBeCloseTo(0.24, 3);
    expect(log.errors).toEqual([]);
  });
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' rendered tire interface follows the bed on dry crowns and the liquid level in ruts', async ({ page }) => {
    await openScene(page, 'highway', 'high', backend);
    const samples = await page.evaluate(async () => {
      const { engine, scene: { road } } = (window as any).lumina, T = (window as any).THREE, n = T.TSL;
      engine.stop();
      road.params.flood = 0.55; road.update(0);
      const strip = road.group.getObjectByName('lumina-wet-road');
      const mat = new T.NodeMaterial();
      mat.positionNode = strip.material.positionNode;
      mat.fragmentNode = n.vec4(n.positionWorld.y, 0, 0, 1);
      const mesh = new T.Mesh(strip.geometry, mat);
      mesh.position.z = 120;
      const scene = new T.Scene(); scene.add(mesh);
      const cam = new T.OrthographicCamera(-0.012, 0.012, 0.012, -0.012, 0.1, 4);
      cam.up.set(0, 0, -1);
      const target = new T.RenderTarget(1, 1, { type: T.FloatType });
      const renderer = engine.renderer, previous = renderer.getRenderTarget();
      const out: { bed: number; level: number; rendered: number }[] = [];
      try {
        for (const [x, z] of [[-3.25, 84], [0, 0]]) {
          cam.position.set(x, 2, z); cam.lookAt(x, 0, z); cam.updateMatrixWorld();
          renderer.setRenderTarget(target); renderer.render(scene, cam); renderer.setRenderTarget(previous);
          const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          out.push({ bed: road.heightAt(x, z), level: road.waterLine, rendered: data[0] });
        }
        return out;
      } finally { renderer.setRenderTarget(previous); mat.dispose(); target.dispose(); }
    });
    expect(samples[0].bed).toBeLessThan(samples[0].level);
    expect(samples[1].bed).toBeGreaterThan(samples[1].level);
    for (const p of samples) expect(Math.abs(p.rendered - Math.max(p.bed, p.level))).toBeLessThan(0.001);
  });
}
