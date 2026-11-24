import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { perturbNormalHeight } from '../../engine/shading';

export interface SaltCrustOptions {
  x: number;
  z: number;
  cellSize: number;
  columns: number;
  rows: number;
  seed: number;
  /** Elevation in metres of the undisturbed mud underneath the salt. */
  bedAt(x: number, z: number): number;
  /** Fraction of the site supporting a salt skin. Use a game-owned mask at a playa margin. */
  coverAt?(x: number, z: number): number;
  plateWidthM?: number;
  thicknessM?: number;
  strengthKPa?: number;
  mudSettlementM?: number;
}
export interface SaltCrustSave {
  version: 1;
  shape: number[];
  /** Pairs of vertex index and peak contact pressure in kPa. */
  pressures: number[];
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function hash(i: number, j: number, seed: number) {
  let h = Math.imul(i, 0x56ab7a25) ^ Math.imul(j, 0x4d495205) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A finite skin of salt on compressible mud. A new peak load can break the skin or settle its bed. */
export class SaltCrust {
  readonly options: Readonly<Required<SaltCrustOptions>>;
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: THREE.BufferAttribute;
  private readonly state: THREE.BufferAttribute;
  private readonly normal: THREE.BufferAttribute;
  private readonly mud: Float32Array;
  private readonly thickness: Float32Array;
  private readonly strength: Float32Array;
  private readonly peak: Float32Array;
  private readonly terrainSignature: number;
  private x0 = Infinity;
  private x1 = -1;
  private z0 = Infinity;
  private z1 = -1;
  constructor(options: SaltCrustOptions) {
    const o = (this.options = Object.freeze({
      coverAt: () => 1,
      plateWidthM: 0.93,
      thicknessM: 0.016,
      strengthKPa: 48,
      mudSettlementM: 0.052,
      ...options,
    }));
    const { columns: n, rows: m, cellSize: s, plateWidthM: span, seed } = o;
    if (
      ![o.x, o.z].every(Number.isFinite) ||
      ![n, m].every((v) => Number.isInteger(v) && v >= 3 && v <= 513) ||
      ![s, span, o.thicknessM, o.strengthKPa].every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(o.mudSettlementM) ||
      o.mudSettlementM < 0 ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff
    )
      throw new RangeError('Invalid salt crust grid or material');
    const len = n * m,
      vertices = new Float32Array(3 * len),
      attrs = new Float32Array(3 * len),
      cover = new Float32Array(len);
    this.mud = new Float32Array(len);
    this.thickness = new Float32Array(len);
    this.strength = new Float32Array(len);
    this.peak = new Float32Array(len);
    const indices =
      len > 65535 ? new Uint32Array(6 * (n - 1) * (m - 1)) : new Uint16Array(6 * (n - 1) * (m - 1));
    let t = 0,
      floor = Infinity,
      ceiling = -Infinity;
    for (let j = 0; j < m; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i,
          x = o.x + i * s,
          z = o.z + j * s;
        const y = o.bedAt(x, z);
        if (!Number.isFinite(y)) throw new RangeError('Invalid salt bed elevation');
        this.mud[k] = y;
        // Disturb the plate boundaries in world space, then measure distance to the nearest bisector.
        const u = x / span + 0.11 * Math.sin((z * 2.1) / span) + 0.034 * Math.sin(((x + z) * 6.7) / span);
        const v = z / span + 0.1 * Math.sin((x * 1.7) / span) + 0.027 * Math.cos(((x - z) * 8.3) / span);
        const bx = Math.floor(u),
          bz = Math.floor(v);
        let a = Infinity,
          b = Infinity,
          ax = 0,
          az = 0,
          bxx = 0,
          bzz = 0,
          plate = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const cx = bx + dx,
              cz = bz + dz;
            const sx = cx + 0.15 + 0.7 * hash(cx, cz, seed),
              sz = cz + 0.15 + 0.7 * hash(cx, cz, seed ^ 0x56d1f5a7);
            const d = (u - sx) ** 2 + (v - sz) ** 2;
            if (d < a) {
              b = a;
              bxx = ax;
              bzz = az;
              a = d;
              ax = sx;
              az = sz;
              plate = hash(cx, cz, seed ^ 0x4b240b5);
            } else if (d < b) {
              b = d;
              bxx = sx;
              bzz = sz;
            }
          }
        const edge = ((b - a) * span) / (2 * Math.max(1e-6, Math.hypot(ax - bxx, az - bzz)));
        const ridge = Math.exp(-((edge / (0.048 * span)) ** 2));
        const grit = hash(Math.round(x * 40), Math.round(z * 40), seed ^ 0x6126ea);
        const mask = o.coverAt(x, z);
        if (!Number.isFinite(mask) || mask < 0 || mask > 1)
          throw new RangeError('Salt cover must be in [0,1]');
        cover[k] = mask;
        const thickness = mask * o.thicknessM * (0.72 + 0.55 * plate + ridge * (0.56 + 0.91 * grit));
        this.thickness[k] = thickness;
        // strengthKPa describes a 16 mm reference skin. An exposed, split seam is weaker.
        const depthFactor = Math.sqrt(Math.max(0.12, thickness / 0.016));
        this.strength[k] =
          o.strengthKPa * depthFactor * (0.73 + 0.46 * plate + 0.15 * grit) * (1 - 0.24 * ridge);
        const h = y + thickness;
        vertices[3 * k] = x;
        vertices[3 * k + 1] = h;
        vertices[3 * k + 2] = z;
        attrs[3 * k] = ridge;
        attrs[3 * k + 2] = plate;
        floor = Math.min(floor, y - o.mudSettlementM);
        ceiling = Math.max(ceiling, h);
        if (i < n - 1 && j < m - 1) {
          indices[t++] = k;
          indices[t++] = k + n;
          indices[t++] = k + 1;
          indices[t++] = k + 1;
          indices[t++] = k + n;
          indices[t++] = k + n + 1;
        }
      }
    let signature = 2166136261;
    const bedBits = new Uint32Array(this.mud.buffer),
      coverBits = new Uint32Array(cover.buffer);
    for (let k = 0; k < len; k++)
      signature = Math.imul(Math.imul(signature ^ bedBits[k], 16777619) ^ coverBits[k], 16777619);
    this.terrainSignature = signature >>> 0;
    const g = this.geometry;
    this.pos = new THREE.BufferAttribute(vertices, 3).setUsage(THREE.DynamicDrawUsage);
    this.state = new THREE.BufferAttribute(attrs, 3).setUsage(THREE.DynamicDrawUsage);
    this.normal = new THREE.BufferAttribute(new Float32Array(3 * len), 3).setUsage(THREE.DynamicDrawUsage);
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.setAttribute('position', this.pos);
    g.setAttribute('saltState', this.state);
    g.setAttribute('saltCover', new THREE.BufferAttribute(cover, 1));
    g.setAttribute('normal', this.normal);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(o.x, floor, o.z),
      new THREE.Vector3(o.x + (n - 1) * s, ceiling, o.z + (m - 1) * s),
    );
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.x0 = this.z0 = 0;
    this.x1 = n - 1;
    this.z1 = m - 1;
    this.flush();
  }
  private change(k: number, pressure: number) {
    const threshold = this.strength[k];
    const broken = clamp01((pressure / threshold - 1) / 0.68);
    const collapse = broken * broken * (3 - 2 * broken);
    const settlement =
      this.options.mudSettlementM * (1 - Math.exp(-Math.max(0, pressure / threshold - 1.1) * 0.42));
    this.peak[k] = pressure;
    this.pos.setY(k, this.mud[k] + this.thickness[k] * (1 - collapse) - settlement);
    this.state.setY(k, collapse);
    const i = k % this.options.columns,
      j = Math.floor(k / this.options.columns);
    this.x0 = Math.min(this.x0, i);
    this.x1 = Math.max(this.x1, i);
    this.z0 = Math.min(this.z0, j);
    this.z1 = Math.max(this.z1, j);
  }
  /** Apply an ellipse with full width and length in metres. Yaw zero points along +Z. */
  press(x: number, z: number, width: number, length: number, yaw: number, forceN: number) {
    if (
      !(
        Number.isFinite(x) &&
        Number.isFinite(z) &&
        Number.isFinite(width) &&
        Number.isFinite(length) &&
        Number.isFinite(yaw) &&
        Number.isFinite(forceN)
      ) ||
      width <= 0 ||
      length <= 0 ||
      forceN < 0
    )
      throw new RangeError('Invalid salt crust contact');
    if (!forceN) return;
    const o = this.options,
      a = width / 2,
      b = length / 2,
      sin = Math.sin(yaw),
      cos = Math.cos(yaw);
    const extentX = Math.hypot(a * cos, b * sin),
      extentZ = Math.hypot(a * sin, b * cos);
    const left = Math.max(0, Math.ceil((x - extentX - o.x) / o.cellSize)),
      right = Math.min(o.columns - 1, Math.floor((x + extentX - o.x) / o.cellSize));
    const near = Math.max(0, Math.ceil((z - extentZ - o.z) / o.cellSize)),
      far = Math.min(o.rows - 1, Math.floor((z + extentZ - o.z) / o.cellSize));
    // This elliptical pressure distribution integrates to the applied normal force.
    const peak = (0.0015 * forceN) / (Math.PI * a * b);
    for (let j = near; j <= far; j++)
      for (let i = left; i <= right; i++) {
        const dx = o.x + i * o.cellSize - x,
          dz = o.z + j * o.cellSize - z;
        const r2 = ((dx * cos - dz * sin) / a) ** 2 + ((dx * sin + dz * cos) / b) ** 2;
        if (r2 >= 1) continue;
        const k = j * o.columns + i,
          pressure = Math.fround(peak * Math.sqrt(1 - r2));
        if (pressure > this.strength[k] && pressure > this.peak[k]) this.change(k, pressure);
      }
  }
  /** Sample the same two triangles as the mesh. Outside the surveyed patch return the host bed. */
  sample(x: number, z: number, out: { height: number; fracture: number }) {
    const o = this.options,
      u = (x - o.x) / o.cellSize,
      v = (z - o.z) / o.cellSize;
    if (u < 0 || v < 0 || u > o.columns - 1 || v > o.rows - 1) {
      out.height = o.bedAt(x, z);
      out.fracture = 0;
      return out;
    }
    const i = Math.min(o.columns - 2, Math.floor(u)),
      j = Math.min(o.rows - 2, Math.floor(v)),
      k = j * o.columns + i;
    const fx = u - i,
      fz = v - j,
      first = fx + fz <= 1;
    const a = first ? k : k + o.columns + 1,
      b = first ? k + 1 : k + o.columns,
      c = first ? k + o.columns : k + 1;
    const wb = first ? fx : 1 - fx,
      wc = first ? fz : 1 - fz,
      wa = 1 - wb - wc;
    out.height = this.pos.getY(a) * wa + this.pos.getY(b) * wb + this.pos.getY(c) * wc;
    out.fracture = this.state.getY(a) * wa + this.state.getY(b) * wb + this.state.getY(c) * wc;
    return out;
  }
  /** Update only the touched normal neighbourhood. Call once before drawing a changed patch. */
  flush() {
    if (this.x1 < 0) return;
    const o = this.options,
      n = o.columns;
    const x0 = Math.max(0, this.x0 - 1),
      x1 = Math.min(n - 1, this.x1 + 1),
      z0 = Math.max(0, this.z0 - 1),
      z1 = Math.min(o.rows - 1, this.z1 + 1);
    for (let j = z0; j <= z1; j++)
      for (let i = x0; i <= x1; i++) {
        const left = Math.max(0, i - 1),
          right = Math.min(n - 1, i + 1),
          near = Math.max(0, j - 1),
          far = Math.min(o.rows - 1, j + 1);
        const dx =
          (this.pos.getY(j * n + left) - this.pos.getY(j * n + right)) / ((right - left) * o.cellSize);
        const dz = (this.pos.getY(near * n + i) - this.pos.getY(far * n + i)) / ((far - near) * o.cellSize);
        const inv = 1 / Math.hypot(dx, 1, dz);
        this.normal.setXYZ(j * n + i, dx * inv, inv, dz * inv);
      }
    const start = 3 * (z0 * n + x0),
      end = 3 * (z1 * n + x1 + 1);
    this.publish(this.pos, start, end);
    this.publish(this.normal, start, end);
    this.publish(this.state, start, end);
    this.x1 = this.z1 = -1;
    this.x0 = this.z0 = Infinity;
  }
  private publish(attr: THREE.BufferAttribute, start: number, end: number) {
    // A hidden or CPU-only patch may accumulate many edits between GPU uploads.
    const pending = attr.updateRanges[0];
    if (pending) {
      const stop = Math.max(end, pending.start + pending.count);
      pending.start = Math.min(start, pending.start);
      pending.count = stop - pending.start;
    } else attr.addUpdateRange(start, end - start);
    attr.needsUpdate = true;
  }
  private shape() {
    const o = this.options;
    return [
      o.x,
      o.z,
      o.columns,
      o.rows,
      o.cellSize,
      o.seed,
      o.thicknessM,
      o.plateWidthM,
      o.strengthKPa,
      o.mudSettlementM,
      this.terrainSignature,
    ];
  }
  save(): SaltCrustSave {
    const pressures: number[] = [];
    for (let k = 0; k < this.peak.length; k++) if (this.peak[k]) pressures.push(k, this.peak[k]);
    return { version: 1, shape: this.shape(), pressures };
  }
  restore(s: SaltCrustSave) {
    const shape = this.shape(),
      p = s.pressures;
    if (
      s.version !== 1 ||
      !Array.isArray(s.shape) ||
      s.shape.length !== shape.length ||
      shape.some((v, i) => v !== s.shape[i]) ||
      !Array.isArray(p) ||
      p.length % 2 ||
      p.length > 2 * this.peak.length
    )
      throw new RangeError('Incompatible salt crust save');
    for (let i = 0; i < p.length; i += 2) {
      if (
        !Number.isInteger(p[i]) ||
        p[i] < 0 ||
        p[i] >= this.peak.length ||
        (i > 0 && p[i] <= p[i - 2]) ||
        !Number.isFinite(Math.fround(p[i + 1])) ||
        p[i + 1] <= this.strength[p[i]]
      )
        throw new RangeError('Invalid salt crust pressure');
    }
    for (let k = 0; k < this.peak.length; k++) if (this.peak[k]) this.change(k, 0);
    for (let i = 0; i < p.length; i += 2) this.change(p[i], p[i + 1]);
    this.flush();
  }
  dispose() {
    this.geometry.dispose();
  }
}

/** Dry crystal ridges, marly plates and the damp clay exposed by a broken crust. */
export function createSaltCrustMaterial(
  options: { salt?: string; bed?: string; ridge?: string; bare?: string } = {},
) {
  const mat = new THREE.MeshPhysicalNodeMaterial();
  const s = TSL.attribute('saltState', 'vec3'),
    p = TSL.positionWorld.xz;
  const variation = TSL.mx_noise_float(p.mul(2.4)).mul(0.07).add(s.z.mul(0.13)).add(0.85);
  const grain = TSL.mx_noise_float(p.mul(92)).mul(TSL.smoothstep(0.018, 0.002, TSL.fwidth(p).length()));
  const salt = TSL.mix(
    TSL.color(options.salt ?? '#c9baa6').mul(variation),
    TSL.color(options.ridge ?? '#efe3cb'),
    s.x,
  );
  const clay = TSL.color(options.bed ?? '#6e5141').mul(grain.mul(0.12).add(0.97));
  const unbroken = TSL.mix(TSL.color(options.bare ?? '#a58668'), salt, TSL.attribute('saltCover', 'float'));
  const plates = TSL.mx_noise_float(p.mul(6.7)).add(TSL.mx_noise_float(p.mul(19.7)).mul(0.53));
  const pits = TSL.smoothstep(0.22, 0.76, plates);
  const chip = TSL.mx_noise_float(p.mul(48)).mul(TSL.smoothstep(0.035, 0.007, TSL.fwidth(p).length()));
  const intact = s.y.oneMinus();
  const crustTint = TSL.mix(unbroken, TSL.color('#9b8468'), pits.mul(0.23).mul(intact));
  mat.colorNode = TSL.mix(crustTint, clay, s.y).mul(grain.mul(0.17).add(1));
  const relief = plates
    .mul(0.0018)
    .sub(pits.mul(0.0014))
    .add(chip.mul(s.x.mul(0.004).add(0.0016)))
    .mul(intact);
  mat.normalNode = perturbNormalHeight(relief, TSL.float(1));
  mat.roughnessNode = TSL.mix(0.86, 0.33, s.y);
  return mat;
}
