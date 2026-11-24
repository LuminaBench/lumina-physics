import type { DuneOptions } from '../../modules/coast/mobile-dune';

/** A game-owned pale pumice lens inside a sloping, dark volcanic sand bank. */
export function pumiceBank(x: number, z: number, seed = 8257): DuneOptions {
  return {
    centerX: x,
    centerZ: z,
    size: 8.8,
    resolution: 129,
    seed,
    thicknessAt(wx, wz) {
      const u = (wx - x) / 2.6,
        v = (wz - z) / 1.2;
      return 0.49 * Math.exp(-u * u - v * v) * (1 + 0.16 * Math.sin(u + v));
    },
    coarseFractionAt(wx, wz) {
      return 0.16 + 0.09 * Math.sin(0.94 * (wx - x) - 0.8 * (wz - z));
    },
    coarseMobility: 0.28,
    rippleHeading: -0.7,
    lens: {
      topDepthAt(wx, wz) {
        return 0.125 + 0.052 * Math.tanh((wx - x) * 1.05 - (wz - z) * 0.56);
      },
      thicknessAt(wx, wz) {
        return 0.094 + 0.022 * Math.sin((wx - x) * 2 + (wz - z) * 0.81);
      },
      coarseFraction: 0.77,
      contactWidthM: 0.016,
      mineral: '#ab9271',
      pale: '#f1dfb6',
    },
  };
}
