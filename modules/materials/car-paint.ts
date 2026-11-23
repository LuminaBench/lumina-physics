/**
 * Reusable TSL PBR automotive metallic / pearlescent clearcoat car paint material.
 *
 * Dual-layer automotive finish:
 *  - Metallic base coat with Fresnel colour flop (base → flop hue at grazing angles)
 *  - High-frequency 3D sparkling metallic micro-flakes
 *  - Glossy automotive clearcoat with subtle orange-peel micro-texture & rain beading
 *  - Optional road grime / dust accumulation and HDR local firelight reflection glint
 */
import { surfaceWetnessNode } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { hash33 } from '../../engine/noise';
import {
  attachMaterialControls,
  fireLightBounce,
  perturbNormalHeight,
  triplanarDetail,
  triplanarNoise,
  specularAARoughness,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const { uniform, float, vec3, positionWorld, positionLocal, normalWorld, cameraPosition, normalize, dot, pow, mix, smoothstep, floor, max } = TSL;

export interface CarPaintMaterialOptions extends SharedMaterialOptions {
  /** Primary pigment colour at facing angles (default crimson metallic 0xb81822). */
  color?: THREE.ColorRepresentation;
  /** Grazing-angle flop / pearl colour (default deep burgundy 0x2b050d). */
  flopColor?: THREE.ColorRepresentation;
  /** 0..1 Fresnel flop blend weight (default 0.65). */
  flopStrength?: number;
  /** Base coat metalness (default 0.72). */
  metalness?: number;
  /** Base coat roughness underneath clearcoat (default 0.24). */
  roughness?: number;
  /** Metallic flake density scale (default 140). */
  flakeScale?: number;
  /** 0..1 metallic flake sparkle brightness (default 0.45). */
  flakeIntensity?: number;
  /** 0..1 automotive clearcoat intensity (default 1.0). */
  clearcoat?: number;
  /** Clearcoat gloss roughness (default 0.04). */
  clearcoatRoughness?: number;
  /** 0..1 road dirt / dust coating (default 0). */
  dirt?: number;
  /** 0..1 rain / water beading on the clearcoat (default 0). */
  wetness?: number;
}

export type CarPaintMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, CarPaintMaterialOptions>;

export function createCarPaintMaterial(options: CarPaintMaterialOptions = {}): CarPaintMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.clearcoat = 1;

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0xb81822)),
    flopColor: uniform(new THREE.Color(options.flopColor ?? 0x2b050d)),
    flopStrength: uniform(options.flopStrength ?? 0.65),
    metalness: uniform(options.metalness ?? 0.72),
    roughness: uniform(options.roughness ?? 0.24),
    flakeScale: uniform(options.flakeScale ?? 140),
    flakeIntensity: uniform(options.flakeIntensity ?? 0.45),
    clearcoat: uniform(options.clearcoat ?? 1.0),
    clearcoatRoughness: uniform(options.clearcoatRoughness ?? 0.04),
    dirt: uniform(options.dirt ?? 0),
    wetness: uniform(options.wetness ?? 0),
    fireLightGain: uniform(options.fireLightGain ?? 1.1),
  };
  const film = u.wetness.max(surfaceWetnessNode(positionWorld));

  const Nw = normalize(normalWorld);
  const V = normalize(cameraPosition.sub(positionWorld));
  const ndv = max(dot(Nw, V), 0.02);

  // Two-tone metallic Fresnel flop (bright highlight face, rich shifted grazing flop).
  const flop = pow(float(1).sub(ndv), 2.4).mul(u.flopStrength);
  const basePigment = mix(u.color, u.flopColor, flop);

  // 3D hashed metallic micro-flakes in local space so flakes stick to moving car panels.
  const flakeCell = floor(positionLocal.mul(u.flakeScale));
  const flakeHash = hash33(flakeCell);
  const flakeNormal = normalize(Nw.add(flakeHash.sub(0.5).mul(0.55)));
  const flakeSparkle = pow(max(dot(flakeNormal, V), 0), 10).mul(smoothstep(0.45, 0.96, flakeHash.x));
  const flakeColor = basePigment.mul(float(1).add(flakeSparkle.mul(u.flakeIntensity).mul(1.8)));

  // Optional road dust / mud film dulls both metalness and clearcoat.
  const grimeNoise = triplanarDetail(positionWorld, Nw, 2.2);
  const dirtMask = smoothstep(0.25, 0.78, grimeNoise).mul(u.dirt);
  const dirtColor = vec3(0.22, 0.19, 0.15);
  const albedo = mix(flakeColor, dirtColor, dirtMask.mul(0.85));

  // Subtle automotive orange-peel + water beading micro-bump on the clearcoat.
  const orangePeel = triplanarNoise(positionLocal, Nw, 32.0, 0).mul(0.0012);
  const waterBeads = smoothstep(0.68, 0.86, triplanarNoise(positionLocal, Nw, 48.0, 1)).mul(film).mul(0.0045);
  const coatNormal = perturbNormalHeight(orangePeel.add(waterBeads), float(1));

  const metal = mix(u.metalness, float(0.05), dirtMask);
  const baseRough = mix(u.roughness.sub(flakeSparkle.mul(0.06)).clamp(0.08, 0.9), float(0.86), dirtMask);
  const finalRough = specularAARoughness(coatNormal, baseRough, 0.2, 0.1);
  const coatRough = mix(u.clearcoatRoughness, float(0.015), film);

  const fireGlow = fireLightBounce(albedo, coatRough.add(0.06), metal, u.fireLightGain, options.fireLighting !== false);

  material.colorNode = albedo;
  material.metalnessNode = metal;
  material.roughnessNode = finalRough;
  material.normalNode = coatNormal;
  material.clearcoatNode = u.clearcoat.mul(float(1).sub(dirtMask.mul(0.85)));
  material.clearcoatRoughnessNode = coatRough;
  material.emissiveNode = fireGlow;

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, CarPaintMaterialOptions>(
    material,
    'carPaint',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.flopColor !== undefined) (u.flopColor.value as THREE.Color).set(partial.flopColor);
      if (partial.flopStrength !== undefined) u.flopStrength.value = partial.flopStrength;
      if (partial.metalness !== undefined) u.metalness.value = partial.metalness;
      if (partial.roughness !== undefined) u.roughness.value = partial.roughness;
      if (partial.flakeScale !== undefined) u.flakeScale.value = partial.flakeScale;
      if (partial.flakeIntensity !== undefined) u.flakeIntensity.value = partial.flakeIntensity;
      if (partial.clearcoat !== undefined) u.clearcoat.value = partial.clearcoat;
      if (partial.clearcoatRoughness !== undefined) u.clearcoatRoughness.value = partial.clearcoatRoughness;
      if (partial.dirt !== undefined) u.dirt.value = partial.dirt;
      if (partial.wetness !== undefined) u.wetness.value = partial.wetness;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
