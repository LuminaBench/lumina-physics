import { expect, test } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' gravel tires eject stones while water binds the fine dust', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'playground', 'high', backend);
    const result = await page.evaluate(() => {
      const { engine, scene } = (window as any).lumina;
      engine.stop();
      scene.setGround('gravel');
      const { ground } = scene;
      const center = ground.center;
      let dust = 0, stones = 0, velocity = 0;
      ground.clumps.emit = (p: any) => { stones += p.count; velocity = p.velocity.z; };
      scene.fx.dust.emit = (p: any) => { dust += p.count; };
      engine.world.surfaceWetness = 0;
      const pass = (id: string, speed: number, x: number, depth: number) => {
        stones = dust = velocity = 0;
        for (let i = 0; i < 30; i++)
          ground.track(id, x, center.y + Math.sign(speed) * i * 0.2, 0.2, depth, speed, { x: 0, z: 1 });
        return { stones, dust, velocity };
      };
      const dry = pass('dry', 14, center.x, 0.8);
      // Reuse a real game source type via the fire module so the production build
      // and development runner exercise the same bus, without loading TS at runtime.
      const local = scene.explosions.thermalPulse;
      local.at(center.x, ground.surfaceY, center.y);
      local.end.z += 6; local.radius = 1.5; local.wetness = 1;
      engine.world.publish(local, 4);
      const sprayed = pass('local-spray', 14, center.x, 0.8);
      const unsprayed = pass('adjacent-lane', 14, center.x + 4, 0.8);
      engine.world.removeSource(local);
      engine.world.surfaceWetness = 1;
      const soaked = pass('soaked', -14, center.x + 1, 0.8);
      const airborne = pass('lift', 14, center.x, 0);
      const outside = pass('outside', 14, center.x + ground.size, 1);
      engine.world.surfaceWetness = 1;
      ground.wetness = 0;
      const T = (window as any).THREE;
      const release = engine.world.shelters.add({center:new T.Vector3(center.x,ground.surfaceY+4,center.y),
        width:4,depth:18,groundY:ground.surfaceY});
      const dryUnderRoof = ground.wetnessAt(center.x,center.y);
      const outsideRoof = ground.wetnessAt(center.x+6,center.y);
      release();
      return { dry, sprayed, unsprayed, soaked, airborne, outside, dryUnderRoof, outsideRoof };
    });
    expect(result.dry.stones).toBeGreaterThan(0);
    expect(result.dry.dust).toBeGreaterThan(0);
    expect(result.dry.velocity).toBeLessThan(0);
    expect(result.sprayed.dust).toBe(0);
    expect(result.sprayed.stones).toBe(result.dry.stones);
    expect(result.unsprayed.dust).toBe(result.dry.dust);
    expect(result.soaked.stones).toBe(result.dry.stones);
    expect(result.soaked.dust).toBe(0);
    expect(result.soaked.velocity).toBeGreaterThan(0);
    expect(result.airborne.stones + result.outside.stones).toBe(0);
    expect(result.dryUnderRoof).toBe(0); expect(result.outsideRoof).toBe(1);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' cloud convection changes upper-cell density for gameplay and shading', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene } = (window as any).lumina;
      const T = (window as any).THREE;
      engine.stop();
      const weather = scene.weather;
      Object.assign(weather.params, { coverage: 1, cloudDensity: 1, storm: 0, convection: 1 });
      weather.update(0);
      const y = weather.params.cloudBase + 0.52 * (weather.params.cloudTop - weather.params.cloudBase);
      const pos = new T.Vector3(0, y, 0), best = pos.clone();
      let peak = 0;
      for (let z = -10000; z <= 10000; z += 400) for (let x = -10000; x <= 10000; x += 400) {
        pos.set(x, y, z);
        const density = weather.sampleCloudDensity(pos);
        if (density > peak) { peak = density; best.copy(pos); }
      }
      const mat = new T.NodeMaterial();
      mat.fragmentNode = T.TSL.vec4(weather.cloudDensityNode(T.TSL.uniform(best), false), 0, 0, 1);
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const quad = new T.QuadMesh(mat), renderer = engine.renderer, previous = renderer.getRenderTarget();
      async function read() {
        renderer.setRenderTarget(target);
        quad.render(renderer);
        renderer.setRenderTarget(previous);
        return (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1))[0];
      }
      try {
        const tall = await read();
        weather.params.convection = -1;
        weather.update(0);
        return { peak, tall, shallowCPU: weather.sampleCloudDensity(best), shallowGPU: await read() };
      } finally {
        renderer.setRenderTarget(previous);
        target.dispose(); mat.dispose();
      }
    });
    expect(result.peak).toBeGreaterThan(0.1);
    expect(result.tall).toBeGreaterThan(0.1);
    expect(result.shallowCPU).toBe(0);
    expect(result.shallowGPU).toBeCloseTo(0, 5);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' aerial cloud deck covers distant ground while nearby geometry stays clear', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const samples = await page.evaluate(async () => {
      const { engine, scene } = (window as any).lumina, T = (window as any).THREE, n = T.TSL;
      const camera = engine.camera, weather = scene.weather;
      Object.assign(weather.params, { cloudBase: 650, cloudTop: 1800, coverage: 1, convection: 0.7, cloudDensity: 1.4 });
      engine.onBeforeRender = () => {
        camera.position.set(-1200, 2200, 0);
        camera.lookAt(-1210, 0, 250);
      };
      const start = engine.stats.frames;
      await new Promise<void>(resolve => {
        const tick = () => engine.stats.frames >= start + 22 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      });
      engine.stop();
      const depthAt = (distance: number) => {
        const clip = new T.Vector4(0, 0, -distance, 1).applyMatrix4(camera.projectionMatrix);
        const z = clip.z / clip.w;
        return camera.coordinateSystem === T.WebGLCoordinateSystem ? z * 0.5 + 0.5 : z;
      };
      // Both texels use the centre sightline and the production composition pass.
      // Place one dark object at aircraft distance, and the other below cloud base.
      const depth = n.uv().x.lessThan(0.5).select(n.float(depthAt(25)), n.float(depthAt(2600)));
      const effect = engine.pipeline.effects.find((e: any) => e.id === 'weather.cloud-immersion');
      const material = new T.NodeMaterial();
      material.fragmentNode = n.vec4(effect.scene({ color: n.vec3(0), depth: { sample: () => n.vec4(depth) },
        ndc: n.vec2(0), uv: n.vec2(0.5) }), 1);
      const target = new T.RenderTarget(2, 1, { type: T.FloatType, depthBuffer: false });
      const previous = engine.renderer.getRenderTarget();
      try {
        engine.renderer.setRenderTarget(target);
        new T.QuadMesh(material).render(engine.renderer);
        engine.renderer.setRenderTarget(previous);
        return Array.from(await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, 2, 1)) as number[];
      } finally {
        engine.renderer.setRenderTarget(previous); material.dispose(); target.dispose();
      }
    });
    expect(Math.max(...samples.slice(0, 3))).toBeLessThan(0.001);
    expect(Math.min(...samples.slice(4, 7))).toBeGreaterThan(0.08);
    expect(log.errors).toEqual([]);
  });
}
