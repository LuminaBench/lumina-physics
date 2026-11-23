import { expect, test } from '@playwright/test';
import * as THREE from 'three/webgpu';
import { RainShelters } from '../engine/rain-shelters';
import { openScene, watchConsole } from './helpers';

test('roof exposure follows the rain direction and preserves the drying history of the ground', () => {
  const roofs = new RainShelters();
  try {
    const cover = { center: new THREE.Vector3(0, 4, 0), width: 8, depth: 4, yaw: Math.PI / 2, groundY: 0 };
    const remove = roofs.add({ ...cover, initialWetness: 0.7 });
    expect(roofs.exposureAt(0, 0, 3)).toBe(0);
    expect(roofs.exposureAt(3, 0, 0)).toBe(1);
    expect(roofs.exposureAt(0, 4.1, 0)).toBe(1);
    expect(roofs.exposureAt(0, 0, 0, 2, 1, 0)).toBe(1);
    expect(roofs.filmAt(0, 0, 0, 1)).toBeCloseTo(0.7);
    roofs.update(4, 0, 0, 1, 0.025);
    expect(roofs.filmAt(0, 0, 0, 1)).toBeCloseTo(0.6);
    roofs.update(1, 22, 0, 1, 0.025);
    const rewetted = roofs.filmAt(0, 0, 0, 1);
    expect(rewetted).toBeGreaterThan(0.6);
    expect(rewetted).toBeLessThan(0.85);
    roofs.update(30,22,0,0,0.04);
    roofs.update(0.5,0,0,1,0.04);
    expect(roofs.filmAt(0,0,0,1)).toBe(0);
    expect(roofs.filmAt(0, 4.2, 0, 1)).toBe(1);
    const second = roofs.add({ ...cover, center: new THREE.Vector3(9, 4, 0) });
    remove();
    remove();
    expect(roofs.count).toBe(1);
    expect(roofs.exposureAt(9, 0, 0, 0, 1, 0)).toBe(0);
    roofs.clear();
    const replacement = roofs.add(cover);
    second();
    expect(roofs.count).toBe(1);
    replacement();
    expect(roofs.count).toBe(0);
    expect(() => roofs.add({ ...cover, depth: 0 })).toThrow();
  } finally {
    roofs.dispose();
  }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(
    backend + ' covered pavement keeps pooled water, masks rain, and sees the sky through an open side',
    async ({ page }) => {
      const log = watchConsole(page);
      await openScene(page, 'highway', 'high', backend);
      const sample = await page.evaluate(async () => {
        const { engine: e, scene: s } = (window as any).lumina,
          T = (window as any).THREE,
          t = T.TSL;
        e.stop();
        e.world.shelters.clear();
        const covers = e.world.shelters;
        const center = new T.Vector3(-2.75, 4, 85);
        const release = covers.add({ center, width: 12, depth: 8, yaw: 0.26, groundY: 0, underside: 0x376194 });
        e.wind.set(0, 0, 0);
        e.world.surfaceWetness=1; e.world.rainfall=1; e.world.update(0);
        s.road.params.flood = 0.65;
        s.road.params.wetness = 1;
        const point = t.uniform(new T.Vector3(-2.75, 0.04, 85)),
          direction = t.uniform(new T.Vector3(0, 1, 0));
        const cover = covers.rayNode(point, direction),
          ground = covers.groundNode(point, t.float(1));
        const mat = new T.NodeMaterial();
        mat.fragmentNode = t.vec4(cover.a, ground.x, ground.y, e.world.scalarNode(point).z);
        const geo = new T.PlaneGeometry(2, 2),
          mesh = new T.Mesh(geo, mat),
          scene = new T.Scene();
        scene.add(mesh);
        const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 5);
        cam.position.z = 1;
        cam.lookAt(0, 0, 0);
        const r = e.renderer,
          prev = r.getRenderTarget(),
          target = new T.RenderTarget(1, 1, { type: T.FloatType });
        async function read() {
          r.setRenderTarget(target);
          r.render(scene, cam);
          r.setRenderTarget(prev);
          return Array.from(await r.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)) as number[];
        }
        try {
          const roof = await read(),
            dry = s.road.liquidWetnessAt(-2.75, 85),
            water = s.road.puddleDepth(-2.75, 85);
          direction.value.set(0, 0.12, 1).normalize();
          const opening = await read();
          point.value.set(-2.75, 5, 85);
          const above = await read();
          point.value.set(-2.75, 0, 120);
          const street = await read();
          e.camera.position.set(-2.75, 1, 85);
          s.rain.intensityOverride = 1;
          s.rain.update(0);
          const shelteredLens = e.lens.rain;
          e.camera.position.z = 120;
          s.rain.update(0);
          const openLens = e.lens.rain;
          covers.update(1, 32, 0, 1, 0.018);
          point.value.set(-2.75, 0.04, 85);
          const humid = await read(),
            cpu = s.road.liquidWetnessAt(-2.75, 85);
          release();
          const released = await read();
          // Register the far roof first. At the near eave the far roof still fills the ray.
          direction.value.set(0, 1, 0);
          point.value.set(0, 0, 0);
          const far = covers.add({
            center: new T.Vector3(0, 7, 0),
            width: 10,
            depth: 10,
            groundY: 0,
            underside: 0x0000ff,
          });
          const near = covers.add({
            center: new T.Vector3(-2, 3, 0),
            width: 4,
            depth: 8,
            groundY: 0,
            underside: 0xff0000,
          });
          const layers = new T.NodeMaterial();
          layers.fragmentNode = covers.rayNode(point, direction, t.float(0.1));
          let stacked;
          try {
            mesh.material = layers;
            stacked = await read();
          } finally {
            mesh.material = mat;
            layers.dispose();
            near();
            far();
          }
          return {
            roof,
            opening,
            above,
            street,
            dry,
            water,
            shelteredLens,
            openLens,
            humid,
            cpu,
            released,
            stacked,
          };
        } finally {
          r.setRenderTarget(prev);
          release();
          target.dispose();
          mat.dispose();
          geo.dispose();
        }
      });
      expect(sample.roof[0]).toBeCloseTo(1);
      expect(sample.roof[1]).toBeCloseTo(0);
      expect(sample.roof[3]).toBeCloseTo(0);
      expect(sample.street[3]).toBeCloseTo(1);
      expect(sample.roof[2]).toBeGreaterThan(0.1);
      expect(sample.roof[2]).toBeLessThan(0.75);
      expect(sample.opening[0]).toBeCloseTo(0);
      expect(sample.opening[1]).toBeCloseTo(sample.roof[1]);
      expect(sample.above[1]).toBeCloseTo(1);
      expect(sample.street[1]).toBeCloseTo(1);
      expect(sample.dry).toBe(0);
      expect(sample.water).toBeGreaterThan(0.01);
      expect(sample.shelteredLens).toBe(0);
      expect(sample.openLens).toBeGreaterThan(0.1);
      expect(sample.cpu).toBeGreaterThan(0.2);
      expect(Math.abs(sample.humid[1] - sample.cpu)).toBeLessThan(0.005);
      expect(sample.released[1]).toBeCloseTo(1);
      expect(sample.stacked[0]).toBeCloseTo(0.5);
      expect(sample.stacked[2]).toBeCloseTo(0.5);
      expect(sample.stacked[3]).toBeCloseTo(1);
      expect(log.errors).toEqual([]);
    },
  );
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(
    backend + ' the finished puddle reflects the underside only when the mirror ray reaches it',
    async ({ page }) => {
      const log = watchConsole(page);
      await openScene(page, 'highway', 'low', backend);
      const pixels = await page.evaluate(async () => {
        const T = (window as any).THREE,
          {
            engine,
            scene: { road, weather },
          } = (window as any).lumina;
        engine.stop();
        engine.world.shelters.clear();
        road.params.flood = 0.85;
        road.params.wetness = 1;
        road.params.rain = 0;
        road.vehicleLighting = false;
        road.update(0);
        weather.localProbe.enabled = false;
        weather.localProbe.update(engine.renderer, engine.scene, 0);
        const scene = new T.Scene();
        const mesh = road.mesh.clone();
        // Read the production colour shader into one linear target. The main
        // pass also writes normals and motion, which this target does not own.
        mesh.material = road.mesh.material.clone();
        mesh.material.mrtNode = null;
        scene.add(mesh);
        const camera = new T.PerspectiveCamera(18, 1, 0.05, 80);
        camera.position.set(-2.75, 1.6, 90);
        camera.lookAt(-2.75, road.waterLine, 85);
        const r = engine.renderer,
          prior = r.getRenderTarget(),
          target = new T.RenderTarget(33, 33, { type: T.FloatType });
        const center = new T.Vector3(-2.75, 3.5, 85);
        async function pixel(depth: number, tint: number) {
          const release = engine.world.shelters.add({ center, width: 24, depth, groundY: 0, underside: tint });
          try {
            r.setRenderTarget(target);
            r.render(scene, camera);
            r.setRenderTarget(prior);
            const rgba = await r.readRenderTargetPixelsAsync(target, 15, 15, 3, 3);
            let red = 0,
              blue = 0;
            for (let i = 0; i < rgba.length; i += 4) {
              red += rgba[i];
              blue += rgba[i + 2];
            }
            return { red: red / 9, blue: blue / 9 };
          } finally {
            release();
          }
        }
        try {
          return {
            red: await pixel(50, 0xff0000),
            blue: await pixel(50, 0x0000ff),
            openRed: await pixel(3, 0xff0000),
            openBlue: await pixel(3, 0x0000ff),
          };
        } finally {
          r.setRenderTarget(prior);
          target.dispose();
          scene.remove(mesh);
          mesh.material.dispose();
        }
      });
      expect(pixels.red.red).toBeGreaterThan(pixels.blue.red + 0.002);
      expect(pixels.blue.blue).toBeGreaterThan(pixels.red.blue + 0.002);
      expect(pixels.openRed.red).toBeCloseTo(pixels.openBlue.red, 4);
      expect(pixels.openRed.blue).toBeCloseTo(pixels.openBlue.blue, 4);
      expect(log.errors).toEqual([]);
    },
  );
}
