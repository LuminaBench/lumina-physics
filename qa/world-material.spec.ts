import { test, expect } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(
    backend + ' ordinary PBR meshes acquire spatial wetness and preserve authored color nodes',
    async ({ page }) => {
      const log = watchConsole(page);
      await openScene(page, 'lagoon', 'low', backend);
      const readings = await page.evaluate(async () => {
        const w = window as any,
          T = w.THREE,
          e = w.lumina.engine,
          bus = e.world;
        e.stop();
        const scene = new T.Scene(),
          camera = new T.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
        camera.position.set(65000, 0, 4);
        camera.lookAt(65000, 0, 0);
        scene.add(new T.AmbientLight(0xffffff, 2));
        const ordinary = new T.MeshStandardMaterial({ color: 0xb7afa5, roughness: 0.7 });
        const authored = new T.MeshPhysicalNodeMaterial({ roughness: 0.73 });
        const graph = T.TSL.vec3(0.54, 0.42, 0.34);
        authored.colorNode = graph;
        const mesh = new T.Mesh(new T.PlaneGeometry(4, 2), ordinary);
        mesh.position.x = 65000;
        scene.add(mesh);
        const target = new T.RenderTarget(20, 4, { type: T.FloatType, depthBuffer: false });
        const renderer = e.renderer,
          prior = renderer.getRenderTarget(),
          rain = bus.surfaceWetness;
        const prototype = w.lumina.scene.rescue.rotor.source.constructor;
        const wet = new prototype().at(64999, 0, 0);
        wet.radius = 0.9;
        wet.wetness = 1;
        const colors = [] as number[][];
        async function draw(mat: any, local: boolean, global: number) {
          bus.surfaceWetness = global;
          if (local) bus.publish(wet, 10);
          else bus.removeSource(wet);
          bus.bindMaterials();
          mesh.material = mat;
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          renderer.setRenderTarget(prior);
          const p = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 20, 4);
          return [p[(2 * 20 + 5) * 4], p[(2 * 20 + 14) * 4]];
        }
        try {
          for (const mat of [ordinary, authored]) {
            const dry = await draw(mat, false, 0),
              local = await draw(mat, true, 0),
              rain = await draw(mat, false, 1);
            const release = bus.shelters.add({center:new T.Vector3(64999,2,0), width:1.4, depth:4,groundY:0});
            try {
              const roof = await draw(mat, false, 1), spray = await draw(mat,true,1);
              colors.push([...dry, ...local, ...rain, ...roof, ...spray]);
            } finally { release(); }
          }
          return { colors, authoredPreserved: authored.colorNode === graph };
        } finally {
          bus.removeSource(wet);
          bus.surfaceWetness = rain;
          bus.bindMaterials();
          renderer.setRenderTarget(prior);
          mesh.geometry.dispose();
          ordinary.dispose();
          authored.dispose();
          target.dispose();
        }
      });
      console.log(backend, 'dry, local and rain PBR samples', readings.colors);
      expect(log.errors).toEqual([]);
      expect(readings.authoredPreserved).toBe(true);
      for (const [dryLeft, dryRight, localLeft, localRight, globalLeft, globalRight, roofLeft, roofRight, sprayLeft] of readings.colors) {
        expect(dryLeft).toBeGreaterThan(0.12);
        expect(localLeft).toBeLessThan(dryLeft * 0.94);
        expect(localRight).toBeCloseTo(dryRight, 2);
        expect(globalLeft).toBeLessThan(dryLeft * 0.86);
        expect(globalRight).toBeLessThan(dryRight * 0.86);
        expect(roofLeft).toBeCloseTo(dryLeft,2);
        expect(roofRight).toBeCloseTo(globalRight,2);
        expect(sprayLeft).toBeLessThan(roofLeft * 0.94);
      }
      expect(log.errors).toEqual([]);
    }
  );
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' shader wind rolls around the swept flight axis', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'lagoon', 'low', backend);
    const samples = await page.evaluate(async () => {
      const { THREE: T, lumina } = window as any;
      const renderer = lumina.engine.renderer, bus = new lumina.engine.world.constructor();
      const Source = lumina.scene.rescue.rotor.source.constructor;
      const wake = new Source().at(-10, 5, 0);
      wake.end.x = 10; wake.radius = 4; wake.swirl = 8; wake.axialSwirl = true;
      bus.publish(wake);
      const point = T.TSL.uniform(new T.Vector3()), mat = new T.NodeMaterial();
      mat.fragmentNode = T.TSL.vec4(bus.localWindNode(point), 1);
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const quad = new T.QuadMesh(mat), prior = renderer.getRenderTarget();
      const samples: number[][] = [];
      try {
        for (const position of [[0, 5, 2], [0, 7, 0], [0, 5, 6]]) {
          point.value.fromArray(position);
          renderer.setRenderTarget(target);
          quad.render(renderer);
          renderer.setRenderTarget(prior);
          const pixel = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          samples.push(Array.from(pixel) as number[]);
        }
        return samples;
      } finally {
        renderer.setRenderTarget(prior); target.dispose(); mat.dispose();
      }
    });
    for (const [i, expected] of [[0, 4.5, 0], [0, 0, -4.5], [0, 0, 0]].entries()) {
      for (let j = 0; j < 3; j++) expect(samples[i][j]).toBeCloseTo(expected[j], 4);
    }
    expect(log.errors).toEqual([]);
  });
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' climate freezes deposited water, local heat thaws it and flight samples match the GPU', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'lagoon', 'low', backend);
    const result = await page.evaluate(async () => {
      const { THREE: T, lumina } = window as any;
      const e = lumina.engine, bus = e.world;
      e.stop();
      const point = T.TSL.uniform(new T.Vector3(65000, 6000, 0));
      const profile = { baseAltitude: 1000, topAltitude: 11000, baseTemperatureC: 30, topTemperatureC: -50,
        baseIceHumidity: 0.62, topIceHumidity: 1.24, surfaceHumidity: 0.45 };
      bus.setClimate(profile);
      const target = new T.RenderTarget(8, 4, { type: T.FloatType, depthBuffer: false });
      const scene = new T.Scene(), camera = new T.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
      camera.position.set(65000, 1000, 4); camera.lookAt(65000, 1000, 0);
      scene.add(new T.AmbientLight(0xffffff, 1));
      const mat = new T.MeshStandardMaterial({ color: 0x52332b, roughness: 0.55 });
      const mesh = new T.Mesh(new T.PlaneGeometry(4, 2), mat);
      mesh.position.set(65000, 1000, 0);
      scene.add(mesh);
      const prior = e.renderer.getRenderTarget(), probe = new T.NodeMaterial();
      const source = new lumina.scene.rescue.rotor.source.constructor().at(65000, 1000, 0);
      source.radius = 20; source.heat = 30;
      try {
        probe.fragmentNode = bus.scalarNode(point);
        e.renderer.setRenderTarget(target);
        new T.QuadMesh(probe).render(e.renderer);
        const scalar = await e.renderer.readRenderTargetPixelsAsync(target, 3, 1, 1, 1);
        const midpoint = [bus.airTemperatureAt(6000), scalar[1], bus.iceHumidityAt(6000)];
        async function pixel(wet: number) {
          bus.surfaceWetness = wet;
          bus.bindMaterials();
          e.renderer.setRenderTarget(target);
          e.renderer.render(scene, camera);
          return (await e.renderer.readRenderTargetPixelsAsync(target, 3, 1, 1, 1))[0] as number;
        }
        const dry = await pixel(0), wet = await pixel(1);
        bus.setClimate({ ...profile, baseTemperatureC: -12 });
        const dryCold = await pixel(0), frost = await pixel(1);
        bus.publish(source, 60);
        const thawed = await pixel(1);
        return { midpoint, dry, wet, dryCold, frost, thawed };
      } finally {
        e.renderer.setRenderTarget(prior);
        probe.dispose(); mat.dispose(); mesh.geometry.dispose(); target.dispose();
        bus.removeSource(source); bus.setClimate(); bus.surfaceWetness = 0; bus.bindMaterials();
      }
    });
    expect(result.midpoint[0]).toBe(-10);
    expect(result.midpoint[1]).toBeCloseTo(-10, 3);
    expect(result.midpoint[2]).toBeCloseTo(0.93, 5);
    expect(result.dryCold).toBeCloseTo(result.dry, 3);
    expect(result.wet).toBeLessThan(result.dry * 0.95);
    expect(result.frost).toBeGreaterThan(result.dry * 1.2);
    expect(result.thawed).toBeCloseTo(result.wet, 3);
    expect(log.errors).toEqual([]);
  });
}
