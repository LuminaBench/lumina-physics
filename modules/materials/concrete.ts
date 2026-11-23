/**
 * Reusable TSL PBR wet/dry concrete material.
 *
 * Features seamless world-space triplanar aggregate & formwork variation, optional slab
 * expansion joints, porosity-based darkening when wet, standing-water puddle gloss with
 * clearcoat + animated rain ripples, optional Thermo scorch/ember coupling and HDR firelight.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import {
  attachMaterialControls,
  applyThermo,
  fireLightBounce,
  perturbNormalHeight,
  rainRippleHeight,
  triplanarDetail,
  triplanarNoise,
  specularAARoughness,
  frame,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const { uniform, float, vec3, positionWorld, normalWorld, mix, smoothstep, fract, abs, max } = TSL;

export interface ConcreteMaterialOptions extends SharedMaterialOptions {
  /** Base dry concrete colour (default warm weathered grey 0x8b8982). */
  color?: THREE.ColorRepresentation;
  /** 0 = bone dry, 1 = soaked dark concrete (default 0.15). */
  wetness?: number;
  /** 0..1 standing-water puddle coverage on horizontal faces (default 0). */
  puddle?: number;
  /** 0..1 active rain ripple intensity inside puddles (default 0). */
  rain?: number;
  /** Dry surface roughness (default 0.88). */
  roughness?: number;
  /** Slab expansion joint spacing in metres; 0 disables joints (default 4.0). */
  slabSize?: number;
  /** Micro-aggregate bump amplitude in metres (default 0.012). */
  bumpScale?: number;
}

export type ConcreteMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, ConcreteMaterialOptions>;

export function createConcreteMaterial(options: ConcreteMaterialOptions = {}): ConcreteMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.metalness = 0;
  material.clearcoat = 1;

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0x8b8982)),
    scale: uniform(options.scale ?? 1),
    wetness: uniform(options.wetness ?? 0.15),
    puddle: uniform(options.puddle ?? 0),
    rain: uniform(options.rain ?? 0),
    roughness: uniform(options.roughness ?? 0.88),
    slabSize: uniform(options.slabSize ?? 4.0),
    bumpScale: uniform(options.bumpScale ?? 0.012),
    fireLightGain: uniform(options.fireLightGain ?? 1),
  };

  const p = positionWorld.mul(u.scale);
  const Nw = normalWorld;
  const upMask = smoothstep(0.55, 0.88, Nw.y);

  // Multi-scale aggregate, formwork blotches and micro-pores.
  const blotch = triplanarDetail(p, Nw, 0.32);
  const aggregate = triplanarDetail(p, Nw, 5.2);
  const finePore = triplanarNoise(p, Nw, 22.0, 1);

  // Optional slab expansion joints on horizontal/wall faces.
  const hasSlabs = smoothstep(0.05, 0.2, u.slabSize);
  const slabInv = float(1).div(max(u.slabSize, 0.2));
  const gx = smoothstep(0.0, 0.014, abs(fract(positionWorld.x.mul(slabInv)).sub(0.5)).oneMinus().sub(0.5));
  const gz = smoothstep(0.0, 0.014, abs(fract(positionWorld.z.mul(slabInv)).sub(0.5)).oneMinus().sub(0.5));
  const jointMask = mix(float(1), gx.mul(gz), hasSlabs.mul(upMask));

  // Height field used both for pore-filling puddles and procedural bump.
  const microHeight = aggregate.mul(0.55).add(finePore.mul(0.3)).add(blotch.mul(0.15)).mul(mix(0.35, 1.0, jointMask));

  let albedo: N = u.color
    .mul(mix(float(0.76), float(1.16), blotch))
    .mul(mix(float(0.86), float(1.12), aggregate))
    .mul(mix(float(0.45), float(1.0), jointMask));

  const thermo = applyThermo(albedo, u.roughness, vec3(0), u.wetness, options);
  albedo = thermo.color;
  const totalWet = thermo.wetness.clamp(0, 1);

  // Standing water fills low micro-relief basins on horizontal surfaces first.
  const puddleMask = smoothstep(float(0.82).sub(u.puddle.mul(0.72)), float(0.98).sub(u.puddle.mul(0.72)), float(1).sub(blotch.mul(0.7).add(aggregate.mul(0.3))))
    .mul(smoothstep(0.01, 0.15, u.puddle))
    .mul(upMask);
  const film = max(puddleMask, totalWet.mul(0.45));

  // Porous concrete darkens significantly when saturated with water.
  const wetAlbedo = albedo.mul(mix(float(1.0), float(0.46), max(totalWet, puddleMask)));
  const dryRough = mix(thermo.roughness.mul(mix(0.88, 1.08, finePore)), float(0.36), totalWet);
  const baseRough = mix(dryRough, float(0.045), puddleMask);

  // Procedural bump fades smoothly under standing water while rain ripples appear on puddles.
  const ripples = TSL.Fn(()=>{
    const relief=float(0).toVar();
    TSL.If(u.rain.greaterThan(0.003).and(puddleMask.greaterThan(0.005)),()=>{
      relief.assign(rainRippleHeight(positionWorld.xz,frame.time).mul(u.rain).mul(puddleMask).mul(0.008));
    });
    return relief;
  })();
  const height = microHeight.mul(u.bumpScale).mul(float(1).sub(puddleMask.mul(0.88))).add(ripples);
  const perturbedNormal = perturbNormalHeight(height, float(1));

  const finalRough = specularAARoughness(perturbedNormal, baseRough, 0.25, 0.15);
  const fireGlow = fireLightBounce(wetAlbedo, finalRough, float(0), u.fireLightGain, options.fireLighting !== false);

  material.colorNode = wetAlbedo;
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.clearcoatNode = film.mul(0.95);
  material.clearcoatRoughnessNode = mix(float(0.26), float(0.03), puddleMask);
  material.emissiveNode = thermo.emissive.add(fireGlow);

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, ConcreteMaterialOptions>(
    material,
    'concrete',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.wetness !== undefined) u.wetness.value = partial.wetness;
      if (partial.puddle !== undefined) u.puddle.value = partial.puddle;
      if (partial.rain !== undefined) u.rain.value = partial.rain;
      if (partial.roughness !== undefined) u.roughness.value = partial.roughness;
      if (partial.slabSize !== undefined) u.slabSize.value = partial.slabSize;
      if (partial.bumpScale !== undefined) u.bumpScale.value = partial.bumpScale;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
