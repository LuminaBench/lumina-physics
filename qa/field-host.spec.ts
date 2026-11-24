import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';
for (const backend of ['webgpu', 'webgl2'])
  test('project recipes, custom host, persistence and regional return ' + backend, async ({ page }) => {
    const log = watchConsole(page);
    await page.goto('/qa/field-host.html');
    await page.waitForFunction(() => !!(window as any).fieldHost);
    const s = await page.evaluate((gl) => (window as any).fieldHost(gl), backend === 'webgl2');
    expect(log.errors).toEqual([]);
    expect(s.backend).toBe(backend);
    expect(s.excluded).toBe(0);
    expect(s.ownership).toBe(true);
    expect(s.stableBefore).toBeTruthy();
    expect(s.stableAfter).toBe(s.stableBefore);
    expect(s.retained).toBe(true);
    expect(s.cells).toBeGreaterThan(3);
    expect(s.carried).toBeGreaterThan(s.independent);
    expect(s.drained).toBeLessThan(s.source);
    expect(s.customHeight).not.toBe(s.parentHeight);
    expect(s.dependencies).toContain('plant/game:silver-birch');
    expect(s.dependencies).toContain('direction/game:ochre-gouache');
    expect(s.overridden).toContain('lean');
    expect(s.inherited).toContain('form');
    expect(s.missing).toContain('test:absent');
    expect(s.renderCalls).toBeGreaterThan(0);
    expect(s.max).toBe(9);
    expect(s.origin).toBe(0);
    expect(s.empty).toBe(true);
  });
