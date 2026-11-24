import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { watchConsole } from './helpers';

type Patch = { x: number; y: number; hdr: number[] };
const weights = [0.2126, 0.7152, 0.0722];
const luminance = (rgb: number[]) => rgb.reduce((sum, v, c) => sum + v * weights[c], 0);

function medianRGB(png: PNG, left: number, top: number, right: number, bottom: number) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let y = Math.floor(top * png.height); y < bottom * png.height; y++)
    for (let x = Math.floor(left * png.width); x < right * png.width; x++) {
      const k = (y * png.width + x) * 4;
      for (let c = 0; c < 3; c++) hist[c][png.data[k + c]]++;
      count++;
    }
  return hist.map((channel) => {
    let sum = 0;
    return channel.findIndex((n) => (sum += n) >= count / 2);
  });
}

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' meters a sunlit dune, a shaded grey card and blue hour in the playable headland',
    async ({ page }, testInfo) => {
      const log = watchConsole(page);
      const dest = process.env.LUMINA_CAPTURE_DIR
        ? path.join(process.env.LUMINA_CAPTURE_DIR, backend)
        : testInfo.outputPath('daylight');
      mkdirSync(dest, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=headland&tier=high&view=walk&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      await page.locator('#clock').fill('12');
      await page.locator('#cut').click();
      await page.locator('aside').evaluate((el) => (el.style.display = 'none'));
      await page.evaluate(() => {
        const { world: w } = (window as any).coastDemo,
          e = w.engine,
          T = (window as any).THREE;
        e.stop();
        const { centerX: x, centerZ: z } = w.dune.options;
        const centre = new T.Vector3(x, w.ground(x, z) + 1.2, z);
        const eye = new T.Vector3(x + 0.88, w.ground(x + 0.88, z + 2.7) + 0.74, z + 2.7);
        const look = new T.Vector3(x - 0.32, w.ground(x, z) + 0.16, z);
        const cards = new T.Group();
        for (const [index, reflectance] of [0.035, 0.18, 0.72].entries()) {
          const m = new T.MeshStandardNodeMaterial();
          m.color.setRGB(reflectance, reflectance, reflectance);
          m.roughness = 1;
          const patch = new T.Mesh(new T.PlaneGeometry(0.52, 0.6), m);
          patch.receiveShadow = true;
          patch.rotation.x = -Math.PI / 2;
          patch.position.copy(centre);
          patch.position.x += (index - 1) * 0.6;
          cards.add(patch);
        }
        cards.visible = false;
        e.scene.add(cards);
        const roof = new T.Mesh(
          new T.BoxGeometry(16, 0.18, 16),
          new T.MeshStandardNodeMaterial({ color: 0x695b50 }),
        );
        roof.position.copy(centre);
        roof.position.y += 5;
        roof.castShadow = true;
        roof.visible = false;
        e.scene.add(roof);
        let elapsed = performance.now();
        e.time = 35;
        e.lastNow = elapsed;
        e.onBeforeRender = () => {
          e.camera.position.copy(eye);
          e.camera.lookAt(look);
          w.weather.shadowFocus.copy(centre);
        };
        let uncover: (() => void) | undefined;
        (window as any).daylightChart = {
          async step(frames: number) {
            for (let i = 0; i < frames; i++) {
              await new Promise(requestAnimationFrame);
              elapsed += 1000 / 60;
              e.tick(elapsed);
            }
          },
          cards() {
            cards.visible = true;
            eye.copy(centre);
            eye.y += 1.7;
            look.copy(centre);
            e.camera.up.set(0, 0, -1);
          },
          roof(on: boolean) {
            if (on) {
              roof.visible = true;
              uncover = e.world.shelters.add({
                center: roof.position,
                width: 16,
                depth: 16,
                groundY: centre.y - 1.5,
              });
            } else {
              uncover?.();
              roof.visible = false;
            }
          },
          async reading() {
            const rt = e.pipeline.scenePass.renderTarget;
            const patches: Patch[] = [];
            if (cards.visible)
              for (const card of cards.children) {
                const clip = card.position.clone().project(e.camera);
                // All three centres lie on the horizontal middle row on both backends.
                const x = 0.5 + 0.5 * clip.x,
                  y = 0.5 - 0.5 * clip.y;
                const sample = await e.renderer.readRenderTargetPixelsAsync(
                  rt,
                  Math.floor(rt.width * x),
                  Math.floor(rt.height * y),
                  1,
                  1,
                );
                const hdr = Array.from(sample as Uint16Array)
                  .slice(0, 3)
                  .map((v) => T.DataUtils.fromHalfFloat(v));
                patches.push({ x, y, hdr });
              }
            return {
              backend: e.backend,
              exposure: e.pipeline.exposure,
              sunDegrees: w.weather.params.sunElevation,
              patches,
            };
          },
        };
      });
      const step = (n: number) => page.evaluate((n) => (window as any).daylightChart.step(n), n);
      const sample = async (name: string) => {
        const reading = await page.evaluate(() => (window as any).daylightChart.reading());
        const frame = PNG.sync.read(await page.screenshot({ path: path.join(dest, name + '.png') }));
        const patches = (reading.patches as Patch[]).map((p) => ({
          hdr: p.hdr,
          rgb: medianRGB(frame, p.x - 0.009, p.y - 0.009, p.x + 0.009, p.y + 0.009),
        }));
        return { ...reading, patches, foreground: medianRGB(frame, 0.25, 0.6, 0.75, 0.91) };
      };
      await step(90);
      const dune = await sample('noon-dune');
      await page.evaluate(() => (window as any).daylightChart.cards());
      await step(30);
      const open = await sample('sunlit-cards');
      await page.evaluate(() => (window as any).daylightChart.roof(true));
      await step(1);
      const firstShade = await page.evaluate(() => (window as any).coastDemo.world.engine.pipeline.exposure);
      await step(150);
      const shaded = await sample('sheltered-cards');
      await page.evaluate(() => (window as any).daylightChart.roof(false));
      await step(1);
      const firstSun = await page.evaluate(() => (window as any).coastDemo.world.engine.pipeline.exposure);
      await step(90);
      const returned = await sample('return-to-sun');
      await page.locator('#clock').evaluate((el: HTMLInputElement) => {
        el.value = '18.48';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await step(180);
      const dusk = await sample('blue-hour-cards');
      const controls = await page.evaluate(async () => {
        const w = (window as any).coastDemo.world.weather,
          chart = (window as any).daylightChart;
        w.exposureResponse.compensationEV = 1;
        await chart.step(240);
        const raised = (window as any).coastDemo.world.engine.pipeline.exposure;
        w.autoExposure = false;
        w.params.exposure = 0.47;
        await chart.step(1);
        return { raised, manual: (window as any).coastDemo.world.engine.pipeline.exposure };
      });
      const report = {
        dune,
        open,
        shaded,
        firstShade,
        firstSun,
        returned,
        dusk,
        controls,
        errors: log.errors,
      };
      writeFileSync(path.join(dest, 'meter.json'), JSON.stringify(report, null, 2));
      console.log(backend, 'daylight', JSON.stringify(report));
      expect(log.errors).toEqual([]);
      expect(dune.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
      expect(dune.foreground[0]).toBeLessThan(246);
      expect(dune.foreground[0]).toBeGreaterThan(170);
      expect(luminance(open.patches[1].rgb)).toBeGreaterThan(120);
      expect(luminance(open.patches[1].rgb)).toBeLessThan(170);
      expect(luminance(shaded.patches[1].rgb)).toBeGreaterThan(82);
      expect(luminance(open.patches[2].rgb) - luminance(open.patches[1].rgb)).toBeGreaterThan(14);
      expect(luminance(open.patches[1].hdr)).toBeGreaterThan(luminance(shaded.patches[1].hdr) * 1.5);
      expect(firstShade).toBeGreaterThan(open.exposure);
      expect(firstShade).toBeLessThan(open.exposure * 1.08);
      expect(shaded.exposure).toBeGreaterThan(open.exposure * 1.3);
      expect(firstSun).toBeLessThan(shaded.exposure);
      expect(firstSun).toBeGreaterThan(returned.exposure);
      expect(returned.exposure).toBeCloseTo(open.exposure, 1);
      expect(dusk.exposure).toBeGreaterThan(open.exposure * 1.5);
      expect(dusk.sunDegrees).toBeLessThan(0);
      expect(controls.raised / dusk.exposure).toBeCloseTo(2, 1);
      expect(controls.manual).toBe(0.47);
    },
  );
}
