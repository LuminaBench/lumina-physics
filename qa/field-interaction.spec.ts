import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';

for (const webgl of [false, true])
  test(
    'remix a populated level and walk over the driven crossing ' + (webgl ? 'WebGL 2' : 'WebGPU'),
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/field.html?region=game:chalk-stream&tier=medium' + (webgl ? '&webgl' : ''));
      await page.waitForFunction(() => !!(window as any).fieldGuide);
      const before = await page.evaluate(() => {
        const g = (window as any).fieldGuide;
        return {
          site: g.route.inspect(),
          seed: g.world.land.seeds,
          deck: g.route.bridge.height(g.route.bridge.centre, g.route.bridge.z),
          dependencies: g.world.profile.landscape.dependencies,
        };
      });
      await page.locator('#view').selectOption('drive');
      await page.locator('canvas').focus();
      await page.keyboard.down('w');
      await page.waitForFunction(() => {
        const g = (window as any).fieldGuide;
        return Math.abs(g.route.vehicle.speed) > 2 && g.world.land.earth.save().cells.length > 0;
      });
      await page.keyboard.up('w');
      const tires = await page.evaluate(() => {
        const g = (window as any).fieldGuide;
        return g.route.vehicle.wheels.map((v: any) => [v.contact, v.loadRatio]);
      });
      await page.locator('#view').selectOption('walk');
      await page.locator('#direction').selectOption('lumina:graphic');
      await page.locator('#season').selectOption('autumn');
      await page.locator('#time').focus();
      await page.keyboard.press('Home');
      await page.locator('#inspect').click();
      await expect(page.locator('#soil')).toBeVisible();
      const result = await page.evaluate(({ x, z }) => {
        const g = (window as any).fieldGuide,
          w = g.world;
        return {
          original: w.foliage.grove.nearest(x, z)?.id,
          seed: w.land.seeds,
          deck: g.route.bridge.height(g.route.bridge.centre, g.route.bridge.z),
          save: w.land.earth.save(),
          direction: w.profile.landscape.direction,
          season: w.land.earth.season,
          clock: w.profile.time,
          water: w.ocean.waterLevel,
        };
      }, before.site.nearest);
      expect(result.original).toBe(before.site.nearest.id);
      expect(result.seed).toEqual(before.seed);
      expect(result.deck).toBe(before.deck);
      expect(tires.filter(([v]: [boolean]) => v).length).toBeGreaterThanOrEqual(2);
      expect(result.save.cells.length).toBeGreaterThan(0);
      expect(result.direction).toBe('lumina:graphic');
      expect(result.season).toBe('autumn');
      expect(result.clock).toBe(0);
      await page.locator('#tree').click();
      await page.waitForFunction(() => {
        const w = (window as any).fieldGuide.world;
        return w.land.earth
          .save()
          .poses.some((p: any) => Math.abs(p.matrix[1]) + Math.abs(p.matrix[9]) > 0.42);
      });
      expect(log.errors).toEqual([]);
    },
  );

const regions = [
  'winter-ground',
  'tidal-marsh',
  'arid-wash',
  'working-farm',
  'alpine-boreal',
  'urban-verge',
  'stylized-fens',
  'earth-watershed',
];
for (const region of regions)
  test('signature interaction ' + region, async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/field.html?tier=low&region=lumina:' + region);
    await page.waitForFunction(() => !!(window as any).fieldGuide);
    await page.locator('#act').click();
    await page.waitForTimeout(180);
    const state = await page.evaluate(() => {
      const g = (window as any).fieldGuide,
        w = g.world,
        l = w.land;
      return {
        season: l.earth.season,
        view: g.route.view,
        cells: l.earth.save().cells.length,
        tide: w.ocean?.waterLevel,
        direction: w.profile.landscape.direction,
        tiles: g.route.tiles?.residentTiles,
      };
    });
    if (region === 'winter-ground') {
      expect(state.season).toBe('winter');
      expect(state.cells).toBeGreaterThan(0);
    }
    if (region === 'tidal-marsh') expect(state.tide).toBeGreaterThan(0.8);
    if (['arid-wash', 'working-farm', 'urban-verge'].includes(region)) expect(state.cells).toBeGreaterThan(0);
    if (region === 'alpine-boreal') expect(state.view).toBe('walk');
    if (region === 'stylized-fens') expect(state.direction).toBe('lumina:painted');
    if (region === 'earth-watershed') {
      expect(state.tiles).toBeGreaterThan(0);
      const flight = await page.evaluate(() => {
        const g = (window as any).fieldGuide,
          r = g.route,
          id = r.inspect().nearest?.id;
        let count = 0,
          furthest = 0;
        while (r.view === 'flight' && count++ < 1800) {
          r.update(1 / 30);
          furthest = Math.max(furthest, Math.abs(r.flying.x));
        }
        return { id, after: r.inspect().nearest?.id, furthest, view: r.view };
      });
      expect(flight.furthest).toBeGreaterThan(1024);
      expect(flight.view).toBe('walk');
      expect(flight.after).toBe(flight.id);
    }
    expect(log.errors).toEqual([]);
  });
