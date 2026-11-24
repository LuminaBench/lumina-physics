import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { watchConsole } from './helpers';

const out = process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coastal-interactions';
for (const backend of ['webgpu', 'webgl2'])
  for (const shore of ['atlantic', 'volcanic', 'cay', 'boulevard']) {
    test([backend, shore, 'coastal controls and stable authoring'].join(' '), async ({ page }) => {
      const log = watchConsole(page);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(
        '/coast.html?shore=' +
          shore +
          '&view=walk&tier=high&backend=' +
          (backend === 'webgl2' ? 'webgl' : 'webgpu'),
      );
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const initial = await page.evaluate(() => {
        const d = (window as any).coastDemo;
        return [d.world.terrain, d.world.coast.seed].map((p, i) => (i ? p : d.world.ground(1.5, 6)));
      });
      const hud = page.locator('aside');
      const select = page.getByRole('combobox', { name: 'Art direction' }),
        clock = page.getByRole('slider', { name: 'Solar hour' });
      await hud.getByText('Inspect conditions').click();
      for (const [style, hour] of [
        ['painterly', '12'],
        ['neon-night', '18.85'],
        ['natural-daylight', '21.5'],
      ]) {
        await select.selectOption(style);
        await clock.fill(hour);
        await clock.press('ArrowRight');
        await page.waitForFunction((id) => (window as any).coastDemo.world.look === id, style);
        expect(await page.locator('#conditions').innerText()).toContain('Sun:');
      }
      await page.getByRole('slider', { name: 'Tide range' }).fill('.35');
      await page.getByRole('button', { name: 'Drive', exact: true }).click();
      await page.waitForFunction(() => {
        const d = (window as any).coastDemo;
        return d.mode === 'drive' && d.vehicles.car.speed > 4 && d.vehicles.car.root.visible;
      });
      await page.waitForFunction(() =>
        document.querySelector('#conditions')?.textContent?.includes('Front left'),
      );
      await page.getByRole('button', { name: 'Fly', exact: true }).click();
      await page.waitForFunction(() => {
        const d = (window as any).coastDemo;
        return d.mode === 'fly' && d.world.engine.camera.position.y > 30;
      });
      await page.locator('canvas').focus();
      await page.keyboard.down('w');
      await page.waitForTimeout(450);
      await page.keyboard.up('w');
      await page.getByRole('button', { name: 'Walk', exact: true }).click();
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      if (shore === 'cay') {
        await page.getByRole('button', { name: 'Skiff', exact: true }).click();
        await page.waitForFunction(() => {
          const d = (window as any).coastDemo;
          return d.skiff?.mesh.visible && d.mode === 'skiff';
        });
        const start = await page.evaluate(() => (window as any).coastDemo.skiff.mesh.position.toArray());
        await page.waitForFunction(([x, , z]) => {
          const p = (window as any).coastDemo.skiff.mesh.position;
          return Math.hypot(p.x - x, p.z - z) > 0.15;
        }, start);
      }
      const after = await page.evaluate(() => {
        const d = (window as any).coastDemo;
        return [d.world.ground(1.5, 6), d.world.coast.seed];
      });
      expect(after).toEqual(initial);
      expect(log.errors).toEqual([]);
    });
  }
test('cay flight crosses a lower cloud bank and climbs into clear air', async ({ page }) => {
  const log = watchConsole(page);
  await page.goto('/coast.html?shore=cay&view=fly&tier=high');
  await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 2);
  const result = await page.evaluate(async () => {
    const d = (window as any).coastDemo,
      w = d.world,
      e = w.engine,
      cam = e.camera;
    const lower = w.weather.params.cloudBase,
      top = w.weather.params.cloudTop;
    let peak = 0,
      inside = 0,
      before = false,
      after = false,
      peakAt = 0,
      maxY = 0;
    const samples: any[] = [];
    await new Promise<void>((done, fail) => {
      const end = performance.now() + 100000;
      function check() {
        const y = cam.position.y,
          den = w.weather.sampleCloudDensity(cam.position);
        maxY = Math.max(maxY, y);
        if (y < lower) before = true;
        if (y >= lower && y <= top) inside++;
        if (den > peak) {
          peak = den;
          peakAt = y;
        }
        if (samples.length === 0 || y - samples[samples.length - 1].y >= 70)
          samples.push({ x: cam.position.x, y, z: cam.position.z, den });
        if (y > top + 30) {
          after = den < 0.002;
          done();
        } else if (performance.now() > end) fail(Error('Flight did not cross the lower deck'));
        else requestAnimationFrame(check);
      }
      check();
    });
    return { before, after, peak, peakAt, inside, maxY, lower, top, samples };
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'cloud-crossing.json'), JSON.stringify(result, null, 2));
  expect(result.before && result.after).toBe(true);
  expect(result.peak).toBeGreaterThan(0.04);
  expect(result.inside).toBeGreaterThan(30);
  expect(log.errors).toEqual([]);
});
