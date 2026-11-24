import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'])
  test(backend + ' coastal swash and weather map match game queries', async ({ page }) => {
    const log = watchConsole(page);
    await page.goto(
      '/coast.html?shore=volcanic&view=walk&tier=high&backend=' + (backend === 'webgl2' ? 'webgl' : 'webgpu'),
    );
    await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 3);
    const report = await page.evaluate(async () => {
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
      material.fragmentNode = t.vec4(wave.x, weather.r, weather.g, w.front.coverageNode(pos.xy, time, true));
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
    });
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
