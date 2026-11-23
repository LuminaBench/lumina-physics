/**
 * Scripted racetrack flight for showcase / QA: a long low pass through a focus point
 * (accelerating through Mach 1 just before it), a banked turn, a high return leg and a
 * second turn. Everything is an analytic function of the distance flown.
 */
import * as THREE from 'three/webgpu';

export const SPEED_OF_SOUND_SEA_LEVEL = 340.3;

export interface FlightPlan {
  /** Point the low pass flies over. */
  focus: THREE.Vector3;
  /** Heading of the low pass in radians (0 = +X). */
  heading: number;
  /** Altitude above the focus during the pass / on the return leg (m). */
  passAltitude: number;
  cruiseAltitude: number;
  /** Mach number entering the pass and at the focus. */
  machIn: number;
  machPeak: number;
  straight: number;
  turnRadius: number;
}

export const DEFAULT_FLIGHT_PLAN: FlightPlan = {
  focus: new THREE.Vector3(), heading: 0, passAltitude: 16, cruiseAltitude: 420, machIn: 0.82, machPeak: 1.18, straight: 5200, turnRadius: 1100,
};

export interface FlightState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  mach: number;
  speed: number;
  gLoad: number;
  bank: number;
  /** Signed distance along the pass relative to the focus (m, negative = approaching). */
  along: number;
  onPass: boolean;
}

const _forward = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eye = new THREE.Vector3();
const _rollAxis = new THREE.Vector3(0, 0, 1);

export class RacetrackFlight {
  readonly state: FlightState = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), quaternion: new THREE.Quaternion(), mach: 0.8, speed: 270, gLoad: 1, bank: 0, along: -1e4, onPass: true,
  };
  private previousPosition = new THREE.Vector3();
  private track = { x: 0, z: 0, yaw: 0, along: 0, turning: false };
  /** Distance flown along the loop (m). */
  distance: number;
  /** Multiplies the planned Mach profile (UI throttle). */
  machScale = 1;

  constructor(readonly plan: FlightPlan = { ...DEFAULT_FLIGHT_PLAN, focus: new THREE.Vector3() }) {
    this.distance = plan.straight * 0.5 - 1900; // start 1.9 km out, inbound
    this.sample(this.distance, this.state);
  }

  get perimeter(): number { return 2 * this.plan.straight + 2 * Math.PI * this.plan.turnRadius; }

  /** Loop-space position: x along the pass, z lateral, plus heading (radians, loop space) and curvature sign. */
  private loop(s: number): void {
    const { straight: L, turnRadius: R } = this.plan;
    const P = this.perimeter;
    s = ((s % P) + P) % P;
    const track = this.track;
    // The second half mirrors the first around z = R.
    const returning = s >= P * 0.5;
    if (returning) s -= P * 0.5;
    track.turning = s >= L;
    if (track.turning) {
      const angle = (s - L) / R;
      track.x = L * 0.5 + Math.sin(angle) * R;
      track.z = R - Math.cos(angle) * R;
      track.yaw = angle;
      track.along = returning ? -1e5 : 1e5;
    } else {
      track.x = s - L * 0.5;
      track.z = 0;
      track.yaw = 0;
      track.along = returning ? 1e5 : track.x;
    }
    if (returning) {
      track.x = -track.x;
      track.z = 2 * R - track.z;
      track.yaw += Math.PI;
    }
  }

  private sample(s: number, out: FlightState): void {
    const plan = this.plan;
    this.loop(s);
    const l = this.track;
    const cosH = Math.cos(plan.heading), sinH = Math.sin(plan.heading);
    // Altitude: sink to pass height over ~1.4 km either side of the focus.
    const onPass = Math.abs(l.along) < plan.straight / 2;
    const low = onPass ? 1 - THREE.MathUtils.smoothstep(Math.abs(l.along), 700, 2200) : 0;
    const altitude = THREE.MathUtils.lerp(plan.cruiseAltitude, plan.passAltitude, low);
    out.position.set(plan.focus.x + l.x * cosH - l.z * sinH, plan.focus.y + altitude, plan.focus.z + l.x * sinH + l.z * cosH);
    // Mach: accelerate through the transonic band on the run-in, hold, bleed off in the turn.
    const accel = onPass ? THREE.MathUtils.smoothstep(l.along, -1500, -120) * (1 - THREE.MathUtils.smoothstep(l.along, 900, 2300)) : 0;
    out.mach = THREE.MathUtils.lerp(plan.machIn, plan.machPeak, accel) * this.machScale;
    out.speed = out.mach * SPEED_OF_SOUND_SEA_LEVEL;
    out.along = l.along;
    out.onPass = onPass;
    const yaw = plan.heading + l.yaw;
    const bank = l.turning ? Math.min(1.3, Math.atan((out.speed * out.speed) / (9.81 * plan.turnRadius))) : 0;
    out.bank = bank;
    out.gLoad = 1 / Math.cos(bank);
    _forward.set(Math.cos(yaw), 0, Math.sin(yaw));
    out.velocity.copy(_forward).multiplyScalar(out.speed);
    // Rig convention: forward = -Z.
    _m.lookAt(_eye.set(0, 0, 0), _forward, _up);
    out.quaternion.setFromRotationMatrix(_m);
    out.quaternion.multiply(_q.setFromAxisAngle(_rollAxis, -bank));
  }

  update(dt: number): FlightState {
    const before = this.previousPosition.copy(this.state.position);
    this.distance += this.state.speed * dt;
    const bankBefore = this.state.bank;
    this.sample(this.distance, this.state);
    // Smooth roll-in / roll-out and derive true velocity (includes climb / descent).
    if (dt > 0) {
      this.state.velocity.copy(this.state.position).sub(before).multiplyScalar(1 / dt);
      const smoothed = bankBefore + (this.state.bank - bankBefore) * Math.min(1, dt * 1.8);
      if (Math.abs(smoothed - this.state.bank) > 1e-4) {
        this.state.quaternion.multiply(_q.setFromAxisAngle(_rollAxis, this.state.bank - smoothed));
        this.state.bank = smoothed;
        this.state.gLoad = 1 / Math.cos(smoothed);
      }
    }
    return this.state;
  }

  /** Jump so the aircraft is `distance` metres before the focus on the pass. */
  resetToRunIn(distance = 1900): void {
    this.distance = this.plan.straight * 0.5 - distance;
    this.sample(this.distance, this.state);
  }
}
