/**
 * Motion smoothness QA: physics-driven objects must glide, not stutter.
 *
 * Positions are sampled once per rendered frame. For steady motion the distance covered
 * per frame should be constant; "step jitter" is the mean change of that distance between
 * consecutive frames, as a percentage of the step. Running the simulation at half speed
 * emulates a display that refreshes faster than the 60 Hz physics step (e.g. 120 Hz): without
 * render interpolation bodies would move only every other frame (≈ 100 % jitter).
 */
import { test, expect, type Page } from '@playwright/test';
import { watchConsole } from './helpers';

interface Motion { step: number; jitterPct: number; maxJitterPct: number; cameraJitterMm: number; heaveJerkMm: number }

/** `target` is a JS expression (in page scope) that evaluates to an Object3D. */
async function measure(page: Page, target: string, frames = 180): Promise<Motion> {
  return page.evaluate(async ({ target, frames }) => {
    // eslint-disable-next-line no-new-func
    const object = new Function('lumina', `return ${target}`)((window as any).lumina);
    const camera = (window as any).lumina.engine.camera;
    const p: number[][] = [], rel: number[] = [];
    await new Promise<void>((resolve) => {
      const tick = () => {
        p.push([object.position.x, object.position.y, object.position.z]);
        rel.push(Math.hypot(object.position.x - camera.position.x, object.position.y - camera.position.y, object.position.z - camera.position.z));
        if (p.length < frames) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    const step: number[] = [], change: number[] = [], camera2: number[] = [], heave: number[] = [];
    for (let i = 1; i < p.length; i++) step.push(Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]));
    for (let i = 1; i < step.length; i++) change.push(Math.abs(step[i] - step[i - 1]));
    for (let i = 2; i < rel.length; i++) camera2.push(Math.abs(rel[i] - 2 * rel[i - 1] + rel[i - 2]));
    for (let i = 2; i < p.length; i++) heave.push(Math.abs(p[i][1] - 2 * p[i - 1][1] + p[i - 2][1]));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
    const s = Math.max(mean(step), 1e-6);
    change.sort((a, b) => a - b);
    return { step: s, jitterPct: (100 * mean(change)) / s, maxJitterPct: (100 * change[Math.floor(change.length * 0.98)]) / s, cameraJitterMm: 1000 * mean(camera2), heaveJerkMm: 1000 * mean(heave) };
  }, { target, frames });
}

async function open(page: Page, scene: string): Promise<void> {
  await page.goto(`/?scene=${scene}&tier=high&ui=0`);
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
}

test('Beaver glides without skipping (real time and half speed)', async ({ page }) => {
  const log = watchConsole(page);
  await open(page, 'lagoon');
  await page.evaluate(() => { (window as any).lumina.scene.beaver.throttle = 0.9; });
  await page.waitForTimeout(5000);
  for (const scale of [1, 0.5]) {
    await page.evaluate((s) => { (window as any).lumina.engine.timeScale = s; }, scale);
    await page.waitForTimeout(1200);
    const m = await measure(page, 'lumina.scene.beaver.rig.object');
    console.log(`  beaver ×${scale}: step ${(m.step * 100).toFixed(1)} cm  jitter ${m.jitterPct.toFixed(2)} % (p98 ${m.maxJitterPct.toFixed(1)} %)  camera ${m.cameraJitterMm.toFixed(2)} mm  heave ${m.heaveJerkMm.toFixed(3)} mm`);
    expect(m.step, 'the plane is moving').toBeGreaterThan(0.02);
    expect(m.jitterPct, `step jitter at time scale ${scale}`).toBeLessThan(4);
    expect(m.maxJitterPct, `worst step jitter at time scale ${scale}`).toBeLessThan(15);
    expect(m.cameraJitterMm, 'camera follows the interpolated pose').toBeLessThan(3);
    expect(m.heaveJerkMm, 'no vertical buzz on ripples').toBeLessThan(0.6);
  }
  expect(log.errors).toEqual([]);
});

test('Beaver rides a storm sea without vertical jitter', async ({ page }) => {
  await open(page, 'chaos');
  // Deliberate camera shake (storm rumble) is not jitter: switch it off for the measurement.
  await page.evaluate(() => { const t = (window as any).lumina.engine.trauma; t.maxOffset = 0; t.maxAngle = 0; });
  await page.waitForTimeout(5000);
  const m = await measure(page, 'lumina.scene.beaver.rig.object', 240);
  console.log(`  beaver (storm): heave jerk ${m.heaveJerkMm.toFixed(2)} mm  camera ${m.cameraJitterMm.toFixed(2)} mm`);
  // A 2.3 t aircraft on 10 m seas: accelerations stay smooth frame to frame.
  expect(m.heaveJerkMm).toBeLessThan(6);
  expect(m.cameraJitterMm).toBeLessThan(6);
});

test('car motion is smooth at real time and half speed', async ({ page }) => {
  await open(page, 'highway');
  await page.waitForTimeout(6000);
  for (const scale of [1, 0.5]) {
    await page.evaluate((s) => { (window as any).lumina.engine.timeScale = s; }, scale);
    await page.waitForTimeout(1000);
    const m = await measure(page, 'lumina.scene.vehicle.root', 150);
    console.log(`  car ×${scale}: step ${(m.step * 100).toFixed(1)} cm  jitter ${m.jitterPct.toFixed(2)} %  camera ${m.cameraJitterMm.toFixed(2)} mm`);
    expect(m.step).toBeGreaterThan(0.05);
    expect(m.jitterPct, `step jitter at time scale ${scale}`).toBeLessThan(4);
    expect(m.cameraJitterMm).toBeLessThan(8);
  }
});

test('jet flight path is smooth through the low pass', async ({ page }) => {
  await open(page, 'jet');
  await page.evaluate(() => (window as any).lumina.scene.jet.flight.resetToRunIn(1900));
  await page.waitForTimeout(1500);
  const m = await measure(page, 'lumina.scene.jet.rig.object', 200);
  console.log(`  jet: step ${m.step.toFixed(2)} m  jitter ${m.jitterPct.toFixed(2)} %`);
  expect(m.step).toBeGreaterThan(2);
  expect(m.jitterPct).toBeLessThan(3);
});

test('debris and props are render-interpolated', async ({ page }) => {
  const log = watchConsole(page);
  await open(page, 'fire');
  await page.evaluate(() => { const l = (window as any).lumina; l.engine.timeScale = 0.5; l.scene.detonate('c4'); });
  await page.waitForTimeout(600);
  // At half speed physics steps every other frame; interpolation must still move debris every frame.
  const moving = await page.evaluate(async () => {
    const mesh = (window as any).lumina.scene.explosions.debris.mesh;
    const m = new (window as any).THREE.Matrix4();
    const samples: number[] = [];
    await new Promise<void>((resolve) => {
      const tick = () => { mesh.getMatrixAt(0, m); samples.push(m.elements[12] + m.elements[13] + m.elements[14]); if (samples.length < 40) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    let changed = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i] - samples[i - 1]) > 1e-5) changed++;
    return changed / (samples.length - 1);
  });
  console.log(`  debris: moved on ${(moving * 100).toFixed(0)} % of frames at half speed`);
  expect(moving, 'debris advances on (nearly) every rendered frame').toBeGreaterThan(0.9);
  expect(log.errors).toEqual([]);
});

test('aquaplaning visibly breaks traction and the car recovers', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 'highway');
  const result = await page.evaluate(async () => {
    const v = (window as any).lumina.scene.vehicle;
    let hydroEvents = 0;
    const off = (window as any).lumina.engine.events.on('aquaplane', () => hydroEvents++);
    let resets = 0;
    const original = v.reset.bind(v);
    v.reset = () => { resets++; original(); };
    let maxSlip = 0, maxHydro = 0, maxSpeed = 0, maxLane = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = v.chassis.translation();
        // Slip angle is only meaningful at speed (it is noise while pulling away).
        if (v.speed > 17) maxSlip = Math.max(maxSlip, Math.abs(v.slipAngle) * 57.3);
        maxHydro = Math.max(maxHydro, v.hydroplaning);
        maxSpeed = Math.max(maxSpeed, v.speed * 3.6);
        maxLane = Math.max(maxLane, Math.abs(t.x - v.laneX));
        if (performance.now() - start < 26_000) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    off();
    return { maxSlip, maxHydro, maxSpeed, maxLane, resets, hydroEvents };
  });
  console.log(`  aquaplaning: ${result.maxSpeed.toFixed(0)} km/h  hydro ${(result.maxHydro * 100).toFixed(0)} %  slip ${result.maxSlip.toFixed(1)}°  lane ±${result.maxLane.toFixed(2)} m  resets ${result.resets}`);
  expect(result.maxSpeed, 'cruises above 100 km/h').toBeGreaterThan(100);
  expect(result.maxHydro, 'tires fully lift in the deep pool').toBeGreaterThan(0.85);
  expect(result.maxSlip, 'the tail visibly steps out').toBeGreaterThan(6);
  expect(result.maxSlip, 'but the slide is catchable').toBeLessThan(35);
  expect(result.resets, 'the driver recovers without leaving the road').toBe(0);
  expect(result.maxLane).toBeLessThan(4);
  expect(result.hydroEvents, 'aquaplane event fired').toBeGreaterThan(0);
});
