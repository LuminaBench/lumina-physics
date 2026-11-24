import { test, expect } from '@playwright/test';
import { Coastline, SANDS } from '../modules/coast/coastline';
import { CoastalSurf } from '../modules/coast/surf';
import { CoastalSediment, sedimentReading } from '../modules/coast/sediment';

import { WeatherFront } from '../modules/weather/front';
import { CoastalAttachment } from '../modules/coast/host';
import { ImmersionFilm, PAINT_FILM, FABRIC_FILM } from '../modules/coast/immersion';

const plane = (x: number) => 0.062 * x;
function beach(barrierAt?: (x: number, z: number) => number) {
  const coast = new Coastline({
    seed: 194,
    shoreline: [
      [0, -100],
      [0, 100],
    ],
    heightAt: plane,
    inlet: false,
    sand: SANDS.quartz,
  });
  const surf = new CoastalSurf(coast, { size: 64, resolution: 129, period: 8, barrierAt });
  return { coast, surf, soil: new CoastalSediment(coast, surf, { ground: plane, barrierAt, maxTiles: 100 }) };
}

test('one swash selectively fills and erodes sole impressions, then releases water downhill', () => {
  const { soil, surf } = beach();
  try {
    const xs = [0.8, 4, 7.1],
      initial: number[] = [],
      peak = xs.map(() => 0);
    for (const x of xs) {
      soil.imprint('foot', x, 0.02, 0, 0.16, 0.32);
      initial.push(soil.inspect(x, 0.02).relief);
    }
    for (let i = 0; i < 240; i++) {
      soil.update(1 / 12, 3.9, 0, 0, 0.47);
      xs.forEach((x, j) => (peak[j] = Math.max(peak[j], soil.inspect(x, 0.02).water)));
    }
    const final = xs.map((x) => ({ ...soil.inspect(x, 0.02) }));
    expect(peak[0]).toBeGreaterThan(0.15);
    expect(peak[1]).toBeGreaterThan(0.008);
    expect(peak[2]).toBeLessThan(0.002);
    expect(Math.abs(final[0].relief)).toBeLessThan(Math.abs(initial[0]) * 0.4);
    expect(Math.abs(final[1].relief)).toBeLessThan(Math.abs(initial[1]) * 0.85);
    expect(final[2].relief).toBeCloseTo(initial[2], 4);
    expect(final[0].lastWet).toBe('sea');
    expect(final[2].lastWet).toBe('none');
    const saved = soil.save(),
      expected = final[1].relief;
    soil.update(0.25, 35, 22, 0, 0.62);
    soil.restore(saved);
    expect(soil.inspect(xs[1], 0.02).relief).toBeCloseTo(expected, 3);
  } finally {
    surf.dispose();
  }
});

test('a raised continuous wall protects a low hollow while the shore in front receives the same wave', () => {
  const ground = (x: number) => (x < 0 ? x * 0.1 : 0.03);
  const coast = new Coastline({
    seed: 3,
    shoreline: [
      [0, -80],
      [0, 80],
    ],
    heightAt: ground,
  });
  const surf = new CoastalSurf(coast, {
    size: 64,
    resolution: 129,
    barrierAt: (x) => (Math.abs(x - 2) < 0.55 ? 2 : -Infinity),
  });
  const soil = new CoastalSediment(coast, surf, { ground });
  let before = 0,
    behind = 0;
  try {
    for (let t = 0; t < 10; t += 0.1) {
      soil.time = t;
      before = Math.max(before, soil.inspect(0.2, 0, sedimentReading()).water);
      behind = Math.max(behind, soil.inspect(4.2, 0, sedimentReading()).water);
    }
    expect(before).toBeGreaterThan(0.15);
    expect(behind).toBe(0);
  } finally {
    surf.dispose();
  }
});

test('a natural sill retains seawater after the tidal head drops', () => {
  const ground = (x: number, z: number) =>
    x < 0 ? 0.06 * x : 0.18 - 0.22 * Math.exp(-((x - 3) ** 2 + z * z) / 0.75);
  const coast = new Coastline({
    seed: 13,
    shoreline: [
      [0, -80],
      [0, 80],
    ],
    heightAt: ground,
    inlet: false,
  });
  const surf = new CoastalSurf(coast, { size: 24, resolution: 193 });
  const soil = new CoastalSediment(coast, surf, { ground });
  try {
    for (let i = 0; i < 12; i++) soil.update(1 / 12, 3, 0, 0.26, 0);
    const full = soil.inspect(3, 0).water;
    for (let i = 0; i < 108; i++) soil.update(1 / 12, 3, 0, -0.2, 0);
    expect(full).toBeGreaterThan(0.25);
    expect(soil.inspect(3, 0).water).toBeGreaterThan(0.12);
    expect(soil.inspect(5, 0).water).toBeLessThan(0.012);
  } finally {
    surf.dispose();
  }
});

test('the same ground and wheel attachment works inland with an elevated dry deck and no ocean renderer', () => {
  const ground = (x: number, z: number) => 1 + 0.033 * x + 0.03 * Math.sin(z);
  const world = new CoastalAttachment({
    coast: { seed: 7, inlet: false, sand: SANDS.ochre },
    heightAt: ground,
    surf: { size: 96, resolution: 49 },
    deckAt: (x, y, z) =>
      y > 3 ? { id: 'bridge', water: x < 0 && z < 0 ? 0.009 : 0, film: 0, soil: 0 } : undefined,
  });
  try {
    const left = world.wheel(),
      right = world.wheel();
    world.update(0.1, -2, 0, -20, 0);
    for (let x = -2; x < 2; x += 0.08) {
      left.sample(x, 4, -0.65, 1 / 60, 5, 1, Math.PI / 2);
      right.sample(x, 4, 0.65, 1 / 60, 5, 1, Math.PI / 2);
    }
    expect(left.film).toBeGreaterThan(0);
    expect(right.film).toBe(0);
    expect(world.sediment.inspect(1.5, -0.65).relief).toBe(0);
    left.sample(2, ground(2, -0.65), -0.65, 0.016, 4, 1, 0);
    expect(world.sediment.inspect(2, -0.65).relief).toBeLessThan(0);
  } finally {
    world.dispose();
  }
});

test('separated weather gauges and material-specific drainage retain their own state', () => {
  const front = new WeatherFront({ type: 'squall', seed: 82, span: 3600 });
  try {
    let wet = 0,
      dry = 1;
    for (let x = -1800; x < 1800; x += 50) {
      const rain = front.sample(x, 180, 5).rain;
      wet = Math.max(wet, rain);
      dry = Math.min(dry, rain);
    }
    expect(wet).toBeGreaterThan(0.65);
    expect(dry).toBeLessThan(0.02);
    const paint = new ImmersionFilm(PAINT_FILM),
      cloth = new ImmersionFilm(FABRIC_FILM);
    for (const film of [paint, cloth]) {
      film.update(2, 0.12);
      film.update(6, 0);
    }
    expect(cloth.absorbed).toBeGreaterThan(paint.absorbed);
    expect(cloth.film).toBeGreaterThan(paint.film);
    expect(paint.shedding).toBeGreaterThan(0);
    expect(cloth.wetHeight).toBeLessThan(cloth.band.top);
  } finally {
    front.dispose();
  }
});
