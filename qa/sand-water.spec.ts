import { expect, test } from '@playwright/test';
import { Coastline, SANDS } from '../modules/coast/coastline';
import { CoastalSurf } from '../modules/coast/surf';
import { CoastalSediment, SEDIMENT_SPACING } from '../modules/coast/sediment';
import { SandWaterColumn } from '../modules/coast/sand-water';

test('the wet surface loses its mirror while water remains in the grains, with all outflow accounted for', () => {
  const c = new SandWaterColumn({
    poreCapacityMm: 2,
    filmCapacityMm: 0.32,
    infiltrationMmS: 0.31,
    drainageSeconds: 23,
    evaporationMmS: 0.001,
  });
  let standing = 4,
    film = 0,
    pore = 0,
    lost = 0;
  let justFilm = false,
    justPores = false;
  for (let tick = 0; tick < 1500; tick++) {
    c.advance(standing, film, pore, 1 / 12);
    lost += c.drainedMm + c.evaporatedMm;
    standing = c.standingMm;
    film = c.filmMm;
    pore = c.poreMm;
    if (standing === 0 && film > 0.005) justFilm = true;
    if (justFilm && film === 0 && pore > 1.3) justPores = true;
    expect(standing + film + pore + lost).toBeCloseTo(4, 9);
  }
  expect(justPores).toBe(true);
  expect(pore).toBeLessThan(0.1);
  expect(() => c.advance(-1, 0, 0, 1)).toThrow();
  expect(() => new SandWaterColumn({ poreCapacityMm: 0 })).toThrow();
});

function bed(drainageSeconds: number, rainAt?: () => number) {
  const ground = () => 2;
  const coast = new Coastline({ seed: 173, heightAt: ground, sand: SANDS.quartz, inlet: false });
  const surf = new CoastalSurf(coast, { size: 24, resolution: 33 }, ground);
  const soil = new CoastalSediment(coast, surf, {
    ground,
    maxTiles: 100,
    rainAt,
    waterColumn: { drainageSeconds, poreCapacityMm: 1.7, evaporationMmS: 0 },
  });
  return { soil, surf };
}
test('a finite splash conserves litres across tile edges and exactly replays a partly drained patch', () => {
  const { soil, surf } = bed(1e12);
  try {
    soil.update(1 / 12, 0, 0, -5, 0);
    const x = 0.03,
      z = -0.02,
      litres = soil.wetPatch(x, z, 1.3, 4);
    const mass = () => {
      let all = 0;
      for (const t of soil.tiles.values())
        for (let i = 0; i < t.water.length; i++)
          all += (1000 * t.water[i] + t.film[i] + t.pore[i]) * SEDIMENT_SPACING ** 2;
      return all;
    };
    const sample = () =>
      Array.from({ length: 13 }, (_, i) => ({ ...soil.inspect(x - 0.73 + i * 0.11, z + 0.07) }));
    for (let i = 0; i < 9; i++) soil.update(1 / 12, 0, 0, -5, 0);
    expect(mass()).toBeCloseTo(litres, 5);
    soil.update(0.031, 0, 0, -5, 0);
    const save = JSON.parse(JSON.stringify(soil.save()));
    expect(save.version).toBe(2);
    expect(save.tiles.some((t: any) => t.columns)).toBe(true);
    const run = () => {
      for (let i = 0; i < 60; i++) soil.update(0.017, 0, 0, -5, 0);
      return sample();
    };
    const first = run();
    expect(mass()).toBeCloseTo(litres, 5);
    soil.restore(save);
    expect(run()).toEqual(first);
    const valid = soil.save(),
      tile = valid.tiles.find((t) => t.columns)!;
    expect(() => soil.restore({ ...valid, tiles: [{ ...tile, columns: { data: 'a' } }] })).toThrow();
    expect(() => soil.restore({ ...valid, hydrology: [1, 1, 1, 1, 1] })).toThrow();
    expect(sample()).toEqual(first);
  } finally {
    surf.dispose();
  }
});
test('old six-byte saves retain damp colour and relief, including cells with no standing water', () => {
  const { soil, surf } = bed(31);
  try {
    const bytes = new Uint8Array(6 * 1024);
    for (let i = 0; i < 1024; i++) bytes.set([118, 70, 127, 0, 0, 2], i * 6);
    const tile = { x: 0, z: 0, data: btoa(String.fromCharCode(...bytes)) };
    soil.restore({ version: 1, seed: 173, spacing: SEDIMENT_SPACING, time: 2, tiles: [tile] });
    const sample = soil.inspect(0.02, 0.02);
    expect(sample.relief).toBeCloseTo(-0.01, 6);
    expect(sample.poreSaturation).toBeCloseTo(127 / 255, 6);
    expect(sample.filmMm).toBe(0);
    expect(sample.water).toBe(0);
    expect(sample.lastWet).toBe('rain');
  } finally {
    surf.dispose();
  }
});
