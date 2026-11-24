import { MathUtils } from 'three/webgpu';
import { Coastline, SANDS } from '../../modules/coast/coastline';
import type { ShoreRecipe } from './recipes';

const shore = new Coastline({
  seed: 4612,
  relief: 'mainland',
  inlet: false,
  sand: {
    ...SANDS.quartz,
    grainMm: 0.69,
    packing: 0.63,
    angularity: 0.56,
    mineral: '#897761',
    pale: '#c0ab85',
    heavy: '#484740',
    heavyFraction: 0.16,
  },
  beachSlope: 0.07,
  duneHeight: 3.4,
  shoreline: [
    [-2, -480],
    [0, 0],
    [2, 480],
  ],
});
const blend = MathUtils.smoothstep;
export const channelCentre = (x: number) => 8 + 0.85 * Math.sin((x + 22) * 0.13);

/** A survey in metres. The channel, bars and pool are the actual mesh and collision bed. */
export const ferryInlet: ShoreRecipe = {
  name: 'Shingle inlet and tidal pool',
  coast: {
    ...shore.options,
    heightAt(x, z) {
      const ground = shore.height(x, z);
      if (x < -42 || x > 24 || z < -16 || z > 33) return ground;
      const cross = Math.abs(z - channelCentre(x));
      const pool = Math.exp(-(((x + 1) / 9) ** 2));
      const side = Math.sign(z - channelCentre(x));
      const innerWidth =
        2.25 + pool * 1.65 + side * (0.32 * Math.sin(x * 0.53) + 0.23 * Math.sin(x * 0.27 + 0.75));
      const shoreward = blend(x, 7, 14);
      const bank = blend(cross, innerWidth, innerWidth + 3.8);
      const sill = 1.25 * Math.exp(-(((x + 14.3) / 2.65) ** 2));
      const floor = -0.99 - 0.18 * pool + sill;
      const ridge = 1.05 + 0.17 * Math.sin(0.35 * x + z * 0.21) + 0.1 * Math.cos(x * 0.73 - z * 0.5);
      const height = MathUtils.lerp(floor, ridge, Math.max(shoreward, bank));
      const influence = blend(x, -42, -31) * (1 - blend(x, 15, 24)) * (1 - blend(cross, 9, 21));
      return MathUtils.lerp(ground, height, influence);
    },
  },
  inlet: {
    x: -33,
    z: 0,
    columns: 80,
    rows: 27,
    spacing: 0.6,
    seaEdge: 'west',
    seaLevel: 0,
    mouthAt: (_x, z) => z > 3 && z < 13,
    roughness: 0.039,
    settlingMps: 0.003,
    bedSiltAt: (x, z) => 0.1 + 0.24 * (1 - blend(Math.abs(z - channelCentre(x)), 1.4, 3.9)),
  },
  gridFocus: { width: 100, segments: 168 },
  detail: { x: -5, z: 8, size: 74, resolution: 129 },
  clock: { latitudeDeg: 52, dayOfYear: 222, solarHour: 16.4 },
  front: { type: 'clearing', seed: 613, lifeSeconds: 260, windSpeed: 4.2, heading: 0.48, span: 5100 },
  swell: 'breeze',
  wave: 0.21,
  sky: { exposure: 0.62 },
  air: 'clear-post-front',
  town: false,
};
