import { expect, test } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' lower and upper cloud erosion preserve dense cores and agree with gameplay probes', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const result = await page.evaluate(async () => {
      const {engine, scene: {weather}} = (window as any).lumina;
      const T = (window as any).THREE, t = T.TSL;
      engine.stop(); engine.paused = true; engine.onUpdate = engine.onBeforeRender = undefined;
      engine.camera.position.set(8100, 315, 9100);
      Object.assign(weather.params, {coverage: .83, cloudDensity: 1, cloudBase: 600, cloudTop: 2500,
        cloudScale: 1, convection: .45, storm: .15});
      Object.assign(weather.upperClouds, {base: 3000, top: 4900, coverage: .83, density: 1, convection: .45,
        scale: 1, storm: .15, windX: 0, windZ: 0});
      const width = 128;
      const col = t.uv().x.mul(width).floor(), altitude = t.uniform(0);
      const point = t.vec3(col.mul(237).sub(14000), altitude, col.mul(379).sub(17000));
      // The analytic tier uses its existing planar weather map at the same bearings.
      const dir = t.vec3(col.mul(.051).cos(), .17, col.mul(.051).sin()).normalize();
      const m = new T.NodeMaterial();
      m.fragmentNode = t.vec4(weather.cloudDensityNode(point, false), weather.analyticCloudTransmittance(dir), 0, 1);
      const quad = new T.QuadMesh(m), target = new T.RenderTarget(width,1,{type:T.FloatType,depthBuffer:false});
      const renderer = engine.renderer, saved = renderer.getRenderTarget(), probe = new T.Vector3();
      let worst = 0, mean = 0, changed = 0, core = 0, analytic = 0, n = 0, stamp = performance.now();
      try {
        for (const upper of [false, true]) {
          altitude.value = upper ? 3500 : 1100;
          let baseline: Float32Array | undefined;
          for (const erosion of [0, 1]) {
            weather.params.cloudErosion = upper ? .62 : erosion;
            weather.upperClouds.erosion = upper ? erosion : .62;
            engine.tick(stamp += 1000 / 60);
            renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(saved);
            const sample = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, 1);
            for (let i = 0; i < width; i++) {
              probe.set(i*237-14000, altitude.value, i*379-17000);
              const error = Math.abs(weather.sampleCloudDensity(probe) - sample[4*i]);
              worst = Math.max(worst, error); mean += error; n++;
              if (baseline) {
                const original = baseline[4*i], eroded = sample[4*i];
                if (original-eroded > .06) changed++;
                if (original > 1.17 && Math.abs(original-eroded) < .006) core++;
              }
            }
            baseline = sample;
          }
        }
        // In broken sky measure one deck at a time so a second opaque deck
        // cannot mask the change in transmission through the first one.
        for (const upper of [false, true]) {
          weather.params.coverage = upper ? 0 : .46;
          weather.upperClouds.coverage = upper ? .46 : 0;
          let baseline: Float32Array | undefined;
          for (const erosion of [0, 1]) {
            weather.params.cloudErosion = weather.upperClouds.erosion = erosion;
            engine.tick(stamp += 1000 / 60);
            renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(saved);
            const sample = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, 1);
            if (baseline) for (let i = 0; i < width; i++) analytic += sample[4*i+1] - baseline[4*i+1];
            baseline = sample;
          }
        }
        return {worst, mean:mean/n, changed, core, analytic};
      } finally { renderer.setRenderTarget(saved); target.dispose(); m.dispose(); }
    });
    console.log(backend, 'cloud erosion and density interpolation', result);
    expect(result.mean).toBeLessThan(.012);
    expect(result.worst).toBeLessThan(.07);
    expect(result.changed).toBeGreaterThan(15);
    expect(result.core).toBeGreaterThan(5);
    expect(result.analytic).toBeGreaterThan(.1);
    expect(log.errors).toEqual([]);
  });
}
