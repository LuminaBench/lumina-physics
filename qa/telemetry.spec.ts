/**
 * Performance telemetry bar + dynamic resolution checks.
 *
 * For every tier (Storm Chaos, 1920×1080, vsync on) this logs where the 16.7 ms frame goes:
 * JavaScript (simulation + render submission), draw calls, triangles on screen, the GPU
 * time estimate and the GPU headroom it implies. Vsync hides spare capacity from frame
 * pacing, so the headroom figure is what shows how far a tier is from dropping frames.
 * The table is written to qa/output/telemetry.json.
 *
 * `gpuMs` is measured as the delay between submitting a frame and the GPU reporting it
 * done (`queue.onSubmittedWorkDone`). It includes a few milliseconds of process latency,
 * so the headroom it implies is a conservative estimate, not a profiler-grade number.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { TIERS, watchConsole } from './helpers';

const SCALE = Number(process.env.LUMINA_QA_BUDGET_SCALE ?? 1);
const BUDGET_MS = 1000 / 60;
function record(sample: object): void {
  test.info().annotations.push({ type: 'telemetry-sample', description: JSON.stringify(sample) });
}

interface Telemetry { fps: number; dropped: number; jsMs: number; simMs: number; submitMs: number; gpuMs: number; gpuPeak: number; headroom: number; drawCalls: number; triangles: number; renderScale: number; drsChanges: number }

async function open(browser: Browser, query: string, width = 1920, height = 1080): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const log = watchConsole(page);
  await page.goto(`/?${query}&ui=0`);
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
  return { page, close: () => context.close(), errors: log.errors };
}

async function sample(page: Page, frames = 300): Promise<Telemetry> {
  return page.evaluate(async (count) => {
    const engine = (window as any).lumina.engine;
    const times: number[] = [], sim: number[] = [], submit: number[] = [], gpu: number[] = [];
    let last = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        times.push(now - last); last = now;
        sim.push(engine.stats.simMs); submit.push(engine.stats.submitMs); gpu.push(engine.stats.gpuMs);
        if (times.length < count) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const gpuMs = mean(gpu);
    return {
      fps: 1000 / mean(times), dropped: times.filter((t) => t > 25).length / times.length,
      jsMs: mean(sim) + mean(submit), simMs: mean(sim), submitMs: mean(submit),
      gpuMs, gpuPeak: Math.max(...gpu), headroom: gpuMs > 0 ? 1 - gpuMs / (1000 / 60) : 0,
      drawCalls: engine.stats.drawCalls, triangles: engine.stats.triangles,
      renderScale: engine.stats.renderScale, drsChanges: engine.drs.changes,
    };
  }, frames);
}

/** One line of the telemetry bar: 30 cells = one 16.7 ms frame. */
function bar(t: Telemetry): string {
  const cells = 30;
  const js = Math.max(1, Math.round((t.jsMs / BUDGET_MS) * cells));
  const gpu = Math.max(0, Math.min(cells - js, Math.round((t.gpuMs / BUDGET_MS) * cells) - js));
  return `${'▓'.repeat(js)}${'█'.repeat(gpu)}${'░'.repeat(Math.max(0, cells - js - gpu))}`;
}

test.describe('telemetry bar: Storm Chaos at 1920×1080', () => {
  for (const tier of TIERS) {
    test(`${tier}: JS time, draw calls, triangles and GPU headroom`, async ({ browser }) => {
      const { page, close, errors } = await open(browser, `scene=chaos&tier=${tier}`);
      await page.waitForTimeout(2500);
      const t = await sample(page);
      record({ scene: 'chaos', tier, viewport: '1920x1080', ...t });
      console.log(`  ${tier.padEnd(6)} ${bar(t)}  js ${t.jsMs.toFixed(1)} ms (sim ${t.simMs.toFixed(1)})  gpu ${t.gpuMs.toFixed(1)} ms  headroom ${(t.headroom * 100).toFixed(0)} %  ${t.drawCalls} draws  ${(t.triangles / 1000).toFixed(0)}k tris  @${t.renderScale}×  ${t.fps.toFixed(1)} fps`);
      expect(errors).toEqual([]);
      expect(t.simMs, 'simulation JavaScript per frame').toBeLessThan(3 * SCALE);
      expect(t.jsMs, 'total JavaScript per frame').toBeLessThan(6 * SCALE);
      expect(t.drawCalls, 'draw calls stay batched').toBeLessThan(220);
      expect(t.gpuMs, 'GPU time estimate is available on WebGPU').toBeGreaterThan(0);
      expect(t.headroom, 'GPU headroom at 1080p').toBeGreaterThan(0.12 / SCALE);
      expect(t.dropped, 'frames that missed vsync').toBeLessThanOrEqual(0.02 * SCALE);
      await close();
    });
  }
});

test('Ultra simultaneous storm, fire and geyser at 1080p', async ({ browser }) => {
  const { page, close, errors } = await open(browser, 'scene=chaos&tier=ultra&drs=0');
  try {
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const scene = (window as any).lumina.scene;
      const center = scene.beaver.position.clone();
      scene.lightning.strike();
      scene.explosions.detonate({ kind: 'water', position: center.clone().add({ x: 7, y: 0, z: -7 }) });
      scene.explosions.detonate({ kind: 'petrol', position: center.clone().add({ x: -5, y: 2, z: 7 }) });
    });
    const t = await sample(page, 200);
    record({ scene: 'chaos', effects: 'storm+geyser+fire', tier: 'ultra', ...t });
    console.log('Concurrent effects at 1080p', t);
    expect(errors).toEqual([]);
    expect(t.gpuMs).toBeGreaterThan(0);
    expect(t.gpuMs).toBeLessThanOrEqual(10);
    expect(t.headroom).toBeGreaterThanOrEqual(0.4);
    expect(t.dropped).toBeLessThanOrEqual(0.01);
  } finally { await close(); }
});

test.describe('dynamic resolution scaling', () => {
  test('off by default on a fixed tier, on with tier=auto, switchable at run time', async ({ browser }) => {
    const fixed = await open(browser, 'scene=lagoon&tier=high', 1280, 720);
    expect(await fixed.page.evaluate(() => (window as any).lumina.engine.drs.enabled)).toBe(false);
    const toggled = await fixed.page.evaluate(async () => {
      const engine = (window as any).lumina.engine;
      engine.setDynamicResolution(true);
      await new Promise((r) => setTimeout(r, 600));
      return { enabled: engine.drs.enabled, dynamic: engine.pipeline.dynamic };
    });
    expect(toggled).toEqual({ enabled: true, dynamic: true });
    expect(fixed.errors).toEqual([]);
    await fixed.close();
    const auto = await open(browser, 'scene=lagoon&tier=auto', 1280, 720);
    expect(await auto.page.evaluate(() => (window as any).lumina.engine.drs.enabled)).toBe(true);
    await auto.close();
  });

  test('ultrawide Ultra: the scale drops below the static budget and 60 fps holds', async ({ browser }) => {
    const { page, close, errors } = await open(browser, 'scene=chaos&tier=ultra&drs=1', 3440, 1440);
    await page.waitForTimeout(5000);
    const t = await sample(page, 360);
    record({ scene: 'chaos', tier: 'ultra+drs', viewport: '3440x1440', ...t });
    console.log(`  ultra+drs 3440×1440 → ${t.fps.toFixed(1)} fps  gpu ${t.gpuMs.toFixed(1)} ms  scale ${t.renderScale}  changes ${t.drsChanges}  dropped ${(t.dropped * 100).toFixed(1)} %`);
    expect(errors).toEqual([]);
    expect(t.renderScale).toBeGreaterThanOrEqual(0.55);
    expect(t.renderScale).toBeLessThanOrEqual(1);
    expect(t.fps, 'frame rate with DRS').toBeGreaterThan(58 / SCALE);
    expect(t.dropped).toBeLessThanOrEqual(0.03 * SCALE);
    await close();
  });

  test('the scale recovers when the GPU has headroom, without a pipeline rebuild or errors', async ({ browser }) => {
    const { page, close, errors } = await open(browser, 'scene=lagoon&tier=high&drs=1');
    await page.waitForTimeout(2000);
    const result = await page.evaluate(async () => {
      const engine = (window as any).lumina.engine;
      engine.pipeline.setRenderScale(0.55);
      engine.drs.scale = 0.55;
      const start = engine.stats.renderScale;
      const size = () => { const t = engine.pipeline.sceneDepth.value.image; return t.width; };
      const widthLow = await new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(size()))));
      await new Promise((r) => setTimeout(r, 9000));
      return { start, widthLow, end: engine.stats.renderScale, widthEnd: size(), changes: engine.drs.changes, fps: engine.quality.profiler.fps };
    });
    console.log(`  drs recovery: ${result.start} → ${result.end} (${result.changes} steps), scene target ${result.widthLow}px → ${result.widthEnd}px, ${result.fps.toFixed(1)} fps`);
    expect(errors).toEqual([]);
    expect(result.widthLow, 'scene target follows the scale').toBeLessThan(1920 * 0.6);
    expect(result.end, 'scale climbs back while the GPU has headroom').toBeGreaterThan(0.7);
    expect(result.widthEnd).toBeGreaterThan(result.widthLow);
    expect(result.fps).toBeGreaterThan(57 / SCALE);
    await close();
  });
});
