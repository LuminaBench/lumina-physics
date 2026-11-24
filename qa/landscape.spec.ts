import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2']) {
  test('botanical atlases, six looks and recovering contact on a host map / ' + backend, async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/qa/profile-host.html');
    await page.waitForFunction(() => !!(window as any).profileChecks?.landscapeEvidence);
    const s = await page.evaluate(
      (gl) => (window as any).profileChecks.landscapeEvidence(gl),
      backend === 'webgl2',
    );
    console.log(backend, JSON.stringify(s));
    expect(s.backend).toBe(backend);
    expect(s.signatures).toBe(8);
    expect(s.tints).toBe(6);
    expect(s.displaced).toBeGreaterThan(s.calm + 2);
    expect(Math.abs(s.recovered - s.calm)).toBeLessThanOrEqual(2);
    expect(s.mapRetained).toBe(true);
    expect(s.active).toBeGreaterThan(50);
    expect(s.cleared).toBe(0);
    expect(log.errors).toEqual([]);
  });
}
