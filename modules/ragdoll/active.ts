import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineModule, LuminaEngine } from '../../engine/engine';
import { buildSwimmerGeometry, swimmerMaterial, SWIMMER_BONES } from './swimmer';

interface Limb {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  rest: THREE.Quaternion;
  afloat: THREE.Quaternion;
  mass: number;
  radius: number;
  length: number;
  gain: number;
  floatRatio: number;
}
export class ActiveRagdoll implements EngineModule {
  readonly limbs: Limb[] = [];
  readonly stats = { strength: 1, immersion: 0, torsoTilt: 0, groundedFeet: 0 };
  readonly torso: Limb;
  readonly pelvis: Limb;
  private readonly joints: RAPIER.ImpulseJoint[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly ang = new THREE.Vector3();
  private readonly current = new THREE.Vector3();
  private readonly air = new THREE.Vector3();
  private readonly push = new THREE.Vector3();
  private readonly target = new THREE.Quaternion();
  private readonly offContact: () => void;
  private readonly rot = new THREE.Quaternion();
  private readonly error = new THREE.Quaternion();
  private readonly inertia: RAPIER.SdpMatrix3;
  private readonly unregister: () => void;
  private readonly offBlast: () => void;
  private recovery = 1;
  private readonly feet: Limb[] = [];
  private readonly contactLife = new Uint8Array(2);
  private readonly contactLoad = new Float64Array(2);
  private readonly planted = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly normal = new THREE.Vector3();
  private readonly supports: (RAPIER.RigidBody | null)[] = [null, null];
  private readonly offSoles: (() => void)[] = [];
  private readonly platformVelocity = new THREE.Vector3();
  private readonly hipCentre = new THREE.Vector3();
  private readonly hipVelocity = new THREE.Vector3();
  private readonly stanceAxis = new THREE.Vector3();
  private readonly hipAnchor = new THREE.Vector3();
  /** The clothed worker: one skinned surface whose bones are the limb objects. */
  private readonly figure: THREE.SkinnedMesh;
  /** Per-segment wetness (0..1) read by the garment shader; drains after leaving water. */
  private readonly wetness: number[] = new Array(SWIMMER_BONES).fill(0);
  private readonly wetNode: N;

  constructor(
    private engine: LuminaEngine,
    origin: THREE.Vector3,
    spawnPose: 'standing' | 'afloat' = 'standing'
  ) {
    const physics = engine.physics,
      R = physics.RAPIER;
    this.inertia = new R.SdpMatrix3(new Float32Array(6));
    this.wetNode = TSL.uniformArray(this.wetness, 'float');
    const material = swimmerMaterial(this.wetNode);
    this.materials.push(material);
    // Limb objects are the skeleton's bones: bound to their bodies as before, never drawn.
    const boneGeometry = new THREE.BufferGeometry();
    this.geometries.push(boneGeometry);
    const piece = (
      x: number,
      y: number,
      z: number,
      length: number,
      radius: number,
      mass: number,
      gain: number,
      floatRatio: number,
      shape?: RAPIER.ColliderDesc
    ) => {
      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(origin.x + x, origin.y + y, origin.z + z)
          .setLinearDamping(0.11)
          .setAngularDamping(0.65)
          .setCanSleep(false)
      );
      const half = Math.max(0.008, length * 0.5 - radius);
      physics.world.createCollider((shape ?? R.ColliderDesc.capsule(half, radius)).setMass(mass).setFriction(0.86), body);
      const mesh = new THREE.Mesh(boneGeometry, material);
      mesh.visible = false;
      mesh.position.set(origin.x + x, origin.y + y, origin.z + z);
      engine.scene.add(mesh);
      physics.bind(body, mesh);
      const entry: Limb = {
        body,
        mesh,
        rest: new THREE.Quaternion(),
        afloat: new THREE.Quaternion(),
        mass,
        radius,
        length,
        gain,
        floatRatio,
      };
      this.limbs.push(entry);
      return entry;
    };
    const connect = (a: Limb, b: Limb, x: number, y: number, z: number, hinge = false) => {
      const aa = new THREE.Vector3(origin.x + x, origin.y + y, origin.z + z).sub(a.mesh.position);
      const ab = new THREE.Vector3(origin.x + x, origin.y + y, origin.z + z).sub(b.mesh.position);
      const data = hinge ? R.JointData.revolute(aa, ab, { x: 1, y: 0, z: 0 }) : R.JointData.spherical(aa, ab);
      const joint = physics.world.createImpulseJoint(data, a.body, b.body, true);
      joint.setContactsEnabled(false);
      if (hinge) {
        const j = joint as RAPIER.RevoluteImpulseJoint;
        j.setLimits(-0.12, 1.68);
        j.configureMotorPosition(0.06, 34, 4);
      }
      this.joints.push(joint);
      return joint;
    };
    this.pelvis = piece(0, 0.99, 0, 0.34, 0.145, 12, 0.85, 1.02);
    this.torso = piece(0, 1.31, 0, 0.47, 0.165, 18, 1.0, 1.48);
    connect(this.pelvis, this.torso, 0, 1.14, 0);
    const head = piece(0, 1.69, 0, 0.29, 0.123, 4.8, 0.6, 1.05);
    connect(this.torso, head, 0, 1.56, 0);
    this.torso.afloat.setFromEuler(new THREE.Euler(0.96, 0, 0));
    this.pelvis.afloat.setFromEuler(new THREE.Euler(0.79, 0, 0));
    head.afloat.setFromEuler(new THREE.Euler(0.66, 0, 0));
    for (const side of [-1, 1]) {
      const hipX = side * 0.104,
        shoulderX = side * 0.225;
      const thigh = piece(hipX, 0.737, 0, 0.44, 0.081, 6.8, 0.9, 0.98);
      const shin = piece(hipX, 0.332, 0, 0.405, 0.062, 3.7, 0.75, 0.96);
      const foot = piece(hipX, 0.095, -0.036, 0.165, 0.079, 1.2, 0.34, 0.88,
        R.ColliderDesc.roundCuboid(0.055, 0.039, 0.117, 0.012).setTranslation(0, -0.019, -0.035));
      this.feet.push(foot);
      thigh.afloat.setFromEuler(new THREE.Euler(0.74, 0, side * 0.25));
      shin.afloat.setFromEuler(new THREE.Euler(0.53, 0, side * 0.19));
      connect(this.pelvis, thigh, hipX, 0.937, 0);
      connect(thigh, shin, hipX, 0.53, 0, true);
      const ankle = connect(shin, foot, hipX, 0.15, 0, true) as RAPIER.RevoluteImpulseJoint;
      ankle.setLimits(-0.42, 0.48);
      ankle.configureMotorPosition(0, 140, 15);
      const arm = piece(shoulderX, 1.34, 0, 0.305, 0.059, 2.5, 0.21, 1.02);
      const hand = piece(shoulderX, 1.055, -0.009, 0.3, 0.048, 1.6, 0.12, 0.99);
      arm.rest.setFromEuler(new THREE.Euler(0.085, 0, side * 0.125));
      hand.rest.setFromEuler(new THREE.Euler(0.22, 0, side * 0.07));
      arm.afloat.setFromEuler(new THREE.Euler(0.2, 0, side * 1.18));
      hand.afloat.setFromEuler(new THREE.Euler(0.35, 0, side * 1.02));
      connect(this.torso, arm, shoulderX, 1.48, 0);
      connect(arm, hand, shoulderX, 1.198, 0, true);
    }
    // Skin the garment surface to the segments in their rest pose (relative to origin).
    const figureGeometry = buildSwimmerGeometry();
    this.geometries.push(figureGeometry);
    // bindMatrix carries the origin, so each inverse undoes the bone's full rest transform.
    const inverses = this.limbs.map((l) => new THREE.Matrix4().makeTranslation(
      -l.mesh.position.x, -l.mesh.position.y, -l.mesh.position.z));
    const skeleton = new THREE.Skeleton(this.limbs.map((l) => l.mesh) as unknown as THREE.Bone[], inverses);
    this.figure = new THREE.SkinnedMesh(figureGeometry, material);
    this.figure.name = 'rescue swimmer';
    this.figure.position.copy(origin);
    this.figure.castShadow = this.figure.receiveShadow = true;
    // Bones move the surface far from its rest bounds; the figure is small, skip culling.
    this.figure.frustumCulled = false;
    this.figure.updateMatrixWorld(true);
    this.figure.bind(skeleton, this.figure.matrixWorld.clone());
    engine.scene.add(this.figure);
    if (spawnPose === 'afloat') {
      // Origin is the water surface at the sternum. Rotate the assembled rig
      // as a unit so every joint starts with coincident local anchors.
      this.rot.setFromAxisAngle(this.stanceAxis.set(1, 0, 0), 1.16);
      for (const limb of this.limbs) {
        this.pos.copy(limb.mesh.position).sub(origin);
        this.pos.y -= 1.31;
        this.pos.applyQuaternion(this.rot).add(origin);
        limb.body.setTranslation(this.pos, true);
        limb.body.setRotation(this.rot, true);
        physics.bind(limb.body, limb.mesh);
      }
    }
    const ownBodies = new Set(this.limbs.map((l) => l.body.handle));
    for (let i = 0; i < this.feet.length; i++) {
      const sole = this.feet[i].body.collider(0);
      this.offSoles.push(physics.onContactForce(sole, 3, (force, other, contact) => {
        if (!other || other.isSensor()) return;
        const support = other.parent();
        if (support && ownBodies.has(support.handle)) return;
        contact.maxForceDirection(this.normal);
        // Rapier reports the normal from its first collider toward the second.
        const up = (contact.collider2() === sole.handle ? 1 : -1) * this.normal.y;
        if (up < 0.55) return;
        if (!this.contactLife[i] || this.supports[i] !== support || this.recovery < 0.45) {
          this.feet[i].body.translation(this.planted[i]);
        }
        this.contactLoad[i] = force * up;
        this.contactLife[i] = 3;
        this.supports[i] = support;
      }));
    }
    this.offContact = physics.onContactForce(this.torso.body.collider(0), 1250, (force, other) => {
      const body = other?.parent();
      if (body && ownBodies.has(body.handle)) return;
      this.recovery = Math.min(this.recovery, Math.max(0.12, 1 - (force - 1000) / 4500));
    });
    this.unregister = physics.addPreStep((dt) => this.balance(dt));
    this.offBlast = physics.onBlast((center, radius) => {
      this.torso.body.translation(this.pos);
      const d = this.pos.distanceTo(center);
      if (d < radius) this.recovery = Math.min(this.recovery, d / Math.max(0.1, radius));
    });
  }
  stumble(direction: THREE.Vector3): void {
    this.torso.body.applyImpulse(direction, true);
    this.recovery = 0.08;
  }
  /** Leg extension and balance act through contacting soles. Internal impulses
   * share a point and therefore preserve angular as well as linear momentum. */
  private supportStance(dt: number): void {
    const activation = this.recovery * Math.max(0, 1 - this.stats.immersion * 2.5);
    this.stats.groundedFeet = 0;
    if (!this.contactLife[0] && !this.contactLife[1]) return;
    const pelvis = this.pelvis.body;
    pelvis.translation(this.hipCentre);
    pelvis.rotation(this.rot);
    pelvis.linvel(this.hipVelocity);
    pelvis.angvel(this.ang);
    for (let i = 0; i < this.feet.length; i++) {
      const support = this.supports[i];
      if (support && !support.isValid()) this.contactLife[i] = 0;
      if (this.contactLife[i] === 0) continue;
      this.contactLife[i]--;
      this.stats.groundedFeet++;
      if (activation <= 0.001) continue;
      const foot = this.feet[i].body;
      this.hipAnchor.set(i === 0 ? -0.104 : 0.104, 0, 0).applyQuaternion(this.rot);
      this.vel.crossVectors(this.ang, this.hipAnchor).add(this.hipVelocity);
      this.hipAnchor.add(this.hipCentre);
      foot.translation(this.pos);
      this.stanceAxis.subVectors(this.hipAnchor, this.pos);
      const length = this.stanceAxis.length();
      if (length < 0.02 || length > 0.94) continue;
      this.stanceAxis.multiplyScalar(1 / length);
      foot.linvel(this.air);
      const separating = this.vel.sub(this.air).dot(this.stanceAxis);
      const force = THREE.MathUtils.clamp((0.925 - length) * 10800 - separating * 260, 0, 930);
      this.push.copy(this.stanceAxis).multiplyScalar(force);
      // Ankle strategy: move the pelvis back over the support polygon. The
      // opposing impulse acts at the sole, so the ground supplies the support.
      // Damping follows a moving platform, including its rotational velocity.
      if (support) support.velocityAtPoint(this.pos, this.platformVelocity);
      else this.platformVelocity.set(0, 0, 0);
      const plant = this.planted[i].addScaledVector(this.platformVelocity, dt);
      const leanX = this.hipAnchor.x - this.pos.x;
      const leanZ = this.hipAnchor.z - this.pos.z - 0.036;
      this.push.x -= THREE.MathUtils.clamp(1550 * leanX + 160 * this.vel.x +
        85 * (this.hipVelocity.x - this.platformVelocity.x), -86, 86);
      this.push.z -= THREE.MathUtils.clamp(1550 * leanZ + 160 * this.vel.z +
        85 * (this.hipVelocity.z - this.platformVelocity.z), -86, 86);
      this.push.multiplyScalar(activation * dt);
      pelvis.applyImpulseAtPoint(this.push, this.pos, true);
      foot.applyImpulse(this.push.negate(), true);
      // Static shear in a rubber sole builds with displacement. Sliding is
      // bounded by the measured normal load and reacts on the supporting body.
      const dx = plant.x - this.pos.x, dz = plant.z - this.pos.z;
      const fx = 5400 * dx + 150 * (this.platformVelocity.x - this.air.x);
      const fz = 5400 * dz + 150 * (this.platformVelocity.z - this.air.z);
      const grip = Math.min(1, (0.65 * this.contactLoad[i]) / Math.max(1, Math.hypot(fx, fz)));
      this.push.set(fx * grip * dt, 0, fz * grip * dt);
      foot.applyImpulse(this.push, true);
      if (support?.isDynamic()) support.applyImpulseAtPoint(this.push.negate(), this.pos, true);
      if (grip < 1) { plant.x = this.pos.x + dx * grip; plant.z = this.pos.z + dz * grip; }
    }
  }

  private balance(dt: number): void {
    this.recovery = Math.min(1, this.recovery + dt * 0.43);
    this.supportStance(dt);
    let sum = 0;
    for (let i = 0; i < this.limbs.length; i++) {
      const l = this.limbs[i],
        b = l.body;
      b.translation(this.pos);
      b.rotation(this.rot);
      b.angvel(this.ang);
      b.linvel(this.vel);
      const h = this.engine.world.waterHeight(this.pos.x, this.pos.z, this.current);
      const wet = Math.min(1, Math.max(0, 0.5 + (h - this.pos.y) / l.length));
      sum += wet;
      // Soaked fabric drains over ~a minute once a segment leaves the water.
      this.wetness[i] = Math.max(wet, this.wetness[i] - dt * 0.018);
      const immersion = Math.min(1, Math.max(wet, this.stats.immersion));
      const stiffness = this.recovery * l.gain * (1 - 0.53 * immersion);
      this.target.slerpQuaternions(l.rest, l.afloat, immersion);
      this.error.copy(this.rot).invert().premultiply(this.target);
      const sign = this.error.w < 0 ? -1 : 1;
      // An inertia-scaled, implicitly damped orientation servo. The same
      // controller can guide a torso and a glove without overshooting the very
      // small rotational inertia about a limb's long axis.
      const spring = 1400 * stiffness * (1 - 0.68 * immersion);
      const damping = 1.25 * Math.sqrt(spring) + 1.6 * wet;
      const step = dt / (1 + damping * dt + spring * dt * dt);
      const x = (2 * sign * spring * this.error.x - damping * this.ang.x) * step;
      const y = (2 * sign * spring * this.error.y - damping * this.ang.y) * step;
      const z = (2 * sign * spring * this.error.z - damping * this.ang.z) * step;
      const tensor = b.effectiveAngularInertia(this.inertia).elements;
      this.push.set(
        tensor[0] * x + tensor[1] * y + tensor[2] * z,
        tensor[1] * x + tensor[3] * y + tensor[4] * z,
        tensor[2] * x + tensor[4] * y + tensor[5] * z
      );
      b.applyTorqueImpulse(this.push, true);
      // Area-scaled wind load and damped hydrostatic lift on each body segment.
      this.engine.world.ambientWind(this.pos, this.engine.time, this.air);
      const drag = Math.min(0.14, wet * dt * 2.6);
      this.push
        .set(
          this.air.x * 0.015 * dt + (this.current.x - this.vel.x) * drag,
          9.81 * wet * l.floatRatio * dt + (this.current.y - this.vel.y) * drag,
          this.air.z * 0.015 * dt + (this.current.z - this.vel.z) * drag
        )
        .multiplyScalar(l.mass);
      b.applyImpulse(this.push, true);
      if (l === this.torso) this.stats.torsoTilt = 2 * Math.acos(Math.min(1, Math.abs(this.rot.w)));
    }
    this.stats.strength = this.recovery;
    this.stats.immersion = sum / this.limbs.length;
  }
  dispose(): void {
    this.unregister();
    this.offBlast();
    this.offContact();
    for (const off of this.offSoles) off();
    const physics = this.engine.physics;
    for (const j of this.joints) physics.world.removeImpulseJoint(j, true);
    for (const l of this.limbs) {
      physics.unbind(l.body);
      physics.world.removeRigidBody(l.body);
      l.mesh.removeFromParent();
    }
    this.figure.removeFromParent();
    this.figure.skeleton.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
