import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';
for (const custom of [false, true])
  test('shared soil, wheel contact and gust on ' + (custom ? 'custom map' : 'river valley'), async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/qa/profile-host.html');
    await page.waitForFunction(() => !!(window as any).profileChecks);
    const s = await page.evaluate((map) => (window as any).profileChecks.terrainContacts(map), custom);
    console.log('terrain', custom, JSON.stringify(s));
    expect(s.reeds).toBeGreaterThan(1);
    expect(s.validReeds).toBe(s.reeds);
    expect(s.steep).toBeGreaterThan(0);
    expect(s.maxBedError).toBeLessThan(0.0001);
    expect(s.maxWaterlineError).toBeLessThan(0.04);
    expect(s.wheelErrors).toHaveLength(4);
    expect(Math.max(...s.wheelErrors)).toBeLessThan(0.025);
    for (const move of s.bends) expect(move).toBeGreaterThan(0.01);
    expect(log.errors).toEqual([]);
  });
