import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TIERS, watchConsole } from './helpers';
const output = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coast', 'salt-pan-routes');
for (const backend of ['webgpu', 'webgl'])
  for (const tier of TIERS)
    test(backend + ' ' + tier + ' loaded cart traverses fracturing salt at 1080p', async ({ page }) => {
      const log = watchConsole(page);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/examples/dry-lake/?tier=' + tier + '&backend=' + backend);
      await page.waitForFunction(() => ((window as any).dryLake?.engine.stats.frames ?? 0) >= 4);
      const fourthObserved = await page.evaluate(() => performance.now());
      await page.getByRole('slider', { name: 'Cart ballast' }).fill('180');
      await page.getByRole('button', { name: 'Roll cart', exact: true }).click();
      await page.waitForFunction(() => (window as any).dryLake.progress > 0);
      const firstMotion = await page.evaluate(() => performance.now());
      const sample = await page.evaluate(async () => {
        const d = (window as any).dryLake,
          e = d.engine,
          start = d.progress,
          frames = e.stats.frames,
          ms: number[] = [];
        let prev = 0;
        await new Promise<void>((resolve) => {
          function frame(now: number) {
            if (prev) ms.push(now - prev);
            prev = now;
            if (ms.length >= 180) resolve();
            else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        });
        const fps = (1000 * ms.length) / ms.reduce((a, b) => a + b, 0);
        ms.sort((a, b) => a - b);
        return {
          fps,
          p95: ms[170],
          p99: ms[178],
          longest: ms[179],
          over33: ms.filter((x) => x > 33).length,
          over50: ms.filter((x) => x > 50).length,
          motion: d.progress - start,
          frames: e.stats.frames - frames,
          scale: e.stats.renderScale,
          draws: e.stats.drawCalls,
          size: [e.canvas.width, e.canvas.height],
          backend: e.backend,
          changedVertices: d.pan.save().pressures.length / 2,
        };
      });
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(
        path.join(output, backend + '-' + tier + '.json'),
        JSON.stringify({ ...sample, fourthObserved, firstMotion, errors: log.errors }, null, 2),
      );
      expect(log.errors).toEqual([]);
      expect(sample.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
      expect(sample.size).toEqual([1920, 1080]);
      expect(sample.motion).toBeGreaterThan(4);
      expect(sample.changedVertices).toBeGreaterThan(100);
      expect(sample.frames).toBeGreaterThanOrEqual(176);
      expect(sample.fps).toBeGreaterThanOrEqual(58);
      expect(sample.p95).toBeLessThanOrEqual(18.5);
    });
