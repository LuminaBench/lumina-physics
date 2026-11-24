import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' uses the same focused shore triangles and advected cloud ages in game and shaders',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=cay&view=walk&tier=medium&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 4);
      const result = await page.evaluate(async () => {
        const { world: w } = (window as any).coastDemo,
          t3 = (window as any).THREE,
          t = t3.TSL;
        w.engine.stop();
        const grid = w.terrain.grid,
          front = w.front,
          n = 96,
          coords = new Float32Array(4 * n);
        const physics = w.engine.physics;
        let maxCollider = 0,
          maxAnalytic = 0,
          maxPhase = 0,
          maxHeight = 0,
          maxAdvected = 0;
        for (let i = 0; i < n; i++) {
          // Cross the old triangle corner and both sides of the inner-to-outer spacing transition.
          const tx = i < 32 ? -0.25 : i < 64 ? -grid.halfWidth : grid.halfWidth;
          const x = tx + Math.cos(i * 1.31) * 0.83,
            z = 1.82 + Math.sin(i * 0.77) * 1.6;
          const y = w.ground(x, z);
          coords.set([x, z, 19 + i * 1.7, 0], 4 * i);
          if (i < 32) maxAnalytic = Math.max(maxAnalytic, Math.abs(y - w.coast.height(x, z)));
          const ray = new physics.RAPIER.Ray({ x, y: y + 0.2, z }, { x: 0, y: -1, z: 0 });
          const hit = physics.world.castRay(ray, 0.4, true);
          if (!hit) throw Error('Missing shore collider');
          maxCollider = Math.max(maxCollider, Math.abs(0.2 - hit.timeOfImpact));
        }
        const tex = new t3.DataTexture(coords, n, 1, t3.RGBAFormat, t3.FloatType);
        tex.needsUpdate = true;
        const s = t.texture(tex, t.uv()).level(0),
          mat = new t3.NodeMaterial();
        mat.fragmentNode = t.vec4(
          w.bed.heightNode(s.xy),
          front.life.node(s.xy, s.z, false),
          front.life.node(s.xy, s.z, true),
          1,
        );
        const target = new t3.RenderTarget(n, 1, { type: t3.FloatType, depthBuffer: false }),
          quad = new t3.QuadMesh(mat);
        const renderer = w.engine.renderer,
          previous = renderer.getRenderTarget();
        try {
          renderer.setRenderTarget(target);
          quad.render(renderer);
          renderer.setRenderTarget(previous);
          const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, n, 1);
          for (let i = 0; i < n; i++) {
            const k = 4 * i,
              x = coords[k],
              z = coords[k + 1],
              time = coords[k + 2];
            maxHeight = Math.max(maxHeight, Math.abs(w.ground(x, z) - px[k]));
            for (const upper of [false, true]) {
              const initial = front.life.at(x, z, time, upper),
                dt = 13.2;
              const wx = upper ? front.upperClouds.windX : front.axis[0] * front.speed;
              const wz = upper ? front.upperClouds.windZ : front.axis[1] * front.speed;
              const later = front.life.at(x + dt * wx, z + dt * wz, time + dt, upper);
              maxPhase = Math.max(maxPhase, Math.abs(initial - px[k + (upper ? 2 : 1)]));
              maxAdvected = Math.max(
                maxAdvected,
                Math.abs(
                  later - initial - ((2 * Math.PI * dt) / front.options.lifeSeconds) * (upper ? 0.59 : 1),
                ),
              );
            }
          }
          return {
            maxHeight,
            maxAnalytic,
            maxCollider,
            maxPhase,
            maxAdvected,
            vertices: w.bed.mesh.geometry.attributes.position.count,
            pitch: grid.innerStep,
          };
        } finally {
          renderer.setRenderTarget(previous);
          mat.dispose();
          target.dispose();
          tex.dispose();
        }
      });
      console.log(backend, result);
      expect(result.vertices).toBe(257 * 257);
      expect(result.pitch).toBeLessThan(0.8);
      expect(result.maxAnalytic).toBeLessThan(0.01);
      expect(result.maxCollider).toBeLessThan(0.01);
      expect(result.maxHeight).toBeLessThan(0.01);
      expect(result.maxPhase).toBeLessThan(0.0001);
      expect(result.maxAdvected).toBeLessThan(1e-8);
      expect(log.errors).toEqual([]);
    },
  );
}
