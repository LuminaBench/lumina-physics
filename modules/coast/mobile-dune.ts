import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { DuneStrata, type DuneLens, type StrataSave } from './dune-strata';
export type { DuneLens } from './dune-strata';

export interface DuneOptions {
  centerX: number;
  centerZ: number;
  size: number;
  resolution?: number;
  seed: number;
  /** Undisturbed loose layer above the compact bed, in metres. */
  thicknessAt(x: number, z: number): number;
  /** Coarse fraction of loose sediment by volume. */
  coarseFractionAt?(x: number, z: number): number;
  /** Coarse-grain transport relative to fine grains in strong wind, from 0 to 1. */
  coarseMobility?: number;
  /** Initial downwind ripple direction in radians from +X toward +Z. */
  rippleHeading?: number;
  /** Optional finite buried lens. Disturbed grains retain their mineral identity in the spoil. */
  lens?: DuneLens;
  rootsAt?(x: number, z: number): number;
  protectedAt?(x: number, z: number): boolean;
  drySlopeDeg?: number;
}
interface DuneSnapshot {
  seed: number;
  centerX: number;
  centerZ: number;
  size: number;
  resolution: number;
  /** Tenths of a millimetre above the compact bed, in row-major order. */
  thickness: number[];
}
export type DuneSave = DuneSnapshot &
  (
    | { version: 1 }
    | (({ version: 2 } | { version: 3; strata: StrataSave }) & {
        coarse: number[];
        rippleHeading: number;
        remainder: number;
      })
  );
const clamp = THREE.MathUtils.clamp;
/** Fixed-size active dune. A node exchanges loose sand only with another node in the same
 * control volume. The outer ring is the immutable join to the surrounding terrain. */
export class MobileDune {
  readonly resolution: number;
  readonly spacing: number;
  readonly originX: number;
  readonly originZ: number;
  readonly texture: THREE.DataTexture;
  readonly geometry: THREE.PlaneGeometry;
  private readonly undisturbed: Float32Array;
  private readonly composition: Uint8Array;
  private readonly compositionMap: THREE.DataTexture;
  private readonly originalFraction: Float32Array;
  readonly coarseDepth: Float32Array;
  private readonly coarseDelta: Float32Array;
  readonly rippleAxis: N;
  private heading: number;
  readonly mobile: Float32Array;
  readonly compact: Float32Array;
  private readonly roots: Float32Array;
  private readonly locked: Uint8Array;
  private readonly delta: Float32Array;
  private readonly planes: Float32Array;
  private readonly positions: THREE.BufferAttribute;
  private readonly origin;
  readonly strata?: DuneStrata;
  private readonly slope: number;
  private elapsed = 0;
  revision = 0;

  constructor(
    readonly options: DuneOptions,
    ground: (x: number, z: number) => number,
  ) {
    const n = (this.resolution = options.resolution ?? 65);
    const angle = options.drySlopeDeg ?? 32;
    const mobility = options.coarseMobility ?? 0.22;
    this.heading = options.rippleHeading ?? 0;
    if (
      !Number.isInteger(n) ||
      n < 5 ||
      n > 193 ||
      !Number.isFinite(options.size) ||
      options.size <= 0 ||
      ![options.centerX, options.centerZ, angle, mobility, this.heading].every(Number.isFinite) ||
      mobility < 0 ||
      mobility > 1 ||
      angle < 12 ||
      angle > 55 ||
      !Number.isInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > 0xffffffff
    )
      throw new RangeError('Invalid dune extent, slope, seed or resolution');
    const cells = n * n;
    this.spacing = options.size / (n - 1);
    this.originX = options.centerX - options.size / 2;
    this.originZ = options.centerZ - options.size / 2;
    this.slope = Math.tan((angle * Math.PI) / 180);
    this.origin = TSL.uniform(new THREE.Vector2(this.originX, this.originZ));
    this.rippleAxis = TSL.uniform(new THREE.Vector2(Math.cos(this.heading), Math.sin(this.heading)));
    this.mobile = new Float32Array(cells);
    this.coarseDepth = new Float32Array(cells);
    this.coarseDelta = new Float32Array(cells);
    this.originalFraction = new Float32Array(cells);
    this.compact = new Float32Array(cells);
    this.roots = new Float32Array(cells);
    this.locked = new Uint8Array(cells);
    this.delta = new Float32Array(cells);
    this.planes = new Float32Array(4 * cells);
    for (let z = 0, i = 0; z < n; z++)
      for (let x = 0; x < n; x++, i++) {
        const wx = this.originX + x * this.spacing,
          wz = this.originZ + z * this.spacing;
        const bed = ground(wx, wz),
          cover = options.thicknessAt(wx, wz),
          roots = options.rootsAt?.(wx, wz) ?? 0,
          coarse = options.coarseFractionAt?.(wx, wz) ?? 0.18;
        if (
          ![bed, cover, roots, coarse].every(Number.isFinite) ||
          cover < 0 ||
          roots < 0 ||
          roots > 1 ||
          coarse < 0 ||
          coarse > 1
        )
          throw new RangeError('Invalid dune sample');
        this.compact[i] = bed;
        const locked = x === 0 || z === 0 || x === n - 1 || z === n - 1 || !!options.protectedAt?.(wx, wz);
        this.locked[i] = Number(locked);
        this.mobile[i] = locked ? 0 : cover;
        this.originalFraction[i] = coarse;
        this.coarseDepth[i] = this.mobile[i] * coarse;
        this.roots[i] = roots;
      }
    this.undisturbed = this.mobile.slice();
    if (options.lens) {
      this.strata = new DuneStrata(
        options.lens,
        n,
        this.originX,
        this.originZ,
        this.spacing,
        this.compact,
        this.undisturbed,
        this.originalFraction,
      );
      this.strata.finish(this.mobile, this.coarseDepth);
    }
    this.composition = new Uint8Array(4 * cells);
    this.compositionMap = new THREE.DataTexture(this.composition, n, n);
    this.compositionMap.minFilter = this.compositionMap.magFilter = THREE.LinearFilter;
    this.texture = new THREE.DataTexture(this.planes, n, n, THREE.RGBAFormat, THREE.FloatType);
    this.geometry = new THREE.PlaneGeometry(options.size, options.size, n - 1, n - 1);
    this.geometry.rotateX(-Math.PI / 2);
    this.positions = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.publish();
  }
  private publish() {
    const n = this.resolution,
      m = this.mobile;
    for (let z = 0, i = 0; z < n; z++)
      for (let x = 0; x < n; x++, i++) {
        const right = i + Number(x < n - 1),
          next = i + (z < n - 1 ? n : 0),
          diag = next + (right - i);
        // A naturally bare edge stays the surrounding material. Expose a compact seam
        // only where excavation removed loose cover and the compact bed is now shallow.
        const removed = THREE.MathUtils.smoothstep(this.undisturbed[i] - m[i], 0.035, 0.13);
        const shallow = 1 - THREE.MathUtils.smoothstep(m[i], 0.015, 0.1);
        const cover = THREE.MathUtils.smoothstep(m[i], 0.001, 0.065);
        this.composition[4 * i] = Math.round(255 * removed * shallow);
        this.composition[4 * i + 1] = m[i] > 0 ? Math.round((255 * cover * this.coarseDepth[i]) / m[i]) : 0;
        this.composition[4 * i + 2] = Math.round(255 * cover);
        this.planes[4 * i] = m[i];
        this.planes[4 * i + 1] = m[right] - m[i];
        this.planes[4 * i + 2] = m[next] - m[i];
        this.planes[4 * i + 3] = m[diag] + m[i] - m[right] - m[next];
        this.positions.setY(i, this.compact[i] + m[i]);
      }
    this.strata?.publish();
    this.compositionMap.needsUpdate = this.texture.needsUpdate = true;
    this.positions.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.revision++;
  }
  contains(x: number, z: number) {
    return (
      x >= this.originX &&
      z >= this.originZ &&
      x <= this.originX + this.options.size &&
      z <= this.originZ + this.options.size
    );
  }
  depthAt(x: number, z: number) {
    if (!this.contains(x, z)) return 0;
    const gx = (x - this.originX) / this.spacing,
      gz = (z - this.originZ) / this.spacing,
      n = this.resolution;
    const ix = Math.min(n - 2, Math.floor(gx)),
      iz = Math.min(n - 2, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz,
      k = 4 * (iz * n + ix);
    return (
      this.planes[k] +
      u * this.planes[k + 1] +
      v * this.planes[k + 2] +
      Math.max(0, u + v - 1) * this.planes[k + 3]
    );
  }
  exposedNode(xz: N): N {
    return this.compositionNode(xz).r;
  }
  /** R compact-bed exposure, G cover-weighted coarse fraction, B loose-sand coverage. */
  compositionNode(xz: N): N {
    const uv = xz.sub(this.origin).div(this.spacing).add(0.5).div(this.resolution);
    return TSL.texture(this.compositionMap, uv).level(0);
  }
  depthNode = (xz: N): N => {
    const n = this.resolution,
      grid = xz
        .sub(this.origin)
        .div(this.spacing)
        .clamp(0, n - 1);
    const cell = grid.floor().min(n - 2),
      uv = grid.sub(cell),
      p = TSL.texture(this.texture, cell.add(0.5).div(n)).level(0);
    return p.r
      .add(p.g.mul(uv.x))
      .add(p.b.mul(uv.y))
      .add(p.a.mul(uv.x.add(uv.y).sub(1).max(0)));
  };
  /** Bulk volume in cubic metres. All mobile nodes are interior nodes of equal area. */
  volume() {
    let total = 0;
    for (const h of this.mobile) total += h;
    return total * this.spacing * this.spacing;
  }
  /** Remove a strip and place its spoil at a world-space offset. Returns transferred m³. */
  cut(
    x: number,
    z: number,
    length: number,
    width: number,
    yaw: number,
    depth: number,
    offsetX: number,
    offsetZ: number,
    footprint: 'strip' | 'scoop' = 'strip',
  ) {
    if (
      (footprint !== 'strip' && footprint !== 'scoop') ||
      ![x, z, length, width, yaw, depth, offsetX, offsetZ].every(Number.isFinite) ||
      width <= 0 ||
      length <= 0 ||
      depth < 0
    )
      throw new RangeError('Expected a finite cut with positive dimensions');
    const n = this.resolution,
      dx = Math.round(offsetX / this.spacing),
      dz = Math.round(offsetZ / this.spacing);
    if (dx === 0 && dz === 0) return 0;
    const cosine = Math.cos(yaw),
      sine = Math.sin(yaw),
      radius = Math.hypot(length, width) / 2;
    const xmin = Math.max(1, Math.ceil((x - radius - this.originX) / this.spacing)),
      xmax = Math.min(n - 2, Math.floor((x + radius - this.originX) / this.spacing));
    const zmin = Math.max(1, Math.ceil((z - radius - this.originZ) / this.spacing)),
      zmax = Math.min(n - 2, Math.floor((z + radius - this.originZ) / this.spacing));
    this.delta.fill(0);
    this.coarseDelta.fill(0);
    let moved = 0;
    for (let iz = zmin; iz <= zmax; iz++)
      for (let ix = xmin; ix <= xmax; ix++) {
        const tx = ix + dx,
          tz = iz + dz,
          i = ix + n * iz,
          j = tx + n * tz;
        if (tx < 1 || tz < 1 || tx >= n - 1 || tz >= n - 1 || this.locked[i] || this.locked[j]) continue;
        const rx = this.originX + ix * this.spacing - x,
          rz = this.originZ + iz * this.spacing - z;
        const cross = (Math.abs(rx * cosine - rz * sine) * 2) / width,
          along = (Math.abs(rx * sine + rz * cosine) * 2) / length;
        if (cross >= 1 || along >= 1) continue;
        const profile =
          footprint === 'scoop'
            ? Math.max(0, 1 - cross * cross - along * along)
            : Math.min(1, (1 - cross) * 5, (1 - along) * 5);
        const amount = Math.min(this.mobile[i], depth * profile);
        if (this.strata) {
          moved += this.strata.transfer(i, j, amount, 1);
          continue;
        }
        const gravel = this.mobile[i] > 0 ? amount * (this.coarseDepth[i] / this.mobile[i]) : 0;
        this.coarseDelta[i] -= gravel;
        this.coarseDelta[j] += gravel;
        this.delta[i] -= amount;
        this.delta[j] += amount;
        moved += amount;
      }
    if (moved > 0) {
      if (this.strata) this.strata.finish(this.mobile, this.coarseDepth);
      else
        for (let i = 0; i < this.mobile.length; i++) {
          this.mobile[i] += this.delta[i];
          this.coarseDepth[i] = clamp(this.coarseDepth[i] + this.coarseDelta[i], 0, this.mobile[i]);
        }
      this.publish();
    }
    return moved * this.spacing * this.spacing;
  }
  private exchange(i: number, j: number, wind: number, damp: number, mobility: number) {
    if (this.locked[i] || this.locked[j]) return;
    const m = this.mobile,
      grade = this.compact[i] + m[i] - this.compact[j] - m[j];
    const roots = this.roots[grade >= 0 ? i : j];
    const excess = Math.max(0, Math.abs(grade) - this.spacing * (this.slope + 0.38 * damp + 0.72 * roots));
    const gravity = Math.sign(grade) * excess * 0.17;
    const donor = wind >= 0 ? i : j;
    const upstream = donor + (wind >= 0 ? i - j : j - i);
    const obstacle = this.compact[upstream] + m[upstream] - this.compact[donor] - m[donor];
    const shelter = clamp(1 - (1.8 * Math.max(0, obstacle)) / this.spacing, 0.08, 1);
    const drift = wind * (1 - damp) * (1 - damp) * (1 - this.roots[donor]) * shelter;
    // Gravity carries the donor mixture. Wind preferentially entrains fine grains.
    // Bound each species independently on the four faces before simultaneous transfer.
    const coarse = this.coarseDepth,
      downhill = grade >= 0 ? i : j;
    if (this.strata) {
      const other = downhill === i ? j : i,
        downwind = donor === i ? j : i;
      const slump = this.strata.transfer(downhill, other, Math.min(Math.abs(gravity), 0.24 * m[downhill]), 1);
      const blown = this.strata.transfer(
        donor,
        downwind,
        Math.min(Math.abs(drift), 0.24 * m[donor]),
        mobility,
      );
      return slump + blown > 0;
    }
    const slopeFraction = m[downhill] > 0 ? coarse[downhill] / m[downhill] : 0;
    const windFraction = m[donor] > 0 ? coarse[donor] / m[donor] : 0;
    const gravel = clamp(
      gravity * slopeFraction + drift * windFraction * mobility,
      -0.24 * coarse[j],
      0.24 * coarse[i],
    );
    const fine = clamp(
      gravity * (1 - slopeFraction) + drift * (1 - windFraction),
      -0.24 * (m[j] - coarse[j]),
      0.24 * (m[i] - coarse[i]),
    );
    const flow = gravel + fine;
    this.coarseDelta[i] -= gravel;
    this.coarseDelta[j] += gravel;
    this.delta[i] -= flow;
    this.delta[j] += flow;
  }
  update(dt: number, windX: number, windZ: number, damp: number) {
    if (
      !Number.isFinite(dt) ||
      !Number.isFinite(windX) ||
      !Number.isFinite(windZ) ||
      !Number.isFinite(damp) ||
      dt < 0
    )
      throw new RangeError('Invalid dune step');
    this.elapsed += Math.min(0.5, dt);
    const ticks = Math.floor(this.elapsed * 12 + 1e-8);
    if (!ticks) return false;
    this.elapsed = Math.max(0, this.elapsed - ticks / 12);
    const speed = Math.hypot(windX, windZ);
    const transport = Math.min(0.0009, Math.max(0, speed - 5) * 0.000055) / Math.max(1, speed);
    const n = this.resolution;
    damp = clamp(damp, 0, 1);
    const mobility = (this.options.coarseMobility ?? 0.22) * THREE.MathUtils.smoothstep(speed, 7, 15);
    if (speed > 5 && damp < 1) {
      const goal = Math.atan2(windZ, windX),
        turn = Math.atan2(Math.sin(goal - this.heading), Math.cos(goal - this.heading));
      const rate = Math.min(1, (speed - 5) * 0.014) * (1 - damp) ** 2;
      this.heading += turn * -Math.expm1((-ticks * rate) / 12);
      this.rippleAxis.value.set(Math.cos(this.heading), Math.sin(this.heading));
    }
    let changed = false;
    for (let k = 0; k < ticks; k++) {
      this.delta.fill(0);
      this.coarseDelta.fill(0);
      for (let z = 1; z < n - 1; z++)
        for (let x = 1; x < n - 1; x++) {
          const i = x + z * n;
          if (this.exchange(i, i + 1, windX * transport, damp, mobility)) changed = true;
          if (this.exchange(i, i + n, windZ * transport, damp, mobility)) changed = true;
        }
      if (this.strata) {
        this.strata.finish(this.mobile, this.coarseDepth);
        continue;
      }
      for (let i = 0; i < this.mobile.length; i++) {
        const d = this.delta[i];
        if (d !== 0 || this.coarseDelta[i] !== 0) {
          this.mobile[i] += d;
          this.coarseDepth[i] = clamp(this.coarseDepth[i] + this.coarseDelta[i], 0, this.mobile[i]);
          changed = true;
        }
      }
    }
    if (changed) this.publish();
    return changed;
  }
  reset() {
    this.elapsed = 0;
    this.heading = this.options.rippleHeading ?? 0;
    this.rippleAxis.value.set(Math.cos(this.heading), Math.sin(this.heading));
    this.mobile.set(this.undisturbed);
    for (let i = 0; i < this.mobile.length; i++)
      this.coarseDepth[i] = this.mobile[i] * this.originalFraction[i];
    if (this.strata) {
      this.strata.reset();
      this.strata.finish(this.mobile, this.coarseDepth);
    }
    this.publish();
  }
  save(): DuneSave {
    const { seed, centerX, centerZ, size } = this.options;
    return {
      ...(this.strata ? { version: 3 as const, strata: this.strata.save() } : { version: 2 as const }),
      seed,
      centerX,
      centerZ,
      size,
      resolution: this.resolution,
      thickness: Array.from(this.mobile, (h) => Math.round(h * 10000)),
      coarse: Array.from(this.coarseDepth, (h) => Math.round(h * 10000)),
      rippleHeading: this.heading,
      remainder: this.elapsed,
    };
  }
  restore(save: DuneSave) {
    if (
      !save ||
      (save.version !== 1 && save.version !== 2 && !(save.version === 3 && this.strata)) ||
      save.seed !== this.options.seed ||
      save.centerX !== this.options.centerX ||
      save.centerZ !== this.options.centerZ ||
      save.size !== this.options.size ||
      save.resolution !== this.resolution ||
      !Array.isArray(save.thickness) ||
      save.thickness.length !== this.mobile.length ||
      !save.thickness.length
    )
      throw new RangeError('Incompatible dune save');
    if (
      save.version !== 1 &&
      (!Array.isArray(save.coarse) ||
        save.coarse.length !== this.mobile.length ||
        !Number.isFinite(save.rippleHeading) ||
        !Number.isFinite(save.remainder) ||
        save.remainder < 0 ||
        save.remainder >= 1 / 12)
    )
      throw new RangeError('Invalid dune composition or clock');
    for (let i = 0; i < this.mobile.length; i++) {
      const v = save.thickness[i];
      if (!Number.isSafeInteger(v) || v < 0 || (this.locked[i] && v !== 0))
        throw new RangeError('Invalid dune layer depth');
      if (
        save.version !== 1 &&
        (!Number.isSafeInteger(save.coarse[i]) || save.coarse[i] < 0 || save.coarse[i] > v)
      )
        throw new RangeError('Invalid coarse sediment thickness');
    }
    if (save.version === 3) this.strata!.restore(save.strata, save.thickness, save.coarse, this.locked);
    for (let i = 0; i < this.mobile.length; i++) {
      this.mobile[i] = save.thickness[i] / 10000;
      this.coarseDepth[i] =
        save.version !== 1 ? save.coarse[i] / 10000 : this.mobile[i] * this.originalFraction[i];
    }
    if (this.strata) {
      if (save.version !== 3) this.strata.migrate(this.mobile, this.coarseDepth, save.version === 2);
      this.strata.finish(this.mobile, this.coarseDepth);
    }
    this.elapsed = save.version !== 1 ? save.remainder : 0;
    this.heading = save.version !== 1 ? save.rippleHeading : (this.options.rippleHeading ?? 0);
    this.rippleAxis.value.set(Math.cos(this.heading), Math.sin(this.heading));
    this.publish();
  }
  dispose() {
    this.strata?.dispose();
    this.compositionMap.dispose();
    this.geometry.dispose();
    this.texture.dispose();
  }
}
