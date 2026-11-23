/**
 * Instanced Verlet strand system for grass, kelp, and hair with Kajiya–Kay shading.
 *
 *   const strands = engine.add(new StrandSystem(engine));
 *   strands.grass({ center: new THREE.Vector3(0, 0, 20), size: [18, 14], count: 3200 });
 *   strands.kelp({ center: new THREE.Vector3(10, -4, -18), count: 400, heightAt: bayFloor });
 *   strands.hair({ follow: headMesh, count: 900 });
 *   strands.addVehicle(car.root, new THREE.Vector3(1.0, 0.7, 2.3));
 *
 * Runs on WebGPU compute (`gpu.ts`) with an automatic CPU fallback (`cpu.ts`) on WebGL 2
 * or when `forceCpu` is set. Reacts to the unified wind field, explosions/blasts,
 * rotor/jet downwash sources, and vehicle / collider interactors.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import { CpuStrandSolver } from './cpu';
import { GpuStrandSolver } from './gpu';
import { createKajiyaKayMaterial } from './kajiya-kay';
import { grassSpec, hairSpec, kelpSpec, type GrassOptions, type HairOptions, type KelpOptions } from './presets';
import {
  DEFAULT_STRAND_TUNING,
  MAX_STRAND_BLASTS,
  MAX_STRAND_FIELDS,
  type DownwashSource,
  type StrandBackend,
  type StrandBlast,
  type StrandContext,
  type StrandFieldRecord,
  type StrandFieldSpec,
  type StrandInteractor,
  type StrandTuning,
} from './types';

const {
  attribute, instanceIndex, float, int, vec3, normalize, cross, mix, sin, cos, pow, max, cameraPosition,
} = TSL;

const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _tmpOffset = new THREE.Vector3();

interface TrackedVehicle {
  object: THREE.Object3D;
  interactor: StrandInteractor;
  offset: THREE.Vector3;
  prevPos: THREE.Vector3;
  initialized: boolean;
}

export class StrandField {
  mesh: THREE.Mesh | null = null;
  follow: THREE.Object3D | null = null;

  constructor(readonly system: StrandSystem, readonly record: StrandFieldRecord) {
    this.follow = record.spec.follow ?? null;
  }

  get kind() { return this.record.spec.kind; }
  get tuning(): StrandTuning { return this.record.tuning; }
  get matrix(): THREE.Matrix4 { return this.record.matrix; }
  get strandCount(): number { return this.record.strandCount; }
  get enabled(): boolean { return this.record.enabled; }
  set enabled(value: boolean) { this.record.enabled = value; if (this.mesh) this.mesh.visible = value; }

  /** Read a strand node position in world space (exact on CPU; initial pose on GPU). */
  nodePosition(strandIndex: number, nodeIndex: number, out = new THREE.Vector3()): THREE.Vector3 {
    const backend = this.system.backend;
    const gi = this.record.nodeOffset + strandIndex * this.record.nodesPerStrand + nodeIndex;
    return backend ? backend.readNode(gi, out) : out.set(0, 0, 0);
  }
}

export interface StrandSystemOptions {
  /** Force the CPU Verlet solver even on WebGPU (for deterministic reads / WebGL testing). */
  forceCpu?: boolean;
  /** Density multiplier applied to presets (default 1 on GPU, 0.35 on CPU). */
  detail?: number;
  substeps?: number;
  /** Ground height clamp (m). */
  groundY?: number;
  /** Water surface level (m) for kelp buoyancy clamp (default 0). */
  waterLevel?: number;
  /** Distance (m) beyond which offscreen/far fields sleep (default 160). */
  sleepDistance?: number;
  /** Distance (m) beyond which fields step at reduced stride (default 60). */
  reducedDistance?: number;
}

export class StrandSystem implements EngineModule {
  readonly fields: StrandField[] = [];
  /** Active rotor/jet downwash sources affecting all strands. */
  readonly downwash: DownwashSource[] = [];
  /** Active sphere & oriented-box interactors (vehicles, characters, props). */
  readonly interactors: StrandInteractor[] = [];
  /** Global underwater current vector (m/s) applied to kelp fields. */
  readonly waterCurrent = new THREE.Vector3(0.45, 0, 0.25);
  waterLevel: number;
  groundY: number;
  sleepDistance: number;
  reducedDistance: number;
  backend: StrandBackend | null = null;
  readonly detail: number;

  private blasts: StrandBlast[] = [];
  private trackedVehicles: TrackedVehicle[] = [];
  private context: StrandContext;
  private dirty = true;
  private lodDistanceScale: number;
  private forceCpu: boolean;
  private frameCounter = 0;
  private offBlast: (() => void) | null = null;

  constructor(private engine: LuminaEngine, options: StrandSystemOptions = {}) {
    this.lodDistanceScale = engine.quality.preset.renderScale;
    this.forceCpu = options.forceCpu ?? false;
    const cpu = engine.backend !== 'webgpu' || this.forceCpu;
    this.detail = options.detail ?? (cpu ? 0.35 : 1);
    this.groundY = options.groundY ?? -1e5;
    this.waterLevel = options.waterLevel ?? 0;
    this.sleepDistance = options.sleepDistance ?? 160;
    this.reducedDistance = options.reducedDistance ?? 60;

    this.context = {
      fields: [],
      downwash: this.downwash,
      interactors: this.interactors,
      blasts: this.blasts,
      waterCurrent: this.waterCurrent,
      waterLevel: this.waterLevel,
      groundY: this.groundY,
      substeps: options.substeps ?? (cpu ? 1 : 2),
    };

    // Automatically react to Rapier / explosion blasts across the engine!
    if (engine.physics) {
      this.offBlast = engine.physics.onBlast((center, radius, impulse) => {
        const strength = Math.min(80, Math.max(12, impulse * 0.025));
        this.addBlast(center, strength, Math.max(radius, 4), 1.15);
      });
    }
  }

  /** Add a strand field from a raw spec. */
  add(spec: StrandFieldSpec): StrandField {
    if (this.fields.length >= MAX_STRAND_FIELDS) throw new Error(`StrandSystem supports ${MAX_STRAND_FIELDS} fields`);
    const base = DEFAULT_STRAND_TUNING[spec.kind];
    const tuning: StrandTuning = { ...base };
    for (const key of Object.keys(base) as Array<keyof StrandTuning>) {
      if (spec[key] !== undefined) tuning[key] = spec[key]!;
    }
    const record: StrandFieldRecord = {
      id: this.fields.length,
      spec,
      tuning,
      strandOffset: 0,
      strandCount: spec.strandCount,
      nodeOffset: 0,
      nodesPerStrand: spec.segments + 1,
      nodeCount: spec.strandCount * (spec.segments + 1),
      matrix: spec.matrix?.clone() ?? new THREE.Matrix4(),
      boundsCenter: new THREE.Vector3(),
      boundsRadius: 5,
      enabled: true,
      activeThisFrame: true,
      lodStride: 1,
    };
    const field = new StrandField(this, record);
    if (field.follow) {
      field.follow.updateWorldMatrix(true, false);
      record.matrix.copy(field.follow.matrixWorld);
    }
    this.fields.push(field);
    this.dirty = true;
    return field;
  }

  /** Create an instanced Verlet grass patch with Kajiya–Kay shading. */
  grass(options: GrassOptions = {}): StrandField { return this.add(grassSpec(options, this.detail)); }
  /** Create an underwater buoyant kelp forest field with Kajiya–Kay shading. */
  kelp(options: KelpOptions = {}): StrandField { return this.add(kelpSpec({ waterLevel: this.waterLevel, ...options }, this.detail)); }
  /** Create an instanced Verlet hair tuft / scalp with dual-lobe Kajiya–Kay shading. */
  hair(options: HairOptions = {}): StrandField { return this.add(hairSpec(options, this.detail)); }

  /** Inject a transient radial blast wave into all strands (grass, kelp, hair). */
  addBlast(position: THREE.Vector3, strength: number, radius: number, duration = 1.1): void {
    if (this.blasts.length >= MAX_STRAND_BLASTS) this.blasts.shift();
    this.blasts.push({ position: position.clone(), radius, strength, age: 0, duration });
  }

  /** Register a persistent downwash source (rotor hub or low-flying jet). Returns handle for live updates. */
  addDownwash(source: DownwashSource): DownwashSource {
    const entry: DownwashSource = {
      position: source.position.clone(),
      direction: source.direction?.clone(),
      radius: source.radius,
      strength: source.strength,
      swirl: source.swirl ?? 0.35,
    };
    this.downwash.push(entry);
    return entry;
  }

  /** Remove a previously registered downwash source. */
  removeDownwash(source: DownwashSource): void {
    const idx = this.downwash.indexOf(source);
    if (idx >= 0) this.downwash.splice(idx, 1);
  }

  /** Register a manual sphere or oriented-box interactor. */
  addInteractor(interactor: StrandInteractor): StrandInteractor {
    const entry: StrandInteractor = {
      position: interactor.position.clone(),
      velocity: interactor.velocity?.clone() ?? new THREE.Vector3(),
      radius: interactor.radius,
      halfExtents: interactor.halfExtents?.clone(),
      quaternion: interactor.quaternion?.clone(),
      strength: interactor.strength ?? 1,
    };
    this.interactors.push(entry);
    return entry;
  }

  /**
   * Automatically track a moving vehicle or character `Object3D` so its chassis parts and
   * flattens grass, kelp, and hair with realistic velocity wake. Returns an unregister callback.
   */
  addVehicle(
    object: THREE.Object3D,
    halfExtents = new THREE.Vector3(1.0, 0.7, 2.2),
    options: { offset?: THREE.Vector3; strength?: number } = {},
  ): () => void {
    const interactor = this.addInteractor({
      position: object.position.clone(),
      velocity: new THREE.Vector3(),
      radius: halfExtents.length(),
      halfExtents: halfExtents.clone(),
      quaternion: object.quaternion.clone(),
      strength: options.strength ?? 1.15,
    });
    const tracked: TrackedVehicle = {
      object,
      interactor,
      offset: options.offset?.clone() ?? new THREE.Vector3(0, halfExtents.y * 0.5, 0),
      prevPos: new THREE.Vector3(),
      initialized: false,
    };
    this.trackedVehicles.push(tracked);
    return () => {
      const ti = this.trackedVehicles.indexOf(tracked);
      if (ti >= 0) this.trackedVehicles.splice(ti, 1);
      const ii = this.interactors.indexOf(interactor);
      if (ii >= 0) this.interactors.splice(ii, 1);
    };
  }

  get strandCount(): number { return this.fields.reduce((n, f) => n + f.record.strandCount, 0); }
  get nodeCount(): number { return this.fields.reduce((n, f) => n + f.record.nodeCount, 0); }

  /** @internal */
  ensureBuilt(): void { if (this.dirty || !this.backend) this.build(); }

  private build(): void {
    this.disposeResources();
    this.context.fields = this.fields.map((f) => f.record);
    const gpu = this.engine.backend === 'webgpu' && !this.forceCpu;
    this.backend = gpu
      ? new GpuStrandSolver(this.engine.renderer, this.context, this.engine.wind)
      : new CpuStrandSolver(this.context, this.engine.wind);

    for (const field of this.fields) {
      field.mesh = this.createFieldMesh(field);
      field.mesh.visible = field.record.enabled;
      this.engine.scene.add(field.mesh);
    }
    this.dirty = false;
  }

  /**
   * Build one instanced ribbon mesh for an entire strand field (1 draw call for thousands of
   * grass blades, kelp fronds, or hair strands) shaded with Kajiya–Kay anisotropic lighting.
   */
  private createFieldMesh(field: StrandField): THREE.Mesh {
    const backend = this.backend!;
    const rec = field.record;
    const nps = rec.nodesPerStrand;
    const segs = nps - 1;
    const vCount = nps * 2;

    const positions = new Float32Array(vCount * 3);
    const segAttr = new Float32Array(vCount);
    const sideAttr = new Float32Array(vCount);
    const tAttr = new Float32Array(vCount);
    const indices: number[] = [];

    for (let k = 0; k < nps; k++) {
      const t = k / segs;
      for (let s = 0; s < 2; s++) {
        const vi = k * 2 + s;
        segAttr[vi] = k;
        sideAttr[vi] = s === 0 ? -1 : 1;
        tAttr[vi] = t;
      }
      if (k < segs) {
        const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.instanceCount = rec.strandCount;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeg', new THREE.BufferAttribute(segAttr, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sideAttr, 1));
    geometry.setAttribute('aT', new THREE.BufferAttribute(tAttr, 1));
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const sGlobal = int(rec.strandOffset).add(int(instanceIndex));
    const kNode = int(attribute('aSeg', 'float'));
    const side = attribute('aSide', 'float');
    const t = attribute('aT', 'float');

    const nodeBase = int(rec.nodeOffset).add(int(instanceIndex).mul(nps));
    const idxCur = nodeBase.add(kNode);
    const idxPrev = nodeBase.add(max(kNode.sub(int(1)), int(0)));
    const idxNext = nodeBase.add(kNode.add(int(1)).min(int(segs)));

    const center = backend.node(idxCur);
    const prevCenter = backend.previousNode(idxCur);
    const tangent = normalize(backend.node(idxNext).sub(backend.node(idxPrev)).add(vec3(0, 1e-5, 0)));

    const m4 = backend.strandMeta(sGlobal);
    const d4 = backend.strandDir(sGlobal);
    const seed = m4.x;
    const tint = m4.w;
    const baseHalfW = d4.w;

    // Shape-specific width profile along the strand.
    let widthProfile: N;
    if (rec.spec.kind === 'grass') {
      widthProfile = float(1).sub(pow(t, float(1.35)).mul(0.88));
    } else if (rec.spec.kind === 'kelp') {
      const leaf = sin(t.mul(Math.PI)).mul(0.55).add(0.45);
      const ruffle = sin(t.mul(14).add(seed.mul(6.2831))).mul(0.28).add(1);
      widthProfile = leaf.mul(ruffle);
    } else {
      widthProfile = float(1).sub(t.mul(0.68));
    }
    const halfWidth = baseHalfW.mul(widthProfile);

    // Blend camera-facing ribbon billboarding with per-strand organic twist angle.
    const toCam = normalize(cameraPosition.sub(center).add(vec3(0, 1e-5, 0)));
    const camSide = normalize(cross(tangent, toCam).add(vec3(1e-5, 0, 0)));
    const twistAng = seed.mul(Math.PI * 2);
    const twistRef = vec3(cos(twistAng), 0, sin(twistAng));
    const twistSide = normalize(cross(tangent, twistRef).add(vec3(1e-5, 0, 0)));
    const billboard = float(rec.spec.look.billboard ?? (rec.spec.kind === 'hair' ? 0.92 : 0.6));
    const sideways = normalize(mix(twistSide, camSide, billboard).add(vec3(1e-5, 0, 0)));

    // Curved ribbon cross-section normal so blades and fibers catch smooth grazing highlights.
    const faceNormal = normalize(cross(sideways, tangent).add(vec3(0, 1e-5, 0)));
    const curvedNormal = normalize(faceNormal.add(sideways.mul(side).mul(0.45)));

    const worldPos = center.add(sideways.mul(side).mul(halfWidth));
    const prevWorldPos = prevCenter.add(sideways.mul(side).mul(halfWidth));

    const material = createKajiyaKayMaterial({
      worldPos,
      previousWorldPos: prevWorldPos,
      tangent,
      normal: curvedNormal,
      strandT: t,
      side,
      tint,
      seed,
      kind: rec.spec.kind,
      look: rec.spec.look,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = rec.spec.kind !== 'kelp';
    mesh.receiveShadow = true;
    mesh.name = `lumina-strands-${rec.spec.kind}`;
    return mesh;
  }

  private updateTrackedVehicles(dt: number): void {
    const invDt = dt > 1e-4 ? 1 / dt : 0;
    for (const tv of this.trackedVehicles) {
      tv.object.updateWorldMatrix(true, false);
      tv.object.matrixWorld.decompose(_pos, _quat, _sphere.center);
      _tmpOffset.copy(tv.offset).applyQuaternion(_quat);
      _pos.add(_tmpOffset);
      if (tv.initialized && invDt > 0) {
        tv.interactor.velocity!.subVectors(_pos, tv.prevPos).multiplyScalar(invDt);
      } else {
        tv.interactor.velocity!.set(0, 0, 0);
        tv.initialized = true;
      }
      tv.prevPos.copy(_pos);
      tv.interactor.position.copy(_pos);
      tv.interactor.quaternion!.copy(_quat);
    }
  }

  private updateLod(): void {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    this.frameCounter++;

    for (let i = 0; i < this.fields.length; i++) {
      const f = this.fields[i];
      const rec = f.record;
      if (!rec.enabled) { rec.activeThisFrame = false; continue; }
      _sphere.center.copy(rec.boundsCenter).applyMatrix4(rec.matrix);
      _sphere.radius = rec.boundsRadius + 3;
      const dist = Math.max(0, _sphere.center.distanceTo(cam.position) - rec.boundsRadius);
      const inFrustum = _frustum.intersectsSphere(_sphere);
      if (dist > this.sleepDistance * this.lodDistanceScale && !f.follow) {
        rec.activeThisFrame = false;
        rec.lodStride = 0;
      } else if (!inFrustum) {
        rec.lodStride = 3;
        rec.activeThisFrame = (this.frameCounter + i) % 3 === 0;
      } else if (dist > this.reducedDistance * this.lodDistanceScale) {
        rec.lodStride = 2;
        rec.activeThisFrame = (this.frameCounter + i) % 2 === 0;
      } else {
        rec.lodStride = 1;
        rec.activeThisFrame = true;
      }
    }
  }

  setQuality(preset: QualityPreset = this.engine.quality.preset): void { this.lodDistanceScale = preset.renderScale; }

  update(dt: number, time: number): void {
    if (this.dirty) this.build();
    this.context.groundY = this.groundY;
    this.context.waterLevel = this.waterLevel;

    // Age transient blasts in place.
    let alive = 0;
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i];
      if ((b.age += dt) < b.duration) this.blasts[alive++] = b;
    }
    this.blasts.length = alive;

    for (const field of this.fields) {
      if (field.follow) {
        field.follow.updateWorldMatrix(true, false);
        field.record.matrix.copy(field.follow.matrixWorld);
      }
    }
    this.updateTrackedVehicles(dt);
    this.updateLod();
    this.backend!.step(dt, time);
  }

  private disposeResources(): void {
    for (const field of this.fields) {
      if (!field.mesh) continue;
      field.mesh.removeFromParent();
      field.mesh.geometry.dispose();
      (field.mesh.material as THREE.Material).dispose();
      field.mesh = null;
    }
    this.backend?.dispose();
    this.backend = null;
  }

  dispose(): void {
    this.offBlast?.();
    this.offBlast = null;
    this.trackedVehicles.length = 0;
    this.disposeResources();
  }
}
