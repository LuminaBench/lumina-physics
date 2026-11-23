/**
 * Camera trauma: blast- and speed-reactive shake.
 *
 * `trauma` (0..1) decays linearly; the visible shake is trauma², which gives a violent
 * snap that settles quickly. A separate continuous "rumble" channel is driven by vehicle
 * speed. Offsets are applied *after* the scene's camera rig has positioned the camera.
 */
import * as THREE from 'three/webgpu';

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

// Each channel samples the same three oscillators with a different fixed phase.
// Expand sin(t + phase) once so a frame only needs six transcendental calls.
const phases = new Float64Array(6 * 6);
for (let channel = 0; channel < 6; channel++) {
  const seed = channel + 1, k = channel * 6;
  phases[k] = 0.5 * Math.cos(seed * 12.9898);
  phases[k + 1] = 0.5 * Math.sin(seed * 12.9898);
  phases[k + 2] = 0.3 * Math.cos(seed * 78.233);
  phases[k + 3] = 0.3 * Math.sin(seed * 78.233);
  phases[k + 4] = 0.2 * Math.cos(seed * 37.719);
  phases[k + 5] = 0.2 * Math.sin(seed * 37.719);
}

export class CameraTrauma {
  trauma = 0;
  /** Continuous 0..1 rumble (speed, engine, storm wind). */
  rumble = 0;
  decay = 1.1;
  maxAngle = 0.055;
  maxOffset = 0.55;
  frequency = 22;
  /** FOV kick in degrees at trauma = 1. */
  fovKick = 6;
  private baseFov = 0;
  private time = 0;
  private applied = false;
  private readonly channels = new Float64Array(6);
  private readonly savedPosition = new THREE.Vector3();
  private readonly savedQuaternion = new THREE.Quaternion();

  /** Undo last frame's shake. Call at the start of a frame, before any camera rig runs. */
  restore(camera: THREE.PerspectiveCamera): void {
    if (!this.applied) return;
    camera.position.copy(this.savedPosition);
    camera.quaternion.copy(this.savedQuaternion);
    this.applied = false;
  }

  add(amount: number): void { this.trauma = Math.min(1, this.trauma + amount); }

  /** Trauma from a blast of `yieldScale` (1 ≈ car bomb) at `distance` metres. */
  blast(distance: number, yieldScale = 1): void {
    this.add(Math.min(1, (yieldScale * 38) / (distance + 12)) ** 1.25);
  }

  /** Current shake amount (0..1), exposed for post effects such as chromatic fringing. */
  get shake(): number { return Math.min(1, this.trauma * this.trauma + this.rumble * 0.12); }

  apply(camera: THREE.PerspectiveCamera, dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const shake = this.trauma * this.trauma + this.rumble * 0.06;
    if (this.baseFov === 0) this.baseFov = camera.fov;
    if (shake < 1e-4) return;
    this.savedPosition.copy(camera.position);
    this.savedQuaternion.copy(camera.quaternion);
    this.applied = true;
    const t = this.time * this.frequency;
    const sinA = Math.sin(t), cosA = Math.cos(t);
    const sinB = Math.sin(t * 2.31), cosB = Math.cos(t * 2.31);
    const sinC = Math.sin(t * 5.17), cosC = Math.cos(t * 5.17);
    const channels = this.channels;
    for (let i = 0; i < channels.length; i++) {
      const k = i * 6;
      channels[i] = sinA * phases[k] + cosA * phases[k + 1] + sinB * phases[k + 2]
        + cosB * phases[k + 3] + sinC * phases[k + 4] + cosC * phases[k + 5];
    }
    _euler.set(channels[0] * this.maxAngle * shake, channels[1] * this.maxAngle * shake, channels[2] * this.maxAngle * 0.7 * shake);
    camera.quaternion.multiply(_quat.setFromEuler(_euler));
    camera.position.x += channels[3] * this.maxOffset * shake;
    camera.position.y += channels[4] * this.maxOffset * shake;
    camera.position.z += channels[5] * this.maxOffset * shake;
    camera.updateMatrixWorld();
  }

  /** Extra FOV (degrees) the rig should add for the current trauma. */
  get fovOffset(): number { return this.trauma * this.trauma * this.fovKick; }
}
