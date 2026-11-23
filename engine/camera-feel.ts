/**
 * Camera feel: the difference between a camera bolted to a vehicle and one flown by an
 * operator.
 *
 *   chase lag    the camera is pulled toward its ideal spot by a critically damped spring,
 *                so the subject surges ahead under power and swings wide in corners
 *   look-ahead   the aim point leads along the velocity
 *   speed FOV    the lens widens with speed (and snaps a little on acceleration)
 *   bank lean    the horizon rolls into turns with the subject, by a fraction of its bank
 *   trauma       impacts go through `engine.trauma` (noise-driven shake + chromatic fringe)
 *   hitstop      a few frames of near-frozen time on a heavy hit sells the impact
 *
 * It only writes the camera; call `update` from `engine.onBeforeRender` so it frames this
 * frame's interpolated physics poses.
 */
import * as THREE from 'three/webgpu';
import type { LuminaEngine } from './engine';

export interface ChaseOptions {
  /** Distance behind the subject (m). */
  distance: number;
  /** Height above the subject (m). */
  height: number;
  /** Spring frequency in Hz: higher = tighter follow. */
  stiffness?: number;
  /** Seconds of velocity the aim point leads by. */
  lookAhead?: number;
  /** Height of the aim point above the subject origin. */
  aimHeight?: number;
  baseFov?: number;
  /** Extra degrees of field of view at `fovSpeed` m/s. */
  fovGain?: number;
  fovSpeed?: number;
  /** Fraction of the subject's roll / lateral load the horizon follows (0 = level). */
  bank?: number;
  /** Subject's forward axis in its local frame (rigs use -Z, vehicle roots +Z). */
  forward?: THREE.Vector3;
  /** Keep the camera above this height function. */
  floor?: (x: number, z: number) => number;
}

const _ideal = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export class CameraFeel {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Current extra field of view from speed (degrees). */
  fovKick = 0;
  /** Current horizon roll (radians). */
  lean = 0;
  options: Required<Omit<ChaseOptions, 'floor'>> & { floor: ChaseOptions['floor'] };
  private subject: THREE.Object3D | null = null;
  private initialised = false;
  private lastSpeed = 0;
  private hitstopLeft = 0;
  private hitstopScale = 1;
  private savedTimeScale = 1;
  private aim = new THREE.Vector3();

  constructor(private engine: LuminaEngine, options: ChaseOptions = { distance: 8, height: 2.6 }) {
    this.options = {
      stiffness: 2.2, lookAhead: 0.22, aimHeight: 1, baseFov: engine.camera.fov, fovGain: 14, fovSpeed: 55, bank: 0.35,
      forward: new THREE.Vector3(0, 0, 1), floor: undefined, ...options,
    };
  }

  /** Follow a new subject (snaps to the ideal position on the next update). */
  follow(subject: THREE.Object3D, options?: Partial<ChaseOptions>): void {
    this.subject = subject;
    if (options) Object.assign(this.options, options);
    this.initialised = false;
  }

  /**
   * Freeze time almost completely for a moment (real seconds), then release. Use on the
   * frame a big hit lands; 0.05–0.09 s reads as weight, more reads as lag.
   */
  hitstop(duration = 0.07, scale = 0.04): void {
    if (this.hitstopLeft <= 0) this.savedTimeScale = this.engine.timeScale;
    this.hitstopLeft = Math.max(this.hitstopLeft, duration);
    this.hitstopScale = scale;
  }

  /** A hit: shake through the engine's trauma channel, optionally with hitstop. */
  impact(strength: number, withHitstop = false): void {
    this.engine.trauma.add(strength);
    if (withHitstop && strength > 0.35) this.hitstop(0.04 + 0.05 * Math.min(1, strength));
  }

  /**
   * @param dt        frame delta in *real* seconds (use the raw delta so hitstop can end)
   * @param velocity  subject velocity in world space (m/s)
   * @param lateral   lateral acceleration in the subject frame (m/s², + = toward its right), for the lean
   */
  update(dt: number, velocity: THREE.Vector3, lateral = 0): void {
    const { engine } = this;
    if (this.hitstopLeft > 0) {
      this.hitstopLeft -= dt;
      engine.timeScale = this.hitstopLeft > 0 ? this.savedTimeScale * this.hitstopScale : this.savedTimeScale;
    }
    const subject = this.subject;
    if (!subject || dt <= 0) return;
    const o = this.options;
    const camera = engine.camera;
    subject.getWorldQuaternion(_q);
    _forward.copy(o.forward).applyQuaternion(_q);
    // Follow the heading, not the pitch / roll of the body: the camera stays level and behind.
    _flat.set(_forward.x, 0, _forward.z);
    if (_flat.lengthSq() < 1e-6) _flat.set(0, 0, 1);
    _flat.normalize();
    subject.getWorldPosition(_aim);
    _ideal.copy(_aim).addScaledVector(_flat, -o.distance).addScaledVector(_up, o.height);
    if (!this.initialised) { this.position.copy(_ideal); this.velocity.set(0, 0, 0); this.aim.copy(_aim); this.initialised = true; }

    // Critically damped spring (exact for constant target velocity over the step).
    const w = o.stiffness * Math.PI * 2;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity.x += (w * w * (_ideal.x - this.position.x) - 2 * w * (this.velocity.x - velocity.x)) * h;
      this.velocity.y += (w * w * (_ideal.y - this.position.y) - 2 * w * (this.velocity.y - velocity.y)) * h;
      this.velocity.z += (w * w * (_ideal.z - this.position.z) - 2 * w * (this.velocity.z - velocity.z)) * h;
      this.position.addScaledVector(this.velocity, h);
    }
    if (o.floor) this.position.y = Math.max(this.position.y, o.floor(this.position.x, this.position.z) + 0.5);
    camera.position.copy(this.position);

    // Aim: ahead of the subject along its velocity, smoothed so steering inputs do not snap it.
    _aim.y += o.aimHeight;
    _aim.addScaledVector(velocity, o.lookAhead);
    this.aim.lerp(_aim, 1 - Math.exp(-dt * 14));
    camera.up.set(0, 1, 0);
    camera.lookAt(this.aim);

    // Bank lean: roll with the lateral load.
    const targetLean = THREE.MathUtils.clamp(-lateral * 0.012 * o.bank, -0.16, 0.16);
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-dt * 4.5));
    if (Math.abs(this.lean) > 1e-4) {
      camera.getWorldDirection(_axis);
      camera.quaternion.premultiply(_roll.setFromAxisAngle(_axis, this.lean));
    }

    // Speed FOV, with a little extra while accelerating hard.
    const speed = velocity.length();
    const accel = (speed - this.lastSpeed) / dt;
    this.lastSpeed = speed;
    const target = o.fovGain * THREE.MathUtils.smoothstep(speed, 4, o.fovSpeed) + THREE.MathUtils.clamp(accel * 0.12, -1.5, 3);
    this.fovKick += (target - this.fovKick) * (1 - Math.exp(-dt * 3.2));
    const fov = o.baseFov + this.fovKick;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  /** Give time back (scene teardown while a hitstop is in flight). */
  dispose(): void {
    if (this.hitstopLeft > 0) this.engine.timeScale = this.savedTimeScale;
    this.hitstopLeft = 0;
  }
}
