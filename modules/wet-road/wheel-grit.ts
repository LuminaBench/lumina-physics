import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface GritBedOptions {
  /** Lower X/Z corner and square cell width in world metres. */
  x: number;
  z: number;
  cellSize: number;
  columns: number;
  rows: number;
}

export interface GritWheelSave {
  fine: number;
  coarse: number;
}

export interface GritBedSave {
  version: 1;
  grid: [number, number, number, number, number];
  /** Sparse triples of cell index, fine grams and coarse grams. */
  cells: number[];
  exported: [number, number];
}

const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** A surveyed patch of finite sediment on a rigid surface. Water remains owned by the host. */
export class GritBed {
  readonly options: Readonly<GritBedOptions>;
  readonly texture: THREE.DataTexture;
  readonly exported = new THREE.Vector2();
  private readonly stock: Float64Array;
  private readonly pixels: Uint8Array;
  private readonly gramsPerKgM2: number;
  private dirty = false;

  constructor(options: GritBedOptions) {
    const { x, z, cellSize, columns, rows } = options;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(cellSize) ||
      cellSize < 0.005 ||
      ![columns, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 512)
    )
      throw new RangeError('Grit bed requires finite bounds, cell size ≥5 mm, and 1–512 cells per axis');
    this.options = Object.freeze({ ...options });
    this.gramsPerKgM2 = 1000 * cellSize * cellSize;
    this.stock = new Float64Array(2 * columns * rows);
    this.pixels = new Uint8Array(4 * columns * rows);
    this.texture = new THREE.DataTexture(this.pixels, columns, rows);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  private index(x: number, z: number) {
    const o = this.options,
      i = Math.floor((x - o.x) / o.cellSize),
      j = Math.floor((z - o.z) / o.cellSize);
    return i >= 0 && j >= 0 && i < o.columns && j < o.rows ? j * o.columns + i : -1;
  }
  private publish(i: number) {
    // Optical coverage of a fine stain and a coarser scatter, stored separately from the mass.
    const fine = -Math.expm1(-this.stock[2 * i] / (this.gramsPerKgM2 * 0.12));
    const coarse = -Math.expm1(-this.stock[2 * i + 1] / (this.gramsPerKgM2 * 0.36));
    const r = Math.round(255 * fine);
    const g = Math.round(255 * coarse);
    if (this.pixels[4 * i] === r && this.pixels[4 * i + 1] === g) return;
    this.pixels[4 * i] = r;
    this.pixels[4 * i + 1] = g;
    this.dirty = true;
  }
  /** Add a measured mass in grams. Sediment falling outside the patch is tallied as exported. */
  deposit(x: number, z: number, fine: number, coarse: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !nonnegative(fine) || !nonnegative(coarse))
      throw new RangeError('Invalid sediment deposit');
    if (fine === 0 && coarse === 0) return;
    const i = this.index(x, z);
    if (i < 0) {
      this.exported.x += fine;
      this.exported.y += coarse;
      return;
    }
    this.stock[2 * i] += fine;
    this.stock[2 * i + 1] += coarse;
    this.publish(i);
  }
  /** Local fine and coarse mass, in grams per cell. */
  sample(x: number, z: number, out: THREE.Vector2) {
    const i = this.index(x, z);
    return i < 0 ? out.set(0, 0) : out.set(this.stock[2 * i], this.stock[2 * i + 1]);
  }
  total(out: THREE.Vector2) {
    out.set(0, 0);
    for (let i = 0; i < this.stock.length; i += 2) {
      out.x += this.stock[i];
      out.y += this.stock[i + 1];
    }
    return out;
  }
  coverageNode(worldXZ: N): N {
    const o = this.options,
      uv = worldXZ.sub(TSL.vec2(o.x, o.z)).div(TSL.vec2(o.columns * o.cellSize, o.rows * o.cellSize));
    return TSL.select(
      uv.greaterThanEqual(0).all().and(uv.lessThan(1).all()),
      TSL.texture(this.texture, uv).rg,
      TSL.vec2(0),
    );
  }
  upload() {
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** @internal Exchange only mass that was present at the beginning of this contact. */
  exchange(
    x: number,
    z: number,
    wheel: GritWheel,
    distance: number,
    weight: number,
    wet: number,
    wash: number,
    slip: number,
  ) {
    const i = this.index(x, z);
    if (
      wheel.fine === 0 &&
      wheel.coarse === 0 &&
      (i < 0 || (this.stock[2 * i] === 0 && this.stock[2 * i + 1] === 0))
    )
      return;
    // Adhering fines survive longer on a damp tire. Loose coarse grains leave more quickly.
    const releaseFine =
      wheel.fine * -Math.expm1(-distance * weight * (0.24 - 0.16 * wet + 1.6 * wash + 0.3 * slip));
    const releaseCoarse =
      wheel.coarse * -Math.expm1(-distance * weight * (0.7 - 0.26 * wet + 2.2 * wash + 0.45 * slip));
    wheel.fine -= releaseFine;
    wheel.coarse -= releaseCoarse;
    if (i < 0) {
      this.exported.x += releaseFine;
      this.exported.y += releaseCoarse;
      return;
    }
    const k = 2 * i;
    const swept = (weight * distance) / this.options.cellSize;
    let takeFine = this.stock[k] * -Math.expm1(-swept * (0.05 + 0.4 * wet) * (1 - 0.75 * wash));
    let takeCoarse = this.stock[k + 1] * -Math.expm1(-swept * (0.024 + 0.15 * wet) * (1 - 0.85 * wash));
    const space = Math.max(0, wheel.capacity - wheel.fine - wheel.coarse);
    const wanted = takeFine + takeCoarse;
    if (wanted > space) {
      const ratio = space / wanted;
      takeFine *= ratio;
      takeCoarse *= ratio;
    }
    if (releaseFine + releaseCoarse + takeFine + takeCoarse === 0) return;
    this.stock[k] += releaseFine - takeFine;
    this.stock[k + 1] += releaseCoarse - takeCoarse;
    wheel.fine += takeFine;
    wheel.coarse += takeCoarse;
    this.publish(i);
  }
  save(): GritBedSave {
    const o = this.options,
      cells: number[] = [];
    for (let k = 0; k < this.stock.length; k += 2)
      if (this.stock[k] || this.stock[k + 1]) cells.push(k / 2, this.stock[k], this.stock[k + 1]);
    return {
      version: 1,
      grid: [o.x, o.z, o.cellSize, o.columns, o.rows],
      cells,
      exported: [this.exported.x, this.exported.y],
    };
  }
  restore(s: GritBedSave) {
    const o = this.options,
      grid = [o.x, o.z, o.cellSize, o.columns, o.rows];
    if (
      s.version !== 1 ||
      !Array.isArray(s.grid) ||
      s.grid.length !== 5 ||
      grid.some((n, i) => n !== s.grid[i]) ||
      !Array.isArray(s.cells) ||
      s.cells.length % 3 !== 0 ||
      s.cells.length > this.stock.length * 1.5 ||
      !Array.isArray(s.exported) ||
      s.exported.length !== 2 ||
      !s.exported.every(nonnegative)
    )
      throw new RangeError('Incompatible grit bed save');
    let previous = -1;
    for (let k = 0; k < s.cells.length; k += 3) {
      const i = s.cells[k];
      if (
        !Number.isInteger(i) ||
        i <= previous ||
        2 * i >= this.stock.length ||
        !nonnegative(s.cells[k + 1]) ||
        !nonnegative(s.cells[k + 2])
      )
        throw new RangeError('Invalid grit bed cell');
      previous = i;
    }
    this.stock.fill(0);
    this.pixels.fill(0);
    this.dirty = true;
    for (let k = 0; k < s.cells.length; k += 3) {
      const i = s.cells[k];
      this.stock[2 * i] = s.cells[k + 1];
      this.stock[2 * i + 1] = s.cells[k + 2];
      this.publish(i);
    }
    this.exported.set(...s.exported);
  }
  dispose() {
    this.texture.dispose();
  }
}

/** One finite load per tire. Fixed-distance strokes keep the transfer independent of rendering cadence. */
export class GritWheel {
  fine = 0;
  coarse = 0;
  private x = 0;
  private z = 0;
  private pending = 0;
  private active = false;
  private receiver?: GritBed;
  constructor(
    readonly bed: GritBed,
    readonly width: number,
    readonly capacity = 45,
  ) {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(capacity) || capacity <= 0)
      throw new RangeError('Supply positive tire width (m) and capacity (g)');
  }
  lift() {
    this.active = false;
    this.pending = 0;
  }
  update(
    x: number,
    z: number,
    load: number,
    filmMetres: number,
    depthMetres: number,
    slip: number,
    maxTravel: number,
    receiver: GritBed = this.bed,
  ) {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(load) ||
      !nonnegative(filmMetres) ||
      !nonnegative(depthMetres) ||
      !Number.isFinite(slip) ||
      !nonnegative(maxTravel)
    )
      throw new RangeError('Invalid grit wheel contact');
    if (load <= 0.005) {
      this.lift();
      return;
    }
    if (this.receiver !== receiver) this.lift();
    this.receiver = receiver;
    const dx = x - this.x,
      dz = z - this.z,
      ds = Math.hypot(dx, dz);
    if (this.active && ds > 0 && ds <= maxTravel) {
      const step = receiver.options.cellSize * 0.55,
        nx = dz / ds,
        nz = -dx / ds;
      const wet = -Math.expm1(-filmMetres / 0.00075),
        wash = clamp01(depthMetres / 0.012),
        grip = clamp01(load);
      let d = step - this.pending;
      for (; d <= ds; d += step) {
        const t = d / ds,
          px = this.x + t * dx,
          pz = this.z + t * dz;
        // Sample across a physical tread instead of sweeping a single line through a puddle.
        for (let side = -1; side <= 1; side++) {
          const offset = side * this.width * 0.32;
          receiver.exchange(
            px + offset * nx,
            pz + offset * nz,
            this,
            step,
            grip * (side === 0 ? 0.4 : 0.3),
            wet,
            wash,
            clamp01(Math.abs(slip)),
          );
        }
      }
      this.pending = Math.max(0, step - (d - ds));
    } else if (!this.active || ds > maxTravel) this.pending = 0;
    this.active = true;
    this.x = x;
    this.z = z;
  }
  save(): GritWheelSave {
    return { fine: this.fine, coarse: this.coarse };
  }
  restore(s: GritWheelSave) {
    if (!nonnegative(s.fine) || !nonnegative(s.coarse) || s.fine + s.coarse > this.capacity + 1e-8)
      throw new RangeError('Invalid tire grit mass');
    this.fine = s.fine;
    this.coarse = s.coarse;
    this.receiver = undefined;
    this.lift();
  }
  /** Drop remaining material at the last contact when the host retires this tire. */
  unload() {
    if (this.receiver) this.receiver.deposit(this.x, this.z, this.fine, this.coarse);
    else {
      this.bed.exported.x += this.fine;
      this.bed.exported.y += this.coarse;
    }
    this.fine = this.coarse = 0;
    this.lift();
  }
}
