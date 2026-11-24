import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { watchConsole, TIERS } from './helpers';

const captures = process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/field-candidate/scenes';
const families = [
  ['seasonal-woodland', 'woodland', 'walk'],
  ['winter-ground', 'atlantic', 'drive'],
  ['tidal-marsh', 'painted', 'ridge'],
  ['arid-wash', 'mediterranean', 'walk'],
  ['working-farm', 'pastoral', 'overhead'],
  ['alpine-boreal', 'atlantic', 'ridge'],
  ['urban-verge', 'noir', 'drive'],
  ['stylized-fens', 'extraterrestrial', 'walk'],
  ['earth-watershed', 'atlantic', 'flight'],
  ['atlantic-headland', 'graphic', 'ridge'],
  ['dry-escarpment', 'painted', 'ridge'],
  ['game:chalk-stream', 'game:ochre-gouache', 'ridge'],
];
const rows = [
  ...families.map(([region, direction, view]) => ({ region, direction, view, tier: 'high' })),
  ...TIERS.map((tier) => ({ region: 'seasonal-woodland', direction: 'woodland', view: 'drive', tier })),
];
for (const backend of ['webgpu', 'webgl2'])
  for (const { region, direction, view, tier } of rows) {
    test([backend, region, direction, view, tier, 'field route'].join(' '), async ({ page }) => {
      const log = watchConsole(page),
        id = [region, direction, view, tier, backend].join('-').replaceAll(':', '-');
      const name = (s: string) => (s.includes(':') ? s : 'lumina:' + s);
      await page.setViewportSize({ width: 1920, height: 1080 });
      const args = new URLSearchParams({
        region: name(region),
        direction: name(direction),
        view,
        tier,
        ui: '0',
      });
      if (backend === 'webgl2') args.set('webgl', '1');
      await page.goto('/field.html?' + args);
      await page.waitForFunction(() => !!(window as any).fieldGuide);
      await page.locator('canvas').click({ position: { x: 80, y: 80 } });
      await page.waitForTimeout(1700);
      if (view === 'drive' || view === 'walk') await page.keyboard.down('w');
      const sample = await page.evaluate(async () => {
        const g = (window as any).fieldGuide,
          e = g.world.engine,
          intervals: number[] = [];
        const start = e.stats.frames;
        const stalls: { frame: number; interval: number; cpu: number; submit: number; draws: number }[] = [];
        let last = 0,
          maxHeap = 0,
          maxTiles = 0;
        await new Promise<void>((resolve) => {
          function tick(t: number) {
            if (last) {
              intervals.push(t - last);
              if (t - last > 32 && stalls.length < 12)
                stalls.push({
                  frame: intervals.length,
                  interval: t - last,
                  cpu: e.stats.cpuMs,
                  submit: e.stats.submitMs,
                  draws: e.stats.drawCalls,
                });
            }
            last = t;
            maxHeap = Math.max(maxHeap, (performance as any).memory?.usedJSHeapSize ?? 0);
            maxTiles = Math.max(maxTiles, g.route.tiles?.residentTiles ?? 0);
            if (intervals.length < 180) requestAnimationFrame(tick);
            else resolve();
          }
          requestAnimationFrame(tick);
        });
        const sum = intervals.reduce((v, n) => v + n, 0);
        intervals.sort((a, b) => a - b);
        return {
          backend: e.backend,
          firstUsableMs: g.readyMs,
          firstInputMs: g.firstInputMs,
          frames: e.stats.frames - start,
          fps: 180000 / sum,
          p95: intervals[170],
          p99: intervals[178],
          longest: intervals[179],
          stalls,
          hitches: intervals.filter((n) => n > 25).length,
          maxHeap,
          maxTiles,
          scale: e.stats.renderScale,
          width: e.renderer.domElement.width,
          height: e.renderer.domElement.height,
          speed: g.route.vehicle?.speed ?? null,
          trees: g.world.foliage.grove.visiblePlants,
          blades: g.world.foliage.meadow.visibleBlades,
          textures: e.renderer.info.memory.textures,
          geometries: e.renderer.info.memory.geometries,
        };
      });
      await page.keyboard.up('w');
      mkdirSync(captures, { recursive: true });
      const report = { region, direction, view, tier, ...sample, consoleErrors: log.errors };
      writeFileSync(path.join(captures, id + '.json'), JSON.stringify(report, null, 2));
      if (tier === 'high' && backend === 'webgpu')
        await page.screenshot({ path: path.join(captures, id + '.jpg'), quality: 76 });
      console.log(id, JSON.stringify(report));
      expect(log.errors).toEqual([]);
      expect(sample.backend).toBe(backend);
      expect(sample.frames).toBeGreaterThanOrEqual(175);
      if (view === 'drive') expect(Math.abs(sample.speed ?? 0)).toBeGreaterThan(2);
      expect(sample.firstInputMs).toBeGreaterThan(0);
      expect(sample.maxTiles).toBeLessThanOrEqual(25);
      expect(sample.fps).toBeGreaterThanOrEqual(58);
      expect(sample.p95).toBeLessThanOrEqual(18.5);
    });
  }
