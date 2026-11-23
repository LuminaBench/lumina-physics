/**
 * Reusable TSL PBR brushed & heat-tinted titanium material.
 *
 * Engineered for aerospace exhausts, turbine shrouds, armor plates and precision hardware:
 *  - Directional brushed grain bump + subtle machined micro-scratches
 *  - Thin-film heat-temper iridescence (raw silver → straw gold → violet → cobalt blue)
 *  - Thermal blackbody incandescence when `temperature` exceeds Draper point
 *  - Wet sheen & HDR local firelight reflection
 */
import { surfaceClimateNode } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { blackbody, spriteNoise } from '../../engine/noise';
import {
  attachMaterialControls,
  fireLightBounce,
  perturbNormalHeight,
  triplanarNoise,
  specularAARoughness,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const { uniform, float, vec2, vec3, positionLocal, positionWorld, normalWorld, mix, smoothstep } = TSL;

export interface TitaniumMaterialOptions extends SharedMaterialOptions {
  /** Base raw titanium alloy albedo (default cool satin silver 0xb6bcc2). */
  color?: THREE.ColorRepresentation;
  /** Base satin roughness (default 0.28). */
  roughness?: number;
  /** Metalness (default 0.96). */
  metalness?: number;
  /** Brushed streak frequency (default 36). */
  brushScale?: number;
  /** 0..1 heat-temper oxidation tint (0 = raw, 0.35 = straw gold, 0.65 = violet-blue, 1 = dark blue-grey). */
  heatTint?: number;
  /** 0..1 live glowing thermal heat (0 = cold, 0.5 = cherry red, 1 = bright orange-yellow). */
  temperature?: number;
  /** 0..1 surface wear & fine scratches (default 0.2). */
  wear?: number;
  /** 0..1 surface wetness (default 0). */
  wetness?: number;
}

export type TitaniumMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, TitaniumMaterialOptions>;

export function createTitaniumMaterial(options: TitaniumMaterialOptions = {}): TitaniumMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.iridescence = 1;
  material.iridescenceIOR = 1.85;
  material.clearcoat = 1;

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0xb6bcc2)),
    scale: uniform(options.scale ?? 1),
    roughness: uniform(options.roughness ?? 0.28),
    metalness: uniform(options.metalness ?? 0.96),
    brushScale: uniform(options.brushScale ?? 36),
    heatTint: uniform(options.heatTint ?? 0.28),
    temperature: uniform(options.temperature ?? 0),
    wear: uniform(options.wear ?? 0.2),
    wetness: uniform(options.wetness ?? 0),
    fireLightGain: uniform(options.fireLightGain ?? 1.15),
  };
  const climate=surfaceClimateNode(positionWorld);
  const film=u.wetness.max(climate.y);
  const hot=u.temperature.max(climate.x.sub(220).div(900).clamp(0,1));

  const p = positionLocal.mul(u.scale);
  const Nw = normalWorld;

  // Directional brushed grain (high frequency across axis, stretched along grain).
  const brushA = spriteNoise(vec2(p.x.mul(u.brushScale), p.z.mul(u.brushScale.mul(0.08)).add(p.y.mul(u.brushScale.mul(0.5)))), 0);
  const brushB = spriteNoise(vec2(p.y.mul(u.brushScale), p.x.mul(u.brushScale.mul(0.08)).add(p.z.mul(u.brushScale.mul(0.5)))), 1);
  const brush = mix(brushA, brushB, smoothstep(0.3, 0.7, Nw.x.abs()));
  const scratches = smoothstep(0.76, 0.93, triplanarNoise(p, Nw, 14.0, 1)).mul(u.wear);

  // Heat-temper oxidation rainbow band: raw silver → straw gold → purple → cobalt blue → dark oxide.
  const heatVar = triplanarNoise(positionWorld, Nw, 0.85, 0).sub(0.5).mul(0.28);
  const ht = u.heatTint.max(climate.x.sub(175).div(570).clamp(0,1)).add(heatVar).clamp(0, 1);
  const straw = vec3(0.86, 0.72, 0.44);
  const violet = vec3(0.46, 0.34, 0.72);
  const blue = vec3(0.24, 0.44, 0.78);
  const oxide = vec3(0.24, 0.26, 0.29);

  let tint: N = mix(u.color, straw, smoothstep(0.06, 0.32, ht));
  tint = mix(tint, violet, smoothstep(0.32, 0.58, ht));
  tint = mix(tint, blue, smoothstep(0.58, 0.8, ht));
  tint = mix(tint, oxide, smoothstep(0.82, 1.0, ht));
  const albedo = tint.mul(mix(float(0.88), float(1.12), brush)).add(vec3(0.14).mul(scratches));

  const height = brush.mul(0.0028).sub(scratches.mul(0.004));
  const perturbedNormal = perturbNormalHeight(height, float(1));

  const rawRough = u.roughness.add(brush.sub(0.5).mul(0.12)).sub(scratches.mul(0.08)).clamp(0.08, 0.75);
  const wetRough = mix(rawRough, float(0.06), film);
  const finalRough = specularAARoughness(perturbedNormal, wetRough, 0.22, 0.12);

  // Incandescent glow above threshold temperature + HDR local firelight glint.
  const thermalGlow = blackbody(hot.mul(1.05)).mul(smoothstep(0.18, 0.55, hot)).mul(0.85);
  const fireGlow = fireLightBounce(albedo, finalRough, u.metalness, u.fireLightGain, options.fireLighting !== false);

  material.colorNode = albedo;
  material.metalnessNode = u.metalness.mul(mix(float(1), float(0.75), smoothstep(0.82, 1.0, ht)));
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.iridescenceNode = smoothstep(0.08, 0.45, ht).mul(0.85);
  material.iridescenceThicknessNode = mix(float(160), float(520), ht);
  material.clearcoatNode = film.mul(0.85);
  material.clearcoatRoughnessNode = float(0.04);
  material.emissiveNode = thermalGlow.add(fireGlow);

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, TitaniumMaterialOptions>(
    material,
    'titanium',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.roughness !== undefined) u.roughness.value = partial.roughness;
      if (partial.metalness !== undefined) u.metalness.value = partial.metalness;
      if (partial.brushScale !== undefined) u.brushScale.value = partial.brushScale;
      if (partial.heatTint !== undefined) u.heatTint.value = partial.heatTint;
      if (partial.temperature !== undefined) u.temperature.value = partial.temperature;
      if (partial.wear !== undefined) u.wear.value = partial.wear;
      if (partial.wetness !== undefined) u.wetness.value = partial.wetness;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
