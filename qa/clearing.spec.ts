import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';
import { mkdirSync, writeFileSync } from 'node:fs';

for (const backend of ['webgpu', 'webgl2'])
  test(backend + ' clearing squall from shade to open water at 1080p', async ({ page }) => {
    const log = watchConsole(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/profiles.html?view=clearing&ui=0&tier=high' + (backend === 'webgl2' ? '&webgl=1' : ''));
    await page.waitForFunction(() => !!(window as any).profileGallery);
    const s = await page.evaluate(async () => {
      const g = (window as any).profileGallery,
        { engine, weather } = g.world,
        road = g.clearing.road;
      const times: number[] = [],
        states: number[][] = [];
      let last = 0,
        maxExposureJump = 0,
        prevExposure = engine.pipeline.exposure;
      await new Promise<void>((resolve) => {
        const frame = (now: number) => {
          if (last && g.pathTime > 1.2) times.push(now - last);
          last = now;
          const exposure = engine.pipeline.exposure;
          maxExposureJump = Math.max(maxExposureJump, Math.abs(exposure - prevExposure));
          prevExposure = exposure;
          if (!states.length || g.pathTime - states[states.length - 1][0] > 0.45)
            states.push([
              g.pathTime,
              road.params.wetness,
              road.params.flood,
              weather.params.rain,
              exposure,
              road.puddleDepth(-2.4, -19),
            ]);
          if (g.pathTime < 12.8) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      times.sort((a, b) => a - b);
      return {
        states,
        maxExposureJump,
        backend: engine.backend,
        readyMs: g.readyMs,
        p95: times[Math.floor(times.length * 0.95)],
        fps: (1000 * times.length) / times.reduce((a, b) => a + b, 0),
        scale: engine.stats.renderScale,
      };
    });
    console.log(backend, 'clearing', JSON.stringify({ ...s, states: [s.states[0], s.states.at(-1)] }));
    mkdirSync('qa/output/profiles', { recursive: true });
    writeFileSync('qa/output/profiles/clearing-' + backend + '.json', JSON.stringify(s));
    expect(s.backend).toBe(backend);
    expect(log.errors).toEqual([]);
    expect(s.maxExposureJump).toBeLessThan(0.075);
    expect(s.states.at(-1)![1]).toBeLessThan(s.states[0][1] * 0.7);
    expect(s.states.at(-1)![2]).toBeGreaterThan(s.states.at(-1)![1]);
    expect(s.states.at(-1)![3]).toBe(0);
    expect(s.fps).toBeGreaterThanOrEqual(58);
    expect(s.p95).toBeLessThanOrEqual(18);
  });
