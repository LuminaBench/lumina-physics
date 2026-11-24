import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' sea enters over the sill, strands wrack and leaves a navigable pool',
    async ({ page }, testInfo) => {
      const log = watchConsole(page);
      const dest = process.env.LUMINA_CAPTURE_DIR
        ? path.join(process.env.LUMINA_CAPTURE_DIR, backend)
        : testInfo.outputPath('inlet');
      mkdirSync(dest, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=inlet&tier=high&view=walk&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      await page.locator('summary').click();
      await page.getByRole('button', { name: 'High sea' }).click();
      await expect(page.locator('#conditions')).toContainText('Sill current');
      await page.evaluate(() => {
        const d = (window as any).coastDemo,
          w = d.world,
          e = w.engine,
          s = w.inlet,
          T = (window as any).THREE,
          t = T.TSL;
        e.stop();
        e.setDynamicResolution(false);
        const markers = d.inletMarkers,
          sillX = -14.3,
          sillZ = 8 + 0.85 * Math.sin((sillX + 22) * 0.13),
          flow = new T.Vector3();
        let clock = performance.now();
        e.lastNow = clock;
        const release = markers.pieces.map((p: any) => p.position.clone());
        const wasAground = markers.pieces.map((p: any) => p.grounded);
        const camera = e.onBeforeRender;
        e.onBeforeRender = () => {
          e.camera.position.set(-7.2, 2.55, 15.6);
          e.camera.lookAt(-14.15, 0.13, 8.55);
        };
        (window as any).inletRun = {
          advance(seconds: number) {
            let flood = 0,
              ebb = 0,
              travel = 0,
              refloated = false;
            const stage = w.ocean.waterLevel;
            for (let i = 0; i < seconds * 20; i++) {
              s.update(0.05, stage);
              markers.update(0.05);
              flood = Math.max(flood, markers.sillCurrent);
              ebb = Math.min(ebb, markers.sillCurrent);
              markers.pieces.forEach((p: any, j: number) => {
                travel = Math.max(travel, p.position.distanceTo(release[j]));
                if (wasAground[j] && !p.grounded) refloated = true;
              });
            }
            return {
              sea: stage,
              pool: w.ocean.meanLevelAt(-4, 8),
              sillBed: w.ground(sillX, sillZ),
              sillSurface: w.ocean.heightAt(sillX, sillZ),
              depth: w.ocean.depthAt(sillX, sillZ),
              flood,
              ebb,
              travel,
              refloated,
              ...s.balance(),
            };
          },
          async frame() {
            for (let i = 0; i < 14; i++) {
              await new Promise(requestAnimationFrame);
              e.tick((clock += 1000 / 60));
            }
          },
          async read() {
            const count = 96,
              xz = t.vec2(t.uv().x.mul(43).sub(32), 8.55);
            const node = s.fieldNode(xz);
            const m = new T.NodeMaterial();
            m.fragmentNode = t.vec4(w.ocean.surfaceHeightNode(xz), node.g, node.b, s.concentrationNode(xz));
            const quad = new T.QuadMesh(m),
              dst = new T.RenderTarget(count, 1, { type: T.FloatType, depthBuffer: false });
            const renderer = e.renderer,
              saved = renderer.getRenderTarget();
            let heightError = 0,
              currentError = 0,
              siltError = 0;
            try {
              renderer.setRenderTarget(dst);
              quad.render(renderer);
              renderer.setRenderTarget(saved);
              const pixels = await renderer.readRenderTargetPixelsAsync(dst, 0, 0, count, 1);
              for (let i = 0; i < count; i++) {
                const x = -32 + (43 * (i + 0.5)) / count;
                const height = w.ocean.heightAt(x, 8.55);
                s.applyCurrent(x, 8.55, flow.set(0, 0, 0));
                heightError = Math.max(heightError, Math.abs(pixels[i * 4] - height));
                currentError = Math.max(
                  currentError,
                  Math.abs(pixels[i * 4 + 1] - flow.x),
                  Math.abs(pixels[i * 4 + 2] - flow.z),
                );
                siltError = Math.max(siltError, Math.abs(pixels[i * 4 + 3] - s.concentrationAt(x, 8.55)));
              }
            } finally {
              renderer.setRenderTarget(saved);
              dst.dispose();
              m.dispose();
            }
            return { backend: e.backend, heightError, currentError, siltError, count };
          },
          helm() {
            e.onBeforeRender = camera;
          },
        };
      });
      const record = async (name: string) => {
        await page.locator('aside').evaluate((el) => (el.style.visibility = 'hidden'));
        await page.evaluate(() => (window as any).inletRun.frame());
        await page.screenshot({ path: path.join(dest, name + '.png') });
        await page.locator('aside').evaluate((el) => (el.style.visibility = 'visible'));
      };
      const flood = await page.evaluate(() => (window as any).inletRun.advance(35));
      await record('inlet-flood');
      const highGpu = await page.evaluate(() => (window as any).inletRun.read());
      await page.getByRole('button', { name: 'Low sea' }).click();
      const ebb = await page.evaluate(() => (window as any).inletRun.advance(110));
      await record('inlet-ebb');
      const lowGpu = await page.evaluate(() => (window as any).inletRun.read());
      await page.evaluate(() => (window as any).inletRun.helm());
      const beforeHelm = await page.evaluate(() => (window as any).coastDemo.world.engine.stats.frames);
      await page.getByRole('button', { name: 'Skiff', exact: true }).click();
      await page.waitForFunction(
        (n) => (window as any).coastDemo.world.engine.stats.frames > n + 4,
        beforeHelm,
      );
      await expect(page.locator('#skiff-controls')).toBeVisible();
      await page.getByRole('slider', { name: 'Load (kg)', exact: true }).fill('70');
      const boat = await page.evaluate(() => {
        const d = (window as any).coastDemo,
          w = d.world,
          b = d.skiff;
        w.engine.stop();
        const keys = new Set<string>();
        for (let i = 0; i < 320; i++) {
          b.drive(1 / 60, keys, false);
          w.engine.physics.step(1 / 60, 4);
        }
        const keel = w.ocean.depthAt(b.mesh.position.x, b.mesh.position.z) - b.reading.draft;
        keys.add('KeyW');
        const before = w.inlet.balance().suspendedKg;
        for (let i = 0; i < 180; i++) {
          b.drive(1 / 60, keys, false);
          w.engine.physics.step(1 / 60, 4);
          w.inlet.update(1 / 60, w.ocean.waterLevel);
        }
        return {
          load: b.load.kg,
          draft: b.reading.draft,
          keel,
          stirred: w.inlet.balance().suspendedKg - before,
        };
      });
      console.log(backend, { flood, ebb, highGpu, lowGpu, boat });
      expect(flood.sea).toBeCloseTo(0.65, 2);
      expect(flood.pool).toBeGreaterThan(0.4);
      expect(flood.flood).toBeGreaterThan(0.4);
      expect(flood.travel).toBeGreaterThan(0.7);
      expect(flood.refloated).toBeTruthy();
      expect(ebb.sea).toBeCloseTo(-0.65, 2);
      expect(ebb.ebb).toBeLessThan(-0.4);
      expect(ebb.pool - ebb.sea).toBeGreaterThan(0.65);
      expect(flood.depth - ebb.depth).toBeGreaterThan(0.22);
      expect(Math.abs(ebb.waterErrorM3)).toBeLessThan(1e-7);
      expect(Math.abs(ebb.sedimentErrorKg)).toBeLessThan(1e-7);
      for (const g of [highGpu, lowGpu]) {
        expect(g.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
        expect(g.heightError).toBeLessThan(0.012);
        expect(g.currentError).toBeLessThan(0.015);
        expect(g.siltError).toBeLessThan(0.001);
      }
      expect(boat.load).toBe(70);
      expect(boat.draft).toBeGreaterThan(0.09);
      expect(boat.keel).toBeGreaterThan(0.5);
      expect(boat.stirred).toBeGreaterThan(0.001);
      expect(log.errors).toEqual([]);
    },
  );
}
