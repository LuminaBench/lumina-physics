import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { watchConsole, TIERS } from './helpers';

const output = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coast', 'routes');
for (const backend of ['webgpu', 'webgl2'])
  for (const [view, shore] of [
    ['walk', 'atlantic'],
    ['walk', 'headland'],
    ['drive', 'boulevard'],
    ['fly', 'cay'],
    ['skiff', 'inlet'],
  ])
    for (const tier of TIERS) {
      test([backend, view, shore, tier, 'coastal replay'].join(' '), async ({ page }) => {
        const id = [shore, view, tier, backend].join('-'),
          log = watchConsole(page);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(
          '/coast.html?shore=' +
            shore +
            '&view=' +
            view +
            '&tier=' +
            tier +
            '&backend=' +
            (backend === 'webgl2' ? 'webgl' : 'webgpu'),
        );
        await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 2);
        const ready = await page.evaluate(() => performance.now());
        if (shore === 'inlet') await page.getByRole('button', { name: 'High sea' }).click();
        const slider = page.getByRole('slider', { name: 'Solar hour' });
        const before = await slider.inputValue();
        await slider.focus();
        await slider.press('ArrowRight');
        await expect(slider).not.toHaveValue(before);
        const input = await page.evaluate(
          () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now()))),
        );
        if (view === 'walk') {
          await page.locator('canvas').focus();
          await page.keyboard.down('w');
        }
        await page.waitForTimeout(1750);
        const sample = await page.evaluate(async () => {
          const d = (window as any).coastDemo,
            e = d.world.engine,
            times: number[] = [],
            pos = e.camera.position.clone();
          let last = 0,
            tiles = 0,
            heap = 0;
          const start = e.stats.frames;
          await new Promise<void>((resolve) => {
            function frame(t: number) {
              if (last) times.push(t - last);
              last = t;
              tiles = Math.max(tiles, d.world.sediment.tiles.size);
              heap = Math.max(heap, (performance as any).memory?.usedJSHeapSize ?? 0);
              if (times.length >= 180) resolve();
              else requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
          });
          const fps = (times.length * 1000) / times.reduce((a, b) => a + b, 0);
          times.sort((a, b) => a - b);
          return {
            backend: e.backend,
            fps,
            p95: times[170],
            p99: times[178],
            longest: times[179],
            hitches: times.filter((t) => t > 25).length,
            frames: e.stats.frames - start,
            motion: e.camera.position.distanceTo(pos),
            scale: e.stats.renderScale,
            tiles,
            heap,
            size: [e.canvas.width, e.canvas.height],
            draws: e.stats.drawCalls,
            textures: e.renderer.info.memory.textures,
            carSpeed: d.vehicles.car?.speed ?? 0,
          };
        });
        if (view === 'walk') await page.keyboard.up('w');
        const result = { ...sample, id, ready, input, errors: log.errors };
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, id + '.json'), JSON.stringify(result, null, 2));
        if (tier === 'high' && backend === 'webgpu')
          await page.screenshot({ path: path.join(output, id + '.jpg'), quality: 87 });
        expect(log.errors).toEqual([]);
        expect(sample.backend).toBe(backend);
        expect(sample.size).toEqual([1920, 1080]);
        expect(sample.motion).toBeGreaterThan(1);
        expect(sample.frames).toBeGreaterThanOrEqual(176);
        expect(sample.fps).toBeGreaterThanOrEqual(58);
        expect(sample.p95).toBeLessThanOrEqual(18.5);
      });
    }
