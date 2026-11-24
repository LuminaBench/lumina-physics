import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { watchConsole } from './helpers';

async function frames(page: Page, count: number) {
  const current = await page.evaluate(() => (window as any).reach.world.engine.stats.frames);
  await page.waitForFunction(
    (limit) => (window as any).reach.world.engine.stats.frames >= limit,
    current + count,
  );
}

async function photographFlower(page: Page) {
  const sample = await page.evaluate(() => {
    const { world, spec } = (window as any).reach;
    const engine = world.engine,
      scene = engine.scene;
    const flower = scene.getObjectByName(spec.bloomId);
    const road = scene.getObjectByName('Chalk crossing, surfaced carriageway');
    engine.paused = true;
    return {
      id: spec.bloomId,
      count: flower.count,
      triangles: flower.geometry.index.count / 3,
      placement: Array.from(flower.instanceMatrix.array).slice(0, flower.count * 16),
      landmark: world.foliage.grove.nearest(0, 0, undefined, true),
      road: Array.from(road.geometry.attributes.position.array),
      backend: engine.backend,
    };
  });
  const clip = { x: 95, y: 80, width: 530, height: 250 };
  await frames(page, 10);
  const on = PNG.sync.read(await page.screenshot({ clip })).data;
  await page.evaluate(() => {
    const { world, spec } = (window as any).reach;
    world.engine.scene.getObjectByName(spec.bloomId).visible = false;
  });
  await frames(page, 18);
  const off = PNG.sync.read(await page.screenshot({ clip })).data;
  let pixels = 0;
  for (let i = 0; i < on.length; i += 4) {
    if (
      Math.max(Math.abs(on[i] - off[i]), Math.abs(on[i + 1] - off[i + 1]), Math.abs(on[i + 2] - off[i + 2])) >
      19
    )
      pixels++;
  }
  expect(pixels).toBeGreaterThan(45);
  return sample;
}

for (const backend of ['webgpu', 'webgl2']) {
  test(
    backend + ' revises visible Brindle Reach flowers and carries clay across the saved road',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.setViewportSize({ width: 720, height: 420 });
      await page.goto('/examples/brindle-reach/?view=flowers&tier=medium&backend=' + backend);
      await page.waitForFunction(() => (window as any).reach?.world.engine.stats.frames >= 8);
      const original = await photographFlower(page);
      expect(original.backend).toBe(backend);
      expect(original.count).toBeGreaterThan(24);
      expect(original.landmark?.id).toBeTruthy();
      await page.getByRole('button', { name: 'Change flowers' }).click();
      await page.waitForFunction(() => (window as any).reach?.spec.bloomId.includes('scalloped'));
      const revised = await photographFlower(page);
      expect(revised.id).not.toBe(original.id);
      expect(revised.triangles).toBeGreaterThan(original.triangles);
      expect(revised.placement).toEqual(original.placement);
      expect(revised.landmark).toEqual(original.landmark);
      expect(revised.road).toEqual(original.road);
      await page.getByRole('button', { name: 'Roll cart' }).click();
      await page.evaluate(() => {
        (window as any).reach.world.engine.paused = false;
      });
      await page.waitForFunction(() => (window as any).reach.cart.x >= -11.18);
      const [loaded, clean] = await page.evaluate(() => {
        const r = (window as any).reach;
        return [r.read(-15.7, 0.77)[1], r.read(-15.7, -0.77)[1]];
      });
      expect(loaded).toBeGreaterThan(0.18);
      expect(clean).toBeLessThan(0.01);
      expect(log.errors).toEqual([]);
    },
  );
}
