import { test, expect } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' off-screen geometry enters reflections after a complete six-face capture', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'fire', 'high', backend);
    const values = await page.evaluate(async () => {
      const { THREE: T, lumina } = window as any;
      const { engine, scene: { weather } } = lumina;
      engine.stop();
      const renderer = engine.renderer, probe = weather.localProbe;
      probe.enabled = false;
      probe.update(renderer, engine.scene, 0);
      probe.enabled = true;
      probe.refreshSeconds = 0;
      probe.center.set(70000, 0, 0);
      probe.halfSize.set(12, 8, 12);
      const building = new T.Mesh(new T.BoxGeometry(1, 4, 4), new T.MeshBasicMaterial({ color: 0xff0000 }));
      building.position.copy(probe.center);
      building.position.x += 6;
      building.layers.enable(probe.layer);
      engine.scene.add(building);
      const prior = renderer.getRenderTarget(), bg = engine.scene.backgroundNode;
      const pos = T.TSL.uniform(probe.center.clone()), dir = T.TSL.uniform(new T.Vector3(1, 0, 0));
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const mat = new T.NodeMaterial();
      mat.fragmentNode = T.TSL.vec4(weather.reflectionAt(pos, dir, T.TSL.float(0)), 1);
      const quad = new T.QuadMesh(mat);
      async function pixel() {
        renderer.setRenderTarget(target);
        quad.render(renderer);
        renderer.setRenderTarget(prior);
        const rgb = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
        return Array.from(rgb as Float32Array).slice(0, 3);
      }
      try {
        const sky = await pixel();
        for (let i = 0; i < 5; i++) probe.update(renderer, engine.scene, 0);
        const partial = await pixel();
        probe.update(renderer, engine.scene, 0);
        const red = await pixel();
        pos.value.z += 9;
        const parallax = await pixel();
        pos.value.copy(probe.center);
        dir.value.x = -1;
        const empty = await pixel();
        probe.enabled = false;
        probe.update(renderer, engine.scene, 0);
        const reverseSky = await pixel();
        return { sky, partial, red, parallax, empty, reverseSky,
          restored: renderer.getRenderTarget() === prior && engine.scene.backgroundNode === bg };
      } finally {
        engine.scene.remove(building);
        building.geometry.dispose(); building.material.dispose();
        renderer.setRenderTarget(prior); target.dispose(); mat.dispose();
      }
    });
    expect(values.restored).toBe(true);
    expect(values.partial).toEqual(values.sky);
    expect(values.red[0]).toBeGreaterThan(0.7);
    expect(values.red[1]).toBeLessThan(0.015);
    expect(values.red[2]).toBeLessThan(0.015);
    for (let c = 0; c < 3; c++) {
      expect(values.parallax[c]).toBeCloseTo(values.sky[c], 2);
      expect(values.empty[c]).toBeCloseTo(values.reverseSky[c], 2);
    }
    expect(log.errors).toEqual([]);
  });
}
