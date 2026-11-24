import { expect, test } from '@playwright/test';
import { Raycaster, Mesh, MeshBasicMaterial, Vector3 } from 'three/webgpu';
import { SaltCrust } from '../modules/surface-deform/salt-crust';
import { watchConsole } from './helpers';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import path from 'node:path';
const options = {
  x: -1,
  z: -1,
  cellSize: 0.025,
  columns: 81,
  rows: 81,
  seed: 62,
  bedAt: (x: number, z: number) => 0.013 * x - 0.025 * z,
};
test('crust yields under pressure, keeps its peak at rest and reports the actual drawn triangles after restore', () => {
  const a = new SaltCrust(options),
    m = new Mesh(a.geometry, new MeshBasicMaterial()),
    read = { height: 0, fracture: 0 };
  const initial = a.save(),
    h = a.sample(0.16, -0.13, read).height;
  a.press(0.16, -0.13, 0.16, 0.2, 0.32, 100);
  expect(a.save()).toEqual(initial);
  a.press(0.16, -0.13, 0.16, 0.2, 0.32, 1800);
  a.flush();
  const saved = a.save();
  expect(saved.pressures.length).toBeGreaterThan(30);
  const deep = a.sample(0.16, -0.13, read).height;
  expect(h - deep).toBeGreaterThan(0.032);
  expect(read.fracture).toBeGreaterThan(0.8);
  const ray = new Raycaster(),
    down = new Vector3(0, -1, 0);
  for (let i = 0; i < 100; i++) {
    const x = 0.04 + 0.25 * ((i * 0.37) % 1),
      z = -0.25 + 0.24 * ((i * 0.41) % 1);
    ray.set(new Vector3(x, 1, z), down);
    const hit = ray.intersectObject(m)[0];
    expect(hit).toBeDefined();
    expect(hit.point.y).toBeCloseTo(a.sample(x, z, read).height, 6);
  }
  a.press(0.16, -0.13, 0.16, 0.2, 0.32, 1800);
  expect(a.save()).toEqual(saved);
  expect(() => a.restore({ ...saved, pressures: [...saved.pressures, 0, -1] })).toThrow();
  expect(a.save()).toEqual(saved);
  a.restore(initial);
  expect(a.sample(0.16, -0.13, read).height).toBeCloseTo(h, 7);
  a.restore(saved);
  expect(a.sample(0.16, -0.13, read).height).toBeCloseTo(deep, 7);
  expect(a.save()).toEqual(saved);
  expect(a.sample(-4, 0, read).height).toBe(options.bedAt(-4, 0));
  a.dispose();
  m.material.dispose();
});
test('a thicker crust resists the same force and a different host bed rejects the save', () => {
  const thin = new SaltCrust({ ...options, thicknessM: 0.008 }),
    thick = new SaltCrust({ ...options, thicknessM: 0.04 });
  for (const panel of [thin, thick]) panel.press(0, 0, 0.12, 0.18, 0, 730);
  const read = { height: 0, fracture: 0 };
  expect(thin.sample(0, 0, read).fracture).toBeGreaterThan(thick.sample(0, 0, { ...read }).fracture + 0.3);
  const other = new SaltCrust({ ...options, thicknessM: 0.008, bedAt: () => -0.12 });
  expect(() => other.restore(thin.save())).toThrow();
  expect(other.save().pressures).toHaveLength(0);
  thin.dispose();
  thick.dispose();
  other.dispose();
});
for (const backend of ['webgpu', 'webgl'])
  test(backend + ' empty and loaded survey carts on a salt flat at noon and sunset', async ({ page }) => {
    const log = watchConsole(page),
      dir = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coast', 'salt-pan');
    fs.mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/examples/dry-lake/?backend=' + backend + '&tier=high');
    await page.waitForFunction(() => ((window as any).dryLake?.engine.stats.frames ?? 0) > 5);
    const btn = (s: string) => page.getByRole('button', { name: s, exact: true });
    const read = () =>
      page.evaluate(() => {
        const d = (window as any).dryLake,
          p = d.pan,
          b = d.boot,
          v = { height: 0, fracture: 0 };
        const boot = { ...p.sample(b.x, b.z, v) },
          l = p.sample(d.pathX(0) - 0.46, 0, v).height;
        return {
          backend: d.engine.backend,
          boot,
          left: l,
          indices: p.save().pressures.length / 2,
          level: d.waterLevel,
          progress: d.progress,
        };
      });
    const capture = async (name: string) => {
      await page.evaluate(async () => {
        for (let i = 0; i < 32; i++) await new Promise(requestAnimationFrame);
      });
      await page.locator('aside').evaluate((el) => ((el as HTMLElement).style.visibility = 'hidden'));
      await page.screenshot({ path: path.join(dir, backend + '-' + name + '.jpg'), quality: 90 });
      await page.locator('aside').evaluate((el) => ((el as HTMLElement).style.visibility = ''));
    };
    const before = await read();
    await capture('evening');
    await btn('Roll cart').click();
    await page.waitForFunction(
      () => !(window as any).dryLake.rolling && (window as any).dryLake.progress >= 11.4,
    );
    const empty = await read();
    expect(empty.indices).toBe(0);
    await page.getByRole('slider', { name: 'Cart ballast' }).focus();
    await page.keyboard.press('End');
    await btn('Roll again').click();
    await page.waitForFunction(
      () => !(window as any).dryLake.rolling && (window as any).dryLake.progress >= 11.4,
    );
    const loaded = await read();
    await capture('loaded-evening');
    await btn('Ground view').click();
    await capture('ground');
    await btn('Press boot').click();
    await capture('boot');
    const boot = await read();
    await page.getByRole('slider', { name: 'Solar hour' }).fill('12');
    await expect(page.locator('#clock')).toHaveText('12:00');
    await capture('noon');
    await page.locator('summary').click();
    await btn('Save survey').click();
    await btn('Fresh crust').click();
    expect((await read()).indices).toBe(0);
    await btn('Restore').click();
    const restored = await read();
    await btn('Waterline view').click();
    await page.getByRole('slider', { name: 'Solar hour' }).fill('19.2');
    await page.evaluate(async () => {
      for (let i = 0; i < 100; i++) await new Promise(requestAnimationFrame);
    });
    await capture('lamp-on');
    const waterPixels = await page.evaluate(() => {
      const d = (window as any).dryLake,
        cam = d.engine.camera,
        pt = cam.position.clone(),
        read = { height: 0, fracture: 0 };
      const points: [number, number][] = [];
      for (let i = 0; i < 64; i++)
        for (let j = 0; j < 52; j++) {
          const x = 0.45 + i * 0.0275,
            z = -0.95 + j * 0.055;
          if (d.pan.sample(x, z, read).height >= d.waterLevel - 0.004) continue;
          pt.set(x, d.waterLevel, z).project(cam);
          if (Math.abs(pt.x) < 0.9 && Math.abs(pt.y) < 0.93) points.push([(1 + pt.x) / 2, (1 - pt.y) / 2]);
        }
      return points;
    });
    async function reds() {
      const data = PNG.sync.read(await page.locator('canvas').screenshot());
      return waterPixels.map(
        ([x, y]) => data.data[4 * (Math.floor(x * data.width) + Math.floor(y * data.height) * data.width)],
      );
    }
    const lit = await reds();
    await page.evaluate(() => {
      (window as any).dryLake.weather.localProbe.enabled = false;
    });
    await capture('probe-off');
    const noProbe = await reds();
    await page.evaluate(() => {
      (window as any).dryLake.weather.localProbe.enabled = true;
    });
    await btn('Pump-house light').click();
    await expect(btn('Pump-house light')).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(async () => {
      for (let i = 0; i < 50; i++) await new Promise(requestAnimationFrame);
    });
    await capture('lamp-off');
    const dark = await reds();
    const meanDifference = (a: number[], b: number[]) =>
      a.reduce((sum, v, i) => sum + v - b[i], 0) / a.length;
    const lightGain = meanDifference(lit, dark),
      probeGain = meanDifference(lit, noProbe);
    const evidence = {
      before,
      empty,
      loaded,
      boot,
      restored,
      lightGain,
      probeGain,
      submergedSamples: lit.length,
      errors: log.errors,
    };
    fs.writeFileSync(path.join(dir, backend + '.json'), JSON.stringify(evidence, null, 2));
    console.log(backend, evidence);
    expect(lit.length).toBeGreaterThan(150);
    expect(lightGain).toBeGreaterThan(8);
    expect(probeGain).toBeGreaterThan(8);
    expect(log.errors).toEqual([]);
    expect(before.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
    expect(loaded.indices).toBeGreaterThan(400);
    expect(empty.left - loaded.left).toBeGreaterThan(0.01);
    expect(boot.boot.fracture).toBeGreaterThan(before.boot.fracture + 0.3);
    expect(restored).toEqual(boot);
    await page.evaluate(() => localStorage.setItem('lumina-dry-lake-survey-1', '{'));
    await btn('Restore').click();
    await expect(page.locator('#save-note')).toContainText('could not be restored');
    expect(await read()).toEqual(boot);
  });
