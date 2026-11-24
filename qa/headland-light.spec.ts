import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(backend + ' ridge occludes the finite solar disc by receiver height', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/coast.html?shore=headland&view=walk&tier=medium&backend=' + backend);
    await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
    const air = page.getByRole('combobox', { name: 'Air conditions' });
    await air.selectOption('dusty-inland');
    const before = await page.evaluate(() => {
      const w = (window as any).coastDemo.world;
      return [
        w.weather.params.turbidity,
        w.weather.params.visibility,
        w.weather.params.sunElevation,
        w.weather.params.exposure,
      ];
    });
    await air.selectOption('humid-sea-breeze');
    const after = await page.evaluate(() => {
      const w = (window as any).coastDemo.world;
      return [
        w.weather.params.turbidity,
        w.weather.params.visibility,
        w.weather.params.sunElevation,
        w.weather.params.exposure,
      ];
    });
    expect(before.slice(0, 2)).toEqual([6.5, 12300]);
    expect(after.slice(0, 2)).toEqual([3.8, 25500]);
    expect(after.slice(2)).toEqual(before.slice(2));
    const report = await page.evaluate(async () => {
      const w = (window as any).coastDemo.world,
        T = (window as any).THREE,
        t = T.TSL;
      w.engine.stop();
      // Analytic ridge with its highest vertex 40 m due east of the receivers.
      const h = new w.horizon.constructor({
        size: 128,
        resolution: 65,
        reach: 120,
        heightAt: (x: number) => Math.max(0, 20 - 3 * Math.abs(x - 40)),
      });
      const el = Math.atan(0.25),
        sun = new T.Vector3(Math.cos(el), Math.sin(el), 0);
      h.update(sun);
      const n = 121,
        points = new Float32Array(n * 4),
        want = new Float32Array(n),
        cpu = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = ((i % 11) - 5) * 0.31,
          z = ((i % 3) - 1) * 1.6;
        const centre = 20 - (40 - x) * Math.tan(el),
          y = centre + (Math.floor(i / 11) - 5) * 0.075;
        const q = Math.max(-1, Math.min(1, (el - Math.atan2(20 - y, 40 - x)) / 0.00465));
        want[i] = (Math.acos(-q) + q * Math.sqrt(1 - q * q)) / Math.PI;
        cpu[i] = h.visibilityAt(x, y, z);
        points.set([x, y, z, 1], 4 * i);
      }
      const input = new T.DataTexture(points, n, 1, T.RGBAFormat, T.FloatType);
      input.needsUpdate = true;
      const mat = new T.NodeMaterial();
      mat.fragmentNode = t.vec4(h.visibilityNode(t.texture(input, t.uv()).level(0).xyz), 0, 0, 1);
      const quad = new T.QuadMesh(mat),
        rt = new T.RenderTarget(n, 1, { type: T.FloatType, depthBuffer: false });
      const r = w.engine.renderer,
        prev = r.getRenderTarget();
      try {
        r.setRenderTarget(rt);
        quad.render(r);
        r.setRenderTarget(prev);
        const pixels = await r.readRenderTargetPixelsAsync(rt, 0, 0, n, 1);
        let maxCpuError = 0,
          maxGpuError = 0,
          partial = 0;
        for (let i = 0; i < n; i++) {
          maxCpuError = Math.max(maxCpuError, Math.abs(cpu[i] - want[i]));
          maxGpuError = Math.max(maxGpuError, Math.abs(pixels[i * 4] - want[i]));
          if (want[i] > 0.01 && want[i] < 0.99) partial++;
        }
        const ridge = w.inspect(0, 0, 2).sun.terrainVisibility,
          flight = w.inspect(0, 0, 220).sun.terrainVisibility;
        return { maxCpuError, maxGpuError, partial, ridge, flight, outside: h.visibilityAt(-70, 0, 0) };
      } finally {
        r.setRenderTarget(prev);
        rt.dispose();
        mat.dispose();
        input.dispose();
        h.dispose();
        w.engine.start();
      }
    });
    console.log(backend, report);
    expect(report.partial).toBeGreaterThan(25);
    expect(report.maxCpuError).toBeLessThan(0.012);
    expect(report.maxGpuError).toBeLessThan(0.025);
    expect(report.ridge).toBeLessThan(0.1);
    expect(report.flight).toBe(1);
    expect(report.outside).toBe(1);
    expect(log.errors).toEqual([]);
  });
}
