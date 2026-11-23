/**
 * GPU particle system (TSL compute, WebGPU + WebGL 2 transform-feedback fallback)
 * plus the shared HDR local fire-light field consumed by particles, PBR materials,
 * water, asphalt and volumetric clouds.
 *
 * State lives in three storage buffers and is integrated entirely on the GPU: gravity,
 * drag relative to the unified wind field, thermal buoyancy, turbulence and floor
 * bounce / kill. The CPU only writes a handful of *spawn batch* uniforms per frame: each
 * batch claims a window of the ring buffer, so bursts (explosions) and continuous
 * emitters (spray, smoke) share one code path with zero readback.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';
import { frame, auxPassthrough } from './frame';
import { hash33, valueNoise2, blackbody, spriteNoise } from './noise';
import type { WindField } from './wind';
import { billowAtlas } from './shaders/billow-atlas';

const {
  Fn, If, Loop, int, float, vec2, vec3, vec4, uniform, instancedArray, instanceIndex, mix, smoothstep,
  normalize, cross, dot, length, max, min, sin, cos, exp, pow, uv, positionGeometry, cameraPosition, cameraWorldMatrix,
  viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar, positionView, screenUV, select, abs, fract, floor,
} = TSL;

// ----------------------------------------------------------------------------
// Shared HDR local fire-light field (4 GPU slots, zero-cost when inactive)
// ----------------------------------------------------------------------------

export const MAX_FIRE_LIGHTS = 4;

export interface FireLightOptions {
  position: THREE.Vector3 | { x: number; y: number; z: number };
  color?: THREE.ColorRepresentation;
  /** Scene-referred HDR radiance intensity (e.g. 2..40 for fires, 40..400 for detonations). */
  intensity: number;
  /** Influence radius in metres where attenuation smoothly reaches zero. */
  radius: number;
  /** Optional automatic lifetime in seconds (omitted = persistent until `.remove()`). */
  duration?: number;
  /** Optional flicker amplitude (0..0.6). */
  flicker?: number;
}

export interface FireLightHandle {
  readonly id: number;
  setPosition(x: number, y: number, z: number): void;
  setColor(color: THREE.ColorRepresentation): void;
  setIntensity(intensity: number): void;
  setRadius(radius: number): void;
  remove(): void;
}

interface FireLightEntry {
  id: number;
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  radius: number;
  flicker: number;
  age: number;
  duration: number; // < 0 means persistent
  score: number;
  radiance: number;
}

const _tmpColor = new THREE.Color();

/**
 * Shared dynamic HDR local light pool for explosions, flames and embers.
 *
 * Unlike Three.js PointLights (which only shade standard/physical materials), these
 * uniforms are sampled directly by custom TSL shaders: smoke, mist, dust, spray,
 * procedural PBR wet/reflective materials, water and clouds.
 */
export class LocalFireLights {
  /** 1 while at least one light is active, 0 otherwise (lets shaders skip work uniformly). */
  readonly hasActive: N = uniform(0);
  /** Per-slot vec4(x, y, z, radius). */
  readonly posRadius: N[] = Array.from({ length: MAX_FIRE_LIGHTS }, () => uniform(new THREE.Vector4(0, -1e5, 0, 1)));
  /** Per-slot vec4(hdrR, hdrG, hdrB, radiusInv). */
  readonly colorInvR: N[] = Array.from({ length: MAX_FIRE_LIGHTS }, () => uniform(new THREE.Vector4(0, 0, 0, 0)));

  /** Brightest active light summary (useful for driving cloud underglow / sky bounce). */
  readonly dominant = {
    active: false,
    position: new THREE.Vector3(),
    color: new THREE.Color(0, 0, 0),
    intensity: 0,
    radius: 0,
  };

  private entries: FireLightEntry[] = [];
  private top: FireLightEntry[] = [];
  private nextId = 1;
  private time = 0;

  /** Active light count (CPU side, before top-4 GPU selection). */
  get count(): number { return this.entries.length; }

  add(options: FireLightOptions): FireLightHandle {
    const id = this.nextId++;
    _tmpColor.set(options.color ?? 0xff7a24);
    const entry: FireLightEntry = {
      id,
      x: options.position.x, y: options.position.y, z: options.position.z,
      r: _tmpColor.r, g: _tmpColor.g, b: _tmpColor.b,
      intensity: Math.max(0, options.intensity),
      radius: Math.max(0.5, options.radius),
      flicker: options.flicker ?? 0,
      age: 0,
      duration: options.duration ?? -1,
      score: 0, radiance: 0,
    };
    this.entries.push(entry);
    const self = this;
    return {
      id,
      setPosition(x: number, y: number, z: number) { entry.x = x; entry.y = y; entry.z = z; },
      setColor(c: THREE.ColorRepresentation) { _tmpColor.set(c); entry.r = _tmpColor.r; entry.g = _tmpColor.g; entry.b = _tmpColor.b; },
      setIntensity(v: number) { entry.intensity = Math.max(0, v); },
      setRadius(v: number) { entry.radius = Math.max(0.5, v); },
      remove() { self.removeById(id); },
    };
  }

  /** One-shot decaying HDR local light pulse (returns handle if further tweaking is desired). */
  pulse(options: FireLightOptions & { duration: number }): FireLightHandle {
    return this.add(options);
  }

  private removeById(id: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].id === id) { this.entries.splice(i, 1); return; }
    }
  }

  clear(): void {
    this.entries.length = 0;
    this.top.length = 0;
    this.hasActive.value = 0;
    this.dominant.active = false;
    this.dominant.intensity = 0;
    this.dominant.color.setRGB(0, 0, 0);
    for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
      (this.posRadius[i].value as THREE.Vector4).set(0, -1e5, 0, 1);
      (this.colorInvR[i].value as THREE.Vector4).set(0, 0, 0, 0);
    }
  }

  /** Advance transient lights and pack the 4 most visually significant lights into GPU uniforms. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    this.time += dt;
    if (this.entries.length === 0 && this.top.length === 0) return;
    this.top.length = 0;
    const cx = cameraPos.x, cy = cameraPos.y, cz = cameraPos.z;
    let bestScore = 0;
    let bestEntry: FireLightEntry | null = null;
    let bestIntensity = 0;

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      e.age += dt;
      let eff = e.intensity;
      if (e.duration > 0) {
        if (e.age >= e.duration) { this.entries.splice(i, 1); continue; }
        const k = 1 - e.age / e.duration;
        eff *= k * k;
      }
      e.radiance = eff;
      if (e.flicker > 0) {
        const w = this.time * 23 + e.id * 7.13;
        const flicker = 1 + e.flicker * (0.6 * Math.sin(w) + 0.4 * Math.sin(w * 2.37 + 1.1));
        e.radiance = eff * Math.max(0.1, flicker);
        eff *= flicker;
      }
      if (eff <= 1e-3) continue;
      const dx = e.x - cx, dy = e.y - cy, dz = e.z - cz;
      const dist2 = dx * dx + dy * dy + dz * dz;
      const r2 = e.radius * e.radius;
      // Prioritise bright, large, close lights without allocating anything.
      const score = (eff * (0.25 + 0.75 * r2 / (dist2 + r2 + 16)));
      e.score = score;

      if (score > bestScore) {
        bestScore = score;
        bestEntry = e;
        bestIntensity = eff;
      }

      // Insertion into top-4 buffer (size <= 4).
      let pos = this.top.length;
      if (pos < MAX_FIRE_LIGHTS) {
        this.top.push(e);
      } else if (score > this.top[MAX_FIRE_LIGHTS - 1].score) {
        this.top[MAX_FIRE_LIGHTS - 1] = e;
        pos = MAX_FIRE_LIGHTS - 1;
      } else {
        continue;
      }
      while (pos > 0 && this.top[pos].score > this.top[pos - 1].score) {
        const tmp = this.top[pos - 1];
        this.top[pos - 1] = this.top[pos];
        this.top[pos] = tmp;
        pos--;
      }
    }

    const activeCount = this.top.length;
    this.hasActive.value = activeCount > 0 ? 1 : 0;

    for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
      const pOut = this.posRadius[i].value as THREE.Vector4;
      const cOut = this.colorInvR[i].value as THREE.Vector4;
      if (i < activeCount) {
        const e = this.top[i];
        const eff = e.radiance;
        pOut.set(e.x, e.y, e.z, e.radius);
        cOut.set(e.r * eff, e.g * eff, e.b * eff, 1 / e.radius);
      } else {
        pOut.set(0, -1e5, 0, 1);
        cOut.set(0, 0, 0, 0);
      }
    }

    if (bestEntry) {
      this.dominant.active = true;
      this.dominant.position.set(bestEntry.x, bestEntry.y, bestEntry.z);
      this.dominant.color.setRGB(bestEntry.r * bestIntensity, bestEntry.g * bestIntensity, bestEntry.b * bestIntensity);
      this.dominant.intensity = bestIntensity;
      this.dominant.radius = bestEntry.radius;
    } else {
      this.dominant.active = false;
      this.dominant.intensity = 0;
      this.dominant.color.setRGB(0, 0, 0);
    }
  }

  /**
   * TSL shader hook: omnidirectional + directional wrapped diffuse + forward scatter
   * for volumetric particles (smoke, mist, spray, dust).
   * Wrapped in `Fn` and unrolled over 4 slots so it works anywhere on WebGPU + WebGL2.
   */
  sampleVolumetric(worldPos: N, normalW: N, viewDir: N, wrap = 0.45): N {
    return Fn(() => {
      const out = vec3(0).toVar();
      If(this.hasActive.greaterThan(0.5), () => {
        for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
          const pr = this.posRadius[i];
          const ci = this.colorInvR[i];
          const toL = pr.xyz.sub(worldPos);
          const dist = length(toL).add(1e-3);
          const normD = dist.mul(ci.w).clamp(0, 1);
          const win = float(1).sub(normD.mul(normD));
          const att = win.mul(win).div(dist.mul(dist).mul(0.06).add(1));
          const L = toL.div(dist);
          const ndl = dot(normalW, L).add(wrap).div(1 + wrap).clamp(0, 1);
          // Translucent forward scatter when fire is behind the smoke/mist puff.
          const fwd = pow(max(dot(viewDir.negate(), L), 0), 3).mul(0.55);
          out.addAssign(ci.rgb.mul(att).mul(ndl.mul(0.75).add(fwd).add(0.18)));
        }
      });
      return out;
    })();
  }

  /**
   * TSL shader hook: surface diffuse + GGX-style specular glint from nearby HDR fire lights.
   * Ideal for wet asphalt, ocean water, concrete puddles, glass and melting ice.
   * Safe to call both inside and outside a TSL `Fn`.
   */
  sampleSurface(worldPos: N, normalW: N, viewDir: N, roughness: N,
    visibilityAt?: (surface: N, light: N) => N): { diffuse: N; specular: N } {
    // The first slot has the highest camera-weighted irradiance. Resolve its
    // local contact shadow once for diffuse and specular; dimmer lights fill it.
    const dominantVisibility = visibilityAt ? Fn(() => {
      const visibility = float(1).toVar(), p = this.posRadius[0];
      If(this.hasActive.greaterThan(0.5).and(dot(p.xyz.sub(worldPos), p.xyz.sub(worldPos)).lessThan(p.w.mul(p.w))), () => {
        visibility.assign(visibilityAt(worldPos.add(normalW.mul(0.035)), p.xyz));
      });
      return visibility;
    })().toVar() : null;
    const diffuse = Fn(() => {
      const diff = vec3(0).toVar();
      If(this.hasActive.greaterThan(0.5), () => {
        for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
          const pr = this.posRadius[i];
          const ci = this.colorInvR[i];
          const toL = pr.xyz.sub(worldPos);
          const dist = length(toL).add(1e-3);
          const normD = dist.mul(ci.w).clamp(0, 1);
          const win = float(1).sub(normD.mul(normD));
          const att = win.mul(win).div(dist.mul(dist).mul(0.055).add(1));
          const L = toL.div(dist);
          const ndl = max(dot(normalW, L), 0);
          diff.addAssign(ci.rgb.mul(i === 0 && dominantVisibility ? att.mul(dominantVisibility) : att).mul(ndl).mul(1 / Math.PI));
        }
      });
      return diff;
    })();
    const specular = Fn(() => {
      const spec = vec3(0).toVar();
      If(this.hasActive.greaterThan(0.5), () => {
        const r = roughness.clamp(0.03, 1.0);
        const specExp = mix(float(220), float(8), r.pow(0.7));
        const specNorm = mix(float(2.4), float(0.18), r);
        for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
          const pr = this.posRadius[i];
          const ci = this.colorInvR[i];
          const toL = pr.xyz.sub(worldPos);
          const dist = length(toL).add(1e-3);
          const normD = dist.mul(ci.w).clamp(0, 1);
          const win = float(1).sub(normD.mul(normD));
          const att = win.mul(win).div(dist.mul(dist).mul(0.055).add(1));
          const L = toL.div(dist);
          const ndl = max(dot(normalW, L), 0);
          const H = normalize(L.add(viewDir));
          const ndh = max(dot(normalW, H), 0);
          spec.addAssign(ci.rgb.mul(i === 0 && dominantVisibility ? att.mul(dominantVisibility) : att).mul(pow(ndh, specExp)).mul(specNorm).mul(ndl.add(0.15).min(1)));
        }
      });
      return spec;
    })();
    return { diffuse, specular };
  }

  /**
   * Single-pass combined PBR diffuse + Fresnel specular HDR fire-light bounce node.
   * Safe to assign directly to `material.emissiveNode` without an outer `Fn`.
   */
  samplePBR(worldPos: N, normalW: N, viewDir: N, albedo: N, roughness: N, metalness: N): N {
    return Fn(() => {
      const out = vec3(0).toVar();
      If(this.hasActive.greaterThan(0.5), () => {
        const r = roughness.clamp(0.03, 1.0);
        const specExp = mix(float(220), float(8), r.pow(0.7));
        const specNorm = mix(float(2.4), float(0.18), r);
        const f0 = mix(vec3(0.04), albedo, metalness);
        const ndv = max(dot(normalW, viewDir), 0.02);
        const fresnel = f0.add(vec3(1).sub(f0).mul(pow(float(1).sub(ndv), 5)));
        const diffFactor = albedo.mul(float(1).sub(metalness)).mul(1 / Math.PI);
        for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
          const pr = this.posRadius[i];
          const ci = this.colorInvR[i];
          const toL = pr.xyz.sub(worldPos);
          const dist = length(toL).add(1e-3);
          const normD = dist.mul(ci.w).clamp(0, 1);
          const win = float(1).sub(normD.mul(normD));
          const att = win.mul(win).div(dist.mul(dist).mul(0.055).add(1));
          const L = toL.div(dist);
          const ndl = max(dot(normalW, L), 0);
          const H = normalize(L.add(viewDir));
          const ndh = max(dot(normalW, H), 0);
          const rad = ci.rgb.mul(att);
          const spec = fresnel.mul(pow(ndh, specExp)).mul(specNorm).mul(ndl.add(0.15).min(1));
          out.addAssign(rad.mul(diffFactor.mul(ndl).add(spec)));
        }
      });
      return out;
    })();
  }
}

/** Shared singleton HDR local fire-light field (updated once per frame by `EffectsKit`). */
export const fireLights = new LocalFireLights();

// ----------------------------------------------------------------------------
// GPU Particle System
// ----------------------------------------------------------------------------

const BATCH_SLOTS = 6;
const QUEUE_SIZE = 64;

// One queued request occupies three position/velocity/size vec4s and a control vec4, in the
// order the simulation's four batch buffers take them. A flush is then four block copies; reading
// a request back float by float would box every one of them while this code is unoptimised.
const REQUEST_STRIDE = 16;
/** The ring keeps one extra row: the request being flushed is staged there for the copies. */
const STAGE = QUEUE_SIZE * REQUEST_STRIDE;

/**
 * Offsets of a packed emission request, a `Float64Array` of `EMIT_REQUEST_SIZE` numbers laid out
 * as the simulation consumes it. A steady emitter fills one from `createEmitRequest()` and hands
 * it to `emitPacked` / `emitRatePacked`: its numbers then reach the queue as one block copy
 * instead of a dozen property reads of an options object.
 */
export const EMIT = {
  X: 0, Y: 1, Z: 2, RADIUS: 3,
  VELOCITY_X: 4, VELOCITY_Y: 5, VELOCITY_Z: 6, SPREAD: 7,
  LIFE: 8, LIFE_JITTER: 9, SIZE: 10, SIZE_END: 11,
  TEMPERATURE: 12, SPEED_JITTER: 15,
} as const;
/** Slot of a queued request that carries its particle count (the caller's value is ignored). */
const REQUEST_COUNT = 14;
export const EMIT_REQUEST_SIZE = REQUEST_STRIDE;

/** A packed request with the defaults `EmitOptions` applies: lifeJitter 0.3, speedJitter 0.3,
 * everything else 0. Unlike the options form, `SIZE_END` must be set explicitly. */
export function createEmitRequest(): Float64Array {
  const request = new Float64Array(EMIT_REQUEST_SIZE);
  request[EMIT.LIFE_JITTER] = 0.3;
  request[EMIT.SPEED_JITTER] = 0.3;
  return request;
}

export type ParticleShading = 'spray' | 'mist' | 'smoke' | 'fire' | 'spark' | 'dust' | 'bubble' | 'grit';

export interface ParticleConfig {
  capacity: number;
  shading: ParticleShading;
  /** Multiplier on -9.81 m/s². */
  gravity?: number;
  /** Linear drag toward the local wind velocity (1/s). */
  drag?: number;
  /** Upward acceleration per unit temperature (m/s²). */
  buoyancy?: number;
  /** Temperature decay rate (1/s). */
  cooling?: number;
  /** Turbulent acceleration amplitude (m/s²). */
  turbulence?: number;
  /** 0..1 – fraction of the wind field that particles feel. */
  windInfluence?: number;
  /** World height of the kill / bounce plane. */
  floorY?: number;
  /** Restitution; 0 kills particles at the floor. */
  bounce?: number;
  /** World height above which particles die (bubbles reaching the surface). */
  ceilingY?: number;
  /** Seconds of motion smeared into the sprite (streaks for sparks / fast spray). */
  stretch?: number;
  /** Soft-particle fade distance in metres. */
  softness?: number;
  opacity?: number;
  color?: THREE.ColorRepresentation;
  renderOrder?: number;
  /**
   * Scene depth texture node for sprites drawn in the pipeline's off-screen soft layer
   * (`LuminaPipeline.sceneDepth`). Omit for sprites drawn in the main scene pass.
   */
  softDepth?: N;
  /** 0..2 sensitivity to local HDR fire lights (defaults by shading type). */
  fireLightGain?: number;
}

export interface EmitOptions {
  position: THREE.Vector3 | { x: number; y: number; z: number };
  /** Spawn-sphere radius (m). */
  radius?: number;
  velocity?: THREE.Vector3 | { x: number; y: number; z: number };
  /** Random isotropic speed added to `velocity` (m/s). */
  spread?: number;
  /** Lifetime in seconds. */
  life: number;
  /** 0..1 lifetime randomisation. */
  lifeJitter?: number;
  /** Start / end diameter in metres. */
  size: number;
  sizeEnd?: number;
  /** Normalised temperature (drives buoyancy + blackbody emission). */
  temperature?: number;
  /** Rubber aerosol scatters pale daylight. Ordinary combustion smoke uses soot. */
  smokeMaterial?: 'soot' | 'rubber';
  /** Fine wind-carried droplets, e.g. the translucent veil behind a wet tire. */
  mistMaterial?: 'billow' | 'aerosol';
  /** 0..1 random scaling of the base velocity (0 = all identical). */
  speedJitter?: number;
  count: number;
}

export class ParticleSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  /** Number of slots one localized emitter can fill before its sprites mostly overlap. */
  readonly burstBudget: number;
  private readonly smokePool: boolean;
  private readonly mistPool: boolean;
  readonly uniforms: Record<string, N>;
  private positions: N;
  private velocities: N;
  private misc: N;
  private computeNode: N;
  private cursor = 0;
  private allocatedSlots = 0;
  private ring = new Float64Array(STAGE + REQUEST_STRIDE);
  /** The four vec4s of the staged request, as the batch buffers take them. */
  private stage = [0, 4, 8, 12].map((o) => this.ring.subarray(STAGE + o, STAGE + o + 4));
  private head = 0;
  private pending = 0;
  private batchA: N; private batchB: N; private batchC: N; private batchD: N;
  private emitterSlots = new Map<string, number>();
  private remainders = new Float64Array(16);
  private remainingLife = 0;
  private needsWarmup = true;

  constructor(private renderer: THREE.WebGPURenderer, wind: WindField, config: ParticleConfig) {
    this.smokePool = config.shading === 'smoke';
    this.mistPool = config.shading === 'mist';
    const capacity = this.capacity = Math.max(64, Math.floor(config.capacity));
    const screenBudget: Record<ParticleShading, number> = {
      fire: 500, smoke: 600, dust: 460, mist: 560, spark: 2400, spray: 2000, bubble: 700, grit: 900,
    };
    this.burstBudget = Math.min(capacity, screenBudget[config.shading]);
    this.positions = instancedArray(capacity, 'vec4');
    this.velocities = instancedArray(capacity, 'vec4');
    this.misc = instancedArray(capacity, 'vec4');
    // Start dead: age (1) >= life (0).
    const pArr = this.positions.value.array as Float32Array;
    for (let i = 0; i < capacity; i++) { pArr[i * 4 + 1] = -1e5; pArr[i * 4 + 3] = 1; }

    const mk = () => TSL.buffer(new Float32Array(BATCH_SLOTS * 4), 'vec4', BATCH_SLOTS);
    this.batchA = mk(); this.batchB = mk(); this.batchC = mk(); this.batchD = mk();

    const defaultFireGain = config.shading === 'smoke' ? 0.55
      : config.shading === 'mist' || config.shading === 'dust' ? 0.42
      : config.shading === 'spray' ? 0.35
      : 0;

    const u = this.uniforms = {
      gravity: uniform(config.gravity ?? 1),
      drag: uniform(config.drag ?? 0.4),
      buoyancy: uniform(config.buoyancy ?? 0),
      cooling: uniform(config.cooling ?? 0.8),
      turbulence: uniform(config.turbulence ?? 0),
      windInfluence: uniform(config.windInfluence ?? 1),
      floorY: uniform(config.floorY ?? -1e5),
      ceilingY: uniform(config.ceilingY ?? 1e6),
      bounce: uniform(config.bounce ?? 0),
      opacity: uniform(config.opacity ?? 1),
      color: uniform(new THREE.Color(config.color ?? 0xffffff)),
      softness: uniform(config.softness ?? 0.6),
      fireLightGain: uniform(config.fireLightGain ?? defaultFireGain),
    };

    const positions = this.positions, velocities = this.velocities, misc = this.misc;
    const bA = this.batchA, bB = this.batchB, bC = this.batchC, bD = this.batchD;
    const N_ = float(capacity);

    this.computeNode = Fn(() => {
      const p = positions.element(instanceIndex);
      const v = velocities.element(instanceIndex);
      const m = misc.element(instanceIndex);
      const pos = p.xyz.toVar();
      const age = p.w.toVar();
      const vel = v.xyz.toVar();
      const life = v.w.toVar();
      const info = m.toVar();
      const idx = float(instanceIndex);
      const dt = frame.delta;

      age.addAssign(dt.div(max(life, 1e-3)));

      Loop({ start: int(0), end: int(BATCH_SLOTS), type: 'int', condition: '<', name: 'bi' }, ({ bi }: N) => {
        const d = bD.element(bi);
        const offset = idx.sub(d.y).add(N_).mod(N_);
        If(offset.lessThan(d.z), () => {
          const a = bA.element(bi);
          const b = bB.element(bi);
          const c = bC.element(bi);
          const r1 = hash33(vec3(idx.mul(0.7311), frame.time.mul(91.7).fract().mul(97.0), float(bi).mul(13.1).add(1.7))).toVar();
          const r2 = hash33(vec3(idx.mul(1.3173).add(5.1), frame.time.mul(57.3).fract().mul(61.0), float(bi).mul(7.7).add(9.2))).toVar();
          const dirA = normalize(r1.mul(2).sub(1).add(1e-4));
          const dirB = normalize(r2.mul(2).sub(1).add(1e-4));
          pos.assign(a.xyz.add(dirA.mul(a.w).mul(pow(r2.z, 0.3333))));
          vel.assign(b.xyz.mul(float(1).sub(d.w.mul(r1.z))).add(dirB.mul(b.w).mul(pow(r1.x, 0.5))));
          life.assign(c.x.mul(float(1).sub(c.y.mul(r2.x))));
          age.assign(0);
          info.assign(vec4(c.z, c.w, r1.y, d.x));
        });
      });

      If(age.lessThan(1), () => {
        const windV = wind.node(pos).mul(u.windInfluence);
        const t = frame.time;
        const seed = info.z.mul(6.2831);
        const turb = vec3(
          sin(pos.y.mul(0.83).add(t.mul(1.7)).add(seed)),
          sin(pos.z.mul(0.71).add(t.mul(1.3)).add(seed.mul(1.7))),
          sin(pos.x.mul(0.77).add(t.mul(1.9)).add(seed.mul(2.3))),
        ).mul(u.turbulence);
        const acc = vec3(0, u.gravity.mul(-9.81).add(u.buoyancy.mul(info.w)), 0)
          .add(windV.sub(vel).mul(u.drag))
          .add(turb);
        vel.addAssign(acc.mul(dt));
        pos.addAssign(vel.mul(dt));
        info.w.assign(info.w.mul(exp(u.cooling.mul(dt).negate())));
        If(pos.y.greaterThan(u.ceilingY), () => { age.assign(1); });
        If(pos.y.lessThan(u.floorY), () => {
          If(u.bounce.greaterThan(0.01), () => {
            pos.y.assign(u.floorY.add(0.01));
            vel.assign(vec3(vel.x.mul(0.72), vel.y.abs().mul(u.bounce), vel.z.mul(0.72)));
            // Each bounce sheds energy and heat; slow sparks die.
            info.w.assign(info.w.mul(0.78));
            If(vel.y.lessThan(0.6), () => { age.assign(1); });
          }).Else(() => { age.assign(1); });
        });
      });

      p.assign(vec4(pos, age));
      v.assign(vec4(vel, life));
      m.assign(info);
    })().compute(capacity);

    this.mesh = this.createMesh(config);
  }

  private createMesh(config: ParticleConfig): THREE.InstancedMesh {
    const u = this.uniforms;
    const pAttr = this.positions.toAttribute();
    const vAttr = this.velocities.toAttribute();
    const mAttr = this.misc.toAttribute();
    const stretch = config.stretch ?? 0;
    const shading = config.shading;
    // Integrate sprite optical depth at pool construction, before a first visible burst.
    const opticalAtlas = shading === 'smoke' || shading === 'mist' || shading === 'dust' ? billowAtlas() : undefined;

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;
    const additive = shading === 'fire' || shading === 'spark';
    material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const offscreen = config.softDepth;
    if (offscreen) {
      // The layer accumulates premultiplied colour and coverage; emissive sprites add light
      // without adding coverage, so they never darken what is behind them.
      if (additive) {
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.SrcAlphaFactor; material.blendDst = THREE.OneFactor;
        material.blendSrcAlpha = THREE.ZeroFactor; material.blendDstAlpha = THREE.OneFactor;
      }
      material.depthTest = false;
    } else material.mrtNode = auxPassthrough();

    const age = pAttr.w;
    const alive = age.lessThan(1);
    const volumetric = shading === 'smoke' || shading === 'mist' || shading === 'dust';
    // Render-only variety from the stored per-particle seed (size, aspect, growth rate).
    // Bursts emit identical size/life parameters per batch, which read as rows of cloned
    // puffs; the simulation, spawn data and buffers are untouched. U(0.66, 1.28) keeps
    // mean sprite area (overdraw) within ~3 % of the unjittered pool.
    const vary = hash33(vec3(mAttr.z.mul(17.17).add(0.31), mAttr.z.mul(3.71).add(0.5), 1.37));
    const growth = volumetric ? mix(float(0.4), float(0.72), vary.z) : float(1);
    const sizeCurve = volumetric ? pow(age.clamp(0, 1), growth) : age.clamp(0, 1);
    const sizeVar = shading === 'spark' || shading === 'bubble' ? float(1) : mix(float(0.66), float(1.28), vary.x);
    // Encode the aerosol class in the unused negative diameter range. Mixed emitters
    // share the same draw, simulation and storage on both renderers.
    const classified = mAttr.y.lessThan(0);
    const endSize = this.smokePool || this.mistPool ? classified.select(mAttr.y.negate().sub(1), mAttr.y) : mAttr.y;
    const size = mix(mAttr.x, endSize, sizeCurve).mul(sizeVar).mul(select(alive, float(1), float(0)));
    // Area-preserving anisotropy: billows squash/stretch, flames stand taller than wide.
    const aspect = volumetric ? mix(float(0.8), float(1.25), vary.y)
      : shading === 'grit' ? mix(float(0.55), float(1.05), vary.y)
      : shading === 'fire' ? mix(float(0.72), float(0.86), vary.y) : float(1);
    const aspectY = float(1).div(aspect);
    const corner = positionGeometry.xy;
    const center = pAttr.xyz;

    const camRight = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const camUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    let worldPos: N;
    let vAspect: N = float(1);
    let rotation: N = vec2(1,0);
    if (stretch > 0) {
      // Velocity-aligned streak: a thin ribbon as long as the distance travelled during the
      // "shutter" time. Width never drops below ~1 px so distant droplets do not vanish.
      const speed = length(vAttr.xyz).add(1e-4);
      const axis = vAttr.xyz.div(speed);
      const toCamVec = cameraPosition.sub(center);
      const dist = length(toCamVec);
      const side = normalize(cross(axis, toCamVec.div(dist)).add(vec3(1e-5, 0, 0)));
      // Spray streaks are droplet trails, not sheets: a thin core keeps fans from
      // reading as wide white wedges once `sizeEnd` grows the cloud.
      const widthScale = shading === 'spray' ? 0.2 : 1;
      const width = max(size.mul(widthScale), dist.mul(0.0011).mul(select(alive, float(1), float(0))));
      const streak = width.mul(1.5).add(speed.mul(stretch));
      worldPos = center.add(axis.mul(corner.y.mul(streak))).add(side.mul(corner.x.mul(width)));
      vAspect = streak.div(max(width, 1e-4)).toVarying('pAspect');
    } else {
      // Per-particle rotation that slowly spins: breaks up repetition in smoke / spray.
      // Flames only lean and sway: a fully spun sprite sends its tongues sideways or down.
      const angle = shading === 'fire'
        ? mAttr.z.sub(0.5).mul(0.5).add(sin(age.mul(6.0).add(mAttr.z.mul(20.0))).mul(0.06))
        : mAttr.z.mul(6.2831).add(age.mul(mAttr.z.sub(0.5)).mul(shading === 'grit' ? 8 : shading === 'smoke' ? 2.4 : 0.6));
      const ca = cos(angle), sa = sin(angle);
      rotation = vec2(ca, sa).toVarying('pRoll');
      const lx = corner.x.mul(aspect), ly = corner.y.mul(aspectY);
      let rx = lx.mul(ca).sub(ly.mul(sa));
      let ry = lx.mul(sa).add(ly.mul(ca));
      if (this.mistPool) {
        const projected = vec2(dot(vAttr.xyz, camRight), dot(vAttr.xyz, camUp));
        const speed = length(projected);
        const axis = speed.greaterThan(0.02).select(projected.div(speed.max(0.02)), vec2(1, 0));
        const elongation = speed.mul(0.085).clamp(0, 0.9).add(1);
        const along = corner.x.mul(elongation), across = corner.y.div(elongation);
        rx = classified.select(axis.x.mul(along).sub(axis.y.mul(across)), rx);
        ry = classified.select(axis.y.mul(along).add(axis.x.mul(across)), ry);
      }
      worldPos = center.add(camRight.mul(rx.mul(size))).add(camUp.mul(ry.mul(size)));
    }
    material.positionNode = worldPos;

    // Volumetric sprites dissolve as the camera enters them: a puff must never become a
    // screen-filling flat card (the classic "white-out when you fly through mist" artefact).
    const vNear = smoothstep(size.mul(0.45).add(0.15), size.mul(1.9).add(0.8), length(cameraPosition.sub(center))).toVarying('pNear');
    const vAge = age.toVarying('pAge');
    const vSeed = mAttr.z.toVarying('pSeed');
    const vTemp = mAttr.w.toVarying('pTemp');
    const rubber = this.smokePool ? float(classified).toVarying('pRubber') : float(0);
    const aerosol = this.mistPool ? float(classified).toVarying('pAerosol') : float(0);
    const vCenter = center.toVarying('pCenter');

    // Normalised Henyey–Greenstein phase (mean 1 over the sphere).
    const phaseHG = (cosT: N, g: number): N => float(1 - g * g).div(pow(float(1 + g * g).sub(cosT.mul(2 * g)), 1.5));

    material.colorNode = Fn(() => {
      const c = uv().mul(2).sub(1);
      const r = length(c);
      const sun = frame.sunDirection;
      const sunCol = frame.sunColor.mul(frame.sunVisibility);
      const ambient = mix(frame.skyHorizon, frame.skyZenith, 0.5);
      const sceneDepth = offscreen ? offscreen.sample(screenUV).r : viewportDepthTexture(screenUV).r;
      const sceneZ = perspectiveDepthToViewZ(sceneDepth, cameraNear, cameraFar);
      const soft = sceneZ.negate().sub(positionView.z.negate()).div(u.softness).clamp(0, 1);
      const fadeIn = smoothstep(0.0, 0.06, vAge);
      const viewDir = normalize(cameraPosition.sub(vCenter));
      // Scattering angle: 1 when looking toward the sun through the particle.
      const cosT = dot(viewDir.negate(), sun);
      const out = vec4(0).toVar();
      // Pre-integrated optical thickness and normals are sampled once per soft fragment,
      // plus one opacity tap toward the sun for directional self-shadow.
      let billow: N, cloudNormal: N, sunTrans: N, occlusion: N, guard: N, variety: N;
      if (opticalAtlas) {
        const tile = floor(vSeed.mul(4)).min(3);
        const tileOrigin = vec2(TSL.mod(tile, 2), floor(tile.div(2)));
        // Mirror half the pool: with four baked variants and free rotation this gives
        // eight distinct silhouettes before any two neighbours can match.
        const flip = select(fract(vSeed.mul(7.31)).greaterThan(0.5), float(-1), float(1));
        // Differential swirl: the core turns faster than the fringe, shearing the baked
        // filaments into rolling strands instead of rotating a rigid cut-out.
        const swirlRate = fract(vSeed.mul(3.17)).sub(0.5).mul(shading === 'smoke' ? 1.6 : 0.9);
        const swirl = vAge.mul(swirlRate).mul(smoothstep(1.0, 0.0, r));
        const sc = cos(swirl), ss = sin(swirl);
        const cf = vec2(c.x.mul(flip), c.y);
        const cs = vec2(cf.x.mul(sc).sub(cf.y.mul(ss)), cf.x.mul(ss).add(cf.y.mul(sc)));
        const curl = vec2(sin(c.y.mul(6.3).add(vAge.mul(3.5)).add(vSeed.mul(17))),
          cos(c.x.mul(6.1).sub(vAge.mul(3)).add(vSeed.mul(23)))).mul(0.018);
        const local = cs.mul(0.5).add(0.5).add(curl).clamp(0.012, 0.988);
        billow = TSL.texture(opticalAtlas, local.add(tileOrigin).mul(0.5)).toVar();
        // Tile-space normal → undo swirl → mirror → particle roll → world.
        const nt = billow.gb.mul(2).sub(1);
        const nu = vec2(nt.x.mul(sc).add(nt.y.mul(ss)).mul(flip), nt.y.mul(sc).sub(nt.x.mul(ss)));
        const nx = nu.x.mul(rotation.x).sub(nu.y.mul(rotation.y));
        const ny = nu.x.mul(rotation.y).add(nu.y.mul(rotation.x));
        const nz = float(1).sub(dot(nu, nu)).max(0.015).sqrt();
        const detailN = normalize(camRight.mul(nx).add(camUp.mul(ny)).add(viewDir.mul(nz)));
        // Macro sphere normal keeps each puff a rounded volume under low-sun light.
        const mx = c.x.mul(rotation.x).sub(c.y.mul(rotation.y));
        const my = c.x.mul(rotation.y).add(c.y.mul(rotation.x));
        const mz = float(1).sub(r.mul(r)).max(0.04).sqrt();
        const macroN = normalize(camRight.mul(mx.mul(0.8)).add(camUp.mul(my.mul(0.8))).add(viewDir.mul(mz)));
        cloudNormal = normalize(mix(macroN, detailN, 0.5));
        // Directional self-shadow: baked opacity one third of a radius toward the sun,
        // carried through the same roll / mirror / swirl as the lookup.
        const sunS = vec2(dot(sun, camRight), dot(sun, camUp));
        const sunL = vec2(sunS.x.mul(rotation.x).add(sunS.y.mul(rotation.y)).mul(flip),
          sunS.y.mul(rotation.x).sub(sunS.x.mul(rotation.y)));
        const sunT = vec2(sunL.x.mul(sc).sub(sunL.y.mul(ss)), sunL.x.mul(ss).add(sunL.y.mul(sc)));
        const tapLocal = local.add(sunT.mul(0.16)).clamp(0.012, 0.988);
        const occluder = TSL.texture(opticalAtlas, tapLocal.add(tileOrigin).mul(0.5)).r;
        // Back-lit puffs are lit through their whole thickness; front-lit ones mostly
        // show the face the sun reaches.
        const behind = cosT.mul(0.5).add(0.5);
        sunTrans = exp(occluder.mul(-1.6).sub(billow.r.mul(behind).mul(1.4)));
        occlusion = billow.a;
        // Never let a sprite's quad edge show, whatever the warp or swirl did.
        guard = smoothstep(1.0, 0.84, r);
        variety = mix(float(0.78), float(1.0), fract(vSeed.mul(5.3)));
      }

      if (shading === 'grit') {
        // Cut corners, asymmetric faces and a tumbling local basis for small solid grains.
        const edge = max(max(abs(c.x), abs(c.y)), abs(c.x.add(c.y.mul(0.7))).mul(0.85))
          .add(vSeed.mul(0.15));
        const aa = TSL.fwidth(edge).clamp(0.035, 0.55);
        const coverage = smoothstep(float(0.90).sub(aa), float(0.90).add(aa), edge).oneMinus();
        const facet = c.x.add(c.y.mul(0.54)).greaterThan(vSeed.sub(0.5)).select(float(0.54), float(-0.42));
        const nx = facet.mul(rotation.x).sub(c.y.mul(0.23).mul(rotation.y));
        const ny = facet.mul(rotation.y).add(c.y.mul(0.23).mul(rotation.x));
        const normal = normalize(camRight.mul(nx).add(camUp.mul(ny)).add(viewDir));
        const light = ambient.mul(0.68).add(sunCol.mul(dot(normal, sun).max(0).mul(1 / Math.PI)));
        out.assign(vec4(u.color.mul(light).mul(vSeed.mul(0.45).add(0.7)),
          coverage.mul(u.opacity).mul(soft).mul(smoothstep(1, 0.85, vAge))));
      } else if (shading === 'spray') {
        // Thin droplet trails that break into beads (ligaments) along their travel.
        const lateral = smoothstep(1.0, 0.0, abs(c.x)).pow(2.5);
        const ends = smoothstep(1.0, 0.4, abs(c.y));
        const beadUV = vec2(c.x.mul(0.9).add(vSeed.mul(37.0)), c.y.mul(vAspect).mul(0.55).add(vSeed.mul(91.0)));
        const beads = smoothstep(0.5, 0.78, valueNoise2(beadUV));
        const alpha = lateral.mul(ends).mul(beads.mul(0.88).add(0.12)).mul(fadeIn).mul(smoothstep(1.0, 0.5, vAge));
        // Water droplets: ~1/π Lambert-like sun response plus a narrow forward glint, so
        // a front-lit fan matches daylight whites instead of clipping.
        const glint = phaseHG(cosT, 0.75).mul(0.05);
        const fireRad = fireLights.sampleVolumetric(vCenter, viewDir, viewDir, 0.7).mul(u.fireLightGain);
        const lit = ambient.mul(0.85).add(sunCol.mul(glint.add(0.26))).add(fireRad);
        out.assign(vec4(lit.mul(u.color), alpha.mul(u.opacity).mul(soft).mul(vNear)));
      } else if (shading === 'mist' || shading === 'dust') {
        const drift = vec2(vSeed.mul(53.0), vSeed.mul(29.0).add(vAge.mul(0.9)));
        const wisp = spriteNoise(c.mul(1.6).add(drift));
        // Ridged, warped erosion carves only the thin fringe; the body stays continuous.
        const strand = abs(spriteNoise(c.mul(3.6).sub(drift.mul(1.7)).add(wisp.mul(0.8)), 1).mul(2).sub(1));
        const body = billow.r;
        const erode = strand.mul(0.38).add(wisp.mul(0.12)).mul(float(1).sub(body));
        let alpha = body.mul(smoothstep(0.0, 0.22, body.sub(erode))).mul(guard).mul(variety)
          .mul(fadeIn).mul(smoothstep(1.0, 0.3, vAge));
        const thin = float(1).sub(body.mul(0.6));
        const forward = phaseHG(cosT, shading === 'mist' ? 0.6 : 0.35).mul(shading === 'mist' ? 0.08 : 0.05).mul(thin);
        const direct = dot(cloudNormal, sun).mul(0.5).add(0.5);
        const sky = mix(frame.skyHorizon, frame.skyZenith, cloudNormal.y.mul(0.5).add(0.5)).mul(occlusion.mul(0.55).add(0.45));
        const fireRad = fireLights.sampleVolumetric(vCenter, cloudNormal, viewDir, 0.6).mul(u.fireLightGain);
        let lit = sunCol.mul(direct.mul(0.3).add(forward)).mul(sunTrans).add(sky.mul(0.9)).add(fireRad.mul(0.58));
        if (this.mistPool) {
          // A dilute aerosol has a smooth optical-depth profile and forward scattering;
          // lighting each packet like an opaque billow produces a string of grey balls.
          const density = exp(dot(c, c).mul(-2.8)).mul(smoothstep(1.0, 0.35, r))
            .mul(wisp.mul(0.42).add(0.58)).mul(0.48).mul(fadeIn).mul(float(1).sub(vAge).pow(1.3));
          const scattered = ambient.mul(0.88).add(sunCol.mul(phaseHG(cosT, 0.66).mul(0.065).add(0.16))).add(fireRad.mul(0.58));
          alpha = mix(alpha, density, aerosol); lit = mix(lit, scattered, aerosol);
        }
        out.assign(vec4(lit.mul(u.color), alpha.mul(u.opacity).mul(soft).mul(vNear)));
      } else if (shading === 'bubble') {
        const rim = smoothstep(0.5, 0.92, r).mul(smoothstep(1.0, 0.93, r));
        const spot = smoothstep(0.3, 0.0, length(c.sub(vec2(-0.3, 0.42))));
        const disc = smoothstep(1.0, 0.9, r);
        const dist = length(cameraPosition.sub(vCenter));
        const reach = exp(dist.mul(-0.11));
        const lit = ambient.mul(1.4).add(sunCol.mul(0.5));
        const alpha = rim.mul(0.75).add(spot.mul(0.9)).add(disc.mul(0.06)).mul(fadeIn).mul(smoothstep(1.0, 0.85, vAge)).mul(reach);
        out.assign(vec4(lit.mul(u.color).mul(float(1).add(spot.mul(2.0))), alpha.mul(u.opacity).mul(soft)));
      } else if (shading === 'smoke') {
        // Soot puff: continuous core, fringe eroded into sharp rolling filaments by ridged
        // noise advected with the plume, lit by sun through baked self-shadow.
        const n1 = spriteNoise(c.mul(2.1).add(vSeed.mul(41.0)).add(vec2(0, vAge.mul(-0.6))));
        const strand = abs(spriteNoise(c.mul(4.6).add(vSeed.mul(17.0)).add(n1.mul(0.9)).add(vec2(0, vAge.mul(-1.1))), 1).mul(2).sub(1));
        // Soot is optically denser than the shared atlas mean: lift mid opacities so a
        // plume keeps its dense core with the thinner, filament-eroded atlas.
        const body = billow.r.pow(0.75);
        const erode = strand.mul(0.42).add(n1.mul(0.1)).mul(float(1).sub(body));
        const density = body.mul(smoothstep(0.0, 0.2, body.sub(erode))).mul(guard);
        const normalW = cloudNormal;
        const direct = smoothstep(-0.3, 1.0, dot(normalW, sun)).mul(sunTrans);
        // Fresh carbon soot is near-black; it dilutes toward grey as it entrains air.
        const soot = mix(vec3(0.035, 0.034, 0.033), vec3(0.15, 0.148, 0.145), smoothstep(0.15, 1.0, vAge));
        const albedo = mix(soot, vec3(0.39, 0.42, 0.46), rubber).mul(u.color);
        const thin = float(1).sub(density);
        const forward = phaseHG(cosT, 0.45).mul(0.25).mul(thin).mul(sunTrans);
        const sky = mix(frame.skyHorizon, frame.skyZenith, normalW.y.mul(0.5).add(0.5)).mul(occlusion.mul(0.6).add(0.25));
        const fireScatter = fireLights.sampleVolumetric(vCenter, normalW, viewDir, 0.5).mul(u.fireLightGain);
        // Thick soot swallows firelight; only thin fringes pass a warm glow. A strong warm
        // bias here previously tinted whole plumes brown.
        const smokeBounce = mix(albedo.mul(2.0), vec3(0.2, 0.14, 0.09), thin.mul(0.45));
        const lit = albedo.mul(sunCol.mul(direct.mul(0.85).add(forward)).add(sky.mul(0.9))).add(smokeBounce.mul(fireScatter));
        const glow = vec3(0).toVar();
        If(vTemp.greaterThan(0.08).and(vAge.lessThan(0.5)), () => {
          // Only genuinely hot soot emits; sub-threshold temperatures no longer leak a
          // dull red over the whole puff. Capped below white.
          const heat = vTemp.mul(density).mul(0.8);
          glow.assign(blackbody(heat.min(0.7)).mul(smoothstep(0.22, 0.36, heat)).mul(smoothstep(0.5, 0.0, vAge)).mul(density));
        });
        const alpha = density.mul(variety).mul(fadeIn).mul(smoothstep(1.0, 0.45, vAge)).mul(u.opacity).mul(rubber.mul(-0.22).add(1));
        out.assign(vec4(lit.add(glow), alpha.mul(soft).mul(vNear)));
      } else if (shading === 'fire') {
        // Flame sprite: tapered body with upward-advected, ridged tongues. Sprites stay
        // upright (see rotation), so tongues always lick upward.
        const flow = vec2(c.x.mul(1.5).add(vSeed.mul(19.0)), c.y.sub(frame.time.mul(2.6)).add(vSeed.mul(7.0)));
        const warp = spriteNoise(flow.mul(1.6));
        const sheet = spriteNoise(vec2(flow.x.mul(2.4).add(warp.mul(1.2)), flow.y.mul(2.0)), 1);
        const ridge = float(1).sub(abs(sheet.mul(2).sub(1)));
        const env = length(vec2(c.x.mul(float(1).add(c.y.max(0).mul(0.8))), c.y.add(0.18).mul(0.82)));
        const lick = env.add(warp.sub(0.5).mul(0.6)).add(ridge.oneMinus().mul(c.y.add(1).mul(0.22)));
        const shape = smoothstep(0.95, 0.62, lick);
        // Temperature peaks low in the flame and along sheet crests. Tone-compressed
        // (max ≈ 0.8) and scaled so dozens of additive sprites saturate toward orange /
        // yellow HDR instead of clipping to a white slab.
        const core = smoothstep(1.0, 0.0, env);
        const raw = vTemp.mul(core.mul(0.7).add(ridge.mul(0.45))).mul(mix(1.0, 0.3, vAge));
        const heat = float(0.8).mul(float(1).sub(exp(raw.mul(-1.5))));
        const colour = blackbody(heat).mul(0.45);
        out.assign(vec4(colour.mul(u.color), shape.mul(fadeIn).mul(smoothstep(1.0, 0.6, vAge)).mul(u.opacity).mul(soft)));
      } else {
        // Sparks: tight HDR core with a soft halo.
        const core = smoothstep(1.0, 0.0, r).pow(2.5);
        const colour = blackbody(vTemp.mul(1.1)).add(vec3(0.6, 0.75, 1.0).mul(core).mul(vTemp).mul(0.6));
        out.assign(vec4(colour.mul(u.color).mul(2.2), core.mul(smoothstep(1.0, 0.7, vAge)).mul(u.opacity)));
      }
      return out;
    })();

    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, this.capacity);
    mesh.frustumCulled = false;
    mesh.renderOrder = config.renderOrder ?? 20;
    mesh.matrixAutoUpdate = false;
    mesh.name = `particles:${shading}`;
    return mesh;
  }

  /** Queue a burst. Up to six batches are flushed per frame; the rest carry over. */
  emit(options: EmitOptions): void { this.enqueue(options, options.count); }

  /** Queue a burst from a packed request (see `EMIT`). The request is copied; reuse it freely. */
  emitPacked(request: Float64Array, count: number): void {
    if (count < 1 || this.pending >= QUEUE_SIZE) return;
    if (request.length !== REQUEST_STRIDE) throw new RangeError('Incorrect packed particle request length');
    const q = this.ring, offset = ((this.head + this.pending++) % QUEUE_SIZE) * REQUEST_STRIDE;
    q.set(request, offset);
    q[offset + REQUEST_COUNT] = count;
  }

  /** Copy a request into the next free slot of the ring (callers reuse their option objects). */
  private enqueue(o: Omit<EmitOptions, 'count'>, count: number): void {
    if (count < 1 || this.pending >= QUEUE_SIZE) return;
    const q = this.ring, offset = ((this.head + this.pending++) % QUEUE_SIZE) * REQUEST_STRIDE;
    const p = o.position, v = o.velocity;
    q[offset] = p.x; q[offset + 1] = p.y; q[offset + 2] = p.z; q[offset + 3] = o.radius ?? 0;
    q[offset + 4] = v?.x ?? 0; q[offset + 5] = v?.y ?? 0; q[offset + 6] = v?.z ?? 0; q[offset + 7] = o.spread ?? 0;
    q[offset + 8] = o.life; q[offset + 9] = o.lifeJitter ?? 0.3; q[offset + 10] = o.size;
    const end = o.sizeEnd ?? o.size;
    const classified = (this.smokePool && o.smokeMaterial === 'rubber') || (this.mistPool && o.mistMaterial === 'aerosol');
    q[offset + 11] = classified ? -1 - end : end;
    q[offset + EMIT.TEMPERATURE] = o.temperature ?? 0; q[offset + EMIT.SPEED_JITTER] = o.speedJitter ?? 0.3; q[offset + REQUEST_COUNT] = count;
  }

  /** Carry slot of a keyed rate emitter in `remainders`. */
  private slotOf(key: string): number {
    let slot = this.emitterSlots.get(key);
    if (slot === undefined) {
      slot = this.emitterSlots.size;
      if (slot === this.remainders.length) {
        const larger = new Float64Array(slot * 2);
        larger.set(this.remainders);
        this.remainders = larger;
      }
      this.emitterSlots.set(key, slot);
    }
    return slot;
  }

  /**
   * Continuous emission helper: accumulates fractional particles so `rate` (particles/s)
   * stays exact at any frame rate. `key` identifies the emitter.
   */
  emitRate(key: string, rate: number, dt: number, options: Omit<EmitOptions, 'count'>): void {
    const slot = this.slotOf(key);
    this.emitRateAt(this.remainders, slot, rate, dt, options);
  }

  /** `emitRate` for a packed request (see `EMIT`). */
  emitRatePacked(key: string, rate: number, dt: number, request: Float64Array): void {
    const slot = this.slotOf(key), carry = this.remainders;
    const acc = carry[slot] + rate * dt;
    const count = Math.floor(acc);
    carry[slot] = acc - count;
    if (count > 0) this.emitPacked(request, count);
  }

  /** Carry fractional particles in the owner's storage for short-lived emission sources. */
  emitRateAt(carry: Float64Array, slot: number, rate: number, dt: number, options: Omit<EmitOptions, 'count'>): void {
    const acc = carry[slot] + rate * dt;
    const count = Math.floor(acc);
    carry[slot] = acc - count;
    if (count > 0) this.enqueue(options, count);
  }

  update(): void {
    if (!this.needsWarmup && this.pending === 0 && this.allocatedSlots === 0) return;
    const delta: number = frame.delta.value;
    let remainingLife = this.remainingLife - delta;
    // Compile both the sprite and simulation with one dead offscreen particle during
    // scene loading. A first burst then only dispatches previously prepared pipelines.
    if (this.needsWarmup) {
      this.needsWarmup = false;
      this.allocatedSlots = 1;
    } else if (this.pending === 0 && remainingLife <= 0) {
      this.cursor = this.allocatedSlots = 0;
    }
    this.mesh.visible = this.allocatedSlots > 0 || this.pending > 0;
    if (!this.mesh.visible) {
      this.remainingLife = remainingLife;
      this.mesh.count = 0;
      return;
    }
    const a: Float32Array = this.batchA.value, b: Float32Array = this.batchB.value;
    const c: Float32Array = this.batchC.value, d: Float32Array = this.batchD.value;
    const q = this.ring, stage = this.stage, capacity = this.capacity;
    for (let i = 0; i < BATCH_SLOTS; i++) {
      const k = 4 * i;
      if (this.pending === 0) { d[k + 2] = 0; continue; }
      const offset = this.head * REQUEST_STRIDE;
      const life = q[offset + EMIT.LIFE], lifeJitter = q[offset + EMIT.LIFE_JITTER];
      remainingLife = Math.max(remainingLife, life * (1 + Math.max(0, -lifeJitter)) + delta);
      this.head = (this.head + 1) % QUEUE_SIZE;
      this.pending--;
      const count = Math.min(Math.floor(q[offset + REQUEST_COUNT]), capacity);
      // Stage the request and hand its four vec4s to the batch buffers as block copies (each
      // converts to float32 exactly as an element store would), then fill in the two control
      // values this pool owns: where the batch starts and how many particles it spawns.
      q.copyWithin(STAGE, offset, offset + REQUEST_STRIDE);
      a.set(stage[0], k);
      b.set(stage[1], k);
      c.set(stage[2], k);
      d.set(stage[3], k);
      d[k + 1] = this.cursor;
      d[k + 2] = count;
      this.allocatedSlots = Math.max(this.allocatedSlots, Math.min(capacity, this.cursor + count));
      this.cursor = (this.cursor + count) % capacity;
    }
    this.remainingLife = remainingLife;
    this.mesh.count = this.allocatedSlots;
    this.computeNode.count = this.allocatedSlots;
    this.renderer.compute(this.computeNode);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.computeNode.dispose?.();
  }
}
