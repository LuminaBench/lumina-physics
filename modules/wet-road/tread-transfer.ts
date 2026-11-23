import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

/** Per-wheel water retained in the grooves, in metres. Use the same result for spray and prints. */
export function retainedTreadFilm(previous: number, depth: number, surfaceWetness: number, grooveDepth: number,
  radius: number, rimSpeed: number, dt: number): number {
  const target = Math.max(0, Math.min(Math.max(0.0002, grooveDepth), Math.max(depth, 0.00028 * surfaceWetness)));
  const rotation = Math.abs(rimSpeed) / Math.max(0.05, radius);
  const rate = target > previous ? 4 + 0.6 * rotation : 0.9 + 0.13 * rotation;
  return previous + (target - previous) * -Math.expm1(-Math.max(0, dt) * rate);
}

/** A host supplies the same loose-sediment coverage (0..1) to the tire and the material. */
export interface LooseSediment {
  amountAt(x: number, z: number): number;
  amountNode(worldXZ: N): N;
}

const COLS = 256, ROWS = 512;
const saturate = (a: number) => Math.max(0, Math.min(1, a));

/** A scrolling XZ contact map. R = deposited water, G = soil, B = displaced surface film. */
export class TreadTransfer {
  readonly texture: THREE.DataTexture;
  readonly span: THREE.Vector2;
  points = 0;
  private readonly data = new Uint8Array(COLS * ROWS * 4);
  private readonly liveRows = new Uint8Array(ROWS);
  private readonly origin = TSL.uniform(new THREE.Vector2());
  private x0 = 0;
  private z0 = 0;
  private dirty = false;
  private age = 0;
  private decaySteps = 0;
  private readonly decay = new Uint8Array(3 * 256);


  constructor(readonly cellX = 0.04, readonly cellZ = 0.08) {
    if (!(Number.isFinite(cellX) && cellX > 0 && Number.isFinite(cellZ) && cellZ > 0))
      throw new RangeError('Tread map texel dimensions must be positive finite metres.');
    this.span = new THREE.Vector2(COLS * cellX, ROWS * cellZ);
    this.texture = new THREE.DataTexture(this.data, COLS, ROWS);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
    this.update(0, 0, 0);
  }

  contact(width: number): TreadContact {
    if (!(Number.isFinite(width) && width > 0)) throw new RangeError('Wheel width must be positive finite metres.');
    return new TreadContact(this, width);
  }

  /** Sample in world metres. UVs wrap in storage while the bounds mask rejects older world tiles. */
  sampleNode(worldXZ: N): N {
    const local = worldXZ.sub(this.origin).div(this.span);
    const guard = TSL.min(local, TSL.vec2(1).sub(local)).mul(TSL.vec2(COLS, ROWS));
    // Clamp the bilinear footprint at the two outer edges before wrapping into texture storage.
    const bounded = local.clamp(TSL.vec2(0.5 / COLS, 0.5 / ROWS), TSL.vec2(1 - 0.5 / COLS, 1 - 0.5 / ROWS));
    const uv = bounded.add(this.origin.div(this.span));
    return TSL.texture(this.texture, uv).rgb.mul(TSL.min(guard.x, guard.y).clamp(0, 1));
  }

  /** Bilinear readback of the same three game-material channels. Reuse the output vector. */
  sampleAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const px = x / this.cellX, pz = z / this.cellZ;
    const edge = saturate(Math.min(px - this.x0, pz - this.z0, this.x0 + COLS - px, this.z0 + ROWS - pz));
    if (!edge) return out.set(0, 0, 0);
    const fx = Math.max(this.x0, Math.min(this.x0 + COLS - 1, px - 0.5));
    const fz = Math.max(this.z0, Math.min(this.z0 + ROWS - 1, pz - 0.5));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    out.set(0, 0, 0);
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const cx = ix + i, cz = iz + j;
      if (cx < this.x0 || cx >= this.x0 + COLS || cz < this.z0 || cz >= this.z0 + ROWS) continue;
      const n = ((cz & (ROWS - 1)) * COLS + (cx & (COLS - 1))) * 4;
      const weight = (i ? fx - ix : 1 - (fx - ix)) * (j ? fz - iz : 1 - (fz - iz)) / 255;
      out.x += this.data[n] * weight; out.y += this.data[n + 1] * weight; out.z += this.data[n + 2] * weight;
    }
    return out.multiplyScalar(edge);
  }

  /** Advance once per frame near the subject. Only newly exposed strips are erased when scrolling. */
  update(dt: number, focusX: number, focusZ: number): void {
    const x = Math.floor(focusX / this.cellX / 32) * 32 - COLS / 2;
    const z = Math.floor(focusZ / this.cellZ / 32) * 32 - ROWS / 2;
    if (x !== this.x0 || z !== this.z0) {
      const oldX = this.x0, oldZ = this.z0;
      this.x0 = x; this.z0 = z;
      this.origin.value.set(x * this.cellX, z * this.cellZ);
      if (Math.abs(x - oldX) >= COLS || Math.abs(z - oldZ) >= ROWS) this.clear();
      else for (let cz = z; cz < z + ROWS; cz++) {
        const row = cz & (ROWS - 1);
        if (!this.liveRows[row]) continue;
        const start = row * COLS * 4;
        if (cz < oldZ || cz >= oldZ + ROWS) {
          this.data.fill(0, start, start + COLS * 4); this.liveRows[row] = 0; this.dirty = true;
        } else if (oldX !== x) {
          const from = x < oldX ? x : oldX + COLS, to = x < oldX ? oldX : x + COLS;
          const left = from & (COLS - 1), length = to - from;
          this.data.fill(0, start + left * 4, start + Math.min(COLS, left + length) * 4);
          if (left + length > COLS) this.data.fill(0, start, start + (left + length - COLS) * 4);
          this.dirty = true;
        }
      }
    }
    this.age += Math.max(0, dt);
    if (this.age >= 0.5) {
      const steps = Math.floor(this.age * 2);
      this.age -= steps * 0.5;
      // The bytes contain both material amount and subpixel coverage. Fractional drying keeps
      // a thin diagonal wet at the same rate as a tire whose centre lies exactly on a texel.
      if (steps !== this.decaySteps) {
        this.decaySteps = steps;
        const wet = Math.exp(-0.5 * steps / 7), soil = Math.exp(-0.5 * steps / 50), cleared = Math.exp(-0.5 * steps / 2.8);
        for (let v = 1; v < 256; v++) {
          const limit = Math.max(0, v - steps);
          this.decay[v] = Math.min(limit, Math.round(v * wet));
          this.decay[256 + v] = Math.min(limit, Math.round(v * soil));
          this.decay[512 + v] = Math.min(limit, Math.round(v * cleared));
        }
      }
      for (let row = 0; row < ROWS; row++) if (this.liveRows[row]) {
        let live = 0;
        for (let i = row * COLS * 4, end = i + COLS * 4; i < end; i += 4) {
          this.data[i] = this.decay[this.data[i]];
          this.data[i+1] = this.decay[256 + this.data[i+1]];
          this.data[i+2] = this.decay[512 + this.data[i+2]];
          live |= this.data[i] | this.data[i+1] | this.data[i+2];
        }
        this.liveRows[row] = Number(live !== 0); this.dirty = true;
      }
    }
    if (this.dirty) { this.texture.needsUpdate = true; this.dirty = false; }
  }

  /** @internal Rasterise a physical contact patch along its swept path. */
  stamp(x0: number, z0: number, x1: number, z1: number, width: number, water: number, dirt: number, cleared: number): void {
    const dx = x1 - x0, dz = z1 - z0, ds = Math.hypot(dx, dz);
    if (ds < 1e-5 || Math.max(water, dirt, cleared) < 0.008) return;
    const nx = dz / ds, nz = -dx / ds;
    const pixel = Math.abs(nx) * this.cellX + Math.abs(nz) * this.cellZ;
    const half = (width + pixel) * 0.5;
    const xmin = Math.max(this.x0, Math.floor((Math.min(x0,x1) - half) / this.cellX));
    const xmax = Math.min(this.x0 + COLS - 1, Math.floor((Math.max(x0,x1) + half) / this.cellX));
    const zmin = Math.max(this.z0, Math.floor((Math.min(z0,z1) - half) / this.cellZ));
    const zmax = Math.min(this.z0 + ROWS - 1, Math.floor((Math.max(z0,z1) + half) / this.cellZ));
    for (let z = zmin; z <= zmax; z++) for (let x = xmin; x <= xmax; x++) {
      const px = (x + 0.5) * this.cellX - x0, pz = (z + 0.5) * this.cellZ - z0;
      const along = Math.max(0, Math.min(ds, -px * nz + pz * nx));
      const across = Math.hypot(px + along * nz, pz - along * nx);
      const coverage = Math.min(1, width / pixel, Math.max(0, (half - across) / pixel));
      if (!coverage) continue;
      // Resolve a pair of longitudinal channels only when the local texel footprint permits it.
      const rib = (width > 3 * pixel) ? 1 - 0.34 * Math.exp(-(((across / width - 0.23) * 11) ** 2)) : 1;
      const row = z & (ROWS - 1), i = (row * COLS + (x & (COLS - 1))) * 4;
      const scale = 255 * coverage * rib, w = Math.round(water * scale), c = Math.round(cleared * scale);
      if (w) this.data[i+2] = Math.min(this.data[i+2], 255 - w);
      if (c) this.data[i] = Math.min(this.data[i], 255 - c);
      this.data[i] = Math.max(this.data[i], w);
      this.data[i+1] = Math.max(this.data[i+1], Math.round(dirt * scale));
      this.data[i+2] = Math.max(this.data[i+2], c);
      this.liveRows[row] = 1; this.dirty = true;
    }
    this.points++;
  }

  clear(): void { this.data.fill(0); this.liveRows.fill(0); this.age = 0; this.dirty = true; }
  dispose(): void { this.texture.dispose(); }
}

export class TreadContact {
  soil = 0;
  private active = false;
  private x = 0;
  private z = 0;

  constructor(private field: TreadTransfer, readonly width: number) {}

  /** supply retained water and standing depth in metres, film/soil supply and load in unit fractions. */
  sample(x: number, z: number, retainedWater: number, depth: number, surfaceFilm: number, looseSoil: number,
    load: number, maxTravel: number): void {
    const ds = Math.hypot(x - this.x, z - this.z);
    const grounded = load > 0.005;
    if (this.active && grounded && ds > 1e-5 && ds <= maxTravel) {
      const supply = saturate(looseSoil), weight = saturate(load);
      const wash = saturate(depth / 0.008);
      const gain = 1.6 * supply, loss = 0.14 * (1 - supply) + wash * 1.8;
      const rate = (gain + loss) * weight;
      const initial = this.soil;
      if (rate > 0) this.soil += (gain / (gain + loss) - this.soil) * -Math.expm1(-ds * rate);
      const bed = weight * (1 - saturate(depth / 0.003));
      const wet = (1 - Math.exp(-Math.max(0, retainedWater) / 0.00065)) * (1 - saturate(surfaceFilm));
      this.field.stamp(this.x, this.z, x, z, this.width, wet * bed, (initial + this.soil) * 0.5 * bed,
        saturate(surfaceFilm) * 0.36 * bed);
    } else if (this.active && ds > maxTravel) this.soil = 0;
    this.x = x; this.z = z; this.active = grounded;
  }

  reset(): void { this.active = false; this.soil = 0; }
}
