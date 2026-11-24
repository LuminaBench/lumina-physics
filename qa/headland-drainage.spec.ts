import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' routes finite rain through the roof, kerb, grates and individual wheels',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=boulevard&view=drive&tier=medium&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 3);
      const shower = page.getByRole('button', { name: 'Street shower' }),
        grate = page.getByRole('button', { name: 'Block grate' });
      await shower.click();
      await grate.click();
      await page.waitForFunction(() => (window as any).coastDemo.road.drainage.budget.roofLitres > 0.3);
      await shower.click();
      expect(await shower.getAttribute('aria-pressed')).toBe('false');
      expect(await grate.getAttribute('aria-pressed')).toBe('true');
      const data = await page.evaluate(async () => {
        const { road, world: w, vehicles } = (window as any).coastDemo,
          T = (window as any).THREE,
          t = T.TSL;
        w.engine.stop();
        const d = road.drainage,
          D = d.constructor,
          o = d.options;
        const clone = () => new D(o),
          closed = clone(),
          open = clone(),
          reloaded = clone();
        const original = closed.save();
        closed.setGrate(0, 0);
        for (const s of [closed, open]) s.update(9.75, 86, 0.4);
        const snap = JSON.parse(JSON.stringify(closed.save()));
        reloaded.restore(snap);
        const roofAtEnd = closed.budget.roofLitres;
        const flowAtEnd = closed.budget.downspoutLps;
        for (const s of [closed, open, reloaded]) s.update(6, 0, 0.7);
        const resumeError = Math.max(
          ...Object.keys(closed.budget).map((k) => Math.abs(closed.budget[k] - reloaded.budget[k])),
        );
        const sample = (m: any) => m.depthAt(o.roof.outletX, o.roof.outletZ);
        const ratio = closed.budget.roofLitres / roofAtEnd,
          opening = sample(closed) - sample(open);
        const budgetError = (m: any) => {
          const b = m.budget;
          return Math.abs(
            b.initialLitres +
              b.rainLitres -
              b.streetLitres -
              b.roofLitres -
              b.evaporatedLitres -
              b.sewerLitres,
          );
        };
        const q = new Float32Array(4 * 72),
          n = q.length / 4;
        for (let i = 0; i < n; i++) {
          const x = road.road.x - 4.4 + (8.8 * (i % 12)) / 11,
            z = road.road.z - 20 + 7 * Math.floor(i / 12);
          q.set([x, z, 0, 0], 4 * i);
        }
        const tex = new T.DataTexture(q, n, 1, T.RGBAFormat, T.FloatType);
        tex.needsUpdate = true;
        const mat = new T.NodeMaterial();
        mat.fragmentNode = t.vec4(d.depthNode(t.texture(tex, t.uv()).xy), 0, 0, 1);
        const target = new T.RenderTarget(n, 1, { type: T.FloatType, depthBuffer: false }),
          renderer = w.engine.renderer;
        const previous = renderer.getRenderTarget();
        let maxShader = 0;
        try {
          renderer.setRenderTarget(target);
          new T.QuadMesh(mat).render(renderer);
          renderer.setRenderTarget(previous);
          const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, n, 1);
          for (let i = 0; i < n; i++)
            maxShader = Math.max(maxShader, Math.abs(px[4 * i] - d.depthAt(q[4 * i], q[4 * i + 1])));
          // Position the real Rapier rig at the surveyed one-sided puddle and let suspension settle.
          const car = vehicles.car,
            z = road.road.z,
            x = road.road.x - 0.38;
          car.chassis.setTranslation({ x, y: road.heightAt(x, z) + 0.63, z }, true);
          car.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
          car.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
          car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
          w.engine.physics.snap(car.chassis);
          for (let i = 0; i < 60; i++) {
            w.engine.physics.step(1 / 60, 4);
            car.update(1 / 60, w.engine.time);
          }
          const wheels = car.wheels.map((v: any) => ({
            x: v.position.x,
            depth: v.depth,
            contact: v.contact,
            fromStreet: d.depthAt(v.position.x, v.position.z),
          }));
          const bad = { ...snap, depths: snap.depths.slice() };
          bad.depths[1] += 7;
          let rejected = false;
          try {
            reloaded.restore(bad);
          } catch {
            rejected = true;
          }
          return {
            roofAtEnd,
            flowAtEnd,
            ratio,
            opening,
            resumeError,
            maxShader,
            wheels,
            rejected,
            loss: Math.max(budgetError(closed), budgetError(open)),
            remainingDischarge: closed.budget.downspoutLps,
            openOutflow: open.budget.sewerLitres,
            closedOutflow: closed.budget.sewerLitres,
            initialLeft: original.depths.reduce((m: number, v: number) => Math.max(m, v), 0),
          };
        } finally {
          renderer.setRenderTarget(previous);
          tex.dispose();
          mat.dispose();
          target.dispose();
          closed.dispose();
          open.dispose();
          reloaded.dispose();
        }
      });
      console.log(backend, data);
      expect(data.roofAtEnd).toBeGreaterThan(5);
      expect(data.ratio).toBeGreaterThan(0.3);
      expect(data.ratio).toBeLessThan(0.55);
      expect(data.remainingDischarge).toBeGreaterThan(0.05);
      expect(data.remainingDischarge).toBeLessThan(data.flowAtEnd);
      expect(data.openOutflow).toBeGreaterThan(data.closedOutflow);
      expect(data.opening).toBeGreaterThan(0.0003);
      expect(data.loss).toBeLessThan(0.000001);
      expect(data.resumeError).toBeLessThan(1e-9);
      expect(data.rejected).toBe(true);
      expect(data.maxShader).toBeLessThan(0.0001);
      expect(data.wheels.every((v: { contact: boolean }) => v.contact)).toBe(true);
      expect(Math.max(...data.wheels.map((v: { depth: number }) => v.depth))).toBeGreaterThan(0.012);
      expect(Math.min(...data.wheels.map((v: { depth: number }) => v.depth))).toBeLessThan(0.002);
      for (const v of data.wheels) expect(Math.abs(v.depth - v.fromStreet)).toBeLessThan(0.001);
      expect(log.errors).toEqual([]);
    },
  );
}
