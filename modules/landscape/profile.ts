import presets from './presets.json' with { type: 'json' };
import type { Biome } from '../terrain/biomes';

export type LandscapeSeason = 'spring' | 'summer' | 'autumn' | 'winter';
export interface LandscapeProfile {
  revision: 1;
  region: string;
  direction?: string;
  season?: LandscapeSeason;
  cover?: string;
  rock?: string;
  treeDensity?: number;
  shrubDensity?: number;
  meadowDensity?: number;
  flowerDensity?: number;
  seeds?: Partial<
    Record<'terrain' | 'trees' | 'meadow' | 'flowers' | 'rocks' | 'understory' | 'debris', number>
  >;
  dependencies?: string[];
  latitude?: number;
  dayOfYear?: number;
  northAzimuth?: number;
}

export interface RegionDefaults {
  biome: Biome;
  direction: string;
  grass: number;
  time: number;
}
export interface DirectionDefaults {
  water: string;
  foliage: string;
  sky: string;
  foamBands: number;
  cloudBands: number;
  temperature: number;
  saturation: number;
  contrast: number;
  exposure: number;
}
export interface LandscapeLookup {
  get(family: 'region', id: string): Readonly<RegionDefaults>;
  get(family: 'direction', id: string): Readonly<DirectionDefaults>;
}
function readDefaults(family: 'region' | 'direction', id: string): Record<string, unknown> {
  const entries: Record<string, { parent?: string; values: object }> = presets[family];
  const entry = Object.hasOwn(entries, id) ? entries[id] : undefined;
  if (!entry)
    throw new Error(
      'Missing ' +
        family +
        ' recipe "' +
        id +
        '". Register its project definition before loading this world.',
    );
  return { ...(entry.parent ? readDefaults(family, entry.parent) : {}), ...entry.values };
}
export const builtinLandscapeDefaults: LandscapeLookup = { get: readDefaults as LandscapeLookup['get'] };
