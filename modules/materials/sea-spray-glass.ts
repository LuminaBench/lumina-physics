/**
 * Reusable TSL PBR sea-spray glass material.
 *
 * Designed for ship bridges, cockpit canopies, coastal windows and lighthouse glazing:
 *  - Zero-extra-pass screen-space backdrop refraction (`viewportSharedTexture`)
 *  - Animated gravity-driven sea-spray rivulets + beaded water droplets refracting the scene
 *  - Frosted dried sea-salt crust haze (`salt` uniform) with elevated diffuse scatter
 *  - Fresnel edge reflection, subtle marine green-blue glass tint, MRT passthrough and HDR firelight
 */
import { surfaceWetnessNode } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { auxPassthrough } from '../../engine/frame';
import { spriteNoise, hash22, hash12 } from '../../engine/noise';
import {
  attachMaterialControls,
  fireLightBounce,
  perturbNormalHeight,
  triplanarNoise,
  specularAARoughness,
  frame,
  type LuminaMaterial,
  type SharedMaterialOptions,
} from './common';

const {
  uniform, float, vec2, vec3, positionWorld, normalWorld, normalView, cameraPosition,
  screenUV, viewportSharedTexture, normalize, dot, pow, mix, smoothstep, floor, fract, length, max, sin, abs,
} = TSL;

export interface SeaSprayGlassOptions extends SharedMaterialOptions {
  /** Subtle glass absorption tint (default pale marine green-cyan 0xcbe8e6). */
  tintColor?: THREE.ColorRepresentation;
  /** 0..1 active sea-spray droplet & trickling runner density (default 0.65). */
  spray?: number;
  /** 0..1 dried white sea-salt crust / frost haze (default 0.22). */
  salt?: number;
  /** Base clean glass roughness (default 0.04). */
  roughness?: number;
  /** Screen-space refraction bend strength (default 0.032). */
  refraction?: number;
  /** Glass index of refraction (default 1.52). */
  ior?: number;
  /** 0..1 base surface tint opacity before Fresnel & salt (default 0.14). */
  opacity?: number;
}

export type SeaSprayGlassMaterial = LuminaMaterial<THREE.MeshPhysicalNodeMaterial, SeaSprayGlassOptions>;

export function createSeaSprayGlassMaterial(options: SeaSprayGlassOptions = {}): SeaSprayGlassMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.metalness = 0;
  material.clearcoat = 1;
  material.ior = options.ior ?? 1.52;
  material.mrtNode = auxPassthrough();

  const u = {
    tintColor: uniform(new THREE.Color(options.tintColor ?? 0xcbe8e6)),
    scale: uniform(options.scale ?? 1),
    spray: uniform(options.spray ?? 0.65),
    salt: uniform(options.salt ?? 0.22),
    roughness: uniform(options.roughness ?? 0.04),
    refraction: uniform(options.refraction ?? 0.032),
    opacity: uniform(options.opacity ?? 0.14),
    fireLightGain: uniform(options.fireLightGain ?? 1.2),
  };
  const film = u.spray.max(surfaceWetnessNode(positionWorld));

  const Nw = normalize(normalWorld);
  const V = normalize(cameraPosition.sub(positionWorld));
  const ndv = max(dot(Nw, V), 0.02);
  const fresnel = float(0.04).add(float(0.96).mul(pow(float(1).sub(ndv), 5)));

  // World-space planar coords for droplets/runners on arbitrarily oriented glass panes.
  const p = positionWorld.mul(u.scale);
  const paneX = mix(p.x, p.z, smoothstep(0.45, 0.75, abs(Nw.x)));
  const paneUV = vec2(paneX, p.y);

  // Layer 1: Beaded sea-spray micro-droplets.
  const dropGrid = paneUV.mul(14.0);
  const dCell = floor(dropGrid);
  const dLocal = fract(dropGrid).sub(0.5);
  const dRand = hash22(dCell);
  const dPos = dRand.sub(0.5).mul(0.52);
  const dRad = hash12(dCell.add(13.7)).mul(0.24).add(0.12);
  const dDist = length(dLocal.sub(dPos));
  const droplets = smoothstep(dRad, dRad.mul(0.15), dDist).mul(smoothstep(0.22, 0.72, dRand.x)).mul(film);

  // Layer 2: Gravity-driven trickling runners sliding down -Y.
  const runCol = vec2(paneUV.x.mul(7.5), paneUV.y.mul(2.1).add(frame.time.mul(0.65)));
  const rCell = floor(runCol);
  const rLocal = fract(runCol);
  const rSeed = hash12(vec2(rCell.x, 7.1));
  const rWobble = sin(paneUV.y.mul(9.0).add(rSeed.mul(19.0))).mul(0.12);
  const rHeadY = fract(frame.time.mul(0.22).add(rSeed.mul(5.3)));
  const dxRun = abs(rLocal.x.sub(0.5).sub(rWobble));
  const dyHead = rLocal.y.sub(rHeadY);
  const runnerBead = smoothstep(0.16, 0.02, length(vec2(dxRun.mul(1.8), dyHead))).mul(film);
  const runnerTrail = smoothstep(0.09, 0.01, dxRun).mul(smoothstep(0.0, 0.25, dyHead)).mul(smoothstep(0.75, 0.05, dyHead)).mul(0.45).mul(film);
  const waterFilm = max(droplets, max(runnerBead, runnerTrail));

  // Dried white sea-salt crust near edges & streaks.
  const saltNoise = triplanarNoise(p, Nw, 3.8, 0).mul(0.62).add(spriteNoise(paneUV.mul(11.5), 1).mul(0.38));
  const saltCrust = smoothstep(0.42, 0.84, saltNoise.add(u.salt.mul(0.45))).mul(u.salt).mul(float(1).sub(runnerBead.mul(0.7)));

  const dropHeight = waterFilm.mul(0.0085).add(saltCrust.mul(0.002));
  const perturbedNormal = perturbNormalHeight(dropHeight, float(1));

  // Screen-space refracted backdrop bent by glass normal + water droplets/runners.
  const bend = perturbedNormal.xy.sub(normalView.xy).mul(u.refraction.mul(2.4))
    .add(normalView.xy.mul(u.refraction.mul(0.38)));
  const refrUV = screenUV.add(vec2(bend.x, bend.y.negate())).clamp(0.001, 0.999);
  const behind = viewportSharedTexture(refrUV).rgb;
  // Salt crust slightly washes and frosts the transmitted scene.
  const transmitted = behind.mul(mix(vec3(1), u.tintColor, float(0.28).add(saltCrust.mul(0.35))))
    .add(vec3(0.32, 0.35, 0.38).mul(saltCrust.mul(0.42)));

  const baseRough = mix(mix(u.roughness, float(0.02), waterFilm), float(0.68), saltCrust);
  const finalRough = specularAARoughness(perturbedNormal, baseRough, 0.22, 0.1);
  const albedo = mix(u.tintColor, vec3(0.86, 0.89, 0.91), saltCrust);
  const fireGlow = fireLightBounce(albedo, finalRough, float(0), u.fireLightGain, options.fireLighting !== false);

  material.colorNode = albedo;
  material.roughnessNode = finalRough;
  material.normalNode = perturbedNormal;
  material.clearcoatNode = max(float(0.65), waterFilm);
  material.clearcoatRoughnessNode = mix(float(0.04), float(0.35), saltCrust);
  material.backdropNode = transmitted;
  material.opacityNode = max(u.opacity, max(fresnel.mul(0.78), saltCrust.mul(0.62))).clamp(0.06, 0.96);
  material.emissiveNode = fireGlow;

  return attachMaterialControls<THREE.MeshPhysicalNodeMaterial, SeaSprayGlassOptions>(
    material,
    'seaSprayGlass',
    u,
    (partial) => {
      if (partial.tintColor !== undefined) (u.tintColor.value as THREE.Color).set(partial.tintColor);
      if (partial.scale !== undefined) u.scale.value = partial.scale;
      if (partial.spray !== undefined) u.spray.value = partial.spray;
      if (partial.salt !== undefined) u.salt.value = partial.salt;
      if (partial.roughness !== undefined) u.roughness.value = partial.roughness;
      if (partial.refraction !== undefined) u.refraction.value = partial.refraction;
      if (partial.opacity !== undefined) u.opacity.value = partial.opacity;
      if (partial.ior !== undefined) material.ior = partial.ior;
      if (partial.fireLightGain !== undefined) u.fireLightGain.value = partial.fireLightGain;
    },
  );
}
