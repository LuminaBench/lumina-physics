import { expect, test } from '@playwright/test';
import { Vector2 } from 'three/webgpu';
import { GritBed, GritWheel } from '../modules/wet-road/wheel-grit';

const options = { x: -0.6, z: -1, cellSize: 0.05, columns: 24, rows: 200 };

test('finite fine and coarse loads follow a tire through a wet bed, dry exit and clean water at three cadences', () => {
  function crossing(hz: number) {
    const bed = new GritBed(options);
    const wheel = new GritWheel(bed, 0.23, 28);
    const dryWheel = new GritWheel(bed, 0.23);
    const stock = new Vector2();
    for (let j = 0; j < 32; j++)
      for (let i = 0; i < 6; i++) bed.deposit(-0.16 + i * 0.05, 0.02 + j * 0.05, 9, 4);
    const before = bed.total(stock).clone();
    let maximum = 0;
    for (let i = 0; i <= 5 * hz; i++) {
      const z = -0.8 + (2 * i) / hz;
      const wet = z < 1.6;
      const flush = z > 6.5;
      wheel.update(0.01, z, 1, wet ? 0.0012 : 0.0002, wet ? 0.001 : flush ? 0.023 : 0, 0, 0.3);
      dryWheel.update(0.46, z, 1, 0, 0, 0, 0.3);
      expect(wheel.fine + wheel.coarse).toBeLessThanOrEqual(wheel.capacity + 1e-8);
      maximum = Math.max(maximum, wheel.fine + wheel.coarse);
    }
    expect([dryWheel.fine, dryWheel.coarse]).toEqual([0, 0]);
    const deposited = new Vector2();
    for (let j = 0; j < 50; j++) deposited.add(bed.sample(0.01, 2.01 + j * 0.05, stock));
    expect(maximum).toBeGreaterThan(25);
    expect(deposited.x).toBeGreaterThan(1);
    expect(deposited.y).toBeGreaterThan(0.5);
    const after = bed.total(stock).add(bed.exported);
    expect(after.x + wheel.fine).toBeCloseTo(before.x, 8);
    expect(after.y + wheel.coarse).toBeCloseTo(before.y, 8);
    expect(wheel.fine + wheel.coarse).toBeLessThan(0.8);
    bed.dispose();
    return deposited;
  }
  const middle = crossing(60);
  for (const hz of [30, 120]) expect(crossing(hz).distanceTo(middle)).toBeLessThan(0.2);
});

test('independent decks, wheel lift, teleports and sparse saves preserve the finite material', () => {
  const ground = new GritBed(options),
    deck = new GritBed(options);
  const wheel = new GritWheel(ground, 0.22);
  wheel.restore({ fine: 30, coarse: 10 });
  wheel.update(0, 0, 1, 0, 0, 0, 0.3);
  wheel.update(0, 5, 1, 0, 0, 0, 0.3);
  for (let i = 0; i < 20; i++) wheel.update(0, 5 + i * 0.02, 1, 0, 0, 0, 0.3, deck);
  const mass = new Vector2();
  expect(ground.total(mass).length()).toBe(0);
  expect(deck.total(mass).length()).toBeGreaterThan(1);
  const save = JSON.parse(JSON.stringify(deck.save()));
  expect(() => deck.restore({ ...save, cells: [...save.cells, 0, -1, 0] })).toThrow();
  expect(deck.save()).toEqual(save);
  const oldWheel = wheel.save();
  wheel.update(0, 1, 0, 0, 0, 0, 0.3);
  wheel.unload();
  expect(deck.sample(0, 5.38, mass).x).toBeGreaterThanOrEqual(oldWheel.fine);
  expect(deck.sample(0, 1, mass).length()).toBe(0);
  expect(deck.total(mass).x).toBeCloseTo(30, 10);
  deck.restore(save);
  wheel.restore(oldWheel);
  wheel.lift();
  wheel.update(0, 2, 1, 0, 0, 0, 0.3, deck);
  expect(wheel.save()).toEqual(oldWheel);
  expect(deck.save()).toEqual(save);
  ground.dispose();
  deck.dispose();
});
