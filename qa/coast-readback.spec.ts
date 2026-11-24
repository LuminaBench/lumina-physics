import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'])
  for (const shore of ['atlantic', 'volcanic'])
    test(backend + ' ' + shore + ' coastal swash and weather map match game queries', async ({ page }) => {
      const log = watchConsole(page);
      await page.goto(
        '/coast.html?shore=' +
          shore +
          '&view=walk&tier=high&backend=' +
          (backend === 'webgl2' ? 'webgl' : 'webgpu'),
      );
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 3);
      const report = await page.evaluate(async (shore) => {
        const { world: w } = (window as any).coastDemo,
          T = (window as any).THREE,
          t = T.TSL,
          e = w.engine,
          renderer = e.renderer;
        e.stop();
        const width = 192,
          locations = new Float32Array(width * 4),
          out = new T.Vector4();
        for (let i = 0; i < width; i++) {
          const s = w.coast.point(
            w.coast.length * (0.3 + 0.48 * (((i * 37) % width) / width)),
            -29 + 57 * (i / width),
          );
          if (shore === 'atlantic' && (i & 1) === 0) {
            const middle = (window as any).coastDemo.prints[1];
            s.x = middle.x + ((i % 24) / 23 - 0.5) * 2.9;
            s.z = middle.z + (Math.floor(i / 24) / 7 - 0.5) * 2.9;
          }
          locations[i * 4] = s.x;
          locations[i * 4 + 1] = s.z;
          locations[i * 4 + 2] = w.ground(s.x, s.z);
        }
        const positions = new T.DataTexture(locations, width, 1, T.RGBAFormat, T.FloatType);
        positions.minFilter = positions.magFilter = T.NearestFilter;
        positions.needsUpdate = true;
        const pos = t.texture(positions, t.uv()).level(0),
          time = t.uniform(0),
          level = t.uniform(0);
        const wave = w.surf.node(pos.xy, level.sub(pos.z), time, t.float(0.61), level);
        const material = new T.NodeMaterial(),
          weather = w.front.mapNode(pos.xy, time);
        material.fragmentNode = t.vec4(
          wave.x,
          weather.r,
          weather.g,
          w.front.coverageNode(pos.xy, time, true),
        );
        const quad = new T.QuadMesh(material),
          dst = new T.RenderTarget(width, 1, { type: T.FloatType, depthBuffer: false }),
          saved = renderer.getRenderTarget();
        let waveMax = 0,
          weatherMax = 0,
          crossings = 0,
          wet = 0,
          dry = 0,
          n = 0;
        try {
          for (const tide of [-0.12, 0.18])
            for (const stamp of [0, 2.05, 4.1, 6.15]) {
              level.value = tide;
              time.value = stamp;
              renderer.setRenderTarget(dst);
              quad.render(renderer);
              renderer.setRenderTarget(saved);
              const pixels = await renderer.readRenderTargetPixelsAsync(dst, 0, 0, width, 1);
              for (let i = 0; i < width; i++) {
                const k = i * 4,
                  x = locations[k],
                  z = locations[k + 1],
                  depth = tide - locations[k + 2];
                const offset = w.surf.offset(x, z, depth, stamp, 0.61, tide),
                  f = w.front.sample(x, z, stamp);
                waveMax = Math.max(waveMax, Math.abs(offset - pixels[k]));
                weatherMax = Math.max(
                  weatherMax,
                  Math.abs(f.coverage - pixels[k + 1]),
                  Math.abs(f.rain - pixels[k + 2]),
                  Math.abs(f.ice - pixels[k + 3]),
                );
                if (Math.abs(depth + offset) > 0.01 && depth + offset > 0 !== depth + pixels[k] > 0)
                  crossings++;
                if (depth + offset > 0) wet++;
                else dry++;
                w.surf.read(x, z, out);
                n++;
              }
            }
        } finally {
          renderer.setRenderTarget(saved);
          dst.dispose();
          positions.dispose();
          material.dispose();
        }
        return { backend: e.backend, waveMax, weatherMax, crossings, wet, dry, n };
      }, shore);
      console.log('Shore and weather readback', report);
      expect(report.backend).toBe(backend);
      expect(report.n).toBe(1536);
      expect(report.wet).toBeGreaterThan(100);
      expect(report.dry).toBeGreaterThan(100);
      expect(report.crossings).toBe(0);
      expect(report.waveMax).toBeLessThan(0.012);
      expect(report.weatherMax).toBeLessThan(0.006);
      expect(log.errors).toEqual([]);
    });

for (const backend of ['webgpu', 'webgl2']) {
  test(
    backend + ' Atlantic replay fills three real prints at two tides and keeps the lee side of the stone',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto(
        '/coast.html?view=walk&shore=atlantic&tier=high&backend=' +
          (backend === 'webgl2' ? 'webgl' : 'webgpu'),
      );
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const records = await page.evaluate(() => {
        const d = (window as any).coastDemo,
          w = d.world,
          T = (window as any).THREE;
        w.engine.stop();
        const p = d.prints,
          focus = p[0].clone().lerp(p[2], 0.5),
          middle = p[1],
          site = w.coast.project(middle.x, middle.z),
          along = new T.Vector3(site.tangentX, 0, site.tangentZ);
        const points = [
          ...p,
          middle.clone().addScaledVector(along, 0.052),
          middle.clone().addScaledVector(along, -0.052),
        ];
        return [0.1, 0.16].map((range) => {
          d.reset(true);
          const relief = () => points.map((pt) => w.sediment.inspect(pt.x, pt.z).relief);
          const initial = relief(),
            peak = points.map(() => 0);
          for (let i = 1; i <= 240; i++) {
            w.sediment.update(
              1 / 12,
              focus.x,
              focus.z,
              range * Math.sin(((i / 12) * Math.PI * 2) / 190),
              w.ocean.optics.breakerHeight,
            );
            points.forEach((pt, k) => {
              peak[k] = Math.max(peak[k], w.sediment.inspect(pt.x, pt.z).water);
            });
          }
          const final = relief(),
            saved = w.sediment.save();
          w.sediment.update(0.25, focus.x + 55, focus.z + 16, 0, w.ocean.optics.breakerHeight);
          w.sediment.restore(saved);
          w.sand.update(focus.x, focus.z, true);
          return { range, initial, final, peak, restored: relief() };
        });
      });
      for (const r of records) {
        expect(r.peak[0]).toBeGreaterThan(0.14);
        expect(r.peak[1]).toBeGreaterThan(0.02);
        expect(r.peak[2]).toBeLessThan(0.002);
        const depth = r.final.map((v: number, i: number) => v / r.initial[i]);
        expect(depth[0]).toBeLessThan(0.2);
        expect(depth[1]).toBeGreaterThan(0.28);
        expect(depth[1]).toBeLessThan(0.84);
        expect(depth[2]).toBeCloseTo(1, 3);
        expect(depth[3]).toBeGreaterThan(depth[4] + 0.15);
        for (let i = 0; i < r.final.length; i++)
          expect(Math.abs(r.final[i] - r.restored[i])).toBeLessThan(0.00051);
      }
      console.log('Atlantic three-print and rock replay', backend, JSON.stringify(records));
      expect(log.errors).toEqual([]);
    },
  );
}
