import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' a single recessed shop window lights the offscreen wet-road reflection after dusk',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=boulevard&view=walk&tier=high&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      await page.getByRole('slider', { name: /solar hour/i }).fill('20.75');
      await page.waitForFunction(() => (window as any).coastDemo.world.weather.params.sunElevation < -4);
      const result = await page.evaluate(async () => {
        const T = (window as any).THREE,
          { world, road } = (window as any).coastDemo;
        const engine = world.engine,
          scene = engine.scene,
          renderer = engine.renderer;
        engine.stop();
        const shops = road.shops,
          room = 13,
          source = shops.centers[room];
        const x = road.road.x - 1.15,
          z = road.road.z + 0.38;
        const point = new T.Vector3(x, road.heightAt(x, z), z);
        let pavementError = 0;
        for (const cross of [4.5, 5.85, 7.15, 9.85])
          for (const along of [-3.2, -0.7, 1.25, 5.5]) {
            const px = road.road.x + cross,
              pz = road.road.z + along,
              y = road.heightAt(px, pz);
            const ray = new engine.physics.RAPIER.Ray({ x: px, y: y + 0.4, z: pz }, { x: 0, y: -1, z: 0 });
            const hit = engine.physics.world.castRay(ray, 0.8, true);
            pavementError = Math.max(pavementError, hit ? Math.abs(hit.timeOfImpact - 0.4) : Infinity);
          }
        const pavement = road.root.getObjectByName('Cambered coastal road');
        const cast = new T.Raycaster(point.clone().add(new T.Vector3(0, 4, 0)), new T.Vector3(0, -1, 0));
        const normal = cast.intersectObject(pavement)[0].normal.normalize();
        const eye = point.clone().sub(source).normalize().reflect(normal);
        const camera = new T.PerspectiveCamera(8.5, 1.5, 0.03, 180);
        camera.position.copy(point).addScaledVector(eye, 2.25);
        camera.lookAt(point);
        camera.updateMatrixWorld();
        const sourceNdc = source.clone().project(camera);
        const visible = camera.clone();
        visible.fov = 12;
        visible.updateProjectionMatrix();
        visible.lookAt(source);
        visible.updateMatrixWorld();
        // The HDR measurement includes the real receivers, frames, light fixtures and
        // glazing. Fullscreen game effects belong to their normal multi-attachment pass.
        road.root.traverse((o: any) => o.layers.enable(29));
        scene.traverse((o: any) => {
          if (o.isLight) o.layers.enable(29);
        });
        camera.layers.set(29);
        visible.layers.set(29);
        const target = new T.RenderTarget(96, 64, { type: T.HalfFloatType });
        const oldTarget = renderer.getRenderTarget(),
          oldMrt = renderer.getMRT();
        const probe = world.weather.localProbe,
          original = road.drainage.save();
        const night = world.weather.params.sunElevation;
        async function photograph(on: number, view: any) {
          shops.setPower(room, on);
          for (let i = 0; i < 12; i++) probe.update(renderer, scene, 1);
          renderer.setRenderTarget(target);
          renderer.render(scene, view);
          renderer.setRenderTarget(oldTarget);
          const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 96, 64);
          return Float32Array.from(raw as Uint16Array, (v) => T.DataUtils.fromHalfFloat(v));
        }
        async function compare(view: any) {
          const off = await photograph(0, view),
            on = await photograph(1, view);
          let sum = 0,
            red = 0,
            blue = 0,
            peak = 0,
            count = 0;
          for (let y = 14; y < 50; y++)
            for (let x = 16; x < 80; x++) {
              const i = (y * 96 + x) * 4,
                r = on[i] - off[i],
                g = on[i + 1] - off[i + 1],
                b = on[i + 2] - off[i + 2];
              const light = r * 0.2126 + g * 0.7152 + b * 0.0722;
              sum += light;
              red += r;
              blue += b;
              peak = Math.max(peak, light);
              count++;
            }
          return { mean: sum / count, red: red / count, blue: blue / count, peak };
        }
        try {
          renderer.setMRT(null);
          const exterior = await compare(visible),
            wet = await compare(camera);
          const dryState = road.drainage.save();
          dryState.depths.fill(0);
          for (const key of Object.keys(dryState.budget)) dryState.budget[key] = 0;
          road.drainage.restore(dryState);
          const dry = await compare(camera);
          world.weather.params.sunElevation = 45;
          road.update(0, point);
          const day = await compare(visible);
          return {
            backend: engine.backend,
            sourceY: sourceNdc.y,
            pavementError,
            depth: original.budget.streetLitres,
            exterior,
            wet,
            dry,
            day,
          };
        } finally {
          renderer.setRenderTarget(oldTarget);
          renderer.setMRT(oldMrt);
          target.dispose();
          world.weather.params.sunElevation = night;
          road.drainage.restore(original);
        }
      });
      console.log(backend, result, log.errors);
      expect(log.errors).toEqual([]);
      expect(result.backend).toBe(backend === 'webgl' ? 'webgl2' : backend);
      expect(result.sourceY).toBeGreaterThan(1.5);
      expect(result.pavementError).toBeLessThan(0.01);
      expect(result.exterior.mean).toBeGreaterThan(0.04);
      expect(result.wet.mean).toBeGreaterThan(0.008);
      expect(result.wet.red).toBeGreaterThan(result.wet.blue * 1.4);
      expect(result.wet.mean).toBeGreaterThan(result.dry.mean * 2);
      expect(Math.abs(result.day.mean)).toBeLessThan(0.0005);
    },
  );
}
