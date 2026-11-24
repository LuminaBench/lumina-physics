import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { RunoffCrossing, type RunoffCrossingOptions } from '../modules/water/runoff-crossing';
import { TidalInlet } from '../modules/water/tidal-inlet';
import { makeWashSurvey, washGauges } from '../examples/dry-lake/wash-recipe';
import { watchConsole, TIERS } from './helpers';

const output = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output', 'wash');
const options: RunoffCrossingOptions = {
  bands: [{ gauge: [8, 1, 2], areaM2: 3600, travelSeconds: 1.225, infiltrationMmHour: 2 }],
  channelSeconds: 1.7,
  patch: {
    x: 0,
    z: 0,
    columns: 8,
    rows: 7,
    spacing: 1,
    seaLevel: -0.2,
    seaEdge: 'east',
    bedAt: (x) => (x > 3 && x < 5 ? 1.4 : 0),
    initialStageAt: () => 0,
    tributary: [1.5, 3.5],
    culvert: { inlet: [2.5, 0.02, 3.5], outlet: [5.5, 0, 3.5], width: 0.72, height: 0.28 },
    tributarySiltKgM3: 0.34,
  },
};
const rain = (x: number, _y: number, _z: number, t: number) => (x === 8 && t < 4 ? 22 : 0);
test('fractional travel, intake and recharge are independent of frame pace and survive a save', () => {
  const s = new RunoffCrossing(options);
  s.update(1.2, rain);
  expect(s.balance().deliveredM3).toBe(0);
  const b = s.balance();
  expect(b.rainM3).toBeCloseTo(0.0264, 10);
  expect(b.infiltrationM3).toBeCloseTo(0.0024, 10);
  s.update(0.337, rain);
  const snap = s.save();
  expect(snap.remainder).toBeCloseTo(0.037, 10);
  expect(snap.inTransit.some((x) => x > 0)).toBe(true);
  expect(snap.channelM3).toBeGreaterThan(0);
  s.update(18, rain);
  const finish = s.save();
  for (const hz of [15, 60, 120]) {
    const copy = new RunoffCrossing(options);
    copy.restore(snap);
    for (let i = 0; i < 18 * hz; i++) copy.update(1 / hz, rain);
    const result = copy.save();
    expect(result.water).toEqual(finish.water);
    expect(result.deliveredM3).toEqual(finish.deliveredM3);
    expect(copy.time).toBeCloseTo(s.time, 10);
    expect(copy.balance().rainM3).toBeCloseTo(0.088, 10);
    copy.dispose();
  }
  for (const corrupt of [
    { ...snap, inTransit: [] },
    { ...snap, channelM3: 12 },
    { ...snap, water: { ...snap.water, opening: 2 } },
    { ...snap, water: { ...snap.water, water: [] } },
    { ...snap, dischargeM3s: NaN },
  ]) {
    expect(() => s.restore(corrupt)).toThrow();
    expect(s.save()).toEqual(finish);
  }
  const dry = new RunoffCrossing(options);
  dry.update(8, () => 1);
  expect(dry.balance().deliveredM3).toBe(0);
  expect(dry.balance().rainM3).toBeCloseTo(dry.balance().infiltrationM3, 12);
  expect(() => s.update(0.05, () => NaN)).toThrow();
  expect(s.save()).toEqual(finish);
  dry.dispose();
  s.dispose();
});
test('a buried opening reverses under opposing head and accepts legacy unported surveys', () => {
  const basin = { ...options.patch, initialStageAt: (x: number) => (x > 5 ? 0.6 : 0) };
  const pipe = new TidalInlet(basin);
  pipe.update(0.05, 0.6);
  expect(pipe.culvertDischargeM3s).toBeLessThan(0);
  pipe.setCulvertOpening(0);
  pipe.update(0.05, 0.6);
  expect(pipe.culvertDischargeM3s).toBe(0);
  expect(Math.abs(pipe.balance().waterErrorM3)).toBeLessThan(1e-10);
  const unported = new TidalInlet({
    ...basin,
    tributary: undefined,
    culvert: undefined,
    tributarySiltKgM3: 0,
  });
  const old = unported.save();
  expect(old.version).toBe(1);
  expect(old).not.toHaveProperty('runoffM3');
  unported.update(0.1, 0.2);
  unported.restore(old);
  expect(unported.save()).toEqual(old);
  expect(() => unported.update(0.05, 0.2, 1)).toThrow();
  expect(() => pipe.restore(old)).toThrow();
  unported.dispose();
  pipe.dispose();
});
test('equal storms produce distinct road crests, delayed arrivals and closed budgets through recession', () => {
  fs.mkdirSync(output, { recursive: true });
  const runs = [1, 0.12].map((clear) => {
    const { crossing: s, bands, rainAt } = makeWashSurvey();
    s.water.setCulvertOpening(clear);
    const rows: number[][] = [];
    let lastRain = 0,
      arrival = 0,
      overtopped = 0,
      peak = 0,
      peakT = 0;
    let rising: ReturnType<typeof s.save> | undefined;
    for (let t = 0; t <= 270; t++) {
      if (t) s.update(1, rainAt);
      const gauges = washGauges.map((g) => s.water.depthAt(g[0], g[1])),
        budget = s.balance();
      const gaugeRate = Math.max(...bands.map((b) => rainAt(...b.gauge, t)));
      expect(rainAt(0.325, 0.3, 0.325, t)).toBe(0);
      if (gaugeRate > 0.01) lastRain = t;
      if (!arrival && s.inflowM3s > 0.001) arrival = t;
      if (!overtopped && gauges[1] > 0.005) overtopped = t;
      if (gauges[1] > peak) {
        peak = gauges[1];
        peakT = t;
      }
      if (t === 108) rising = s.save();
      rows.push([
        t,
        ...gauges,
        gaugeRate,
        s.inflowM3s,
        s.water.culvertDischargeM3s,
        budget.patchM3,
        budget.outletM3,
      ]);
    }
    const end = s.save(),
      result = s.balance();
    expect(lastRain).toBeLessThan(arrival);
    expect(arrival).toBe(61);
    expect(result.rainM3).toBeCloseTo(33.87, 2);
    expect(
      Math.abs(result.catchmentErrorM3) +
        Math.abs(result.patchErrorM3) +
        Math.abs(s.water.balance().sedimentErrorKg),
    ).toBeLessThan(1e-8);
    if (clear === 1) expect(peak).toBe(0);
    else {
      expect(peak).toBeGreaterThan(0.04);
      expect(peak).toBeLessThan(0.05);
      expect(overtopped).toBeGreaterThan(120);
      expect(peakT).toBeGreaterThan(overtopped);
      expect(rows[270][2]).toBeLessThan(0.004);
    }
    s.restore(rising!);
    s.update(162, rainAt);
    expect(s.save()).toEqual(end);
    s.dispose();
    return { clear, peak, peakT, arrival, lastRain, overtopped, result, rows };
  });
  expect(runs[0].result.rainM3).toBe(runs[1].result.rainM3);
  fs.writeFileSync(path.join(output, 'hydrographs.json'), JSON.stringify(runs));
});
async function enter(page: Page, backend: string, tier = 'high') {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/examples/dry-lake/wash.html?backend=' + backend + '&tier=' + tier);
  await page.waitForFunction(() => ((window as any).washSurvey?.engine.stats.frames ?? 0) > 12);
}
for (const backend of ['webgpu', 'webgl']) {
  test(backend + ' a saved rising storm restores the visible overtopping at the road', async ({ page }) => {
    const log = watchConsole(page);
    await enter(page, backend);
    fs.mkdirSync(output, { recursive: true });
    const skip = async (n: number) => {
      for (let i = 0; i < n; i++) await page.locator('#skip').click();
    };
    const photo = async (id: string) => {
      const aside = page.locator('aside');
      await aside.evaluate((el) => el.setAttribute('hidden', ''));
      await page.waitForTimeout(230);
      const buf = await page
        .locator('#world')
        .screenshot({ path: path.join(output, backend + '-' + id + '.png') });
      await aside.evaluate((el) => el.removeAttribute('hidden'));
      return buf;
    };
    const check = () =>
      page.evaluate(() => {
        const d = (window as any).washSurvey;
        return {
          time: d.sim.time,
          opening: d.sim.water.culvertOpening,
          budget: d.sim.balance(),
          trace: Array.from(d.record),
          view: d.view,
          backend: d.engine.backend,
        };
      });
    await photo('dry');
    await page.locator('#ridge').click();
    await skip(1);
    await photo('ridge');
    await page.locator('#crossing').click();
    await skip(9);
    const open = PNG.sync.read(await photo('open'));
    await page.locator('#outlet').click();
    await photo('outlet');
    await page.locator('#crossing').click();
    await page.locator('#restart').click();
    await page.locator('#opening').fill('12');
    await skip(7);
    await page.locator('summary').click();
    await page.locator('#save').click();
    await expect(page.locator('#save-status')).toContainText('saved');
    await skip(3);
    const block = PNG.sync.read(await photo('blocked'));
    const atCrest = await check();
    expect(atCrest.time).toBeCloseTo(150, 7);
    expect(atCrest.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
    const samples = await page.evaluate(() => {
      const d = (window as any).washSurvey,
        c = d.engine.camera,
        p = c.position.clone(),
        out: number[][] = [];
      for (let i = -16; i <= 16; i++)
        for (let j = -9; j <= 9; j++) {
          const x = i * 0.105,
            z = j * 0.095,
            h = d.sim.water.depthAt(x, z);
          if (h < 0.018) continue;
          const y = d.sim.water.stageAt(x, z, 0);
          p.set(x, y, z).project(c);
          if (Math.abs(p.x) < 0.85 && Math.abs(p.y) < 0.9) out.push([(1 + p.x) * 0.5, (1 - p.y) * 0.5]);
        }
      return out;
    });
    let change = 0;
    for (const [u, v] of samples) {
      const pos = 4 * (Math.floor(v * block.height) * block.width + Math.floor(u * block.width));
      for (let k = 0; k < 3; k++) change += Math.abs(block.data[pos + k] - open.data[pos + k]);
    }
    change /= 3 * samples.length;
    expect(samples.length).toBeGreaterThan(70);
    expect(change).toBeGreaterThan(8);
    await page.locator('#inlet').click();
    await photo('inlet');
    await page.locator('#opening').fill('85');
    await page.locator('#restore').click();
    await expect(page.locator('#save-status')).toContainText('restored');
    expect((await check()).time).toBeCloseTo(105, 7);
    await skip(3);
    expect(await check()).toEqual(atCrest);
    await page.evaluate(() => localStorage.setItem('lumina-runoff-crossing-1', '{}'));
    await page.locator('#restore').click();
    await expect(page.locator('#save-status')).toContainText('could not be restored');
    expect(await check()).toEqual(atCrest);
    expect(log.errors).toEqual([]);
    fs.writeFileSync(
      path.join(output, backend + '-visual.json'),
      JSON.stringify(
        {
          samples: samples.length,
          meanDifference: change,
          errors: log.errors,
          atCrest: { ...atCrest, trace: undefined },
        },
        null,
        2,
      ),
    );
  });
  for (const tier of TIERS)
    test(backend + ' ' + tier + ' plays across a moving flood crest at 1080p', async ({ page }) => {
      const log = watchConsole(page);
      await enter(page, backend, tier);
      await page.locator('#opening').fill('12');
      await page.evaluate(() => {
        for (let i = 0; i < 9; i++) document.getElementById('skip')!.click();
      });
      await page.locator('#run').click();
      await page.waitForFunction(() => (window as any).washSurvey.sim.time > 137);
      const stats = await page.evaluate(async () => {
        const d = (window as any).washSurvey,
          e = d.engine,
          frames = e.stats.frames,
          t0 = d.sim.time,
          ms: number[] = [];
        let prev = 0;
        await new Promise<void>((res) => {
          function tick(t: number) {
            if (prev) ms.push(t - prev);
            prev = t;
            if (ms.length === 180) res();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
        const fps = 180000 / ms.reduce((a, b) => a + b, 0);
        ms.sort((a, b) => a - b);
        return {
          fps,
          p95: ms[170],
          p99: ms[178],
          longest: ms[179],
          frames: e.stats.frames - frames,
          scale: e.stats.renderScale,
          backend: e.backend,
          size: [e.canvas.width, e.canvas.height],
          start: t0,
          end: d.sim.time,
          roadDepth: d.sim.water.depthAt(0.325, 0.325),
          draws: e.stats.drawCalls,
        };
      });
      expect(log.errors).toEqual([]);
      expect(stats.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
      expect(stats.size).toEqual([1920, 1080]);
      expect(stats.end - stats.start).toBeGreaterThan(21);
      expect(stats.roadDepth).toBeGreaterThan(0.025);
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, backend + '-' + tier + '.json'), JSON.stringify(stats, null, 2));
      expect(stats.frames).toBeGreaterThanOrEqual(175);
      expect(stats.fps).toBeGreaterThanOrEqual(58);
      expect(stats.p95).toBeLessThanOrEqual(18.5);
    });
}
