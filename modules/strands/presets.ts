/**
 * Ready-made strand field builders: grass meadows, underwater kelp forests, and hair tufts.
 */
import * as THREE from 'three/webgpu';
import type { KajiyaKayLook, StrandFieldSpec, StrandTuning } from './types';

/** Deterministic mulberry32 PRNG so grass, kelp, and hair layouts match on GPU and CPU. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GrassOptions extends Partial<StrandTuning> {
  /** Center of the grass patch in world space (default (0, 0, 0)). */
  center?: THREE.Vector3;
  /** Patch size [widthX, depthZ] in metres (default [14, 14]). */
  size?: [number, number] | number;
  /** Number of grass blades (scaled by detail on CPU). */
  count?: number;
  /** Segments per blade (default 4). */
  segments?: number;
  /** Blade height range [min, max] in metres (default [0.35, 0.78]). */
  height?: [number, number];
  /** Blade half-width at base in metres (default 0.032). */
  width?: number;
  /** Optional terrain height callback `heightAt(x, z)`. */
  heightAt?: (x: number, z: number) => number;
  /** Optional placement filter returning true to keep a blade at `(x, z)`. */
  mask?: (x: number, z: number) => boolean;
  /** Seed for deterministic scatter (default 1337). */
  seed?: number;
  look?: Partial<KajiyaKayLook>;
  follow?: THREE.Object3D | null;
}

export function grassSpec(o: GrassOptions = {}, detail = 1): StrandFieldSpec {
  const center = o.center ?? new THREE.Vector3();
  const sx = typeof o.size === 'number' ? o.size : (o.size?.[0] ?? 14);
  const sz = typeof o.size === 'number' ? o.size : (o.size?.[1] ?? 14);
  const target = Math.max(32, Math.round((o.count ?? 2400) * detail));
  const segments = Math.max(2, o.segments ?? 4);
  const [hMin, hMax] = o.height ?? [0.35, 0.78];
  const baseHalfW = o.width ?? 0.032;
  const rand = rng(o.seed ?? 1337);

  const roots = new Float32Array(target * 4);
  const dirs = new Float32Array(target * 4);
  const meta = new Float32Array(target * 4);

  let placed = 0;
  let attempts = 0;
  const maxAttempts = target * 6;
  const cols = Math.ceil(Math.sqrt(target * (sx / Math.max(sz, 0.1))));
  const rows = Math.ceil(target / Math.max(cols, 1));

  while (placed < target && attempts < maxAttempts) {
    const cell = attempts++;
    const gx = ((cell % cols) + rand()) / cols - 0.5;
    const gz = (Math.floor(cell / cols) % rows + rand()) / rows - 0.5;
    const lx = gx * sx;
    const lz = gz * sz;
    const wx = center.x + lx;
    const wz = center.z + lz;
    if (o.mask && !o.mask(wx, wz)) continue;
    const ly = o.heightAt ? o.heightAt(wx, wz) - center.y : 0;

    const len = hMin + (hMax - hMin) * (0.25 + 0.75 * rand());
    const leanAng = rand() * Math.PI * 2;
    const lean = 0.08 + rand() * 0.24;
    const dx = Math.cos(leanAng) * lean;
    const dz = Math.sin(leanAng) * lean;
    const dy = Math.sqrt(Math.max(0.2, 1 - dx * dx - dz * dz));

    const i = placed * 4;
    roots[i] = lx; roots[i + 1] = ly; roots[i + 2] = lz; roots[i + 3] = len;
    dirs[i] = dx; dirs[i + 1] = dy; dirs[i + 2] = dz; dirs[i + 3] = baseHalfW * (0.75 + rand() * 0.5);
    meta[i] = rand(); meta[i + 1] = 0.75 + rand() * 0.5; meta[i + 2] = 0.25 + rand() * 0.55; meta[i + 3] = rand();
    placed++;
  }

  return {
    kind: 'grass',
    strandCount: placed,
    segments,
    roots: roots.subarray(0, placed * 4),
    dirs: dirs.subarray(0, placed * 4),
    meta: meta.subarray(0, placed * 4),
    matrix: new THREE.Matrix4().makeTranslation(center.x, center.y, center.z),
    follow: o.follow ?? null,
    stiffness: o.stiffness,
    damping: o.damping,
    gravity: o.gravity,
    windResponse: o.windResponse,
    flutter: o.flutter,
    drag: o.drag,
    downwashResponse: o.downwashResponse,
    vehicleResponse: o.vehicleResponse,
    constraintIterations: o.constraintIterations,
    look: {
      rootColor: 0x1a3a14,
      tipColor: 0x6ea834,
      variationColor: 0x99a642,
      specularColor: 0xfff8d6,
      primaryShift: -0.08,
      secondaryShift: 0.14,
      primaryExponent: 36,
      secondaryExponent: 16,
      primaryIntensity: 0.28,
      secondaryIntensity: 0.18,
      translucency: 0.72,
      rootAO: 0.24,
      billboard: 0.55,
      ...o.look,
    },
  };
}

export interface KelpOptions extends Partial<StrandTuning> {
  /** Center of the kelp bed in world space. */
  center?: THREE.Vector3;
  /** Bed size [widthX, depthZ] in metres (default [16, 16]). */
  size?: [number, number] | number;
  /** Number of kelp fronds (default 360). */
  count?: number;
  /** Segments per frond (default 7). */
  segments?: number;
  /** Frond height range [min, max] in metres (default [2.2, 4.6]). */
  height?: [number, number];
  /** Frond half-width in metres (default 0.12). */
  width?: number;
  /** Optional seabed height callback `heightAt(x, z)`. */
  heightAt?: (x: number, z: number) => number;
  /** Minimum water depth required to place a frond (if heightAt is supplied). */
  minDepth?: number;
  waterLevel?: number;
  seed?: number;
  look?: Partial<KajiyaKayLook>;
  follow?: THREE.Object3D | null;
}

export function kelpSpec(o: KelpOptions = {}, detail = 1): StrandFieldSpec {
  const center = o.center ?? new THREE.Vector3(0, -4, 0);
  const sx = typeof o.size === 'number' ? o.size : (o.size?.[0] ?? 16);
  const sz = typeof o.size === 'number' ? o.size : (o.size?.[1] ?? 16);
  const target = Math.max(16, Math.round((o.count ?? 360) * detail));
  const segments = Math.max(4, o.segments ?? 7);
  const [hMin, hMax] = o.height ?? [2.2, 4.6];
  const baseHalfW = o.width ?? 0.12;
  const waterY = o.waterLevel ?? 0;
  const minDepth = o.minDepth ?? 1.2;
  const rand = rng(o.seed ?? 4207);

  const roots = new Float32Array(target * 4);
  const dirs = new Float32Array(target * 4);
  const meta = new Float32Array(target * 4);

  // Cluster kelp into organic clumps.
  const clumps = Math.max(4, Math.round(Math.sqrt(target) * 0.45));
  const clumpX = new Float32Array(clumps);
  const clumpZ = new Float32Array(clumps);
  for (let c = 0; c < clumps; c++) {
    clumpX[c] = (rand() - 0.5) * sx * 0.85;
    clumpZ[c] = (rand() - 0.5) * sz * 0.85;
  }

  let placed = 0;
  let attempts = 0;
  while (placed < target && attempts < target * 6) {
    attempts++;
    const ci = Math.floor(rand() * clumps);
    const ang = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand()) * Math.min(sx, sz) * 0.18;
    const lx = THREE.MathUtils.clamp(clumpX[ci] + Math.cos(ang) * rad, -sx * 0.5, sx * 0.5);
    const lz = THREE.MathUtils.clamp(clumpZ[ci] + Math.sin(ang) * rad, -sz * 0.5, sz * 0.5);
    const wx = center.x + lx;
    const wz = center.z + lz;
    const floorY = o.heightAt ? o.heightAt(wx, wz) : center.y;
    const depth = waterY - floorY;
    if (o.heightAt && depth < minDepth) continue;

    const maxAllowed = Math.max(0.6, depth - 0.25);
    const len = Math.min(maxAllowed, hMin + (hMax - hMin) * rand());
    const i = placed * 4;
    roots[i] = lx; roots[i + 1] = floorY - center.y; roots[i + 2] = lz; roots[i + 3] = len;
    dirs[i] = (rand() - 0.5) * 0.18; dirs[i + 1] = 1; dirs[i + 2] = (rand() - 0.5) * 0.18;
    const l = Math.hypot(dirs[i], dirs[i + 1], dirs[i + 2]);
    dirs[i] /= l; dirs[i + 1] /= l; dirs[i + 2] /= l;
    dirs[i + 3] = baseHalfW * (0.7 + rand() * 0.6);
    meta[i] = rand(); meta[i + 1] = 0.7 + rand() * 0.6; meta[i + 2] = 0.15 * (rand() - 0.5); meta[i + 3] = rand();
    placed++;
  }

  return {
    kind: 'kelp',
    strandCount: placed,
    segments,
    roots: roots.subarray(0, placed * 4),
    dirs: dirs.subarray(0, placed * 4),
    meta: meta.subarray(0, placed * 4),
    matrix: new THREE.Matrix4().makeTranslation(center.x, center.y, center.z),
    follow: o.follow ?? null,
    stiffness: o.stiffness,
    damping: o.damping,
    gravity: o.gravity,
    windResponse: o.windResponse,
    flutter: o.flutter,
    drag: o.drag,
    downwashResponse: o.downwashResponse,
    vehicleResponse: o.vehicleResponse,
    constraintIterations: o.constraintIterations,
    look: {
      rootColor: 0x162b12,
      tipColor: 0x6f7c24,
      variationColor: 0x9b7e24,
      specularColor: 0xdff5c8,
      primaryShift: -0.06,
      secondaryShift: 0.12,
      primaryExponent: 46,
      secondaryExponent: 18,
      primaryIntensity: 0.36,
      secondaryIntensity: 0.22,
      translucency: 0.78,
      rootAO: 0.28,
      billboard: 0.75,
      ...o.look,
    },
  };
}

export interface HairOptions extends Partial<StrandTuning> {
  /** World origin (or local offset if `follow` is set). */
  origin?: THREE.Vector3;
  /** Moving rig / character head the hair follows. */
  follow?: THREE.Object3D | null;
  /** Scalp sphere radius in metres (default 0.16). */
  scalpRadius?: number;
  /** Number of hair strands (default 900). */
  count?: number;
  /** Segments per hair strand (default 6). */
  segments?: number;
  /** Hair length range [min, max] in metres (default [0.22, 0.38]). */
  length?: [number, number];
  /** Half-width of each hair strand ribbon in metres (default 0.0055). */
  width?: number;
  /** Polar coverage of the scalp cap in radians (default 1.35 = crown + sides). */
  capAngle?: number;
  seed?: number;
  look?: Partial<KajiyaKayLook>;
}

export function hairSpec(o: HairOptions = {}, detail = 1): StrandFieldSpec {
  const origin = o.origin ?? new THREE.Vector3();
  const radius = o.scalpRadius ?? 0.16;
  const count = Math.max(32, Math.round((o.count ?? 900) * detail));
  const segments = Math.max(3, o.segments ?? 6);
  const [lMin, lMax] = o.length ?? [0.22, 0.38];
  const baseHalfW = o.width ?? 0.0055;
  const maxTheta = o.capAngle ?? 1.35;
  const rand = rng(o.seed ?? 9001);

  const roots = new Float32Array(count * 4);
  const dirs = new Float32Array(count * 4);
  const meta = new Float32Array(count * 4);

  for (let s = 0; s < count; s++) {
    // Uniform distribution on spherical cap (crown + sides, leaving face front clearer).
    const u = rand();
    const cosTheta = 1 - u * (1 - Math.cos(maxTheta));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = rand() * Math.PI * 2;
    const nx = sinTheta * Math.cos(phi);
    const ny = cosTheta;
    const nz = sinTheta * Math.sin(phi);

    // Rest direction flows slightly outward and downward from the scalp normal.
    const dx = nx * 0.72;
    const dy = ny * 0.38 - 0.55;
    const dz = nz * 0.72;
    const dl = Math.hypot(dx, dy, dz) || 1;

    const i = s * 4;
    roots[i] = nx * radius;
    roots[i + 1] = ny * radius;
    roots[i + 2] = nz * radius;
    roots[i + 3] = lMin + (lMax - lMin) * (0.35 + 0.65 * rand());
    dirs[i] = dx / dl; dirs[i + 1] = dy / dl; dirs[i + 2] = dz / dl;
    dirs[i + 3] = baseHalfW * (0.8 + rand() * 0.45);
    meta[i] = rand(); meta[i + 1] = 0.8 + rand() * 0.4; meta[i + 2] = 0.45 + rand() * 0.35; meta[i + 3] = rand();
  }

  return {
    kind: 'hair',
    strandCount: count,
    segments,
    roots,
    dirs,
    meta,
    matrix: new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z),
    follow: o.follow ?? null,
    stiffness: o.stiffness,
    damping: o.damping,
    gravity: o.gravity,
    windResponse: o.windResponse,
    flutter: o.flutter,
    drag: o.drag,
    downwashResponse: o.downwashResponse,
    vehicleResponse: o.vehicleResponse,
    constraintIterations: o.constraintIterations,
    look: {
      rootColor: 0x24160e,
      tipColor: 0x6b4428,
      variationColor: 0x8f5b32,
      specularColor: 0xfff5e4,
      primaryShift: -0.14,
      secondaryShift: 0.16,
      primaryExponent: 115,
      secondaryExponent: 34,
      primaryIntensity: 0.62,
      secondaryIntensity: 0.36,
      translucency: 0.38,
      rootAO: 0.25,
      billboard: 0.92,
      ...o.look,
    },
  };
}
