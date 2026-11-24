import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { watchConsole, TIERS } from './helpers';

async function openPatch(page: Page, shore: string, backend: string, tier = 'high') {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/coast.html?shore=' + shore + '&backend=' + backend + '&tier=' + tier);
  await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 14);
  await page.locator('#clock').fill('14');
  const clockChanged = await page.evaluate(() => (window as any).coastDemo.world.engine.time);
  await page.waitForFunction(t => (window as any).coastDemo.world.engine.time > t + 1.4, clockChanged);
  await page.locator('summary').click();
  await page.locator('#wet-sand').click();
  await expect(page.locator('#sand-water-reading')).toContainText('pore saturation');
}

const folder = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output', 'sand-water');
for (const shore of ['headland', 'volcanic'])
  for (const backend of ['webgpu', 'webgl']) {
    test(
      backend + ' ' + shore + ' wet stake reflection vanishes before the bed dries at two angles',
      async ({ page }) => {
        const log = watchConsole(page),
          dir = path.join(folder, shore, backend);
        fs.mkdirSync(dir, { recursive: true });
        await openPatch(page, shore, backend);
        await page.evaluate(() => {
          const w = (window as any).coastDemo.world,
            e = w.engine;
          e.stop();
          w.sediment.options.rainAt = () => 0;
          (window as any).initialGauge = w.sediment.save();
        });
        for (const angle of ['front', 'side']) {
          if (angle === 'side') await page.locator('#sand-water-angle').click();
          await page.locator('aside').evaluate((e) => (e.style.visibility = 'hidden'));
          const prepare = async (state: 'wet' | 'damp' | 'dry') =>
            page.evaluate((state) => {
              const d = (window as any).coastDemo,
                w = d.world,
                e = w.engine,
                p = d.gauge.point,
                s = w.sediment;
              // Replay the same pulse with a dry forecast, keeping the sky, clock and exposure fixed.
              if (state === 'wet') s.restore((window as any).initialGauge);
              let elapsed = 0;
              if (state === 'damp') {
                while (elapsed < 720) {
                  for (let tick = 0; tick < 24; tick++)
                    s.update(1 / 12, p.x, p.z, w.ocean.waterLevel, w.ocean.optics.breakerHeight);
                  elapsed += 2;
                  let surface = 0;
                  for (let i = -30; i <= 30; i++)
                    for (let j = -30; j <= 30; j++) {
                      const r = s.inspect(p.x + i * 0.04, p.z + j * 0.04);
                      surface = Math.max(surface, r.filmMm + r.water * 1000);
                    }
                  if (surface < 0.001) break;
                }
              } else if (state === 'dry') {
                // Isolate pore darkening at unchanged bed geometry and exposure.
                for (const tile of s.tiles.values()) {
                  tile.pore.fill(0);
                  tile.film.fill(0);
                  tile.water.fill(0);
                }
              }
              w.sand.update(p.x, p.z, true);
              e.onUpdate(0, e.time);
              e.camera.updateMatrixWorld();
              const bottom = d.gauge.stake.position.clone().project(e.camera);
              // Use the wettest remaining three-by-three bed sample inside the original pulse.
              // Holding this position for the dry control isolates the colour of those same grains.
              let px = p.x,
                pz = p.z,
                peak = -1;
              if (state === 'damp') {
                for (let i = -9; i <= 9; i++)
                  for (let j = -9; j <= 9; j++) {
                    if (i * i + j * j > 81) continue;
                    const x = p.x + 0.1 * i,
                      z = p.z + 0.1 * j;
                    let saturation = 0;
                    for (let a = -1; a <= 1; a++)
                      for (let b = -1; b <= 1; b++)
                        saturation += s.inspect(x + 0.04 * a, z + 0.04 * b).poreSaturation;
                    if (saturation > peak) {
                      peak = saturation;
                      px = x;
                      pz = z;
                    }
                  }
              }
              const r = { ...s.inspect(px, pz) },
                mark = p
                  .clone()
                  .set(px, r.height + r.water, pz)
                  .project(e.camera);
              return {
                ...r,
                elapsed,
                probeXZ: [px, pz],
                uv: [(1 + mark.x) / 2, (1 - mark.y) / 2],
                foot: [(1 + bottom.x) / 2, (1 - bottom.y) / 2],
              };
            }, state);
          const capture = async (stake: boolean, file: string) => {
            await page.evaluate(async (on) => {
              const d = (window as any).coastDemo,
                w = d.world,
                e = w.engine,
                probe = w.weather.localProbe;
              d.gauge.stake.traverse((obj: any) =>
                on ? obj.layers.enable(probe.layer) : obj.layers.disable(probe.layer),
              );
              for (let i = 0; i < 12; i++) probe.update(e.renderer, e.scene, 2);
              for (let i = 0; i < 8; i++) {
                e.pipeline.render();
                await new Promise(requestAnimationFrame);
              }
            }, stake);
            return PNG.sync.read(
              await page
                .locator('canvas')
                .first()
                .screenshot({ path: path.join(dir, angle + '-' + file + '.png') }),
            );
          };
          const wet = await prepare('wet'),
            wOn = await capture(true, 'wet'),
            wOff = await capture(false, 'wet-control');
          const damp = await prepare('damp'),
            dOn = await capture(true, 'damp'),
            dOff = await capture(false, 'damp-control');
          await prepare('dry');
          const dry = await capture(true, 'dry');
          const { width, height } = wOn;
          const v = (a: PNG, x: number, y: number) => {
            const k = (x + y * width) * 4;
            return a.data[k] * 0.2126 + a.data[k + 1] * 0.7152 + a.data[k + 2] * 0.0722;
          };
          const regions: { x: number; y: number; wet: number; damp: number }[] = [];
          // The entire surveyed pulse has drained. Reuse the wet reflection's screen footprint.
          const cx = wet.foot[0] * width,
            cy = wet.foot[1] * height;
          for (let y = Math.ceil(cy) + 6; y < Math.min(height - 8, cy + height * 0.22); y += 8)
            for (
              let x = Math.max(0, Math.floor(cx - width * 0.085));
              x < Math.min(width - 8, cx + width * 0.085);
              x += 8
            ) {
              let a = 0,
                b = 0;
              for (let j = 0; j < 8; j++)
                for (let i = 0; i < 8; i++) {
                  a += v(wOn, x + i, y + j) - v(wOff, x + i, y + j);
                  b += v(dOn, x + i, y + j) - v(dOff, x + i, y + j);
                }
              regions.push({ x, y, wet: Math.abs(a / 64), damp: Math.abs(b / 64) });
            }
          regions.sort((a, b) => b.wet - a.wet);
          const witness = regions.slice(0, 16);
          const reflected = witness.reduce((n, p) => n + p.wet, 0) / witness.length;
          const remaining = witness.reduce((n, p) => n + p.damp, 0) / witness.length;
          let darkening = 0,
            count = 0;
          const sx = Math.round(damp.uv[0] * width),
            sy = Math.round(damp.uv[1] * height);
          for (let y = sy - 5; y <= sy + 5; y++)
            for (let x = sx - 10; x <= sx + 10; x++) {
              darkening += v(dry, x, y) - v(dOn, x, y);
              count++;
            }
          darkening /= count;
          const result = {
            shore,
            backend,
            angle,
            wet,
            damp,
            witnesses: witness.length,
            reflected,
            remaining,
            darkening,
          };
          expect(witness.length).toBe(16);
          fs.writeFileSync(path.join(dir, angle + '.json'), JSON.stringify(result, null, 2));
          console.log('Wet sand', shore, backend, angle, reflected, remaining, darkening, damp.elapsed);
          expect(log.errors).toEqual([]);
          expect(damp.elapsed).toBeLessThan(720);
          expect(wet.water).toBeGreaterThan(0.001);
          expect(damp.filmMm).toBeLessThan(0.001);
          expect(damp.water).toBeLessThan(0.000005);
          expect(damp.poreSaturation).toBeGreaterThan(0.15);
          expect(reflected).toBeGreaterThan(3);
          expect(remaining).toBeLessThan(reflected * 0.4);
          expect(darkening).toBeGreaterThan(4);
          expect(log.errors).toEqual([]);
          await page.locator('aside').evaluate((e) => (e.style.visibility = 'visible'));
        }
      },
    );
  }
for (const backend of ['webgpu', 'webgl'])
  for (const tier of TIERS)
    test(backend + ' ' + tier + ' wet sand at 1080p', async ({ page }) => {
      const log = watchConsole(page);
      await openPatch(page, 'headland', backend, tier);
      const perf = await page.evaluate(async () => {
        const e = (window as any).coastDemo.world.engine,
          frames = e.stats.frames,
          times: number[] = [];
        let old = 0;
        await new Promise<void>((done) => {
          function sample(t: number) {
            if (old) times.push(t - old);
            old = t;
            if (times.length === 180) done();
            else requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        });
        const fps = 180000 / times.reduce((a, b) => a + b, 0);
        times.sort((a, b) => a - b);
        return {
          fps,
          p95: times[170],
          over33: times.filter((t) => t > 33.3).length,
          frames: e.stats.frames - frames,
          size: [e.canvas.width, e.canvas.height],
          scale: e.stats.renderScale,
          backend: e.backend,
        };
      });
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, backend + '-' + tier + '.json'), JSON.stringify(perf, null, 2));
      expect(perf.backend).toBe(backend === 'webgpu' ? 'webgpu' : 'webgl2');
      expect(perf.size).toEqual([1920, 1080]);
      expect(perf.frames).toBeGreaterThanOrEqual(175);
      expect(perf.p95).toBeLessThanOrEqual(18.5);
      expect(perf.fps).toBeGreaterThanOrEqual(58);
      expect(log.errors).toEqual([]);
    });
