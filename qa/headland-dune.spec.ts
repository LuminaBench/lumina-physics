import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';
for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' moves a finite dune, exposes its bed and preserves its surface across reload',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=headland&tier=medium&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const volume = await page.evaluate(() => {
        const d = (window as any).coastDemo.world.dune;
        if (d.depthAt(d.options.centerX, d.options.centerZ) < 0.45)
          throw Error('Dune cut must start in loose sand');
        return d.volume();
      });
      await page.getByRole('button', { name: 'Cut dune' }).click();
      await page.waitForFunction(() => {
        const d = (window as any).coastDemo.world.dune;
        return d.depthAt(d.options.centerX, d.options.centerZ) < 0.16;
      });
      const data = await page.evaluate(async () => {
        const { world: w } = (window as any).coastDemo,
          T = (window as any).THREE,
          t = T.TSL,
          d = w.dune,
          physics = w.engine.physics;
        await new Promise((r) => setTimeout(r, 250));
        w.engine.stop();
        const n = 47,
          locations = new Float32Array(4 * n);
        for (let i = 0; i < n; i++) {
          const x = d.options.centerX + 2.5 * Math.sin(i * 0.78),
            z = d.options.centerZ + 1.9 * Math.cos(i * 0.81);
          locations.set([x, z, w.ground(x, z), 0], 4 * i);
        }
        const tex = new T.DataTexture(locations, n, 1, T.RGBAFormat, T.FloatType);
        tex.needsUpdate = true;
        const pos = t.texture(tex, t.uv()).level(0);
        const mat = new T.NodeMaterial();
        mat.fragmentNode = t.vec4(w.bed.heightNode(pos.xy), d.depthNode(pos.xy), 0, 1);
        const quad = new T.QuadMesh(mat),
          rt = new T.RenderTarget(n, 1, { type: T.FloatType, depthBuffer: false }),
          r = w.engine.renderer,
          saved = r.getRenderTarget();
        let shaderError = 0,
          colliderError = 0,
          hits = 0;
        try {
          r.setRenderTarget(rt);
          quad.render(r);
          r.setRenderTarget(saved);
          const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, n, 1);
          for (let i = 0; i < n; i++) {
            const k = 4 * i,
              x = locations[k],
              z = locations[k + 1],
              h = locations[k + 2];
            shaderError = Math.max(shaderError, Math.abs(px[k] - h), Math.abs(px[k + 1] - d.depthAt(x, z)));
            const ray = new physics.RAPIER.Ray({ x, y: h + 1, z }, { x: 0, y: -1, z: 0 });
            const hit = physics.world.castRay(ray, 2, true);
            if (hit) {
              hits++;
              colliderError = Math.max(colliderError, Math.abs(1 - hit.timeOfImpact));
            }
          }
        } finally {
          r.setRenderTarget(saved);
          rt.dispose();
          tex.dispose();
          mat.dispose();
        }
        const D = d.constructor,
          setup = {
            size: 5,
            centerX: 0,
            centerZ: 0,
            resolution: 51,
            seed: 315,
            thicknessAt: (x: number, z: number) => (Math.abs(x) < 0.51 && Math.abs(z) < 0.51 ? 0.8 : 0),
          };
        const runs: { moment: number; spread: number; loss: number }[] = [];
        for (const [damp, roots, wind] of [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 12],
          [0, 0, -12],
        ]) {
          const model = new D({ ...setup, rootsAt: () => roots }, () => 0),
            before = model.volume();
          for (let i = 0; i < 110; i++) model.update(1 / 12, wind, 0, damp);
          let moment = 0,
            spread = 0;
          for (let z = 0, i = 0; z < 51; z++)
            for (let x = 0; x < 51; x++, i++) {
              moment += model.mobile[i] * (x - 25);
              spread += model.mobile[i] * Math.hypot(x - 25, z - 25);
            }
          runs.push({ moment, spread, loss: Math.abs(model.volume() - before) / before });
          model.dispose();
        }
        const snapshot = d.save(),
          pre = d.depthAt(d.options.centerX - 0.6, d.options.centerZ);
        d.cut(d.options.centerX - 0.6, d.options.centerZ, 1.8, 0.65, 0, 0.3, 0.9, 0);
        d.restore(snapshot);
        return {
          runs,
          volume: d.volume(),
          shaderError,
          colliderError,
          hits,
          restoreError: Math.abs(pre - d.depthAt(d.options.centerX - 0.6, d.options.centerZ)),
        };
      });
      console.log(backend, data);
      expect(Math.abs(volume - data.volume) / volume).toBeLessThan(0.02);
      expect(data.hits).toBe(47);
      expect(data.shaderError).toBeLessThan(0.01);
      expect(data.colliderError).toBeLessThan(0.01);
      expect(data.restoreError).toBeLessThan(0.0001);
      for (const run of data.runs) expect(run.loss).toBeLessThan(0.0001);
      expect(data.runs[0].spread).toBeGreaterThan(data.runs[1].spread);
      expect(data.runs[0].spread).toBeGreaterThan(data.runs[2].spread);
      expect(data.runs[3].moment).toBeGreaterThan(0);
      expect(data.runs[4].moment).toBeLessThan(0);
      expect(log.errors).toEqual([]);
    },
  );
}
