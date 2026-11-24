import { CoastalAttachment, type CoastalHostOptions } from '../../modules/coast/host';
import { SANDS, type SandRecipe } from '../../modules/coast/coastline';

/** Game-owned materials for one heightmap. Keep the terrain and contact IDs when changing the mix. */
export const TRAIL_SOILS = {
  riverSilt: {
    ...SANDS.ochre,
    grainMm: 0.055,
    angularity: 0.16,
    packing: 0.46,
    paleFraction: 0.07,
    heavyFraction: 0.09,
    pale: '#b6ac88',
    mineral: '#756c50',
    heavy: '#494438',
    drainageSeconds: 96,
  },
  redDirt: {
    ...SANDS.ochre,
    grainMm: 0.24,
    angularity: 0.44,
    packing: 0.64,
    paleFraction: 0.08,
    heavyFraction: 0.18,
    pale: '#c99563',
    mineral: '#a15436',
    heavy: '#593f35',
    drainageSeconds: 43,
  },
  gravel: {
    ...SANDS.basalt,
    grainMm: 4.8,
    angularity: 0.86,
    packing: 0.76,
    paleFraction: 0.28,
    heavyFraction: 0.19,
    pale: '#c1b3a0',
    mineral: '#817a70',
    heavy: '#504b48',
    drainageSeconds: 12,
  },
} satisfies Record<string, SandRecipe>;
export function attachInlandTrack(
  soil: keyof typeof TRAIL_SOILS,
  host: Pick<CoastalHostOptions, 'heightAt' | 'deckAt' | 'rainAt' | 'save' | 'retainAt'>,
  seed: number,
) {
  return new CoastalAttachment({
    ...host,
    coast: {
      seed,
      sand: TRAIL_SOILS[soil],
      shoreline: [
        [-18, -60],
        [-18, 60],
      ],
      heightAt: host.heightAt,
      inlet: false,
    },
    surf: { size: 96, resolution: 97 },
  });
}
