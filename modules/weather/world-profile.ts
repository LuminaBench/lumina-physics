import { builtinLandscapeDefaults, type LandscapeProfile, type LandscapeLookup } from '../landscape/profile';
import { QUALITY_TIERS, type QualityTier } from '../../engine/quality';
import palettes from './world-looks.json' with { type: 'json' };
import { BIOMES, type Biome } from '../terrain/biomes';

export const LOOK_NAMES = [
  'natural-daylight',
  'golden-coast',
  'cold-overcast',
  'painterly',
  'neon-night',
  'alien-dusk',
] as const;
export { BIOMES, type Biome } from '../terrain/biomes';
export const SKY_STATES = {
  clear: 'hotFair',
  mixed: 'tradeCumulus',
  overcast: 'overcastSwell',
  squall: 'storm',
} as const;
export type WorldLook = (typeof LOOK_NAMES)[number];
export type SeaState = 'still' | 'lagoon' | 'breeze' | 'swell' | 'storm' | 'hurricane';
type Palette = Omit<(typeof palettes.looks)[number], 'name'>;
export interface WorldValues extends Palette {
  seaState: SeaState;
  grassDensity: number;
}
export interface WorldProfile {
  profileVersion: 1;
  landscape?: LandscapeProfile;
  mode?: 'fresh' | 'attach';
  seed?: number;
  biome?: Biome;
  look?: WorldLook;
  weather?: keyof typeof SKY_STATES;
  /** Local solar hours on the spring equinox, at latitude 42° N. */
  time?: number;
  quality?: QualityTier | 'auto';
  locks?: (keyof WorldValues)[];
  overrides?: Partial<WorldValues>;
}
export type ResolvedWorldProfile = Required<Omit<WorldProfile, 'landscape'>> & {
  landscape?: LandscapeProfile;
  values: WorldValues;
  modules: string[];
  rationale: string[];
};
export type ProfilePatch = Partial<
  Omit<WorldProfile, 'profileVersion' | 'mode' | 'seed' | 'biome' | 'landscape'>
>;
const seaStates: SeaState[] = ['still', 'lagoon', 'breeze', 'swell', 'storm', 'hurricane'];
function checked<T>(choices: readonly T[], value: T, key: string): T {
  if (!choices.includes(value)) throw new RangeError('Unknown ' + key + ': ' + value);
  return value;
}

export function resolveWorldProfile(input: WorldProfile, library?: LandscapeLookup): ResolvedWorldProfile {
  if (input.profileVersion !== 1) throw new RangeError('Expected profileVersion 1');
  const authored = input.landscape;
  if (authored && authored.revision !== 1) throw new RangeError('Unknown landscape revision');
  const recipes = authored ? (library ?? builtinLandscapeDefaults) : undefined;
  const region = authored ? recipes!.get('region', authored.region) : undefined;
  const direction = region ? recipes!.get('direction', authored!.direction ?? region.direction) : undefined;
  const look = checked(LOOK_NAMES, input.look ?? 'natural-daylight', 'look');
  const biome = checked(BIOMES, region?.biome ?? input.biome ?? 'coastal-cliffs', 'biome');
  const weather = checked(
    Object.keys(SKY_STATES),
    input.weather ?? 'mixed',
    'weather',
  ) as keyof typeof SKY_STATES;
  const mode = checked(['fresh', 'attach'] as const, input.mode ?? 'fresh', 'mode');
  const quality = checked([...QUALITY_TIERS, 'auto'] as const, input.quality ?? 'auto', 'quality');
  const seed = input.seed ?? 7,
    time = input.time ?? region?.time ?? 15;
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isFinite(time) ||
    time < 0 ||
    time >= 24
  )
    throw new RangeError('Expected an unsigned 32-bit seed and local solar hours in [0, 24)');
  const { name, ...style } = palettes.looks.find((p) => p.name === look)!;
  const defaults: WorldValues = {
    ...style,
    ...(direction
      ? {
          waterTint: direction.water,
          foliageTint: direction.foliage,
          skyTint: direction.sky,
          foamBands: direction.foamBands,
          cloudBands: direction.cloudBands,
          temperature: direction.temperature,
          saturation: direction.saturation,
          contrast: direction.contrast,
          exposureBias: direction.exposure,
        }
      : {}),
    seaState: biome === 'coastal-cliffs' ? 'swell' : 'still',
    grassDensity: authored?.meadowDensity ?? region?.grass ?? (biome === 'dry-highlands' ? 0.22 : 0.66),
  };
  const overrides = { ...input.overrides },
    locks = [...new Set(input.locks ?? [])];
  for (const key of [...Object.keys(overrides), ...locks])
    if (!Object.hasOwn(defaults, key)) throw new RangeError('Unknown world value: ' + key);
  const values = { ...defaults, ...overrides };
  checked(seaStates, values.seaState, 'seaState');
  for (const key of ['waterTint', 'foliageTint', 'skyTint'] as const)
    if (!/^#[a-f0-9]{6}$/i.test(values[key])) throw new RangeError('Expected an RGB hex color for ' + key);
  for (const key of [
    'grassDensity',
    'foam',
    'foamBands',
    'cloudBands',
    'temperature',
    'tint',
    'saturation',
    'contrast',
    'exposureBias',
  ] as const) {
    const lo = key === 'temperature' || key === 'tint' ? -1 : 0;
    const hi = ['saturation', 'contrast', 'exposureBias'].includes(key) ? 3 : 1;
    if (!Number.isFinite(values[key]) || values[key] < lo || values[key] > hi)
      throw new RangeError('Out of range: ' + key);
  }
  const modules =
    mode === 'attach'
      ? ['rain']
      : ['weather', ...(biome === 'dry-highlands' ? [] : ['ocean']), 'terrain-surface', 'rain'];
  const rationale =
    mode === 'attach'
      ? ['Rain runs in the host scene and follows its camera.']
      : [
          'The clock and weather control the sky.',
          ...(biome === 'dry-highlands' ? [] : ['The seeded sea state controls displacement and buoyancy.']),
          'Terrain and plants use the selected biome.',
          'Rain follows the weather intensity.',
        ];
  // Store the effective lock values so a bare JSON round trip can reproduce a previous edit.
  for (const key of locks) Object.assign(overrides, { [key]: values[key] });
  return {
    profileVersion: 1,
    ...(authored ? { landscape: { ...authored, seeds: { ...authored.seeds } } } : {}),
    mode,
    seed,
    time,
    quality,
    biome,
    look,
    weather,
    overrides,
    locks,
    values,
    modules,
    rationale,
  };
}

export function patchWorldProfile(
  current: ResolvedWorldProfile,
  patch: ProfilePatch,
  library?: LandscapeLookup,
): ResolvedWorldProfile {
  for (const key of Object.keys(patch)) {
    if (!['look', 'weather', 'time', 'quality', 'locks', 'overrides'].includes(key))
      throw new RangeError('Cannot patch ' + key + ' on a live world');
  }
  const overrides = { ...current.overrides, ...patch.overrides };
  for (const key of patch.locks ?? current.locks) Object.assign(overrides, { [key]: current.values[key] });
  return resolveWorldProfile({ ...current, ...patch, overrides }, library);
}
