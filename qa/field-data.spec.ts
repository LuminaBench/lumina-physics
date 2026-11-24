import { test, expect } from '@playwright/test';
import { AuthoredLandscape } from '../modules/landscape/authored';
import { chalkStreamGarden } from '../examples/landscape/chalk-stream';
import { createLandLibrary } from '../modules/landscape/collection';
import { regionalRiver, watershedClimate, watershedHeight } from '../modules/landscape/earth';
import { resolveWorldProfile } from '../modules/weather/world-profile';

test('revision one resolves the same native metadata and custom dependencies on reload', () => {
  const library = createLandLibrary();
  for (const region of library.ids('region'))
    for (const direction of library.ids('direction')) {
      const doc = {
        profileVersion: 1 as const,
        seed: 99,
        landscape: { revision: 1 as const, region, direction },
      };
      const saved = resolveWorldProfile(doc, library);
      expect(resolveWorldProfile(doc)).toEqual(saved);
    }
  const { library: custom, landscape } = chalkStreamGarden(),
    first = new AuthoredLandscape(landscape, 1, { library: custom });
  expect(first.dependencies).toContain('cover/game:wood-bluebell');
  const overrides = {
    ...landscape,
    dependencies: first.dependencies,
    seeds: { ...first.seeds, flowers: 333 },
  };
  const next = new AuthoredLandscape(overrides, 1, { library: custom });
  expect(next.surface.heights).toEqual(first.surface.heights);
  expect(next.seeds.trees).toBe(first.seeds.trees);
  expect(first.flowerMask).toBeDefined();
  const cells = first.flowerMask!.image.data!;
  expect(cells.some((v) => v === 255)).toBe(true);
  expect(cells.some((v) => v === 0)).toBe(true);
  expect(() => new AuthoredLandscape(overrides, 1)).toThrow('game:chalk-stream');
  expect(() => first.library.define('plant', 'game:bad', { height: -1 }, 'lumina:oak')).toThrow();
  first.dispose();
  next.dispose();
});

test('slope sends a pulse downhill, traffic persists, and sheltered snow thaws into film', () => {
  const size = 40,
    segments = 20,
    map = {
      size,
      segments,
      heights: Float32Array.from({ length: (segments + 1) ** 2 }, (_, k) => 5 - (k % (segments + 1)) * 0.14),
    };
  const land = new AuthoredLandscape({ revision: 1, region: 'lumina:winter-ground' }, 81, { heightmap: map });
  const e = land.earth;
  e.sunlight = 0;
  const cold = e.inspect(0, 0);
  e.sunlight = 0.97;
  const thaw = e.inspect(0, 0);
  expect(thaw.slush).toBeGreaterThan(cold.slush);
  expect(thaw.snow).toBeLessThan(cold.snow);
  expect(thaw.film).toBeGreaterThan(cold.film);
  e.stamp(-3, 1, 0.4, 0.8);
  const once = e.inspect(-3, 1);
  e.stamp(-3, 1, 0.4, 0.8);
  expect(e.inspect(-3, 1).compaction).toBeGreaterThan(once.compaction);
  const before = e.save();
  e.discharge(0, 0, 0.095, 0.06);
  for (let i = 0; i < 48; i++) e.update(0.25);
  const edited = e.save().cells.filter((c) => c.water > 0.0003);
  expect(edited.some((c) => c.x > 0.18)).toBe(true);
  expect(edited.every((c) => Number.isFinite(c.water) && c.water >= 0 && c.water <= 0.12)).toBe(true);
  e.setRain(1);
  for (let i = 0; i < 30; i++) e.update(0.5);
  const storm = e.wetnessAt(5, 5);
  e.setRain(0);
  for (let i = 0; i < 180; i++) e.update(0.5);
  expect(e.wetnessAt(5, 5)).toBeLessThan(storm * 0.7);
  e.restore(before);
  expect(e.save()).toEqual(before);
  land.dispose();
});

test('regional rivers connect through the divide and change climate on its lee side', () => {
  const seed = 170,
    west = -1200,
    east = 50;
  expect(regionalRiver(east, seed, 1)).toBe(regionalRiver(east, seed));
  expect(regionalRiver(west, seed, 1)).toBeGreaterThan(regionalRiver(west, seed) + 200);
  const z = regionalRiver(west, seed);
  expect(watershedHeight(west, z, seed)).toBeLessThan(watershedHeight(west, z + 52, seed));
  expect(watershedClimate(east, 0, seed)).toBeGreaterThan(watershedClimate(west, 400, seed));
});
