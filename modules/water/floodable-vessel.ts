import * as THREE from 'three/webgpu';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { RigidBody } from '../../engine/physics';
import { WorldSource } from '../../engine/world-bus';

export interface HullCompartment {
  center: THREE.Vector3;
  volume: number;
}
export interface FloodableHullOptions {
  draft: number;
  compartments: HullCompartment[];
}

/** Independent port/starboard and fore/aft reserves of buoyancy. Incoming water
 * removes local displacement; applying the remaining lift at each station creates list
 * and trim. This controller owns hydrostatics for the supplied rigid body. */
export class FloodableVessel implements EngineModule {
  readonly fill: Float64Array;
  readonly breaches: Float64Array;
  readonly bubbles: THREE.InstancedMesh;
  /** Local tangent plane through the sampled free surface. Its dot product with
   * a homogeneous world position is the signed vertical distance above water. */
  readonly waterline = new THREE.Vector4(0, 1, 0, 1e5);
  private readonly wakes = Array.from({ length: 2 }, () => ({
    source: new WorldSource(), center: new THREE.Vector3(), weight: 0, pressure: 0,
  }));
  readonly stats = { flooded: 0, submerged: 0, bubbles: 0, list: 0 };
  private readonly points: THREE.Vector3[];
  private readonly dropPositions = new Float32Array(48 * 3);
  private readonly dropAge = new Float32Array(48).fill(-1);
  private readonly dropLife = new Float32Array(48);
  private readonly rotation = new THREE.Quaternion();
  private readonly location = new THREE.Vector3();
  private readonly impulse = new THREE.Vector3();
  private readonly current = new THREE.Vector3();
  private readonly linear = new THREE.Vector3();
  private readonly angular = new THREE.Vector3();
  private readonly transform = new THREE.Object3D();
  private readonly unregister: () => void;
  private bubbleCarry = 0;
  private nextBubble = 0;
  private readonly volume: number;

  constructor(
    private engine: LuminaEngine,
    readonly body: RigidBody,
    readonly hull: FloodableHullOptions
  ) {
    if (!hull.compartments.length || !(hull.draft > 0) || hull.compartments.some((c) => !(c.volume > 0)))
      throw new RangeError('Hull compartments require positive displacement and draft');
    this.fill = new Float64Array(hull.compartments.length);
    this.breaches = new Float64Array(this.fill.length);
    this.points = hull.compartments.map(() => new THREE.Vector3());
    this.volume = hull.compartments.reduce((v, c) => v + c.volume, 0);
    this.bubbles = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshPhysicalNodeMaterial({
        color: 0xadcfd2,
        roughness: 0.11,
        metalness: 0.65,
        transparent: true,
        opacity: 0.64,
        depthWrite: false,
      }),
      48
    );
    this.bubbles.count = 0;
    this.bubbles.frustumCulled = false;
    engine.scene.add(this.bubbles);
    this.unregister = engine.physics.addPreStep((dt) => this.apply(dt));
  }
  damage(index: number, opening = 0.075): void {
    if (index >= 0 && index < this.fill.length)
      this.breaches[index] = Math.max(0, this.breaches[index] + opening);
  }
  repair(): void {
    this.fill.fill(0);
    this.breaches.fill(0);
  }
  private apply(dt: number): void {
    this.body.translation(this.location);
    this.body.rotation(this.rotation);
    this.body.linvel(this.linear);
    this.body.angvel(this.angular);
    // Fit the waterline to the actual compartment probes; origin-relative
    // moments retain precision when the vessel is far from the world origin.
    let n = 0, x = 0, z = 0, y = 0, xx = 0, zz = 0, xz = 0, xy = 0, zy = 0;
    for (const wake of this.wakes) { wake.center.set(0, 0, 0); wake.weight = wake.pressure = 0; }
    let volumeLost = 0,
      sub = 0;
    for (let i = 0; i < this.fill.length; i++) {
      const c = this.hull.compartments[i],
        p = this.points[i].copy(c.center).applyQuaternion(this.rotation).add(this.location);
      const h = this.engine.world.waterHeight(p.x, p.z, this.current);
      const rx = p.x - this.location.x, ry = p.y - this.location.y, rz = p.z - this.location.z;
      if (Number.isFinite(h)) {
        const dy = h - this.location.y;
        n++; x += rx; z += rz; y += dy; xx += rx * rx; zz += rz * rz;
        xz += rx * rz; xy += rx * dy; zy += rz * dy;
      }
      const depth = h - p.y;
      const immersion = Math.max(0, Math.min(1, 0.5 + depth / this.hull.draft));
      const ingress = this.breaches[i] * Math.sqrt(2 * 9.81 * Math.max(0, depth + this.hull.draft * 0.37));
      this.fill[i] = Math.min(1, this.fill[i] + (ingress * dt) / c.volume);
      volumeLost += this.fill[i] * c.volume;
      sub += immersion;
      if (immersion <= 0) continue;
      const vx = this.linear.x - this.current.x + this.angular.y * rz - this.angular.z * ry;
      const vy = this.linear.y - this.current.y + this.angular.z * rx - this.angular.x * rz;
      const vz = this.linear.z - this.current.z + this.angular.x * ry - this.angular.y * rx;
      // A moving waterline exchanges momentum with the surrounding surface.
      // Keep port and starboard separate so rolling produces opposing waves.
      const contact = c.volume * (1 - this.fill[i]) * 4 * immersion * (1 - immersion);
      if (contact > 0) {
        const wake = this.wakes[c.center.x < 0 ? 0 : 1];
        wake.weight += contact;
        wake.center.x += p.x * contact; wake.center.y += h * contact; wake.center.z += p.z * contact;
        wake.pressure += contact * (-1.8 * vy + 0.06 * (vx * vx + vz * vz));
      }
      const drag = ((Math.min(0.12, dt * 1.8) * this.body.mass()) / this.fill.length) * immersion;
      this.impulse.set(
        -vx * drag,
        (1 - this.fill[i]) * immersion * c.volume * 1000 * 9.81 * dt - vy * drag * 2.4,
        -vz * drag
      );
      this.body.applyImpulseAtPoint(this.impulse, p, true);
      if (this.breaches[i] > 0 && depth > 0 && this.fill[i] < 1) {
        this.bubbleCarry += Math.min(35, ingress * 130) * dt;
        while (this.bubbleCarry >= 1) {
          this.bubbleCarry--;
          const b = this.nextBubble++ % 48;
          this.dropPositions[b * 3] = p.x + Math.sin(b * 8.31) * 0.085;
          this.dropPositions[b * 3 + 1] = p.y;
          this.dropPositions[b * 3 + 2] = p.z + Math.cos(b * 4.76) * 0.085;
          this.dropAge[b] = 0;
          this.dropLife[b] = Math.min(6, depth / (0.65 + 0.006 * b));
        }
      }
    }
    if (n) {
      const varX = xx - x * x / n, varZ = zz - z * z / n, cov = xz - x * z / n;
      const covX = xy - x * y / n, covZ = zy - z * y / n;
      const det = varX * varZ - cov * cov;
      // A single point only gives elevation. Collinear stations also give
      // slope along their line; use its minimum-norm solution.
      const trace = varX + varZ;
      const sx = det > 1e-7 * trace * trace ? (covX * varZ - covZ * cov) / det : trace > 1e-8 ? covX / trace : 0;
      const sz = det > 1e-7 * trace * trace ? (covZ * varX - covX * cov) / det : trace > 1e-8 ? covZ / trace : 0;
      this.waterline.set(-sx, 1, -sz, sx * (this.location.x + x/n) + sz * (this.location.z + z/n) - this.location.y - y/n);
    } else this.waterline.set(0, 1, 0, 1e5);
    for (const wake of this.wakes) {
      const load = THREE.MathUtils.clamp(wake.pressure, -3, 4);
      if (wake.weight > 1e-4 && Math.abs(load) > 0.035) {
        const p = wake.center.multiplyScalar(1 / wake.weight);
        const source = wake.source.at(p.x, p.y, p.z);
        source.radius = Math.max(this.hull.draft, 1.4 * Math.cbrt(wake.weight));
        source.pressure = load;
        source.wetness = Math.min(0.6, Math.abs(load) * 0.22);
        this.engine.world.publish(source);
      } else this.engine.world.removeSource(wake.source);
    }
    this.stats.flooded = volumeLost / this.volume;
    this.stats.submerged = sub / this.fill.length;
    this.stats.list = Math.asin(
      THREE.MathUtils.clamp(2 * (this.rotation.w * this.rotation.z + this.rotation.x * this.rotation.y), -1, 1)
    );
  }
  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < 48; i++) {
      if (this.dropAge[i] < 0) continue;
      const age = (this.dropAge[i] += dt);
      if (age > this.dropLife[i]) {
        this.dropAge[i] = -1;
        continue;
      }
      const k = i * 3;
      this.transform.position.set(
        this.dropPositions[k] + 0.06 * Math.sin(age * 5 + i),
        this.dropPositions[k + 1] + age * (0.65 + 0.006 * i),
        this.dropPositions[k + 2] + 0.04 * Math.cos(age * 6 + i)
      );
      this.transform.scale.setScalar((0.023 + (i % 6) * 0.008) * (1 + 0.11 * age));
      this.transform.updateMatrix();
      this.bubbles.setMatrixAt(n++, this.transform.matrix);
    }
    this.bubbles.count = n;
    this.bubbles.instanceMatrix.needsUpdate = n > 0;
    this.stats.bubbles = n;
  }
  dispose(): void {
    this.unregister();
    for (const wake of this.wakes) this.engine.world.removeSource(wake.source);
    this.bubbles.removeFromParent();
    this.bubbles.geometry.dispose();
    (this.bubbles.material as THREE.Material).dispose();
    this.bubbles.dispose();
  }
}
