import { expect, test } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' cloud transmittance stays stable in a held shot and a moving bank', async ({ page }) => {
    await page.setViewportSize({width: 768, height: 480});
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: {weather} } = (window as any).lumina;
      const T = (window as any).THREE;
      engine.stop(); engine.paused = true;
      engine.trauma.restore(engine.camera); engine.trauma.trauma = engine.trauma.rumble = 0;
      engine.onUpdate = engine.onBeforeRender = undefined;
      Object.assign(weather.params, {cloudBase: 850, cloudTop: 2500, coverage: 0.55,
        cloudDensity: 0.95, cloudScale: 0.87, convection: 0.42, storm: 0.07, rain: 0, sunElevation: 5});
      if (weather.upperClouds) weather.upperClouds.coverage = 0;
      weather.cloudUniforms.offset.value.set(0, 0, 0);
      const camera = engine.camera;
      const forward = new T.Vector3(0.13, 0.27, -1).normalize();
      const lookAt = new T.Vector3();
      let stamp = performance.now(), shiftX = 0, shiftZ = 0;
      function draw(i: number) {
        camera.position.set(8100 + shiftX + i * 2.2, 315, 9100 + shiftZ - i * 3.5);
        camera.up.set(0, 1, 0); camera.lookAt(lookAt.copy(camera.position).add(forward));
        camera.rotateZ(i * 0.005); camera.fov = 49; camera.updateProjectionMatrix();
        engine.tick(stamp += 1000 / 60);
      }
      async function transmission() {
        const target = weather.cloudTargets[weather.cloudIndex];
        const width = 256, height = 144;
        const bytes = await engine.renderer.readRenderTargetPixelsAsync(target,
          Math.floor((target.width - width) / 2), Math.floor((target.height - height) / 2), width, height);
        return Float32Array.from({length:width * height}, (_, i) => T.DataUtils.fromHalfFloat(bytes[i * 4 + 3]));
      }
      const steps = weather.cloudUniforms.steps;
      async function reference(pose: number) {
        const count = steps.value;
        steps.value = 144;
        let mean: Float32Array;
        for (let i = 0; i < 4; i++) {
          weather.resetCloudHistory(); draw(pose);
          const sample = await transmission();
          if (i === 0) mean = new Float32Array(sample.length);
          for (let k = 0; k < sample.length; k++) mean![k] += sample[k] / 4;
        }
        steps.value = count;
        return mean!;
      }
      function error(sample: Float32Array, truth: Float32Array) {
        let sum = 0;
        for (let i = 0; i < sample.length; i++) sum += (sample[i] - truth[i]) ** 2;
        return Math.sqrt(sum / sample.length);
      }
      weather.resetCloudHistory();
      for (let i = 0; i < 32; i++) draw(0);
      let previous = await transmission(), variation = 0;
      for (let i = 0; i < 8; i++) {
        draw(0);
        const sample = await transmission();
        variation += error(sample, previous) / 8;
        previous = sample;
      }
      const fixedReference = await reference(0);
      const fixedError = error(previous, fixedReference);
      const fixedBias = previous.reduce((sum,v,i) => sum + v - fixedReference[i], 0) / previous.length;

      // Measure the dome's reconstruction on the first frame following a cut.
      // R reads the displayed cloud and G reads the original single ray.
      const target = weather.cloudTargets[weather.cloudIndex];
      const rt = new T.RenderTarget(target.width, target.height, {type: T.FloatType, depthBuffer: false});
      const mat = new T.NodeMaterial(), tsl = T.TSL, st = tsl.uv();
      const ray = weather.uCloudInvVP.mul(tsl.vec4(st.mul(2).sub(1), 0.5, 1)).xyz.normalize();
      mat.fragmentNode = tsl.vec4(weather.visibleCloud(ray).a, weather.cloudCurrent.sample(st).level(0).a, 0, 1);
      const quad = new T.QuadMesh(mat), renderer = engine.renderer;
      async function firstFrame(pose: number) {
        weather.resetCloudHistory(); draw(pose);
        const prior = renderer.getRenderTarget();
        renderer.setRenderTarget(rt); quad.render(renderer); renderer.setRenderTarget(prior);
        return await renderer.readRenderTargetPixelsAsync(rt, Math.floor((rt.width - 256) / 2),
          Math.floor((rt.height - 144) / 2), 256, 144);
      }
      let firstRaw = 0, firstResolved = 0;
      try {
        const cut = await firstFrame(0), count = steps.value;
        steps.value = 144;
        const truth = new Float32Array(cut.length / 4);
        for (let i = 0; i < 4; i++) {
          const ref = await firstFrame(0);
          for (let k = 0; k < truth.length; k++) truth[k] += ref[k*4+1] / 4;
        }
        steps.value = count;
        for (let k = 0; k < truth.length; k++) {
          firstResolved += (cut[k*4] - truth[k]) ** 2;
          firstRaw += (cut[k*4+1] - truth[k]) ** 2;
        }
        firstResolved = Math.sqrt(firstResolved / truth.length); firstRaw = Math.sqrt(firstRaw / truth.length);
      } finally { mat.dispose(); rt.dispose(); }
      let clear = 0, dense = 0;
      for (const t of fixedReference) { if (t > 0.85) clear++; if (t < 0.35) dense++; }
      weather.resetCloudHistory();
      for (let i = 0; i < 12; i++) draw(0);
      for (let i = 1; i <= 24; i++) draw(i);
      const bank = await transmission();
      const bankError = error(bank, await reference(24));
      weather.params.coverage = 0; draw(24);
      const cleared = await transmission();
      // Follow a translating upper deck. Moving the noise coordinates oppositely
      // keeps all of its physical features at the same bearing from the camera.
      Object.assign(weather.params, {cloudBase: 400, cloudTop: 800});
      Object.assign(weather.upperClouds, {base: 850, top: 2500, density: 0.95, coverage: 0.55,
        scale: 0.87, convection: 0.42, storm: 0.07, windX: 0, windZ: 0});
      const offset = weather.upperModel.uniforms.offset.value;
      offset.set(0, 0, 0);
      for (let i = 0; i < 32; i++) draw(0);
      const upper = await transmission();
      shiftX = 180; shiftZ = 120; offset.set(-shiftX, 0, -shiftZ); draw(0);
      const advected = error(upper, await transmission());
      for (let i = 0; i < 8; i++) { weather.upperClouds.coverage += 0.001; draw(0); }
      const retainedOnFade = weather.cloudSamples;
      return {variation, fixedError, bankError, firstRaw, firstResolved, fixedBias, clear, dense, advected,
        upperRange: Math.max(...upper) - Math.min(...upper), retainedOnFade, clearedMin: Math.min(...cleared)};
    });
    console.log(backend, 'cloud history', result);
    expect(result.clear).toBeGreaterThan(500);
    expect(result.dense).toBeGreaterThan(500);
    expect(result.variation).toBeLessThan(0.035);
    expect(result.fixedError).toBeLessThan(0.065);
    expect(result.bankError).toBeLessThan(0.08);
    expect(result.firstResolved).toBeLessThan(result.firstRaw * 0.85);
    expect(result.clearedMin).toBe(1);
    expect(result.upperRange).toBeGreaterThan(0.75);
    expect(result.advected).toBeLessThan(0.035);
    expect(result.retainedOnFade).toBe(10);
    expect(log.errors).toEqual([]);
  });
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' a mirror samples the visible cloud bank and retains the off-camera sky after a cut', async ({page}) => {
    await openScene(page, 'jet', 'high', backend);
    const log = watchConsole(page);
    const result = await page.evaluate(async () => {
      const {engine, scene:{weather}} = (window as any).lumina, T = (window as any).THREE;
      engine.stop(); engine.paused = true;
      engine.trauma.restore(engine.camera); engine.trauma.trauma = engine.trauma.rumble = 0; engine.onUpdate = engine.onBeforeRender = undefined;
      Object.assign(weather.params, {cloudBase:850, cloudTop:2500, coverage:.55, cloudScale:.87,
        convection:.42, cloudDensity:.95, storm:.07, rain:0, sunElevation:5});
      weather.upperClouds.coverage = 0;
      weather.cloudUniforms.offset.value.set(0,0,0);
      engine.camera.fov = 60; engine.camera.zoom = 1; engine.camera.updateProjectionMatrix();
      engine.camera.position.set(8100,315,9100);
      engine.camera.lookAt(8113,342,9000);
      let stamp = performance.now();
      function frame() { engine.tick(stamp += 1000/60); }
      for (let i=0;i<28;i++) frame();
      weather.reflectionAge = Infinity; frame();
      const tsl = T.TSL, size = tsl.vec2(weather.envTarget.width, weather.envTarget.height);
      // Use exact environment texel centres to avoid angular interpolation error.
      const region = tsl.uv().mul(tsl.vec2(.075,.085)).add(tsl.vec2(.232,.544));
      const angles = region.mul(size).floor().add(.5).div(size).sub(.5).mul(tsl.vec2(2*Math.PI, Math.PI));
      const dir = tsl.vec3(angles.x.cos().mul(angles.y.cos()), angles.y.sin(), angles.x.sin().mul(angles.y.cos()));
      const sky = weather.skyColor(dir);
      const background = sky.add(weather.solarAureole(dir)).add(weather.lunarDisc(dir,true));
      const visible = weather.visibleCloud(dir), direct = weather.renderDecks(weather.cloudEye,dir,sky,tsl.float(.5),weather.cloudUniforms.envSteps);
      const composite = (cloud:any) => background.r.mul(cloud.a).add(cloud.r);
      const m = new T.NodeMaterial();
      m.fragmentNode = tsl.vec4(weather.reflection(dir,0).r, composite(visible), composite(direct), 1);
      const quad = new T.QuadMesh(m), target = new T.RenderTarget(40,24,{type:T.FloatType,depthBuffer:false});
      const renderer = engine.renderer;
      async function compare() {
        const saved = renderer.getRenderTarget();
        renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(saved);
        const rgb = await renderer.readRenderTargetPixelsAsync(target,0,0,40,24);
        let view = 0, march = 0, count = 0;
        for (let i=0;i<rgb.length;i+=4) {
          view += Math.abs(rgb[i]-rgb[i+1]); march += Math.abs(rgb[i]-rgb[i+2]); count++;
        }
        return {view:view/count,march:march/count};
      }
      try {
        const front = await compare();
        engine.camera.lookAt(8087,342,9200); frame();
        return {front, rear:await compare()};
      } finally {target.dispose(); m.dispose();}
    });
    console.log(backend,'mirror cloud radiance',result);
    expect(result.front.view).toBeLessThan(.003);
    expect(result.front.view).toBeLessThan(result.front.march*.15);
    expect(result.rear.march).toBeLessThan(.003);
    expect(log.errors).toEqual([]);
  });
}
