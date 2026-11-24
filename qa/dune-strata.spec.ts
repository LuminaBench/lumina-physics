import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { MobileDune, type DuneOptions } from '../modules/coast/mobile-dune';
import { watchConsole, TIERS } from './helpers';

const recipe: DuneOptions = {
  seed: 879,
  centerX: 0,
  centerZ: 0,
  size: 6,
  resolution: 61,
  thicknessAt: () => 0.55,
  coarseFractionAt: () => 0.1,
  coarseMobility: 0.15,
  protectedAt: (x, z) => x > 1.9 && z < -0.8,
  lens: {
    topDepthAt: (x, z) => 0.12 + 0.025 * x + 0.012 * z,
    thicknessAt: () => 0.09,
    coarseFraction: 0.8,
    mineral: '#3a4140',
    pale: '#ada17d',
  },
};
const base = (x: number, z: number) => 0.025 * x + 0.01 * z;
const budget = (d: MobileDune) => [
  d.volume(),
  d.coarseDepth.reduce((a, b) => a + b, 0) * d.spacing ** 2,
  d.strata!.markerVolume(),
];
const surface = (d: MobileDune, x: number, z: number) =>
  d.strata!.surfaceFractionAt(x, z, base(x, z) + d.depthAt(x, z));
test('a cut intersects the surveyed lens, retains its fractions in spoil and restores its stratigraphy', () => {
  const d = new MobileDune(recipe, base),
    initial = budget(d);
  expect(surface(d, 0, 0)).toBe(0);
  d.cut(0, 0, 1.6, 0.8, 0, 0.06, 1.2, 0, 'scoop');
  expect(surface(d, 0, 0)).toBe(0);
  expect(surface(d, 1.2, 0)).toBe(0);
  d.cut(0, 0, 1.6, 0.8, 0, 0.12, 1.2, 0, 'scoop');
  expect(surface(d, 0, 0)).toBeGreaterThan(0.99);
  expect(surface(d, 1.2, 0)).toBeCloseTo(1 / 3, 4);
  const saved = JSON.parse(JSON.stringify(d.save()));
  d.cut(0, 0, 1.6, 0.8, 0, 0.12, 1.2, 0, 'scoop');
  expect(surface(d, 0, 0)).toBeLessThan(0.01);
  expect(surface(d, 1.2, 0)).toBeCloseTo(0.3, 4);
  expect(d.depthAt(0.3, 0.5)).toBeGreaterThan(d.depthAt(0, 0));
  d.restore(saved);
  expect(d.save()).toEqual(saved);
  d.cut(1.2, 0, 1.6, 0.8, 0, 0.12, -1.2, 0, 'scoop');
  expect(surface(d, 0, 0)).toBeCloseTo(1 / 3, 4);
  const beforeWind = d.save();
  for (let i = 0; i < 96; i++) d.update(1 / 12, 18, -7, 0.18);
  const after = budget(d);
  for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(initial[i], 5);
  const a = d.save();
  expect(a.version).toBe(3);
  if (a.version !== 3) throw Error('missing strata');
  const bad = { ...a, strata: { ...a.strata, mixed: a.strata.mixed.slice() } };
  bad.strata.mixed[0] = 0.01;
  expect(() => d.restore(bad)).toThrow();
  expect(d.save()).toEqual(a);
  expect(() => d.restore({ ...a, strata: { ...a.strata, markerM3: a.strata.markerM3 + 0.25 } })).toThrow();
  expect(d.save()).toEqual(a);
  d.restore(beforeWind);
  for (let i = 0; i < 96; i++) d.update(1 / 12, 18, -7, 0.18);
  expect(d.save()).toEqual(a);
  const other = new MobileDune({ ...recipe, lens: { ...recipe.lens!, thicknessAt: () => 0.02 } }, base);
  expect(() => other.restore(a)).toThrow();
  other.dispose();
  d.reset();
  expect(surface(d, 0, 0)).toBe(0);
  expect(budget(d)).toEqual(initial);
  d.dispose();
});
test('older thickness and composition saves preserve their elevations and available evidence', () => {
  const plain = new MobileDune({ ...recipe, lens: undefined }, base),
    d = new MobileDune(recipe, base);
  plain.cut(0, 0, 1.1, 0.8, 0, 0.22, 1.1, 0);
  const old = plain.save();
  expect(old.version).toBe(2);
  d.restore(old);
  const current = d.save();
  expect(current.thickness).toEqual(old.thickness);
  if (old.version === 2 && current.version === 3) expect(current.coarse).toEqual(old.coarse);
  else throw Error('wrong version');
  // The legacy survey had no mineral labels for the disturbed material.
  expect(surface(d, 0, 0)).toBe(0);
  const v1 = { ...old, version: 1 as const };
  d.restore(v1);
  expect(d.save().thickness).toEqual(old.thickness);
  expect(() => plain.restore(current)).toThrow();
  d.dispose();
  plain.dispose();
});
for (const shore of ['headland', 'volcanic'])
  for (const backend of ['webgpu', 'webgl']) {
    const folder = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output', 'strata', shore);
    test(backend + ' ' + shore + ' exposes its surveyed seam and returns mixed spoil', async ({ page }) => {
      const log = watchConsole(page);
      fs.mkdirSync(folder, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=' + shore + '&tier=high&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 12);
      await page.locator('#clock').fill('12.5');
      await page.locator('summary').click();
      const run = async (id: string, label: string) => {
        await page.locator('#' + id + '-section').click();
        await page.waitForTimeout(300);
        await page.locator('aside').evaluate((e) => (e.style.visibility = 'hidden'));
        const frame = PNG.sync.read(
          await page
            .locator('canvas')
            .first()
            .screenshot({ path: path.join(folder, backend + '-' + label + '.png') }),
        );
        await page.locator('aside').evaluate((e) => (e.style.visibility = 'visible'));
        const read = await page.evaluate(() => {
          const w = (window as any).coastDemo.world,
            d = w.dune,
            { centerX: x, centerZ: z } = d.options,
            cam = w.engine.camera,
            pt = cam.position.clone();
          const uvs: number[][] = [];
          let total = 0;
          for (let i = -14; i <= 14; i++)
            for (let j = -8; j <= 8; j++) {
              const a = x + i * 0.024,
                b = z + j * 0.029,
                y = w.ground(a, b);
              if (d.strata.surfaceFractionAt(a, b, y) > 0.9) {
                pt.set(a, y, b).project(cam);
                uvs.push([(1 + pt.x) / 2, (1 - pt.y) / 2]);
              }
              total++;
            }
          const h = w.ground(x, z);
          return { fraction: d.strata.surfaceFractionAt(x, z, h), depth: d.depthAt(x, z), uvs, total };
        });
        return { frame, read };
      };
      const untouched = await run('reset', 'initial'),
        skin = await run('skim', 'skim'),
        lens = await run('deepen', 'lens');
      const below = await run('deepen', 'section'),
        filled = await run('fill', 'spoil');
      expect(untouched.read.fraction).toBeLessThan(0.02);
      expect(skin.read.fraction).toBeLessThan(0.05);
      expect(lens.read.fraction).toBeGreaterThan(0.95);
      expect(below.read.fraction).toBeLessThan(0.05);
      expect(filled.read.fraction).toBeGreaterThan(0.12);
      expect(filled.read.fraction).toBeLessThan(0.65);
      expect(lens.read.uvs.length).toBeGreaterThan(70);
      const prior = skin.frame,
        now = lens.frame;
      let lightDiff = 0;
      for (const [u, v] of lens.read.uvs) {
        const k = 4 * (Math.floor(v * now.height) * now.width + Math.floor(u * now.width));
        for (let c = 0; c < 3; c++) lightDiff += (prior.data[k + c] - now.data[k + c]) / 3;
      }
      lightDiff /= lens.read.uvs.length;
      expect(shore === 'headland' ? lightDiff : -lightDiff).toBeGreaterThan(9);
      const precision = await page.evaluate(async () => {
        const w = (window as any).coastDemo.world,
          d = w.dune,
          T = (window as any).THREE,
          t = T.TSL,
          e = w.engine;
        e.stop();
        const points: number[] = [],
          gold: number[] = [],
          n = 101;
        for (let i = 0; i < n; i++) {
          const x = d.options.centerX + Math.sin(i * 2.1) * 1.45,
            z = d.options.centerZ + Math.cos(i * 0.79) * 0.87,
            y = w.ground(x, z);
          points.push(x, y, z, 1);
          gold.push(d.strata.surfaceFractionAt(x, z, y));
        }
        const tex = new T.DataTexture(Float32Array.from(points), n, 1, T.RGBAFormat, T.FloatType);
        tex.needsUpdate = true;
        const p = t.texture(tex, t.uv()).level(0);
        const m = new T.NodeMaterial(),
          target = new T.RenderTarget(n, 1, { type: T.FloatType, depthBuffer: false }),
          q = new T.QuadMesh(m);
        m.fragmentNode = t.vec4(d.strata.surfaceFractionNode(p.xz, p.y), 0, 0, 1);
        const r = e.renderer,
          prev = r.getRenderTarget();
        try {
          r.setRenderTarget(target);
          q.render(r);
          const pixels = await r.readRenderTargetPixelsAsync(target, 0, 0, n, 1);
          return {
            error: Math.max(...gold.map((v, i) => Math.abs(v - pixels[i * 4]))),
            tested: n,
            backend: e.backend,
          };
        } finally {
          r.setRenderTarget(prev);
          target.dispose();
          tex.dispose();
          m.dispose();
        }
      });
      expect(precision.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
      expect(precision.error).toBeLessThan(0.008);
      expect(log.errors).toEqual([]);
      fs.writeFileSync(
        path.join(folder, backend + '-proof.json'),
        JSON.stringify(
          {
            precision,
            lightDiff,
            points: lens.read.uvs.length,
            fractions: [untouched, skin, lens, below, filled].map((s) => s.read.fraction),
            depths: [untouched, skin, lens, below, filled].map((s) => s.read.depth),
          },
          null,
          2,
        ),
      );
    });
    test(
      backend + ' ' + shore + ' a loaded wheel exposes the lens beside a shallow sole',
      async ({ page }) => {
        const log = watchConsole(page);
        await page.goto('/coast.html?shore=' + shore + '&tier=high&backend=' + backend);
        await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 9);
        const result = await page.evaluate(() => {
          const w = (window as any).coastDemo.world,
            d = w.dune,
            e = w.engine;
          e.stop();
          d.reset();
          const x = d.options.centerX,
            z = d.options.centerZ,
            span = d.spacing * 10;
          const pair = [z - span, z + span].map((probeZ, index) => {
            const cap = d.options.lens.topDepthAt(x, probeZ);
            // Prepare identical cover above the two buried contacts in metres.
            d.cut(x, probeZ, 0.66, 0.62, 0, cap - 0.045, -1.15, 0.14);
            const original = d.depthAt(x, probeZ),
              before = d.strata.surfaceFractionAt(x, probeZ, w.ground(x, probeZ));
            if (index === 0) w.sediment.imprint('foot', x, probeZ, 0, 0.16, 0.3, 0.65, 0);
            else for (let i = 0; i < 2; i++) w.sediment.imprint('wheel', x, probeZ, 0, 0.27, 0.38, 1.7, 0.32);
            return {
              before,
              after: d.strata.surfaceFractionAt(x, probeZ, w.ground(x, probeZ)),
              removed: original - d.depthAt(x, probeZ),
            };
          });
          return pair;
        });
        expect(result[0].before).toBeLessThan(0.01);
        expect(result[1].before).toBeLessThan(0.01);
        expect(result[0].after).toBeLessThan(0.02);
        expect(result[1].after).toBeGreaterThan(0.95);
        expect(result[1].removed).toBeGreaterThan(result[0].removed + 0.05);
        expect(log.errors).toEqual([]);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, backend + '-contacts.json'), JSON.stringify(result));
      },
    );
    for (const tier of TIERS)
      test(backend + ' ' + tier + ' ' + shore + ' active sand section at 1080p', async ({ page }) => {
        const log = watchConsole(page);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto('/coast.html?shore=' + shore + '&tier=' + tier + '&backend=' + backend);
        await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 14);
        await page.locator('summary').click();
        await page.locator('#skim-section').click();
        await page.locator('#deepen-section').click();
        const data = await page.evaluate(async () => {
          const w = (window as any).coastDemo.world,
            e = w.engine,
            d = w.dune,
            rev = d.revision,
            frames = e.stats.frames,
            ms: number[] = [];
          let prev = 0;
          await new Promise<void>((res) => {
            function f(t: number) {
              if (prev) ms.push(t - prev);
              prev = t;
              if (ms.length === 180) res();
              else requestAnimationFrame(f);
            }
            requestAnimationFrame(f);
          });
          const fps = 180000 / ms.reduce((a, b) => a + b, 0);
          ms.sort((a, b) => a - b);
          return {
            fps,
            p95: ms[170],
            p99: ms[178],
            longest: ms[179],
            scale: e.stats.renderScale,
            frames: e.stats.frames - frames,
            backend: e.backend,
            size: [e.canvas.width, e.canvas.height],
            revisions: d.revision - rev,
          };
        });
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, backend + '-' + tier + '.json'), JSON.stringify(data, null, 2));
        expect(data.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
        expect(data.size).toEqual([1920, 1080]);
        expect(log.errors).toEqual([]);
        expect(data.revisions).toBeGreaterThan(20);
        expect(data.frames).toBeGreaterThanOrEqual(175);
        expect(data.fps).toBeGreaterThanOrEqual(58);
        expect(data.p95).toBeLessThanOrEqual(18.5);
      });
  }
