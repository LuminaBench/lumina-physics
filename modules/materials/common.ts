/**
 * Shared TSL PBR material building blocks:
 *  - Scale-invariant Mikkelsen height-to-view-normal perturbation (`perturbNormalHeight`)
 *  - Seamless world-space triplanar noise (`triplanarNoise`, `triplanarDetail`)
 *  - Animated rain-ripple micro-height (`rainRippleHeight`)
 *  - Optional `ThermoField` / `ThermalSurface` scorch + ember + wetness composition
 *  - Optional HDR local fire-light bounce/specular hook (`fireLightBounce`)
 *  - Live reactive uniform handles attached directly to the returned Three.js NodeMaterial
 */
import * as THREE from 'three/webgpu';
import { applySurfaceFrost, surfaceWetnessNode } from '../../engine/world-bus';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { spriteNoise, valueNoise2, hash12, hash22 } from '../../engine/noise';
import { specularAARoughness } from '../../engine/shading';
import { fireLights } from '../../engine/fx';
import type { ThermoField, ThermalSurface } from '../thermo/thermo';

const {
  Fn, Loop, int, float, vec2, vec3, abs, dot, normalize,
  positionWorld, normalWorld, cameraPosition,
  floor, fract, length, sin, exp, mix, max, pow,
} = TSL;

export type MaterialKind =
  | 'concrete'
  | 'asphalt'
  | 'carPaint'
  | 'titanium'
  | 'timber'
  | 'seaSprayGlass'
  | 'meltingIce';

export const MATERIAL_KINDS: readonly MaterialKind[] = [
  'concrete',
  'asphalt',
  'carPaint',
  'titanium',
  'timber',
  'seaSprayGlass',
  'meltingIce',
] as const;

export interface SharedMaterialOptions {
  /** World-space tiling scale multiplier (default 1). */
  scale?: number;
  /** Optional primary ground ThermoField to overlay scorch, ember cracks and wetness. */
  thermo?: ThermoField | null;
  /** Optional 3D wall/deck ThermalSurface to overlay scorch, ember cracks and wetness. */
  thermalSurface?: ThermalSurface | null;
  /** Couple into the shared HDR local fire-light field for warm glints/bounce (default true). */
  fireLighting?: boolean;
  /** Multiplier on local HDR fire-light bounce (default 1). */
  fireLightGain?: number;
}

/**
 * Strongly typed handle merged directly onto the Three.js `MeshStandardNodeMaterial` or
 * `MeshPhysicalNodeMaterial`, so callers pass it directly to `new THREE.Mesh(geo, mat)`
 * while still being able to update uniforms cleanly at runtime.
 */
export type LuminaMaterial<
  TMat extends THREE.NodeMaterial,
  TParams extends Record<string, any>,
> = TMat & {
  readonly kind: MaterialKind;
  readonly uniforms: Record<string, N>;
  setParams(partial: Partial<TParams>): void;
};

export { perturbNormalHeight } from '../../engine/shading';

/**
 * Cheap triplanar baked noise sample (3 bilinear taps weighted by `|normalWorld|^4`).
 * Eliminates UV stretching on walls, blocks, piers and curved geometry.
 */
export function triplanarNoise(worldPos: N, worldNormal: N, scale: N | number, channel: 0 | 1 = 0): N {
  const p = worldPos.mul(scale);
  const w = abs(worldNormal).pow(4);
  const wNorm = w.div(w.x.add(w.y).add(w.z).add(1e-4));
  const nx = spriteNoise(p.zy, channel);
  const ny = spriteNoise(p.xz, channel);
  const nz = spriteNoise(p.xy, channel);
  return nx.mul(wNorm.x).add(ny.mul(wNorm.y)).add(nz.mul(wNorm.z));
}

/** Two-octave triplanar detail value in [0, 1]. */
export function triplanarDetail(worldPos: N, worldNormal: N, scale: N | number): N {
  return triplanarNoise(worldPos, worldNormal, scale, 0).mul(0.65)
    .add(triplanarNoise(worldPos, worldNormal, float(scale as any).mul(2.73), 1).mul(0.35));
}

/**
 * Lightweight expanding raindrop ripple rings → scalar height displacement for wet films.
 * Uses a single 3×3 cell lattice so wet concrete and asphalt stay fast on every tier.
 */
export const rainRippleHeight = Fn(([xz, time]: N[]) => {
  const q = xz.mul(2.35);
  const cell = floor(q).toVar();
  const local = fract(q).toVar();
  const h = float(0).toVar();
  Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'rj' }, ({ rj }: N) => {
    Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'ri' }, ({ ri }: N) => {
      const offset = vec2(float(ri), float(rj));
      const id = cell.add(offset);
      const centre = offset.add(hash22(id));
      const phase = fract(time.mul(1.15).add(hash12(id.add(19.7))));
      const d = length(local.sub(centre));
      const ring = d.sub(phase.mul(0.95));
      const wave = sin(ring.mul(30)).mul(exp(ring.mul(ring).mul(-65))).mul(float(1).sub(phase).pow(2));
      h.addAssign(wave);
    });
  });
  return h;
});

/**
 * Compose optional `ThermoField` or `ThermalSurface` scorch/char/wetness/ember cracks
 * into a PBR material's albedo, roughness and emissive outputs.
 */
export function applyThermo(
  albedo: N,
  roughness: N,
  emissive: N,
  wetness: N,
  options: SharedMaterialOptions,
): { color: N; roughness: N; emissive: N; wetness: N } {
  wetness = max(wetness, surfaceWetnessNode(positionWorld));
  if (options.thermalSurface) {
    const t = options.thermalSurface.shade(albedo, positionWorld);
    const wet = max(wetness, t.wetness);
    return {
      color: t.color,
      roughness: mix(roughness, float(0.9), t.char.mul(0.7)),
      emissive: emissive.add(t.emissive),
      wetness: wet,
    };
  }
  if (options.thermo) {
    const t = options.thermo.surface(albedo, positionWorld);
    const wet = max(wetness, t.wetness);
    return {
      color: t.color,
      roughness,
      emissive: emissive.add(t.emissive),
      wetness: wet,
    };
  }
  return { color: albedo, roughness, emissive, wetness };
}

/**
 * Additive HDR local fire-light diffuse + specular glint for PBR surfaces
 * (zero GPU cost when no fire lights are active thanks to `fireLights.hasActive`).
 */
export function fireLightBounce(
  albedo: N,
  roughness: N,
  metalness: N,
  gain: N | number = 1,
  enabled = true,
): N {
  if (!enabled) return vec3(0);
  return Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const Nw = normalize(normalWorld);
    return fireLights.samplePBR(positionWorld, Nw, viewDir, albedo, roughness, metalness).mul(gain);
  })();
}

/** Attach `.kind`, `.uniforms` and `.setParams()` onto a Three.js NodeMaterial instance. */
export function attachMaterialControls<
  TMat extends THREE.NodeMaterial,
  TParams extends Record<string, any>,
>(
  material: TMat,
  kind: MaterialKind,
  uniforms: Record<string, N>,
  apply: (partial: Partial<TParams>) => void,
): LuminaMaterial<TMat, TParams> {
  const m = material as LuminaMaterial<TMat, TParams>;
  applySurfaceFrost(material as unknown as THREE.MeshStandardNodeMaterial, uniforms.wetness ?? uniforms.spray ?? uniforms.melt);
  m.userData.luminaWorldSurface = true;
  Object.defineProperty(m, 'kind', { value: kind, enumerable: true });
  Object.defineProperty(m, 'uniforms', { value: uniforms, enumerable: true });
  m.setParams = apply;
  return m;
}

export { frame, specularAARoughness, valueNoise2 };
