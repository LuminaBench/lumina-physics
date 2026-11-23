import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface PuddleSurface {
  /** Bed elevation and liquid thickness at world X/Z, both in metres. */
  heightAt(x: number, z: number): number;
  puddleDepth(x: number, z: number): number;
}

type Point = { x: number; y: number; z: number };
type ContactKind = 'foot' | 'wheel';
const CAPACITY = 24;
const LIFETIME = 1.8;

/** Centimetre-scale wave packets. The game may share one pool across many contact handles. */
export class PuddleContacts {
  private readonly events = Array.from({ length: CAPACITY }, () => new THREE.Vector4());
  private readonly dispersion = Array.from({ length: CAPACITY }, () => new THREE.Vector4());
  private readonly eventNodes = TSL.uniformArray(this.events, 'vec4');
  private readonly waveNodes = TSL.uniformArray(this.dispersion, 'vec4');
  private readonly first = TSL.uniform(0, 'int');
  private readonly count = TSL.uniform(0, 'int');
  private readonly time = TSL.uniform(0);
  private clock = 0;

  constructor(readonly surface: PuddleSurface) {}
  get activeCount(): number { return this.count.value; }

  /** One handle per independently moving outsole or tire. Width is the physical contact width. */
  contact(kind: ContactKind, width = kind === 'wheel' ? 0.045 : 0.105): PuddleContact {
    if (!Number.isFinite(width) || width <= 0) throw new RangeError('Contact width must be positive and finite.');
    return new PuddleContact(this, kind, width);
  }

  /** Standalone users advance the pool once per frame. WetRoad does this automatically. */
  update(dt: number): void {
    if (!(dt > 0) || !this.count.value) return;
    this.clock += dt;
    while (this.count.value && this.clock - this.events[this.first.value].z >= LIFETIME) {
      this.first.value = (this.first.value + 1) % CAPACITY;
      this.count.value--;
    }
    if (!this.count.value) this.clock = 0;
    this.time.value = this.clock;
  }

  /** Deposit a circular wave packet at a known wet contact. */
  deposit(x: number, z: number, depth: number, width: number, speed: number): void {
    if (!(depth > 0.0004 && width > 0 && speed > 0.04)) return;
    const wavelength = Math.max(0.045, Math.min(0.36, width * 1.55));
    const k = 2 * Math.PI / wavelength;
    const kh = k * Math.min(depth, 0.4);
    const h = Math.tanh(kh);
    // Finite-depth gravity–capillary dispersion. Its derivative transports the envelope.
    const gravity = 9.81, capillary = 0.000072;
    const omega = Math.sqrt((gravity * k + capillary * k ** 3) * h);
    const group = ((gravity + 3 * capillary * k * k) * h +
      (gravity * k + capillary * k ** 3) * (kh / k) * (1 - h * h)) / (2 * omega);
    const amplitude = Math.min(depth * 0.36, 0.17 / k, speed * width * 0.055);
    const slot = (this.first.value + this.count.value) % CAPACITY;
    if (this.count.value === CAPACITY) this.first.value = (this.first.value + 1) % CAPACITY;
    else this.count.value++;
    this.events[slot].set(x, z, this.clock, amplitude);
    this.dispersion[slot].set(k, omega, group, wavelength);
  }

  /** Sample submerged paint and aggregate at the end of the refracted viewing ray.
   * Supply a unit surface-to-camera direction, a unit world normal and vertical liquid depth in metres. */
  bedXZNode(xz: N, view: N, normal: N, depth: N): N {
    const ray = TSL.refract(view.negate(), normal, TSL.float(1 / 1.333));
    return xz.add(ray.xz.mul(depth.max(0).div(ray.y.negate().max(0.15))));
  }

  /** TSL world-XZ gradient, to add to the standing water normal before reflection/refraction. */
  slopeNode(xz: N): N {
    const { Fn, If, Loop, vec2, float, length, exp, sin, cos, smoothstep } = TSL;
    return Fn(() => {
      const slope = vec2(0).toVar();
      Loop({ start: 0, end: this.count, type: 'int', condition: '<', name: 'puddlePacket' }, ({ puddlePacket }: N) => {
        const i = this.first.add(puddlePacket).mod(CAPACITY);
        const e = this.eventNodes.element(i), wave = this.waveNodes.element(i);
        const age = this.time.sub(e.z), delta = xz.sub(e.xy), r = length(delta);
        const width = wave.w.mul(0.7).add(age.mul(0.045));
        const front = r.sub(wave.z.mul(age));
        If(front.abs().lessThan(width.mul(2.6)), () => {
          const phase = wave.x.mul(r).sub(wave.y.mul(age));
          const falloff = exp(front.div(width).pow2().negate().sub(age.mul(1.8)));
          const radius = wave.w.mul(0.45);
          const spread = radius.div(r.add(radius)).sqrt();
          const slopeR = wave.x.mul(cos(phase)).sub(sin(phase).mul(front.mul(2).div(width.pow2()).add(float(0.5).div(r.add(radius)))));
          slope.addAssign(delta.div(r.max(0.0001)).mul(slopeR).mul(e.w).mul(falloff).mul(spread)
            .mul(smoothstep(0, 0.025, age)).mul(smoothstep(LIFETIME, LIFETIME - 0.3, age)));
        });
      });
      return slope;
    })();
  }
}

/** Feed sole/tread points and velocities in world coordinates. Reset on respawn or teleport. */
export class PuddleContact {
  private wet = false;
  private tracking = false;
  private x = 0;
  private y = 0;
  private z = 0;
  private untilNext = 0;

  constructor(private pool: PuddleContacts, readonly kind: ContactKind, readonly width: number) {}
  reset(): void { this.wet = false; this.tracking = false; this.untilNext = 0; }

  sample(point: Point, velocity: Point, dt: number, enabled = true): void {
    if (!enabled) { this.reset(); return; }
    if (!(dt > 0)) return;
    const dx = point.x - this.x, dz = point.z - this.z, distance = Math.hypot(dx, dz);
    const horizontal = Math.hypot(velocity.x, velocity.z);
    const spacing = Math.max(this.width * 1.3, 0.13, horizontal * 0.095);
    if (!this.tracking || distance > Math.min(12 * spacing, Math.max(1, horizontal * dt * 2.5))) {
      this.wet = false;
      this.test(point.x, point.y, point.z, horizontal, velocity.y);
      this.untilNext = spacing;
    } else if (this.kind === 'wheel' && distance > 0) {
      for (let d = this.untilNext; d <= distance; d += spacing) {
        const t = d / distance;
        this.test(this.x + dx * t, this.y + (point.y - this.y) * t, this.z + dz * t, horizontal, velocity.y);
        this.untilNext = d + spacing;
      }
      this.untilNext -= distance;
    } else {
      this.test(point.x, point.y, point.z, this.kind === 'foot' ? horizontal : 0, velocity.y);
    }
    this.x = point.x; this.y = point.y; this.z = point.z; this.tracking = true;
  }

  private test(x: number, y: number, z: number, horizontal: number, vertical: number): void {
    const surface = this.pool.surface;
    const depth = surface.puddleDepth(x, z);
    const immersed = depth > 0.0004 && y <= surface.heightAt(x, z) + depth + 0.001;
    const rolling = this.kind === 'wheel' && horizontal > 0.1;
    if (immersed && (rolling || !this.wet)) {
      const speed = rolling ? horizontal * 0.4 : Math.max(0, -vertical) + horizontal * 0.12;
      this.pool.deposit(x, z, depth, this.width, speed);
    }
    this.wet = immersed;
  }
}
