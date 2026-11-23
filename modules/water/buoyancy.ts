/**
 * Multi-point buoyancy + hydrodynamic drag on Rapier rigid bodies.
 *
 * Each sample point owns a slice of displaced volume. Every fixed step the ocean surface
 * (FFT swell with choppy inversion + tsunami) is sampled under each point; Archimedes
 * lift, linear + quadratic drag against the local water velocity and a slamming term are
 * applied at that point, so hulls pitch over swells, roll in chop and are picked up and
 * thrown by breaking mega-waves.
 */
import * as THREE from 'three/webgpu';
import { RapierScratch, type PhysicsWorld, type RigidBody } from '../../engine/physics';
import { OceanHeightBatch, type Ocean } from './ocean';

export interface BuoyancyOptions {
  /** Sample points in body-local space. */
  points: THREE.Vector3[];
  /** Total displaced volume (m³) when every point is fully submerged. */
  volume: number;
  /** Vertical distance over which a point goes from dry to fully submerged (m). */
  draft?: number;
  /** Linear drag coefficient per point (N·s/m per unit submersion). */
  linearDrag?: number;
  /** Quadratic drag coefficient per point (N·s²/m²). */
  quadraticDrag?: number;
  /**
   * Heave damping ratio ζ of the float "springs" (1 = critically damped: the hull settles
   * onto a swell without bobbing or buzzing). The damper strength is derived from the
   * body mass and the hydrostatic stiffness ρ·g·V/draft, so it is right for any hull.
   */
  heaveDamping?: number;
  /** Lateral (keel) drag multiplier: resists sideways slip. */
  keel?: number;
}

export interface BuoyancyState {
  /** 0..1 mean submersion of all points. */
  submersion: number;
  /** Per-point submersion (0..1). */
  pointSubmersion: Float32Array;
  /** Last sampled free-surface height in world metres at each hull point. */
  surfaceHeights: Float32Array;
  /** Per-point world positions (updated every step). */
  pointWorld: THREE.Vector3[];
  /** Per-point vertical impact speed this step (m/s, >0 when slamming down into water). */
  slam: Float32Array;
}

const WATER_DENSITY = 1025;
const ARCHIMEDES_SCALE = WATER_DENSITY * 9.81;
const _flow = new THREE.Vector3();
const _t = new RapierScratch(), _r = new RapierScratch();
const _lv = new RapierScratch(), _av = new RapierScratch(), _com = new RapierScratch();
const _force = new RapierScratch(), _torque = new RapierScratch();

export class BuoyantBody {
  readonly state: BuoyancyState;
  private options: Required<BuoyancyOptions>;
  private unregister: () => void;
  /** Per-point vertical damper (N·s/m). */
  private heaveC: number;
  private readonly localPoints: Float32Array;
  private readonly pointCount: number;
  private readonly invPointCount: number;
  private readonly invDraft: number;
  private readonly archimedesPerPoint: number;
  private readonly lastSurface: Float32Array;
  private readonly surfaceRate: Float32Array;
  private readonly waterVelocity: Float64Array;
  private readonly worldCoordinates: Float64Array;
  private hadCurrent = false;
  private readonly right = new Float64Array(3);
  private readonly probes: OceanHeightBatch;
  private initialized = false;

  constructor(physics: PhysicsWorld, private ocean: Ocean, readonly body: RigidBody, options: BuoyancyOptions) {
    this.options = { draft: 0.6, linearDrag: 900, quadraticDrag: 260, heaveDamping: 1, keel: 4, ...options };
    const n = this.pointCount = options.points.length;
    this.invPointCount = 1 / n;
    this.invDraft = 1 / this.options.draft;
    this.archimedesPerPoint = ARCHIMEDES_SCALE * (this.options.volume * this.invPointCount);
    // c = 2·ζ·√(k·m), shared equally by the sample points.
    const stiffness = (ARCHIMEDES_SCALE * this.options.volume) * this.invDraft;
    this.heaveC = (2 * this.options.heaveDamping * Math.sqrt(stiffness * body.mass())) * this.invPointCount;

    const lp = this.localPoints = new Float32Array(n * 3);
    const pointWorld: THREE.Vector3[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const pt = options.points[i];
      lp[i * 3] = pt.x; lp[i * 3 + 1] = pt.y; lp[i * 3 + 2] = pt.z;
      pointWorld[i] = new THREE.Vector3();
    }
    this.probes = new OceanHeightBatch(n);
    this.waterVelocity = new Float64Array(n * 2);
    this.worldCoordinates = new Float64Array(n * 3);
    this.lastSurface = new Float32Array(n);
    this.surfaceRate = new Float32Array(n);
    this.state = { surfaceHeights: this.lastSurface, submersion: 0, pointSubmersion: new Float32Array(n), pointWorld, slam: new Float32Array(n) };
    this.unregister = physics.addPreStep((dt) => this.apply(dt));
  }

  private apply(dt: number): void {
    const { body, ocean, state } = this;
    body.translation(_t);
    body.rotation(_r);
    const tx = _t.x, ty = _t.y, tz = _t.z;
    const qx = _r.x, qy = _r.y, qz = _r.z, qw = _r.w;

    // 3×3 rotation matrix from unit quaternion (batched transform for all hull points).
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const m00 = 1 - (yy + zz), m01 = xy - wz, m02 = xz + wy;
    const m10 = xy + wz, m11 = 1 - (xx + zz), m12 = yz - wx;
    const m20 = xz - wy, m21 = yz + wx, m22 = 1 - (xx + yy);
    // Body-local +X axis in world space (keel normal) is column 0 of the rotation matrix.
    this.right[0] = m00; this.right[1] = m10; this.right[2] = m20;

    body.resetForces(true);
    body.resetTorques(true);

    const n = this.pointCount;
    const lp = this.localPoints;
    const pointWorld = state.pointWorld;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const lx = lp[j], ly = lp[j + 1], lz = lp[j + 2];
      const px = m00 * lx + m01 * ly + m02 * lz + tx;
      const py = m10 * lx + m11 * ly + m12 * lz + ty;
      const pz = m20 * lx + m21 * ly + m22 * lz + tz;
      const point = pointWorld[i];
      const xyz = this.worldCoordinates;
      point.x = xyz[j] = px; point.y = xyz[j + 1] = py; point.z = xyz[j + 2] = pz;
    }
    ocean.heightsAt(pointWorld, this.probes);
    const heights = this.probes.heights;
    const { pointSubmersion, slam } = state;
    const withFlow = ocean.tsunami.active;
    if (this.hadCurrent && !withFlow) this.waterVelocity.fill(0);
    this.hadCurrent = withFlow;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const point = pointWorld[i];
      const sub = Math.max(0, Math.min(1, (heights[i] - point.y) * this.invDraft + 0.5));
      pointSubmersion[i] = sub;
      total += sub;
      slam[i] = 0;
      if (!this.initialized || sub === 0) this.lastSurface[i] = heights[i];
      if (withFlow && sub > 0) {
        ocean.flowAt(point.x, point.z, _flow);
        this.waterVelocity[i * 2] = _flow.x;
        this.waterVelocity[i * 2 + 1] = _flow.z;
      }
    }
    state.submersion = total * this.invPointCount;
    this.initialized = true;
    if (total > 0) this.applyWaterForces(dt);
  }

  private applyWaterForces(dt: number): void {
    // Read kinematics once outside the integration kernel so the live force and
    // torque accumulators never cross a JS-to-Wasm or wave-sampler call.
    const { body, state, options } = this;
    body.linvel(_lv);
    body.angvel(_av);
    body.worldCom(_com);
    const lvX = _lv[0], lvY = _lv[1], lvZ = _lv[2];
    const avX = _av[0], avY = _av[1], avZ = _av[2];
    const comX = _com[0], comY = _com[1], comZ = _com[2];
    const rightX = this.right[0], rightY = this.right[1], rightZ = this.right[2];
    const invDt = 1 / dt, archimedesPerPoint = this.archimedesPerPoint, heaveC = this.heaveC;
    const { linearDrag, quadraticDrag, keel } = options;
    const { pointSubmersion, slam: slamArr } = state;
    const xyz = this.worldCoordinates;
    const { lastSurface, surfaceRate: surfaceRateArr, waterVelocity } = this;
    const heights = this.probes.heights;
    let netFx = 0, netFy = 0, netFz = 0;
    let netTx = 0, netTy = 0, netTz = 0;
    for (let i = 0; i < this.pointCount; i++) {
      const sub = pointSubmersion[i];
      if (sub === 0) continue;
      const k3 = i * 3, k2 = i * 2;
      const surface = heights[i];
      const rx = xyz[k3] - comX, ry = xyz[k3 + 1] - comY, rz = xyz[k3 + 2] - comZ;
      const vx = lvX + avY * rz - avZ * ry - waterVelocity[k2];
      const vy = lvY + avZ * rx - avX * rz;
      const vz = lvZ + avX * ry - avY * rx - waterVelocity[k2 + 1];
      if (vy < -1.2 && sub < 0.6) slamArr[i] = -vy;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      // Archimedes.
      let fy = archimedesPerPoint * sub;
      // Drag: relative to the moving water, so a tsunami bore carries the hull with it.
      const k = (linearDrag + quadraticDrag * speed) * sub;
      let fx = -vx * k, fz = -vz * k;
      // Vertical damper acts on the hull's motion *relative to the rising / falling surface*,
      // so the hull follows swells instead of fighting them. Engages fully once a point is wet.
      // (The CPU wave twin advances once per rendered frame, so the raw rate is low-passed.)
      const rate = surfaceRateArr[i] + ((surface - lastSurface[i]) * invDt - surfaceRateArr[i]) * 0.2;
      surfaceRateArr[i] = rate;
      lastSurface[i] = surface;
      const wet = sub * 4 < 1 ? sub * 4 : 1;
      const clampedRate = rate < -6 ? -6 : rate > 6 ? 6 : rate;
      fy -= (vy - clampedRate) * heaveC * wet + vy * quadraticDrag * (vy < 0 ? -vy : vy) * sub;
      // Keel: extra resistance to sideways slip.
      const lateral = vx * rightX + vy * rightY + vz * rightZ;
      const lk = lateral * k * keel;
      fx -= rightX * lk;
      fz -= rightZ * lk;

      // Batch force and torque around world CoM into a single Rapier update per body.
      netFx += fx; netFy += fy; netFz += fz;
      netTx += ry * fz - rz * fy;
      netTy += rz * fx - rx * fz;
      netTz += rx * fy - ry * fx;
    }
    _force[0] = netFx; _force[1] = netFy; _force[2] = netFz;
    _torque[0] = netTx; _torque[1] = netTy; _torque[2] = netTz;
    body.addForce(_force, true);
    body.addTorque(_torque, true);
  }

  dispose(): void { this.unregister(); }
}
