/**
 * Small procedural animators for mechanical parts. Each one turns a physical quantity the
 * simulation already knows (a command, a throttle setting, an acceleration) into motion with
 * the rate limits and overshoot of real hardware; none of them needs keyframes.
 */
import * as THREE from 'three/webgpu';

/**
 * A hydraulic / servo actuator: follows a commanded value at a limited rate with a
 * second-order response (control surfaces, landing-gear doors, flaps, turrets).
 */
export class Actuator {
  value = 0;
  velocity = 0;
  /**
   * @param rate       maximum travel rate in units per second
   * @param frequency  natural frequency in Hz (how quickly it settles)
   * @param damping    damping ratio (1 = no overshoot, 0.6 = a visible wobble)
   */
  constructor(public rate = 2, public frequency = 6, public damping = 0.85) {}

  step(target: number, dt: number): number {
    const w = this.frequency * Math.PI * 2;
    // Semi-implicit spring toward the target, then clamp the speed to the actuator's rate.
    this.velocity += (w * w * (target - this.value) - 2 * this.damping * w * this.velocity) * dt;
    this.velocity = THREE.MathUtils.clamp(this.velocity, -this.rate, this.rate);
    this.value += this.velocity * dt;
    return this.value;
  }
}

export interface SurfaceBinding {
  pivot: THREE.Object3D;
  /** Rotation axis on the pivot. */
  axis: 'x' | 'y' | 'z';
  /** Deflection in radians at command = 1. */
  throw: number;
  /** -1 mirrors the deflection (left / right ailerons). */
  sign?: number;
}

/**
 * Flight control surfaces driven by pitch / roll / yaw / flap commands (-1..1), each group
 * behind its own actuator so surfaces lag, overshoot slightly and never snap.
 */
export class ControlSurfaces {
  private static readonly channels = ['pitch', 'roll', 'yaw', 'flap'] as const;
  readonly pitch = new Actuator(3.2, 5, 0.8);
  readonly roll = new Actuator(4.5, 7, 0.75);
  readonly yaw = new Actuator(2.6, 4.5, 0.85);
  readonly flap = new Actuator(0.35, 1.2, 1);
  private groups: Record<'pitch' | 'roll' | 'yaw' | 'flap', SurfaceBinding[]> = { pitch: [], roll: [], yaw: [], flap: [] };

  bind(channel: 'pitch' | 'roll' | 'yaw' | 'flap', ...surfaces: SurfaceBinding[]): this {
    this.groups[channel].push(...surfaces);
    return this;
  }

  update(dt: number, command: { pitch?: number; roll?: number; yaw?: number; flap?: number }): void {
    for (let i = 0; i < ControlSurfaces.channels.length; i++) {
      const channel = ControlSurfaces.channels[i];
      const value = this[channel].step(THREE.MathUtils.clamp(command[channel] ?? 0, -1, 1), dt);
      const surfaces = this.groups[channel];
      for (let j = 0; j < surfaces.length; j++) {
        const s = surfaces[j];
        s.pivot.rotation[s.axis] = value * s.throw * (s.sign ?? 1);
      }
    }
  }
}

/**
 * Variable-area exhaust nozzle. The throat follows engine power the way a real turbofan's
 * does: wide open at idle, closed down at military power, wide open again in afterburner.
 * `petals` are scaled about the nozzle axis (convergent petals swinging in and out).
 */
export class NozzleAnimator {
  /** 0 = fully closed throat, 1 = fully open. */
  readonly area = new Actuator(1.8, 2.6, 0.9);
  /** 0..1 strength for exhaust shimmer (feed it to a heat-haze volume). */
  shimmer = 0;

  constructor(private petals: THREE.Object3D[], private options: { axis?: 'x' | 'y' | 'z'; apertureAxis?: 'x' | 'y' | 'z'; closed?: number; open?: number } = {}) {}

  /** `throttle` 0..1 (dry power), `afterburner` 0..1. */
  update(dt: number, throttle: number, afterburner: number): number {
    const closed = this.options.closed ?? 0.72, open = this.options.open ?? 1.08;
    // Idle: open. Rising dry power: closing. Afterburner: opening past the idle setting.
    const dry = THREE.MathUtils.lerp(0.75, 0, THREE.MathUtils.smoothstep(throttle, 0.15, 0.95));
    const target = Math.max(dry, afterburner);
    const area = this.area.step(target, dt);
    const scale = THREE.MathUtils.lerp(closed, open, area);
    const axis = this.options.axis ?? 'z', aperture = this.options.apertureAxis;
    for (let i = 0; i < this.petals.length; i++) {
      const p = this.petals[i];
      if (axis !== 'x' && (!aperture || aperture === 'x')) p.scale.x = scale;
      if (axis !== 'y' && (!aperture || aperture === 'y')) p.scale.y = scale;
      if (axis !== 'z' && (!aperture || aperture === 'z')) p.scale.z = scale;
    }
    this.shimmer = THREE.MathUtils.clamp(0.25 + throttle * 0.5 + afterburner * 0.6, 0, 1.4);
    return area;
  }
}

/**
 * Car body motion on its springs: squat under power, dive under braking, roll in corners
 * and heave over bumps, from the body-frame acceleration the vehicle already computes.
 * Applied to the sprung body node only (wheels stay with the suspension solver).
 */
export class ChassisAnimator {
  /** Radians of pitch per m/s² of longitudinal acceleration. */
  pitchGain = 0.0105;
  /** Radians of roll per m/s² of lateral acceleration. */
  rollGain = 0.0125;
  maxPitch = 0.055;
  maxRoll = 0.075;
  private pitch = new Actuator(1.2, 1.9, 0.42);
  private roll = new Actuator(1.4, 2.1, 0.45);
  private restY: number;

  constructor(private body: THREE.Object3D) { this.restY = body.position.y; }

  /** `acceleration`: x = forward (m/s²), y = toward the car's right. */
  update(dt: number, acceleration: { x: number; y: number }): void {
    // Rig convention: forward = -Z. Positive rotation.x tips the nose down, so accelerating
    // (weight to the rear, nose up) is negative.
    const pitch = this.pitch.step(THREE.MathUtils.clamp(-acceleration.x * this.pitchGain, -this.maxPitch, this.maxPitch), dt);
    // Cornering throws the body toward the outside of the turn.
    const roll = this.roll.step(THREE.MathUtils.clamp(acceleration.y * this.rollGain, -this.maxRoll, this.maxRoll), dt);
    this.body.rotation.x = pitch;
    this.body.rotation.z = roll;
    // The body sits a little lower on its springs while it is loaded.
    this.body.position.y = this.restY - (Math.abs(pitch) + Math.abs(roll)) * 0.18;
  }
}
