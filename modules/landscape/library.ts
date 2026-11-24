import type { BufferGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import type { FlowerHead, FlowerWriter } from './flowers';
import type { PlantForm, Species } from '../vegetation/botany';
import type { Biome } from '../terrain/biomes';
import type { N } from '../../engine/tsl';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Soil = 'loam' | 'clay' | 'gravel' | 'sand' | 'peat' | 'snow' | 'asphalt';
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];
export interface PlantRecipe {
  form: Species;
  height: number;
  breadth: number;
  lean: number;
  crownBase: number;
  limbs: number;
  depth: number;
  bark: string;
  foliage: string;
  leafWidth: number;
  barkPattern?: 'grooves' | 'lenticels' | 'rings' | 'scales';
  flex: number;
  evergreen: boolean;
  variants: number;
  shrub: boolean;
  grow?: (form: PlantForm, seed: number) => PlantForm;
  drawLeaves?: (ctx: CanvasRenderingContext2D, seed: number) => void;
}
export interface CoverRecipe {
  height: number;
  width: number;
  bend: number;
  dry: number;
  stemColor: string;
  petalColor: string;
  petals: number;
  radius: number;
  bell: number;
  spacing: number;
  bladeForm?: 'ribbon' | 'frond' | 'round' | 'spike';
  flowerHead?: (head: FlowerHead, writer: FlowerWriter) => void;
  minimumShade?: number;
  patchSize?: number;
  recoverySeconds?: number;
  bloom: Season[];
  geometry?: (seed: number, detail: number) => BufferGeometry;
}
export interface RockRecipe {
  light: string;
  dark: string;
  bedding: number;
  fracture: number;
  relief: number;
}
export interface DirectionRecipe {
  foliage: string;
  ground: string;
  water: string;
  sky: string;
  bands: number;
  cloudBands: number;
  foamBands: number;
  transmission: number;
  emission: number;
  saturation: number;
  contrast: number;
  exposure: number;
  temperature: number;
  leafShader?: (color: N, material: MeshStandardNodeMaterial) => N;
}
export interface Site {
  x: number;
  z: number;
  height: number;
  slope: number;
  moisture: number;
  exposure: number;
  shade: number;
}
export interface Habitat {
  plant: string;
  weight: number;
  minMoisture?: number;
  maxMoisture?: number;
  maxHeight?: number;
  minHeight?: number;
  maxSlope?: number;
}
export type Landform =
  | 'wood'
  | 'snowfield'
  | 'marsh'
  | 'wash'
  | 'farm'
  | 'mountain'
  | 'street'
  | 'fans'
  | 'watershed'
  | 'shore'
  | 'uplands';
export interface RegionRecipe {
  biome: Biome;
  form: Landform;
  soil: Soil;
  rock: string;
  cover: string;
  direction: string;
  plants: Habitat[];
  rainfall: number;
  canopy: number;
  grass: number;
  relief: number;
  latitude: number;
  season: Season;
  time: number;
  shape?: (x: number, z: number, baseHeight: number, seed: number) => number;
  place?: (site: Site, recipeId: string) => number;
}
export interface LandDefinitions {
  plant: PlantRecipe;
  cover: CoverRecipe;
  rock: RockRecipe;
  direction: DirectionRecipe;
  region: RegionRecipe;
}
export type Family = keyof LandDefinitions;
type Entry<K extends Family> = { value: Readonly<LandDefinitions[K]>; parent?: string; own: string[] };
export class LandLibrary {
  private readonly definitions = new Map<string, Entry<Family>>();
  define<K extends Family>(family: K, id: string, value: LandDefinitions[K]): this;
  define<K extends Family>(family: K, id: string, value: Partial<LandDefinitions[K]>, parent: string): this;
  define<K extends Family>(family: K, id: string, value: Partial<LandDefinitions[K]>, parent?: string): this {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(id))
      throw new Error('Expected namespace:name, received ' + id);
    const key = family + '/' + id;
    if (this.definitions.has(key)) throw new Error('Duplicate ' + key);
    const base = parent ? this.get(family, parent) : undefined;
    const merged = { ...base, ...value } as LandDefinitions[K];
    // Copy nested data before freezing: project authors may reuse the input arrays.
    for (const [name, field] of Object.entries(merged)) {
      if (Array.isArray(field))
        Object.assign(merged, {
          [name]: Object.freeze(
            field.map((item) => (item && typeof item === 'object' ? Object.freeze({ ...item }) : item)),
          ),
        });
    }
    for (const [name, v] of Object.entries(merged)) {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError(key + ' invalid ' + name);
      if (typeof v === 'string' && v.startsWith('#') && !/^#[0-9a-f]{6}$/i.test(v))
        throw new RangeError(key + ' invalid color ' + name);
    }
    validateRecipe(family, merged);
    this.definitions.set(key, { value: Object.freeze(merged), parent, own: Object.keys(value) });
    return this;
  }
  get<K extends Family>(family: K, id: string): Readonly<LandDefinitions[K]> {
    const entry = this.definitions.get(family + '/' + id);
    if (!entry)
      throw new Error(
        'Missing ' +
          family +
          ' recipe "' +
          id +
          '". Register its project definition before loading this world.',
      );
    return entry.value as Readonly<LandDefinitions[K]>;
  }
  ids(family: Family) {
    return [...this.definitions.keys()]
      .filter((k) => k.startsWith(family + '/'))
      .map((k) => k.slice(family.length + 1));
  }
  describe<K extends Family>(family: K, id: string) {
    const value = this.get(family, id),
      entry = this.definitions.get(family + '/' + id)!;
    return {
      id,
      family,
      parent: entry.parent,
      overridden: [...entry.own],
      inherited: Object.keys(value).filter((k) => !entry.own.includes(k)),
      value,
    };
  }
}
function validateRecipe<K extends Family>(family: K, value: LandDefinitions[K]) {
  function range(n: number, lo: number, hi: number, integer = false) {
    if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n)))
      throw new RangeError('Invalid ' + family + ' value ' + n + ' (expected ' + lo + ' to ' + hi + ')');
  }
  if (family === 'plant') {
    const p = value as PlantRecipe;
    range(p.height, 0.05, 85);
    range(p.breadth, 0.03, 32);
    range(p.limbs, 1, 64, true);
    range(p.depth, 0, 3, true);
    range(p.variants, 1, 4, true);
    range(p.crownBase, 0, 0.9);
    range(p.leafWidth, 0.1, 4);
    range(p.lean, -1, 1);
    range(p.flex, 0, 1);
    if (!['oak', 'willow', 'fern', 'cypress', 'palm', 'sagebrush', 'heather', 'gorse'].includes(p.form))
      throw new RangeError('Unknown plant form ' + p.form);
  } else if (family === 'cover') {
    const c = value as CoverRecipe;
    range(c.height, 0.015, 4);
    range(c.petals, 3, 16, true);
    range(c.spacing, 3, 512, true);
    range(c.radius, 0.003, 0.25);
    range(c.bell, -2, 2);
    range(c.width, 0.001, 0.2);
    range(c.minimumShade ?? 0, 0, 1);
    range(c.patchSize ?? 16, 1, 256);
    range(c.recoverySeconds ?? 78, 1, 1800);
    if (!c.bloom.every((s) => SEASONS.includes(s))) throw new RangeError('Invalid bloom season');
  } else if (family === 'region') {
    const r = value as RegionRecipe;
    range(r.canopy, 0, 1);
    range(r.grass, 0, 1);
    range(r.latitude, -90, 90);
    range(r.time, 0, 23.9999);
    range(r.rainfall, 0, 1);
    range(r.relief, 0.01, 10);
    for (const h of r.plants) {
      range(h.weight, 0, 1000);
      range(h.minMoisture ?? 0, 0, 1);
      range(h.maxMoisture ?? 1, h.minMoisture ?? 0, 1);
    }
  } else if (family === 'rock') {
    const r = value as RockRecipe;
    range(r.relief, 0, 2);
    range(r.fracture, 0, 1);
    range(r.bedding, 0, 64);
  } else if (family === 'direction') {
    const d = value as DirectionRecipe;
    for (const n of [d.bands, d.cloudBands, d.foamBands, d.transmission, d.emission]) range(n, 0, 1);
    for (const n of [d.saturation, d.contrast, d.exposure]) range(n, 0, 3);
    range(d.temperature, -1, 1);
  }
}
export function seedFor(seed: number, key: string) {
  let v = seed >>> 0;
  for (let i = 0; i < key.length; i++) v = Math.imul(v ^ key.charCodeAt(i), 16777619);
  return (v ^ (v >>> 16)) >>> 0;
}
export const landId = (name: string) => 'lumina:' + name;
