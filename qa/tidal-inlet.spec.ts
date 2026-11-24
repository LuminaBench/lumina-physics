import { test, expect } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { TidalInlet } from '../modules/water/tidal-inlet';
import { WrackDrift } from '../modules/water/wrack-drift';

const survey = {
  x: 0,
  z: 0,
  spacing: 0.55,
  columns: 32,
  rows: 12,
  seaEdge: 'west' as const,
  seaLevel: -0.16,
  bedAt(x: number, z: number) {
    const bank = 0.42 * Math.min(1, Math.abs(z - 3.3) / 3.3) ** 2;
    const sill = 0.69 * Math.exp(-((x - 5.3) ** 2) / 1.2);
    return -0.44 + bank + sill;
  },
  bedSiltAt: () => 0.12,
  roughness: 0.043,
  settlingMps: 0.004,
};

test('a surveyed sill holds a perched pool, reverses flow and conserves water and mobile sediment', () => {
  function cross(hz: number) {
    const inlet = new TidalInlet(survey);
    const current = new Vector3();
    let peakFlood = 0,
      peakEbb = 0;
    const tide = (t: number) =>
      t <= 4
        ? -0.16
        : t < 10
          ? -0.16 + (0.84 * (t - 4)) / 6
          : t <= 23
            ? 0.68
            : t < 30
              ? 0.68 - (0.99 * (t - 23)) / 7
              : -0.31;
    let early = 0,
      high = 0,
      maxSilt = 0;
    for (let i = 1; i <= hz * 52; i++) {
      const t = i / hz;
      inlet.update(1 / hz, tide(t));
      if (i === 4 * hz) {
        early = inlet.balance().waterM3;
        expect(inlet.stir(4.8, 3.3, 2)).toBe(0);
      }
      if (i === 16 * hz) expect(inlet.stir(7.2, 3.3, 0.03)).toBeCloseTo(0.03, 10);
      if (i === 23 * hz) high = inlet.stageAt(13, 3.3, -2);
      const u = inlet.applyCurrent(6.5, 3.3, current.set(0, 0, 0)).x;
      if (t < 23) peakFlood = Math.max(peakFlood, u);
      if (t > 24) peakEbb = Math.min(peakEbb, u);
      maxSilt = Math.max(maxSilt, inlet.concentrationAt(8.5, 3.3));
    }
    inlet.update(0.016, -0.31);
    const saved = inlet.save(),
      restored = new TidalInlet(survey);
    try {
      restored.restore(saved);
      const actual = inlet.applyCurrent(6.5, 3.3, new Vector3());
      const resumed = restored.applyCurrent(6.5, 3.3, new Vector3());
      expect(actual.distanceTo(resumed)).toBeLessThan(1e-9);
      const b = inlet.balance();
      const reading = {
        peakFlood,
        peakEbb,
        maxSilt,
        early,
        high,
        retained: inlet.stageAt(13, 3.3, -0.31),
        ...b,
      };
      expect(early).toBeCloseTo(inlet.initialVolume, 7);
      expect(reading.high).toBeGreaterThan(0.38);
      expect(reading.retained).toBeGreaterThan(-0.05);
      expect(peakFlood).toBeGreaterThan(0.1);
      expect(peakEbb).toBeLessThan(-0.1);
      expect(maxSilt).toBeGreaterThan(0.0001);
      expect(Math.abs(b.waterErrorM3)).toBeLessThan(1e-8);
      expect(Math.abs(b.sedimentErrorKg)).toBeLessThan(1e-8);
      expect(inlet.stageAt(-8, 3.3, -0.31)).toBe(-0.31);
      expect(inlet.applyCurrent(-8, 3.3, current.set(4, 3, 2)).toArray()).toEqual([4, 3, 2]);
      for (let i = 0; i < 20; i++) {
        inlet.update(1 / 60, 0.12);
        restored.update(1 / 60, 0.12);
      }
      expect(restored.save()).toEqual(inlet.save());
      const broken = restored.save();
      broken.water[0] += 1;
      expect(() => restored.restore(broken)).toThrow(/balance/);
      expect(restored.save()).toEqual(inlet.save());
      return reading;
    } finally {
      inlet.dispose();
      restored.dispose();
    }
  }
  const slow = cross(30),
    fast = cross(120);
  expect(slow.floodM3).toBeCloseTo(fast.floodM3, 6);
  expect(slow.retained).toBeCloseTo(fast.retained, 7);
  console.log('sill and tide', fast);
});

test('a stranded branch refloats, stops on a sloping bed and lifts again at a higher stage', () => {
  let stage = 0.1;
  const surface = {
    ground: (x: number) => Math.max(0, x - 1) * 0.3,
    stage: () => stage,
    current: (_x: number, _z: number, out: Vector3) => out.set(0.8, 0, 0),
  };
  const twig = new WrackDrift(surface, 0.12);
  twig.reset(0, 0);
  twig.update(1);
  expect(twig.grounded).toBe(true);
  expect(twig.position.x).toBe(0);
  stage = 0.48;
  twig.update(9);
  expect(twig.grounded).toBe(true);
  expect(twig.position.x).toBeCloseTo(2.2, 3);
  const at = twig.position.clone();
  twig.update(2);
  expect(twig.position.equals(at)).toBe(true);
  stage = 0.485;
  twig.update(1);
  expect(twig.position.equals(at)).toBe(true);
  stage = 0.72;
  twig.update(0.8);
  expect(twig.grounded).toBe(false);
  expect(twig.position.x).toBeGreaterThan(at.x + 0.25);
});
