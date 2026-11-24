/**
 * Frame-pacing benchmark at full desktop resolution.
 *
 * Measure 300 vsynced frames per scene, backend and tier at 1920×1080.
 * GPU time is the engine's queue-completion estimate, available on WebGPU.
 * Full measurements are written to qa/output/performance.json.
 *
 * Slower CI GPUs: set LUMINA_QA_BUDGET_SCALE (e.g. 1.5) to loosen every budget.
 */
import { test, expect, type Browser } from '@playwright/test';
import { SCENES, TIERS, watchConsole, type Backend } from './helpers';

const SCALE = Number(process.env.LUMINA_QA_BUDGET_SCALE ?? 1);
/** Mean frame time ceiling (ms): 17.0 ≈ 58.8 fps, i.e. vsync-locked 60 with timer noise. */
const MEAN_BUDGET: Record<string, number> = { low: 17.0, medium: 17.0, high: 17.0, xhigh: 17.0, ultra: 17.0 };
/** Share of frames allowed to miss a 60 Hz vsync. */
const DROP_BUDGET: Record<string, number> = { low: 0.01, medium: 0.01, high: 0.01, xhigh: 0.01, ultra: 0.01 };
const SIM_BUDGET_MS = 3;
interface Sample { readyMs: number; mean: number; p95: number; fps: number; dropped: number; simMs: number; submitMs: number; gpuMs: number; buffer: string; renderScale: number; drawCalls: number }

async function benchmark(browser: Browser, scene: string, tier: string, width: number, height: number, dpr = 1, backend: Backend = 'webgpu', action?: CoupledScenario): Promise<Sample> {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const log = watchConsole(page);
  await page.goto(`/?scene=${scene}&tier=${tier}&ui=${action ? 1 : 0}${backend === 'webgl2' ? '&webgl=1' : ''}`);
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
  const readyMs = await page.evaluate(() => performance.now());
  expect(await page.evaluate(() => (window as any).lumina.sceneId)).toBe(scene);
  expect(await page.evaluate(() => (window as any).lumina.engine.backend)).toBe(backend);
  if(action){
    for(const name of action.buttons)await page.getByRole('button',{name,exact:true}).click();
    await page.waitForFunction(action.active);
    await page.locator('#ui').evaluate(element=>{(element as HTMLElement).style.visibility='hidden';});
  }
  await page.waitForTimeout(2500); // pipelines compiled, temporal history warm
  const sample = await page.evaluate(async (readyMs) => {
    const engine = (window as any).lumina.engine;
    const times: number[] = [], sim: number[] = [], submit: number[] = [], gpu: number[] = [];
    const frameStart = engine.stats.frames;
    let last = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        times.push(now - last); last = now; sim.push(engine.stats.simMs); submit.push(engine.stats.submitMs); gpu.push(engine.stats.gpuMs);
        if (times.length < 300) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const sorted = [...times].sort((a, b) => a - b);
    const size = engine.renderer.getDrawingBufferSize(new (window as any).THREE.Vector2());
    return {
      readyMs, engineFrames: engine.stats.frames - frameStart, mean: mean(times), p95: sorted[Math.floor(sorted.length * 0.95)], fps: 1000 / mean(times),
      dropped: times.filter((t) => t > 25).length / times.length,
      simMs: mean(sim), submitMs: mean(submit), gpuMs: mean(gpu), buffer: `${size.x}x${size.y}`, renderScale: engine.pipeline.renderScale, drawCalls: engine.stats.drawCalls,
    };
  }, readyMs);
  expect(sample.engineFrames, 'simulation and rendering kept ticking').toBeGreaterThanOrEqual(295);
  expect(log.errors, 'console errors during benchmark').toEqual([]);
  await context.close();
  test.info().annotations.push({ type: 'performance-sample',
    description: JSON.stringify({ scene, scenario:action?.label, tier, backend, viewport: `${width}x${height}@${dpr}x`, ...sample }) });
  const gpuLabel = backend === 'webgpu' ? `${sample.gpuMs.toFixed(1)} ms (${Math.round((1 - sample.gpuMs / 16.67) * 100)} % free)` : 'n/a';
  console.log(`  ${backend} ${scene}@${tier} ${width}x${height}@${dpr}x → ${sample.fps.toFixed(1)} fps  mean ${sample.mean.toFixed(1)} ms  p95 ${sample.p95.toFixed(1)}  dropped ${(sample.dropped * 100).toFixed(1)} %  sim ${sample.simMs.toFixed(2)} ms  submit ${sample.submitMs.toFixed(2)} ms  gpu ${gpuLabel}  buffer ${sample.buffer} × ${sample.renderScale}`);
  return sample;
}

function expectBudget(sample: Sample, tier: string): void {
  expect(sample.mean, `${tier}: mean frame time`).toBeLessThan(MEAN_BUDGET[tier] * SCALE);
  expect(sample.dropped, `${tier}: share of frames that missed vsync`).toBeLessThanOrEqual(DROP_BUDGET[tier] * SCALE);
  expect(sample.simMs, `${tier}: simulation JavaScript per frame`).toBeLessThan(SIM_BUDGET_MS * SCALE);
}

test.describe('1920×1080 scene and tier matrix', () => {
  for (const backend of ['webgpu', 'webgl2'] as const) for (const scene of SCENES) for (const tier of TIERS) {
    test(`${backend} ${scene} @ ${tier}`, async ({ browser }) => {
      const sample = await benchmark(browser, scene, tier, 1920, 1080, 1, backend);
      expectBudget(sample, tier);
      if (backend === 'webgl2' && scene === 'playground') expect(sample.simMs).toBeLessThanOrEqual(2.5 * SCALE);
      if (backend === 'webgpu' && tier === 'ultra') {
        expect(sample.gpuMs).toBeGreaterThan(0);
        expect(sample.gpuMs).toBeLessThanOrEqual(10 * SCALE);
      }
    });
  }
});

interface CoupledScenario {
  label:string;
  scene:string;
  buttons:readonly string[];
  active:string;
}

const coupledScenarios:CoupledScenario[]=[
  {label:'last light flight',scene:'jet',buttons:['Last light at altitude'],active:'lumina.scene.jet.aero.altitude > 8000 && lumina.scene.jet.aero.contrails[0].emissionStrength > 0.6'},
  {label:'muddy tire transfer',scene:'highway',buttons:['Cross muddy shoulder'],active:'lumina.scene.spray.prints.some((wheel) => wheel.soil > 0.5)'},
  {label:'sheltered puddle',scene:'highway',buttons:['Rain under the overpass'],active:'lumina.scene.vehicle.root.position.z > 250 && lumina.scene.road.puddleDepth(-2.75,255) > 0.01'},
  {label:'paint scrape',scene:'highway',buttons:['Sideswipe'],active:'lumina.scene.damage.paintWear.count > 0'},
  {label:'marked concrete',scene:'playground',buttons:['Chip wall','Chip wall','Chip wall'],active:'lumina.scene.targets[0].surfaceMarkCount === 3'},
  {label:'hover',scene:'lagoon',buttons:['Hover over water'],active:'lumina.scene.rescue.rotor.stats.emitted > 80'},
  {label:'cloud tunnel',scene:'jet',buttons:['Fly through cloud'],active:'lumina.scene.jet.aero.cloudTrail.segments >= 3'},
  {label:'wading',scene:'highway',buttons:['Flood the street','Leak fuel'],active:'lumina.scene.fluid.stats.hoodSpray > 4'},
  {label:'waterspout and swimmer',scene:'river',buttons:['Launch waterspout','Float rescue worker'],active:'lumina.scene.worker.stats.immersion > 0.4'},
];

test.describe('active world coupling at 1920×1080',()=>{
  for(const backend of ['webgpu','webgl2'] as const)for(const scenario of coupledScenarios)for(const tier of TIERS){
    test(`${backend} ${scenario.label} @ ${tier}`,async({browser})=>{
      const sample=await benchmark(browser,scenario.scene,tier,1920,1080,1,backend,scenario);
      expectBudget(sample,tier);
      if(backend==='webgpu'&&tier==='ultra'){
        expect(sample.gpuMs).toBeGreaterThan(0);expect(sample.gpuMs).toBeLessThanOrEqual(10*SCALE);
      }
    });
  }
});

test.describe('large and high-DPI canvases (pixel budget + temporal upscaling)', () => {
  test('1886×1289 desktop window: High and Ultra locked', async ({ browser }) => {
    expectBudget(await benchmark(browser, 'lagoon', 'high', 1886, 1289), 'high');
    expectBudget(await benchmark(browser, 'lagoon', 'ultra', 1886, 1289), 'ultra');
  });
  test('3440×1440 ultrawide: High locked', async ({ browser }) => {
    const sample = await benchmark(browser, 'lagoon', 'high', 3440, 1440);
    expectBudget(sample, 'high');
    expect(sample.renderScale, 'internal resolution is reduced on a 5 MP canvas').toBeLessThan(1);
  });
  test('Retina-class canvas (1886×1289 @2x): High locked', async ({ browser }) => {
    expectBudget(await benchmark(browser, 'lagoon', 'high', 1886, 1289, 2), 'high');
  });
});

test('tier=auto calibrates to a tier that holds 58+ fps at the real window size', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const log = watchConsole(page);
  await page.goto('/?scene=lagoon&tier=auto&ui=0');
  await page.waitForFunction('window.__luminaReady === true && window.lumina && window.lumina.sceneId === "lagoon"', null, { timeout: 90_000 });
  await page.waitForTimeout(6000); // calibration probes happen behind the loading overlay
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).lumina.engine.backend)).toBe('webgpu');
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({ tier: (window as any).lumina.engine.quality.tier, ema: (window as any).lumina.engine.quality.profiler.ema }));
  console.log(`  auto → ${state.tier} (${state.ema.toFixed(1)} ms)`);
  test.info().annotations.push({ type: 'performance-sample', description: JSON.stringify({ scene: 'lagoon', tier: `auto→${state.tier}`, viewport: '1920x1080@1x', mean: state.ema }) });
  expect(state.ema, 'the calibrated tier holds 58 fps').toBeLessThan(17.3 * SCALE);
  expect(log.errors).toEqual([]);
  await context.close();
});
