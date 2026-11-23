/**
 * Propeller / rotor motion blur.
 *
 * A camera with a finite shutter does not see a spinning blade, it sees the arc the blade
 * swept while the shutter was open. For angular speed ω and exposure time τ each blade is
 * smeared over φ = ω·τ; a blade of angular width β(r) = chord / r therefore covers the
 * fraction β / (β + φ) of its smear. With N blades:
 *
 *   φ small           N distinct, slightly soft blades
 *   φ ≈ 2π/N − β      the smears touch: the classic strobing fan
 *   φ ≥ 2π/N          a uniform veil of opacity N·β / 2π (thin at the tip, dense at the hub)
 *
 * The disc is one transparent quad-ring whose fragment shader evaluates exactly that, so
 * the hand-over from real blades to blur needs no cross-fade tricks: hide the blade meshes
 * once `blurred` is true.
 */
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame, auxPassthrough } from '../../engine/frame';

const { Fn, uv, vec3, vec4, float, uniform, length, atan, mod, smoothstep, mix, min, max } = TSL;

export interface RotorOptions {
  /** Tip radius in metres. */
  radius: number;
  /** Hub radius in metres (no blade inside it). */
  hubRadius?: number;
  blades: number;
  /** Blade chord in metres at the root and at the tip. */
  chord?: [number, number];
  color?: THREE.ColorRepresentation;
  /** Painted tip band (safety stripe) and how much of the radius it covers. */
  tipColor?: THREE.ColorRepresentation;
  tipBand?: number;
  /** Exposure time in seconds (1/48 = film at 24 fps, 1/120 = sharp game look). */
  shutter?: number;
  /** Visual gain on the blur's opacity (1 = exact time-average coverage). */
  density?: number;
  /** Upward slope of the loaded blades from hub to tip, in radians. */
  coning?: number;
}

export class RotorBlur {
  /** Disc in the local XY plane (normal +Z). Parent it to the hub and orient it to the rotor axis. */
  readonly mesh: THREE.Mesh;
  /** Current blade angle in radians. */
  angle = 0;
  /** True once the blades are smeared enough that the real meshes should be hidden. */
  blurred = false;
  shutter: number;
  private uAngle = uniform(0);
  private uSmear = uniform(0);
  private uOpacity = uniform(1);
  private blades: number;

  constructor(options: RotorOptions) {
    this.blades = options.blades;
    this.shutter = options.shutter ?? 1 / 60;
    const hub = (options.hubRadius ?? options.radius * 0.08) / options.radius;
    const [chordRoot, chordTip] = options.chord ?? [options.radius * 0.11, options.radius * 0.06];
    const color = new THREE.Color(options.color ?? 0x1c1f22);
    const tip = new THREE.Color(options.tipColor ?? 0xe8b21a);
    const band = options.tipBand ?? 0.08;
    const density = options.density ?? 2.6;
    const N_ = options.blades;
    const sector = (Math.PI * 2) / N_;

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;
    material.colorNode = Fn(() => {
      const c = uv().mul(2).sub(1);
      const r = length(c);
      const theta = atan(c.y, c.x);
      // Angular width of a blade at this radius.
      const chord = mix(float(chordRoot), float(chordTip), smoothstep(hub, 1.0, r)).div(options.radius);
      const beta = chord.div(max(r, 0.02));
      const smear = this.uSmear;
      const span = min(beta.add(smear), sector);
      // Position inside the blade's sector, measured from the trailing end of its smear.
      const local = mod(theta.sub(this.uAngle).add(span.mul(0.5)).add(Math.PI * 4), sector);
      const edge = max(beta.mul(0.18), 0.012);
      const inside = smoothstep(0.0, edge, local).mul(smoothstep(span, span.sub(edge), local));
      // A blade covers β of its smear; fully merged smears become a uniform veil.
      const coverage = beta.div(max(span, 1e-4)).min(1);
      const radial = smoothstep(hub, hub + 0.03, r).mul(smoothstep(1.0, 0.985, r));
      // `density` lifts the physically thin veil to what a camera sensor records (highlights
      // on the blade faces and the tip stripe read brighter than their time-average).
      const alpha = inside.mul(coverage.mul(density).min(0.92)).mul(radial);
      const paint = mix(vec3(color.r, color.g, color.b), vec3(tip.r, tip.g, tip.b), smoothstep(1 - band - 0.01, 1 - band, r));
      // Unlit sprite: approximate the light on a flat disc.
      const light = mix(frame.skyHorizon, frame.skyZenith, 0.5).add(frame.sunColor.mul(frame.sunVisibility).mul(0.28));
      return vec4(paint.mul(light), alpha.mul(this.uOpacity));
    })();
    material.mrtNode = auxPassthrough();
    material.forceSinglePass = true;
    const geometry = options.coning
      ? new THREE.RingGeometry(hub * options.radius, options.radius, 72, 2)
      : new THREE.PlaneGeometry(options.radius * 2, options.radius * 2);
    if (options.coning) {
      const positions = geometry.getAttribute('position');
      const slope = Math.tan(options.coning), root = hub * options.radius;
      for (let i = 0; i < positions.count; i++) {
        const radius = Math.hypot(positions.getX(i), positions.getY(i));
        positions.setZ(i, (radius - root) * slope);
      }
      geometry.computeBoundingSphere();
    }
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'lumina-rotor-blur';
    this.mesh.renderOrder = 14;
    this.mesh.castShadow = false;
  }

  /**
   * Advance the rotor. `omega` is the angular speed in rad/s (rpm × 2π / 60). Returns the
   * new blade angle; apply it to the real blade group while `blurred` is false.
   */
  update(dt: number, omega: number): number {
    this.angle = (this.angle + omega * dt) % (Math.PI * 2);
    const smear = Math.abs(omega) * this.shutter;
    this.uAngle.value = this.angle;
    this.uSmear.value = smear;
    // The real blades take over when the smear is a small fraction of a blade width.
    const sector = (Math.PI * 2) / this.blades;
    this.blurred = smear > sector * 0.06;
    this.uOpacity.value = this.blurred ? 1 : 0;
    this.mesh.visible = this.blurred;
    return this.angle;
  }

  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
