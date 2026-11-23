/**
 * Reusable TSL PBR wet/dry asphalt material.
 *
 * Designed for roads, runways, helipads, ramps and parking aprons: crushed mineral
 * aggregate sparkle, weathered tar binder, alligator micro-cracks, standing-water
 * puddles with animated rain ripples, clearcoat water sheen, specular AA and HDR fire glints.
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

const { uniform, float, vec3, positionWorld, normalWorld, mix, smoothstep, abs, max } = TSL;

export interface AsphaltMaterialOptions extends SharedMaterialOptions {
  /** Base dry asphalt colour (default charcoal 0x262729). */
  color?: THREE.ColorRepresentation;
  /** 0 = dry sun-bleached asphalt, 1 = dark rain-soaked asphalt (default 0.35). */
  wetness?: number;
  /** 0..1 standing-water puddle level (default 0.2). */
  puddle?: number;
  /** 0..1 active rain ripple intensity in puddles (default 0). */
  rain?: number;
  /** 0..1 traffic wear / exposed paler mineral aggregate (default 0.35). */
  wear?: number;
  /** 0..1 fine tar hairline cracks (default 0.25). */
  cracks?: number;
  /** Aggregate bump amplitude in metres (default 0.015). */
  bumpScale?: number;
}

export type AsphaltMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, AsphaltMaterialOptions>;

export function createAsphaltMaterial(options: AsphaltMaterialOptions = {}): AsphaltMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.metalness = 0;
  material.clearcoat = 1;

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0x262729)),
    scale: uniform(options.scale ?? 1),
    wetness: uniform(options.wetness ?? 0.35),
    puddle: uniform(options.puddle ?? 0.2),
    rain: uniform(options.rain ?? 0),
    wear: uniform(options.wear ?? 0.35),
    cracks: uniform(options.cracks ?? 0.25),
    bumpScale: uniform(options.bumpScale ?? 0.015),
    fireLightGain: uniform(options.fireLightGain ?? 1.25),
  };

  const p = positionWorld.mul(u.scale);
  const Nw = normalWorld;
  const upMask = smoothstep(0.6, 0.9, Nw.y);

  // Coarse tar patches, crushed stone aggregate and sharp hairline cracks.
  const patches = triplanarNoise(p, Nw, 0.18, 0);
  const stones = triplanarDetail(p, Nw, 14.5);
  const grit = triplanarNoise(p, Nw, 42.0, 1);
  const crackField = abs(triplanarNoise(p, Nw, 1.35, 1).sub(0.5));
  const crackMask = smoothstep(0.028, 0.004, crackField).mul(u.cracks);

  const stoneTint = mix(u.color.mul(0.65), u.color.mul(2.15), stones.mul(0.65).add(grit.mul(0.35)));
  let albedo: N = mix(u.color, stoneTint, u.wear.mul(0.65).add(0.35))
    .mul(mix(float(0.75), float(1.18), patches))
    .mul(mix(float(1.0), float(0.28), crackMask));

  const dryRough = mix(float(0.88), float(0.74), u.wear.mul(stones));
  const thermo = applyThermo(albedo, dryRough, vec3(0), u.wetness, options);
  albedo = thermo.color;
  const totalWet = thermo.wetness.clamp(0, 1);

  // Low tar basins hold glossy standing water puddles.
  const basin = float(1).sub(patches.mul(0.75).add(stones.mul(0.25)));
  const puddleMask = smoothstep(float(0.76).sub(u.puddle.mul(0.68)), float(0.92).sub(u.puddle.mul(0.68)), basin)
    .mul(smoothstep(0.01, 0.12, u.puddle))
    .mul(upMask);

  const wetAlbedo = albedo.mul(mix(float(1.0), float(0.38), max(totalWet, puddleMask)));
  const dampRough = mix(thermo.roughness, float(0.38), totalWet);
  const baseRough = mix(dampRough, float(0.025), puddleMask);

  const microH = stones.mul(0.6).add(grit.mul(0.4)).sub(crackMask.mul(0.75));
  const ripples = rainRippleHeight(positionWorld.xz, frame.time).mul(u.rain).mul(puddleMask).mul(0.009);
  const height = microH.mul(u.bumpScale).mul(float(1).sub(puddleMask.mul(0.92))).add(ripples);
  const perturbedNormal = perturbNormalHeight(height, float(1));

  const finalRough = specularAARoughness(perturbedNormal, baseRough, 0.28, 0.14);
  const fireGlow = fireLightBounce(wetAlbedo, finalRough, float(0), u.fireLightGain, options.fireLighting !== false);

  material.colorNode = wetAlbedo;
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.clearcoatNode = max(puddleMask, totalWet.mul(0.55));
  material.clearcoatRoughnessNode = mix(float(0.22), float(0.02), puddleMask);
  material.emissiveNode = thermo.emissive.add(fireGlow);

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, AsphaltMaterialOptions>(
    material,
    'asphalt',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.wetness !== undefined) u.wetness.value = partial.wetness;
      if (partial.puddle !== undefined) u.puddle.value = partial.puddle;
      if (partial.rain !== undefined) u.rain.value = partial.rain;
      if (partial.wear !== undefined) u.wear.value = partial.wear;
      if (partial.cracks !== undefined) u.cracks.value = partial.cracks;
      if (partial.bumpScale !== undefined) u.bumpScale.value = partial.bumpScale;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
