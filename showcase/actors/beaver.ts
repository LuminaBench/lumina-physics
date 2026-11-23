/**
 * Beaver floatplane actor: rig + Rapier body + multi-point buoyancy + taxi controls, and
 * the water coupling that carves Kelvin V-wakes, stern wake convergence and bow spray.
 */
import * as THREE from 'three/webgpu';
import type { LuminaEngine } from '../../engine/engine';
import { RapierScratch } from '../../engine/physics';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from '../../modules/water/ocean';
import { BuoyantBody } from '../../modules/water/buoyancy';
import { createBeaverRig, type BeaverRig } from '../../test-rigs';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _r = new RapierScratch();
const _lv = new RapierScratch();
const _av = new RapierScratch();
const _force = new RapierScratch();
const _torque = new RapierScratch();
const _bowPos = new THREE.Vector3();
const _bowVel = { x: 0, y: 0, z: 0 };
const _bowOpts = {
  position: _bowPos, radius: 0.3, velocity: _bowVel,
  spread: 1.1, speedJitter: 0.5, life: 1.05, lifeJitter: 0.4, size: 0.085, sizeEnd: 0.32,
};
const _slamPos = new THREE.Vector3();
const _slamVel = { x: 0, y: 0, z: 0 };
const _slamOpts = {
  position: _slamPos, radius: 0.6, velocity: _slamVel,
  spread: 2, life: 1.3, size: 0.12, sizeEnd: 0.8, count: 0,
};
const BOW_DIRS: readonly [readonly [number, number], readonly [number, number]] = [[-1, 0.45], [1, -0.45]];
/** Recorded track (x, z) at ≥ 0.5 m spacing, newest last: wash sources follow the real turn. */
const TRAIL = 96;
const TRAIL_SPACING = 0.5;
/** Path-distance sample scratch: x, z, unit tangent x, z. */
const _trail = new Float64Array(4);
/** Foam a Gaussian field source deposits on its centreline in one pass is
 * rate · r / U · √(π / 2.5); invert it so whitewater is laid per metre travelled. */
const DEPOSIT = 1 / (Math.sqrt(Math.PI / 2.5));
const BOW_KEYS: readonly [readonly [string, string], readonly [string, string]] = [['bow0-1', 'bow00.45'], ['bow11', 'bow1-0.45']];

export class BeaverActor {
  readonly rig: BeaverRig;
  readonly body: import('@dimforge/rapier3d-compat').RigidBody;
  readonly buoyancy: BuoyantBody;
  /** 0..1 engine power. */
  throttle = 0;
  /** -1..1 water rudder. */
  rudder = 0;
  /** When set, the actor steers itself around a circle of this radius (m). */
  circleRadius: number | null = 85;
  speed = 0;
  readonly position = new THREE.Vector3();
  private unregister: () => void;
  private readonly trail = new Float64Array(TRAIL * 2);
  private trailHead = 0;
  private trailCount = 0;

  constructor(private engine: LuminaEngine, private fx: EffectsKit, private ocean: Ocean, start = new THREE.Vector3(0, 0.6, 0), heading = 0) {
    const { physics, scene } = engine;
    const R = physics.RAPIER;
    this.rig = createBeaverRig();
    scene.add(this.rig.object);
    const he = this.rig.halfExtents;
    this.body = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z)
        .setRotation(_q.setFromAxisAngle(_up.set(0, 1, 0), heading))
        .setLinearDamping(0.05).setAngularDamping(0.9).setCanSleep(false),
    );
    // Mass concentrated low between the floats keeps the aircraft upright.
    physics.world.createCollider(R.ColliderDesc.cuboid(he.x, 0.5, he.z).setTranslation(0, 0.7, 0).setMass(this.rig.mass).setFriction(0.4), this.body);
    physics.bind(this.body, this.rig.object);
    // 4 points per float; volume chosen so the floats sit ~half submerged at rest (waterline trim).
    this.buoyancy = new BuoyantBody(physics, ocean, this.body, { points: this.rig.floatPoints, volume: 4.7, draft: 0.7, linearDrag: 60, quadraticDrag: 18, heaveDamping: 1, keel: 6 });
    // Registered after buoyancy (which resets forces), so thrust is added on top each step.
    this.unregister = physics.addPreStep(() => this.forces());
    this.position.copy(start);
  }

  private forces(): void {
    const body = this.body;
    body.rotation(_r);
    body.linvel(_lv);
    const qx = _r.x, qy = _r.y, qz = _r.z, qw = _r.w;
    // Rotate (0, 0, -1) and (0, 1, 0) by unit quaternion directly.
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const fwdX = -(xz + wy), fwdZ = -(1 - (xx + yy));
    const upX = xy - wz, upZ = yz + wx;

    const forwardSpeed = _lv.x * fwdX + _lv.z * fwdZ;
    const afloat = this.buoyancy.state.submersion;
    const throttle = this.throttle;
    // Propeller thrust falls off with speed; applied near the centre of mass (no pitch-up).
    const thrustFactor = 1 - (forwardSpeed > 0 ? forwardSpeed : 0) / 34;
    const thrust = throttle * 9800 * (thrustFactor > 0.2 ? thrustFactor : 0.2);
    _force.x = fwdX * thrust;
    _force.y = 0;
    _force.z = fwdZ * thrust;
    body.addForce(_force, true);

    let rudder = this.rudder;
    const circleRadius = this.circleRadius;
    if (circleRadius !== null && throttle > 0.05) {
      body.angvel(_av);
      const desired = forwardSpeed / circleRadius;
      rudder = (desired - _av.y) * 2.2 + 0.25;
      if (rudder < -1) rudder = -1;
      else if (rudder > 1) rudder = 1;
    }
    // Combine water-rudder yaw torque and float-stance righting moment in a single Rapier call.
    const absFwd = forwardSpeed < 0 ? -forwardSpeed : forwardSpeed;
    const rudderBite = 0.3 + absFwd / 9;
    _torque.x = upZ * 9000 * afloat;
    _torque.y = rudder * 5200 * afloat * (rudderBite < 1 ? rudderBite : 1);
    _torque.z = -upX * 9000 * afloat;
    body.addTorque(_torque, true);
  }

  update(dt: number): void {
    const { fx, ocean, rig } = this;
    // Render-interpolated pose (written by PhysicsWorld.step) – not the raw 60 Hz body state.
    this.body.linvel(_lv);
    this.position.copy(rig.object.position);
    _q.copy(rig.object.quaternion);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    // Every double below is read from its field or scratch once: this runs about once per
    // frame, so it spends its first several hundred frames in V8's unoptimised tiers, where
    // each repeated read or repeated product allocates another HeapNumber.
    const lvx = _lv.x, lvz = _lv.z;
    const speed = this.speed = Math.sqrt(lvx * lvx + lvz * lvz);
    const throttle = this.throttle;
    rig.update(dt, throttle > 0.12 ? throttle : 0.12);
    if (dt <= 0) return;

    const field = ocean.field, sources = field.sources;
    const state = this.buoyancy.state;
    const submersion = state.pointSubmersion, slams = state.slam;
    const planing = THREE.MathUtils.smoothstep(speed, 1.5, 14);
    field.matchKelvin(speed > 6 ? speed : 6);
    const rigMatrix = rig.object.matrixWorld;
    const fwdX = _fwd.x, fwdZ = _fwd.z;

    // Bow spray terms shared by both floats and both sheets.
    const spraying = planing > 0.08;
    let sprayRate = 0, latSpeed = 0, carryX = 0, carryZ = 0, rightX = 0, rightZ = 0, noseX = 0, noseZ = 0;
    if (spraying) {
      // More water is thrown the deeper the bows run (mean of both floats: one value, so
      // the rate is boxed once per frame for the four emitter calls, as before).
      const bowMean = (submersion[0] + submersion[4]) * 1.1;
      sprayRate = (fx.spray.capacity / 1.4) * 0.05 * planing * (0.5 + (bowMean < 1 ? bowMean : 1));
      latSpeed = 1.6 + speed * 0.22;
      carryX = lvx * 0.55; carryZ = lvz * 0.55;
      rightX = _right.x; rightZ = _right.z;
      noseX = fwdX * 0.12; noseZ = fwdZ * 0.12;
      _bowOpts.spread = 1.1 + speed * 0.05;
      _bowVel.y = 1.6 + speed * 0.2;
    }

    // Wake coupling. Whitewater is laid per metre travelled (a moving source's deposit
    // falls as 1/U), and pressures stay at the scale of a real float wake: tens of
    // centimetres, where continuous forcing at the old strengths dug 0.9-1.5 m troughs that
    // read as two dark ribbons with almost no white water.
    const travelling = speed > 0.6 ? speed : 0.6;
    // Aeration begins as the floats start to plough (~4 kn) and saturates by ~13 kn.
    // Inline smoothsteps: an out-of-line call returns a boxed double each frame.
    const ta = (speed - 2) / 4.5, ts = (speed - 3) / 5;
    const aerated = ta <= 0 ? 0 : ta >= 1 ? 1 : ta * ta * (3 - 2 * ta);
    const sheets = ts <= 0 ? 0 : ts >= 1 ? 1 : ts * ts * (3 - 2 * ts);
    const rightAxisX = _right.x, rightAxisZ = _right.z;
    this.recordTrail();
    for (let side = 0; side < 2; side++) {
      const baseIdx = side * 4;
      const outward = side === 0 ? -1 : 1;
      const bowSub = submersion[baseIdx];
      const bowImmersion = bowSub * 2.2 < 1 ? bowSub * 2.2 : 1;
      const bow = _p.copy(rig.bows[side]).applyMatrix4(rigMatrix);
      const bowX = bow.x, bowZ = bow.z;
      if (bowSub > 0.02) {
        // Bow pressure pulse: the source of the divergent Kelvin arms. Its rim breaks into
        // a white moustache that grows with immersion and speed.
        let o = field.reserveSource();
        if (o >= 0) {
          sources[o] = bowX; sources[o + 1] = bowZ; sources[o + 2] = 1.0;
          // Stagnation pressure grows as U²; a slower hull also dwells longer over each
          // cell, so a constant forcing dug deeper troughs at taxi speed than at speed.
          const stagnation = 0.16 * speed * speed;
          sources[o + 3] = -(stagnation < 12 ? stagnation : 12) * bowImmersion; sources[o + 4] = 0;
          sources[o + 5] = 1.1 * aerated * bowImmersion * travelling * DEPOSIT; sources[o + 6] = 0.45;
        }
        // Chine sheets peel off and land beside each float 1.5-2 m aft of the bow.
        if (sheets > 0.02) {
          o = field.reserveSource();
          if (o >= 0) {
            sources[o] = bowX - fwdX * 1.8 + rightAxisX * outward * 0.95;
            sources[o + 1] = bowZ - fwdZ * 1.8 + rightAxisZ * outward * 0.95;
            sources[o + 2] = 0.85; sources[o + 3] = 0; sources[o + 4] = 0;
            sources[o + 5] = 1.5 * sheets * bowImmersion * travelling * DEPOSIT / 0.85; sources[o + 6] = 0;
          }
        }
      }
      // Bow spray: twin sheets peeled off the chines, thrown up and outward.
      if (spraying && bowSub > 0.05) {
        const keys = BOW_KEYS[side];
        // Plain stores: a `set()` call that is not inlined boxes all three arguments.
        _bowPos.x = bowX + noseX; _bowPos.y = state.surfaceHeights[baseIdx] + 0.045; _bowPos.z = bowZ + noseZ;
        for (let d = 0; d < 2; d++) {
          const dir = BOW_DIRS[side][d];
          _bowVel.x = carryX + rightX * dir * latSpeed;
          _bowVel.z = carryZ + rightZ * dir * latSpeed;
          fx.spray.emitRate(keys[d], sprayRate, dt, _bowOpts);
        }
      }
      // Stern: aerated turbulent wash from each transom, a little upwelling boil included.
      const sternSub = submersion[baseIdx + 3];
      if (sternSub > 0.02) {
        const stern = _p.copy(rig.sterns[side]).applyMatrix4(rigMatrix);
        const o = field.reserveSource();
        if (o >= 0) {
          const r = 1.05;
          sources[o] = stern.x - fwdX * 0.5; sources[o + 1] = stern.z - fwdZ * 0.5; sources[o + 2] = r;
          sources[o + 3] = 2.5 * planing * sternSub; sources[o + 4] = 0;
          sources[o + 5] = 2.6 * aerated * (0.45 + sternSub) * travelling * DEPOSIT / r; sources[o + 6] = 0;
        }
      }
      // Hard re-entry after a crest: slam spray + ring.
      for (let k = 0; k < 4; k++) {
        const slam = slams[baseIdx + k];
        if (slam > 2.2) {
          const wp = state.pointWorld[baseIdx + k];
          const wpX = wp.x, wpZ = wp.z;
          const clampedSlam = slam < 8 ? slam : 8;
          const o = field.reserveSource();
          if (o >= 0) {
            sources[o] = wpX; sources[o + 1] = wpZ; sources[o + 2] = 1.5;
            sources[o + 3] = 0; sources[o + 4] = -0.05 * clampedSlam; sources[o + 5] = 5; sources[o + 6] = 0;
          }
          _slamPos.x = wpX; _slamPos.y = state.surfaceHeights[baseIdx + k] + 0.06; _slamPos.z = wpZ;
          _slamVel.x = lvx * 0.4;
          _slamVel.y = 2 + slam * 0.9;
          _slamVel.z = lvz * 0.4;
          _slamOpts.spread = 2 + slam * 0.6;
          _slamOpts.count = Math.floor(fx.spray.burstBudget * 0.012 * clampedSlam);
          fx.spray.emit(_slamOpts);
        }
      }
    }
    // The two float washes merge on the centreline and spread. Sampled on the recorded
    // track, so the wash bends with the turn instead of trailing straight astern.
    if (aerated > 0.02) {
      for (let i = 0; i < 2; i++) {
        const back = i === 0 ? 8.5 : 16;
        if (!this.sampleTrail(back)) continue;
        const o = field.reserveSource();
        if (o < 0) continue;
        const r = i === 0 ? 2.0 : 2.8;
        sources[o] = _trail[0]; sources[o + 1] = _trail[1]; sources[o + 2] = r;
        sources[o + 3] = i === 0 ? -1.2 * planing : 0; sources[o + 4] = 0;
        sources[o + 5] = (i === 0 ? 0.9 : 0.55) * aerated * travelling * DEPOSIT / r; sources[o + 6] = i === 0 ? 0.4 : 0.5;
      }
    }
    if (planing > 0.05) {
      // Prop wash ruffles the surface under the tail; air, not a hull, so no deep trough.
      const px = this.position.x, pz = this.position.z;
      const o = field.reserveSource();
      if (o >= 0) {
        sources[o] = px - fwdX * 3; sources[o + 1] = pz - fwdZ * 3; sources[o + 2] = 2.2;
        sources[o + 3] = -0.9 * throttle; sources[o + 4] = 0; sources[o + 5] = 0.6 * throttle; sources[o + 6] = 0;
      }
      if (Math.random() < dt * 2.5) this.engine.events.emitAt('splash', this.position, planing);
    }
  }

  /** Append the current position when it has moved at least `TRAIL_SPACING` (no allocation). */
  private recordTrail(): void {
    const trail = this.trail, x = this.position.x, z = this.position.z;
    if (this.trailCount > 0) {
      const last = ((this.trailHead + TRAIL - 1) % TRAIL) * 2;
      const dx = x - trail[last], dz = z - trail[last + 1];
      if (dx * dx + dz * dz < TRAIL_SPACING * TRAIL_SPACING) return;
    }
    const o = this.trailHead * 2;
    trail[o] = x; trail[o + 1] = z;
    this.trailHead = (this.trailHead + 1) % TRAIL;
    if (this.trailCount < TRAIL) this.trailCount++;
  }

  /** Point `distance` metres back along the recorded track into `_trail`; false if too short. */
  private sampleTrail(distance: number): boolean {
    const trail = this.trail, count = this.trailCount;
    let i = (this.trailHead + TRAIL - 1) % TRAIL;
    let x = this.position.x, z = this.position.z, travelled = 0;
    for (let k = 0; k < count; k++) {
      const o = i * 2, px = trail[o], pz = trail[o + 1];
      const dx = px - x, dz = pz - z, d = Math.sqrt(dx * dx + dz * dz);
      if (d > 1e-6 && travelled + d >= distance) {
        const t = (distance - travelled) / d;
        _trail[0] = x + dx * t; _trail[1] = z + dz * t; _trail[2] = -dx / d; _trail[3] = -dz / d;
        return true;
      }
      travelled += d; x = px; z = pz;
      i = (i + TRAIL - 1) % TRAIL;
    }
    return false;
  }

  dispose(): void {
    this.unregister();
    this.buoyancy.dispose();
    this.engine.physics.removeBody(this.body);
    this.rig.object.removeFromParent();
  }
}
