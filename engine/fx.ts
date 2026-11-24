/**
 * Shared effects kit: the GPU particle pools every module draws from (budgeted by the
 * quality tier), shared HDR local fire lighting (`fireLights`), expanding air-refraction
 * shockwave shells and depth-softened convective heat-refraction volumes.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';
import { frame, auxPassthrough } from './frame';
import { spriteNoise } from './noise';
import { refractedScreenUV } from './shading';
import {
  ParticleSystem,
  fireLights,
  LocalFireLights,
  MAX_FIRE_LIGHTS,
  type FireLightOptions,
  type FireLightHandle,
} from './particles';
import type { LuminaEngine, EngineModule } from './engine';
import type { QualityPreset } from './quality';

const {
  Fn, float, vec2, vec3, vec4, uv, screenUV, viewportTexture, viewportDepthTexture,
  perspectiveDepthToViewZ, cameraNear, cameraFar, positionView, positionWorld, cameraPosition,
  normalView, positionViewDirection, dot, pow, abs, smoothstep, length, userData, normalize, max, mix,
} = TSL;

export { fireLights, LocalFireLights, MAX_FIRE_LIGHTS, type FireLightOptions, type FireLightHandle };

/** Fraction of the tier's particle budget given to each pool. */
const BUDGET_SPLIT = { spray: 0.3, mist: 0.2, smoke: 0.2, fire: 0.12, sparks: 0.08, dust: 0.1 } as const;
/**
 * Large soft sprites are fill-rate bound: past a few thousand they only add overdraw, not
 * detail. Higher tiers spend their extra budget on (cheap, thin) spray streaks and sparks.
 */
const POOL_CAP: Partial<Record<keyof typeof BUDGET_SPLIT, number>> = { mist: 4200, smoke: 3400, dust: 2800, fire: 3600 };
export type PoolName = keyof typeof BUDGET_SPLIT;
const POOL_NAMES = Object.keys(BUDGET_SPLIT) as PoolName[];
const SOFT_POOLS = new Set<PoolName>(['mist', 'smoke', 'fire', 'dust']);

const MAX_SHOCKWAVES = 10;
const MAX_HAZES = 14;

export interface ShockwaveOptions {
  /** Visual expansion speed (m/s). */
  speed?: number;
  maxRadius?: number;
  /** Screen-space refraction strength (default 1). */
  strength?: number;
  /** Clip/fade the lower half below the origin Y (ground-hugging blasts). */
  hemisphere?: boolean;
  /** 0..2 visible condensation / compression flash along the shell rim (default 0.35). */
  condensation?: number;
  /** 0..1 warm amber tint vs neutral white compression rim (default 0). */
  warmth?: number;
}

export interface HeatHazeOptions {
  /** Initial world radius (m). */
  radius: number;
  /** Refraction distortion amplitude (default 1). */
  strength?: number;
  /** Lifetime in seconds (default 4). */
  duration?: number;
  /** Upward convective rise speed in m/s (default 2). */
  rise?: number;
  /** 0..1 subtle warm mirage glow inside the shimmer column (default 0.08). */
  warmth?: number;
  /** Horizontal expansion rate in m/s (default 0.35). */
  expand?: number;
}

interface Shockwave {
  mesh: THREE.Mesh;
  age: number;
  duration: number;
  speed: number;
  maxRadius: number;
}

interface Haze {
  mesh: THREE.Mesh;
  age: number;
  duration: number;
  rise: number;
  expand: number;
  radius: number;
}

export class EffectsKit implements EngineModule {
  spray!: ParticleSystem;
  mist!: ParticleSystem;
  smoke!: ParticleSystem;
  fire!: ParticleSystem;
  sparks!: ParticleSystem;
  dust!: ParticleSystem;
  /** Shared HDR local fire-light field sampled by particles, materials, water and clouds. */
  readonly fireLights = fireLights;
  /** Height of the water / ground plane where ballistic droplets die. */
  floorY = 0;

  private shockwaves: Shockwave[] = [];
  private shockPool: THREE.Mesh[] = [];
  private hazes: Haze[] = [];
  private hazePool: THREE.Mesh[] = [];
  private shockGeometry = new THREE.SphereGeometry(1, 48, 24);
  private hazeGeometry = new THREE.PlaneGeometry(1, 1);
  private hazeMaterial: THREE.NodeMaterial;
  private shockMaterial: THREE.NodeMaterial;

  constructor(private engine: LuminaEngine,private readonly volumeLight?:(p:N)=>N) {
    this.hazeMaterial = this.createHazeMaterial();
    this.shockMaterial = this.createShockMaterial();
    this.build(engine.quality.preset);
    // First blast / first heat shimmer must not pay for shader compilation.
    const shell = new THREE.Mesh(this.shockGeometry, this.shockMaterial);
    shell.userData.shockStrength = 0;
    shell.userData.shockFade = 0;
    shell.userData.shockCondense = 0.35;
    shell.userData.shockWarmth = 0;
    shell.userData.shockHemisphere = 0;
    shell.userData.shockOriginY = 0;
    const haze = new THREE.Mesh(this.hazeGeometry, this.hazeMaterial);
    haze.userData.hazeStrength = 0;
    haze.userData.hazeWarmth = 0;
    engine.prewarm(shell);
    engine.prewarm(haze);
  }

  private build(preset: QualityPreset): void {
    const { renderer, wind, scene, pipeline } = this.engine;
    // Large soft sprites go to the half-resolution off-screen layer; thin streaks stay in the scene.
    const softDepth = pipeline.sceneDepth;
    for (const name of POOL_NAMES) this[name]?.dispose();
    const cap = (name: PoolName) => Math.max(256, Math.min(POOL_CAP[name] ?? Infinity, Math.floor(preset.particles.budget * BUDGET_SPLIT[name])));
    // Spray: ballistic micro-droplet streaks (1/22 s shutter).
    this.spray = new ParticleSystem(renderer, wind, { capacity: cap('spray'), shading: 'spray', incomingLight:this.volumeLight, gravity: 1, drag: 0.35, windInfluence: 0.7, floorY: this.floorY, stretch: 0.045, opacity: 0.85, softness: 0.4 });
    this.mist = new ParticleSystem(renderer, wind, { capacity: cap('mist'), shading: 'mist', incomingLight:this.volumeLight, softDepth, gravity: 0.03, drag: 1.3, turbulence: 0.9, windInfluence: 1, opacity: 0.3, softness: 1.5 });
    this.smoke = new ParticleSystem(renderer, wind, { capacity: cap('smoke'), shading: 'smoke', softDepth, gravity: 0, drag: 0.9, buoyancy: 9, cooling: 0.5, turbulence: 1.6, windInfluence: 1, opacity: 0.93, softness: 1.2, renderOrder: 18 });
    this.fire = new ParticleSystem(renderer, wind, { capacity: cap('fire'), shading: 'fire', softDepth, gravity: 0, drag: 1.6, buoyancy: 7, cooling: 1.5, turbulence: 2.2, windInfluence: 0.6, opacity: 1, softness: 0.8, renderOrder: 22 });
    this.sparks = new ParticleSystem(renderer, wind, { capacity: cap('sparks'), shading: 'spark', gravity: 1, drag: 0.25, cooling: 0.55, windInfluence: 0.3, floorY: this.floorY, bounce: 0.5, stretch: 0.03, opacity: 1, renderOrder: 24 });
    this.dust = new ParticleSystem(renderer, wind, { capacity: cap('dust'), shading: 'dust', incomingLight:this.volumeLight, softDepth, gravity: 0.08, drag: 1.8, turbulence: 0.7, windInfluence: 1, opacity: 0.45, color: 0x9a8f80, softness: 1.2 });
    for (const name of POOL_NAMES) (SOFT_POOLS.has(name) ? pipeline.softScene : scene).add(this[name].mesh);
  }

  setFloor(y: number): void {
    this.floorY = y;
    this.spray.uniforms.floorY.value = y;
    this.sparks.uniforms.floorY.value = y;
  }

  setQuality(preset: QualityPreset): void {
    this.build(preset);
    this.setFloor(this.floorY);
  }

  /** Register a dynamic HDR local fire light (sampled by smoke, mist, spray, wet materials and clouds). */
  addFireLight(options: FireLightOptions): FireLightHandle {
    return this.fireLights.add(options);
  }

  // ---- shockwaves -----------------------------------------------------------

  /**
   * Expanding spherical (or hemispherical) pressure front that refracts the scene behind it.
   * `speed` is the visual expansion speed (m/s) – 150–400 reads cleanly at game scale.
   */
  shockwave(position: THREE.Vector3, options: ShockwaveOptions = {}): void {
    if (this.shockwaves.length >= MAX_SHOCKWAVES) this.removeShockwave(0);
    const mesh = this.shockPool.pop() ?? new THREE.Mesh(this.shockGeometry, this.shockMaterial);
    mesh.position.copy(position);
    mesh.scale.setScalar(0.5);
    mesh.renderOrder = 30;
    mesh.frustumCulled = false;
    mesh.userData.shockStrength = options.strength ?? 1;
    mesh.userData.shockFade = 1;
    mesh.userData.shockCondense = options.condensation ?? 0.35;
    mesh.userData.shockWarmth = options.warmth ?? 0;
    mesh.userData.shockHemisphere = options.hemisphere ? 1 : 0;
    mesh.userData.shockOriginY = position.y;
    this.engine.scene.add(mesh);
    const maxRadius = options.maxRadius ?? 120;
    const speed = options.speed ?? 220;
    this.shockwaves.push({ mesh, age: 0, duration: maxRadius / Math.max(speed, 1), speed, maxRadius });
  }

  private removeShockwave(index: number): void {
    const s = this.shockwaves[index];
    s.mesh.removeFromParent();
    this.shockPool.push(s.mesh);
    this.shockwaves.splice(index, 1);
  }

  /** One material for every shell: per-shell strength / fade / tint come from `userData`. */
  private createShockMaterial(): THREE.NodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;
    material.colorNode = Fn(() => {
      const strength = userData('shockStrength', 'float');
      const fade = userData('shockFade', 'float');
      const condense = userData('shockCondense', 'float');
      const warmth = userData('shockWarmth', 'float');
      const hemi = userData('shockHemisphere', 'float');
      const originY = userData('shockOriginY', 'float');

      const cosine = abs(dot(normalize(normalView), normalize(positionViewDirection)));
      const rim = float(1).sub(cosine);
      const hemiMask = mix(float(1), smoothstep(originY.sub(0.35), originY.add(0.45), positionWorld.y), hemi);
      // Only the grazing silhouette of the shell bends light: a thin lensing ring.
      // Rays on either side of the shell boundary see the same background.
      // Taper the optical deflection to zero there: a discontinuity duplicates
      // entire wings and horizon segments when a long lens tracks through the ring.
      const edge = smoothstep(0, max(0.13,TSL.fwidth(cosine).mul(2)), cosine);
      const band = pow(rim, 6.5).mul(edge).mul(fade).mul(hemiMask);
      const aspect = TSL.screenSize.y.div(TSL.screenSize.x);
      const offset = normalView.xy.mul(vec2(aspect,-1)).mul(band).mul(strength).mul(0.0045);
      // `viewportTexture` (not the shared opaque copy) so the lens also bends water, spray and smoke.
      const refracted = viewportTexture(refractedScreenUV(screenUV, offset)).rgb;
      const tint = mix(vec3(1.0, 1.0, 1.0), vec3(1.25, 0.85, 0.55), warmth);
      // Compression brightens the front slightly (condensation halo at the leading edge).
      const color = refracted.mul(band.mul(condense).add(1)).add(tint.mul(band.mul(condense).mul(0.32)));
      return vec4(color, smoothstep(0.01, 0.12, band));
    })();
    material.mrtNode = auxPassthrough();
    return material;
  }

  // ---- heat refraction (convective haze) ------------------------------------

  private createHazeMaterial(): THREE.NodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;
    material.colorNode = Fn(() => {
      const c = uv().mul(2).sub(1);
      const strength = userData('hazeStrength', 'float');
      const warmth = userData('hazeWarmth', 'float');
      const r = length(c);
      const falloff = smoothstep(1.0, 0.08, r);
      // Depth-soft + near-camera fade so shimmering volumes never carve hard intersections.
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(screenUV).r, cameraNear, cameraFar);
      const soft = sceneZ.negate().sub(positionView.z.negate()).div(1.2).clamp(0, 1);
      const nearFade = smoothstep(0.7, 2.6, length(cameraPosition.sub(positionWorld)));
      // Carry fine refractive cells on larger rolling eddies. The card's +Y
      // axis follows the exhaust jet, or vertical convection for a fire.
      const p = vec2(c.x.mul(2.8), c.y.mul(2.2).sub(frame.time.mul(2.1)));
      const roll = vec2(spriteNoise(p), spriteNoise(p,1)).sub(0.5);
      const fine = p.mul(2.9).add(roll.mul(2.3)).add(vec2(2.9, frame.time.mul(-0.85)));
      const density = spriteNoise(fine,1).mul(0.25).add(roll.x.mul(0.75));
      const pixelWidth = float(2).div(max(length(TSL.fwidth(c)),0.0001));
      // Deflection follows the gradient of the integrated density. Bound it
      // by the projected plume width so a distant nozzle cannot bend a whole wing.
      const gradient = vec2(TSL.dFdx(density),TSL.dFdy(density)).mul(pixelWidth);
      const wave = gradient.div(length(gradient).add(1));
      const amp = falloff.mul(strength).mul(soft).mul(nearFade);
      const offset = wave.mul(amp).mul(pixelWidth.mul(0.06).min(6)).div(TSL.screenSize);
      const refracted = viewportTexture(refractedScreenUV(screenUV, offset)).rgb;
      const shimmerTint = mix(vec3(1.0, 1.0, 1.0), vec3(1.12, 0.97, 0.88), warmth.mul(amp).clamp(0, 1));
      return vec4(refracted.mul(shimmerTint), amp.min(1));
    })();
    material.mrtNode = auxPassthrough();
    return material;
  }

  /** Screen-space convective heat-refraction volume (billboard). Rises and fades over `duration`. */
  heatHaze(position: THREE.Vector3, radius: number, strength = 1, duration = 4, rise = 2, warmth = 0.08, expand = 0.35): void {
    if (this.hazes.length >= MAX_HAZES) this.removeHaze(0);
    const mesh = this.hazePool.pop() ?? new THREE.Mesh(this.hazeGeometry, this.hazeMaterial);
    mesh.position.copy(position);
    mesh.scale.set(radius * 2, radius * 2.6, 1);
    mesh.renderOrder = 28;
    mesh.userData.hazeStrength = strength;
    mesh.userData.hazeBase = strength;
    mesh.userData.hazeWarmth = warmth;
    mesh.frustumCulled = false;
    this.engine.scene.add(mesh);
    this.hazes.push({ mesh, age: 0, duration, rise, expand, radius });
  }

  /** Ergonomic object-options overload for spawning a heat-refraction column. */
  heatRefraction(position: THREE.Vector3, options: HeatHazeOptions): void {
    this.heatHaze(
      position,
      options.radius,
      options.strength ?? 1,
      options.duration ?? 4,
      options.rise ?? 2,
      options.warmth ?? 0.12,
      options.expand ?? 0.35,
    );
  }

  private removeHaze(index: number): void {
    const h = this.hazes[index];
    h.mesh.removeFromParent();
    this.hazePool.push(h.mesh);
    this.hazes.splice(index, 1);
  }

  /** A persistent haze the caller positions each frame (jet exhaust, active crater). */
  attachHaze(radius: number, strength = 1, warmth = 0.08): THREE.Mesh {
    const mesh = new THREE.Mesh(this.hazeGeometry, this.hazeMaterial);
    mesh.scale.set(radius * 2, radius * 2, 1);
    mesh.renderOrder = 28;
    mesh.userData.hazeStrength = strength;
    mesh.userData.hazeWarmth = warmth;
    mesh.frustumCulled = false;
    this.engine.scene.add(mesh);
    return mesh;
  }

  update(dt: number): void {
    const camera = this.engine.camera;
    this.fireLights.update(dt, camera.position);
    for (let i = 0; i < POOL_NAMES.length; i++) this[POOL_NAMES[i]].update();
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.age += dt;
      const k = s.age / s.duration;
      if (k >= 1) {
        this.removeShockwave(i);
        continue;
      }
      s.mesh.scale.setScalar(Math.max(0.5, s.age * s.speed));
      s.mesh.userData.shockFade = (1 - k) ** 1.5;
    }
    for (let i = this.hazes.length - 1; i >= 0; i--) {
      const h = this.hazes[i];
      h.age += dt;
      const k = h.age / h.duration;
      if (k >= 1) { this.removeHaze(i); continue; }
      h.mesh.position.y += h.rise * dt;
      const r = h.radius + h.expand * h.age;
      h.mesh.scale.set(r * 2, r * 2.6, 1);
      h.mesh.userData.hazeStrength = h.mesh.userData.hazeBase * Math.sin(Math.min(1, k * 6) * Math.PI * 0.5) * (1 - k);
      h.mesh.quaternion.copy(camera.quaternion);
    }
  }

  dispose(): void {
    this.fireLights.clear();
    for (const name of POOL_NAMES) this[name].dispose();
    for (const s of this.shockwaves) s.mesh.removeFromParent();
    this.shockMaterial.dispose();
    this.shockGeometry.dispose();
    for (const h of this.hazes) h.mesh.removeFromParent();
    this.shockwaves = [];
    this.shockPool = [];
    this.hazes = [];
    this.hazePool = [];
    this.hazeMaterial.dispose();
    this.hazeGeometry.dispose();
  }
}

export { max as _max };
