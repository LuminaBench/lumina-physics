import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { watchConsole } from './helpers';

const captures = fileURLToPath(new URL('./output/captures/', import.meta.url));
fs.mkdirSync(captures, { recursive: true });
test.use({ viewport: { width: 1920, height: 1080 } });

async function boot(page: Page, scene: string, backend: string) {
  await page.goto('/?scene=' + scene + '&tier=high' + (backend === 'webgl2' ? '&webgl=1' : ''));
  await page.waitForFunction('window.__luminaReady === true');
  expect(await page.evaluate(() => (window as any).lumina.engine.backend)).toBe(backend);
}
async function capture(page: Page, backend: string, name: string) {
  await page.locator('#ui').evaluate((e) => {
    (e as HTMLElement).style.visibility = 'hidden';
  });
  try {
    await page.screenshot({ path: path.join(captures, backend + '-' + name + '.png') });
  } finally {
    await page.locator('#ui').evaluate((e) => {
      (e as HTMLElement).style.visibility = '';
    });
  }
}
const click = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();

for (const backend of ['webgpu', 'webgl2']) {
  test(
    backend + ' coastal rescue couples rotor pressure to the water, ground dust and a listing boat',
    async ({ page }) => {
      const log = watchConsole(page);
      await boot(page, 'lagoon', backend);
      await click(page, 'Hover over water');
      await page.waitForFunction(
        'lumina.scene.rescue.rotor.stats.emitted > 260 && lumina.scene.rescue.rotor.stats.water'
      );
      // Render an actual scalar-field sample into a floating-point GPU target independently of CPU interpolation.
      const parity = await page.evaluate(async () => {
        const w = window as any,
          { engine: e, scene: s } = w.lumina,
          bus = e.world,
          THREE = w.THREE;
        const source = s.rescue.rotor.source,
          cp = source.start.clone();
        cp.x += 1;
        const cpu = bus.disturbance(cp, { wind: new THREE.Vector3(), pressureForce: new THREE.Vector3() });
        let idx = 0;
        while (idx < bus.sourceCount && !bus.ownedBy(idx, source)) idx++;
        if (idx === bus.sourceCount) throw Error('rotor field missing');
        const coord = bus.u.start.element(idx).xyz.add(new THREE.Vector3(1, 0, 0));
        const m = new THREE.NodeMaterial();
        m.fragmentNode = bus.scalarNode(coord);
        const target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
        const quad = new THREE.QuadMesh(m),
          prev = e.renderer.getRenderTarget();
        try {
          e.renderer.setRenderTarget(target);
          quad.render(e.renderer);
          e.renderer.setRenderTarget(prev);
          const rgba = await e.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          return {
            gpu: Array.from(rgba) as number[],
            cpu: [cpu.pressure, cpu.temperature, cpu.wetness, cpu.cloudCut],
          };
        } finally {
          e.renderer.setRenderTarget(prev);
          m.dispose();
          target.dispose();
        }
      });
      for (let i = 0; i < 4; i++) expect(parity.gpu[i]).toBeCloseTo(parity.cpu[i], 2);
      await page.waitForFunction(() => {
        const { ocean, rescue } = (window as any).lumina.scene;
        const p = rescue.rotor.source.start;
        return ocean.field.sampleHeight(p.x, p.z) < -0.012;
      });
      const dish = await page.evaluate(async () => {
        const w = window as any,
          { scene, engine } = w.lumina,
          T = w.THREE,
          field = scene.ocean.field;
        const p = scene.rescue.rotor.source.start,
          r = scene.rescue.rotor.source.radius;
        const center = T.TSL.vec2(p.x, p.z),
          outside = T.TSL.vec2(p.x + r * 2.5, p.z);
        const cpu = field.sampleHeight(p.x, p.z),
          m = new T.NodeMaterial();
        m.fragmentNode = T.TSL.vec4(field.heightVertex(center), field.heightVertex(outside), 0, 1);
        const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false }),
          old = engine.renderer.getRenderTarget();
        try {
          engine.renderer.setRenderTarget(target);
          new T.QuadMesh(m).render(engine.renderer);
          engine.renderer.setRenderTarget(old);
          const pixel = await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          return { cpu, gpu: pixel[0], outside: pixel[1] };
        } finally {
          engine.renderer.setRenderTarget(old);
          target.dispose();
          m.dispose();
        }
      });
      console.log(backend, 'rotor water displacement (metres)', dish);
      expect(dish.gpu).toBeLessThan(-0.008);
      expect(dish.gpu).toBeLessThan(dish.outside - 0.006);
      expect(Math.abs(dish.cpu - dish.gpu)).toBeLessThan(0.04 + Math.abs(dish.gpu) * 0.42);
      await capture(page, backend, 'rotor-water');
      await click(page, 'Hover over beach');
      await page.waitForFunction(
        '!lumina.scene.rescue.rotor.stats.water && lumina.scene.rescue.rotor.stats.loading > 0.2'
      );
      await click(page, 'Stop rotor');
      await click(page, 'Launch workboat');
      await click(page, 'Flood port compartment');
      await page.waitForFunction(
        'lumina.scene.rescue.vessel.stats.flooded > 0.24 && Math.abs(lumina.scene.rescue.vessel.stats.list) > 0.24'
      );
      await capture(page, backend, 'listing-boat');
      expect(log.errors).toEqual([]);
    }
  );
  test(backend + ' yard hover entrains the selected loose ground cover', async ({ page }) => {
    const log = watchConsole(page);
    await boot(page, 'playground', backend);
    await click(page, 'snow');
    await click(page, 'Hover over yard');
    await page.waitForFunction(
      "lumina.scene.yardWash.stats.surface==='snow' && lumina.scene.yardWash.stats.emitted>300"
    );
    await capture(page, backend, 'rotor-snow');
    await click(page, 'mud');
    await page.waitForFunction(
      "lumina.scene.yardWash.stats.surface==='soil' && lumina.scene.yardWash.stats.loading>0.4"
    );
    await click(page, 'Hover over yard');
    await page.waitForFunction('lumina.scene.yardWash.stats.loading===0');
    expect(log.errors).toEqual([]);
  });
  for (const deck of ['lower', 'upper'] as const) test(backend + ' jet opens a swept cloud tunnel in the ' + deck + ' deck', async ({ page }) => {
    const log = watchConsole(page);
    await boot(page, 'jet', backend);
    await click(page, deck === 'upper' ? 'Fly through upper deck' : 'Fly through cloud');
    await page.waitForFunction(
      'lumina.scene.jet.aero.cloudTrail.segments >= 6 && lumina.engine.lens.wetness > 0.04'
    );
    const density = await page.evaluate(async () => {
      const w = window as any,
        { scene, engine } = w.lumina,
        bus = engine.world,
        weather = scene.weather;
      const THREE = w.THREE;
      let index = -1,
        score = 0;
      for (let i = 0; i < bus.sourceCount; i++) {
        const source = bus.sourceAt(i);
        if (source.cloudCut < 0.9) continue;
        const value = weather.sampleCloudDensity(source.start, engine.time) * bus.gainAt(i);
        if (value > score) {
          index = i;
          score = value;
        }
      }
      if (index < 0) throw Error('No aircraft capsule intersects cloud condensate');
      const q = bus.u.start.element(index).xyz;
      const m = new THREE.NodeMaterial();
      // Reconstruct an opaque point through the same scene projection and cloud
      // shader used in flight. The post quad has its own orthographic camera.
      const clip = new THREE.Vector4(0, 0, -24, 1).applyMatrix4(engine.camera.projectionMatrix);
      let depth = clip.z / clip.w;
      if (engine.camera.coordinateSystem === THREE.WebGLCoordinateSystem) depth = 0.5 * depth + 0.5;
      m.fragmentNode = THREE.TSL.vec4(weather.cloudDensityNode(q), weather.cloudDensityNode(q, false), bus.cloudNode(q),
        scene.weather.opaqueViewDepth(THREE.TSL.float(depth)));
      const target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
      const old = engine.renderer.getRenderTarget();
      try {
        engine.renderer.setRenderTarget(target);
        new THREE.QuadMesh(m).render(engine.renderer);
        engine.renderer.setRenderTarget(old);
        return Array.from(await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)) as number[];
      } finally {
        engine.renderer.setRenderTarget(old);
        target.dispose();
        m.dispose();
      }
    });
    console.log(backend, 'cloud density, undisturbed density, cavity', density);
    expect(density[1]).toBeGreaterThan(0.012);
    expect(density[2]).toBeGreaterThan(0.6);
    expect(density[0]).toBeLessThan(density[1] * 0.55);
    expect(density[3]).toBeCloseTo(24, 2);
    await capture(page, backend, deck === 'upper' ? 'upper-cloud-pass' : 'cloud-pass');
    const s = await page.evaluate((deck) => {
      const a = (window as any).lumina;
      const world = a.engine.world;
      const y = (world.cloudTop + world.upperCloudBase) / 2;
      const point = a.scene.jet.flight.state.position.clone();
      point.y = y;
      return {
        y: a.scene.jet.flight.state.position.y,
        base: deck === 'upper' ? world.upperCloudBase : world.cloudBase,
        top: deck === 'upper' ? world.upperCloudTop : world.cloudTop,
        clearGap: !world.inCloudLayer(y) && a.scene.weather.sampleCloudDensity(point) === 0,
      };
    }, deck);
    expect(s.y).toBeGreaterThan(s.base);
    expect(s.clearGap).toBe(true);
    expect(s.y).toBeLessThan(s.top);
    expect(log.errors).toEqual([]);
  });
  test(
    backend + ' flooded highway develops a bow wave, flowing slick, glass damage and dry tire smoke',
    async ({ page }) => {
      const log = watchConsole(page);
      await boot(page, 'highway', backend);
      await click(page, 'Flood the street');
      await page.waitForFunction(
        'lumina.scene.fluid.stats.depth > 0.22 && lumina.scene.fluid.stats.hoodSpray > 8 && lumina.scene.fluid.grid.stats.peakWave > 0.025'
      );
      await capture(page, backend, 'street-wading');
      await click(page, 'Leak fuel');
      await page.waitForFunction('lumina.scene.fluid.grid.stats.film > 1.5');
      await click(page, 'Light fuel trail');
      await page.waitForFunction('lumina.scene.fluid.grid.stats.burning >= 2');
      await click(page, 'Dent front wing');
      await click(page, 'Crack windscreen');
      await page.waitForFunction(
        'lumina.scene.damage.stats.displacement > 0.05 && lumina.scene.damage.stats.glassDamage > 0.12'
      );
      await capture(page, backend, 'crash-glass');
      for (let i = 0; i < 3; i++) await click(page, 'Crack windscreen');
      await page.waitForFunction('lumina.scene.damage.stats.shattered');
      await click(page, 'Repair bodywork');
      await click(page, 'Dry burnout');
      await page.waitForFunction('lumina.scene.damage.stats.smoke > 6 && !lumina.scene.damage.stats.shattered');
      expect(log.errors).toEqual([]);
    }
  );
  test(backend + ' opaque depth clips only condensate behind the surface', async ({ page }) => {
    const log = watchConsole(page);
    await boot(page, 'river', backend);
    await click(page, 'Launch waterspout');
    await page.waitForFunction('lumina.scene.vortex.stats.seconds > 1');
    const result = await page.evaluate(async () => {
      const w = window as any, T = w.THREE, t = T.TSL;
      const { engine, scene: { vortex } } = w.lumina;
      engine.stop();
      for (const child of engine.scene.children) child.visible = false;
      for (const child of engine.pipeline.softScene.children) child.visible = child === vortex.mesh;
      const r = engine.renderer, camera = engine.camera, o = vortex.position;
      const focus = o.clone().add(new T.Vector3(0, 8, 0));
      camera.position.copy(focus).add(new T.Vector3(0, 0, 33));
      camera.lookAt(focus);
      camera.updateMatrixWorld();
      const g = new T.BoxGeometry(24, 9, 0.2), m = new T.MeshBasicNodeMaterial();
      const wall = new T.Mesh(g, m);
      wall.position.copy(o).add(new T.Vector3(0, 4, -12));
      engine.scene.add(wall);
      const probe = new T.NodeMaterial();
      const texture = t.texture(engine.pipeline.softPass.getTexture('output'));
      const lower = o.clone().add(new T.Vector3(0, vortex.height * 0.14, 0)).project(camera);
      const upper = o.clone().add(new T.Vector3(0, vortex.height * 0.48, 0)).project(camera);
      // Read a small patch centred on each projected world point using the same
      // top-down screen coordinates as the material's depth sampler.
      const v = t.uv(), half = v.x.greaterThan(0.5);
      const local = t.vec2(v.x.mul(2).fract().sub(0.5).mul(0.013), v.y.sub(0.5).mul(0.017));
      const st = t.select(half, t.vec2(0.5 + upper.x * 0.5, 0.5 - upper.y * 0.5),
        t.vec2(0.5 + lower.x * 0.5, 0.5 - lower.y * 0.5)).add(local);
      const z = t.perspectiveDepthToViewZ(engine.pipeline.sceneDepth.sample(st).r,
        t.float(camera.near), t.float(camera.far)).negate();
      probe.fragmentNode = t.vec4(texture.sample(st).a, z, 0, 1);
      const target = new T.RenderTarget(16, 8, { type: T.FloatType, depthBuffer: false });
      const quad = new T.QuadMesh(probe);
      async function sample(expectedDepth: number) {
        const prior = r.getRenderTarget();
        // PassNode schedules work once per renderer frame. Verify the actual
        // opaque buffer belongs to this wall pose before comparing coverage.
        for (let frame = 0; frame < 8; frame++) {
          await new Promise<number>(resolve => requestAnimationFrame(resolve));
          engine.pipeline.render();
          r.setRenderTarget(target); quad.render(r); r.setRenderTarget(prior);
          const pixels = await r.readRenderTargetPixelsAsync(target, 0, 0, 16, 8);
          let bottom = 0, top = 0, maxError = 0, upperDepth = Infinity;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
            const i = (y * 16 + x) * 4, a = pixels[i] / 64;
            if (x < 8) { bottom += a; maxError = Math.max(maxError, Math.abs(pixels[i + 1] - expectedDepth)); }
            else { top += a; upperDepth = Math.min(upperDepth, pixels[i + 1]); }
          }
          if (maxError < 0.1 && upperDepth > camera.far * 0.9) return { bottom, top };
        }
        throw new Error('The probe did not read the expected wall and clear upper sightline');
      }
      try {
        const behind = await sample(44.9);
        wall.position.z = o.z + 9;
        return { behind, inFront: await sample(23.9) };
      } finally {
        wall.removeFromParent(); g.dispose(); m.dispose(); probe.dispose(); target.dispose();
      }
    });
    console.log(backend, 'funnel coverage with wall behind and in front', result);
    expect(result.behind.bottom).toBeGreaterThan(0.04);
    expect(result.behind.top).toBeGreaterThan(0.05);
    expect(result.inFront.bottom).toBeLessThan(result.behind.bottom * 0.1);
    expect(Math.abs(result.inFront.top - result.behind.top)).toBeLessThan(0.04);
    expect(log.errors).toEqual([]);
  });
  test(
    backend + ' waterspout and tornado bend vegetation, detach a trunk and carry a buoyant ragdoll',
    async ({ page }) => {
      const log = watchConsole(page);
      await boot(page, 'river', backend);
      await click(page, 'Launch waterspout');
      await page.waitForFunction(
        'lumina.scene.vortex.stats.overWater && lumina.scene.vortex.stats.seconds > 1.3'
      );
      await capture(page, backend, 'waterspout');
      await click(page, 'Land tornado');
      await page.waitForFunction(
        '!lumina.scene.vortex.stats.overWater && lumina.scene.tree.stats.peakStrain > 0.015'
      );
      await click(page, 'Break trunk');
      await page.waitForFunction('lumina.scene.tree.stats.brokenAt >= 0');
      await click(page, 'Clear vortex');
      await click(page, 'Stumble on bank');
      await page.waitForFunction('lumina.scene.worker.stats.strength < 0.65');
      await click(page, 'Float rescue worker');
      await page.waitForFunction('lumina.scene.worker.stats.immersion > 0.45');
      const settledAt = await page.evaluate(() => (window as any).lumina.engine.time + 1.8);
      await page.waitForFunction(t => (window as any).lumina.engine.time >= t &&
        (window as any).lumina.scene.worker.stats.immersion > 0.45, settledAt);
      await capture(page, backend, 'river-rescue');
      expect(log.errors).toEqual([]);
    }
  );
}
