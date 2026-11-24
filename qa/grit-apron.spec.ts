import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { watchConsole } from './helpers';

const output = path.join(process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coast', 'grit-apron');
for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' coupe carries two finite grit loads onto the dry apron and leaves a visible track',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/coast.html?shore=boulevard&view=drive&tier=high&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 3);
      await page.evaluate(() => (window as any).coastDemo.world.engine.stop());
      await page.getByRole('button', { name: 'Scatter washed sand' }).click();
      const result = await page.evaluate(() => {
        const d = (window as any).coastDemo,
          T = (window as any).THREE;
        const { world, vehicles, road } = d,
          e = world.engine,
          car = vehicles.car,
          spray = vehicles.spray;
        const bed = road.grit,
          m = new T.Vector2(),
          start = bed.save(),
          initial = bed.total(m).toArray();
        vehicles.reset('drive');
        const keys = new Set(),
          peak = [0, 0, 0, 0],
          dryPeak = [0, 0, 0, 0];
        let t = 0,
          dryZ = NaN,
          entryDepth = 0,
          exitDepth = 0,
          leftX = 0;
        const dry: [number, number][] = [],
          trace: number[][] = [];
        for (let i = 0; i < 480; i++) {
          const dt = 1 / 60;
          vehicles.drive(dt, keys, true);
          e.physics.step(dt, 4);
          car.update(dt, (t += dt));
          spray.update(dt);
          road.update(dt, car.root.position);
          for (let k = 0; k < 4; k++) {
            const w = car.wheels[k],
              grams = spray.grit[k].fine + spray.grit[k].coarse;
            peak[k] = Math.max(peak[k], grams);
            if (w.position.z > road.road.z + 17.8 && w.depth < 0.0005)
              dryPeak[k] = Math.max(dryPeak[k], grams);
          }
          const w = car.wheels[0],
            dz = w.position.z - road.road.z;
          if (i % 6 === 0 && dz > 3 && dz < 27)
            trace.push(
              [
                dz,
                w.position.x - road.road.x,
                w.depth * 1000,
                spray.treadFilm[0] * 1000,
                spray.grit[0].fine,
                spray.grit[0].coarse,
              ].map((v) => +v.toFixed(2)),
            );
          if (Math.abs(dz) < 6) entryDepth = Math.max(entryDepth, w.depth);
          if (dz > 17.8 && dz < 24 && w.contact && w.depth < 0.0005) {
            dry.push([w.position.x, w.position.z]);
            if (!Number.isFinite(dryZ)) {
              dryZ = w.position.z;
              leftX = w.position.x;
              exitDepth = w.depth;
            }
          }
          if (car.root.position.z > road.road.z + 26) break;
        }
        const saved = bed.save(),
          sum = bed.total(m).toArray();
        const error = initial.map((v: number, i: number) =>
          Math.abs(
            v -
              sum[i] -
              bed.exported.getComponent(i) -
              spray.grit.reduce((total: number, w: any) => total + (i === 0 ? w.fine : w.coarse), 0),
          ),
        );
        const deposited = [0, 0];
        for (let i = 0; i < saved.cells.length; i += 3) {
          const cell = saved.cells[i],
            z = bed.options.z + (Math.floor(cell / bed.options.columns) + 0.5) * bed.options.cellSize;
          if (z > road.road.z + 17.8) {
            deposited[0] += saved.cells[i + 1];
            deposited[1] += saved.cells[i + 2];
          }
        }
        if (!Number.isFinite(dryZ)) throw Error('No front-left dry exit found');
        const at = new T.Vector3(leftX, road.heightAt(leftX, dryZ + 1.3) + 0.005, dryZ + 1.3);
        let clock = performance.now();
        e.lastNow = clock;
        e.paused = true;
        e.onUpdate = null;
        world.setClock({ latitudeDeg: 34, dayOfYear: 190, solarHour: 15.5 });
        e.onBeforeRender = () => {
          e.camera.position.set(at.x + 0.92, at.y + 1.45, at.z - 2.5);
          e.camera.lookAt(at);
        };
        (window as any).paintGrit = async (present: boolean) => {
          bed.restore(present ? saved : start);
          bed.upload();
          for (let i = 0; i < 32; i++) {
            await new Promise(requestAnimationFrame);
            e.tick((clock += 1000 / 60));
          }
          const samples: number[][] = [];
          for (const [x, z] of dry) {
            const pos = new T.Vector3(x, road.heightAt(x, z) + 0.003, z).project(e.camera);
            if (Math.abs(pos.x) < 0.85 && Math.abs(pos.y) < 0.85 && pos.z < 1)
              samples.push([(pos.x + 1) * 0.5, (1 - pos.y) * 0.5]);
          }
          return samples as number[][];
        };
        return {
          backend: e.backend,
          initial,
          trace,
          peak,
          dryPeak,
          entryDepth,
          exitDepth,
          dryOffset: dryZ - road.road.z,
          deposited,
          error,
        };
      });
      await page.locator('aside').evaluate((el) => el.setAttribute('hidden', ''));
      fs.mkdirSync(output, { recursive: true });
      const draw = async (state: boolean) => {
        const points = (await page.evaluate((show) => (window as any).paintGrit(show), state)) as number[][];
        const data = await page.screenshot({
          path: path.join(output, backend + (state ? '-transfer' : '-control') + '.png'),
        });
        return { points, png: PNG.sync.read(data) };
      };
      const off = await draw(false),
        on = await draw(true);
      const changes = on.points
        .map(([x, y]) => {
          const pixel = 4 * (Math.floor(y * on.png.height) * on.png.width + Math.floor(x * on.png.width));
          return on.png.data[pixel] - off.png.data[pixel];
        })
        .sort((a, b) => a - b);
      const medianRed = changes[Math.floor(changes.length / 2)];
      const evidence = { ...result, trackSamples: changes.length, medianRed, errors: log.errors };
      console.log(evidence);
      fs.writeFileSync(path.join(output, backend + '.json'), JSON.stringify(evidence, null, 2));
      expect(log.errors).toEqual([]);
      expect(result.backend).toBe(backend === 'webgl' ? 'webgl2' : backend);
      expect(result.peak[0]).toBeGreaterThan(3);
      expect(result.peak[2]).toBeGreaterThan(3);
      expect(result.peak[1] + result.peak[3]).toBe(0);
      expect(result.dryPeak[0]).toBeGreaterThan(2);
      expect(result.dryPeak[2]).toBeGreaterThan(2);
      expect(result.entryDepth).toBeGreaterThan(0.005);
      expect(result.deposited[0]).toBeGreaterThan(1);
      expect(result.deposited[1]).toBeGreaterThan(0.5);
      expect(Math.max(...result.error)).toBeLessThan(1e-7);
      expect(changes.length).toBeGreaterThan(7);
      expect(medianRed).toBeGreaterThan(3);
    },
  );
}
