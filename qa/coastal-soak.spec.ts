import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { watchConsole } from './helpers';

test('ten-minute moving shore drive revisits the sand and road', async ({ page }) => {
  test.skip(
    process.env.LUMINA_COAST_SOAK !== '1',
    'Set LUMINA_COAST_SOAK=1 for the real-time ten-minute drive',
  );
  test.setTimeout(720000);
  const log = watchConsole(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/coast.html?shore=boulevard&view=drive&tier=high');
  await page.waitForFunction(() => ((window as any).coastDemo?.vehicles.car?.speed ?? 0) > 2);
  await page.exposeFunction(
    'logDriveSample',
    (sample: { seconds: number; distance: number; lap: number; tiles: number }) => {
      console.log(
        'Coast drive progress',
        Math.round(sample.seconds),
        Math.round(sample.distance),
        sample.lap,
        sample.tiles,
      );
    },
  );
  const report = await page.evaluate(async () => {
    const d = (window as any).coastDemo,
      w = d.world,
      car = d.vehicles.car,
      T = (window as any).THREE;
    const x = d.road.road.x - 0.38,
      z = d.road.road.z - 85;
    const start = new T.Vector3(x, d.road.heightAt(x, z) + 0.55, z),
      r = 16;
    car.chassis.setTranslation(start, true);
    car.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    car.chassis.setLinvel({ x: 0, y: 0, z: 6 }, true);
    car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    w.engine.physics.snap(car.chassis);
    let resets = 0;
    const reset = car.reset.bind(car);
    car.reset = () => {
      resets++;
      reset();
    };
    car.path = { type: 'circle', center: new T.Vector2(start.x + r, start.z), radius: r, clockwise: true };
    car.targetSpeed = 6;
    car.autopilot = true;
    const sentinel = d.prints[2];
    w.sediment.imprint('foot', sentinel.x, sentinel.z, 0, 0.18, 0.32);
    const initial = w.sediment.inspect(sentinel.x, sentinel.z).relief,
      prev = start.clone();
    const samples: any[] = [],
      begin = performance.now();
    let last = begin,
      next = begin + 10000,
      distance = 0,
      hitches = 0,
      frames = 0,
      onRoad = 0,
      onSand = 0,
      laps = 0,
      away = false,
      heights = 0;
    await new Promise<void>((done) => {
      function frame(now: number) {
        const p = car.root.position;
        distance += p.distanceTo(prev);
        prev.copy(p);
        frames++;
        if (now - last > 50) hitches++;
        last = now;
        if (d.road.onRoad(p.x, p.z)) onRoad++;
        else onSand++;
        if (p.distanceTo(start) > 22) away = true;
        else if (away && p.distanceTo(start) < 10) {
          laps++;
          away = false;
        }
        heights = Math.max(heights, p.y);
        if (now >= next) {
          next += 10000;
          const pools = ['spray', 'mist', 'dust'].map((k) => w.fx[k].mesh.count);
          samples.push({
            seconds: (now - begin) / 1000,
            distance,
            lap: laps,
            x: p.x,
            z: p.z,
            tiles: w.sediment.tiles.size,
            heap: (performance as any).memory?.usedJSHeapSize ?? null,
            geometry: w.engine.renderer.info.memory.geometries,
            textures: w.engine.renderer.info.memory.textures,
            scale: w.engine.stats.renderScale,
            particles: pools,
          });
          void (window as any).logDriveSample(samples[samples.length - 1]);
        }
        if (now - begin >= 600000) done();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    const saved = w.sediment.save(),
      returned = w.sediment.inspect(sentinel.x, sentinel.z).relief;
    return {
      seconds: (last - begin) / 1000,
      frames,
      resets,
      fps: (frames * 1000) / (last - begin),
      distance,
      laps,
      onRoad,
      onSand,
      hitches,
      initial,
      returned,
      saveBytes: new TextEncoder().encode(JSON.stringify(saved)).length,
      samples,
    };
  });
  const dir = process.env.LUMINA_CAPTURE_DIR ?? 'qa/output/coastal-soak';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'drive.json'), JSON.stringify({ ...report, errors: log.errors }, null, 2));
  console.log('Coast drive', report.seconds, report.distance, report.laps, report.fps, report.saveBytes);
  expect(report.seconds).toBeGreaterThanOrEqual(600);
  expect(report.resets).toBe(0);
  expect(report.distance).toBeGreaterThan(1000);
  expect(report.laps).toBeGreaterThan(3);
  expect(report.onSand).toBeGreaterThan(400);
  expect(report.onRoad).toBeGreaterThan(400);
  expect(Math.max(...report.samples.map((s) => s.tiles))).toBeLessThanOrEqual(384);
  expect(report.returned).toBeCloseTo(report.initial, 3);
  expect(log.errors).toEqual([]);
});
