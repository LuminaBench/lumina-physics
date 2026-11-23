/**
 * Rapier world wrapper: fixed-step integration, mesh binding, radial blast impulses and
 * a pooled instanced debris system shared by every explosion archetype.
 */
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { FieldReading, type WorldBus } from './world-bus';

export type RapierModule = typeof RAPIER;
export type RigidBody = RAPIER.RigidBody;

let _rapierReady: Promise<void> | null = null;

/** Initialise the Rapier WASM module once. */
export function initRapier(): Promise<void> {
  if (!_rapierReady) _rapierReady = RAPIER.init();
  return _rapierReady;
}

type PreStep = (dt: number) => void;
/** `kind` is whatever the blast's author passed (the explosions module passes its archetype). */
export type BlastListener = (center: THREE.Vector3, radius: number, impulse: number, kind: string) => void;
/** The contact exposes Rapier's direction and is valid only during this callback. */
export type ContactForceListener = (
  force: number, other: RAPIER.Collider | null, contact: RAPIER.TempContactForceEvent
) => void;

// Rapier's target API reads/writes x/y/z/w. These accessors keep each numeric
// component unboxed, including when WASM passes a different rotation every step.
export class RapierScratch extends Float64Array {
  constructor() { super(4); }
  get x(): number { return this[0]; } set x(value: number) { this[0] = value; }
  get y(): number { return this[1]; } set y(value: number) { this[1] = value; }
  get z(): number { return this[2]; } set z(value: number) { this[2] = value; }
  get w(): number { return this[3]; } set w(value: number) { this[3] = value; }
}

const _v = new THREE.Vector3();
const _t = new RapierScratch();
const _r = new RapierScratch();
const _lv = new RapierScratch();
const _imp = new RapierScratch();
const _trq = new RapierScratch();

interface Binding {
  handle: number;
  body: RAPIER.RigidBody;
  object: THREE.Object3D;
  previousPosition: THREE.Vector3;
  previousRotation: THREE.Quaternion;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  sleeping: boolean;
}

export class PhysicsWorld {
  readonly RAPIER = RAPIER;
  readonly world: RAPIER.World;
  /** Fixed simulation step. Rendering interpolates between the two most recent states. */
  readonly fixedDt = 1 / 60;
  private accumulator = 0;
  private bindingIndex = new Map<number, number>();
  private bindingList: Binding[] = [];
  fields?: WorldBus;
  private readonly airPosition = new THREE.Vector3();
  private readonly airSample = new FieldReading();
  private readonly applyMovingAir = (body: RAPIER.RigidBody): void => {
    if (!body.isDynamic()) return;
    body.translation(this.airPosition);
    const { wind, pressureForce } = this.fields!.disturbance(this.airPosition, this.airSample);
    if (wind.lengthSq() < 0.16 && pressureForce.lengthSq() < 0.001) return;
    const velocity = body.linvel(_t);
    const mass = body.mass();
    if (!(mass > 0)) return;
    const dx = wind.x - velocity.x, dy = wind.y - velocity.y, dz = wind.z - velocity.z;
    // Quadratic drag at large slip speeds, blended into linear drag as the body
    // approaches the local air speed. The implicit fraction stays bounded at every mass.
    const slip = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const scale = Math.cbrt(mass);
    const rate = this.fixedDt * (2.8 + 0.15 * Math.min(70, slip)) / scale;
    const impulseScale = mass * rate / (1 + rate);
    const exposedArea = scale * scale * this.fixedDt;
    _imp.x = dx * impulseScale + pressureForce.x * exposedArea;
    _imp.y = dy * impulseScale + pressureForce.y * exposedArea;
    _imp.z = dz * impulseScale + pressureForce.z * exposedArea;
    body.applyImpulse(_imp, true);
  };
  private preStepList: PreStep[] = [];
  private blastListenerList: BlastListener[] = [];
  private contactListeners = new Map<number, ContactForceListener>();
  private events: RAPIER.EventQueue | null = null;
  /** Interpolation factor (0..1) between the previous and the current physics state. */
  alpha = 0;

  // Scratch fields for hoisted `applyBlast` callback (avoids per-blast closure allocation).
  private blastCx = 0;
  private blastCy = 0;
  private blastCz = 0;
  private blastRadius = 0;
  private blastRadiusSq = 0;
  private blastInvRadius = 0;
  private blastImpulse = 0;
  private blastUpBias = 0;
  private blastAffected = 0;

  private readonly handleContactForce = (event: RAPIER.TempContactForceEvent): void => {
    const a = event.collider1(), b = event.collider2();
    const la = this.contactListeners.get(a);
    const lb = this.contactListeners.get(b);
    if (!la && !lb) return;
    const force = event.totalForceMagnitude();
    if (la) la(force, this.world.getCollider(b) ?? null, event);
    if (lb) lb(force, this.world.getCollider(a) ?? null, event);
  };

  private readonly applyBlastToBody = (body: RAPIER.RigidBody): void => {
    if (!body.isDynamic()) return;
    body.translation(_t);
    const dx = _t.x - this.blastCx, dy = _t.y - this.blastCy, dz = _t.z - this.blastCz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > this.blastRadiusSq) return;
    const dist = Math.sqrt(distSq);
    const fall1 = 1 - dist * this.blastInvRadius;
    const fall = fall1 * fall1;
    const invD = 1 / (dist > 0.25 ? dist : 0.25);
    let vx = dx * invD, vy = dy * invD + this.blastUpBias, vz = dz * invD;
    const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const massScale = Math.cbrt(body.mass()) * 0.6 + 0.2;
    const mag = this.blastImpulse * fall * (massScale < 1 ? massScale : 1) / (vLen > 1e-8 ? vLen : 1);
    _imp.x = vx * mag; _imp.y = vy * mag; _imp.z = vz * mag;
    body.applyImpulse(_imp, true);
    const spin = this.blastImpulse * fall * 0.04;
    _trq.x = (Math.random() - 0.5) * spin;
    _trq.y = (Math.random() - 0.5) * spin;
    _trq.z = (Math.random() - 0.5) * spin;
    body.applyTorqueImpulse(_trq, true);
    this.blastAffected++;
  };

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
  }

  static async create(): Promise<PhysicsWorld> {
    await initRapier();
    return new PhysicsWorld();
  }

  /** Register a callback that runs before every fixed step (forces, vehicle controllers). */
  addPreStep(fn: PreStep): () => void {
    if (!this.preStepList.includes(fn)) this.preStepList.push(fn);
    return () => {
      const idx = this.preStepList.indexOf(fn);
      if (idx !== -1) this.preStepList.splice(idx, 1);
    };
  }

  /** Called for every `applyBlast` (destruction, thermo and cloth react without knowing the source). */
  onBlast(listener: BlastListener): () => void {
    if (!this.blastListenerList.includes(listener)) this.blastListenerList.push(listener);
    return () => {
      const idx = this.blastListenerList.indexOf(listener);
      if (idx !== -1) this.blastListenerList.splice(idx, 1);
    };
  }

  /**
   * Watch a collider for hard contacts: `listener` fires when the total contact force on it
   * exceeds `threshold` newtons (glass hit by debris, a wall rammed by a car).
   */
  onContactForce(collider: RAPIER.Collider, threshold: number, listener: ContactForceListener): () => void {
    if (!this.events) this.events = new RAPIER.EventQueue(true);
    collider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    collider.setContactForceEventThreshold(threshold);
    this.contactListeners.set(collider.handle, listener);
    return () => this.contactListeners.delete(collider.handle);
  }

  /**
   * Drive `object` from `body`. The object receives the *interpolated* transform every
   * frame, so motion stays smooth at any display refresh rate (120 Hz screens render two
   * frames per 60 Hz physics step; without interpolation bodies visibly stutter).
   */
  bind(body: RAPIER.RigidBody, object: THREE.Object3D): void {
    body.translation(_t);
    body.rotation(_r);
    const existing = this.bindingIndex.get(body.handle);
    if (existing !== undefined) {
      const b = this.bindingList[existing];
      b.body = body;
      b.object = object;
      b.position.set(_t.x, _t.y, _t.z);
      b.rotation.set(_r.x, _r.y, _r.z, _r.w);
      b.previousPosition.copy(b.position);
      b.previousRotation.copy(b.rotation);
      b.sleeping = false;
      object.position.copy(b.position);
      object.quaternion.copy(b.rotation);
      return;
    }
    const position = new THREE.Vector3(_t.x, _t.y, _t.z);
    const rotation = new THREE.Quaternion(_r.x, _r.y, _r.z, _r.w);
    const idx = this.bindingList.length;
    this.bindingList.push({
      handle: body.handle, body, object, position, rotation,
      previousPosition: position.clone(), previousRotation: rotation.clone(), sleeping: false,
    });
    this.bindingIndex.set(body.handle, idx);
    object.position.copy(position);
    object.quaternion.copy(rotation);
  }

  unbind(body: RAPIER.RigidBody): void {
    const idx = this.bindingIndex.get(body.handle);
    if (idx === undefined) return;
    this.bindingIndex.delete(body.handle);
    const last = this.bindingList.pop()!;
    if (idx < this.bindingList.length) {
      this.bindingList[idx] = last;
      this.bindingIndex.set(last.handle, idx);
    }
  }

  /** Call after teleporting a bound body so it is not interpolated across the jump. */
  snap(body: RAPIER.RigidBody): void {
    const idx = this.bindingIndex.get(body.handle);
    if (idx === undefined) return;
    const b = this.bindingList[idx];
    body.translation(_t);
    body.rotation(_r);
    b.position.set(_t.x, _t.y, _t.z);
    b.rotation.set(_r.x, _r.y, _r.z, _r.w);
    b.previousPosition.copy(b.position);
    b.previousRotation.copy(b.rotation);
    b.object.position.copy(b.position);
    b.object.quaternion.copy(b.rotation);
    b.sleeping = false;
  }

  removeBody(body: RAPIER.RigidBody): void {
    this.unbind(body);
    if (this.world.getRigidBody(body.handle)) this.world.removeRigidBody(body);
  }

  /**
   * Advance by `dt` seconds of real time (clamp it to ≤ 0.05 s upstream) in fixed 1/60 s
   * steps, then write interpolated transforms to every bound object.
   */
  step(dt: number, maxSubsteps = 3): void {
    const maxAcc = this.fixedDt * maxSubsteps;
    const nextAcc = this.accumulator + dt;
    this.accumulator = nextAcc < maxAcc ? nextAcc : maxAcc;
    const bindings = this.bindingList;
    const preSteps = this.preStepList;

    while (this.accumulator >= this.fixedDt) {
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        if (b.sleeping && b.body.isSleeping()) continue;
        b.previousPosition.copy(b.position);
        b.previousRotation.copy(b.rotation);
      }
      for (let i = 0; i < preSteps.length; i++) preSteps[i](this.fixedDt);
      if (this.fields?.bodyForcing) this.world.forEachRigidBody(this.applyMovingAir);
      if (this.events) {
        this.world.step(this.events);
        this.events.drainContactForceEvents(this.handleContactForce);
      } else this.world.step();
      this.accumulator -= this.fixedDt;
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        const asleep = b.body.isSleeping();
        if (b.sleeping && asleep) continue;
        b.body.translation(_t);
        b.body.rotation(_r);
        b.position.set(_t.x, _t.y, _t.z);
        b.rotation.set(_r.x, _r.y, _r.z, _r.w);
        if (asleep) {
          const pp = b.previousPosition, cp = b.position;
          const pr = b.previousRotation, cr = b.rotation;
          b.sleeping = pp.x === cp.x && pp.y === cp.y && pp.z === cp.z && pr.x === cr.x && pr.y === cr.y && pr.z === cr.z && pr.w === cr.w;
          if (b.sleeping) {
            b.object.position.copy(cp);
            b.object.quaternion.copy(cr);
          }
        } else {
          b.sleeping = false;
        }
      }
    }
    const alpha = this.alpha = this.accumulator / this.fixedDt;
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      if (b.sleeping) continue;
      b.object.position.lerpVectors(b.previousPosition, b.position, alpha);
      b.object.quaternion.slerpQuaternions(b.previousRotation, b.rotation, alpha);
    }
  }

  /**
   * Radial blast impulse with inverse-square-ish falloff. `impulse` is in N·s at the
   * centre for a 1 m² presented area; bodies receive it at their centre of mass plus a
   * small random torque so debris tumbles.
   */
  applyBlast(center: THREE.Vector3, radius: number, impulse: number, upBias = 0.35, kind = 'blast'): number {
    // Listeners first: a wall that shatters now gets its fresh chunks thrown by the loop below.
    const listeners = this.blastListenerList;
    for (let i = 0; i < listeners.length; i++) listeners[i](center, radius, impulse, kind);
    this.blastCx = center.x;
    this.blastCy = center.y;
    this.blastCz = center.z;
    this.blastRadius = radius;
    this.blastRadiusSq = radius * radius;
    this.blastInvRadius = 1 / radius;
    this.blastImpulse = impulse;
    this.blastUpBias = upBias;
    this.blastAffected = 0;
    this.world.forEachRigidBody(this.applyBlastToBody);
    return this.blastAffected;
  }

  dispose(): void {
    this.bindingIndex.clear();
    this.bindingList.length = 0;
    this.preStepList.length = 0;
    this.blastListenerList.length = 0;
    this.contactListeners.clear();
    this.events?.free();
    this.events = null;
    this.world.free();
  }
}

export interface DebrisOptions {
  count: number;
  origin: THREE.Vector3;
  /** Launch speed range in m/s. */
  speed: [number, number];
  /** Piece size range in metres. */
  size: [number, number];
  /** 0 = full sphere, 1 = straight up. */
  upward?: number;
  color?: THREE.ColorRepresentation;
  /** Emissive glow multiplier for hot fragments. */
  heat?: number;
  lifetime?: number;
  restitution?: number;
  /** Optional water plane: fragments below it get heavy drag (and callers may spawn splashes). */
  waterLevel?: number;
}

interface DebrisPiece {
  body: RAPIER.RigidBody | null; age: number; lifetime: number; scale: THREE.Vector3; heat: number; color: THREE.Color; splashed: boolean;
  previousPosition: THREE.Vector3; previousRotation: THREE.Quaternion;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _dir = new THREE.Vector3();
const _ang = new RapierScratch();

/** Pooled Rapier rigid-body fragments rendered with one InstancedMesh. */
export class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private pieces: DebrisPiece[] = [];
  private freePieces: DebrisPiece[] = [];
  /** Called when a fragment first crosses the water plane. */
  onSplash: ((position: THREE.Vector3, speed: number) => void) | null = null;
  /** Called for energetic ground contacts (throttled). */
  onImpact: ((position: THREE.Vector3, speed: number) => void) | null = null;

  constructor(private physics: PhysicsWorld, private capacity: number) {
    const geometry = new THREE.DodecahedronGeometry(0.5, 0);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.25 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, _c.set(0x333333));
    // Remember each fragment's pre-step transform so rendering can interpolate.
    this.unregister = physics.addPreStep(() => {
      const pieces = this.pieces;
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        const body = piece.body!;
        if (body.isSleeping()) continue;
        body.translation(_t);
        body.rotation(_r);
        piece.previousPosition.set(_t.x, _t.y, _t.z);
        piece.previousRotation.set(_r.x, _r.y, _r.z, _r.w);
      }
    });
  }
  private unregister: () => void;

  setCapacity(capacity: number): void { this.capacity = Math.min(capacity, this.mesh.instanceMatrix.count); }

  spawn(options: DebrisOptions): void {
    const R = this.physics.RAPIER;
    const up = options.upward ?? 0.4;
    const ox = options.origin.x, oy = options.origin.y, oz = options.origin.z;
    const minSpeed = options.speed[0], spanSpeed = options.speed[1] - minSpeed;
    const minSize = options.size[0], spanSize = options.size[1] - minSize;
    const baseLife = options.lifetime ?? 9;
    const baseHeat = options.heat ?? 0;
    const restitution = options.restitution ?? 0.32;
    const baseColor = options.color ?? 0x2a2a2a;

    for (let i = 0; i < options.count; i++) {
      if (this.pieces.length >= this.capacity) this.release(0, false);
      const u = Math.random();
      const size = minSize + spanSize * (u * u);
      _dir.set(Math.random() * 2 - 1, Math.random() * (1 + up) - (1 - up) * 0.25, Math.random() * 2 - 1).normalize();
      _dir.y = Math.abs(_dir.y) * (0.4 + up) + _dir.y * (1 - up) * 0.2;
      _dir.normalize();
      const speed = minSpeed + spanSpeed * Math.random();
      const px = ox + _dir.x * 0.4, py = oy + Math.abs(_dir.y) * 0.4 + 0.1, pz = oz + _dir.z * 0.4;
      _ang.x = (Math.random() - 0.5) * 18;
      _ang.y = (Math.random() - 0.5) * 18;
      _ang.z = (Math.random() - 0.5) * 18;
      const body = this.physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(px, py, pz)
          .setLinvel(_dir.x * speed, _dir.y * speed, _dir.z * speed)
          .setAngvel(_ang)
          .setLinearDamping(0.05).setAngularDamping(0.2).setCcdEnabled(size < 0.2),
      );
      const sx = size * (0.6 + Math.random() * 0.8);
      const sy = size * (0.4 + Math.random() * 0.6);
      const sz = size * (0.6 + Math.random() * 0.8);
      this.physics.world.createCollider(
        R.ColliderDesc.cuboid(sx * 0.45, sy * 0.45, sz * 0.45).setDensity(900).setRestitution(restitution).setFriction(0.7),
        body,
      );
      let piece = this.freePieces.pop();
      if (piece) {
        piece.body = body;
        piece.age = 0;
        piece.lifetime = baseLife * (0.7 + Math.random() * 0.6);
        piece.scale.set(sx, sy, sz);
        piece.heat = baseHeat;
        piece.color.set(baseColor).multiplyScalar(0.6 + Math.random() * 0.8);
        piece.splashed = false;
        piece.previousPosition.set(px, py, pz);
        piece.previousRotation.set(0, 0, 0, 1);
      } else {
        piece = {
          body, age: 0, lifetime: baseLife * (0.7 + Math.random() * 0.6),
          scale: new THREE.Vector3(sx, sy, sz), heat: baseHeat,
          color: new THREE.Color(baseColor).multiplyScalar(0.6 + Math.random() * 0.8),
          splashed: false,
          previousPosition: new THREE.Vector3(px, py, pz),
          previousRotation: new THREE.Quaternion(0, 0, 0, 1),
        };
      }
      this.pieces.push(piece);
    }
  }

  private release(index: number, swap = true): void {
    const piece = this.pieces[index];
    if (piece.body) {
      this.physics.world.removeRigidBody(piece.body);
      piece.body = null;
    }
    this.freePieces.push(piece);
    if (swap) {
      const last = this.pieces.pop()!;
      if (index < this.pieces.length) this.pieces[index] = last;
    } else {
      this.pieces.splice(index, 1);
    }
  }

  update(dt: number, waterLevel: number | null = null): void {
    const pieces = this.pieces;
    if (pieces.length === 0) {
      if (this.mesh.count !== 0) this.mesh.count = 0;
      return;
    }
    const alpha = this.physics.alpha;
    const matArr = this.mesh.instanceMatrix.array as Float32Array;
    const colArr = this.mesh.instanceColor ? (this.mesh.instanceColor.array as Float32Array) : null;

    // Single pass: age, splash-check, retire expired pieces (swap-remove) and write batched transforms + colors.
    let i = 0;
    while (i < pieces.length) {
      const piece = pieces[i];
      piece.age += dt;
      const body = piece.body!;
      body.translation(_t);
      if (piece.age > piece.lifetime || _t.y < -60) {
        this.release(i, true);
        continue;
      }
      if (waterLevel !== null && _t.y < waterLevel) {
        if (!piece.splashed) {
          piece.splashed = true;
          body.linvel(_lv);
          this.onSplash?.(_p.set(_t.x, waterLevel, _t.z), Math.sqrt(_lv.x * _lv.x + _lv.y * _lv.y + _lv.z * _lv.z));
        }
        body.setLinearDamping(4.5);
        piece.heat = 0;
      }
      body.rotation(_r);

      const pp = piece.previousPosition;
      const px = pp.x + (_t.x - pp.x) * alpha;
      const py = pp.y + (_t.y - pp.y) * alpha;
      const pz = pp.z + (_t.z - pp.z) * alpha;
      _q2.set(_r.x, _r.y, _r.z, _r.w);
      _q.slerpQuaternions(piece.previousRotation, _q2, alpha);

      let fade = (piece.lifetime - piece.age) / 0.6;
      if (fade > 1) fade = 1;
      else if (fade < 0.001) fade = 0.001;
      const sx = piece.scale.x * fade, sy = piece.scale.y * fade, sz = piece.scale.z * fade;

      // Inline Matrix4.compose directly into the instanceMatrix buffer.
      const qx = _q.x, qy = _q.y, qz = _q.z, qw = _q.w;
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2;
      const yy = qy * y2, yz = qy * z2, zz = qz * z2;
      const wx = qw * x2, wy = qw * y2, wz = qw * z2;
      const mo = i * 16;
      matArr[mo] = (1 - (yy + zz)) * sx;
      matArr[mo + 1] = (xy + wz) * sx;
      matArr[mo + 2] = (xz - wy) * sx;
      matArr[mo + 3] = 0;
      matArr[mo + 4] = (xy - wz) * sy;
      matArr[mo + 5] = (1 - (xx + zz)) * sy;
      matArr[mo + 6] = (yz + wx) * sy;
      matArr[mo + 7] = 0;
      matArr[mo + 8] = (xz + wy) * sz;
      matArr[mo + 9] = (yz - wx) * sz;
      matArr[mo + 10] = (1 - (xx + yy)) * sz;
      matArr[mo + 11] = 0;
      matArr[mo + 12] = px;
      matArr[mo + 13] = py;
      matArr[mo + 14] = pz;
      matArr[mo + 15] = 1;

      if (colArr) {
        // Hot fragments glow (HDR instance colour feeds bloom) and cool to charred metal.
        const glow = piece.heat > 0 ? piece.heat * Math.exp(-piece.age * 1.3) : 0;
        const co = i * 3;
        colArr[co] = piece.color.r + glow * 6;
        colArr[co + 1] = piece.color.g + glow * 1.6;
        colArr[co + 2] = piece.color.b + glow * 0.25;
      }
      i++;
    }
    this.mesh.count = pieces.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    while (this.pieces.length) this.release(this.pieces.length - 1, true);
    this.mesh.count = 0;
  }

  dispose(): void {
    this.unregister();
    this.clear();
    this.freePieces.length = 0;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
