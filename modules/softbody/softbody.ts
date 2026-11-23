/**
 * Inflatable spring / pressure soft-body system.
 *
 *   const soft = engine.add(new SoftBodySystem(engine, { ocean }));
 *   const ball = soft.ball({ position: new THREE.Vector3(0, 4, 0), radius: 0.8 });
 *   const buoy = soft.buoy({ position: new THREE.Vector3(6, 1, -4) });
 *
 * Runs on WebGPU compute (`gpu.ts`) with an automatic CPU fallback (`cpu.ts`) on WebGL 2
 * or when `forceCpu` is set. Automatically reacts to the engine's unified wind/blast field,
 * water buoyancy (`Ocean` or `waterLevel`), and Rapier rigid-body colliders with two-way
 * impact coupling.
 */
import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../../engine/quality';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { RigidBody } from '../../engine/physics';
import { CpuSoftBodySolver } from './cpu';
import { GpuSoftBodySolver } from './gpu';
import {
  ballSpec,
  buoySpec,
  cushionSpec,
  customSoftBodySpec,
  torusSpec,
  type BallOptions,
  type BuoyOptions,
  type CushionOptions,
  type CustomSoftBodyOptions,
  type SoftBodyLook,
  type SoftBodyPattern,
  type TorusOptions,
} from './presets';
import {
  DEFAULT_SOFTBODY_TUNING,
  MAX_SB_BOXES,
  MAX_SB_SPHERES,
  MAX_SOFT_BODIES,
  type SoftBodyBackend,
  type SoftBodyBoxCollider,
  type SoftBodyContext,
  type SoftBodyImpactEvent,
  type SoftBodyRecord,
  type SoftBodySpec,
  type SoftBodySphereCollider,
  type SoftBodyTuning,
  type WaterSurfaceLike,
} from './types';

const {
  attribute, normalize, cameraViewMatrix, vec3, vec4, float, uv, max, dot, mix, step, floor, mod, atan, abs,
} = TSL;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

/** Procedural vinyl / marine inflatable shading pattern (TSL). */
function softBodyPatternNode(pattern: SoftBodyPattern, st: N, localPos: N, colors: THREE.Color[]): N {
  const c = (i: number): N => { const k = colors[Math.min(i, colors.length - 1)]; return vec3(k.r, k.g, k.b); };
  switch (pattern) {
    case 'beachball': {
      const ang = atan(localPos.z, localPos.x).div(Math.PI * 2).add(0.5);
      const panel = floor(ang.mul(6));
      const m3 = mod(panel, 3);
      const base = mix(mix(c(0), c(1), step(0.5, m3)), c(2), step(1.5, m3));
      const cap = step(0.84, abs(normalize(localPos).y));
      return mix(base, c(1), cap);
    }
    case 'lifeRing': {
      // Four reflective fabric bands wrapped around the tube; follow rest space as it bends.
      const angle = atan(localPos.z, localPos.x);
      const patch = TSL.smoothstep(0.74, 0.80, TSL.cos(angle.mul(4)));
      return mix(c(0), c(1), patch);
    }
    case 'stripes': {
      const band = floor(st.x.mul(8));
      return mix(c(0), c(1), mod(band, 2));
    }
    case 'buoy': {
      const band = step(0.28, abs(normalize(localPos).y)).mul(step(abs(normalize(localPos).y), 0.52));
      return mix(c(0), c(1), band);
    }
    case 'checker': {
      const cell = floor(st.x.mul(8)).add(floor(st.y.mul(8)));
      return mix(c(0), c(1), mod(cell, 2));
    }
    default:
      return c(0);
  }
}

export class SoftBody {
  mesh: THREE.Mesh | null = null;
  constructor(readonly system: SoftBodySystem, readonly record: SoftBodyRecord, readonly look: SoftBodyLook) {}

  get tuning(): SoftBodyTuning { return this.record.tuning; }
  get enabled(): boolean { return this.record.enabled; }
  set enabled(value: boolean) { this.record.enabled = value; if (this.mesh) this.mesh.visible = value; }
  get pressure(): number { return this.record.tuning.pressure; }
  set pressure(value: number) { this.record.tuning.pressure = Math.max(0, value); }
  get inflation(): number { return this.record.tuning.inflation; }
  set inflation(value: number) { this.record.tuning.inflation = Math.max(0.2, value); }
  /** 0..1 water submersion fraction. */
  get submersion(): number { return this.record.submersion; }
  /** Current signed volume (m³). */
  get volume(): number { return this.record.volume; }
  /** Live world center-of-mass estimate (exact on CPU, proxy-tracked on GPU). */
  getCenter(out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.record.center); }
  /** Live linear velocity (m/s). */
  getVelocity(out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.record.velocity); }
  /** Read a specific vertex in world space. */
  vertex(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    const backend = this.system.backend;
    return backend ? backend.readVertex(this.record.vertexOffset + index, out) : out.copy(this.record.center);
  }
  /** Inflate / change internal gas pressure and stop any active leak. */
  inflate(pressure = 2.0, inflation = 1.03): void {
    this.record.tuning.leakRate = 0;
    this.record.tuning.pressure = Math.max(0, pressure);
    this.record.tuning.inflation = Math.max(0.2, inflation);
  }
  /** Puncture the inflatable so gas escapes smoothly over time. */
  puncture(leakRate = 0.85): void {
    this.record.tuning.leakRate = Math.max(0.05, leakRate);
  }
  /** Give the whole soft body a linear velocity impulse (m/s). */
  kick(velocity: THREE.Vector3): void {
    this.system.ensureBuilt();
    this.system.backend!.kick(this.record, velocity);
  }
  /** Apply a localized denting / impact impulse around a world point. */
  impulseAt(point: THREE.Vector3, velocity: THREE.Vector3, radius = 0.8): void {
    this.system.ensureBuilt();
    this.system.backend!.impulseAt(point, velocity, radius, this.record);
  }
  /** Teleport and reset the soft body to a rest pose. */
  reset(position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    this.system.ensureBuilt();
    this.system.backend!.resetBody(this.record, position, quaternion);
  }
}

export interface SoftBodySystemOptions {
  /** Force CPU solver even on WebGPU (exact vertex readback & deterministic gameplay). */
  forceCpu?: boolean;
  /** Optional ocean or water surface for per-vertex buoyancy and flow. */
  ocean?: WaterSurfaceLike | null;
  /** Fallback flat water level (m) when no `ocean` is supplied. */
  waterLevel?: number | null;
  /** Minimum ground height (m). */
  groundY?: number;
  substeps?: number;
  iterations?: number;
  /** Automatically pull nearby Rapier world colliders for pushout & impulse coupling (default true). */
  syncRapierColliders?: boolean;
  /** Distance (m) beyond which soft bodies sleep (default 180). */
  sleepDistance?: number;
}

export class SoftBodySystem implements EngineModule {
  readonly bodies: SoftBody[] = [];
  /** Manual sphere colliders (merged with synced Rapier sphere colliders each frame). */
  readonly colliders: SoftBodySphereCollider[] = [];
  /** Manual box colliders (merged with synced Rapier cuboid colliders each frame). */
  readonly boxColliders: SoftBodyBoxCollider[] = [];
  /** Water surface for buoyancy (`Ocean` or custom `WaterSurfaceLike`). */
  water: WaterSurfaceLike | null = null;
  /** Flat water level fallback when `water` is null. */
  waterLevel: number | null = null;
  groundY = -1e5;
  /** Automatically sync Rapier world colliders (cuboids, balls, capsules) every frame. */
  syncRapierColliders: boolean;
  /** Distance (m) beyond which offscreen/distant bodies pause simulation. */
  sleepDistance: number;
  backend: SoftBodyBackend | null = null;
  /** Total impact events recorded (QA / telemetry). */
  impacts = 0;
  /** Total water splash events recorded (QA / telemetry). */
  splashes = 0;
  /** Optional callback fired on energetic impacts. */
  onImpact: ((body: SoftBody, event: SoftBodyImpactEvent) => void) | null = null;
  /** Optional callback fired when a soft body slams into water. */
  onSplash: ((body: SoftBody, point: THREE.Vector3, speed: number) => void) | null = null;

  private context: SoftBodyContext;
  private activeSpheres: SoftBodySphereCollider[] = [];
  private activeBoxes: SoftBodyBoxCollider[] = [];
  private spherePool: SoftBodySphereCollider[] = Array.from({ length: MAX_SB_SPHERES }, () => ({
    center: new THREE.Vector3(), radius: 0, velocity: new THREE.Vector3(), rapierBody: undefined, invMass: 0,
  }));
  private boxPool: SoftBodyBoxCollider[] = Array.from({ length: MAX_SB_BOXES }, () => ({
    center: new THREE.Vector3(), halfExtents: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), margin: 0.025, rapierBody: undefined, invMass: 0,
  }));
  private seenHandles = new Set<number>();
  private dirty = true;
  private lodDistanceScale: number;
  private forceCpu: boolean;
  private offBlast: (() => void) | null = null;
  private coupledBodies = new Set<RigidBody>();

  constructor(private engine: LuminaEngine, options: SoftBodySystemOptions = {}) {
    this.lodDistanceScale = engine.quality.preset.renderScale;
    this.forceCpu = options.forceCpu ?? false;
    this.water = options.ocean ?? null;
    this.waterLevel = options.waterLevel ?? null;
    this.groundY = options.groundY ?? -1e5;
    this.syncRapierColliders = options.syncRapierColliders ?? true;
    this.sleepDistance = options.sleepDistance ?? 180;
    const cpu = engine.backend !== 'webgpu' || this.forceCpu;

    this.context = {
      bodies: [],
      spheres: this.activeSpheres,
      boxes: this.activeBoxes,
      groundY: this.groundY,
      water: this.water,
      waterLevel: this.waterLevel,
      substeps: options.substeps ?? (cpu ? 2 : 3),
      iterations: options.iterations ?? (cpu ? 5 : 7),
      onImpact: (ev) => {
        this.impacts++;
        const b = this.bodies[ev.bodyId];
        this.engine.events?.emit('impact', {
          position: [ev.point.x, ev.point.y, ev.point.z],
          intensity: Math.min(1, ev.speed / 12),
          kind: 'softbody',
        });
        if (b) this.onImpact?.(b, ev);
      },
      onSplash: (bodyId, point, speed) => {
        this.splashes++;
        const b = this.bodies[bodyId];
        this.engine.events?.emit('splash', {
          position: [point.x, point.y, point.z],
          intensity: Math.min(1, speed / 10),
          kind: 'softbody',
        });
        if (b) this.onSplash?.(b, point, speed);
      },
    };

    // React automatically to engine blasts / explosions / sonic booms!
    if (engine.physics) {
      this.offBlast = engine.physics.onBlast((center, radius, impulse) => {
        if (!this.backend) return;
        for (const body of this.bodies) {
          if (!body.enabled) continue;
          _v.subVectors(body.record.center, center);
          const dist = _v.length();
          if (dist > radius + body.record.restRadius) continue;
          const fall = (1 - Math.min(1, dist / Math.max(radius, 0.5))) ** 2;
          _v.multiplyScalar(1 / Math.max(dist, 0.25));
          _v.y += 0.35;
          _v.normalize();
          const speed = Math.min(35, (impulse * fall) / Math.max(body.record.tuning.mass * 12, 10));
          _v.multiplyScalar(speed);
          this.backend.impulseAt(center, _v, radius, body.record);
          this.backend.kick(body.record, _v2.copy(_v).multiplyScalar(0.6));
        }
      });
    }
  }

  /** Attach an Ocean or custom water height provider for soft-body buoyancy. */
  setWater(water: WaterSurfaceLike | null): void {
    this.water = water;
    this.context.water = water;
  }

  /** Add a manual sphere collider (returns the object so callers can update its position/velocity). */
  addSphereCollider(center: THREE.Vector3, radius: number, velocity?: THREE.Vector3): SoftBodySphereCollider {
    const col: SoftBodySphereCollider = { center: center.clone(), radius, velocity: velocity?.clone() };
    this.colliders.push(col);
    return col;
  }

  /** Add a manual oriented/axis-aligned box collider. */
  addBoxCollider(center: THREE.Vector3, halfExtents: THREE.Vector3, quaternion?: THREE.Quaternion, velocity?: THREE.Vector3): SoftBodyBoxCollider {
    const col: SoftBodyBoxCollider = {
      center: center.clone(),
      halfExtents: halfExtents.clone(),
      quaternion: quaternion?.clone(),
      velocity: velocity?.clone(),
    };
    this.boxColliders.push(col);
    return col;
  }

  /** Explicitly prioritize a Rapier rigid body for collider & impact coupling. */
  coupleRapierBody(body: RigidBody): () => void {
    this.coupledBodies.add(body);
    return () => this.coupledBodies.delete(body);
  }

  /** Add a soft body from a raw spec. */
  add(spec: SoftBodySpec, look: SoftBodyLook = {}): SoftBody {
    if (this.bodies.length >= MAX_SOFT_BODIES) throw new Error(`SoftBodySystem supports ${MAX_SOFT_BODIES} bodies`);
    const tuning: SoftBodyTuning = { ...DEFAULT_SOFTBODY_TUNING };
    for (const key of Object.keys(DEFAULT_SOFTBODY_TUNING) as Array<keyof SoftBodyTuning>) {
      if (spec[key] !== undefined) tuning[key] = spec[key]!;
    }
    const record: SoftBodyRecord = {
      id: this.bodies.length,
      spec,
      tuning,
      vertexOffset: 0,
      vertexCount: spec.topology.positions.length / 3,
      triOffset: 0,
      triCount: spec.topology.triangles.length / 3,
      restVolume: spec.topology.restVolume,
      restRadius: spec.topology.restRadius,
      restArea: spec.topology.restArea,
      enabled: true,
      activeThisFrame: true,
      center: spec.position?.clone() ?? new THREE.Vector3(),
      velocity: spec.velocity?.clone() ?? new THREE.Vector3(),
      volume: spec.topology.restVolume,
      submersion: 0,
      waterPlane: new THREE.Vector4(0, -1e6, 0, tuning.waterDrag),
      waterFlow: new THREE.Vector4(0, 0, 0, 0),
      proxyBody: null,
    };
    const body = new SoftBody(this, record, look);
    this.bodies.push(body);
    this.dirty = true;
    return body;
  }

  /** Inflatable sphere / beach ball. */
  ball(options: BallOptions = {}): SoftBody {
    const cpu = this.engine.backend !== 'webgpu' || this.forceCpu;
    const b = ballSpec(options, cpu);
    return this.add(b.spec, b.look);
  }
  /** Alias for `ball()`. */
  sphere(options: BallOptions = {}): SoftBody { return this.ball(options); }
  /** Inflatable box / air cushion / mattress. */
  cushion(options: CushionOptions = {}): SoftBody {
    const cpu = this.engine.backend !== 'webgpu' || this.forceCpu;
    const b = cushionSpec(options, cpu);
    return this.add(b.spec, b.look);
  }
  /** Alias for `cushion()`. */
  box(options: CushionOptions = {}): SoftBody { return this.cushion(options); }
  /** Marine inflatable buoy / dock fender. */
  buoy(options: BuoyOptions = {}): SoftBody {
    const cpu = this.engine.backend !== 'webgpu' || this.forceCpu;
    const b = buoySpec(options, cpu);
    return this.add(b.spec, b.look);
  }
  /** Inflatable life ring / inner tube. */
  torus(options: TorusOptions = {}): SoftBody {
    const cpu = this.engine.backend !== 'webgpu' || this.forceCpu;
    const b = torusSpec(options, cpu);
    return this.add(b.spec, b.look);
  }
  /** Build an inflatable soft body from any closed BufferGeometry. */
  custom(geometry: THREE.BufferGeometry, options: CustomSoftBodyOptions = {}): SoftBody {
    const b = customSoftBodySpec(geometry, options);
    return this.add(b.spec, b.look);
  }

  get vertexCount(): number { return this.bodies.reduce((n, b) => n + b.record.vertexCount, 0); }

  /** @internal */
  ensureBuilt(): void { if (this.dirty || !this.backend) this.build(); }

  private build(): void {
    this.disposeResources();
    this.context.bodies = this.bodies.map((b) => b.record);
    const gpu = this.engine.backend === 'webgpu' && !this.forceCpu;
    this.backend = gpu
      ? new GpuSoftBodySolver(this.engine.renderer, this.context, this.engine.wind)
      : new CpuSoftBodySolver(this.context, this.engine.wind);

    for (const body of this.bodies) {
      body.mesh = this.createMesh(body);
      body.mesh.visible = body.record.enabled;
      this.engine.scene.add(body.mesh);
    }
    this.dirty = false;
  }

  private createMesh(body: SoftBody): THREE.Mesh {
    const backend = this.backend!;
    const { topology } = body.record.spec;
    const vCount = body.record.vertexCount;
    const base = body.record.vertexOffset;

    const vertIndices = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) vertIndices[i] = base + i;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(topology.positions), 3));
    geometry.setAttribute('localPos', new THREE.BufferAttribute(new Float32Array(topology.positions), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(topology.uvs), 2));
    geometry.setAttribute('sbVertex', new THREE.BufferAttribute(vertIndices, 1));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(topology.triangles), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const look = body.look;
    const material = new THREE.MeshStandardNodeMaterial();
    material.roughness = look.roughness ?? 0.3;
    material.metalness = 0.04;

    const vIdx = attribute('sbVertex', 'float');
    const worldPos = backend.vertex(vIdx);
    const worldPrev = backend.previous(vIdx);
    const worldNormal = normalize(backend.normal(vIdx).add(vec3(0, 1e-6, 0)));

    material.positionNode = worldPos;
    const vNormal = worldNormal.toVarying('sbNormal');
    const vWorld = worldPos.toVarying('sbWorld');
    const vPrev = worldPrev.toVarying('sbPrev');
    const vLocal = attribute('localPos', 'vec3').toVarying('sbLocal');

    const nrm = normalize(vNormal);
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(nrm, 0)).xyz);
    const colors = (look.colors ?? [0xe63946, 0xf4f1de, 0x1d6fb8]).map((c) => new THREE.Color(c));
    const albedo = softBodyPatternNode(look.pattern ?? 'solid', uv(), vLocal, colors);
    material.colorNode = albedo;

    // Subtle back-lit vinyl translucency when sunlight shines through the inflated shell.
    const through = max(dot(nrm.negate(), frame.sunDirection), 0);
    material.emissiveNode = albedo.mul(frame.sunColor).mul(frame.sunVisibility).mul(through).mul((look.translucency ?? 0.25) / Math.PI);
    material.mrtNode = auxSurface(material.normalNode, screenVelocity(vWorld, vPrev));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'lumina-softbody';
    return mesh;
  }

  /** Pull manual + Rapier colliders near active soft bodies into the solver buffers. */
  private syncColliders(): void {
    const spheres = this.activeSpheres;
    const boxes = this.activeBoxes;
    spheres.length = 0;
    boxes.length = 0;

    for (const s of this.colliders) if (spheres.length < MAX_SB_SPHERES) spheres.push(s);
    for (const b of this.boxColliders) if (boxes.length < MAX_SB_BOXES) boxes.push(b);

    const physics = this.engine.physics;
    if (!this.syncRapierColliders || !physics || this.bodies.length === 0) return;

    const R = physics.RAPIER;
    let poolS = 0;
    let poolB = 0;
    const pushCollider = (col: import('@dimforge/rapier3d-compat').Collider, rb: RigidBody | null) => {
      if (col.isSensor()) return;
      const t = col.translation();
      const r = col.rotation();
      const st = col.shapeType();
      // Filter out colliders far from every soft body so we never waste slots on distant world geometry.
      let near = false;
      const maxCheckDist = 18;
      for (const sb of this.bodies) {
        if (!sb.enabled) continue;
        const dx = sb.record.center.x - t.x, dy = sb.record.center.y - t.y, dz = sb.record.center.z - t.z;
        if (dx * dx + dy * dy + dz * dz < (maxCheckDist + sb.record.restRadius) ** 2) { near = true; break; }
      }
      if (!near) return;

      const lv = rb ? rb.linvel() : null;
      const vx = lv ? lv.x : 0, vy = lv ? lv.y : 0, vz = lv ? lv.z : 0;
      const invMass = rb && rb.isDynamic() ? rb.invMass() : 0;

      if (st === R.ShapeType.Ball && spheres.length < MAX_SB_SPHERES && poolS < this.spherePool.length) {
        const slot = this.spherePool[poolS++];
        slot.center.set(t.x, t.y, t.z);
        slot.radius = col.radius();
        slot.velocity!.set(vx, vy, vz);
        slot.rapierBody = rb ?? undefined;
        slot.invMass = invMass;
        spheres.push(slot);
      } else if (st === R.ShapeType.Cuboid && boxes.length < MAX_SB_BOXES && poolB < this.boxPool.length) {
        const he = col.halfExtents();
        if (!he) return;
        const slot = this.boxPool[poolB++];
        slot.center.set(t.x, t.y, t.z);
        slot.halfExtents.set(he.x, he.y, he.z);
        slot.quaternion!.set(r.x, r.y, r.z, r.w);
        slot.velocity!.set(vx, vy, vz);
        slot.margin = 0.025;
        slot.rapierBody = rb ?? undefined;
        slot.invMass = invMass;
        boxes.push(slot);
      } else if ((st === R.ShapeType.Capsule || st === R.ShapeType.Cylinder) && boxes.length < MAX_SB_BOXES && poolB < this.boxPool.length) {
        const rad = col.radius();
        const hh = col.halfHeight() + (st === R.ShapeType.Capsule ? rad : 0);
        const slot = this.boxPool[poolB++];
        slot.center.set(t.x, t.y, t.z);
        slot.halfExtents.set(rad, hh, rad);
        slot.quaternion!.set(r.x, r.y, r.z, r.w);
        slot.velocity!.set(vx, vy, vz);
        slot.margin = 0.02;
        slot.rapierBody = rb ?? undefined;
        slot.invMass = invMass;
        boxes.push(slot);
      }
    };

    // Prioritize explicitly coupled bodies first, then scan remaining Rapier world colliders.
    const seen = this.seenHandles;
    seen.clear();
    for (const rb of this.coupledBodies) {
      if (!physics.world.getRigidBody(rb.handle)) continue;
      for (let i = 0; i < rb.numColliders(); i++) {
        const col = rb.collider(i);
        seen.add(col.handle);
        pushCollider(col, rb);
      }
    }
    physics.world.forEachCollider((col) => {
      if (seen.has(col.handle)) return;
      if (spheres.length >= MAX_SB_SPHERES && boxes.length >= MAX_SB_BOXES) return;
      pushCollider(col, col.parent());
    });
  }

  private updateLod(): void {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const body of this.bodies) {
      const rec = body.record;
      if (!rec.enabled) { rec.activeThisFrame = false; continue; }
      _sphere.center.copy(rec.center);
      _sphere.radius = rec.restRadius * 2 + 1.5;
      const dist = rec.center.distanceTo(cam.position);
      rec.activeThisFrame = dist <= this.sleepDistance * this.lodDistanceScale || _frustum.intersectsSphere(_sphere);
    }
  }

  setQuality(preset: QualityPreset = this.engine.quality.preset): void { this.lodDistanceScale = preset.renderScale; }

  update(dt: number, time: number): void {
    if (this.dirty) this.build();
    this.context.groundY = this.groundY;
    this.context.water = this.water;
    this.context.waterLevel = this.waterLevel;
    this.syncColliders();
    this.updateLod();
    this.backend!.step(dt, time);
  }

  private disposeResources(): void {
    for (const body of this.bodies) {
      if (!body.mesh) continue;
      body.mesh.removeFromParent();
      body.mesh.geometry.dispose();
      (body.mesh.material as THREE.Material).dispose();
      body.mesh = null;
    }
    this.backend?.dispose();
    this.backend = null;
  }

  dispose(): void {
    this.offBlast?.();
    this.offBlast = null;
    this.coupledBodies.clear();
    this.disposeResources();
  }
}

export { _q };
