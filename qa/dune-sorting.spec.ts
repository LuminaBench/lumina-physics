import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' dune conserves independent grain sizes through wind, a cut and save migration',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=headland&tier=high&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const result = await page.evaluate(async () => {
        const world = (window as any).coastDemo.world,
          T = (window as any).THREE,
          t = T.TSL;
        world.engine.stop();
        const opts = {
          centerX: 0,
          centerZ: 0,
          size: 6.4,
          resolution: 65,
          seed: 83,
          rippleHeading: 0,
          thicknessAt: (x: number, z: number) => 0.1 * Math.exp(-(x * x + z * z) / 0.4),
          coarseFractionAt: () => 0.55,
          coarseMobility: 0.2,
        };
        const D = world.dune.constructor,
          d = new D(opts, () => 0);
        const moment = () => {
          let fine = 0,
            coarse = 0,
            fx = 0,
            cx = 0;
          for (let i = 0; i < d.mobile.length; i++) {
            const c = d.coarseDepth[i],
              f = d.mobile[i] - c,
              x = d.originX + (i % d.resolution) * d.spacing;
            if (c < 0 || f < 0 || !Number.isFinite(c + f)) throw Error('Nonphysical grain thickness');
            fine += f;
            coarse += c;
            fx += f * x;
            cx += c * x;
          }
          return {
            fine: fine * d.spacing * d.spacing,
            coarse: coarse * d.spacing * d.spacing,
            fx: fx / fine,
            cx: cx / coarse,
          };
        };
        const before = moment();
        for (let i = 0; i < 54; i++) d.update(1 / 12, 14, 0, 0);
        const drift = moment();
        d.cut(0.2, 0, 1.1, 0.54, 0.4, 0.07, -0.6, 0.1);
        const cut = moment(),
          first = d.rippleAxis.value.clone();
        d.update(1 / 12, 0, 14, 0);
        const one = d.rippleAxis.value.clone();
        for (let i = 0; i < 180; i++) d.update(1 / 12, 0, 14, 0);
        const reworked = d.rippleAxis.value.clone();
        for (let i = 0; i < 20; i++) d.update(1 / 12, -18, 0, 1);
        const saturated = d.rippleAxis.value.distanceTo(reworked);
        d.update(0.032, 0, 0, 0);
        const beforeSave = moment(),
          v2 = d.save();
        d.update(0.25, -10, 0, 0);
        d.restore(v2);
        const resumed = moment(),
          savedAxis = d.rippleAxis.value.distanceTo(reworked);
        const valid = d.volume(),
          corrupt = { ...v2, coarse: [...v2.coarse] };
        corrupt.coarse[1] = 10000;
        let rejected = false;
        try {
          d.restore(corrupt);
        } catch {
          rejected = true;
        }
        const atomic = d.volume() === valid;
        const centre = 32 * 65 + 32,
          mesh = world.dune,
          readPoint = new T.Vector2(opts.centerX, opts.centerZ);
        const mat = new T.NodeMaterial(),
          target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
        const quad = new T.QuadMesh(mat),
          renderer = world.engine.renderer,
          old = renderer.getRenderTarget();
        let shaderError = 0,
          cover = 0;
        try {
          mat.fragmentNode = d.compositionNode(t.uniform(readPoint));
          renderer.setRenderTarget(target);
          quad.render(renderer);
          renderer.setRenderTarget(old);
          const a = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          cover = a[2];
          shaderError = Math.abs(a[1] / Math.max(0.0001, a[2]) - d.coarseDepth[centre] / d.mobile[centre]);
        } finally {
          renderer.setRenderTarget(old);
          target.dispose();
          mat.dispose();
        }
        const { coarse: omit, rippleHeading: heading, remainder, ...legacy } = v2;
        d.restore({ ...legacy, version: 1 });
        const v1 = moment();
        d.dispose();
        return {
          backend: world.engine.backend,
          source: mesh.resolution,
          before,
          drift,
          cut,
          beforeSave,
          resumed,
          v1,
          first: first.y,
          one: one.y,
          reworked: reworked.y,
          saturated,
          savedAxis,
          atomic,
          rejected,
          cover,
          shaderError,
        };
      });
      console.log(backend, result);
      expect(result.backend).toBe(backend === 'webgl' ? 'webgl2' : backend);
      expect(result.drift.fx - result.before.fx).toBeGreaterThan(0.045);
      expect(result.drift.fx - result.before.fx).toBeGreaterThan(2 * (result.drift.cx - result.before.cx));
      for (const after of [result.drift, result.cut, result.beforeSave]) {
        expect(Math.abs(after.fine / result.before.fine - 1)).toBeLessThan(0.0001);
        expect(Math.abs(after.coarse / result.before.coarse - 1)).toBeLessThan(0.0001);
      }
      expect(result.first).toBeCloseTo(0);
      expect(result.one).toBeGreaterThan(0);
      expect(result.one).toBeLessThan(0.15);
      expect(result.reworked).toBeGreaterThan(0.7);
      expect(result.saturated).toBeLessThan(1e-7);
      expect(result.savedAxis).toBeLessThan(1e-7);
      expect(Math.abs(result.resumed.coarse / result.beforeSave.coarse - 1)).toBeLessThan(0.02);
      expect(result.v1.coarse / (result.v1.fine + result.v1.coarse)).toBeCloseTo(0.55, 5);
      expect(result.atomic && result.rejected).toBe(true);
      expect(result.cover).toBeGreaterThan(0.15);
      expect(result.shaderError).toBeLessThan(0.012);
      expect(log.errors).toEqual([]);
    },
  );
}
