import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

/** One buried mineral lens in a finite mobile sand section. Distances are metres. */
export interface DuneLens {
  topDepthAt(x: number, z: number): number;
  thicknessAt(x: number, z: number): number;
  coarseFraction: number;
  /** Optical width of the transition between grain mixtures, metres. Defaults to 2 mm. */
  contactWidthM?: number;
  /** Mineral and shell colours using standard Three.js colour inputs. */
  mineral: THREE.ColorRepresentation;
  pale: THREE.ColorRepresentation;
}
export interface StrataSave {
  survey: string;
  markerM3: number;
  intact: number[];
  /** Reworked sediment in metres, ordered matrix fine/coarse, then lens fine/coarse. */
  mixed: number[];
}

/** Excavation samples the original section from the top. Incoming spoil is kept
 * as a separate, mixed cap so it can bury an intact lens and be removed again. */
export class DuneStrata {
  readonly survey: string;
  readonly lens: Readonly<DuneLens>;
  private readonly contactWidth: number;
  private readonly initialMarkerM3: number;
  private readonly intact: Float64Array;
  private readonly mixed: Float64Array;
  private readonly incoming: Float64Array;
  private readonly top: Float32Array;
  private readonly base: Float32Array;
  private readonly field: Float32Array;
  private readonly map: THREE.DataTexture;
  private readonly origin: N;
  constructor(
    lens: DuneLens,
    private readonly n: number,
    private readonly x0: number,
    private readonly z0: number,
    private readonly dx: number,
    private readonly bed: Float32Array,
    private readonly original: Float32Array,
    private readonly matrixCoarse: Float32Array,
  ) {
    if (!Number.isFinite(lens.coarseFraction) || lens.coarseFraction < 0 || lens.coarseFraction > 1)
      throw new RangeError('Invalid coarse fraction for the dune lens');
    this.contactWidth = lens.contactWidthM ?? 0.002;
    if (!Number.isFinite(this.contactWidth) || this.contactWidth <= 0)
      throw new RangeError('Invalid mineral contact width');
    this.lens = Object.freeze({ ...lens });
    this.intact = Float64Array.from(original);
    this.mixed = new Float64Array(original.length * 4);
    this.incoming = new Float64Array(this.mixed.length);
    this.field = new Float32Array(this.mixed.length);
    this.top = new Float32Array(original.length);
    this.base = new Float32Array(original.length);
    for (let i = 0; i < original.length; i++) {
      const x = x0 + (i % n) * dx,
        z = z0 + Math.floor(i / n) * dx;
      const cover = lens.topDepthAt(x, z),
        width = lens.thicknessAt(x, z);
      if (!Number.isFinite(cover) || cover < 0 || !Number.isFinite(width) || width < 0)
        throw new RangeError('Invalid lens burial or thickness');
      this.top[i] = Math.max(0, original[i] - cover);
      this.base[i] = Math.max(0, original[i] - cover - width);
    }
    this.initialMarkerM3 = this.markerVolume();
    let hash = 2166136261;
    for (const arr of [this.top, this.base, original, matrixCoarse, bed]) {
      for (const byte of new Uint8Array(arr.buffer)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    }
    this.survey = [x0, z0, dx, n, lens.coarseFraction, hash].join('/');
    this.map = new THREE.DataTexture(this.field, n, n, THREE.RGBAFormat, THREE.FloatType);
    this.origin = TSL.vec2(x0, z0);
  }
  private lensDepth(i: number, h: number) {
    return Math.max(0, Math.min(this.top[i], h) - this.base[i]);
  }
  private intactCoarse(i: number, h: number) {
    const marker = this.lensDepth(i, h);
    return marker * this.lens.coarseFraction + (h - marker) * this.matrixCoarse[i];
  }
  private loose(k: number) {
    return this.mixed[k] + this.mixed[k + 1] + this.mixed[k + 2] + this.mixed[k + 3];
  }

  /** Stage incoming material until all donors have been sampled for this operation. */
  transfer(from: number, to: number, demand: number, coarseMobility: number) {
    if (demand <= 0) return 0;
    const k = 4 * from,
      j = 4 * to,
      surface = this.loose(k),
      h = this.intact[from];
    const mined = Math.min(h, Math.max(0, demand - surface)),
      left = h - mined;
    if (mined > 0) {
      const marker = Math.min(mined, Math.max(0, this.lensDepth(from, h) - this.lensDepth(from, left)));
      const sand = mined - marker,
        q = this.matrixCoarse[from],
        m = this.lens.coarseFraction;
      // Wind below the coarse-grain threshold cannot disturb a completely armoured surface.
      if (coarseMobility === 0 && this.mixed[k] + this.mixed[k + 2] + sand * (1 - q) + marker * (1 - m) === 0)
        return 0;
      this.mixed[k] += sand * (1 - q);
      this.mixed[k + 1] += sand * q;
      this.mixed[k + 2] += marker * (1 - m);
      this.mixed[k + 3] += marker * m;
      this.intact[from] = left;
    }
    const available = surface + mined;
    if (available <= 0) return 0;
    const fraction = Math.min(1, demand / available);
    let moved = 0;
    for (let b = 0; b < 4; b++) {
      const take = this.mixed[k + b] * fraction * (b % 2 ? coarseMobility : 1);
      this.mixed[k + b] -= take;
      this.incoming[j + b] += take;
      moved += take;
    }
    return moved;
  }
  finish(depth: Float32Array, coarse: Float32Array) {
    for (let i = 0; i < depth.length; i++) {
      const k = i * 4;
      for (let b = 0; b < 4; b++) {
        this.mixed[k + b] += this.incoming[k + b];
        this.incoming[k + b] = 0;
      }
      depth[i] = this.intact[i] + this.loose(k);
      coarse[i] = Math.min(
        depth[i],
        this.intactCoarse(i, this.intact[i]) + this.mixed[k + 1] + this.mixed[k + 3],
      );
    }
  }
  publish() {
    for (let i = 0; i < this.intact.length; i++) {
      const k = i * 4,
        cap = this.loose(k);
      // Fixed elevations preserve the section where a triangle cuts across
      // several beds. Deposited marker volume is premultiplied by cap depth.
      this.field[k] = this.bed[i] + this.top[i];
      this.field[k + 1] = this.bed[i] + this.base[i];
      this.field[k + 2] = cap;
      this.field[k + 3] = this.mixed[k + 2] + this.mixed[k + 3];
    }
    this.map.needsUpdate = true;
  }
  /** The shader and gameplay interpolate the same three survey vertices. */
  private component(x: number, z: number, c: number) {
    const u = (x - this.x0) / this.dx,
      v = (z - this.z0) / this.dx;
    const col = Math.min(this.n - 2, Math.floor(u)),
      row = Math.min(this.n - 2, Math.floor(v));
    const a = u - col,
      b = v - row,
      k = 4 * (col + row * this.n) + c,
      line = 4 * this.n,
      f = this.field;
    if (a + b <= 1) return f[k] * (1 - a - b) + f[k + 4] * a + f[k + line] * b;
    return f[k + 4] * (1 - b) + f[k + line] * (1 - a) + f[k + line + 4] * (a + b - 1);
  }
  surfaceFractionAt(x: number, z: number, y: number) {
    if (
      x < this.x0 ||
      z < this.z0 ||
      x > this.x0 + this.dx * (this.n - 1) ||
      z > this.z0 + this.dx * (this.n - 1)
    )
      return 0;
    const top = this.component(x, z, 0),
      base = this.component(x, z, 1),
      cap = this.component(x, z, 2);
    const width = this.contactWidth;
    const contact =
      THREE.MathUtils.smoothstep(y - base, -width, width) *
      (1 - THREE.MathUtils.smoothstep(y - top, -width, width));
    const intact = contact * THREE.MathUtils.smoothstep(top - base, 0, width);
    const mix = THREE.MathUtils.smoothstep(cap, 0, width);
    return THREE.MathUtils.lerp(intact, this.component(x, z, 3) / Math.max(1e-12, cap), mix);
  }
  surfaceFractionNode(xz: N, y: N): N {
    return this.sectionNode(xz, y).x;
  }
  /** Surface mineral fraction, depth below the original lens top, and intact visibility. */
  sectionNode(xz: N, y: N): N {
    const grid = xz
        .sub(this.origin)
        .div(this.dx)
        .clamp(0, this.n - 1),
      cell = grid.floor().min(this.n - 2),
      uv = grid.sub(cell);
    const upper = uv.x.add(uv.y).greaterThan(1);
    const at = (offset: N) => TSL.texture(this.map, cell.add(offset).add(0.5).div(this.n)).level(0);
    const a = at(TSL.select(upper, TSL.vec2(1, 1), TSL.vec2(0, 0)));
    const b = at(TSL.vec2(1, 0)),
      c = at(TSL.vec2(0, 1));
    const f = a
      .mul(uv.x.add(uv.y).sub(1).abs())
      .add(b.mul(TSL.select(upper, uv.y.oneMinus(), uv.x)))
      .add(c.mul(TSL.select(upper, uv.x.oneMinus(), uv.y)))
      .toVar();
    const width = TSL.float(this.contactWidth);
    const intact = TSL.smoothstep(width.negate(), width, y.sub(f.g))
      .mul(TSL.smoothstep(width.negate(), width, y.sub(f.r)).oneMinus())
      .mul(TSL.smoothstep(0, width, f.r.sub(f.g)));
    const cover = TSL.smoothstep(0, width, f.b);
    return TSL.vec3(
      TSL.mix(intact, f.a.div(f.b.max(1e-12)), cover),
      f.r.sub(y),
      intact.mul(cover.oneMinus()),
    );
  }
  markerVolume() {
    let result = 0;
    for (let i = 0; i < this.intact.length; i++)
      result += this.lensDepth(i, this.intact[i]) + this.mixed[i * 4 + 2] + this.mixed[i * 4 + 3];
    return result * this.dx * this.dx;
  }
  reset() {
    this.intact.set(this.original);
    this.mixed.fill(0);
    this.incoming.fill(0);
  }
  save(): StrataSave {
    return {
      survey: this.survey,
      markerM3: this.markerVolume(),
      intact: Array.from(this.intact),
      mixed: Array.from(this.mixed),
    };
  }
  restore(snapshot: StrataSave, depth: readonly number[], coarse: readonly number[], locked: Uint8Array) {
    const n = this.intact.length;
    if (
      !snapshot ||
      snapshot.survey !== this.survey ||
      !Number.isFinite(snapshot.markerM3) ||
      snapshot.markerM3 < 0 ||
      !Array.isArray(snapshot.intact) ||
      snapshot.intact.length !== n ||
      !Array.isArray(snapshot.mixed) ||
      snapshot.mixed.length !== 4 * n ||
      !snapshot.mixed.every((v) => Number.isFinite(v) && v >= 0)
    )
      throw new RangeError('Invalid dune stratigraphy save');
    let marker = 0;
    for (let i = 0; i < n; i++) {
      const h = snapshot.intact[i],
        k = 4 * i,
        v = snapshot.mixed;
      if (
        !Number.isFinite(h) ||
        h < 0 ||
        h > this.original[i] ||
        (locked[i] && (h || v[k] || v[k + 1] || v[k + 2] || v[k + 3]))
      )
        throw new RangeError('Invalid preserved sand section');
      const total = h + (v[k] + v[k + 1] + v[k + 2] + v[k + 3]),
        gravel = this.intactCoarse(i, h) + v[k + 1] + v[k + 3];
      if (
        Math.round(Math.fround(total) * 10000) !== depth[i] ||
        Math.round(Math.fround(gravel) * 10000) !== coarse[i]
      )
        throw new RangeError('Dune layer inventory disagrees with saved sediment');
      marker += this.lensDepth(i, h) + v[k + 2] + v[k + 3];
    }
    const volume = marker * this.dx * this.dx,
      tolerance = 1e-9 * Math.max(1, this.initialMarkerM3);
    if (Math.abs(volume - snapshot.markerM3) > tolerance || volume > this.initialMarkerM3 + tolerance)
      throw new RangeError('Dune mineral budget does not balance');
    this.intact.set(snapshot.intact);
    this.mixed.set(snapshot.mixed);
    this.incoming.fill(0);
  }
  migrate(depth: Float32Array, coarse: Float32Array, oldCoarse: boolean) {
    this.mixed.fill(0);
    this.incoming.fill(0);
    for (let i = 0; i < depth.length; i++) {
      const h = this.original[i],
        c = this.intactCoarse(i, h);
      if (Math.abs(depth[i] - h) <= 0.000051 && (!oldCoarse || Math.abs(coarse[i] - c) <= 0.000051))
        this.intact[i] = h;
      else {
        this.intact[i] = 0;
        this.mixed[i * 4] = depth[i] - coarse[i];
        this.mixed[i * 4 + 1] = coarse[i];
      }
    }
  }
  dispose() {
    this.map.dispose();
  }
}
