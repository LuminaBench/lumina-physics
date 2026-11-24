import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' measures leaning cloud crowns, ground light and open sky above a noon bank',
    async ({ page }, testInfo) => {
      const log = watchConsole(page);
      const dest = process.env.LUMINA_CAPTURE_DIR
        ? path.join(process.env.LUMINA_CAPTURE_DIR, backend)
        : testInfo.outputPath('banks');
      mkdirSync(dest, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=headland&tier=high&view=walk&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      await page.locator('summary').click();
      await page.getByRole('slider', { name: 'Cloud crown lean (%)' }).fill('-50');
      await page.getByRole('slider', { name: 'Cloud skylight reach (m)' }).fill('75');
      expect(await page.evaluate(() => (window as any).coastDemo.world.weather.params.cloudBank)).toEqual({
        crownOffset: [-260, 105],
        skylightReach: 75,
        billows: 0.88,
      });
      await page.locator('#bank-lean').fill('100');
      await page.locator('#bank-sky').fill('125');
      await page.locator('aside').evaluate((el) => (el.style.display = 'none'));
      const report = await page.evaluate(async () => {
        const w = (window as any).coastDemo.world,
          e = w.engine,
          T = (window as any).THREE,
          t = T.TSL;
        const weather = w.weather,
          r = e.renderer,
          realRecipe = weather.params.cloudBank;
        e.stop();
        e.paused = true;
        e.onBeforeRender = null;
        e.onUpdate = null;
        e.setDynamicResolution(false);
        e.camera.fov = 57;
        e.camera.updateProjectionMatrix();
        w.setClock({ latitudeDeg: 36, dayOfYear: 115, solarHour: 12.4 });
        weather.autoExposure = false;
        weather.params.exposure = 0.55;
        let now = performance.now();
        const tick = () => e.tick((now += 1000 / 60));
        tick();
        const probe = new T.Vector3(),
          n = 224,
          col = t.uv().x.mul(n).floor(),
          shift = t.uniform(new T.Vector2());
        const height = t.uniform(0);
        const point = t.vec3(
          col.mul(117).sub(14920).add(shift.x),
          height,
          col.mul(217).sub(10930).add(shift.y),
        );
        const m = new T.NodeMaterial();
        m.fragmentNode = t.vec4(weather.cloudDensityNode(point, false), 0, 0, 1);
        const quad = new T.QuadMesh(m),
          target = new T.RenderTarget(n, 1, { type: T.FloatType, depthBuffer: false });
        const prev = r.getRenderTarget();
        let moved = 0,
          occupied = 0,
          maxAligned = 0,
          maxCPU = 0,
          sumCPU = 0,
          comparisons = 0;
        const read = async () => {
          r.setRenderTarget(target);
          quad.render(r);
          r.setRenderTarget(prev);
          return r.readRenderTargetPixelsAsync(target, 0, 0, n, 1);
        };
        try {
          const [dx, dz] = [900, -460];
          for (const high of [false, true]) {
            const deck = high ? weather.upperClouds : weather.params;
            const saved = high ? deck.bank : deck.cloudBank;
            const edit = (value: any) => {
              if (high) deck.bank = value;
              else deck.cloudBank = value;
              tick();
            };
            const model = high ? weather.upperModel : weather.clouds;
            for (const frac of [0.14, 0.36, 0.57]) {
              height.value =
                model.uniforms.base.value + frac * (model.uniforms.top.value - model.uniforms.base.value);
              shift.value.set(0, 0);
              edit({ billows: 0.88 });
              const normal = await read();
              edit({ crownOffset: [dx, dz], skylightReach: 125, billows: 0.88 });
              const tilted = await read();
              shift.value.set(dx * frac * frac, dz * frac * frac);
              const aligned = await read();
              for (let i = 0; i < n; i++) {
                const k = 4 * i;
                if (normal[k] > 0.03) occupied++;
                if (Math.abs(normal[k] - tilted[k]) > 0.03) moved++;
                maxAligned = Math.max(maxAligned, Math.abs(normal[k] - aligned[k]));
                probe.set(i * 117 - 14920 + shift.value.x, height.value, i * 217 - 10930 + shift.value.y);
                const err = Math.abs(model.sampleDensity(probe, e.time) - aligned[k]);
                maxCPU = Math.max(maxCPU, err);
                sumCPU += err;
                comparisons++;
              }
            }
            edit(saved);
          }
        } finally {
          r.setRenderTarget(prev);
          m.dispose();
          target.dispose();
        }
        const width = 128,
          heightPx = 60,
          skyMat = new T.NodeMaterial(),
          pick = new T.QuadMesh(skyMat);
        const skyTarget = new T.RenderTarget(width, heightPx, { type: T.FloatType, depthBuffer: false });
        const a = t.uv().x.mul(Math.PI * 2),
          y = t.uv().y.mul(0.87).add(0.035),
          hz = t.float(1).sub(y.mul(y)).sqrt();
        const dir = t.vec3(a.cos().mul(hz), y, a.sin().mul(hz)),
          origin = t.vec3(21, 3, -5);
        skyMat.fragmentNode = weather.clouds.march(
          origin,
          dir,
          t.float(0.5),
          t.int(42),
          weather.skyColor(dir),
        );
        const sampleSky = async (reach: number) => {
          weather.params.cloudBank = { ...realRecipe, skylightReach: reach };
          tick();
          r.setRenderTarget(skyTarget);
          pick.render(r);
          r.setRenderTarget(prev);
          return r.readRenderTargetPixelsAsync(skyTarget, 0, 0, width, heightPx);
        };
        let covered = 0,
          maxTransmissionError = 0,
          skyDelta = 0;
        const shade: number[] = [];
        try {
          const flat = await sampleSky(0),
            modelled = await sampleSky(realRecipe.skylightReach);
          for (let k = 0; k < flat.length; k += 4) {
            maxTransmissionError = Math.max(maxTransmissionError, Math.abs(flat[k + 3] - modelled[k + 3]));
            if (flat[k + 3] > 0.82) continue;
            const before = 0.2126 * flat[k] + 0.7152 * flat[k + 1] + 0.0722 * flat[k + 2];
            const after = 0.2126 * modelled[k] + 0.7152 * modelled[k + 1] + 0.0722 * modelled[k + 2];
            if (before < 0.02) continue;
            shade.push((before - after) / before);
            covered++;
            skyDelta += before - after;
          }
        } finally {
          r.setRenderTarget(prev);
          skyTarget.dispose();
          skyMat.dispose();
        }
        shade.sort((a, b) => a - b);
        // A paused photo-mode cut can jump between dense and clear regions within
        // one deck. Lens moisture must follow the new eye even with dt = 0.
        const testY = weather.params.cloudBase + 0.17 * (weather.params.cloudTop - weather.params.cloudBase);
        let wet = -1,
          dry = Infinity;
        const wetEye = new T.Vector3(),
          dryEye = new T.Vector3();
        for (let i = 0; i < 180; i++) {
          probe.set(i * 73 - 4800, testY, i * 117 - 9100);
          const d = weather.sampleCloudDensity(probe);
          if (d > wet) {
            wet = d;
            wetEye.copy(probe);
          }
          if (d < dry) {
            dry = d;
            dryEye.copy(probe);
          }
        }
        e.camera.position.copy(wetEye);
        tick();
        const wetError = Math.abs(weather.cloudMoisture - wet);
        e.camera.position.copy(dryEye);
        tick();
        const dryError = Math.abs(weather.cloudMoisture - dry);
        const weatherAcrossCut = wet - dry,
          moistureError = Math.max(wetError, dryError);
        const [x, z] = [w.dune.options.centerX, w.dune.options.centerZ];
        const displayed = async (scene: string, bank: boolean) => {
          weather.params.cloudBank = bank ? realRecipe : undefined;
          const eye = e.camera.position;
          if (scene === 'evening') {
            w.setClock({ latitudeDeg: 36, dayOfYear: 115, solarHour: 17.9 });
            eye.set(x + 2.5, w.ground(x + 2.5, z + 3) + 1.45, z + 3);
            const sun = weather.getSunDirection(),
              bearing = Math.atan2(sun.z, sun.x) + 0.38;
            e.camera.lookAt(eye.x + 100 * Math.cos(bearing), eye.y + 13, eye.z + 100 * Math.sin(bearing));
          } else if (scene === 'beach') {
            eye.set(x + 2.5, w.ground(x + 2.5, z + 3) + 1.1, z + 3);
            e.camera.lookAt(x - 60, 24, z - 74);
          } else if (scene === 'aloft') {
            eye.set(-620, 875, -495);
            e.camera.lookAt(-1650, 1060, -1400);
          } else {
            eye.set(-620, 1250, -495);
            e.camera.lookAt(-1150, 1360, 640);
          }
          w.setFocus(eye);
          weather.resetCloudHistory();
          for (let i = 0; i < 34; i++) {
            await new Promise(requestAnimationFrame);
            tick();
          }
        };
        (window as any).bankFrame = displayed;
        return {
          backend: e.backend,
          weatherAcrossCut,
          moistureError,
          moved,
          occupied,
          maxAligned,
          maxCPU,
          meanCPU: sumCPU / comparisons,
          comparisons,
          covered,
          maxTransmissionError,
          skyDelta: skyDelta / covered,
          p10: shade[Math.floor(shade.length * 0.1)],
          p90: shade[Math.floor(shade.length * 0.9)],
        };
      });
      for (const scene of ['beach', 'aloft', 'tower', 'evening']) {
        for (const enabled of [false, true]) {
          await page.evaluate(([s, b]) => (window as any).bankFrame(s, b), [scene, enabled]);
          await page.screenshot({
            path: path.join(dest, scene + '-' + (enabled ? 'after' : 'before') + '.png'),
          });
        }
      }
      console.log(backend, 'cloud banks', report);
      writeFileSync(path.join(dest, 'cloud-bank.json'), JSON.stringify(report, null, 2));
      expect(report.backend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu');
      expect(report.occupied).toBeGreaterThan(75);
      expect(report.moved).toBeGreaterThan(20);
      expect(report.weatherAcrossCut).toBeGreaterThan(0.6);
      expect(report.moistureError).toBeLessThan(0.0001);
      expect(report.maxAligned).toBeLessThan(0.012);
      expect(report.meanCPU).toBeLessThan(0.012);
      expect(report.maxCPU).toBeLessThan(0.08);
      expect(report.maxTransmissionError).toBeLessThan(0.0001);
      expect(report.covered).toBeGreaterThan(100);
      expect(report.skyDelta).toBeGreaterThan(0.001);
      expect(report.p90 - report.p10).toBeGreaterThan(0.035);
      expect(log.errors).toEqual([]);
    },
  );
}
