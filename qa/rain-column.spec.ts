import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { RainColumn, type RainColumnOptions } from '../modules/weather/rain-column';
import { RainCloudBanks } from '../modules/weather/rain-cloud-banks';
import { StreetDrainage } from '../modules/wet-road/drainage';
import { watchConsole, TIERS } from './helpers';
const common: RainColumnOptions = {
  center: [50, -25],
  radius: [80, 60],
  baseY: 400,
  minimumY: 0,
  seed: 43,
  rainMmHour: 36,
  dropDiameterMm: 0.8,
  fallSpeed: 4,
  humidity: [1, 0.1],
  upperWind: [2, -1],
  lowerWind: [-2, 1],
  motion: [1, 0],
  evaporation: 0.032,
};
test('a drifting column integrates shear and dry-air exposure, including altitude and provider boundary', () => {
  const dry = new RainColumn(common),
    wet = new RainColumn({ ...common, humidity: [1, 0.93] }),
    saturated = new RainColumn({ ...common, humidity: [1, 1] });
  const center = (f: number, t: number) =>
    [50 + t + 100 * f * (1 - 2 * f), 400 * (1 - f), -25 + 100 * f * (-1 + f)] as const;
  for (const t of [0, 31, 177])
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const [x, y, z] = center(f, t);
      for (const column of [dry, wet, saturated]) {
        const remaining = Math.max(
          0,
          1 - (0.032 * 100 * f * 0.5 * f * (1 - column.lowerHumidity)) / 0.8 ** 2,
        );
        expect(column.rainAt(x, y, z, t)).toBeCloseTo(36 * remaining ** 1.5, 4);
      }
    }
  expect(dry.rainAt(50, 400, -25)).toBe(36);
  expect(dry.rainAt(-50, 0, -25)).toBe(0);
  expect(dry.rainAt(300, 300, -25)).toBe(0);
  expect(wet.rainAt(50, 401, -25)).toBe(0);
  expect(wet.rainAt(-50, -1, -25)).toBe(0);
  const version = dry.profileVersion;
  dry.setLowerHumidity(1);
  expect(dry.rainAt(-50, 0, -25)).toBe(36);
  expect(dry.profileVersion).toBe(version + 1);
  dry.setLowerHumidity(1);
  expect(dry.profileVersion).toBe(version + 1);
  expect(() => dry.setLowerHumidity(NaN)).toThrow();
  expect(() => new RainColumn({ ...common, radius: [0, 12] })).toThrow();
  expect(() => new RainColumn({ ...common, baseY: -1 })).toThrow();
  expect(new RainColumn({ ...common, seed: 44 }).source).not.toEqual(dry.source);
});
test('emitting banks move with their cloud and preserve unrelated upper and regional weather', () => {
  const cell = new RainColumn(common);
  const region = {
    iceVeil: true,
    coverageAt: (_x: number, _z: number, _t: number, upper: boolean) => (upper ? 0.63 : 0.21),
    coverageNode: () => undefined,
  };
  const banks = new RainCloudBanks([cell], region);
  expect(banks.iceVeil).toBe(true);
  expect(banks.coverageAt(50, -25, 0, false)).toBeGreaterThan(1.05);
  expect(banks.coverageAt(50, -25, 0, false)).toBeCloseTo(banks.coverageAt(145, -25, 95, false), 10);
  expect(banks.coverageAt(1500, 1000, 50, false)).toBeCloseTo(0.21, 8);
  expect(banks.coverageAt(50, -25, 50, true)).toBe(0.63);
});
test('a blank road with a different cloud, altitude and clock conserves only the rain received', () => {
  const moving = new RainColumn({
    ...common,
    baseY: 180,
    minimumY: -40,
    center: [3, 9],
    radius: [112, 74],
    seed: 18316,
    humidity: [0.98, 0.88],
    motion: [4, -1.2],
  });
  const road = () =>
    new StreetDrainage({
      x: -2,
      z: 2,
      width: 10,
      length: 12,
      columns: 8,
      rows: 8,
      ground: () => 22,
      roof: { area: 0, seconds: 1, outletX: 0, outletZ: 4 },
      drains: [],
    });
  const totals: number[] = [];
  for (const hz of [15, 60]) {
    const host = road();
    let millimetres = 0;
    for (let i = 0; i < 50 * hz; i++) {
      const rate = moving.rainAt(3, 22, 8, (i + 0.5) / hz);
      millimetres += rate / (3600 * hz);
      host.update(1 / hz, rate);
    }
    expect(host.budget.rainLitres).toBeCloseTo(120 * millimetres, 7);
    expect(host.depthAt(3, 8) * 1000).toBeCloseTo(millimetres, 8);
    expect(millimetres).toBeGreaterThan(0.01);
    totals.push(millimetres);
    host.dispose();
  }
  expect(totals[0]).toBeCloseTo(totals[1], 5);
});
const directory = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coast', 'rain-survey');
for (const backend of ['webgpu', 'webgl'])
  test(backend + ' same-source dry and wet showers, wet rut and humidity control', async ({ page }) => {
    const log = watchConsole(page);
    fs.mkdirSync(directory, { recursive: true });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/examples/dry-lake/rain.html?tier=high&backend=' + backend);
    await page.waitForFunction(() => ((window as any).rainSurvey?.engine.stats.frames ?? 0) > 25);
    const run = async (label: string) => {
      await page.waitForTimeout(450);
      return page
        .locator('canvas')
        .screenshot({ path: path.join(directory, backend + '-' + label + '.png') });
    };
    const matching = await page.evaluate(() => {
      const s = (window as any).rainSurvey;
      function projected(c: any, y: number) {
        const i = 4 * Math.round(((c.options.baseY - y) / c.height) * (c.profileSize - 1));
        const p = s.engine.camera.position
          .clone()
          .set(c.options.center[0] + c.profile[i], y, c.options.center[1] + c.profile[i + 1])
          .project(s.engine.camera);
        return [(p.x + 1) / 2, (1 - p.y) / 2];
      }
      return {
        gauges: s.groundRates.slice(),
        backend: s.engine.backend,
        samples: [projected(s.columns[0], 320), projected(s.columns[0], 95), projected(s.columns[1], 155)],
      };
    });
    expect(matching.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
    expect(matching.gauges[0]).toBe(0);
    expect(matching.gauges[1]).toBeGreaterThan(12);
    const aside = page.locator('aside');
    await aside.evaluate((e) => e.setAttribute('hidden', ''));
    const curtains = await run('ridge');
    await page.evaluate(() => {
      for (const s of (window as any).rainSurvey.views) s.root.visible = false;
    });
    const clear = await run('clear');
    function difference(a: Buffer, b: Buffer, u: number, v: number) {
      const p = PNG.sync.read(a),
        q = PNG.sync.read(b);
      let delta = 0;
      for (let j = -8; j <= 8; j++)
        for (let k = -10; k <= 10; k++) {
          const i = 4 * ((Math.round(v * p.height) + j) * p.width + Math.round(u * p.width) + k);
          for (let ch = 0; ch < 3; ch++) delta += Math.abs(p.data[i + ch] - q.data[i + ch]);
        }
      return delta / (3 * 17 * 21);
    }
    const delta = matching.samples.map(([u, v]: number[]) => difference(curtains, clear, u, v));
    expect(delta[0]).toBeGreaterThan(5);
    expect(delta[2]).toBeGreaterThan(5);
    expect(delta[1]).toBeLessThan(Math.min(delta[0], delta[2]) * 0.6);
    await page.evaluate(() => {
      for (const s of (window as any).rainSurvey.views) s.root.visible = true;
    });
    await aside.evaluate((e) => e.removeAttribute('hidden'));
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await button('Advance one minute').click();
    await button('Advance one minute').click();
    const wet = await page.evaluate(() => {
      const d = (window as any).rainSurvey;
      return d.roads.map((r: any) => [r.depth() * 1000, r.runoff.budget.rainLitres]);
    });
    expect(wet[0]).toEqual([0, 0]);
    expect(wet[1][0]).toBeGreaterThan(0.7);
    expect(wet[1][1]).toBeGreaterThan(30);
    for (const [name, label] of [
      ['West gauge', 'west-road'],
      ['East gauge', 'east-road'],
    ]) {
      await button(name).click();
      await aside.evaluate((e) => e.setAttribute('hidden', ''));
      await run(label);
      await aside.evaluate((e) => e.removeAttribute('hidden'));
    }
    await page.getByRole('slider', { name: 'East lower-air humidity' }).fill('98');
    await page.waitForFunction(() => (window as any).rainSurvey.groundRates[0] > 12);
    await button('Advance one minute').click();
    expect(await page.evaluate(() => (window as any).rainSurvey.roads[0].depth() * 1000)).toBeGreaterThan(
      0.2,
    );
    await button('Advance one minute').click();
    await aside.evaluate((e) => e.setAttribute('hidden', ''));
    const wetPavement = PNG.sync.read(await run('east-filled'));
    const wetPixels = await page.evaluate(() => {
      const d = (window as any).rainSurvey,
        r = d.roads[0],
        cam = d.engine.camera;
      const pt = cam.position.clone(),
        out: number[][] = [];
      for (let i = 0; i < 61; i++)
        for (const lane of [-1, 1])
          for (let j = -2; j <= 2; j++) {
            const z = r.z - 2.8 + i * 0.13,
              x = r.x + lane * (0.94 + j * 0.031);
            const h = r.runoff.depthAt(x, z);
            if (h < 0.001) continue;
            pt.set(x, r.floor(x, z) + h, z).project(cam);
            if (Math.abs(pt.x) < 0.87 && Math.abs(pt.y) < 0.91) out.push([(pt.x + 1) / 2, (1 - pt.y) / 2]);
          }
      return out;
    });
    await aside.evaluate((e) => e.removeAttribute('hidden'));
    await button('Empty both roads').click();
    await aside.evaluate((e) => e.setAttribute('hidden', ''));
    const emptied = PNG.sync.read(await run('east-emptied'));
    expect(wetPixels.length).toBeGreaterThan(65);
    let blueDifference = 0;
    for (const [u, v] of wetPixels) {
      const index = 4 * (Math.floor(v * emptied.height) * emptied.width + Math.floor(u * emptied.width)) + 2;
      blueDifference += Math.abs(wetPavement.data[index] - emptied.data[index]);
    }
    blueDifference /= wetPixels.length;
    expect(blueDifference).toBeGreaterThan(9);
    expect(await page.evaluate(() => (window as any).rainSurvey.roads[0].depth() * 1000)).toBeLessThan(0.05);
    expect(log.errors).toEqual([]);
    fs.writeFileSync(
      path.join(directory, backend + '.json'),
      JSON.stringify(
        { matching, delta, wet, wetSamples: wetPixels.length, blueDifference, errors: log.errors },
        null,
        2,
      ),
    );
  });
for (const backend of ['webgpu', 'webgl'])
  for (const tier of TIERS)
    test(backend + ' ' + tier + ' rain crossing plays at 1080p', async ({ page }) => {
      const log = watchConsole(page);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/examples/dry-lake/rain.html?tier=' + tier + '&backend=' + backend);
      await page.waitForFunction(() => ((window as any).rainSurvey?.engine.stats.frames ?? 0) > 12);
      const result = await page.evaluate(async () => {
        const d = (window as any).rainSurvey,
          e = d.engine,
          start = e.stats.frames,
          ms: number[] = [];
        const rain = d.roads[1].runoff.budget.rainLitres;
        let prev = 0;
        await new Promise<void>((resolve) => {
          function tick(t: number) {
            if (prev) ms.push(t - prev);
            prev = t;
            if (ms.length >= 180) return resolve();
            requestAnimationFrame(tick);
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
          scale: e.stats.renderScale,
          draws: e.stats.drawCalls,
          frames: e.stats.frames - start,
          actual: e.backend,
          size: [e.canvas.width, e.canvas.height],
          delivered: d.roads[1].runoff.budget.rainLitres - rain,
        };
      });
      expect(log.errors).toEqual([]);
      expect(result.actual).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
      expect(result.frames).toBeGreaterThanOrEqual(176);
      expect(result.delivered).toBeGreaterThan(0.3);
      expect(result.fps).toBeGreaterThanOrEqual(58);
      expect(result.p95).toBeLessThanOrEqual(18.5);
      expect(result.size).toEqual([1920, 1080]);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, backend + '-' + tier + '.json'), JSON.stringify(result, null, 2));
    });
