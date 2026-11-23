/**
 * Reusable TSL PBR Material Library for Three.js WebGPU + WebGL 2.
 *
 * Seven procedural physically-based materials with live reactive uniforms, triplanar
 * world-space detail, specular AA, optional Thermo/ThermalSurface coupling and HDR
 * local fire-light glints:
 *   - concrete       wet/dry concrete with pores, slab joints, puddles & rain ripples
 *   - asphalt        wet/dry asphalt with aggregate, tar cracks, wear & rain puddles
 *   - carPaint       metallic/pearlescent dual-layer automotive clearcoat with flakes
 *   - titanium       directional brushed alloy with thin-film heat-temper iridescence
 *   - timber         weathered/wet/charred 3D wood grain with plank seams & embers
 *   - seaSprayGlass  refractive marine glass with animated spray runners & salt crust
 *   - meltingIce     refractive glacial ice with internal fractures, bubbles & meltwater
 */
import { createConcreteMaterial, type ConcreteMaterial, type ConcreteMaterialOptions } from './concrete';
import { createAsphaltMaterial, type AsphaltMaterial, type AsphaltMaterialOptions } from './asphalt';
import { createCarPaintMaterial, type CarPaintMaterial, type CarPaintMaterialOptions } from './car-paint';
import { createTitaniumMaterial, type TitaniumMaterial, type TitaniumMaterialOptions } from './titanium';
import { createTimberMaterial, type TimberMaterial, type TimberMaterialOptions } from './timber';
import { createSeaSprayGlassMaterial, type SeaSprayGlassMaterial, type SeaSprayGlassOptions } from './sea-spray-glass';
import { createMeltingIceMaterial, type MeltingIceMaterial, type MeltingIceOptions } from './melting-ice';
import type { MaterialKind } from './common';

export * from './common';
export * from './concrete';
export * from './asphalt';
export * from './car-paint';
export * from './titanium';
export * from './timber';
export * from './sea-spray-glass';
export * from './melting-ice';

export interface MaterialOptionsMap {
  concrete: ConcreteMaterialOptions;
  asphalt: AsphaltMaterialOptions;
  carPaint: CarPaintMaterialOptions;
  titanium: TitaniumMaterialOptions;
  timber: TimberMaterialOptions;
  seaSprayGlass: SeaSprayGlassOptions;
  meltingIce: MeltingIceOptions;
}

export interface MaterialTypeMap {
  concrete: ConcreteMaterial;
  asphalt: AsphaltMaterial;
  carPaint: CarPaintMaterial;
  titanium: TitaniumMaterial;
  timber: TimberMaterial;
  seaSprayGlass: SeaSprayGlassMaterial;
  meltingIce: MeltingIceMaterial;
}

/** Unified factory for creating any material in the reusable TSL PBR library by kind. */
export function createMaterial<K extends MaterialKind>(
  kind: K,
  options?: MaterialOptionsMap[K],
): MaterialTypeMap[K] {
  switch (kind) {
    case 'concrete': return createConcreteMaterial(options as ConcreteMaterialOptions) as MaterialTypeMap[K];
    case 'asphalt': return createAsphaltMaterial(options as AsphaltMaterialOptions) as MaterialTypeMap[K];
    case 'carPaint': return createCarPaintMaterial(options as CarPaintMaterialOptions) as MaterialTypeMap[K];
    case 'titanium': return createTitaniumMaterial(options as TitaniumMaterialOptions) as MaterialTypeMap[K];
    case 'timber': return createTimberMaterial(options as TimberMaterialOptions) as MaterialTypeMap[K];
    case 'seaSprayGlass': return createSeaSprayGlassMaterial(options as SeaSprayGlassOptions) as MaterialTypeMap[K];
    case 'meltingIce': return createMeltingIceMaterial(options as MeltingIceOptions) as MaterialTypeMap[K];
  }
}
