import { test, expect } from '@playwright/test';
import { watchConsole, TIERS } from './helpers';
import { BIOMES } from '../modules/terrain/biomes';
import { mkdirSync, writeFileSync } from 'node:fs';

for (const backend of ['webgpu', 'webgl2'])
  for (const biome of BIOMES)
    for (const tier of TIERS)
      for (const view of ['headland', 'tire']) {
        test([backend, biome, tier, view, 'foliage at 1080p'].join(' '), async ({ page }) => {
          const log = watchConsole(page);
          await page.setViewportSize({ width: 1920, height: 1080 });
          await page.goto(
            '/profiles.html?ui=0&tier=' +
              tier +
              '&biome=' +
              biome +
              '&view=' +
              view +
              (backend === 'webgl2' ? '&webgl=1' : ''),
          );
          await page.waitForFunction(() => !!(window as any).profileGallery);
          await page.waitForTimeout(1900);
          const sample = await page.evaluate(async () => {
            const g = (window as any).profileGallery,
              e = g.world.engine;
            const frames: number[] = [];
            const frameStart = e.stats.frames;
            let leastCover = Infinity;
            let last = 0;
            await new Promise<void>((resolve) => {
              const next = (now: number) => {
                if (last) frames.push(now - last);
                if (frames.length % 30 === 0)
                  leastCover = Math.min(leastCover, g.world.foliage.meadow.visibleBlades);
                last = now;
                if (frames.length < 180) requestAnimationFrame(next);
                else resolve();
              };
              requestAnimationFrame(next);
            });
            frames.sort((a, b) => a - b);
            return {
              backend: e.backend,
              engineFrames: e.stats.frames - frameStart,
              leastCover,
              readyMs: g.readyMs,
              p95: frames[171],
              fps: 180000 / frames.reduce((a, b) => a + b, 0),
              scale: e.stats.renderScale,
              width: e.renderer.domElement.width,
              height: e.renderer.domElement.height,
              grass: g.world.foliage.meadow.visibleBlades,
              submittedBlades: g.world.foliage.meadow.submittedBlades,
              reeds: g.world.foliage.reeds.count,
              trees: g.world.foliage.grove.visiblePlants,
              tier: e.quality.preset.tier,
              biome: g.world.profile.biome,
              drawCalls: e.stats.drawCalls,
            };
          });
          console.log(backend, biome, tier, view, JSON.stringify(sample));
          mkdirSync('qa/output/profiles', { recursive: true });
          writeFileSync(
            'qa/output/profiles/foliage-' + [backend, biome, tier, view].join('-') + '.json',
            JSON.stringify(sample),
          );
          if (tier === 'low' && backend === 'webgl2') {
            await page.screenshot({ path: 'qa/output/profiles/low-' + biome + '-' + view + '.png' });
          }
          expect(log.errors).toEqual([]);
          expect(sample.backend).toBe(backend);
          expect(sample.engineFrames).toBeGreaterThanOrEqual(175);
          expect(sample.drawCalls).toBeGreaterThan(0);
          expect(sample.biome).toBe(biome);
          expect(sample.tier).toBe(tier);
          expect(sample.grass).toBeGreaterThan(100);
          if (tier === 'ultra') expect(sample.leastCover).toBeGreaterThanOrEqual(150000);
          expect(sample.trees).toBeGreaterThan(1);
          expect(sample.fps).toBeGreaterThanOrEqual(58);
          expect(sample.p95).toBeLessThanOrEqual(18);
        });
      }
