import { expect, test } from '@playwright/test';
import { openScene, watchConsole } from './helpers';
import { buildInitialSpectrum, cascadeLayout, OCEAN_PRESETS } from '../modules/water/spectrum';

test('windless water retains incoming swell and a still pool has zero wave energy', () => {
  const layout = cascadeLayout(64, 2)[0];
  const calm = buildInitialSpectrum(64, layout, 0, OCEAN_PRESETS.still);
  const swell = buildInitialSpectrum(64, layout, 0, { ...OCEAN_PRESETS.swell, windSpeed: 0 });
  expect(calm.every(x => x === 0)).toBe(true);
  expect(swell.every(Number.isFinite)).toBe(true);
  expect(swell.some(x => Math.abs(x) > 0.01)).toBe(true);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' tide moves the rendered surface, wet shore, gameplay depth and current together', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'lagoon', 'high', backend);
    const result = await page.evaluate(async () => {
      const { lumina, THREE } = window as any;
      const { engine, scene } = lumina;
      engine.stop();
      const { ocean } = scene;
      const bed = ocean.bathymetry;
      const still = { ...ocean.params, windSpeed: 0, swellHeight: 0, chop: 0 };
      ocean.setSeaStates(still, still);
      ocean.optics.breakerHeight = 0;
      bed.shoreDryingSeconds = 20;
      const epoch = engine.time;
      ocean.setTide({ amplitude: 2, periodSeconds: 40 });
      // An intertidal point on the live showcase beach, away from local wakes.
      let coastX = 0, coastZ = 0, nearest = Infinity;
      for (let z = -180; z < 240; z += 4) for (let x = 40; x < 430; x += 4) {
        const offset = Math.abs(bed.heightAt(x, z) - ocean.meanWaterLevel);
        if (offset < nearest) { nearest = offset; coastX = x; coastZ = z; }
      }
      const pos = THREE.TSL.vec2(coastX, coastZ);
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = THREE.TSL.vec4(ocean.surfaceHeightNode(pos), bed.depthNode(pos), bed.waterLevel, bed.wetHighWater);
      const target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
      const quad = new THREE.QuadMesh(mat);
      const prev = engine.renderer.getRenderTarget();
      const samples: { gpu: number[]; level: number; height: number; depth: number; oceanDepth: number; wet: boolean; velocity: number }[] = [];
      const flow = new THREE.Vector3();
      try {
        for (const elapsed of [0, 10, 20, 30, 40, 50]) {
          if (elapsed === 50) ocean.setTide();
          ocean.update(elapsed ? 10 : 0, epoch + elapsed);
          engine.renderer.setRenderTarget(target);
          quad.render(engine.renderer);
          engine.renderer.setRenderTarget(prev);
          const gpu = Array.from(await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)) as number[];
          samples.push({ gpu, level: ocean.waterLevel, height: ocean.heightAt(coastX, coastZ),
            depth: bed.depthAt(coastX, coastZ), oceanDepth: ocean.depthAt(coastX, coastZ),
            wet: Number.isFinite(engine.world.waterHeight(coastX, coastZ)), velocity: ocean.flowAt(coastX, coastZ, flow).y });
        }
      } finally {
        engine.renderer.setRenderTarget(prev);
        target.dispose();
        mat.dispose();
      }
      bed.shoreDryingSeconds = 0;
      bed.updateShoreMoisture(0);
      return { samples, nearest, drained: bed.wetHighWater.value, focusing: bed.waveFocusing.value };
    });
    expect(result.nearest).toBeLessThan(0.15);
    const levels = [0, 2, 0, -2, 0, 0];
    for (const [i, s] of result.samples.entries()) {
      expect(s.level).toBeCloseTo(levels[i], 5);
      expect(s.height).toBeCloseTo(s.level, 3);
      expect(s.gpu[0]).toBeCloseTo(s.level, 3);
      expect(s.gpu[2]).toBeCloseTo(s.level, 5);
      expect(s.gpu[1] - result.samples[0].gpu[1]).toBeCloseTo(s.level, 3);
      expect(s.oceanDepth).toBeCloseTo(s.depth, 5);
      expect(s.velocity).toBeCloseTo(i < 5 ? Math.PI / 10 * Math.cos(i * Math.PI / 2) : 0, 3);
    }
    let highWater = 0;
    for (const [i, level] of levels.entries()) {
      highWater = level >= highWater ? level : level + (highWater - level) * Math.exp(-10 / 20);
      expect(result.samples[i].gpu[3]).toBeCloseTo(highWater, 4);
    }
    expect(result.drained).toBe(0);
    expect(result.focusing).toBe(0);
    expect(result.samples[1].wet).toBe(true);
    expect(result.samples[3].wet).toBe(false);
    expect(log.errors).toEqual([]);
  });
}
