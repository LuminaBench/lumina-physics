import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2']) {
  test(backend + ' rain changes the exposed slate face under fixed light', async ({ page }) => {
    const log = watchConsole(page);
    const captures = process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/field-candidate/stone';
    mkdirSync(captures, { recursive: true });
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto(
      '/field.html?region=lumina:atlantic-headland&direction=lumina:atlantic&view=ridge&hour=16&ui=0&tier=high' +
        (backend === 'webgl2' ? '&webgl' : ''),
    );
    await page.waitForFunction(() => !!(window as any).fieldGuide);
    const surface = await page.evaluate(() => {
      const g = (window as any).fieldGuide,
        w = g.world,
        e = w.engine,
        c = e.camera;
      const mat = c.matrixWorld.clone();
      let best = -Infinity,
        target: { x: number; y: number; z: number; size: number } | undefined;
      e.scene.traverse((node: any) => {
        if (!node.name.startsWith('talus ') || !node.isInstancedMesh) return;
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, mat);
          const q = mat.elements,
            size = Math.hypot(q[0], q[1], q[2]);
          const score = size - Math.abs(q[13] - 4.2) * 0.1;
          if (q[13] > 2.2 && q[13] < 14 && score > best) {
            best = score;
            target = { x: q[12], y: q[13] + size * 0.38, z: q[14], size };
          }
        }
      });
      if (!target) throw new Error('No exposed slate boulder visible on the headland');
      const t = target;
      let low = Infinity,
        angle = 0;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        const h = g.route.bridge.height(t.x + Math.sin(a) * t.size * 2.85, t.z + Math.cos(a) * t.size * 2.85);
        if (h < low) {
          low = h;
          angle = a;
        }
      }
      e.onBeforeRender = () => {
        c.fov = 46;
        c.updateProjectionMatrix();
        c.position.set(
          t.x + Math.sin(angle) * t.size * 2.85,
          Math.max(low + 1.6, t.y + t.size * 0.21),
          t.z + Math.cos(angle) * t.size * 2.85,
        );
        c.lookAt(t.x, t.y, t.z);
        c.updateMatrixWorld();
      };
      e.onBeforeRender();
      e.paused = true;
      return w.land.region.rock;
    });
    expect(surface).toBe('lumina:slate');
    const shots: Buffer[] = [];
    for (const rain of [0, 1]) {
      const film = await page.evaluate((amount) => {
        const g = (window as any).fieldGuide,
          w = g.world;
        w.land.earth.setRain(amount);
        for (let i = 0; i < 800; i++) w.land.update(0.25);
        return w.land.rain.value;
      }, rain);
      expect(Math.abs(film - rain)).toBeLessThan(0.01);
      await page.waitForTimeout(300);
      const label = rain ? 'wet' : 'dry';
      await page.screenshot({ path: path.join(captures, backend + '-slate-' + label + '.jpg'), quality: 82 });
      shots.push(
        PNG.sync.read(await page.screenshot({ clip: { x: 425, y: 232, width: 110, height: 78 } })).data,
      );
    }
    const sum = (buf: Buffer) => {
      let v = 0;
      for (let i = 0; i < buf.length; i += 4)
        v += buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722;
      return v / (buf.length / 4);
    };
    const dry = sum(shots[0]),
      wet = sum(shots[1]);
    console.log(backend, 'slate centre luminance', dry, wet);
    expect(Math.abs(wet - dry)).toBeGreaterThan(3);
    expect(log.errors).toEqual([]);
  });
}
