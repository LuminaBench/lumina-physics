import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import path from 'node:path';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl'])
  test(
    backend + ' mineral faces resolve to individual sun glints and average into a stable distant lobe',
    async ({ page }, testInfo) => {
      const log = watchConsole(page);
      const dest = process.env.LUMINA_CAPTURE_DIR
        ? path.join(process.env.LUMINA_CAPTURE_DIR, backend)
        : testInfo.outputPath('minerals');
      mkdirSync(dest, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=headland&tier=high&view=walk&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      await page.locator('summary').click();
      await page.getByRole('button', { name: 'Inspect sand grains' }).click();
      await expect(page.locator('#inspect-grains')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('#facet-strength').fill('0.35');
      expect(
        await page.evaluate(() => (window as any).coastDemo.world.sand.facets.strength.value),
      ).toBeCloseTo(0.35);
      await page.locator('#facet-strength').fill('1');
      await page.getByRole('button', { name: 'Inspect sand grains' }).click();
      await expect(page.locator('#inspect-grains')).toHaveAttribute('aria-pressed', 'false');
      await page.locator('aside').evaluate((el) => (el.style.display = 'none'));
      const report = await page.evaluate(async () => {
        const d = (window as any).coastDemo,
          w = d.world,
          e = w.engine,
          T = (window as any).THREE,
          t = T.TSL,
          r = e.renderer;
        e.stop();
        const Facets = w.sand.facets.constructor;
        const finish = new Facets({
          seed: 721,
          fraction: 0.19,
          diameterMm: 2.6,
          tilt: 0.54,
          roughness: 0.115,
        });
        const geometry = new T.PlaneGeometry(80, 80).rotateX(-Math.PI / 2);
        const material = new T.MeshPhysicalNodeMaterial({ color: 0x796951, roughness: 0.86 });
        finish.apply(material, t.positionWorld.xz, t.normalView);
        const scene = new T.Scene(),
          surface = new T.Mesh(geometry, material),
          sun = new T.DirectionalLight(0xffffff, 2.6);
        sun.position.set(-0.8, 0.65, 0);
        scene.add(surface, sun, new T.AmbientLight(0xffffff, 0.2));
        const size = 192,
          cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
        const target = new T.RenderTarget(size, size, { type: T.FloatType }),
          saved = r.getRenderTarget();
        async function read(span: number, enable: number, offset = 0) {
          finish.strength.value = enable;
          cam.position.set(16 + offset, 13, 0);
          cam.lookAt(offset, 0, 0);
          cam.left = cam.bottom = -span / 2;
          cam.right = cam.top = span / 2;
          cam.updateProjectionMatrix();
          r.setRenderTarget(target);
          r.render(scene, cam);
          r.setRenderTarget(saved);
          return r.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        }
        function stats(data: Float32Array, ref: Float32Array) {
          const values: number[] = [];
          let sum = 0,
            square = 0;
          for (let j = 36; j < size - 36; j++)
            for (let i = 36; i < size - 36; i++) {
              const k = (i + j * size) * 4;
              const diff =
                (data[k] - ref[k]) * 0.2126 +
                (data[k + 1] - ref[k + 1]) * 0.7152 +
                (data[k + 2] - ref[k + 2]) * 0.0722;
              values.push(diff);
              sum += diff;
              square += diff * diff;
            }
          values.sort((a, b) => a - b);
          const mean = sum / values.length;
          return {
            mean,
            stdev: Math.sqrt(Math.max(0, square / values.length - mean * mean)),
            p99: values[Math.floor(values.length * 0.99)],
            max: values.at(-1)!,
          };
        }
        let result;
        try {
          const nearOff = await read(0.14, 0),
            near = stats(await read(0.14, 1), nearOff);
          const middle = stats(await read(0.8, 1), await read(0.8, 0));
          const far = stats(await read(4, 1), await read(4, 0));
          const translated = stats(await read(4, 1, 0.002), await read(4, 0, 0.002));
          const moving: number[] = [];
          for (const span of [0.28, 0.5, 0.8, 1.2, 2.0]) {
            let mean = 0;
            for (const phase of [0.001, 0.043, 0.091, 0.161])
              mean += stats(await read(span, 1, phase), await read(span, 0, phase)).mean;
            moving.push(mean / 4);
          }
          sun.position.set(0.8, 0.65, 0);
          const away = stats(await read(0.14, 1), await read(0.14, 0));
          result = { near, middle, far, translated, away, moving, backend: e.backend };
        } finally {
          r.setRenderTarget(saved);
          target.dispose();
          material.dispose();
          geometry.dispose();
          finish.dispose();
        }
        const { centerX, centerZ } = w.dune.options;
        const x = centerX + 0.55,
          z = centerZ + 0.35,
          ground = w.ground;
        const at = new T.Vector3(x, ground(x, z) + 0.002, z),
          delta = 0.16;
        const normal = new T.Vector3(
          ground(x - delta, z) - ground(x + delta, z),
          2 * delta,
          ground(x, z - delta) - ground(x, z + delta),
        ).normalize();
        w.setClock({ latitudeDeg: 52, dayOfYear: 188, solarHour: 15.3 });
        w.weather.autoExposure = false;
        w.weather.params.exposure = 0.55;
        e.tick(performance.now());
        const axis = w.weather.getSunDirection().negate().reflect(normal).normalize();
        let clock = performance.now();
        e.lastNow = clock;
        e.onUpdate = null;
        e.paused = true;
        (window as any).mineralFrame = async (gain: number, distance: number) => {
          w.sand.facets.strength.value = gain;
          e.onBeforeRender = () => {
            e.camera.position.copy(at).addScaledVector(axis, distance);
            e.camera.lookAt(at);
          };
          w.setFocus(distance > 9 ? at.clone().add(new T.Vector3(0, 12, 0)) : at);
          for (let i = 0; i < 25; i++) {
            await new Promise(requestAnimationFrame);
            e.tick((clock += 1000 / 60));
          }
        };
        (window as any).duneEdge = () => {
          const uv: number[][] = [];
          for (let i = 0; i < 96; i++) {
            const dx = Math.cos((Math.PI * 2 * i) / 96),
              dz = Math.sin((Math.PI * 2 * i) / 96);
            for (let radius = 0.8; radius < 4; radius += 0.04) {
              const x = centerX + dx * radius,
                z = centerZ + dz * radius,
                depth = w.dune.depthAt(x, z);
              if (depth > 0.004 && depth < 0.009) {
                const q = new T.Vector3(x, ground(x, z), z).project(e.camera);
                if (Math.abs(q.x) < 0.95 && Math.abs(q.y) < 0.95) uv.push([(1 + q.x) * 0.5, (1 - q.y) * 0.5]);
                break;
              }
            }
          }
          return uv as number[][];
        };
        return result;
      });
      for (const [label, gain, metres] of [
        ['base', 0, 0.62],
        ['facets', 1, 0.62],
        ['distance', 1, 13],
      ] as const) {
        await page.evaluate(([g, m]) => (window as any).mineralFrame(g, m), [gain, metres]);
        await page.screenshot({ path: path.join(dest, 'sand-' + label + '.png') });
      }
      const edge = await page.evaluate(() => (window as any).duneEdge() as number[][]);
      expect(edge.length).toBeGreaterThan(45);
      const on = PNG.sync.read(await page.screenshot());
      await page.evaluate(() => {
        const w = (window as any).coastDemo.world;
        if (w.sand.detail.visible) throw new Error('Distant sand still uses contact geometry');
        w.engine.scene.getObjectByName('Loose dune over compact sand').visible = false;
      });
      await page.evaluate(() => (window as any).mineralFrame(1, 13));
      const off = PNG.sync.read(await page.screenshot());
      const changes = edge
        .map(([u, v]) => {
          let diff = 0;
          for (let y = -1; y <= 1; y++)
            for (let x = -1; x <= 1; x++) {
              const k = ((Math.floor(v * on.height) + y) * on.width + Math.floor(u * on.width) + x) * 4;
              diff += Math.abs(
                0.2126 * (on.data[k] - off.data[k]) +
                  0.7152 * (on.data[k + 1] - off.data[k + 1]) +
                  0.0722 * (on.data[k + 2] - off.data[k + 2]),
              );
            }
          return diff / 9;
        })
        .sort((a, b) => a - b);
      const edgeP90 = changes[Math.floor(changes.length * 0.9)];
      writeFileSync(
        path.join(dest, 'mineral-facets.json'),
        JSON.stringify({ ...report, edgeP90, edgeSamples: edge.length }, null, 2),
      );
      expect(edgeP90).toBeLessThan(7);
      expect(report.moving.every((v) => v > report.far.mean * 0.6 && v < report.far.mean * 1.65)).toBe(true);
      console.log(backend, report);
      expect(report.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
      expect(report.near.p99).toBeGreaterThan(0.015);
      expect(report.near.p99).toBeGreaterThan(report.away.p99 * 1.5);
      expect(report.far.mean).toBeGreaterThan(0.0001);
      expect(report.near.stdev).toBeGreaterThan(report.far.stdev * 3);
      expect(Math.abs(report.translated.mean - report.far.mean)).toBeLessThan(0.003);
      expect(log.errors).toEqual([]);
    },
  );
