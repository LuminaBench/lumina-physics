/**
 * Reusable TSL PBR melting glacial ice material.
 *
 * Features:
 *  - Zero-extra-pass refractive translucent interior (`viewportSharedTexture` backdrop)
 *    with Beer-Lambert glacial cyan-blue depth tint
 *  - Internal 3D fracture planes (`cracks`) and suspended air-bubble clouds (`bubbles`)
 *  - Continuous `melt` (0..1) progression: frosty faceted crystalline surface melts into
 *    a mirror-wet water sheath with animated downward meltwater rivulets
 *  - Subsurface forward scatter + warm HDR local firelight glow through the translucent block
 */
import { surfaceWetnessNode } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { auxPassthrough } from '../../engine/frame';
import { spriteNoise } from '../../engine/noise';
import {
  attachMaterialControls,
  fireLightBounce,
  perturbNormalHeight,
  triplanarDetail,
  triplanarNoise,
  specularAARoughness,
  frame,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const {
  uniform, float, vec2, vec3, positionWorld, normalWorld, normalView, cameraPosition,
  screenUV, viewportSharedTexture, normalize, dot, pow, mix, smoothstep, abs, max, sin,
} = TSL;

export interface MeltingIceOptions extends SharedMaterialOptions {
  /** Shallow ice tint colour (default pale glacial ice 0xd8f1fb). */
  color?: THREE.ColorRepresentation;
  /** Deep glacial core absorption colour (default deep turquoise-blue 0x2c8bb8). */
  deepColor?: THREE.ColorRepresentation;
  /** 0 = frozen frosty block, 1 = actively melting dripping wet ice (default 0.25). */
  melt?: number;
  /** 0..1 internal fracture vein density (default 0.65). */
  cracks?: number;
  /** 0..1 suspended frosty micro-bubbles (default 0.5). */
  bubbles?: number;
  /** Screen-space refraction bend strength (default 0.055). */
  refraction?: number;
  /** Index of refraction for ice (default 1.31). */
  ior?: number;
  /** Surface relief bump amplitude in metres (default 0.018). */
  bumpScale?: number;
}

export type MeltingIceMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, MeltingIceOptions>;

export function createMeltingIceMaterial(options: MeltingIceOptions = {}): MeltingIceMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.metalness = 0;
  material.clearcoat = 1;
  material.ior = options.ior ?? 1.31;
  material.mrtNode = auxPassthrough();

  const u = {
    color: uniform(new THREE.Color(options.color ?? 0xd8f1fb)),
    deepColor: uniform(new THREE.Color(options.deepColor ?? 0x2c8bb8)),
    scale: uniform(options.scale ?? 1),
    melt: uniform(options.melt ?? 0.25),
    cracks: uniform(options.cracks ?? 0.65),
    bubbles: uniform(options.bubbles ?? 0.5),
    refraction: uniform(options.refraction ?? 0.055),
    bumpScale: uniform(options.bumpScale ?? 0.018),
    fireLightGain: uniform(options.fireLightGain ?? 1.35),
  };
  const film = u.melt.max(surfaceWetnessNode(positionWorld));

  const p = positionWorld.mul(u.scale);
  const Nw = normalize(normalWorld);
  const V = normalize(cameraPosition.sub(positionWorld));
  const ndv = max(dot(Nw, V), 0.02);
  const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(ndv), 5)));

  // Faceted surface relief softens smoothly as the ice melts.
  const facet = triplanarDetail(p, Nw, 2.4);
  const microFrost = triplanarNoise(p, Nw, 26.0, 1);

  // Parallax-shifted internal fracture veins & trapped air-bubble clouds.
  const innerPos = p.sub(V.mul(0.28));
  const crackField = abs(triplanarNoise(innerPos, Nw, 3.6, 0).sub(0.5));
  const crackVeins = smoothstep(0.055, 0.008, crackField).mul(u.cracks);
  const bubbleCloud = smoothstep(0.46, 0.86, triplanarDetail(innerPos.mul(1.9), Nw, 6.2)).mul(u.bubbles);

  // Animated meltwater rivulets trickling downward when melt > 0.
  const sideMask = float(1).sub(abs(Nw.y));
  const rivX = mix(p.x, p.z, smoothstep(0.45, 0.75, abs(Nw.x)));
  const rivNoise = spriteNoise(vec2(rivX.mul(6.5), p.y.mul(1.8).add(frame.time.mul(0.55))), 1);
  const rivulets = smoothstep(0.52, 0.82, rivNoise).mul(sin(rivX.mul(18.0).add(rivNoise.mul(5.0))).mul(0.5).add(0.5)).mul(film).mul(sideMask);

  // Frozen frost fades rapidly as melt rises.
  const frost = float(1).sub(film).pow(1.4).mul(microFrost.mul(0.65).add(0.35));
  const height = facet.mul(mix(float(1.0), float(0.35), film))
    .add(frost.mul(0.22))
    .add(rivulets.mul(0.28));
  const perturbedNormal = perturbNormalHeight(height.mul(u.bumpScale), float(1));

  // Refracted glacial backdrop.
  const bend = perturbedNormal.xy.mul(u.refraction).add(vec2(facet.sub(0.5)).mul(u.refraction.mul(0.35)));
  const refrUV = screenUV.add(vec2(bend.x, bend.y.negate())).clamp(0.001, 0.999);
  const behind = viewportSharedTexture(refrUV).rgb;
  const thicknessTint = mix(u.color, u.deepColor, pow(ndv, 0.8).mul(0.65));
  const internalScatter = vec3(0.85, 0.96, 1.0).mul(crackVeins.mul(0.55).add(bubbleCloud.mul(0.32)));
  const transmitted = behind.mul(thicknessTint).add(internalScatter);

  // Sun subsurface forward scatter through thin melting edges.
  const sss = pow(max(dot(V.negate(), frame.sunDirection), 0), 3.5)
    .mul(float(1).sub(ndv).mul(0.65).add(0.35))
    .mul(frame.sunColor)
    .mul(u.deepColor.mul(0.55).add(vec3(0.18, 0.35, 0.42)))
    .mul(0.35);

  const albedo = mix(u.color, vec3(0.95, 0.98, 1.0), max(frost.mul(0.55), crackVeins.mul(0.5)));
  const baseRough = mix(mix(float(0.28), float(0.03), film), float(0.52), frost.mul(0.7));
  const finalRough = specularAARoughness(perturbedNormal, baseRough, 0.22, 0.12);
  const fireGlow = fireLightBounce(albedo, finalRough, float(0), u.fireLightGain, options.fireLighting !== false);

  material.colorNode = albedo;
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.clearcoatNode = mix(float(0.35), float(1.0), max(film, rivulets));
  material.clearcoatRoughnessNode = mix(float(0.18), float(0.02), film);
  material.backdropNode = transmitted;
  material.opacityNode = max(float(0.24), max(fresnel.mul(0.82), max(crackVeins.mul(0.5), bubbleCloud.mul(0.38)))).clamp(0.2, 0.95);
  material.emissiveNode = sss.add(fireGlow);

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, MeltingIceOptions>(
    material,
    'meltingIce',
    u,
    (partial) => {
      if (partial.color !== undefined) (u.color.value as THREE.Color).set(partial.color);
      if (partial.deepColor !== undefined) (u.deepColor.value as THREE.Color).set(partial.deepColor);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.melt !== undefined) u.melt.value = partial.melt;
      if (partial.cracks !== undefined) u.cracks.value = partial.cracks;
      if (partial.bubbles !== undefined) u.bubbles.value = partial.bubbles;
      if (partial.refraction !== undefined) u.refraction.value = partial.refraction;
      if (partial.bumpScale !== undefined) u.bumpScale.value = partial.bumpScale;
      if (partial.ior !== undefined) material.ior = partial.ior;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
