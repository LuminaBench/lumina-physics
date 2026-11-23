/**
 * Inland water systems: flowmap-advected rivers, rocky rapids, waterfall sheets and plunge mist.
 *
 *   River       Spline-authored channel with a baked 2D flowmap (`DataTexture`, RGBA HalfFloat)
 *               encoding channel velocity, potential-flow boulder deflection, rapid turbulence
 *               and standing pillow waves. Shaded with dual-phase flowmap advection, cellular
 *               stretched whitewater foam, crest SSS, GGX specular AA, Schlick Fresnel and
 *               screen-space refraction (analytic riverbed fallback on Low tier). Includes a
 *               single-draw-call merged rocky rapids boulder mesh with a wet splash-darkened
 *               waterline ring and a zero-allocation CPU `sample()` API for buoyancy / gameplay.
 *   Waterfall   Ballistic parabolic falling water sheet (`s = v₀t, y = y₀ − ½gt²`) with
 *               gravity-accelerated vertical streaks, cellular aerated curtains, back-lit rim
 *               scatter, soft depth-feathered plunge entry, an outward-boiling plunge pool
 *               ring and continuous plunge mist + splash spray particles (sharing `EffectsKit`
 *               or using tier-budgeted soft-layer `ParticleSystem` pools).
 *   InlandWater `EngineModule` host coordinating multiple rivers and waterfalls with unified
 *               `sample()`, `heightAt()`, `flowAt()`, `setQuality()` and `dispose()`.
 */
import * as THREE from 'three/webgpu';
import { FieldReading } from '../../engine/world-bus';
import { TSL, type N } from '../../engine/tsl';
import { specularAA, refractedScreenUV, viewportDepthAt } from '../../engine/shading';
import { frame, auxSurface, auxPassthrough, screenVelocity } from '../../engine/frame';
import { valueNoise2, fbm2, voronoi2, mulberry32 } from '../../engine/noise';
import { ParticleSystem } from '../../engine/particles';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import type { EffectsKit } from '../../engine/fx';
import type { Weather } from '../weather/weather';

const {
  Fn, If, float, vec2, vec3, vec4, uniform, texture, attribute, uv, positionGeometry, positionWorld,
  positionView, cameraPosition, cameraViewMatrix, cameraNear, cameraFar, screenUV,
  viewportSharedTexture, perspectiveDepthToViewZ, normalize, dot, length, reflect, mix, smoothstep,
  exp, pow, max, min, fract, sin, abs, select, fwidth, dFdx, dFdy,
} = TSL;

const GRAVITY = 9.81;

// ---------------------------------------------------------------------------
// Public interfaces & presets
// ---------------------------------------------------------------------------

export interface RiverPoint {
  x: number;
  y: number;
  z: number;
  /** River channel width at this control point (m). */
  width?: number;
  /** Mean centreline flow speed (m/s). */
  speed?: number;
  /** Centreline water depth (m). */
  depth?: number;
  /** Extra rapids turbulence multiplier (0 = calm glide, 1 = fierce whitewater). */
  turbulence?: number;
}

export interface RapidRockSpec {
  x: number;
  z: number;
  /** Approximate boulder radius (m). */
  radius: number;
  /** Protrusion height above riverbed/water (m; default `radius * 0.85`). */
  height?: number;
  /** Optional explicit world Y for boulder centre; defaults to river surface height. */
  y?: number;
  /** Deterministic shape variation seed. */
  seed?: number;
}

export interface RiverOptics {
  /** 0 = silty brown/olive river, 1 = crystal alpine stream. */
  clarity: number;
  /** Master whitewater foam intensity (0..2). */
  foam: number;
  /** Screen-space refraction distortion strength. */
  refraction: number;
  /** Crest / rapid subsurface-scattering strength. */
  sss: number;
  /** Multiplier on flow advection speed (1 = physical m/s). */
  flowScale: number;
  /** Extra rapids aeration / whitewater sensitivity (0..2). */
  rapidsFoam: number;
  /** Fraction of half-width feathered smoothly into the riverbank (0.04..0.35). */
  bankFade: number;
}

export interface RiverOptions {
  points: RiverPoint[];
  /** Default channel width (m) when omitted on control points. */
  width?: number;
  /** Default centreline speed (m/s). */
  speed?: number;
  /** Default centreline depth (m). */
  depth?: number;
  /** Baseline rapids turbulence (0..1). */
  turbulence?: number;
  /** Explicit rocky rapids boulders placed in the channel. */
  rocks?: RapidRockSpec[];
  /** Procedurally scatter this many boulders along rapid sections (0 = none). */
  autoRocks?: number;
  /** Deterministic seed for procedural rock placement. */
  seed?: number;
  /** Tessellation segments along the river length (auto-sized from arc length if omitted). */
  segmentsAlong?: number;
  /** Tessellation segments across the channel width (default 20). */
  segmentsAcross?: number;
  /** Baked flowmap resolution (default 256). */
  flowmapSize?: number;
  weather?: Weather;
  fx?: EffectsKit;
  optics?: Partial<RiverOptics>;
}

export interface RiverSample {
  /** True when `(x, z)` lies within the river channel width. */
  inside: boolean;
  /** Water surface elevation (world Y, metres). */
  height: number;
  /** Local water depth above the riverbed (m, 0 outside). */
  depth: number;
  /** World-space horizontal flow velocity (m/s, boulder-deflected). */
  velocity: THREE.Vector3;
  /** Flow speed magnitude (m/s). */
  speed: number;
  /** Local rapids turbulence / whitewater intensity (0..2). */
  turbulence: number;
  /** Signed distance inside the nearest bank (m; > 0 inside, < 0 outside). */
  bankDistance: number;
  /** Normalised across-channel coordinate in [-1, 1] (0 = centreline). */
  u: number;
  /** Arc-length distance downstream from the river head (m). */
  distance: number;
}

export interface WaterfallOptions {
  /** World position of the waterfall crest centre (lip). */
  position: THREE.Vector3 | { x: number; y: number; z: number };
  /** Horizontal flow direction: angle in radians (0 = +X, π/2 = +Z) or XZ vector. */
  direction?: number | { x: number; z: number };
  /** Crest width (m). */
  width?: number;
  /** Vertical drop height (m). */
  height?: number;
  /** Horizontal exit speed over the crest lip (m/s, default 4.2). */
  exitSpeed?: number;
  /** Optional explicit horizontal throw distance (m); defaults to ballistic `exitSpeed * sqrt(2h/g)`. */
  throwDistance?: number;
  /** 0..1 aeration / whitewater opacity of the falling curtain (default 0.85). */
  aeration?: number;
  /** Plunge mist & splash emission multiplier (0..2, default 1). */
  mistIntensity?: number;
  /** Plunge pool boiling ring radius (m, default `width * 0.9`). */
  plungeRadius?: number;
  /** Overall discharge / flow multiplier (0..2, default 1). */
  flow?: number;
  weather?: Weather;
  fx?: EffectsKit;
}

export interface InlandWaterOptions {
  weather?: Weather;
  fx?: EffectsKit;
}

export const RIVER_PRESETS: Record<'mountainRapids' | 'forestStream' | 'canyonTorrent', Partial<RiverOptions>> = {
  mountainRapids: {
    width: 11, speed: 4.4, depth: 1.5, turbulence: 0.62, autoRocks: 14,
    optics: { clarity: 0.86, foam: 1.15, refraction: 1.0, sss: 1.15, flowScale: 1.0, rapidsFoam: 1.3, bankFade: 0.14 },
  },
  forestStream: {
    width: 6.5, speed: 2.1, depth: 0.9, turbulence: 0.22, autoRocks: 6,
    optics: { clarity: 0.92, foam: 0.72, refraction: 1.0, sss: 0.9, flowScale: 0.9, rapidsFoam: 0.85, bankFade: 0.18 },
  },
  canyonTorrent: {
    width: 16, speed: 6.2, depth: 2.8, turbulence: 0.85, autoRocks: 20,
    optics: { clarity: 0.64, foam: 1.45, refraction: 0.9, sss: 1.25, flowScale: 1.15, rapidsFoam: 1.6, bankFade: 0.11 },
  },
};

export const WATERFALL_PRESETS: Record<'cascade' | 'bridalveil' | 'cataract', Partial<WaterfallOptions>> = {
  cascade:    { width: 7.5, height: 12, exitSpeed: 3.8, aeration: 0.82, mistIntensity: 1.0 },
  bridalveil: { width: 4.5, height: 26, exitSpeed: 2.8, aeration: 0.94, mistIntensity: 1.35 },
  cataract:   { width: 16,  height: 18, exitSpeed: 6.2, aeration: 0.90, mistIntensity: 1.65 },
};

// ---------------------------------------------------------------------------
// Internal spline sample representation
// ---------------------------------------------------------------------------

interface SplineSample {
  x: number; y: number; z: number;
  tx: number; ty: number; tz: number; // unit tangent
  rx: number; rz: number;             // unit horizontal right vector (cross(tangent, up))
  width: number;
  speed: number;
  depth: number;
  turbulence: number;
  slope: number;                      // downward vertical slope (-dy/ds >= 0)
  s: number;                          // cumulative arc length (m)
}

interface ResolvedRock {
  x: number; y: number; z: number;
  radius: number;
  height: number;
  seed: number;
  u: number;        // normalised across [-1, 1]
  v: number;        // normalised along [0, 1]
  s: number;        // arc length (m)
  localSpeed: number;
  tx: number; tz: number;
}

const _tmpV = new THREE.Vector3();
const _tmpEmit = new THREE.Vector3();
const _tmpVel = new THREE.Vector3();

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Deterministic pseudo-noise for organic river boulder displacement. */
function rockNoise3(x: number, y: number, z: number, seed: number): number {
  return (
    Math.sin(x * 2.3 + seed * 1.7) * Math.cos(y * 2.7 - seed * 0.9) * Math.sin(z * 2.1 + seed * 2.3) * 0.5
    + Math.sin(x * 5.1 - z * 4.3 + seed * 3.1) * Math.cos(y * 4.9 + x * 2.2) * 0.28
    + Math.cos(z * 8.3 + y * 7.1 - seed * 4.7) * 0.12
  );
}

// ---------------------------------------------------------------------------
// River (flowmap-advected water + rocky rapids)
// ---------------------------------------------------------------------------

export class River {
  private readonly weatherProbe = new FieldReading();
  private readonly weatherPoint = new THREE.Vector3();
  readonly group = new THREE.Group();
  readonly optics: RiverOptics = {
    clarity: 0.85,
    foam: 1.0,
    refraction: 1.0,
    sss: 1.0,
    flowScale: 1.0,
    rapidsFoam: 1.15,
    bankFade: 0.14,
  };
  /** Baked 2D flowmap texture: R = vAcross, G = vAlong, B = rapids turbulence, A = pillow height. */
  readonly flowmap: THREE.DataTexture;
  /** Total downstream arc length of the river (m). */
  readonly length: number;
  mesh!: THREE.Mesh;
  rocksMesh: THREE.Mesh | null = null;

  private samples: SplineSample[] = [];
  private rocks: ResolvedRock[] = [];
  private rockSpecs: RapidRockSpec[] = [];
  private outletCarry = new Float64Array(0);
  private readonly rockSpray = {
    position: _tmpEmit, velocity: _tmpVel, radius: 0, spread: 1.6,
    life: 0.75, lifeJitter: 0.4, size: 0.08, sizeEnd: 0.14,
  };
  private readonly rockMist = {
    position: _tmpEmit, velocity: _tmpVel, radius: 0, spread: 0.65,
    life: 1.8, lifeJitter: 0.35, size: 0.75, sizeEnd: 2.1,
  };
  private flowmapSize: number;
  private flowmapHalf: Uint16Array;
  private segmentsAlong: number;
  private segmentsAcross: number;
  private weather: Weather | null;
  private fx: EffectsKit | null;
  private localSpray: ParticleSystem | null = null;
  private localMist: ParticleSystem | null = null;
  private ownsParticles = false;

  private u = {
    absorption: uniform(new THREE.Vector3(0.46, 0.095, 0.045)),
    scatter: uniform(new THREE.Color(0.012, 0.036, 0.045)),
    foamGain: uniform(1.0),
    rapidsFoam: uniform(1.15),
    refraction: uniform(1.0),
    sss: uniform(1.0),
    flowScale: uniform(1.0),
    bankFade: uniform(0.14),
    length: uniform(100),
    meanWidth: uniform(10),
    // Outlet crossfade into a waterfall brink: start fraction along v, and on/off.
    outletFadeStart: uniform(0.98),
    outletFade: uniform(0),
  };

  constructor(private engine: LuminaEngine, options: RiverOptions) {
    if (options.points.length < 2) throw new Error('River requires at least 2 control points');
    Object.assign(this.optics, options.optics);
    this.weather = options.weather ?? null;
    this.fx = options.fx ?? null;
    this.flowmapSize = options.flowmapSize ?? 256;
    this.segmentsAcross = Math.max(6, options.segmentsAcross ?? 20);
    this.group.name = 'lumina-river';

    // Sample Catmull-Rom spline densely for exact arc-length parameterisation & CPU queries.
    this.samples = this.buildSpline(options);
    this.length = this.samples[this.samples.length - 1].s;
    this.segmentsAlong = Math.max(16, options.segmentsAlong ?? Math.min(360, Math.round(this.length * 1.4)));
    this.u.length.value = Math.max(this.length, 1);
    const meanW = this.samples.reduce((acc, s) => acc + s.width, 0) / this.samples.length;
    this.u.meanWidth.value = Math.max(meanW, 1);

    // Prepare flowmap texture.
    this.flowmapHalf = new Uint16Array(this.flowmapSize * this.flowmapSize * 4);
    this.flowmap = new THREE.DataTexture(this.flowmapHalf, this.flowmapSize, this.flowmapSize, THREE.RGBAFormat, THREE.HalfFloatType);
    this.flowmap.wrapS = THREE.ClampToEdgeWrapping;
    this.flowmap.wrapT = THREE.ClampToEdgeWrapping;
    this.flowmap.minFilter = this.flowmap.magFilter = THREE.LinearFilter;
    this.flowmap.generateMipmaps = false;

    // Collect explicit + procedural rapids rocks.
    const specs: RapidRockSpec[] = [...(options.rocks ?? [])];
    if (options.autoRocks && options.autoRocks > 0) {
      this.generateAutoRocks(specs, options.autoRocks, options.seed ?? 4219);
    }
    this.rockSpecs = specs;

    this.resolveRocks();
    this.rebakeFlowmap();
    this.buildSurfaceMesh(engine.quality.preset);
    this.buildRocksMesh();
    this.buildParticles(engine.quality.preset);
  }

  private buildSpline(options: RiverOptions): SplineSample[] {
    const pts = options.points;
    const defW = options.width ?? 12;
    const defS = options.speed ?? 3.2;
    const defD = options.depth ?? 1.8;
    const defT = options.turbulence ?? 0.35;
    const n = pts.length;
    const subPerSeg = 24;
    const raw: SplineSample[] = [];
    const at = (idx: number) => pts[Math.max(0, Math.min(n - 1, idx))];

    for (let i = 0; i < n - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const steps = i === n - 2 ? subPerSeg + 1 : subPerSeg;
      for (let j = 0; j < steps; j++) {
        const t = j / subPerSeg;
        const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
        const z = catmullRom(p0.z, p1.z, p2.z, p3.z, t);
        const width = Math.max(1.2, catmullRom(p0.width ?? defW, p1.width ?? defW, p2.width ?? defW, p3.width ?? defW, t));
        const speed = Math.max(0.2, catmullRom(p0.speed ?? defS, p1.speed ?? defS, p2.speed ?? defS, p3.speed ?? defS, t));
        const depth = Math.max(0.15, catmullRom(p0.depth ?? defD, p1.depth ?? defD, p2.depth ?? defD, p3.depth ?? defD, t));
        const turbulence = Math.max(0, catmullRom(p0.turbulence ?? defT, p1.turbulence ?? defT, p2.turbulence ?? defT, p3.turbulence ?? defT, t));
        raw.push({ x, y, z, tx: 1, ty: 0, tz: 0, rx: 0, rz: 1, width, speed, depth, turbulence, slope: 0, s: 0 });
      }
    }

    let accum = 0;
    for (let i = 0; i < raw.length; i++) {
      if (i > 0) accum += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y, raw[i].z - raw[i - 1].z);
      raw[i].s = accum;
    }
    for (let i = 0; i < raw.length; i++) {
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.max(Math.hypot(dx, dy, dz), 1e-5);
      const tx = dx / len, ty = dy / len, tz = dz / len;
      const hLen = Math.max(Math.hypot(dx, dz), 1e-5);
      raw[i].tx = tx; raw[i].ty = ty; raw[i].tz = tz;
      // Right vector in XZ perpendicular to tangent: cross((tx,0,tz), (0,1,0)) = (-tz, 0, tx).
      raw[i].rx = -dz / hLen;
      raw[i].rz = dx / hLen;
      raw[i].slope = Math.max(0, -dy / len);
    }
    return raw;
  }

  private sampleAtFraction(vNorm: number): SplineSample {
    const targetS = THREE.MathUtils.clamp(vNorm, 0, 1) * this.length;
    const arr = this.samples;
    let lo = 0, hi = arr.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].s < targetS) lo = mid; else hi = mid;
    }
    const a = arr[lo], b = arr[hi];
    const f = b.s > a.s ? (targetS - a.s) / (b.s - a.s) : 0;
    const tx = a.tx + (b.tx - a.tx) * f;
    const ty = a.ty + (b.ty - a.ty) * f;
    const tz = a.tz + (b.tz - a.tz) * f;
    const tLen = Math.max(Math.hypot(tx, ty, tz), 1e-5);
    const rx = a.rx + (b.rx - a.rx) * f;
    const rz = a.rz + (b.rz - a.rz) * f;
    const rLen = Math.max(Math.hypot(rx, rz), 1e-5);
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      tx: tx / tLen, ty: ty / tLen, tz: tz / tLen,
      rx: rx / rLen, rz: rz / rLen,
      width: a.width + (b.width - a.width) * f,
      speed: a.speed + (b.speed - a.speed) * f,
      depth: a.depth + (b.depth - a.depth) * f,
      turbulence: a.turbulence + (b.turbulence - a.turbulence) * f,
      slope: a.slope + (b.slope - a.slope) * f,
      s: targetS,
    };
  }

  private generateAutoRocks(out: RapidRockSpec[], count: number, seed: number): void {
    const rand = mulberry32(seed);
    for (let i = 0; i < count; i++) {
      // Bias slightly toward steeper / higher-turbulence reaches while keeping coverage natural.
      const v = 0.08 + ((i + 0.2 + rand() * 0.6) / count) * 0.84;
      const sp = this.sampleAtFraction(v);
      const u = (rand() * 2 - 1) * 0.68;
      const offset = u * sp.width * 0.5;
      const radius = THREE.MathUtils.clamp(sp.width * (0.065 + rand() * 0.095), 0.55, 2.4);
      out.push({
        x: sp.x + sp.rx * offset,
        z: sp.z + sp.rz * offset,
        radius,
        height: radius * (0.65 + rand() * 0.45),
        seed: Math.floor(rand() * 10000),
      });
    }
  }

  private resolveRocks(): void {
    this.rocks = [];
    this.outletCarry = new Float64Array(this.rockSpecs.length * 2);
    const tmpSample = createEmptyRiverSample();
    for (let i = 0; i < this.rockSpecs.length; i++) {
      const r = this.rockSpecs[i];
      this.projectPoint(r.x, r.z, tmpSample);
      const v = this.length > 1e-4 ? THREE.MathUtils.clamp(tmpSample.distance / this.length, 0, 1) : 0;
      const sp = this.sampleAtFraction(v);
      this.rocks.push({
        x: r.x,
        y: r.y ?? tmpSample.height,
        z: r.z,
        radius: Math.max(0.35, r.radius),
        height: r.height ?? Math.max(0.35, r.radius) * 0.8,
        seed: r.seed ?? (i * 137 + 19),
        u: tmpSample.u,
        v,
        s: tmpSample.distance,
        localSpeed: sp.speed,
        tx: sp.tx,
        tz: sp.tz,
      });
    }
  }

  /** Replace all rapid boulders and re-bake both the flowmap and boulder geometry. */
  setRocks(rocks: RapidRockSpec[]): void {
    this.rockSpecs = [...rocks];
    this.resolveRocks();
    this.rebakeFlowmap();
    this.buildRocksMesh();
  }

  /** Add one boulder to the rapids and re-bake flow deflection & geometry. */
  addRock(rock: RapidRockSpec): void {
    this.rockSpecs.push(rock);
    this.resolveRocks();
    this.rebakeFlowmap();
    this.buildRocksMesh();
  }

  /**
   * Re-bake the 2D river flowmap (`DataTexture`, RGBA HalfFloat):
   *   R = across-channel velocity (m/s)
   *   G = downstream velocity (m/s)
   *   B = rapids turbulence / aerated foam production (0..2)
   *   A = standing wave / boulder pillow height offset (m)
   */
  rebakeFlowmap(): void {
    const N_ = this.flowmapSize;
    const half = this.flowmapHalf;
    const toHalf = THREE.DataUtils.toHalfFloat;

    for (let j = 0; j < N_; j++) {
      const v = j / (N_ - 1);
      const sp = this.sampleAtFraction(v);
      // Downhill slope boosts speed and whitewater energy naturally.
      const slopeBoost = 1 + sp.slope * 3.8;
      const halfW = sp.width * 0.5;

      for (let i = 0; i < N_; i++) {
        const uNorm = (i / (N_ - 1)) * 2 - 1; // [-1, 1]
        const absU = Math.abs(uNorm);
        // Parabolic channel profile: fast in the thalweg, slower near banks.
        const bankProfile = Math.max(0.22, 1 - 0.72 * absU * absU);
        let vAcross = 0;
        let vAlong = sp.speed * slopeBoost * bankProfile;
        let turb = sp.turbulence * (0.45 + 0.55 * bankProfile) + sp.slope * 2.6;
        // Subtle bank-edge eddies & shear foam.
        if (absU > 0.78) turb += THREE.MathUtils.smoothstep(absU, 0.78, 0.98) * 0.35;
        let pillowH = 0;

        const wx = sp.x + sp.rx * (uNorm * halfW);
        const wz = sp.z + sp.rz * (uNorm * halfW);

        // Potential-flow doublet deflection + bow pillow + frothy wake around every boulder.
        for (let k = 0; k < this.rocks.length; k++) {
          const rock = this.rocks[k];
          const dx = wx - rock.x;
          const dz = wz - rock.z;
          const maxRange = rock.radius * 6.5;
          if (Math.abs(dx) > maxRange && Math.abs(dz) > maxRange) continue;
          // Local coordinates aligned with downstream flow at the rock:
          // `ds > 0` downstream of rock, `ds < 0` upstream; `dr` across-channel.
          const hLen = Math.max(Math.hypot(rock.tx, rock.tz), 1e-5);
          const ftx = rock.tx / hLen, ftz = rock.tz / hLen;
          const frx = -ftz, frz = ftx;
          const ds = dx * ftx + dz * ftz;
          const dr = dx * frx + dz * frz;
          const r2 = ds * ds + dr * dr;
          const a = rock.radius * 1.12;
          const a2 = a * a;
          if (r2 > a2 * 36) continue;

          const r = Math.sqrt(Math.max(r2, a2 * 0.12));
          const cosT = ds / r;
          const sinT = dr / r;
          // 2D potential flow around cylinder of radius `a`:
          // u_s = U (1 - (a/r)^2 cos(2θ)), u_r = -U (a/r)^2 sin(2θ)
          const invR2 = Math.min(1.15, a2 / Math.max(r2, a2 * 0.35));
          const cos2T = cosT * cosT - sinT * sinT;
          const sin2T = 2 * sinT * cosT;
          const localU = rock.localSpeed * 0.9;
          vAlong += -localU * invR2 * cos2T * 0.75;
          vAcross += -localU * invR2 * sin2T * 1.15;

          // Upstream bow pillow wave (water piles up against the rock face).
          if (ds < a * 0.3 && ds > -a * 2.6 && Math.abs(dr) < a * 1.8) {
            const upG = Math.exp(-(((ds + a * 0.75) / (a * 0.75)) ** 2) - ((dr / (a * 0.95)) ** 2));
            pillowH += upG * Math.min(0.45, 0.14 * localU * 0.4 + 0.12);
            turb += upG * 1.05;
          }
          // Downstream churning V-wake / hydraulic foam tail.
          if (ds > -a * 0.2 && ds < a * 5.8) {
            const tail = Math.max(0, ds / (a * 5.5));
            const spread = a * (0.75 + tail * 1.25);
            const wakeG = Math.exp(-((dr / spread) ** 2)) * (1 - tail) * THREE.MathUtils.smoothstep(ds, -a * 0.2, a * 0.45);
            turb += wakeG * (1.25 + 0.14 * localU);
            // Standing roostertail wave just behind the rock.
            pillowH += Math.sin(ds * (3.2 / Math.max(a, 0.5))) * wakeG * 0.12;
          }
        }

        const o = (j * N_ + i) * 4;
        half[o]     = toHalf(THREE.MathUtils.clamp(vAcross, -12, 12));
        half[o + 1] = toHalf(THREE.MathUtils.clamp(vAlong, 0.05, 18));
        half[o + 2] = toHalf(THREE.MathUtils.clamp(turb, 0, 2.2));
        half[o + 3] = toHalf(THREE.MathUtils.clamp(pillowH, -0.4, 0.75));
      }
    }
    this.flowmap.needsUpdate = true;
  }

  private buildSurfaceMesh(preset: QualityPreset): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }

    const segL = this.segmentsAlong;
    const segW = this.segmentsAcross;
    const cols = segW + 1;
    const rows = segL + 1;
    const vCount = cols * rows;
    const positions = new Float32Array(vCount * 3);
    const uvs = new Float32Array(vCount * 2);
    const tangents = new Float32Array(vCount * 4); // xyz = downstream tangent, w = local depth
    const rights = new Float32Array(vCount * 3);   // xyz = across-channel right vector

    for (let j = 0; j <= segL; j++) {
      const v = j / segL;
      const sp = this.sampleAtFraction(v);
      const halfW = sp.width * 0.5;
      for (let i = 0; i <= segW; i++) {
        const u01 = i / segW;
        const uSigned = u01 * 2 - 1;
        const idx = j * cols + i;
        positions[idx * 3]     = sp.x + sp.rx * (uSigned * halfW);
        positions[idx * 3 + 1] = sp.y;
        positions[idx * 3 + 2] = sp.z + sp.rz * (uSigned * halfW);
        uvs[idx * 2]     = u01;
        uvs[idx * 2 + 1] = v;
        const edgeDepth = sp.depth * Math.max(0.05, 1 - uSigned * uSigned * 0.92);
        tangents[idx * 4]     = sp.tx;
        tangents[idx * 4 + 1] = sp.ty;
        tangents[idx * 4 + 2] = sp.tz;
        tangents[idx * 4 + 3] = edgeDepth;
        rights[idx * 3]     = sp.rx;
        rights[idx * 3 + 1] = 0;
        rights[idx * 3 + 2] = sp.rz;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < segL; j++) {
      for (let i = 0; i < segW; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = (j + 1) * cols + i;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('aRiverTangent', new THREE.BufferAttribute(tangents, 4));
    geom.setAttribute('aRiverRight', new THREE.BufferAttribute(rights, 3));
    geom.setIndex(vCount > 65535 ? new THREE.BufferAttribute(new Uint32Array(indices), 1) : new THREE.BufferAttribute(new Uint16Array(indices), 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const material = this.createRiverMaterial(preset);
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.renderOrder = -8;
    this.mesh.name = 'lumina-river-surface';
    this.group.add(this.mesh);
  }

  private createRiverMaterial(preset: QualityPreset): THREE.NodeMaterial {
    const u = this.u;
    const weather = this.weather;
    const flowTex = this.flowmap;
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const aTan = attribute('aRiverTangent', 'vec4');
    const aRight = attribute('aRiverRight', 'vec3');
    const flowV = texture(flowTex, uv()).level(0);
    const t = frame.time;

    // Standing rapid wave chop & boulder pillow displacement along the river mesh.
    const metricPos = vec2(uv().x.mul(u.meanWidth), uv().y.mul(u.length));
    const speedV = length(flowV.xy).mul(u.flowScale);
    const rapidWave = sin(metricPos.y.mul(2.1).sub(t.mul(speedV.mul(1.25).add(2.2))).add(sin(metricPos.x.mul(1.7)).mul(1.3)))
      .mul(0.065)
      .mul(flowV.z.clamp(0, 1.8));
    const edgeMaskV = smoothstep(0.0, 0.14, uv().x).mul(smoothstep(1.0, 0.86, uv().x));
    const probe=TSL.modelWorldMatrix.mul(vec4(positionGeometry,1)).xyz;
    const scalar=this.engine.world.scalarNode(probe);
    const stormCurrent=this.engine.world.localWindNode(probe).xz.mul(0.12).toVarying('riverStormCurrent');
    const liftY = flowV.w.add(rapidWave).mul(edgeMaskV).sub(scalar.x.mul(0.028).clamp(-0.65,0.65));
    material.positionNode = positionGeometry.add(vec3(0, liftY, 0));

    const vUv = uv().toVarying('rUv');
    const vTan = aTan.xyz.toVarying('rTan');
    const vDepth = aTan.w.toVarying('rDepth');
    const vRight = aRight.toVarying('rRight');
    const vLift = liftY.toVarying('rLift');

    material.colorNode = Fn(() => {
      const P = positionWorld;
      const toCam = cameraPosition.sub(P);
      const viewDist = length(toCam);
      const V = toCam.div(max(viewDist, 1e-4));
      const L = frame.sunDirection;

      // Sample baked flowmap: xy = (vAcross, vAlong) m/s, z = rapids turbulence, w = pillow height.
      const flow = texture(flowTex, vUv);
      const vel = flow.xy.mul(u.flowScale).add(vec2(dot(stormCurrent,vRight.xz),dot(stormCurrent,vTan.xz)));
      const turb = flow.z;
      const speed = length(vel);

      // Metric river-space coordinates (x across, y downstream) + screen-space footprint for AA.
      const rCoord = vec2(vUv.x.mul(u.meanWidth), vUv.y.mul(u.length));
      const dRx = dFdx(rCoord), dRy = dFdy(rCoord);
      const footprintMax = max(length(dRx), length(dRy));

      // ---- Dual-phase flowmap advection (hides cycle reset with per-pixel noise jitter) ----
      const cycleRate = float(0.42);
      const jitter = valueNoise2(rCoord.mul(0.45)).mul(0.35);
      const p0 = fract(t.mul(cycleRate).add(jitter));
      const p1 = fract(t.mul(cycleRate).add(0.5).add(jitter));
      const blend = abs(p0.mul(2).sub(1));

      // Advected coordinates in metres: flow moves water patterns downstream (negative UV shift).
      const adv0 = rCoord.sub(vel.mul(p0.div(cycleRate)));
      const adv1 = rCoord.sub(vel.mul(p1.div(cycleRate)));

      // Multi-octave advected surface slopes (band-limited by pixel footprint).
      const gradNoise = (q: N, freq: number): N => {
        const p = q.mul(freq);
        const e = 0.25;
        const c0 = valueNoise2(p);
        return vec2(valueNoise2(p.add(vec2(e, 0))).sub(c0), valueNoise2(p.add(vec2(0, e))).sub(c0)).div(e);
      };
      const wFine = float(1).sub(smoothstep(0.03, 0.22, footprintMax));
      const slope0 = gradNoise(adv0, 1.35).mul(0.55).add(gradNoise(adv0.mul(vec2(1.4, 0.85)), 3.8).mul(0.45).mul(wFine));
      const slope1 = gradNoise(adv1.add(vec2(13.7, 5.3)), 1.35).mul(0.55).add(gradNoise(adv1.mul(vec2(1.4, 0.85)).add(vec2(7.1, 11.9)), 3.8).mul(0.45).mul(wFine));
      const slope = mix(slope0, slope1, blend).mul(turb.mul(0.42).add(0.16)).toVar();

      const Nbase = normalize(vec3(0, 1, 0).sub(vRight.mul(slope.x)).sub(vTan.mul(slope.y)));
      const Nw = normalize(Nbase.add(V.mul(max(float(0.04).sub(dot(Nbase, V)), 0))));
      const NdotV = max(dot(Nw, V), 0.02);
      const unresolvedVar = float(1).sub(wFine).mul(turb.mul(0.06).add(0.012));
      const alpha2 = specularAA(Nw, unresolvedVar.add(0.0012).min(0.32), 0.25, 0.14);
      const roughness = alpha2.sqrt().sqrt();

      // ---- Reflection + GGX sun glitter -------------------------------------
      const shadow = weather ? weather.cloudShadow(P) : frame.sunVisibility;
      const skyAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.55);
      const R = reflect(V.negate(), Nw);
      const reflection = weather
        ? weather.reflection(R, roughness.mul(7))
        : mix(frame.skyHorizon, frame.skyZenith, max(R.y, 0.02).pow(0.55));
      const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV).max(0), 5)));
      const H = normalize(L.add(V));
      const NdotH = max(dot(Nw, H), 0);
      const NdotL = max(dot(Nw, L), 0);
      const dTerm = NdotH.mul(NdotH).mul(alpha2.sub(1)).add(1);
      const D = alpha2.div(dTerm.mul(dTerm).mul(Math.PI));
      const FH = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(V, H), 0)), 5)));
      const sunGlint = frame.sunColor.mul(shadow).mul(min(D.mul(FH).mul(NdotL).div(NdotL.mul(NdotV).mul(4).add(0.02)), 70));

      // ---- Refraction + Beer–Lambert river body -----------------------------
      const downwelling = frame.sunColor.mul(max(L.y, 0)).mul(shadow).mul(1 / Math.PI).add(skyAmbient);
      const inscatter = u.scatter.mul(downwelling);
      const analyticCol = vDepth.div(max(NdotV, 0.35));
      const analyticTransmit = exp(u.absorption.mul(analyticCol).negate());
      const bedColor = vec3(0.28, 0.25, 0.20).mul(downwelling).mul(exp(u.absorption.mul(vDepth).negate()));
      const transmit = vec3(analyticTransmit).toVar();
      const background = vec3(bedColor).toVar();
      const contact = float(0).toVar();

      if (preset.ocean.refraction) {
        If(viewDist.lessThan(180), () => {
          const surfaceZ = positionView.z.negate();
          const sceneZ0 = perspectiveDepthToViewZ(viewportDepthAt(screenUV), cameraNear, cameraFar).negate();
          const col0 = sceneZ0.sub(surfaceZ);
          const viewN = cameraViewMatrix.mul(vec4(Nw, 0)).xyz;
          const offset = viewN.xy.mul(vec2(-1, 1)).mul(u.refraction).mul(0.038).mul(smoothstep(0.0, 1.0, col0)).div(surfaceZ.mul(0.05).add(1));
          const uvR = refractedScreenUV(screenUV, offset);
          const thickness = col0.max(0).mul(viewDist.div(max(surfaceZ, 0.1)));
          contact.assign(smoothstep(0.004, 0.035, thickness).mul(smoothstep(0.05, 0.21, thickness).oneMinus())
            .mul(smoothstep(26, 55, viewDist).oneMinus()));
          const sceneZ1 = perspectiveDepthToViewZ(viewportDepthAt(uvR), cameraNear, cameraFar).negate();
          const valid = sceneZ1.greaterThan(surfaceZ.add(0.02));
          const uvFinal = select(valid, uvR, screenUV);
          const sceneZ = select(valid, sceneZ1, sceneZ0);
          const hasFloor = sceneZ.lessThan(cameraFar.mul(0.5));
          const column = max(sceneZ.sub(surfaceZ), 0).mul(viewDist.div(max(surfaceZ, 0.1)));
          const far = smoothstep(130, 180, viewDist);
          transmit.assign(mix(select(hasFloor, exp(u.absorption.mul(column).negate()), analyticTransmit), analyticTransmit, far));
          background.assign(mix(select(hasFloor, viewportSharedTexture(uvFinal).rgb, bedColor), bedColor, far));
        });
      }

      // Crest & rapid standing-wave SSS.
      const Hsss = normalize(L.add(Nw.mul(0.45)));
      const backLit = pow(max(dot(V, Hsss.negate()), 0), 3.5);
      const crestThin = smoothstep(-0.02, 0.22, vLift).add(turb.mul(0.25)).clamp(0, 1).mul(float(1).sub(NdotV).mul(0.65).add(0.35));
      const sss = vec3(0.06, 0.44, 0.38).mul(frame.sunColor).mul(shadow).mul(1 / Math.PI)
        .mul(crestThin).mul(backLit.mul(0.75).add(0.2)).mul(u.sss);

      const body = background.mul(transmit).add(inscatter.mul(vec3(1).sub(transmit))).add(sss);
      const color = mix(body, reflection, fresnel).add(sunGlint).toVar();

      // ---- Flowmap-advected cellular stretched rapids foam & aerated streaks ---
      const foamAmount = smoothstep(0.30, 1.8, turb).mul(u.rapidsFoam).mul(u.foamGain).clamp(0, 1.3);
      If(foamAmount.greaterThan(0.04), () => {
        // Stretch cells & aerated streaks along the flow direction (y in river coordinates).
        const sCoord0 = vec2(adv0.x.mul(5.6), adv0.y.mul(2.5));
        const sCoord1 = vec2(adv1.x.mul(5.6).add(4.7), adv1.y.mul(2.5).add(9.1));
        const cell0 = voronoi2(sCoord0, t.mul(0.8));
        const cell1 = voronoi2(sCoord1, t.mul(0.8).add(1.7));
        const web0 = float(1).sub(smoothstep(0.015, 0.14, cell0.y.sub(cell0.x)));
        const web1 = float(1).sub(smoothstep(0.015, 0.14, cell1.y.sub(cell1.x)));
        const rawWeb = mix(web0, web1, blend);
        const web = mix(rawWeb, float(0.45), smoothstep(0.08, 0.5, footprintMax));

        const streak0 = fbm2(vec2(adv0.x.mul(1.3), adv0.y.mul(0.18)), 3);
        const streak1 = fbm2(vec2(adv1.x.mul(1.3).add(6.3), adv1.y.mul(0.18).add(3.7)), 3);
        const streaks = smoothstep(0.32, 0.82, mix(streak0, streak1, blend));

        // Subsurface aerated turquoise-white cloud under rapid chutes.
        const subAerated = smoothstep(0.12, 0.75, foamAmount).mul(streaks.mul(0.65).add(0.22)).mul(0.34);
        const aeratedCol = vec3(0.55, 0.78, 0.78).mul(downwelling.mul(0.75).add(skyAmbient.mul(0.45)));
        color.assign(mix(color, aeratedCol, subAerated.clamp(0, 0.55)));

        const lace = web.mul(0.22).add(streaks.mul(0.64)).add(mix(valueNoise2(adv0.mul(8.4)), valueNoise2(adv1.mul(8.4)), blend).mul(0.14));
        const mask = smoothstep(float(0.95).sub(foamAmount.mul(0.65)), float(1.26).sub(foamAmount.mul(0.65)), lace.add(foamAmount.mul(0.16)))
          .mul(smoothstep(0.04, 0.2, foamAmount));
        const thickness = smoothstep(0.35, 1.35, foamAmount.mul(lace.mul(0.8).add(0.55)));
        const foamAlbedo = mix(vec3(0.62, 0.74, 0.74), vec3(0.96, 0.97, 0.96), thickness);
        const foamSun = dot(normalize(mix(vec3(0, 1, 0), Nw, 0.5)), L).add(0.55).div(1.55).clamp(0, 1);
        const foamLit = foamAlbedo.mul(frame.sunColor.mul(shadow).mul(foamSun).mul(1 / Math.PI).add(skyAmbient.mul(1.08)));
        color.assign(mix(color, foamLit, mask.mul(mix(0.6, 0.96, thickness))));
      });

      if (preset.ocean.refraction) {
        // The undistorted depth anchors fine, broken lines of trapped air to partly
        // submerged rocks and hulls. The foam travels with the local water velocity.
        const bubbles = mix(valueNoise2(adv0.mul(8.3)), valueNoise2(adv1.mul(8.3)), blend);
        const coverage = contact.mul(smoothstep(0.24, 0.78, bubbles))
          .mul(smoothstep(0.3, 3.5, speed)).mul(0.58);
        color.assign(mix(color, vec3(0.73, 0.83, 0.80).mul(downwelling), coverage));
      }

      // Soft bank-margin alpha feathering so the river meets terrain cleanly.
      const bankAlpha = smoothstep(0.0, u.bankFade, vUv.x).mul(smoothstep(1.0, float(1).sub(u.bankFade), vUv.x))
        // A river that pours into a waterfall hands its last metre to the sheet's glassy
        // brink instead of ending in a hard, hanging edge.
        .mul(mix(float(1), smoothstep(1.0, u.outletFadeStart, vUv.y), u.outletFade));
      const finalRgb = weather ? weather.aerial(color, P) : color;
      return vec4(finalRgb, bankAlpha);
    })();

    material.mrtNode = auxSurface(cameraViewMatrix.mul(vec4(vec3(0, 1, 0), 0)).xyz, screenVelocity(positionWorld, positionWorld));
    return material;
  }

  /** Build a single merged geometry for all boulders in the rapids (1 draw call). */
  private buildRocksMesh(): void {
    if (this.rocksMesh) {
      this.group.remove(this.rocksMesh);
      this.rocksMesh.geometry.dispose();
      (this.rocksMesh.material as THREE.Material).dispose();
      this.rocksMesh = null;
    }
    if (this.rocks.length === 0) return;

    // Weld the polyhedron first: the unindexed icosahedron gave every triangle its own
    // normal, so boulders shaded as faceted gems. Shared vertices now interpolate across edges.
    const shell = new THREE.IcosahedronGeometry(1, 2);
    shell.deleteAttribute('normal');
    shell.deleteAttribute('uv');
    const base = mergeVertices(shell);
    shell.dispose();
    const basePos = base.attributes.position as THREE.BufferAttribute;
    const baseIdx = base.index;
    const vPerRock = basePos.count;
    const iPerRock = baseIdx?.count ?? vPerRock;
    const totalV = vPerRock * this.rocks.length;
    const totalI = iPerRock * this.rocks.length;

    const positions = new Float32Array(totalV * 3);
    const wetHeight = new Float32Array(totalV); // vertex world Y minus local water height
    const indices = totalV > 65535 ? new Uint32Array(totalI) : new Uint16Array(totalI);

    for (let rIdx = 0; rIdx < this.rocks.length; rIdx++) {
      const rock = this.rocks[rIdx];
      const vOff = rIdx * vPerRock;
      const iOff = rIdx * iPerRock;
      const sx = rock.radius * (0.9 + ((rock.seed % 17) / 17) * 0.35);
      const sy = rock.height;
      const sz = rock.radius * (0.85 + (((rock.seed * 7) % 19) / 19) * 0.4);
      const yaw = (rock.seed * 1.618) % (Math.PI * 2);
      const cy = Math.cos(yaw), syaw = Math.sin(yaw);

      for (let v = 0; v < vPerRock; v++) {
        const bx = basePos.getX(v), by = basePos.getY(v), bz = basePos.getZ(v);
        const disp = 1 + rockNoise3(bx, by, bz, rock.seed) * 0.28;
        // Slightly flatten the underside and crown so river boulders look water-worn.
        const lx = bx * sx * disp;
        const ly = (by < 0 ? by * 0.72 : by * 0.92) * sy * disp;
        const lz = bz * sz * disp;
        const wx = rock.x + lx * cy - lz * syaw;
        const wy = rock.y - rock.height * 0.18 + ly;
        const wz = rock.z + lx * syaw + lz * cy;
        positions[(vOff + v) * 3]     = wx;
        positions[(vOff + v) * 3 + 1] = wy;
        positions[(vOff + v) * 3 + 2] = wz;
        wetHeight[vOff + v] = wy - rock.y;
      }
      for (let idx = 0; idx < iPerRock; idx++) {
        indices[iOff + idx] = (baseIdx ? baseIdx.getX(idx) : idx) + vOff;
      }
    }
    base.dispose();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aWetHeight', new THREE.BufferAttribute(wetHeight, 1));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const material = new THREE.MeshStandardNodeMaterial();
    material.metalness = 0.02;
    const hAbove = attribute('aWetHeight', 'float');
    const P = positionWorld;
    const grain = fbm2(P.xz.mul(1.8).add(P.y.mul(1.3)), 3);
    const fine = valueNoise2(P.xz.mul(9.5).add(P.y.mul(7.0)));
    const granite = mix(vec3(0.18, 0.19, 0.20), vec3(0.42, 0.40, 0.37), grain).mul(mix(0.84, 1.12, fine));
    const moss = smoothstep(0.12, 0.55, hAbove).mul(smoothstep(0.45, 0.75, fbm2(P.xz.mul(0.9).add(5.3), 2)));
    const dryColor = mix(granite, vec3(0.13, 0.21, 0.09), moss.mul(0.55));
    // Wet splash zone: darkened, glossy rock up to ~0.45 m above the waterline.
    const wet = smoothstep(0.52, -0.05, hAbove);
    const hRim = hAbove.div(0.09);
    const foamRim = exp(hRim.mul(hRim).negate()).mul(smoothstep(0.35, 0.75, fine)).mul(0.55);
    material.colorNode = mix(dryColor.mul(mix(1.0, 0.44, wet)), vec3(0.88, 0.92, 0.92), foamRim);
    material.roughnessNode = mix(float(0.84), float(0.18), wet);

    this.rocksMesh = new THREE.Mesh(geom, material);
    this.rocksMesh.castShadow = true;
    this.rocksMesh.receiveShadow = true;
    this.rocksMesh.name = 'lumina-river-rapids-rocks';
    this.group.add(this.rocksMesh);
  }

  private buildParticles(preset: QualityPreset): void {
    if (this.fx) {
      if (this.ownsParticles) {
        this.localSpray?.dispose();
        this.localMist?.dispose();
        this.localSpray = this.localMist = null;
        this.ownsParticles = false;
      }
      return;
    }
    this.localSpray?.dispose();
    this.localMist?.dispose();
    const { renderer, wind, scene, pipeline } = this.engine;
    const sprayCap = Math.max(128, Math.min(1024, Math.floor(preset.particles.budget * 0.04)));
    const mistCap = Math.max(128, Math.min(768, Math.floor(preset.particles.budget * 0.03)));
    this.localSpray = new ParticleSystem(renderer, wind, {
      capacity: sprayCap, shading: 'spray', gravity: 1, drag: 0.45, windInfluence: 0.5, stretch: 0.04, opacity: 0.78, softness: 0.35,
    });
    this.localMist = new ParticleSystem(renderer, wind, {
      capacity: mistCap, shading: 'mist', softDepth: pipeline.sceneDepth, gravity: 0.04, drag: 1.5, turbulence: 0.8, windInfluence: 0.8, opacity: 0.24, softness: 1.0,
    });
    scene.add(this.localSpray.mesh);
    pipeline.softScene.add(this.localMist.mesh);
    this.ownsParticles = true;
  }

  private projectPoint(x: number, z: number, out: RiverSample): void {
    const arr = this.samples;
    let bestD2 = Infinity;
    let bestI = 0;
    let bestT = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const ab2 = abx * abx + abz * abz;
      const t = ab2 > 1e-8 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / ab2, 0, 1) : 0;
      const px = a.x + abx * t, pz = a.z + abz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bestD2) { bestD2 = d2; bestI = i; bestT = t; }
    }
    const a = arr[bestI], b = arr[bestI + 1];
    const px = a.x + (b.x - a.x) * bestT;
    const py = a.y + (b.y - a.y) * bestT;
    const pz = a.z + (b.z - a.z) * bestT;
    const rx = a.rx + (b.rx - a.rx) * bestT;
    const rz = a.rz + (b.rz - a.rz) * bestT;
    const rLen = Math.max(Math.hypot(rx, rz), 1e-5);
    const urx = rx / rLen, urz = rz / rLen;
    const tx = a.tx + (b.tx - a.tx) * bestT;
    const tz = a.tz + (b.tz - a.tz) * bestT;
    const tLen = Math.max(Math.hypot(tx, tz), 1e-5);
    const utx = tx / tLen, utz = tz / tLen;

    const width = a.width + (b.width - a.width) * bestT;
    const halfW = width * 0.5;
    const signedOffset = (x - px) * urx + (z - pz) * urz;
    const u = signedOffset / Math.max(halfW, 1e-4);
    const bankDist = halfW - Math.abs(signedOffset);
    const along = (x - px) * utx + (z - pz) * utz;
    const beforeStart = bestI === 0 && bestT === 0 && along < -1e-4;
    const afterEnd = bestI === arr.length - 2 && bestT === 1 && along > 1e-4;
    const inside = bankDist >= 0 && !beforeStart && !afterEnd;
    const baseDepth = a.depth + (b.depth - a.depth) * bestT;
    const baseSpeed = (a.speed + (b.speed - a.speed) * bestT) * this.optics.flowScale;
    const slope = a.slope + (b.slope - a.slope) * bestT;
    const baseTurb = a.turbulence + (b.turbulence - a.turbulence) * bestT;

    const absU = Math.min(1, Math.abs(u));
    const bankProfile = Math.max(0.22, 1 - 0.72 * absU * absU);
    let vAlong = baseSpeed * (1 + slope * 3.8) * bankProfile;
    let vAcross = 0;
    let turb = baseTurb * (0.45 + 0.55 * bankProfile) + slope * 2.6;
    let pillowH = 0;

    if (inside) {
      for (let k = 0; k < this.rocks.length; k++) {
        const rock = this.rocks[k];
        const dx = x - rock.x, dz = z - rock.z;
        const r2 = dx * dx + dz * dz;
        const rad = rock.radius * 1.12;
        if (r2 > rad * rad * 36) continue;
        const r = Math.sqrt(Math.max(r2, rad * rad * 0.12));
        const ds = dx * utx + dz * utz;
        const dr = dx * urx + dz * urz;
        const cosT = ds / r, sinT = dr / r;
        const invR2 = Math.min(1.15, (rad * rad) / Math.max(r2, rad * rad * 0.35));
        const localU = rock.localSpeed * 0.9 * this.optics.flowScale;
        vAlong += -localU * invR2 * (cosT * cosT - sinT * sinT) * 0.75;
        vAcross += -localU * invR2 * (2 * sinT * cosT) * 1.15;
        if (ds < rad * 0.3 && ds > -rad * 2.6 && Math.abs(dr) < rad * 1.8) {
          const upG = Math.exp(-(((ds + rad * 0.75) / (rad * 0.75)) ** 2) - ((dr / (rad * 0.95)) ** 2));
          pillowH += upG * 0.24;
          turb += upG * 1.05;
        }
        if (ds > -rad * 0.2 && ds < rad * 5.8) {
          const tail = Math.max(0, ds / (rad * 5.5));
          const spread = rad * (0.75 + tail * 1.25);
          const wakeG = Math.exp(-((dr / spread) ** 2)) * (1 - tail) * THREE.MathUtils.smoothstep(ds, -rad * 0.2, rad * 0.45);
          turb += wakeG * 1.4;
        }
      }
    }

    out.inside = inside;
    out.height = py + pillowH;
    out.depth = inside ? baseDepth * Math.max(0.05, 1 - absU * absU * 0.92) : 0;
    if (inside) out.velocity.set(utx * vAlong + urx * vAcross, 0, utz * vAlong + urz * vAcross);
    else out.velocity.set(0, 0, 0);
    out.speed = inside ? Math.hypot(vAlong, vAcross) : 0;
    out.turbulence = inside ? Math.min(2.2, turb) : 0;
    out.bankDistance = bankDist;
    out.u = u;
    out.distance = a.s + (b.s - a.s) * bestT;
  }

  /** @internal Fade this river's outlet when it ends at a waterfall crest (visual only). */
  updateOutlet(waterfalls: readonly Waterfall[]): void {
    const end = this.samples[this.samples.length - 1];
    const linked = waterfalls.some(({crestPosition: p}) =>
      Math.hypot(end.x - p.x, end.z - p.z) <= 2.5 && Math.abs(end.y - p.y) <= 1);
    this.u.outletFadeStart.value = THREE.MathUtils.clamp(1 - 1.4 / Math.max(this.length, 1e-3), 0, 0.999);
    this.u.outletFade.value = linked ? 1 : 0;
  }

  /** Zero-allocation CPU query of height, depth, boulder-deflected velocity and rapids turbulence. */
  sample(x: number, z: number, out: RiverSample = createEmptyRiverSample()): RiverSample {
    this.projectPoint(x, z, out);
    if(out.inside && this.engine.world.sourceCount){
      const field=this.engine.world.disturbance(this.weatherPoint.set(x,out.height,z),this.weatherProbe);
      out.height-=THREE.MathUtils.clamp(field.pressure*0.028,-0.65,0.65);
      out.velocity.x+=field.wind.x*0.12;out.velocity.z+=field.wind.z*0.12;
      out.speed=out.velocity.length();
    }
    return out;
  }

  setQuality(preset: QualityPreset): void {
    this.buildSurfaceMesh(preset);
    this.buildParticles(preset);
  }

  update(dt: number): void {
    const clarity = THREE.MathUtils.clamp(this.optics.clarity, 0, 1);
    const murk = THREE.MathUtils.lerp(4.8, 1.0, clarity);
    (this.u.absorption.value as THREE.Vector3).set(0.46 * (0.65 + 0.35 * murk), 0.095 * murk, 0.036 * murk * murk * 0.55 + 0.016);
    (this.u.scatter.value as THREE.Color).setRGB(
      THREE.MathUtils.lerp(0.032, 0.008, clarity),
      THREE.MathUtils.lerp(0.055, 0.034, clarity),
      THREE.MathUtils.lerp(0.028, 0.048, clarity),
    );
    this.u.foamGain.value = Math.max(0, this.optics.foam);
    this.u.rapidsFoam.value = Math.max(0, this.optics.rapidsFoam);
    this.u.refraction.value = Math.max(0, this.optics.refraction);
    this.u.sss.value = Math.max(0, this.optics.sss);
    this.u.flowScale.value = Math.max(0.05, this.optics.flowScale);
    this.u.bankFade.value = THREE.MathUtils.clamp(this.optics.bankFade, 0.03, 0.45);

    // Emit rocky rapids spray & low mist around submerged boulders.
    const sprayPool = this.fx ? this.fx.spray : this.localSpray;
    const mistPool = this.fx ? this.fx.mist : this.localMist;
    if (dt > 0 && this.rocks.length > 0 && (sprayPool || mistPool)) {
      const flowScale = this.optics.flowScale;
      for (let i = 0; i < this.rocks.length; i++) {
        const rock = this.rocks[i];
        const energy = Math.max(0, rock.localSpeed * flowScale - 1.4) * this.optics.rapidsFoam;
        if (energy < 0.25) continue;
        // Upstream pillow splash spray.
        if (sprayPool) {
          _tmpEmit.set(rock.x - rock.tx * rock.radius * 0.75, rock.y + 0.15, rock.z - rock.tz * rock.radius * 0.75);
          _tmpVel.set(rock.tx * 1.4, 1.3 + energy * 0.35, rock.tz * 1.4);
          this.rockSpray.radius = rock.radius * 0.55;
          sprayPool.emitRateAt(this.outletCarry, i * 2, Math.min(24, energy * 4.5), dt, this.rockSpray);
        }
        // Fine aerated mist veil behind fierce rapids boulders.
        if (mistPool && energy > 1.2) {
          _tmpEmit.set(rock.x + rock.tx * rock.radius * 0.6, rock.y + 0.35, rock.z + rock.tz * rock.radius * 0.6);
          _tmpVel.set(rock.tx * 0.8, 0.6, rock.tz * 0.8);
          this.rockMist.radius = rock.radius * 0.8;
          mistPool.emitRateAt(this.outletCarry, i * 2 + 1, Math.min(8, energy * 1.5), dt, this.rockMist);
        }
      }
    }
    if (this.ownsParticles) {
      this.localSpray?.update();
      this.localMist?.update();
    }
  }

  dispose(): void {
    this.flowmap.dispose();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    if (this.rocksMesh) {
      this.rocksMesh.geometry.dispose();
      (this.rocksMesh.material as THREE.Material).dispose();
    }
    if (this.ownsParticles) {
      this.localSpray?.dispose();
      this.localMist?.dispose();
    }
    this.group.removeFromParent();
  }
}

export function createEmptyRiverSample(): RiverSample {
  return {
    inside: false,
    height: 0,
    depth: 0,
    velocity: new THREE.Vector3(),
    speed: 0,
    turbulence: 0,
    bankDistance: -1e6,
    u: 0,
    distance: 0,
  };
}

// ---------------------------------------------------------------------------
// Waterfall (ballistic falling sheet + plunge boil ring + plunge mist/spray)
// ---------------------------------------------------------------------------

export class Waterfall {
  readonly group = new THREE.Group();
  readonly crestPosition: THREE.Vector3;
  readonly plungePosition: THREE.Vector3;
  readonly direction: THREE.Vector2;
  readonly width: number;
  readonly height: number;
  readonly throwDistance: number;
  readonly plungeRadius: number;
  /** Live flow/discharge multiplier (0 = dry, 1 = nominal, 2 = flood). */
  flow: number;
  /** Plunge mist & splash emission multiplier (0..2). */
  mistIntensity: number;
  /** Sheet whitewater aeration (0..1). */
  aeration: number;

  sheetMesh!: THREE.Mesh;
  plungeMesh!: THREE.Mesh;

  private exitSpeed: number;
  private weather: Weather | null;
  private fx: EffectsKit | null;
  private localMist: ParticleSystem | null = null;
  private localSpray: ParticleSystem | null = null;
  private ownsParticles = false;
  private readonly emitterCarry = new Float64Array(4);
  private readonly mistPuff = {
    position: _tmpEmit, velocity: _tmpVel, radius: 1, spread: 1.1,
    life: 2.35, lifeJitter: 0.45, size: 1, sizeEnd: 3.5,
  };
  private readonly impactSpray = {
    position: _tmpEmit, velocity: _tmpVel, radius: 1, spread: 2.8,
    life: 1.15, lifeJitter: 0.4, size: 0.10, sizeEnd: 0.18,
  };

  private u = {
    flow: uniform(1),
    aeration: uniform(0.85),
    width: uniform(8),
    height: uniform(14),
    exitSpeed: uniform(4.2),
    plungeY: uniform(0),
  };

  constructor(private engine: LuminaEngine, options: WaterfallOptions) {
    this.weather = options.weather ?? null;
    this.fx = options.fx ?? null;
    this.crestPosition = new THREE.Vector3(options.position.x, options.position.y, options.position.z);

    if (typeof options.direction === 'number') {
      this.direction = new THREE.Vector2(Math.cos(options.direction), Math.sin(options.direction));
    } else if (options.direction) {
      this.direction = new THREE.Vector2(options.direction.x, options.direction.z);
      if (this.direction.lengthSq() > 1e-8) this.direction.normalize(); else this.direction.set(1, 0);
    } else {
      this.direction = new THREE.Vector2(1, 0);
    }

    this.width = Math.max(1, options.width ?? 8);
    this.height = Math.max(1.5, options.height ?? 14);
    this.exitSpeed = Math.max(0.8, options.exitSpeed ?? 4.2);
    const fallTime = Math.sqrt((2 * this.height) / GRAVITY);
    this.throwDistance = Math.max(0.8, options.throwDistance ?? this.exitSpeed * fallTime);
    this.plungeRadius = Math.max(this.width * 0.55, options.plungeRadius ?? this.width * 0.9);
    this.aeration = THREE.MathUtils.clamp(options.aeration ?? 0.85, 0, 1);
    this.mistIntensity = Math.max(0, options.mistIntensity ?? 1);
    this.flow = Math.max(0, options.flow ?? 1);

    this.plungePosition = new THREE.Vector3(
      this.crestPosition.x + this.direction.x * this.throwDistance,
      this.crestPosition.y - this.height,
      this.crestPosition.z + this.direction.y * this.throwDistance,
    );

    this.mistPuff.radius = Math.max(0.48, this.width * 0.15);
    this.mistPuff.size = Math.max(0.75, this.width * 0.105);
    this.mistPuff.sizeEnd = Math.max(2.25, this.width * 0.32);
    this.impactSpray.radius = this.width * 0.48;
    this.u.width.value = this.width;
    this.u.height.value = this.height;
    this.u.exitSpeed.value = this.exitSpeed;
    this.u.aeration.value = this.aeration;
    this.u.flow.value = this.flow;
    this.u.plungeY.value = this.plungePosition.y;

    this.group.name = 'lumina-waterfall';
    this.buildSheetMesh();
    this.buildPlungeMesh();
    this.buildParticles(engine.quality.preset);
  }

  /** Ballistic parabolic falling water sheet mesh, preceded by a short glassy brink where
   * the river accelerates over the lip (uv.y < 0). */
  private buildSheetMesh(): void {
    const segW = Math.max(14, Math.min(48, Math.round(this.width * 2.4)));
    const segH = Math.max(20, Math.min(56, Math.round(this.height * 2.2)));
    const approachRows = 4, approachLength = 1.2, approachV = 0.08;
    const cols = segW + 1;
    const rows = segH + 1 + approachRows;
    const positions = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    const normals = new Float32Array(cols * rows * 3);
    const dirX = this.direction.x, dirZ = this.direction.y;
    const rightX = -dirZ, rightZ = dirX;

    for (let row = 0; row < rows; row++) {
      const j = row - approachRows;
      // v < 0: brink approach (upstream of the lip), v = 0 at the lip, v = 1 at plunge
      // impact (slight over-drop into the boil ring).
      const a = j < 0 ? j / approachRows : 0; // -1..0 across the approach
      const v = Math.max(0, j / segH);
      const vDrop = v * 1.03;
      const forward = j < 0 ? a * approachLength : this.throwDistance * vDrop;
      // The brink surface is level and C¹-continuous with the parabola's horizontal start.
      const y = j < 0 ? this.crestPosition.y + 0.012 * (1 + a) : this.crestPosition.y - this.height * vDrop * vDrop;
      const blend = j < 0 ? 1 + a : 1;
      // Falling sheet fans out gently as air entrains the curtain.
      const spread = 1 + v * 0.18;
      // Tangent along parabola: (throwDistance, -2*height*vDrop)
      const ds = this.throwDistance;
      const dy = -2 * this.height * Math.max(vDrop, 0.06);
      const tLen = Math.hypot(ds, dy);
      // Outward normal pointing away from cliff face (up-and-forward); up on the brink.
      const nForward = j < 0 ? 0 : -dy / tLen;
      const nY = j < 0 ? 1 : ds / tLen;

      for (let i = 0; i <= segW; i++) {
        const u01 = i / segW;
        const uSigned = u01 * 2 - 1;
        // Organic lip undulation creates distinct ribbon curtains across the waterfall width.
        const curtainBulge = (Math.sin(u01 * Math.PI * 3.0 + 0.4) * 0.24 + Math.sin(u01 * Math.PI * 7.0) * 0.11) * (0.3 + 0.7 * v) * blend;
        const lateral = uSigned * this.width * 0.5 * spread;
        const idx = row * cols + i;
        const chute = Math.sin(u01 * 15.3 + 0.64) * 0.22 + Math.sin(u01 * 39.6 + 1.9) * 0.094;
        const throwVariation = j < 0 ? forward : forward * (1 + chute * 0.65);
        positions[idx * 3]     = this.crestPosition.x + dirX * (throwVariation + curtainBulge) + rightX * lateral;
        positions[idx * 3 + 1] = y + chute * (1 - v) * Math.min(0.6, this.height * 0.08) * blend;
        positions[idx * 3 + 2] = this.crestPosition.z + dirZ * (throwVariation + curtainBulge) + rightZ * lateral;
        uvs[idx * 2]     = u01;
        uvs[idx * 2 + 1] = j < 0 ? a * approachV : v;
        normals[idx * 3]     = dirX * nForward;
        normals[idx * 3 + 1] = nY;
        normals[idx * 3 + 2] = dirZ * nForward;
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < segW; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = (j + 1) * cols + i;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setIndex(indices);
    geom.computeBoundingSphere();

    const u = this.u;
    const weather = this.weather;
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const t = frame.time;
    const stV = uv();
    const fallSpeed = u.exitSpeed.mul(0.28).add(1.35).mul(u.flow.max(0.2));
    const surge = sin(stV.y.mul(13.0).sub(t.mul(fallSpeed.mul(4.5))).add(sin(stV.x.mul(17.0)).mul(1.8)))
      .mul(0.16)
      .mul(smoothstep(0.0, 0.2, stV.y));
    const nOut = vec3(this.direction.x, 0.25, this.direction.y).normalize();
    material.positionNode = positionGeometry.add(nOut.mul(surge));

    const vUv = stV.toVarying('wfUv');
    const vN = attribute('normal', 'vec3').toVarying('wfN');

    material.colorNode = Fn(() => {
      const P = positionWorld;
      const V = normalize(cameraPosition.sub(P));
      const L = frame.sunDirection;
      const shadow = weather ? weather.cloudShadow(P) : frame.sunVisibility;
      const sun = frame.sunColor.mul(shadow);
      const skyAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.55);
      const fallV = vUv.y.max(0);
      const brink = smoothstep(0.0, -0.02, vUv.y);

      // Gravity-accelerated downward coordinates (streaks elongate as water accelerates).
      const accelV = pow(fallV.max(0.001), 0.72).mul(u.height.mul(0.32));
      const speedA = t.mul(u.exitSpeed.mul(0.55).add(2.4)).mul(u.flow.max(0.2));
      const uMetric = vUv.x.mul(u.width);

      // Discharge lanes are fixed by the lip's micro-topography; slow ropes of thicker
      // water drift within them. Together they decide where the sheet tears open.
      const lane = fbm2(vec2(uMetric.mul(0.84), float(3.72)), 3);
      const rope = valueNoise2(vec2(uMetric.mul(2.6).add(lane.mul(1.4)), accelV.mul(0.18).sub(speedA.mul(0.35))));
      const ribbon1 = fbm2(vec2(uMetric.mul(1.55), accelV.mul(0.55).sub(speedA)), 3);
      const ribbon2 = valueNoise2(vec2(uMetric.mul(4.2).add(3.7), accelV.mul(1.35).sub(speedA.mul(1.65))));
      const thread = valueNoise2(vec2(uMetric.mul(13.8).add(ribbon1.mul(1.65)), accelV.sub(speedA).mul(0.62)));
      const cell = voronoi2(vec2(uMetric.mul(1.3), accelV.mul(0.35).sub(speedA.mul(0.95))), t.mul(0.9));
      const foamWeb = float(1).sub(smoothstep(0.02, 0.28, cell.y.sub(cell.x)));

      // Break-up: a coherent glassy tongue at the lip tears into ropes and veils as it
      // accelerates; gaps open between lanes first and show the wet rock behind.
      const thickness = lane.mul(0.55).add(rope.mul(0.45));
      const breakup = smoothstep(0.06, 0.85, fallV).mul(u.aeration.mul(0.6).add(0.4));
      const tearLo = breakup.mul(0.5).add(0.1);
      const tear = smoothstep(tearLo, tearLo.add(0.2), thickness.add(thread.sub(0.5).mul(0.28)));
      // Aerated packets ("comet heads") fall with gravity and smear downward.
      const packets = smoothstep(0.62, 0.86, valueNoise2(vec2(uMetric.mul(1.9), accelV.mul(0.42).sub(speedA.mul(1.05)))))
        .mul(smoothstep(0.08, 0.35, fallV));
      const airEntrain = smoothstep(0.05, 0.6, fallV).mul(u.aeration);
      // White boil where the curtain meets the pool, with a ragged water line.
      const waterline = u.plungeY.add(ribbon2.mul(0.35)).add(0.05);
      const boil = smoothstep(waterline.add(1.1), waterline.add(0.1), P.y);
      const whiteness = airEntrain.mul(ribbon1.mul(0.45).add(0.4)).add(packets.mul(0.65)).add(foamWeb.mul(airEntrain).mul(0.2))
        .add(boil.mul(0.7)).clamp(0, 1);

      // Optics. Clear water: Fresnel sky reflection, a teal body and tight sun glints —
      // what lies behind shows through via alpha. Aerated water: bright multiple scatter,
      // back-lit forward lobe, thick ropes self-shade their cores.
      const Nw = normalize(vN);
      const Nf = Nw.mul(select(dot(Nw, V).lessThan(0), float(-1), float(1)));
      const NdotV = dot(Nf, V).clamp(0, 1);
      const fresnel = float(0.02).add(pow(float(1).sub(NdotV), 5).mul(0.98));
      const R = reflect(V.negate(), Nf);
      const skyRefl = mix(frame.skyHorizon, frame.skyZenith, R.y.clamp(0, 1));
      const sheen = mix(float(0.75), float(1.25), valueNoise2(vec2(uMetric.mul(5.0), vUv.y.mul(40.0).sub(speedA.mul(0.3)))));
      const glint = pow(max(dot(R, L), 0), 160).mul(3.0);
      const glassCol = skyRefl.mul(fresnel.mul(sheen)).add(vec3(0.03, 0.075, 0.07).mul(skyAmbient.add(sun.mul(0.12))))
        .add(sun.mul(glint));
      const glassAlpha = fresnel.mul(0.45).add(0.32);
      const wrapSun = dot(Nf, L).add(0.65).div(1.65).clamp(0, 1);
      const forward = pow(max(dot(V.negate(), L), 0), 4.5).mul(0.85);
      const selfShade = mix(float(0.72), float(1.0), float(1).sub(thickness.mul(airEntrain)));
      const whiteCol = vec3(0.9, 0.93, 0.93).mul(sun.mul(wrapSun.mul(0.8).add(forward)).mul(1 / Math.PI).add(skyAmbient.mul(0.95)))
        .mul(selfShade).mul(mix(0.82, 1.06, thread));
      const curtain = mix(glassCol, whiteCol, whiteness);

      // Soft lateral feathering; the brink fades in from the river outlet; the base
      // dissolves at the ragged water line; a short depth feather only softens contacts.
      const edgeX = smoothstep(0.0, 0.14, vUv.x).mul(smoothstep(1.0, 0.86, vUv.x));
      const lipIn = smoothstep(-0.08, -0.035, vUv.y);
      const edgeY = lipIn.mul(smoothstep(1.0, 0.88, vUv.y)).mul(smoothstep(waterline.sub(0.1), waterline.add(0.25), P.y));
      const sceneZ = perspectiveDepthToViewZ(viewportDepthAt(screenUV), cameraNear, cameraFar).negate();
      const depthSoft = sceneZ.sub(positionView.z.negate()).div(0.3).clamp(0, 1);
      const body = mix(glassAlpha, float(0.93), whiteness).mul(mix(float(0.1), float(1), max(tear, brink)));
      const alpha = body.mul(edgeX).mul(edgeY).mul(depthSoft).mul(u.flow.clamp(0, 1)).clamp(0, 0.95);
      const finalRgb = weather ? weather.aerial(curtain, P) : curtain;
      return vec4(finalRgb, alpha);
    })();
    material.mrtNode = auxPassthrough();

    this.sheetMesh = new THREE.Mesh(geom, material);
    this.sheetMesh.renderOrder = 8;
    this.sheetMesh.name = 'lumina-waterfall-sheet';
    this.group.add(this.sheetMesh);
  }

  /** Outward-boiling aerated plunge pool ring at the base of the fall. */
  private buildPlungeMesh(): void {
    const geom = new THREE.PlaneGeometry(this.plungeRadius * 2.4, this.plungeRadius * 2.4, 24, 24);
    geom.rotateX(-Math.PI / 2);

    const u = this.u;
    const weather = this.weather;
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const vUv = uv().toVarying('plUv');
    material.colorNode = Fn(() => {
      const P = positionWorld;
      const L = frame.sunDirection;
      const shadow = weather ? weather.cloudShadow(P) : frame.sunVisibility;
      const skyAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.55);

      const c = vUv.mul(2).sub(1);
      const r = length(c);
      const angle = TSL.atan(c.y, c.x);
      const t = frame.time;
      const outSpeed = t.mul(1.45).mul(u.flow.max(0.2));

      // Outward-advected radial boil rings + cellular foam web.
      const radialUV = vec2(angle.mul(2.4), r.mul(4.8).sub(outSpeed));
      const boil = fbm2(radialUV, 3);
      const cell = voronoi2(c.mul(4.5).sub(normalize(c.add(vec2(1e-4, 0))).mul(outSpeed.mul(1.1))), t.mul(1.1));
      const web = float(1).sub(smoothstep(0.02, 0.28, cell.y.sub(cell.x)));
      // Ragged rather than circular: the boil's radius breathes with the noise.
      const rr = r.add(boil.sub(0.5).mul(0.26));

      // Intense frothy white core right under impact, lacy aerated rings radiating outward.
      // The boil is aerated water broken into churning cells, never a uniform white disc
      // (a 0.95-opaque core read as a flat circular decal from the valley rim).
      const core = smoothstep(0.6, 0.08, rr).mul(web.mul(0.4).add(boil.mul(0.3)).add(0.42));
      const ring = smoothstep(1.0, 0.22, rr).mul(boil.mul(0.55).add(web.mul(0.45)));
      // Runoff: foam leaving the pool stretches into streaks along the outflow and thins
      // with distance (uv.y runs against world +z on the rotated plane).
      const down = normalize(vec2(this.direction.x, -this.direction.y));
      const along = dot(c, down), across = dot(c, vec2(down.y.negate(), down.x));
      const streak = valueNoise2(vec2(across.mul(7.5), along.mul(1.8).sub(outSpeed.mul(0.9))));
      const plume = smoothstep(1.0, 0.25, abs(across).div(along.max(0).mul(0.45).add(0.4)))
        .mul(smoothstep(-0.25, 0.1, along)).mul(smoothstep(1.0, 0.45, along));
      const tail = plume.mul(smoothstep(0.42, 0.72, streak.mul(0.7).add(web.mul(0.3))));
      const mask = max(max(core.mul(0.88), smoothstep(0.24, 0.72, ring)), tail.mul(0.8))
        .mul(smoothstep(1.0, 0.8, max(rr, r.mul(0.9)))).mul(u.flow.clamp(0, 1));

      const albedo = mix(vec3(0.58, 0.78, 0.78), vec3(0.96, 0.97, 0.97), core.mul(0.7).add(web.mul(0.3)).add(tail.mul(0.25)).clamp(0, 1));
      const lit = albedo.mul(frame.sunColor.mul(shadow).mul(max(L.y, 0.15).add(0.45).div(1.45)).mul(1 / Math.PI).add(skyAmbient.mul(1.1)));
      const finalRgb = weather ? weather.aerial(lit, P) : lit;
      return vec4(finalRgb, mask.mul(0.92));
    })();
    material.mrtNode = auxPassthrough();

    this.plungeMesh = new THREE.Mesh(geom, material);
    this.plungeMesh.position.copy(this.plungePosition);
    this.plungeMesh.position.y += 0.04;
    this.plungeMesh.renderOrder = 6;
    this.plungeMesh.name = 'lumina-waterfall-plunge';
    this.group.add(this.plungeMesh);
  }

  private buildParticles(preset: QualityPreset): void {
    if (this.fx) {
      if (this.ownsParticles) {
        this.localMist?.dispose();
        this.localSpray?.dispose();
        this.localMist = this.localSpray = null;
        this.ownsParticles = false;
      }
      return;
    }
    this.localMist?.dispose();
    this.localSpray?.dispose();
    const { renderer, wind, scene, pipeline } = this.engine;
    const mistCap = Math.max(128, Math.min(1024, Math.floor(preset.particles.budget * 0.05)));
    const sprayCap = Math.max(128, Math.min(1024, Math.floor(preset.particles.budget * 0.05)));
    this.localMist = new ParticleSystem(renderer, wind, {
      capacity: mistCap, shading: 'mist', softDepth: pipeline.sceneDepth,
      gravity: -0.02, drag: 1.15, turbulence: 1.0, windInfluence: 0.9, opacity: 0.32, softness: 1.4,
    });
    this.localSpray = new ParticleSystem(renderer, wind, {
      capacity: sprayCap, shading: 'spray',
      gravity: 1, drag: 0.4, windInfluence: 0.6, floorY: this.plungePosition.y - 0.1, stretch: 0.045, opacity: 0.82, softness: 0.4,
    });
    pipeline.softScene.add(this.localMist.mesh);
    scene.add(this.localSpray.mesh);
    this.ownsParticles = true;
  }

  /** Outward radial plunge-pool push velocity at world `(x, z)` (m/s). */
  plungeFlowAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const dx = x - this.plungePosition.x;
    const dz = z - this.plungePosition.z;
    const d = Math.hypot(dx, dz);
    if (d > this.plungeRadius * 1.4 || this.flow <= 0.01) return out.set(0, 0, 0);
    const k = (1 - THREE.MathUtils.smoothstep(d, this.plungeRadius * 0.15, this.plungeRadius * 1.4)) * this.flow;
    const speed = Math.sqrt(2 * GRAVITY * this.height) * 0.22 * k;
    const inv = d > 1e-4 ? 1 / d : 0;
    return out.set(
      (dx * inv * 0.7 + this.direction.x * 0.3) * speed,
      0,
      (dz * inv * 0.7 + this.direction.y * 0.3) * speed,
    );
  }

  setQuality(preset: QualityPreset): void {
    this.buildParticles(preset);
  }

  update(dt: number): void {
    this.u.flow.value = Math.max(0, this.flow);
    this.u.aeration.value = THREE.MathUtils.clamp(this.aeration, 0, 1);

    const mistPool = this.fx ? this.fx.mist : this.localMist;
    const sprayPool = this.fx ? this.fx.spray : this.localSpray;
    const intensity = this.flow * this.mistIntensity;

    if (dt > 0 && intensity > 0.02) {
      const rightX = -this.direction.y, rightZ = this.direction.x;
      const spreadSpan = this.width * 0.45;
      // Billowing rising plunge mist cloud at the waterfall base (three spread emitters across width).
      if (mistPool) {
        const baseRate = Math.min(48, (10 + this.width * 1.4 + this.height * 0.5) * intensity);
        for (let s = -1; s <= 1; s++) {
          _tmpEmit.set(
            this.plungePosition.x + rightX * (s * spreadSpan * 0.65) + this.direction.x * 0.6,
            this.plungePosition.y + 0.48,
            this.plungePosition.z + rightZ * (s * spreadSpan * 0.65) + this.direction.y * 0.6,
          );
          _tmpVel.set(this.direction.x * 1.4, 0.85 + Math.sqrt(this.height) * 0.19, this.direction.y * 1.4);
          mistPool.emitRateAt(this.emitterCarry, s + 1, baseRate / 3, dt, this.mistPuff);
        }
      }
      // Ballistic splash droplets leaping off the plunge boil.
      if (sprayPool) {
        const sprayRate = Math.min(90, (22 + this.width * 2.5) * intensity);
        _tmpEmit.set(this.plungePosition.x, this.plungePosition.y + 0.35, this.plungePosition.z);
        _tmpVel.set(this.direction.x * 2.4, 3.2 + Math.sqrt(this.height) * 0.65, this.direction.y * 2.4);
        sprayPool.emitRateAt(this.emitterCarry, 3, sprayRate, dt, this.impactSpray);
      }
      // Wet the camera lens gently when standing inside the plunge mist.
      this.engine.lens?.splashAt(this.plungePosition, this.plungeRadius * 1.35, Math.min(0.45, 0.22 * intensity));
    }

    if (this.ownsParticles) {
      this.localMist?.update();
      this.localSpray?.update();
    }
  }

  dispose(): void {
    this.sheetMesh.geometry.dispose();
    (this.sheetMesh.material as THREE.Material).dispose();
    this.plungeMesh.geometry.dispose();
    (this.plungeMesh.material as THREE.Material).dispose();
    if (this.ownsParticles) {
      this.localMist?.dispose();
      this.localSpray?.dispose();
    }
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// InlandWater module host
// ---------------------------------------------------------------------------

export class InlandWater implements EngineModule {
  readonly group = new THREE.Group();
  readonly rivers: River[] = [];
  readonly waterfalls: Waterfall[] = [];

  private weather: Weather | null;
  private fx: EffectsKit | null;
  private scratchSample = createEmptyRiverSample();
  private querySample = createEmptyRiverSample();

  private readonly unregisterWater: () => void;
  constructor(private engine: LuminaEngine, options: InlandWaterOptions = {}) {
    this.unregisterWater=engine.world.addWater({heightAt:(x,z,flow)=>{
      const state=this.sample(x,z,this.querySample);
      if(flow)flow.copy(state.velocity);
      return state.inside?state.height:NaN;
    }});
    this.weather = options.weather ?? null;
    this.fx = options.fx ?? null;
    this.group.name = 'lumina-inland-water';
    engine.scene.add(this.group);
  }

  /** Create and register a flowmap-advected river with optional rocky rapids. */
  addRiver(options: RiverOptions): River {
    const river = new River(this.engine, {
      weather: this.weather ?? undefined,
      fx: this.fx ?? undefined,
      ...options,
    });
    this.rivers.push(river);
    this.group.add(river.group);
    river.updateOutlet(this.waterfalls);
    return river;
  }

  removeRiver(river: River): void {
    const idx = this.rivers.indexOf(river);
    if (idx < 0) return;
    this.rivers.splice(idx, 1);
    river.dispose();
  }

  /** Create and register a ballistic waterfall sheet with plunge boil and plunge mist. */
  addWaterfall(options: WaterfallOptions): Waterfall {
    const waterfall = new Waterfall(this.engine, {
      weather: this.weather ?? undefined,
      fx: this.fx ?? undefined,
      ...options,
    });
    this.waterfalls.push(waterfall);
    this.group.add(waterfall.group);
    for (const river of this.rivers) river.updateOutlet(this.waterfalls);
    return waterfall;
  }

  removeWaterfall(waterfall: Waterfall): void {
    const idx = this.waterfalls.indexOf(waterfall);
    if (idx < 0) return;
    this.waterfalls.splice(idx, 1);
    for (const river of this.rivers) river.updateOutlet(this.waterfalls);
    waterfall.dispose();
  }

  /** Query the active river at world `(x, z)` (highest water surface if overlapping). */
  sample(x: number, z: number, out: RiverSample = createEmptyRiverSample()): RiverSample {
    out.inside = false;
    out.height = -Infinity;
    out.depth = 0;
    out.velocity.set(0, 0, 0);
    out.speed = 0;
    out.turbulence = 0;
    out.bankDistance = -Infinity;
    out.u = 0;
    out.distance = 0;

    for (let i = 0; i < this.rivers.length; i++) {
      this.rivers[i].sample(x, z, this.scratchSample);
      if (this.scratchSample.inside && (!out.inside || this.scratchSample.height > out.height)) {
        out.inside = true;
        out.height = this.scratchSample.height;
        out.depth = this.scratchSample.depth;
        out.velocity.copy(this.scratchSample.velocity);
        out.speed = this.scratchSample.speed;
        out.turbulence = this.scratchSample.turbulence;
        out.bankDistance = this.scratchSample.bankDistance;
        out.u = this.scratchSample.u;
        out.distance = this.scratchSample.distance;
      }
    }
    // Add outward plunge-pool current from any nearby waterfalls.
    for (let i = 0; i < this.waterfalls.length; i++) {
      this.waterfalls[i].plungeFlowAt(x, z, _tmpV);
      if (_tmpV.lengthSq() > 1e-6) {
        out.velocity.add(_tmpV);
        out.speed = out.velocity.length();
        out.turbulence = Math.min(2.2, out.turbulence + 0.65);
      }
    }
    if (!out.inside) out.height = 0;
    return out;
  }

  /** Water elevation (world Y) at `(x, z)`, or `fallback` outside any river. */
  heightAt(x: number, z: number, fallback = 0): number {
    this.sample(x, z, this.querySample);
    return this.querySample.inside ? this.querySample.height : fallback;
  }

  /** Horizontal flow velocity (m/s) at world `(x, z)` across rivers and waterfall plunge pools. */
  flowAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.sample(x, z, this.querySample);
    return out.copy(this.querySample.velocity);
  }

  setQuality(preset: QualityPreset): void {
    for (const r of this.rivers) r.setQuality(preset);
    for (const w of this.waterfalls) w.setQuality(preset);
  }

  update(dt: number): void {
    for (const r of this.rivers) r.update(dt);
    for (const w of this.waterfalls) w.update(dt);
  }

  dispose(): void {
    this.unregisterWater();
    for (const r of this.rivers) r.dispose();
    for (const w of this.waterfalls) w.dispose();
    this.rivers.length = 0;
    this.waterfalls.length = 0;
    this.group.removeFromParent();
  }
}

export { fwidth as _fwidth };
