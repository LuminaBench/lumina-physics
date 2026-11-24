/**
 * Raycast 4-wheel vehicle with real aquaplaning (hydroplaning) physics.
 *
 * Built on Rapier's `DynamicRayCastVehicleController` (per-wheel suspension rays, engine,
 * brake and friction impulses). Every fixed step each wheel samples the standing-water
 * depth under its contact patch:
 *
 *   - NASA critical speed  V_p = 6.35·√(tire pressure in kPa) km/h. Above ~0.75·V_p a
 *     water wedge starts to lift the tread; by ~1.08·V_p in water deeper than the tread
 *     the patch rides entirely on water.
 *   - grip (longitudinal slip limit + cornering stiffness) is scaled per wheel by that
 *     hydroplaning factor, so one flooded rut pulls the car, the nose "floats" when the
 *     fronts go light, and the tail steps out when the rears do,
 *   - displaced water costs momentum: ½·ρ·C_d·(tread width × depth)·v² at the patch,
 *     which also yaws the car toward the deeper side.
 *
 * Lifting the throttle sheds speed, depth-dependent grip returns and the driver model
 * (or a human) can counter-steer – exactly the recovery behaviour of a real car.
 */
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { LuminaEngine, EngineModule } from '../../engine/engine';

/**
 * What the vehicle drives on. `WetRoad` (puddles, aquaplaning) and `DeformableGround`
 * (sand, gravel, snow, mud) both implement it; a plain object works for anything else.
 */
export interface VehicleSurface {
  /** Standing-water depth in metres under a world position. */
  puddleDepth(x: number, z: number): number;
  /** 0 dry .. 1 soaked: blends `dryGrip` toward `wetGrip`. */
  readonly wetness: number;
  /** Local rain film at a wheel contact, for roads with sheltered or drying patches. */
  wetnessAt?(x: number, z: number): number;
  /** Friction multiplier of the ground itself (loose sand ≈ 0.7, snow ≈ 0.4). Default 1. */
  grip?(x: number, z: number): number;
  /** Rolling resistance per wheel in N per m/s (soft ground). Default 0. */
  rollingDrag?(x: number, z: number): number;
  /** Optional sinks for the car pose (road shading: contact shadow, headlight pool). */
  partFoliage?: (x: number, y: number, z: number, radius: number, speed: number) => void;
  carPosition?: THREE.Vector3;
  carForward?: THREE.Vector3;
}

/** Where the built-in driver model steers. */
export type VehiclePath =
  | { type: 'lane'; x: number }
  | { type: 'circle'; center: THREE.Vector2; radius: number; clockwise?: boolean };

export interface VehicleOptions {
  start?: THREE.Vector3;
  /** Create an infinite flat collider for the suspension rays (default true). */
  ground?: boolean;
  /** Height of that collider's surface (default 0). */
  groundY?: number;
  path?: VehiclePath;
  /** Initial heading in radians (0 = +Z). */
  heading?: number;
}

/**
 * What the vehicle needs from a car model (rig space: forward = -Z, origin on the road).
 * `test-rigs/test-car.ts` is the reference implementation.
 */
export interface VehicleRig {
  object: THREE.Object3D;
  /** Wheel pivots in order FL, FR, RL, RR; each may contain a child named "spin". */
  wheels: THREE.Object3D[];
  wheelRadius: number;
  /** Wheel hub rest positions relative to the rig origin. */
  hardPoints: THREE.Vector3[];
  halfExtents: THREE.Vector3;
  mass: number;
  setBrake(amount: number): void;
  /** Optional per-wheel angular speed (rad/s) for speed-aware spoke/tread motion blur. */
  setWheelSpeed?(index: number, omega: number): void;
}

export interface VehicleInput {
  /** -1 (reverse) .. 1 (full throttle). */
  throttle: number;
  /** -1 (toward -X) .. 1 (toward +X) for a car heading +Z. */
  steer: number;
  /** 0..1 */
  brake: number;
}

export interface WheelState {
  contact: boolean;
  /** Solver contact load (N) and its ratio to the static quarter-car load. */
  load: number;
  loadRatio: number;
  /** World contact frame and chassis velocity at the wheel (m/s). */
  normal: THREE.Vector3;
  rollingDirection: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Signed speeds along the wheel and across its tread, in m/s. */
  rollingSpeed: number;
  /** Signed wheel angular speed in radians per second; also drives the render rig. */
  angularSpeed: number;
  lateralSpeed: number;
  /** Standing-water depth under the patch (m). */
  depth: number;
  /** 0 = full contact, 1 = fully hydroplaning. */
  hydro: number;
  /** Friction limit handed to the solver this step. */
  grip: number;
  position: THREE.Vector3;
}

export interface VehicleTuning {
  /** Tire inflation pressure in kPa (sets the hydroplaning onset speed). */
  tirePressure: number;
  /** Tread depth in metres: water shallower than this is channelled away. */
  treadDepth: number;
  dryGrip: number;
  wetGrip: number;
  enginePower: number;
  maxDriveForce: number;
  brakeForce: number;
  /** Drag coefficient of the water wedge ahead of each tire (momentum lost to spray). */
  waterDrag: number;
  /** Fraction of grip a fully hydroplaning tire keeps (viscous shear in the film). */
  floatGrip: number;
}

const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _applicationPoint = new THREE.Vector3();
const _impulse = new THREE.Vector3();

/** NASA hydroplaning onset speed (m/s) for a tire pressure in kPa. */
export function hydroplaningSpeed(pressureKPa: number): number {
  return (6.35 * Math.sqrt(pressureKPa)) / 3.6;
}

export class AquaplaningVehicle implements EngineModule {
  readonly input: VehicleInput = { throttle: 0, steer: 0, brake: 0 };
  readonly tuning: VehicleTuning = { tirePressure: 220, treadDepth: 0.0028, dryGrip: 2.1, wetGrip: 1.45, enginePower: 260_000, maxDriveForce: 9500, brakeForce: 240, waterDrag: 1.0, floatGrip: 0.055 };
  readonly wheels: WheelState[] = Array.from({ length: 4 }, () => ({ contact: false, depth: 0, hydro: 0, grip: 0, position: new THREE.Vector3(),
    load: 0, loadRatio: 0, normal: new THREE.Vector3(0, 1, 0), rollingDirection: new THREE.Vector3(0, 0, 1),
    velocity: new THREE.Vector3(), rollingSpeed: 0, angularSpeed: 0, lateralSpeed: 0 }));
  /** When true a simple driver model holds the lane and target speed and reacts to hydroplaning. */
  autopilot = true;
  /** Stationary rear-wheel burnout: front brakes hold the car while the driven
   * wheels exceed rolling speed. The tire smoke uses the resulting slip. */
  burnout = 0;
  /** Autopilot cruise speed in m/s. */
  targetSpeed = 24;
  /** Lane centre for the default straight path (alias of `path.x`). */
  get laneX(): number { return this.path.type === 'lane' ? this.path.x : 0; }
  set laneX(x: number) { if (this.path.type === 'lane') this.path.x = x; else this.path = { type: 'lane', x }; }
  /** Signed forward speed (m/s). */
  speed = 0;
  yawRate = 0;
  /** Mean hydroplaning factor of the four wheels (0..1). */
  hydroplaning = 0;
  /** Heading error relative to the road axis (radians). */
  slipAngle = 0;
  readonly chassis: RAPIER.RigidBody;
  readonly forward = new THREE.Vector3(0, 0, 1);
  private controller: RAPIER.DynamicRayCastVehicleController;
  private unregister: () => void;
  /** Scene node driven by the chassis: carries the render-interpolated pose (use it for cameras). */
  readonly root = new THREE.Group();
  private holder = new THREE.Group();
  private groundBody?: RAPIER.RigidBody;
  private restLength = 0.3;
  /** Chassis-origin height above the road at static equilibrium. */
  private rideHeight = 0.38;
  private connectionY = 0.185;
  private recovery = 0;
  private floatTime = 0;
  /** Seconds the autopilot takes to react to a slide before lifting off. */
  reactionTime = 0.32;

  /** 0..1 brake-light output this frame. */
  brakeLight = 0;
  /** True while the driver model is lifting off to recover from a slide. */
  get recovering(): boolean { return this.recovery > 0; }
  /** Path followed by the autopilot. */
  path: VehiclePath;
  /** Height of the ground the car resets onto. */
  groundY: number;
  /** Longitudinal / lateral acceleration in the car's frame (m/s²), for body animation. */
  readonly acceleration = new THREE.Vector2();
  private road: VehicleSurface;
  private lastVelocity = new THREE.Vector3();

  constructor(private engine: LuminaEngine, readonly rig: VehicleRig, surface: VehicleSurface, options: VehicleOptions | THREE.Vector3 = {}) {
    const { physics, scene } = engine;
    const R = physics.RAPIER;
    const he = rig.halfExtents;
    const o: VehicleOptions = options instanceof THREE.Vector3 ? { start: options } : options;
    this.road = surface;
    this.groundY = o.groundY ?? 0;
    this.path = o.path ?? { type: 'lane', x: -1.9 };
    const start = o.start ?? new THREE.Vector3(-1.9, this.groundY + 0.75, 0);
    const heading = o.heading ?? 0;
    this.chassis = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z).setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
        .setLinearDamping(0.02).setAngularDamping(0.35).setCanSleep(false),
    );
    physics.world.createCollider(
      R.ColliderDesc.cuboid(he.x, he.y, he.z).setTranslation(0, 0.12, 0.28).setMass(rig.mass).setFriction(0.3).setRestitution(0.05),
      this.chassis,
    );
    // Flat ground for the suspension rays (skip when the scene provides its own colliders).
    if (o.ground !== false) {
      const ground = this.groundBody = physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, this.groundY - 0.5, 0));
      physics.world.createCollider(R.ColliderDesc.cuboid(4000, 0.5, 40000).setFriction(1), ground);
    }

    const controller = this.controller = physics.world.createVehicleController(this.chassis);
    controller.indexUpAxis = 1;
    controller.setIndexForwardAxis = 2;
    // The rig faces -Z; the physics chassis drives toward +Z.
    this.holder.rotation.y = Math.PI;
    // The rig is modelled standing on the ground; the chassis body rides `rideHeight` above it.
    rig.object.position.y = -this.rideHeight;
    this.holder.add(rig.object);
    this.root.name = 'vehicle';
    this.root.add(this.holder);
    scene.add(this.root);
    physics.bind(this.chassis, this.root);
    rig.hardPoints.forEach((hp, i) => {
      // Mirror the rig-space hard point through the 180° holder rotation.
      controller.addWheel({ x: -hp.x, y: this.connectionY, z: -hp.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.restLength, rig.wheelRadius);
      controller.setWheelSuspensionStiffness(i, 30);
      controller.setWheelSuspensionCompression(i, 2.8);
      controller.setWheelSuspensionRelaxation(i, 3.6);
      controller.setWheelMaxSuspensionTravel(i, 0.2);
      controller.setWheelMaxSuspensionForce(i, 60000);
      controller.setWheelFrictionSlip(i, this.tuning.wetGrip);
      controller.setWheelSideFrictionStiffness(i, 1);
    });
    this.unregister = physics.addPreStep((dt) => this.step(dt));
  }

  /** World-space rear bumper centre (wake anchor). */
  rearBumper(out = new THREE.Vector3()): THREE.Vector3 {
    this.chassis.translation(_p);
    this.chassis.rotation(_q);
    return out.set(0, -0.1, -2.3).applyQuaternion(_q).add(_p);
  }

  private drive(dt: number): void {
    if (!this.autopilot) return;
    const t = this.chassis.translation(_p);
    const heading = Math.atan2(this.forward.x, this.forward.z);
    const frontHydro = (this.wheels[0].hydro + this.wheels[1].hydro) / 2;
    const rearHydro = (this.wheels[2].hydro + this.wheels[3].hydro) / 2;
    const floating = Math.max(frontHydro, rearHydro);
    // A real driver needs a moment to feel the wheel go light (or the tail step out) before
    // lifting – long enough for the slide to develop, short enough to catch it.
    // (Cornering on a curved path carries a few degrees of body slip that is not a slide.)
    const sliding = Math.abs(this.slipAngle) > (this.path.type === 'lane' ? 0.07 : 0.24);
    this.floatTime = floating > 0.5 || sliding ? this.floatTime + dt : 0;
    if (this.floatTime > this.reactionTime) this.recovery = 0.75;
    else this.recovery = Math.max(0, this.recovery - dt);
    // Lateral offset from the path and heading error relative to its tangent.
    let error: number, headingError: number, feedForward = 0;
    if (this.path.type === 'lane') { error = t.x - this.path.x; headingError = heading; }
    else {
      const p = this.path, dx = t.x - p.center.x, dz = t.z - p.center.y;
      const sign = p.clockwise ? -1 : 1;
      const radial = Math.hypot(dx, dz) || 1;
      // Tangent of travel around the circle; positive error = outside the circle.
      const tangent = Math.atan2(-dz * sign, dx * sign);
      headingError = Math.atan2(Math.sin(heading - tangent), Math.cos(heading - tangent));
      error = (radial - p.radius) * sign;
      // Steady-state steer for the curve (bicycle model), so the PD only corrects errors.
      feedForward = -sign * Math.atan(2.7 / p.radius) / 0.5;
    }
    // Path keeping: PD on lateral offset + heading, plus yaw-rate damping, which is what
    // produces the counter-steer when the tail steps out. Authority fades with front grip.
    const authority = 1 - 0.55 * frontHydro;
    const lookAhead = THREE.MathUtils.clamp(Math.abs(this.speed) * 0.4, 5, 18);
    let steer = (feedForward - (error / lookAhead + headingError * 1.5 + (this.yawRate - (this.path.type === 'circle' ? (this.path.clockwise ? -1 : 1) * this.speed / this.path.radius : 0)) * 0.42)) * authority;
    steer = THREE.MathUtils.clamp(steer, -1, 1);
    this.input.steer += (steer - this.input.steer) * Math.min(1, dt * 9);
    const speedError = this.targetSpeed - this.speed;
    if (this.recovery > 0) { this.input.throttle = 0; this.input.brake = 0; }
    else {
      this.input.throttle = THREE.MathUtils.clamp(speedError * 0.35, 0, 1);
      this.input.brake = speedError < -3 ? THREE.MathUtils.clamp(-speedError * 0.06, 0, 0.6) : 0;
    }
    // Spun or left the path: put it back (showcase convenience).
    const lost = this.path.type === 'lane' ? Math.abs(t.x) > 22 || Math.abs(heading) > 2.2 : Math.abs(error) > Math.max(9, this.path.radius * 0.6);
    if (lost || t.y < this.groundY - 2) this.reset();
  }

  /** Put the car back on its path, upright, at a moderate speed. */
  reset(): void {
    const t = this.chassis.translation(_p);
    const v = Math.min(this.targetSpeed, 14);
    if (this.path.type === 'lane') {
      this.chassis.setTranslation({ x: this.path.x, y: this.groundY + 0.75, z: t.z }, true);
      this.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      this.chassis.setLinvel({ x: 0, y: 0, z: v }, true);
    } else {
      const p = this.path, sign = p.clockwise ? -1 : 1;
      const angle = Math.atan2(t.z - p.center.y, t.x - p.center.x);
      const heading = Math.atan2(-Math.sin(angle) * sign, Math.cos(angle) * sign);
      this.chassis.setTranslation({ x: p.center.x + Math.cos(angle) * p.radius, y: this.groundY + 0.75, z: p.center.y + Math.sin(angle) * p.radius }, true);
      this.chassis.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
      this.chassis.setLinvel({ x: Math.sin(heading) * v, y: 0, z: Math.cos(heading) * v }, true);
    }
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.engine.physics.snap(this.chassis);
  }

  private step(dt: number): void {
    const c = this.controller, chassis = this.chassis, tune = this.tuning;
    chassis.rotation(_q);
    this.forward.set(0, 0, 1).applyQuaternion(_q);
    chassis.linvel(_vel);
    const speedAbs = _vel.length();
    this.speed = _vel.dot(this.forward);
    this.yawRate = chassis.angvel(_impulse).y;
    this.slipAngle = speedAbs > 2 ? Math.atan2(_vel.dot(_fwd.set(this.forward.z, 0, -this.forward.x)), Math.abs(this.speed) + 0.01) : 0;
    this.drive(dt);

    // Each tire contributes its impulse for this fixed step. External forces
    // on the chassis can persist independently of the wheel controller.
    const vp = hydroplaningSpeed(tune.tirePressure);
    // Body-frame acceleration (squat, dive and roll cues for the animation layer).
    const ax = (_vel.x - this.lastVelocity.x) / dt, az = (_vel.z - this.lastVelocity.z) / dt;
    this.acceleration.set(ax * this.forward.x + az * this.forward.z, ax * this.forward.z - az * this.forward.x);
    this.lastVelocity.copy(_vel);
    let hydroSum = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.contact = c.wheelIsInContact(i);
      w.load = w.contact ? Math.max(0, c.wheelSuspensionForce(i) ?? 0) : 0;
      w.loadRatio = w.load / (this.rig.mass * 9.81 / 4);
      if (w.contact) {
        c.wheelContactPoint(i, w.position);
        c.wheelContactNormal(i, w.normal);
        chassis.velocityAtPoint(w.position, w.velocity);
        const steering = c.wheelSteering(i) ?? 0;
        w.rollingDirection.set(Math.sin(steering), 0, Math.cos(steering)).applyQuaternion(_q)
          .projectOnPlane(w.normal).normalize();
        w.rollingSpeed = w.velocity.dot(w.rollingDirection);
        w.lateralSpeed = w.velocity.dot(_fwd.crossVectors(w.normal, w.rollingDirection));
      } else {
        w.velocity.set(0, 0, 0);
        w.rollingSpeed = w.lateralSpeed = 0;
      }
      w.depth = w.contact ? this.road.puddleDepth(w.position.x, w.position.z) : 0;
      // Water wedge: needs more water than the tread can evacuate *and* enough speed.
      const depthFactor = THREE.MathUtils.smoothstep(w.depth, tune.treadDepth, tune.treadDepth + 0.0095);
      const dynamicLift = THREE.MathUtils.smoothstep(speedAbs, 0.74 * vp, 1.08 * vp);
      const viscous = 0.22 * depthFactor * THREE.MathUtils.smoothstep(speedAbs, 0.3 * vp, 0.74 * vp);
      w.hydro = depthFactor * dynamicLift;
      const film = w.contact ? this.road.wetnessAt?.(w.position.x, w.position.z) ?? this.road.wetness : this.road.wetness;
      const wet = Math.max(film, THREE.MathUtils.smoothstep(w.depth, 0, 0.0036));
      const base = THREE.MathUtils.lerp(tune.dryGrip, tune.wetGrip, wet);
      // Rear tires carry a little more lateral capacity than the fronts (stable baseline);
      // even a fully floating tire keeps a trace of viscous grip.
      w.grip = base * (i >= 2 ? 1.12 : 1) * Math.max(tune.floatGrip, 1 - (1 - tune.floatGrip) * w.hydro - viscous) * (this.road.grip?.(w.position.x, w.position.z) ?? 1);
      c.setWheelFrictionSlip(i, w.grip);
      c.setWheelSideFrictionStiffness(i, THREE.MathUtils.lerp(1, 0.18, w.hydro));
      hydroSum += w.hydro;
      // Momentum lost to throwing water aside (also yaws the car toward the deeper rut).
      if (w.contact && w.depth > 0.0005 && speedAbs > 1) {
        const drag = 0.5 * 1000 * tune.waterDrag * (0.22 * Math.min(w.depth, 0.05)) * speedAbs * speedAbs;
        chassis.applyImpulseAtPoint(_impulse.set(_vel.x,0,_vel.z).multiplyScalar(-dt * drag / speedAbs), w.position, true);
      }
      // Soft ground: the wheel ploughs material aside.
      const soft = w.contact && this.road.rollingDrag ? this.road.rollingDrag(w.position.x, w.position.z) : 0;
      if (soft > 0 && speedAbs > 0.3) chassis.applyImpulseAtPoint(_impulse.set(_vel.x,0,_vel.z).multiplyScalar(-dt * soft), w.position, true);
    }
    this.hydroplaning = hydroSum / 4;

    // Power-limited rear-wheel drive.
    const driveForce = Math.min(tune.maxDriveForce, tune.enginePower / Math.max(Math.abs(this.speed), 4))
      * (this.burnout > 0 ? Math.max(this.input.throttle,this.burnout) : THREE.MathUtils.clamp(this.input.throttle,-1,1)) * (1-this.burnout*0.92);
    c.setWheelEngineForce(2, driveForce / 2);
    c.setWheelEngineForce(3, driveForce / 2);
    const brake = this.input.brake * tune.brakeForce;
    for (let i = 0; i < 4; i++) c.setWheelBrake(i, i<2 ? Math.max(brake,this.burnout*tune.brakeForce) : brake*0.65);
    // Speed-sensitive steering lock.
    const lock = THREE.MathUtils.lerp(0.52, 0.07, THREE.MathUtils.smoothstep(Math.abs(this.speed), 4, 45));
    // Autopilot counter-steer: point the front wheels along the direction of travel when the
    // car is sliding (what a skilled driver does), on top of the lane-keeping input.
    const onset = this.path.type === 'lane' ? 0.03 : 0.16;
    const counter = this.autopilot ? THREE.MathUtils.clamp(this.slipAngle * 1.15 - this.yawRate * 0.1, -0.45, 0.45) * THREE.MathUtils.smoothstep(Math.abs(this.slipAngle), onset, onset + 0.07) : 0;
    const steerAngle = THREE.MathUtils.clamp(this.input.steer * lock + counter, -0.55, 0.55);
    c.setWheelSteering(0, steerAngle);
    c.setWheelSteering(1, steerAngle);
    // Aerodynamic drag keeps top speed sane.
    chassis.applyImpulse(_impulse.set(_vel.x,0,_vel.z).multiplyScalar(-dt * speedAbs * 0.42), true);
    // Crosswind from the unified wind field: side force on the body's centre of pressure
    // (slightly ahead of the centre of mass). Harmless with grip – it steers a floating car.
    const t = chassis.translation(_p);
    const wind = this.engine.wind.ambientWind(_applicationPoint.set(t.x, t.y + 0.65, t.z), this.engine.time, _wind);
    const rx = this.forward.z, rz = -this.forward.x;
    const lateralAir = (wind.x - _vel.x) * rx + (wind.z - _vel.z) * rz;
    const sideForce = 0.5 * 1.2 * 1.05 * 2.4 * lateralAir * Math.abs(lateralAir);
    chassis.applyImpulseAtPoint(_impulse.set(rx * sideForce * dt,0,rz * sideForce * dt),
      _applicationPoint.set(t.x + this.forward.x * 0.35, t.y + 0.1, t.z + this.forward.z * 0.35), true);
    c.updateVehicle(dt);
  }

  update(dt: number): void {
    const c = this.controller, rig = this.rig;
    for (let i = 0; i < 4; i++) {
      const pivot = rig.wheels[i];
      const suspension = c.wheelSuspensionLength(i) ?? this.restLength;
      // Wheel centre = connection point − current suspension length (in rig space, origin on the road).
      pivot.position.y = this.rideHeight + this.connectionY - suspension;
      pivot.rotation.y = c.wheelSteering(i) ?? 0;
      const spin = pivot.getObjectByName('spin');
      // Hydroplaning driven wheels spin up, undriven ones slow: visible cue of lost contact.
      const wheelSlipSpeed = i>=2 ? this.burnout*44 : 0;
      const wheel = this.wheels[i];
      const rolling = wheel.contact ? wheel.rollingSpeed : this.speed;
      const brake = i < 2 ? Math.max(this.burnout, this.input.brake) : this.input.brake * 0.65;
      const availableImpulse = wheel.load * wheel.grip * this.engine.physics.fixedDt;
      const lock = wheel.contact && brake > 0
        ? THREE.MathUtils.smoothstep(brake * this.tuning.brakeForce / Math.max(1, availableImpulse), 0.55, 1.45) : 0;
      const slip = i >= 2 ? 1 + wheel.hydro * Math.abs(this.input.throttle) * 0.8 : 1 - wheel.hydro * 0.5;
      const omega = wheel.angularSpeed = (wheelSlipSpeed + rolling / rig.wheelRadius * slip) * (1 - lock);
      if (spin) spin.rotation.x -= omega * dt;
      rig.setWheelSpeed?.(i, omega);
    }
    // Brake lights: pedal pressure, and the lift-off while the driver catches a slide.
    this.brakeLight = Math.max(this.input.brake, this.recovery > 0 ? 0.6 : 0);
    rig.setBrake(this.brakeLight);
    if (this.road.partFoliage && this.wheels.some(w => w.contact)) {
      const p = this.root.position;
      this.road.partFoliage(p.x, p.y, p.z, 2.2, this.speed);
    }
    this.road.carPosition?.copy(this.root.position);
    this.road.carForward?.set(0, 0, 1).applyQuaternion(this.root.quaternion);
  }

  dispose(): void {
    this.unregister();
    const { physics } = this.engine;
    physics.world.removeVehicleController(this.controller);
    physics.removeBody(this.chassis);
    if (this.groundBody) physics.removeBody(this.groundBody);
    this.root.removeFromParent();
  }
}
