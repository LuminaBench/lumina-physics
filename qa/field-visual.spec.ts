import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { watchConsole } from './helpers';

const dir = process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/field-candidate/visual';
const save = (page: Page, name: string) =>
  page.screenshot({ path: path.join(dir, name + '.jpg'), quality: 76 });
async function open(page: Page, query: string) {
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/field.html?ui=0&tier=high&' + query);
  await page.waitForFunction(() => !!(window as any).fieldGuide);
}
test('eight art directions in motion, four seasons and a continuous solar clock on the same crossing', async ({
  page,
}) => {
  const log = watchConsole(page);
  await open(page, 'region=lumina:seasonal-woodland&view=ridge&hour=16.5');
  for (const direction of [
    'woodland',
    'mediterranean',
    'atlantic',
    'pastoral',
    'painted',
    'graphic',
    'noir',
    'extraterrestrial',
  ]) {
    await page.evaluate((d) => {
      const { world } = (window as any).fieldGuide;
      world.setDirection('lumina:' + d);
    }, direction);
    await page.waitForTimeout(380);
    await save(page, 'style-' + direction);
    await page.waitForTimeout(400);
    await save(page, 'motion-' + direction);
  }
  await page.evaluate(() => {
    const { world } = (window as any).fieldGuide;
    world.setDirection('lumina:woodland');
  });
  for (const season of ['spring', 'summer', 'autumn', 'winter']) {
    await page.evaluate((s) => (window as any).fieldGuide.world.setSeason(s), season);
    await page.waitForTimeout(300);
    await save(page, 'season-' + season);
  }
  const landmark = await page.evaluate(() => (window as any).fieldGuide.route.inspect().nearest?.id);
  await page.evaluate(() => {
    const g = (window as any).fieldGuide,
      w = g.world;
    w.setSeason('autumn');
    w.patch({ time: 15, weather: 'clear' }, 0);
    g.solarClock = { start: performance.now(), hour: 15 };
    const draw = w.engine.onBeforeRender;
    let previous = -1;
    w.engine.onBeforeRender = (dt: number, t: number) => {
      draw(dt, t);
      const v = Math.min(24, 15 + (performance.now() - g.solarClock.start) / 1100);
      if (v - previous > 0.05 || (v === 24 && previous < 24)) {
        w.patch({ time: v % 24 }, 0.09);
        previous = v;
      }
      g.solarClock.hour = v;
    };
  });
  for (let i = 0; i <= 18; i++) {
    await page.waitForFunction((h) => (window as any).fieldGuide.solarClock.hour >= h, 15 + i * 0.5);
    await save(page, 'clock-' + String(i).padStart(2, '0'));
  }
  const midnight = await page.evaluate(() => ({
    id: (window as any).fieldGuide.route.inspect().nearest?.id,
    sun: (window as any).fieldGuide.world.weather.params.sunElevation,
  }));
  expect(midnight.id).toBe(landmark);
  expect(midnight.sun).toBeLessThan(-12);
  expect(log.errors).toEqual([]);
});

test('same individual trees across detail distances and four ground-level observations', async ({ page }) => {
  const log = watchConsole(page);
  await open(page, 'region=lumina:seasonal-woodland&hour=16.8&view=ridge');
  const report: {id:string;recipe:string;variant:string;shot:string}[] = [];
  for (const species of ['oak', 'willow', 'birch', 'spruce']) {
    for (const shot of ['far', 'near']) {
      const state = await page.evaluate(
        ({ species, shot }) => {
          const g = (window as any).fieldGuide,
            w = g.world,
            c = w.engine.camera,
            grove = w.foliage.grove;
          const tr = grove.nearest(15, -32, c, true, 'lumina:' + species);
          if (!tr) throw new Error('Missing visible ' + species);
          const h = w.land.library.get('plant', tr.recipe).height * tr.scale;
          // Photograph the same instance. Change focal length to keep its crown legible in both views.
          const distance = (shot === 'far' ? h * 16 : h * 2.6) + 1,
            targetY = tr.y + h * 0.54;
          w.engine.onBeforeRender = () => {
            c.position.set(tr.x + distance * 0.38, targetY + distance * 0.145, tr.z - distance * 0.925);
            c.fov = (2 * Math.atan((h * 0.94) / distance) * 180) / Math.PI;
            c.updateProjectionMatrix();
            c.lookAt(tr.x, targetY, tr.z);
            c.updateMatrixWorld();
          };
          return { id: tr.id, recipe: tr.recipe, variant: tr.variant };
        },
        { species, shot },
      );
      report.push({ ...state, shot });
      await page.waitForTimeout(600);
      await save(page, 'tree-' + species + '-' + shot);
    }
    expect(report[report.length - 1].id).toBe(report[report.length - 2].id);
  }
  writeFileSync(path.join(dir, 'landmarks.json'), JSON.stringify(report, null, 2));
  await open(page, 'region=lumina:urban-verge&direction=lumina:noir&hour=23.9&view=drive');
  await page.locator('canvas').focus();
  await page.keyboard.down('w');
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(450);
    await save(page, 'lamps-' + i);
  }
  await page.keyboard.up('w');
  await open(page, 'region=lumina:tidal-marsh&view=ridge');
  await page.evaluate(() => (window as any).fieldGuide.route.act());
  await page.locator('canvas').focus();
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  await save(page, 'tidal-canoe');
  await page.keyboard.up('w');
  await open(page, 'region=lumina:alpine-boreal&view=ridge');
  await save(page, 'alpine-stream');
  await page.evaluate(() => (window as any).fieldGuide.route.act());
  await page.waitForTimeout(400);
  await save(page, 'alpine-ridge');
  await open(page, 'region=lumina:earth-watershed&view=ridge');
  await page.evaluate(() => {
    const r = (window as any).fieldGuide.route;
    r.act();
    for (let i = 0; i < 198; i++) r.update(1 / 30);
  });
  await page.waitForTimeout(200);
  await save(page, 'inland-flight');
  expect(log.errors).toEqual([]);
});
