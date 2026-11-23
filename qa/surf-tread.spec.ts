import { test, expect } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { TireSmoke } from '../modules/wet-road/tire-smoke';
import { breakerAt } from '../modules/water/shore-breaker';
import { openScene, watchConsole } from './helpers';

test('tread heating follows friction work, cooling and timestep', () => {
  const fx = { smoke: { emitRateAt() {} } }, p = new Vector3();
  function run(hz: number, load: number, wet: number) {
    const tires = new TireSmoke(fx as any, 1);
    for (let i = 0; i < 2 * hz; i++) tires.updateWheel(0, p, load, 13, wet, 1 / hz);
    return tires;
  }
  const hot = run(60, 3300, 0);
  expect(hot.emitted).toBeGreaterThan(10);
  expect(run(30, 3300, 0).temperatureRise(0)).toBeCloseTo(hot.temperatureRise(0), 7);
  expect(run(60, 0, 0).emitted + run(60, 3300, 1).emitted).toBe(0);
  const dry = run(60, 3300, 0), tally = hot.emitted;
  hot.updateWheel(0, p, 3300, 0, 1, 1);
  dry.updateWheel(0, p, 3300, 0, 0, 1);
  expect(hot.emitted).toBe(tally);
  expect(hot.temperatureRise(0)).toBeLessThan(dry.temperatureRise(0) * 0.1);
});

test('surf velocity differentiates a continuous periodic breaker', () => {
  for (let t = 0; t < 8; t += 0.09) {
    const h = (s: number) => breakerAt(17, -31, 0.42, s, 0.55);
    expect(breakerAt(17, -31, 0.42, t, 0.55, true)).toBeCloseTo((h(t + 0.0001) - h(t - 0.0001)) / 0.0002, 5);
  }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' submerged fire stops emitting flames and releases finite surface condensate', async ({ page }) => {
    const log = watchConsole(page); await openScene(page, 'playground', 'low', backend);
    const result = await page.evaluate(() => {
      const { engine, scene: { fx, explosions } } = (window as any).lumina, T = (window as any).THREE;
      engine.stop(); explosions.extinguish();
      engine.world.rainfall = 0;
      const point = new T.Vector3(2100, 90, 1);
      const waterY = 94;
      let flame = 0, soot = 0, steam = 0, lowest = Infinity;
      fx.fire.emitRateAt = () => flame++;
      fx.smoke.emitRateAt = () => soot++;
      fx.mist.emitRateAt = (_carry: unknown, _slot: number, rate: number, dt: number, options: any) => {
        steam += rate * dt; lowest = Math.min(lowest, options.position.y);
      };
      const remove = engine.world.addWater({ heightAt: () => waterY });
      try {
        const consume = (hz: number) => {
          steam = 0;
          explosions.ignite(point, 1, 30, { rainExposure: 0 });
          for (let i = 0; i < hz; i++) explosions.update(1 / hz, engine.time + i / hz);
          return steam;
        };
        const coarse = consume(30), fine = consume(120), count = explosions.fireCount, under = flame + soot;
        steam = 0;
        explosions.ignite(point, 1, 30, { followsWater: true });
        explosions.update(1 / 30, engine.time);
        return { coarse, fine, count, lowest, under, floatingFlame: flame, floatingSteam: steam, waterY };
      } finally { remove(); }
    });
    expect(result.under).toBe(0); expect(result.count).toBe(0);
    expect(result.lowest).toBeGreaterThanOrEqual(result.waterY);
    expect(result.coarse).toBeGreaterThan(15); expect(result.fine).toBeCloseTo(result.coarse, 3);
    expect(result.floatingFlame).toBeGreaterThan(0); expect(result.floatingSteam).toBe(0);
    expect(log.errors).toEqual([]);
  });
  test(backend + ' a nearshore hull samples the crest drawn under it', async ({ page }) => {
    const log = watchConsole(page); await openScene(page, 'lagoon', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: { ocean } } = (window as any).lumina, T = (window as any).THREE;
      engine.stop();
      const flat = { ...ocean.params, windSpeed: 0, swellHeight: 0, chop: 0 };
      ocean.setSeaStates(flat, flat);
      ocean.optics.breakerHeight = 0.7;
      ocean.update(1 / 60, engine.time);
      let best = 0, x = 0, z = 0;
      for (let a = 70; a < 275; a += 3) for (let b = -90; b < 150; b += 3) {
        const depth = ocean.depthAt(a, b);
        if (depth < 0.25 || depth > 1.1) continue;
        const magnitude = Math.abs(ocean.heightAt(a, b) - ocean.waterLevel);
        if (magnitude > best) { best = magnitude; x = a; z = b; }
      }
      const mat = new T.NodeMaterial();
      mat.fragmentNode = T.TSL.vec4(ocean.surfaceHeightNode(T.TSL.vec2(x, z)), 0, 0, 1);
      const rt = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const renderer = engine.renderer, prev = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(rt); new T.QuadMesh(mat).render(renderer); renderer.setRenderTarget(prev);
        const gpu = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 1, 1))[0];
        return { gpu, best, cpu: ocean.heightAt(x, z), bus: engine.world.waterHeight(x, z) };
      } finally { renderer.setRenderTarget(prev); rt.dispose(); mat.dispose(); }
    });
    expect(result.best).toBeGreaterThan(0.1);
    expect(result.cpu).toBeCloseTo(result.gpu, 2); expect(result.bus).toBeCloseTo(result.cpu, 5);
    expect(log.errors).toEqual([]);
  });
}
