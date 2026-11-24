import { expect, test } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { WheelArchWater } from '../modules/wet-road/wheel-arch';
import { StreetDrainage } from '../modules/wet-road/drainage';
import { WheelSpraySheets } from '../modules/wet-road/wheel-sheets';
import { watchConsole } from './helpers';

test('wheel sheets follow the rising and falling receiving surface', () => {
  for (const slope of [-0.25, 0, 0.25]) {
    const hits: number[] = [];
    const height = (x: number) => 0.35 + slope * x;
    const sheet = new WheelSpraySheets(1, (x) => hits.push(x), { surfaceHeightAt: height });
    const p = new Vector3(0, 0.36, 0),
      v = new Vector3(3, 2, 0);
    sheet.submit(0, p, v, v, 1);
    sheet.update(1 / 60);
    for (let i = 0; i < 100; i++) sheet.update(1 / 60);
    const effectiveLift = v.y - slope * v.x,
      time = (effectiveLift + Math.sqrt(effectiveLift ** 2 + 2 * 9.81 * 0.01)) / 9.81;
    expect(hits).toHaveLength(1);
    expect(Math.abs(hits[0] - v.x * time)).toBeLessThan(0.0015);
    sheet.dispose();
  }
});

test('wheel liner retention balances the street at different frame rates and drains after stopping', () => {
  function pass(hz: number, coverage: number) {
    let puddle = 3,
      returned = 0;
    const arch = new WheelArchWater({
      coverage,
      exchangeLitres(x, z, request) {
        if (request > 0) {
          returned += request;
          return request;
        }
        const taken = Math.min(puddle, -request);
        puddle -= taken;
        return -taken;
      },
    });
    for (let i = 0; i < 2 * hz; i++) arch.update(1 / hz, 0, 0, 0, 0.2, 0.24, 0.34, 0.033, 13, 13, 0.95);
    const wet = arch.storedLitres;
    for (let i = 0; i < 2 * hz; i++) arch.update(1 / hz, 0, 0, 0, 0.2, 0.24, 0.34, 0, 0, 0, 0.95);
    const parked = arch.storedLitres;
    arch.empty();
    expect(puddle + returned).toBeCloseTo(3, 9);
    expect(arch.capturedLitres - arch.dischargedLitres).toBeCloseTo(0, 9);
    return { wet, parked, returned };
  }
  const a = pass(30, 0.7),
    b = pass(120, 0.7);
  expect(a.wet).toBeGreaterThan(0.1);
  expect(a.parked / a.wet).toBeCloseTo(Math.exp(-2 / 1.65), 7);
  expect(a.returned).toBeCloseTo(b.returned, 7);
  expect(pass(60, 0).returned).toBe(0);
});

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' boulevard wheels intercept real puddle water and brake light reaches only the rear mist',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=boulevard&view=drive&tier=high&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      const result = await page.evaluate(async () => {
        const { world: w, road, vehicles: v } = (window as any).coastDemo,
          T = (window as any).THREE,
          t = T.TSL;
        const e = w.engine,
          car = v.car,
          spray = v.spray,
          arches = spray.arches,
          keys = new Set(),
          brake = new Set(['KeyS']);
        e.stop();
        const x = road.road.x - 0.38,
          z = road.road.z - 5;
        car.chassis.setTranslation({ x, y: road.heightAt(x, z) + 0.64, z }, true);
        car.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        car.chassis.setLinvel({ x: 0, y: 0, z: 11 }, true);
        car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        e.physics.snap(car.chassis);
        const tick = (k: Set<unknown>) => {
          v.drive(1 / 60, k, false);
          e.physics.step(1 / 60, 4);
          car.update(1 / 60, e.time);
          spray.update(1 / 60);
        };
        for (let i = 0; i < 84; i++) tick(keys);
        const captured = arches.map((a: any) => a.capturedLitres),
          stored = arches.map((a: any) => a.storedLitres);
        const m = new T.NodeMaterial(),
          query = t.uniform(new T.Vector3());
        m.fragmentNode = t.vec4(w.beams.rearRadiance(query), 1);
        const quad = new T.QuadMesh(m),
          renderer = e.renderer,
          target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
        const old = renderer.getRenderTarget();
        async function sample(distance: number) {
          const left = new T.Vector3(),
            right = new T.Vector3();
          v.coupe.rearLampCenters(left, right);
          query.value.copy(left).addScaledVector(car.forward, distance);
          renderer.setRenderTarget(target);
          quad.render(renderer);
          renderer.setRenderTarget(old);
          const rgb = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          return Array.from(rgb as Float32Array).slice(0, 3);
        }
        try {
          const free = await sample(-1.2);
          for (let i = 0; i < 8; i++) tick(brake);
          const lit = await sample(-1.2),
            ahead = await sample(2.0),
            far = await sample(-8);
          const balance = arches.reduce(
            (s: number, a: any) => s + Math.abs(a.capturedLitres - a.storedLitres - a.dischargedLitres),
            0,
          );
          const d = road.drainage,
            b = d.budget;
          const budgetError = Math.abs(
            b.initialLitres +
              b.rainLitres +
              b.returnLitres -
              b.pickupLitres -
              b.streetLitres -
              b.roofLitres -
              b.evaporatedLitres -
              b.sewerLitres,
          );
          const snap = d.save();
          d.restore(snap);
          return { backend: e.backend, captured, stored, free, lit, ahead, far, balance, budgetError };
        } finally {
          renderer.setRenderTarget(old);
          target.dispose();
          m.dispose();
        }
      });
      console.log(backend, result);
      expect(result.backend).toBe(backend === 'webgl' ? 'webgl2' : backend);
      const captured = [...result.captured].sort((a, b) => b - a);
      expect(captured[1]).toBeGreaterThan(0.03);
      expect(captured[2]).toBeLessThan(captured[1] * 0.1);
      expect(Math.max(...result.stored)).toBeGreaterThan(0.025);
      expect(result.lit[0] - result.free[0]).toBeGreaterThan(0.2);
      expect(result.lit[0]).toBeGreaterThan(10 * result.lit[2]);
      expect(result.ahead[0]).toBeLessThan(0.001);
      expect(result.far[0]).toBeLessThan(0.001);
      expect(result.balance).toBeLessThan(1e-7);
      expect(result.budgetError).toBeLessThan(1e-7);
      expect(log.errors).toEqual([]);
    },
  );
}
test('legacy street storage migrates before a wheel moves its water to the adjacent cell', () => {
  const street = new StreetDrainage({
    x: 0, z: 0, width: 2, length: 2, columns: 2, rows: 2, ground: () => 0,
    initialDepth: (x, z) => x < 1 && z < 1 ? 0.003 : 0,
    roof: { area: 0, seconds: 1, outletX: 0.5, outletZ: 0.5 }, drains: [],
  });
  try {
    const legacy = street.save();
    legacy.version = 1;
    delete legacy.budget.pickupLitres;
    delete legacy.budget.returnLitres;
    street.restore(legacy);
    expect(street.exchangeLitres(0.5, 0.5, -12)).toBeCloseTo(-3, 9);
    expect(street.exchangeLitres(0.5, 0.5, -1)).toBe(0);
    expect(street.exchangeLitres(3, 0.5, 1)).toBe(0);
    expect(street.exchangeLitres(1.5, 0.5, 2)).toBe(2);
    const saved = street.save();
    expect(saved.depths).toEqual([0, 0.002, 0, 0]);
    street.restore(saved);
    expect(street.save().budget).toMatchObject({ streetLitres: 2, pickupLitres: 3, returnLitres: 2 });
  } finally {
    street.dispose();
  }
});
