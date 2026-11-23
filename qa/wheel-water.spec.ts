import { expect, test } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { WheelSpraySheets } from '../modules/wet-road/wheel-sheets';
import { TrailRibbon } from '../modules/aero/trails';
import { openScene, watchConsole } from './helpers';

test('spray sheets return to the water once per launch and expire at both sample rates', () => {
  const measure = (hz: number) => {
    const landings: number[] = [];
    const sheets = new WheelSpraySheets(2, (x) => landings.push(x));
    const surface = new Vector3(0, 0.3, 0), inner = new Vector3(1, 3, 1), outer = new Vector3(5, 1, 2);
    let triangles = 0;
    for (let i = 0; i < hz; i++) {
      surface.z = i / hz * 12;
      sheets.submit(0, surface, inner, outer, 1);
      sheets.update(1 / hz);
      triangles = Math.max(triangles, sheets.stats.triangles);
    }
    for (let i = 0; i < hz * 2; i++) sheets.update(1 / hz);
    expect(sheets.mesh.visible).toBe(false);
    expect(sheets.stats.triangles).toBe(0);
    expect(triangles).toBeGreaterThan(80);
    sheets.dispose();
    return landings;
  };
  const a = measure(30), b = measure(120);
  expect(a.length).toBe(30);
  expect(b.length).toBe(30);
  for (const x of [...a, ...b]) expect(x).toBeCloseTo(3 * 4 / 9.81, 5);
});

test('aircraft wake strips keep their release wind and leave an open gap across dry air', () => {
  const trail = new TrailRibbon({ capacity: 12, spacing: 1, life: 5, width: 0.3, widthEnd: 1 });
  const p = new Vector3(), wind = new Vector3(3, 1, 0);
  for (let z = 0; z < 4; z++) { trail.push(p.set(0, 0, z), 1, wind); trail.update(1 / 60); }
  trail.release(); trail.update(0.5);
  const g = trail.mesh.geometry;
  expect(g.attributes.center.getX(0)).toBeCloseTo(1.5);
  expect(g.attributes.center.getY(0)).toBeCloseTo(0.5);
  // The texture follows the drifting vapor and retains its coordinates at birth.
  expect(g.attributes.position.getX(0)).toBe(0);
  expect(g.attributes.position.getY(0)).toBe(0);
  expect(g.attributes.position.getZ(0)).toBe(3);
  expect(trail.emissionStrength).toBe(0);
  wind.set(-4, 0, 0);
  for (let z = 100; z < 104; z++) { trail.push(p.set(0, 0, z), 0.9, wind); trail.update(1 / 60); }
  expect(g.drawRange.count).toBe(36);
  const zs = g.attributes.center, index = g.index!;
  for (let i = 0; i < g.drawRange.count; i += 3) {
    const a = zs.getZ(index.getX(i)), b = zs.getZ(index.getX(i + 1)), c = zs.getZ(index.getX(i + 2));
    expect(Math.max(a, b, c) - Math.min(a, b, c)).toBeLessThan(2);
  }
  trail.release(); trail.update(6);
  expect(g.drawRange.count).toBe(0);
  trail.dispose();
});

test('a fast engine contrail retains its time history within the same point budget', () => {
  for (const hz of [30, 120]) {
    const capacity = 120, life = 22, speed = 310;
    const trail = new TrailRibbon({ capacity, life, spacing: 22, width: 1, widthEnd: 14 });
    const p = new Vector3();
    try {
      for (let f = 0; f < 25 * hz; f++) {
        p.z = -speed * f / hz;
        trail.push(p, 1, undefined, speed);
        trail.update(1 / hz);
      }
      const g = trail.mesh.geometry, tailVertex = g.drawRange.count / 3;
      const seconds = (g.attributes.center.getZ(tailVertex) - g.attributes.center.getZ(0)) / speed;
      expect(seconds).toBeGreaterThan(life - 0.5);
      expect(seconds).toBeLessThanOrEqual(life + 1 / hz);
      expect(g.attributes.center.count).toBe(capacity * 2);
    } finally { trail.dispose(); }
  }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' wheel rotation, sliding, dry exit and reverse wading drive distinct responses', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    await page.evaluate(() => { document.getElementById('ui')!.style.display = ''; });
    await page.getByRole('button', { name: 'Curbside puddle', exact: true }).click({ force: true });
    await page.waitForFunction('lumina.scene.spray.sheets.stats.triangles > 32');
    await page.getByRole('button', { name: 'Reverse through flood', exact: true }).click({ force: true });
    await page.waitForFunction('lumina.scene.fluid.stats.rearSpray > 4');
    const result = await page.evaluate(() => {
      const { engine, scene: { road, vehicle, spray, fx, fluid } } = (window as any).lumina;
      engine.stop();
      const T = (window as any).THREE;
      const rear = fluid.stats.rearSpray, hood = fluid.stats.hoodSpray;
      const g = fluid.grid, total = (array: Float32Array) => array.reduce((s, v) => s + v, 0);
      g.velocity.fill(0);
      const p = vehicle.root.position, landed = fluid.returnSpray(p.x, p.z, 1), net = total(g.velocity);
      fluid.setFlood(false);
      const drainedGrid = !fluid.mesh.visible && g.wave.every((v: number) => v === 0);
      vehicle.speed = 23; vehicle.forward.set(0, 0, 1);
      vehicle.chassis.setLinvel(new T.Vector3(0, 0, 23), true);
      for (const w of vehicle.wheels) {
        w.depth = 0; w.loadRatio = 1; w.contact = true; w.normal.set(0, 1, 0);
        w.rollingDirection.set(0, 0, 1); w.velocity.set(0, 0, 23); w.rollingSpeed = 23; w.lateralSpeed = 0;
        w.angularSpeed = 23 / vehicle.rig.wheelRadius;
      }
      road.params.wetness = 0;
      const wheel = vehicle.wheels[2]; wheel.depth = 0.04;
      let spin = 0, squeeze = 0, origin = 0;
      fx.spray.emitRateAt = (_c: unknown, i: number, rate: number, _dt: number, plume: any) => {
        if (i === 2) spin = rate;
        if (i === 6) { squeeze = rate; origin = plume.position.y; }
      };
      const step = () => { spin = squeeze = 0; spray.update(1 / 60); };
      for (let i = 0; i < 35; i++) step();
      const rolling = spin;
      wheel.angularSpeed = 0; step();
      const locked = spin, sideJet = squeeze, interfaceY = road.heightAt(wheel.position.x, wheel.position.z) + wheel.depth;
      wheel.angularSpeed = 23 / vehicle.rig.wheelRadius; wheel.depth = 0; step();
      const leaving = spin, drySheet = squeeze;
      for (let i = 0; i < 180; i++) step();
      return { rear, hood, net, landed, drainedGrid, rolling, locked, sideJet, origin, interfaceY, leaving, drySheet, drained: spin };
    });
    expect(result.rear).toBeGreaterThan(4); expect(result.hood).toBe(0);
    expect(result.drainedGrid).toBe(true); expect(result.landed).toBe(true); expect(result.net).toBeCloseTo(0, 6);
    expect(result.rolling).toBeGreaterThan(5); expect(result.locked).toBe(0); expect(result.sideJet).toBeGreaterThan(5);
    expect(result.origin).toBeCloseTo(result.interfaceY + 0.012, 3);
    expect(result.leaving).toBeGreaterThan(0); expect(result.drySheet).toBe(0); expect(result.drained).toBe(0);
    expect(log.errors).toEqual([]);
  });
}
