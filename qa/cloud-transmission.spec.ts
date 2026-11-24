import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' daylight meter samples the broad cloud extinction that lights the ground',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=headland&tier=medium&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const result = await page.evaluate(async () => {
        const w = (window as any).coastDemo.world,
          e = w.engine,
          T = (window as any).THREE,
          t = T.TSL;
        e.stop();
        const model = w.weather.clouds,
          sun = w.weather.sunDirection,
          count = 521,
          p = new T.Vector3();
        const coordinates = new Float32Array(count * 4),
          expected = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          p.set((((i * 89) % 509) - 254) * 110, 2, (((i * 173) % 503) - 251) * 130);
          coordinates.set([p.x, p.y, p.z, 1], 4 * i);
          expected[i] = model.sunTransmissionAt(p, sun, e.time);
        }
        p.y = model.uniforms.top.value + 1;
        const above = model.sunTransmissionAt(p, sun, e.time);
        const tex = new T.DataTexture(coordinates, count, 1, T.RGBAFormat, T.FloatType);
        tex.needsUpdate = true;
        const m = new T.NodeMaterial(),
          q = new T.QuadMesh(m),
          r = e.renderer,
          old = r.getRenderTarget();
        const rt = new T.RenderTarget(count, 1, { type: T.FloatType, depthBuffer: false });
        m.fragmentNode = t.vec4(model.shadow(t.texture(tex, t.uv()).level(0).xyz), 0, 0, 1);
        try {
          r.setRenderTarget(rt);
          q.render(r);
          r.setRenderTarget(old);
          const pixels = await r.readRenderTargetPixelsAsync(rt, 0, 0, count, 1);
          let max = 0,
            error = 0,
            partial = 0,
            clear = 0;
          for (let i = 0; i < count; i++) {
            const v = pixels[4 * i],
              delta = Math.abs(v - expected[i]);
            max = Math.max(max, delta);
            error += delta * delta;
            if (v < 0.94 && v > 0.08) partial++;
            if (v > 0.99) clear++;
          }
          return { max, rms: Math.sqrt(error / count), partial, clear, above };
        } finally {
          r.setRenderTarget(old);
          rt.dispose();
          tex.dispose();
          m.dispose();
        }
      });
      console.log(backend, 'receiver transmission', result);
      expect(log.errors).toEqual([]);
      expect(result.above).toBe(1);
      expect(result.clear).toBeGreaterThan(30);
      expect(result.partial).toBeGreaterThan(10);
      expect(result.rms).toBeLessThan(0.014);
      expect(result.max).toBeLessThan(0.12);
    },
  );
  test(
    backend + ' lens energy agrees with the lit analytic sky on either side of both decks',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=cay&tier=low&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 3);
      const stats = await page.evaluate(async () => {
        const w = (window as any).coastDemo.world,
          T = (window as any).THREE,
          t = T.TSL,
          weather = w.weather;
        w.engine.stop();
        const N = 131,
          r = w.engine.renderer,
          old = r.getRenderTarget(),
          n = new Float32Array(N * 4);
        for (let i = 0; i < N; i++) {
          const h = 0.995 - (1.99 * i) / (N - 1),
            a = ((i * 0.61803398875) % 1) * Math.PI * 2,
            flat = Math.sqrt(1 - h * h);
          n.set([flat * Math.cos(a), h, flat * Math.sin(a), 0], 4 * i);
        }
        const tex = new T.DataTexture(n, N, 1, T.RGBAFormat, T.FloatType);
        tex.needsUpdate = true;
        const dir = t.texture(tex, t.uv()).xyz.normalize(),
          mat = new T.NodeMaterial();
        const full = weather.analyticCloudNode(weather.cloudEye, dir, weather.skyColor(dir)).a;
        mat.fragmentNode = t.vec4(full, weather.analyticCloudTransmittance(dir), 0, 1);
        const target = new T.RenderTarget(N, 1, { type: T.FloatType, depthBuffer: false }),
          quad = new T.QuadMesh(mat);
        let maximum = 0,
          partial = 0,
          clear = 0,
          reads = 0;
        try {
          for (const h of [
            3,
            weather.params.cloudBase + 35,
            weather.params.cloudTop + 75,
            weather.upperClouds.base + 70,
            weather.upperClouds.top + 220,
          ]) {
            weather.cloudEye.value.set(140, h, 200);
            r.setRenderTarget(target);
            quad.render(r);
            r.setRenderTarget(old);
            const p = await r.readRenderTargetPixelsAsync(target, 0, 0, N, 1);
            for (let i = 0; i < N; i++) {
              const x = p[4 * i];
              maximum = Math.max(maximum, Math.abs(x - p[4 * i + 1]));
              if (x > 0.02 && x < 0.98) partial++;
              if (x > 0.998) clear++;
              reads++;
            }
          }
        } finally {
          r.setRenderTarget(old);
          target.dispose();
          tex.dispose();
          mat.dispose();
        }
        return { maximum, partial, clear, reads };
      });
      console.log(backend, stats);
      expect(stats.reads).toBe(655);
      expect(stats.maximum).toBeLessThan(0.0002);
      expect(stats.partial).toBeGreaterThan(20);
      expect(stats.clear).toBeGreaterThan(50);
      expect(log.errors).toEqual([]);
    },
  );
}
