/**
 * Reusable TSL PBR weathered / wet / charred timber material.
 *
 * Features procedural 3D warped annual wood grain, optional plank grooves with per-plank
 * tonal variation, sun-bleached silvering (`weathering`), wet darkening & gloss sheen,
 * alligator-skin charring with glowing ember cracks, optional Thermo / ThermalSurface
 * coupling (ground boardwalks, stacked crates, timber walls) and HDR local firelight.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { blackbody, spriteNoise, valueNoise2 } from '../../engine/noise';
import {
  attachMaterialControls,
  applyThermo,
  fireLightBounce,
  perturbNormalHeight,
  triplanarNoise,
  specularAARoughness,
  frame,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const { uniform, float, vec2, vec3, positionWorld, normalWorld, mix, smoothstep, sin, fract, floor, abs, max } = TSL;

export interface TimberMaterialOptions extends SharedMaterialOptions {
  /** Base warm wood colour (default cedar/oak 0x7c5432). */
  color?: THREE.ColorRepresentation;
  /** Darker grain ring colour (default walnut 0x3b2413). */
  grainColor?: THREE.ColorRepresentation;
  /** Plank width in metres; 0 disables plank seams (default 0.24). */
  plankWidth?: number;
  /** 0 = fresh sawn timber, 1 = sun-bleached weathered driftwood grey (default 0.2). */
  weathering?: number;
  /** 0..1 moisture darkening and glossy sheen (default 0.1). */
  wetness?: number;
  /** 0..1 manual charring level (stacks cleanly with optional Thermo/ThermalSurface). */
  char?: number;
  /** 0..1 glowing ember intensity inside char cracks (default 0). */
  ember?: number;
  /** Dry wood roughness (default 0.82). */
  roughness?: number;
  /** Grain bump amplitude in metres (default 0.008). */
  bumpScale?: number;
}

export type TimberMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, TimberMaterialOptions>;

export function createTimberMaterial(options: TimberMaterialOptions = {}): TimberMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.metalness = 0;
  material.clearcoat = 1;

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0x7c5432)),
    grainColor: uniform(new THREE.Color(options.grainColor ?? 0x3b2413)),
    scale: uniform(options.scale ?? 1),
    plankWidth: uniform(options.plankWidth ?? 0.24),
    weathering: uniform(options.weathering ?? 0.2),
    wetness: uniform(options.wetness ?? 0.1),
    char: uniform(options.char ?? 0),
    ember: uniform(options.ember ?? 0),
    roughness: uniform(options.roughness ?? 0.82),
    bumpScale: uniform(options.bumpScale ?? 0.008),
    fireLightGain: uniform(options.fireLightGain ?? 1),
  };

  const p = positionWorld.mul(u.scale);
  const Nw = normalWorld;

  // Choose grain coordinates cleanly for both horizontal planks and vertical walls/posts.
  const isWall = smoothstep(0.45, 0.75, float(1).sub(abs(Nw.y)));
  const along = mix(p.z, p.y, isWall);
  const across = mix(p.x, mix(p.x, p.z, smoothstep(0.45, 0.75, abs(Nw.x))), isWall);

  // Optional plank seams and per-plank tone shift.
  const hasPlanks = smoothstep(0.02, 0.08, u.plankWidth);
  const invPlank = float(1).div(max(u.plankWidth, 0.05));
  const plankIdx = floor(across.mul(invPlank));
  const plankFrac = fract(across.mul(invPlank));
  const plankTone = mix(float(1), valueNoise2(vec2(plankIdx.mul(7.31), 2.1)).mul(0.38).add(0.76), hasPlanks);
  const seamGroove = mix(float(1), smoothstep(0.0, 0.045, abs(plankFrac.sub(0.5)).oneMinus().sub(0.5)), hasPlanks);

  // Organic warped wood growth rings + fine fibrous grain.
  const warp = spriteNoise(vec2(across.mul(2.1).add(plankIdx.mul(3.7)), along.mul(0.45)), 0).sub(0.5).mul(1.8);
  const rings = sin(across.mul(26.0).add(warp.mul(6.2831))).mul(0.5).add(0.5);
  const fibers = spriteNoise(vec2(across.mul(42.0).add(plankIdx.mul(5.1)), along.mul(2.2)), 1);
  const grain = rings.mul(0.58).add(fibers.mul(0.42));

  let wood: N = mix(u.grainColor, u.color, grain).mul(plankTone).mul(mix(float(0.28), float(1.0), seamGroove));
  // Sun-bleached coastal silvering.
  const bleached = vec3(0.44, 0.43, 0.4).mul(mix(0.82, 1.15, fibers));
  wood = mix(wood, bleached, u.weathering.mul(0.78));

  // Manual char + alligator cracks (additive with optional Thermo/ThermalSurface).
  const charNoise = triplanarNoise(p, Nw, 7.5, 0).mul(0.6).add(triplanarNoise(p, Nw, 23.0, 1).mul(0.4));
  const manualChar = smoothstep(0.18, 0.56, u.char.add(charNoise.sub(0.5).mul(0.35))).mul(smoothstep(0.001, 0.05, u.char));
  const charcoal = vec3(0.022, 0.02, 0.019).mul(mix(0.7, 1.45, charNoise));
  let albedo: N = mix(wood, charcoal, manualChar.mul(0.95));

  const manualCracks = smoothstep(0.54, 0.82, triplanarNoise(p.add(vec3(0, frame.time.mul(0.03), 0)), Nw, 28.0, 1));
  const manualFlicker = spriteNoise(vec2(across.mul(3.5), along.mul(3.5).sub(frame.time.mul(1.6))), 0).mul(0.45).add(0.65);
  const manualEmber = blackbody(u.ember.mul(0.95)).mul(manualCracks).mul(manualChar.mul(0.75).add(0.25)).mul(manualFlicker).mul(smoothstep(0.01, 0.15, u.ember)).mul(0.65);

  const thermo = applyThermo(albedo, u.roughness, manualEmber, u.wetness, options);
  albedo = thermo.color;
  const totalWet = thermo.wetness.clamp(0, 1);

  const wetAlbedo = albedo.mul(mix(float(1.0), float(0.52), totalWet));
  const baseRough = mix(mix(thermo.roughness, float(0.92), manualChar), float(0.26), totalWet);

  const height = grain.mul(0.65).add(fibers.mul(0.35)).mul(seamGroove).sub(manualCracks.mul(manualChar).mul(0.6));
  const perturbedNormal = perturbNormalHeight(height.mul(u.bumpScale), float(1));
  const finalRough = specularAARoughness(perturbedNormal, baseRough, 0.24, 0.14);
  const fireGlow = fireLightBounce(wetAlbedo, finalRough, float(0), u.fireLightGain, options.fireLighting !== false);

  material.colorNode = wetAlbedo;
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.clearcoatNode = totalWet.mul(0.8);
  material.clearcoatRoughnessNode = mix(float(0.32), float(0.06), totalWet);
  material.emissiveNode = thermo.emissive.add(fireGlow);

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, TimberMaterialOptions>(
    material,
    'timber',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.grainColor !== undefined) (u.grainColor.value as THREE.Color).set(partial.grainColor);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.plankWidth !== undefined) u.plankWidth.value = partial.plankWidth;
      if (partial.weathering !== undefined) u.weathering.value = partial.weathering;
      if (partial.wetness !== undefined) u.wetness.value = partial.wetness;
      if (partial.char !== undefined) u.char.value = partial.char;
      if (partial.ember !== undefined) u.ember.value = partial.ember;
      if (partial.roughness !== undefined) u.roughness.value = partial.roughness;
      if (partial.bumpScale !== undefined) u.bumpScale.value = partial.bumpScale;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
