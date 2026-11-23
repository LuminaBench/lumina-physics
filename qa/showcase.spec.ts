/**
 * lumina-physics visual + stability QA.
 *
 * For every showcase scene on both backends (WebGPU and the WebGL 2 fallback):
 *   - the scene must start and keep rendering with ZERO console / shader / page errors,
 *   - scene-specific physics invariants must hold (things float, fly, drive, detonate),
 *   - a capture is written to qa/output/captures and screened for "non-plastic realism":
 *     real contrast, fine detail, a rich palette and no blown-out / blank frames.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, analyse, openScene, watchConsole, type Backend } from './helpers';

test.use({ viewport: { width: 1920, height: 1080 } });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES = path.join(HERE, 'output', 'captures');
fs.mkdirSync(CAPTURES, { recursive: true });

/** Drive each scene to its "money shot" and return scene-specific invariants. */
const SCENARIOS: Record<string, { settle: number; act?: string; check: string }> = {
  lagoon: {
    settle: 7000,
    act: `lumina.scene.beaver.throttle = 0.9`,
    check: `(() => { const s = lumina.scene; return { afloat: s.beaver.buoyancy.state.submersion, y: s.beaver.position.y, speed: s.beaver.speed, hs: s.ocean.significantHeight }; })()`,
  },
  jet: {
    settle: 5200,
    act: `lumina.scene.jet.flight.resetToRunIn(1900)`,
    check: `(() => { const a = lumina.scene.jet.aero; return { mach: a.mach, booms: a.booms, altitude: a.altitude }; })()`,
  },
  highway: {
    settle: 9000,
    act: `lumina.scene.setMode('side')`,
    check: `(() => { const v = lumina.scene.vehicle; const t = v.chassis.translation(); return { speed: v.speed, y: t.y, x: t.x, contacts: v.wheels.filter((w) => w.contact).length, maxDepth: Math.max(...v.wheels.map((w) => w.depth)) }; })()`,
  },
  fire: {
    settle: 2600,
    act: `lumina.scene.detonate('petrol'); setTimeout(() => lumina.scene.detonate('electrical'), 500); setTimeout(() => lumina.scene.detonate('water'), 900); setTimeout(() => lumina.scene.detonate('c4'), 1900)`,
    check: `(() => ({ blasts: lumina.scene.explosions.count, events: window.eventCount }))()`,
  },
  chaos: {
    settle: 8000,
    act: `lumina.scene.lightning.strike()`,
    check: `(() => { const s = lumina.scene; return { afloat: s.beaver.buoyancy.state.submersion, hs: s.ocean.significantHeight, y: s.beaver.position.y, events: window.eventCount }; })()`,
  },
  playground: {
    settle: 9000,
    act: `lumina.scene.ignite(); lumina.scene.airDrop(); setTimeout(() => lumina.scene.blastAt('c4', 2.5, -6.2), 1200)`,
    check: `(() => { const s = lumina.scene; return { breaks: s.destruction.breaks, burning: s.thermo.stats.burningCells, charred: s.thermo.stats.charredCells, stamps: s.ground.stamps, speed: Math.abs(s.car.speed), particles: s.cloth.particleCount, dropY: s.supply.position.y }; })()`,
  },
  river: {
    settle: 2100,
    act: 'lumina.scene.skip(); lumina.scene.passThrough()',
    check: 'lumina.scene.tracers.stats',
  },
  landfall: {
    settle: 17500,
    check: `(() => { const s = lumina.scene; return { wave: s.ocean.tsunami.profile.height * s.ocean.tsunami.amplitude, y: s.beaver.position.y }; })()`,
  },
};

/** Read the actual rendered breaker cross-section back beside its CPU buoyancy probe. */
async function checkBreakerParity(page: Page): Promise<void> {
  const samples = await page.evaluate(async () => {
    const { THREE: T, lumina } = window as any, { renderer } = lumina.engine;
    const wave = lumina.scene.ocean.tsunami, N = T.TSL;
    const point = N.uniform(new T.Vector2()), depth = N.uniform(0);
    const material = new T.NodeMaterial();
    const correction = wave.restOffsetNode(point, depth);
    const dir = wave.uniforms.direction;
    const vertex = wave.deform(point.add(dir.mul(correction)), depth).offset;
    material.fragmentNode = N.vec4(vertex.y, correction, correction.add(N.dot(vertex.xz, dir)), 1);
    const target = new T.RenderTarget(1, 1, {type: T.FloatType, depthBuffer: false});
    const quad = new T.QuadMesh(material), previous = renderer.getRenderTarget();
    const samples: {y:number; shift:number; gpuY:number; gpuShift:number; residual:number}[] = [];
    try {
      for (const [cross, bed, offset] of [[-43,4,-0.8], [3,17,0.34], [79,100,1.6]]) {
        const lip = wave.crestPoint(cross, new T.Vector3(), bed);
        const x = lip.x + dir.value.x * offset, z = lip.z + dir.value.y * offset;
        point.value.set(x,z); depth.value = bed;
        const y = wave.heightAt(x,z,bed), shift = wave.restOffset(x,z,bed);
        renderer.setRenderTarget(target);
        quad.render(renderer);
        renderer.setRenderTarget(previous);
        const pixel = await renderer.readRenderTargetPixelsAsync(target,0,0,1,1);
        samples.push({ y, shift, gpuY: pixel[0], gpuShift: pixel[1], residual: pixel[2] });
      }
      return samples;
    } finally {
      renderer.setRenderTarget(previous); target.dispose(); material.dispose();
    }
  });
  for (const s of samples) {
    expect(Math.abs(s.gpuY - s.y), 'rendered height against the hull probe, metres').toBeLessThan(0.075);
    expect(Math.abs(s.gpuShift - s.shift), 'visible branch displacement, metres').toBeLessThan(0.075);
    expect(Math.abs(s.residual), 'horizontal reprojection error, metres').toBeLessThan(0.10);
  }
}

async function runScene(page: Page, scene: string, backend: Backend): Promise<void> {
  const log = watchConsole(page);
  await openScene(page, scene, backend === 'webgl2' ? 'medium' : 'high', backend);
  const scenario = SCENARIOS[scene];
  await page.evaluate(() => {
    const w = window as any;
    w.eventCount = 0;
    for (const name of ['explosion', 'lightning']) w.lumina.engine.events.on(name, () => w.eventCount++);
  });
  if (scenario.act) await page.evaluate(scenario.act);
  await page.waitForTimeout(scenario.settle);

  const state = await page.evaluate(scenario.check) as Record<string, number>;
  const frames = await page.evaluate(() => ({ ms: (window as any).lumina.engine.quality.profiler.ema, errors: (window as any).lumina.errors }));
  const shot = await page.screenshot({ path: path.join(CAPTURES, `${backend}-${scene}.png`) });
  const stats = analyse(shot);
  test.info().annotations.push({ type: 'state', description: JSON.stringify(state) }, { type: 'image', description: JSON.stringify(stats) });
  console.log(`  ${backend}/${scene}: ${frames.ms.toFixed(1)} ms  state=${JSON.stringify(state, (_, v) => (typeof v === 'number' ? +v.toFixed(2) : v))}  image=${JSON.stringify(stats, (_, v) => (typeof v === 'number' ? +v.toFixed(3) : v))}`);

  // --- zero shader / console errors ---
  expect(log.errors, 'console errors').toEqual([]);
  expect(frames.errors, 'window errors').toEqual([]);
  expect(Number.isFinite(frames.ms) && frames.ms > 0, 'engine is producing frames').toBe(true);

  // --- physics invariants ---
  for (const [key, value] of Object.entries(state)) expect(Number.isFinite(value), `${key} is finite`).toBe(true);
  if (scene === 'lagoon') { expect(state.afloat).toBeGreaterThan(0.08); expect(state.afloat).toBeLessThan(0.95); expect(Math.abs(state.y)).toBeLessThan(2.5); expect(state.speed).toBeGreaterThan(3); }
  if (scene === 'jet') { expect(state.booms).toBeGreaterThanOrEqual(1); expect(state.mach).toBeGreaterThan(0.9); }
  if (scene === 'highway') { expect(state.contacts).toBe(4); expect(state.speed).toBeGreaterThan(12); expect(state.y).toBeGreaterThan(0.2); expect(state.y).toBeLessThan(0.7); expect(Math.abs(state.x)).toBeLessThan(7.5); expect(state.maxDepth).toBeGreaterThan(0.002); }
  if (scene === 'fire') { expect(state.blasts).toBe(4); expect(state.events).toBeGreaterThanOrEqual(4); }
  if (scene === 'chaos') { expect(state.hs).toBeGreaterThan(3); expect(state.afloat).toBeGreaterThan(0.02); expect(state.events).toBeGreaterThan(0); }
  if (scene === 'river') {
    expect(state.launched).toBe(2);
    expect(state.skipped).toBeGreaterThan(0);
    expect(state.exited).toBeGreaterThan(0);
  }
  if (scene === 'landfall') {
    await checkBreakerParity(page);
    expect(state.wave).toBeGreaterThan(10);
    expect(stats.clipped, 'sun glints leave the aircraft and breaking wave visible').toBeLessThan(0.06);
  }
  if (scene === 'playground') {
    expect(state.breaks, 'the blast broke chunks off the targets').toBeGreaterThan(10);
    expect(state.burning + state.charred, 'the boardwalk is burning').toBeGreaterThan(8);
    expect(state.stamps, 'the car is leaving ruts').toBeGreaterThan(60);
    expect(state.speed, 'the car is driving').toBeGreaterThan(3);
    expect(state.particles, 'cloth is simulated').toBeGreaterThan(800);
    expect(state.dropY, 'the air drop is descending or has landed').toBeLessThan(46);
  }

  // --- non-plastic realism screen ---
  expect(stats.mean, 'not a black frame').toBeGreaterThan(0.06);
  expect(stats.mean, 'not a white frame').toBeLessThan(0.92);
  expect(stats.contrast, 'tonal range').toBeGreaterThan(0.06);
  expect(stats.detail, 'fine surface detail (not smooth plastic)').toBeGreaterThan(0.006);
  expect(stats.palette, 'rich palette').toBeGreaterThan(260);
  expect(stats.clipped, 'no large blown-out / crushed areas').toBeLessThan(0.3);
}

for (const backend of ['webgpu', 'webgl2'] as Backend[]) {
  test.describe(`${backend} showcase`, () => {
    for (const scene of SCENES) {
      test(`${scene}: renders clean with live physics`, async ({ page }) => {
        await runScene(page, scene, backend);
      });
    }
  });
}

test('scene switching and live tier switching stay error-free', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'lagoon', 'medium', 'webgpu');
  for (const tier of ['low', 'ultra', 'high']) {
    await page.evaluate((t) => (window as any).lumina.setTier(t), tier);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).lumina.engine.quality.tier)).toBe(tier);
  }
  for (const scene of ['fire', 'highway', 'playground', 'jet']) {
    await page.evaluate((s) => (window as any).lumina.setScene(s), scene);
    await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => (window as any).lumina.sceneId)).toBe(scene);
  }
  // Switching the graphics tier must preserve live solver buffers (including tears,
  // pressure, strand bends and accumulated body motion).
  for (const [scene, names] of [['river', ['soft', 'strands']], ['playground', ['cloth']]] as const) {
    await page.evaluate((id) => (window as any).lumina.setScene(id), scene);
    await page.waitForFunction('window.__luminaReady === true');
    const survived = await page.evaluate(async (keys) => {
      const app = (window as any).lumina;
      const before = keys.map(k => app.scene[k].backend);
      app.setTier(app.engine.quality.tier === 'medium' ? 'high' : 'medium');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return keys.every((k, i) => before[i] && app.scene[k].backend === before[i]);
    }, [...names]);
    expect(survived, scene + ' keeps active solver buffers across a quality change').toBe(true);
  }
  expect(log.errors).toEqual([]);
});
