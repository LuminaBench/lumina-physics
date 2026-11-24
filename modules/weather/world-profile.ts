import { QUALITY_TIERS, type QualityTier } from '../../engine/quality';
import palettes from './world-looks.json';

export const LOOK_NAMES = ['natural-daylight', 'golden-coast', 'cold-overcast', 'painterly', 'neon-night', 'alien-dusk'] as const;
import { BIOMES, type Biome } from '../terrain/biomes';
export { BIOMES, type Biome } from '../terrain/biomes';
export const SKY_STATES = { clear: 'hotFair', mixed: 'tradeCumulus', overcast: 'overcastSwell', squall: 'storm' } as const;
export type WorldLook = typeof LOOK_NAMES[number];
export type SeaState = 'still' | 'lagoon' | 'breeze' | 'swell' | 'storm' | 'hurricane';
type Palette = Omit<typeof palettes.looks[number], 'name'>;
export interface WorldValues extends Palette {
  seaState: SeaState;
  grassDensity: number;
}
export interface WorldProfile {
  profileVersion: 1;
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
export type ResolvedWorldProfile = Required<WorldProfile> & {
  values: WorldValues;
  modules: string[];
  rationale: string[];
};
export type ProfilePatch = Partial<Omit<WorldProfile, 'profileVersion' | 'mode' | 'seed' | 'biome'>>;
const seaStates: SeaState[] = ['still', 'lagoon', 'breeze', 'swell', 'storm', 'hurricane'];
function checked<T>(choices: readonly T[], value: T, key: string): T {
  if (!choices.includes(value)) throw new RangeError('Unknown ' + key + ': ' + value);
  return value;
}

export function resolveWorldProfile(input: WorldProfile): ResolvedWorldProfile {
  if (input.profileVersion !== 1) throw new RangeError('Expected profileVersion 1');
  const look = checked(LOOK_NAMES, input.look ?? 'natural-daylight', 'look');
  const biome = checked(BIOMES, input.biome ?? 'coastal-cliffs', 'biome');
  const weather = checked(Object.keys(SKY_STATES), input.weather ?? 'mixed', 'weather') as keyof typeof SKY_STATES;
  const mode = checked(['fresh', 'attach'] as const, input.mode ?? 'fresh', 'mode');
  const quality = checked([...QUALITY_TIERS, 'auto'] as const, input.quality ?? 'auto', 'quality');
  const seed = input.seed ?? 7, time = input.time ?? 15;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(time) || time < 0 || time >= 24)
    throw new RangeError('Expected an unsigned 32-bit seed and local solar hours in [0, 24)');
  const { name, ...style } = palettes.looks.find(p => p.name === look)!;
  const defaults: WorldValues = { ...style, seaState: biome === 'coastal-cliffs' ? 'swell' : 'still',
    grassDensity: biome === 'dry-highlands' ? 0.22 : 0.66 };
  const overrides = { ...input.overrides }, locks = [...new Set(input.locks ?? [])];
  for (const key of [...Object.keys(overrides), ...locks])
    if (!Object.hasOwn(defaults, key)) throw new RangeError('Unknown world value: ' + key);
  const values = { ...defaults, ...overrides };
  checked(seaStates, values.seaState, 'seaState');
  for (const key of ['waterTint', 'foliageTint'] as const)
    if (!/^#[a-f0-9]{6}$/i.test(values[key])) throw new RangeError('Expected an RGB hex color for ' + key);
  for (const key of ['grassDensity','foam','foamBands','temperature','tint','saturation','contrast','exposureBias'] as const) {
    const lo = key === 'temperature' || key === 'tint' ? -1 : 0;
    const hi = ['saturation','contrast','exposureBias'].includes(key) ? 3 : 1;
    if (!Number.isFinite(values[key]) || values[key] < lo || values[key] > hi) throw new RangeError('Out of range: ' + key);
  }
  const modules = mode === 'attach' ? ['rain'] : ['weather', ...(biome === 'dry-highlands' ? [] : ['ocean']), 'terrain-surface', 'rain'];
  const rationale = mode === 'attach' ? ['Rain runs in the host scene and follows its camera.'] :
    ['The clock and weather control the sky.', 'The seeded sea state controls displacement and buoyancy.',
     'Terrain and plants use the selected biome.', 'Rain follows the weather intensity.'];
  // Store the effective lock values so a bare JSON round trip can reproduce a previous edit.
  for (const key of locks) Object.assign(overrides, { [key]: values[key] });
  return { profileVersion: 1, mode, seed, time, quality, biome, look, weather, overrides, locks, values, modules, rationale };
}

export function patchWorldProfile(current: ResolvedWorldProfile, patch: ProfilePatch): ResolvedWorldProfile {
  const overrides = { ...current.overrides, ...patch.overrides };
  for (const key of patch.locks ?? current.locks) Object.assign(overrides, { [key]: current.values[key] });
  return resolveWorldProfile({ ...current, ...patch, overrides });
}
