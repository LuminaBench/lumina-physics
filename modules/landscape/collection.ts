import { bellFlower, seedSpike } from './flowers';
import presets from './presets.json' with { type: 'json' };
import { Vector3 } from 'three/webgpu';
import { SPECIES, type PlantForm } from '../vegetation/botany';
import {
  LandLibrary,
  landId as id,
  type PlantRecipe,
  type CoverRecipe,
  type RegionRecipe,
  type DirectionRecipe,
  type RockRecipe,
} from './library';

export function propRoots(form: PlantForm, seed: number) {
  const h = form.height,
    start = seed % 31;
  for (let i = 0; i < 9; i++) {
    const a = start + i * 2.4,
      reach = h * (0.22 + 0.03 * (i % 3));
    const point = (r: number, y: number) => new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    form.wood.push({
      path: [
        point(0, h * 0.31),
        point(reach * 0.5, h * 0.27),
        point(reach * 0.93, h * 0.12),
        point(reach, -0.15),
      ],
      base: h * 0.026,
      end: h * 0.006,
    });
  }
  return form;
}
export function createLandLibrary() {
  const lib = new LandLibrary();
  const sizes = {
    cypress: [8.4, 2.38, 34],
    oak: [7.3, 3.9, 13],
    palm: [8.4, 3.6, 15],
    willow: [7.5, 3.6, 18],
    gorse: [1.45, 1.15, 11],
    fern: [0.95, 1.05, 11],
    sagebrush: [0.93, 0.93, 12],
    heather: [0.58, 0.55, 17],
  };
  for (const form of SPECIES) {
    const [height, breadth, limbs] = sizes[form],
      shrub = height < 2;
    lib.define('plant', id(form), {
      form,
      height,
      breadth,
      limbs,
      lean: form === 'palm' || form === 'cypress' ? 0.18 : 0.058,
      crownBase: shrub ? 0.06 : 0.2,
      depth: form === 'oak' ? 2 : 1,
      bark: '#674e3c',
      foliage: form === 'sagebrush' ? '#a7b5a1' : '#bdcba6',
      leafWidth: 1,
      flex: form === 'fern' ? 0.085 : 0.034,
      evergreen: !['oak', 'willow', 'fern'].includes(form),
      variants: shrub ? 1 : 2,
      shrub,
    });
  }
  const plant = (name: string, parent: string, values: Partial<PlantRecipe>) =>
    lib.define('plant', id(name), values, id(parent));
  plant('birch', 'oak', {
    height: 10.4,
    breadth: 2.15,
    limbs: 16,
    crownBase: 0.36,
    barkPattern: 'lenticels',
    bark: '#c6c2ad',
    foliage: '#c8de8a',
    lean: 0.08,
    leafWidth: 0.73,
  });
  plant('spruce', 'cypress', {
    barkPattern: 'scales',
    grow(form) {
      for (const leaf of form.leaves) {
        const reach = Math.hypot(leaf.tip.x, leaf.tip.z);
        leaf.tip.y -= reach * 0.21;
        leaf.span *= 0.81;
      }
      return form;
    },
    height: 12.5,
    breadth: 2.95,
    limbs: 40,
    crownBase: 0.09,
    lean: 0.018,
    bark: '#514034',
    foliage: '#6b8e79',
    leafWidth: 0.72,
  });
  plant('orchard', 'oak', {
    grow(form) {
      for (const limb of form.wood)
        for (const p of limb.path) {
          p.y = Math.min(p.y, 2.87 + 0.13 * Math.sin(p.x * 4));
        }
      for (const spray of form.leaves) {
        spray.tip.y = Math.min(spray.tip.y, 3.08);
        spray.root.y = Math.min(spray.root.y, 2.94);
      }
      return form;
    },
    height: 3.35,
    breadth: 2.85,
    limbs: 7,
    crownBase: 0.31,
    depth: 2,
    foliage: '#b4cf89',
  });
  plant('dwarf-pine', 'cypress', {
    height: 1.85,
    breadth: 2.32,
    limbs: 17,
    crownBase: 0.07,
    lean: 0.29,
    shrub: true,
    foliage: '#769781',
  });
  plant('mangrove', 'willow', {
    height: 4.2,
    breadth: 2.7,
    crownBase: 0.42,
    evergreen: true,
    leafWidth: 1.43,
    grow: propRoots,
  });
  plant('alien-fan', 'palm', {
    height: 4.4,
    breadth: 3.15,
    limbs: 7,
    lean: 0.27,
    foliage: '#7cbac5',
    bark: '#655774',
    leafWidth: 1.8,
    grow(form) {
      for (const s of form.leaves) {
        s.tip.y += s.span * 0.85;
        s.span *= 1.45;
      }
      return form;
    },
  });
  const base: CoverRecipe = {
    height: 0.44,
    width: 0.012,
    bend: 0.44,
    dry: 0.12,
    stemColor: '#85974d',
    petalColor: '#e9dfbc',
    petals: 7,
    radius: 0.025,
    bell: 0.17,
    spacing: 19,
    bloom: ['spring', 'summer'],
    geometry: undefined,
  };
  lib.define('cover', id('meadow'), base);
  const cover = (name: string, values: Partial<CoverRecipe>) =>
    lib.define('cover', id(name), values, id('meadow'));
  cover('bluebells', {
    flowerHead: bellFlower,
    minimumShade: 0.38,
    patchSize: 16,
    height: 0.31,
    petalColor: '#777ccf',
    petals: 6,
    bell: -1.35,
    radius: 0.027,
    spacing: 9,
    bloom: ['spring'],
  });
  cover('marram', { height: 0.69, width: 0.008, bend: 0.68, dry: 0.42, spacing: 67 });
  cover('sedge', {
    height: 0.75,
    width: 0.014,
    bend: 0.21,
    stemColor: '#829648',
    petalColor: '#ab8850',
    spacing: 37,
  });
  cover('stubble', { height: 0.16, width: 0.009, bend: 0.09, dry: 0.85, stemColor: '#b79a59', spacing: 159 });
  cover('steppe', { height: 0.34, width: 0.006, bend: 0.48, dry: 0.78, stemColor: '#b6a763', spacing: 81 });
  cover('turf', { height: 0.105, width: 0.009, bend: 0.22, petals: 5, spacing: 37, stemColor: '#879758' });
  cover('alpine', { height: 0.19, width: 0.007, bend: 0.13, petalColor: '#975fa1', spacing: 23, petals: 5 });
  cover('frost', { height: 0.23, stemColor: '#a5b5ac', dry: 0.55, spacing: 187 });
  cover('rushes', {
    flowerHead: seedSpike,
    bladeForm: 'spike',
    height: 0.88,
    width: 0.006,
    bend: 0.13,
    dry: 0.23,
    petalColor: '#926f48',
    spacing: 29,
  });
  cover('cattails', {
    flowerHead: seedSpike,
    bladeForm: 'spike',
    height: 1.21,
    width: 0.017,
    bend: 0.23,
    stemColor: '#6e884e',
    spacing: 73,
  });
  cover('clover', {
    bladeForm: 'round',
    height: 0.12,
    width: 0.021,
    bend: 0.25,
    petals: 12,
    radius: 0.014,
    spacing: 6,
    petalColor: '#ded1c5',
  });
  cover('seed-heads', {
    flowerHead: seedSpike,
    bladeForm: 'spike',
    height: 0.81,
    width: 0.007,
    bend: 0.55,
    dry: 0.63,
    petals: 3,
    radius: 0.018,
    bell: 1.3,
    spacing: 11,
  });
  cover('fern-floor', {
    bladeForm: 'frond',
    height: 0.33,
    width: 0.028,
    bend: 0.81,
    minimumShade: 0.44,
    dry: 0.04,
    bloom: [],
  });
  cover('heather', {
    flowerHead: bellFlower,
    bladeForm: 'frond',
    height: 0.38,
    width: 0.006,
    bend: 0.2,
    petals: 4,
    radius: 0.013,
    bell: -0.72,
    spacing: 4,
    petalColor: '#bf879f',
    bloom: ['summer', 'autumn'],
  });
  cover('fan-herbs', {
    height: 0.58,
    width: 0.035,
    bend: 0.58,
    petalColor: '#65e0ce',
    petals: 3,
    bell: 0.95,
    radius: 0.068,
    spacing: 13,
    bloom: ['spring', 'summer', 'autumn', 'winter'],
  });
  const rocks: Record<string, RockRecipe> = {
    slate: { light: '#786f65', dark: '#364550', bedding: 4.7, fracture: 0.77, relief: 0.13 },
    granite: { light: '#a99c91', dark: '#47515a', bedding: 0.36, fracture: 0.78, relief: 0.19 },
    chalk: { light: '#d2cbb1', dark: '#878375', bedding: 1.7, fracture: 0.38, relief: 0.085 },
    sandstone: { light: '#c7956e', dark: '#794d40', bedding: 3.4, fracture: 0.51, relief: 0.16 },
    volcanic: { light: '#766c79', dark: '#383641', bedding: 0.74, fracture: 0.95, relief: 0.18 },
  };
  for (const [name, rock] of Object.entries(rocks)) lib.define('rock', id(name), rock);
  for (const [key, entry] of Object.entries(presets.direction)) {
    if ('parent' in entry) lib.define('direction', key, entry.values, entry.parent);
    else lib.define('direction', key, entry.values as DirectionRecipe);
  }
  for (const [key, entry] of Object.entries(presets.region)) {
    if ('parent' in entry) lib.define('region', key, entry.values as Partial<RegionRecipe>, entry.parent);
    else lib.define('region', key, entry.values as RegionRecipe);
  }
  return lib;
}
