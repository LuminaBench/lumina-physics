import { expect, test } from '@playwright/test';
import { buildInitialSpectrum, OCEAN_PRESETS } from '../modules/water/spectrum';
import { openScene, watchConsole } from './helpers';

test('GPU transforms preserve the CPU surface, slopes, Jacobian and lasting foam at every texel', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'lagoon', 'high', 'webgpu');
  // Odd and even log2 grid sizes exercise the two different final stages.
  for (const size of [32, 64]) {
    const layout = { length: 78, kMin: 0, kMax: Math.PI * size / 78 };
    const a = buildInitialSpectrum(size, layout, 0, OCEAN_PRESETS.storm);
    const b = buildInitialSpectrum(size, layout, 0, OCEAN_PRESETS.swell);
    const errors = await page.evaluate(async ({ size, layout, a, b }) => {
      const { lumina, THREE } = window as any;
      const { engine, scene } = lumina;
      engine.stop();
      const live = scene.ocean.cascades[0];
      const u = THREE.TSL.uniform;
      const inputs = { time: u(0), delta: u(1 / 60), chop: u(0.9), foamBias: u(1.04), foamDecay: u(0.4), blend: u(0.25) };
      const A = new Float32Array(a), B = new Float32Array(b);
      const cpu = new live.cpu.constructor(layout, size, A, B, size, 40);
      const gpu = new live.gpu.constructor(layout, size, A, B, 40, inputs);
      const peaks = [0, 0], errors = [0, 0];
      try {
        for (const time of [0, 1.75, 4.5]) {
          inputs.time.value = time;
          cpu.update(time, inputs.chop.value, inputs.blend.value);
          cpu.updateDerivatives(inputs.delta.value, inputs.foamBias.value, inputs.foamDecay.value);
          engine.renderer.compute(gpu.passes);
          for (const [i, tex] of [gpu.displacementTexture, gpu.derivativeTexture].entries()) {
            const raw = await engine.renderer.backend.copyTextureToBuffer(tex, 0, 0, size, size, 0);
            const reference = i === 0 ? cpu.displacement : cpu.derivatives;
            for (let j = 0; j < size * size * 4; ++j) {
              if (i === 0 && j % 4 === 3) continue;
              const expected = reference[j], actual = THREE.DataUtils.fromHalfFloat(raw[j]);
              peaks[i] = Math.max(peaks[i], Math.abs(expected));
              errors[i] = Math.max(errors[i], Math.abs(expected - actual) / (1 + Math.abs(expected)));
            }
          }
        }
      } finally { gpu.dispose(); }
      return { peaks, errors };
    }, { size, layout, a: Array.from(a), b: Array.from(b) });
    for (const peak of errors.peaks) expect(peak).toBeGreaterThan(0.1);
    for (const error of errors.errors) expect(error, size + ' squared, half-float readback').toBeLessThan(0.0015);
  }
  expect(log.errors).toEqual([]);
});
