import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

test('profile edits retain locked materials, wave phase, buoyancy and wind', async ({ page }) => {
  const log = watchConsole(page);
  const run = async (edits: boolean) => {
    await page.goto('/qa/profile-host.html');
    await page.waitForFunction(() => !!(window as any).profileChecks);
    return page.evaluate((flag) => (window as any).profileChecks.drift(flag), edits);
  };
  const control = await run(false),
    edit = await run(true);
  expect(edit.after.waterTint).toBe(control.before.waterTint);
  expect(edit.after.seaState).toBe('swell');
  expect(edit.after.grassDensity).toBe(0.19);
  expect(edit.after.foliageTint).not.toBe(control.before.foliageTint);
  expect(edit.after.foamBands).toBeGreaterThan(control.before.foamBands);
  expect(edit.foam).not.toBe(control.foam);
  expect(edit.trajectory).toEqual(control.trajectory);
  expect(Math.abs(control.trajectory[0][0] - control.trajectory.at(-1)[0])).toBeGreaterThan(0.01);
  expect(log.errors).toEqual([]);
});

test('attach rain to a host-owned track and restore its saved configuration', async ({ page }) => {
  const log = watchConsole(page);
  await page.goto('/qa/profile-host.html');
  await page.waitForFunction(() => !!(window as any).profileChecks);
  const result = await page.evaluate(() => (window as any).profileChecks.track());
  expect(result).toMatchObject({ detached: true, replay: true, emitted: true, camera: true, controls: 2 });
  expect(result.count).toBeGreaterThan(0);
  expect(log.errors).toEqual([]);
});
