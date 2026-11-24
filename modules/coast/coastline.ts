import { MathUtils, CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import type { TerrainHeightmap } from '../terrain/surface';

export interface SandRecipe {
  /** Mean grain diameter in millimetres. */
  grainMm: number;
  angularity: number;
  packing: number;
  pale: string;
  mineral: string;
  heavy: string;
  /** Areal fractions of pale inclusions and heavy minerals. The remainder is the host sediment. */
  paleFraction?: number;
  heavyFraction?: number;
  /** Time for an exposed water film to drain to 1/e of its initial amount. */
  drainageSeconds: number;
}
export const SANDS = {
  quartz: {
    grainMm: 0.32,
    angularity: 0.36,
    packing: 0.48,
    paleFraction: 0.32,
    heavyFraction: 0.045,
    pale: '#e5ce9b',
    mineral: '#b69b72',
    heavy: '#605746',
    drainageSeconds: 31,
  },
  shell: {
    grainMm: 0.78,
    angularity: 0.67,
    packing: 0.31,
    paleFraction: 0.62,
    heavyFraction: 0.018,
    pale: '#f6eac9',
    mineral: '#d4b992',
    heavy: '#a9826a',
    drainageSeconds: 19,
  },
  basalt: {
    grainMm: 0.48,
    angularity: 0.81,
    packing: 0.53,
    paleFraction: 0.055,
    heavyFraction: 0.47,
    pale: '#635f60',
    mineral: '#393b41',
    heavy: '#23252a',
    drainageSeconds: 34,
  },
  ochre: {
    grainMm: 0.21,
    angularity: 0.46,
    packing: 0.6,
    paleFraction: 0.095,
    heavyFraction: 0.14,
    pale: '#dfae7e',
    mineral: '#b56745',
    heavy: '#704d39',
    drainageSeconds: 49,
  },
} satisfies Record<string, SandRecipe>;
export type ShorePoint = readonly [x: number, z: number];
export interface CoastOptions {
  seed: number;
  /** Ordered with land to the right when travelling from the first point to the last. */
  shoreline?: readonly ShorePoint[];
  sand?: SandRecipe;
  exposure?: number;
  duneHeight?: number;
  relief?: 'mainland' | 'cay' | 'lava' | 'terrace';
  /** Optional island radius. Land descends below sea at its outer margin. */
  islandRadius?: number;
  /** Local basins cut into the rock. Along is the fraction of shoreline length. All other dimensions are metres. */
  pools?: readonly { along: number; cross: number; radius: number; floor: number; lip: number }[];
  beachSlope?: number;
  inlet?: boolean;
  /** Distance along the shore in metres, from the first point. */
  inletAt?: number;
  /** Host-owned surfaces, including elevated decks, can opt out of edits and coastal dressing. */
  protectedAt?: (x: number, z: number) => boolean;
  heightAt?: (x: number, z: number) => number;
}
export type CoastZone = 'offshore' | 'bar' | 'foreshore' | 'berm' | 'dune' | 'backshore' | 'inlet';
const clamp = MathUtils.clamp,
  smooth = MathUtils.smoothstep;
const bell = (v: number) => Math.exp(-v * v);
export const shoreSite = () => ({
  cross: 0,
  along: 0,
  tangentX: 0,
  tangentZ: 1,
  bank: 0,
  zone: 'foreshore' as CoastZone,
  brackish: 0,
  shelter: 0,
});
export class Coastline {
  readonly seed: number;
  readonly sand: Readonly<SandRecipe>;
  readonly exposure: number;
  readonly duneHeight: number;
  readonly slope: number;
  readonly inletAt: number;
  readonly shoreline: readonly ShorePoint[];
  private readonly cumulative: Float64Array;
  private readonly segments: Float64Array;
  private readonly bounds: Float64Array;
  private nearestSegment = 0;
  private readonly site = shoreSite();
  private readonly phase: number;
  constructor(readonly options: CoastOptions) {
    if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
      throw new RangeError('Expected an unsigned shoreline seed');
    if (
      options.islandRadius !== undefined &&
      !(Number.isFinite(options.islandRadius) && options.islandRadius > 0)
    )
      throw new RangeError('Expected a positive island radius in metres');
    for (const pool of options.pools ?? [])
      if (
        ![pool.along, pool.cross, pool.radius, pool.floor, pool.lip].every(Number.isFinite) ||
        pool.along < 0 ||
        pool.along > 1 ||
        pool.radius <= 0 ||
        pool.lip <= pool.floor
      )
        throw new RangeError('Invalid shoreline rock pool');
    this.seed = options.seed >>> 0;
    this.sand = Object.freeze({ ...(options.sand ?? SANDS.quartz) });
    const pale = this.sand.paleFraction ?? 0.12,
      heavy = this.sand.heavyFraction ?? 0.06;
    if (![pale, heavy].every(Number.isFinite) || pale < 0 || heavy < 0 || pale + heavy > 1)
      throw new RangeError('Mineral fractions must be non-negative and total at most one');
    this.exposure = options.exposure ?? 0.72;
    this.duneHeight = options.duneHeight ?? 7;
    this.slope = options.beachSlope ?? 0.055;
    if (
      ![this.sand.grainMm, this.sand.drainageSeconds, this.slope].every((v) => Number.isFinite(v) && v > 0) ||
      ![this.sand.packing, this.sand.angularity, this.exposure].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 1,
      ) ||
      !Number.isFinite(this.duneHeight) ||
      this.duneHeight < 0
    )
      throw new RangeError('Invalid coastal sediment or landform parameters');
    const rand = mulberry32(this.seed);
    this.phase = rand() * Math.PI * 2;
    const base =
      options.shoreline ??
      Array.from({ length: 29 }, (_, i): ShorePoint => {
        const z = (i - 14) * 78;
        const x =
          23 * Math.sin(z / 162 + this.phase) +
          12 * Math.sin(z / 79 + this.phase * 1.7) -
          52 * bell((z - 232) / 103) +
          78 * bell((z + 318) / 86);
        return [x, z];
      });
    if (base.length < 2 || base.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
      throw new RangeError('A shoreline needs two or more finite XZ points');
    for (let i = 1; i < base.length; i++)
      if (Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]) < 0.001)
        throw new RangeError('Adjacent shoreline points coincide');
    const curve = base.length > 2 ? new CatmullRomCurve3(base.map((p) => new Vector3(p[0], 0, p[1]))) : null;
    const resolved: readonly ShorePoint[] = curve
      ? curve.getPoints(Math.min(512, (base.length - 1) * 4)).map((p) => [p.x, p.z] as const)
      : base;
    this.shoreline = Object.freeze(resolved.map((p) => Object.freeze([p[0], p[1]] as const)));
    this.cumulative = new Float64Array(resolved.length);
    for (let i = 1; i < resolved.length; i++) {
      const length = Math.hypot(resolved[i][0] - resolved[i - 1][0], resolved[i][1] - resolved[i - 1][1]);
      this.cumulative[i] = this.cumulative[i - 1] + length;
    }
    this.segments = new Float64Array((resolved.length - 1) * 5);
    this.bounds = new Float64Array(Math.ceil((resolved.length - 1) / 8) * 4);
    for (let j = 0; j < this.bounds.length; j += 4)
      this.bounds.set([Infinity, Infinity, -Infinity, -Infinity], j);
    for (let i = 0; i < resolved.length - 1; i++) {
      const a = resolved[i],
        b = resolved[i + 1],
        len = this.cumulative[i + 1] - this.cumulative[i],
        j = (i >> 3) * 4,
        box = this.bounds;
      this.segments.set([a[0], a[1], (b[0] - a[0]) / len, (b[1] - a[1]) / len, len], i * 5);
      box[j] = Math.min(box[j], a[0], b[0]);
      box[j + 1] = Math.min(box[j + 1], a[1], b[1]);
      box[j + 2] = Math.max(box[j + 2], a[0], b[0]);
      box[j + 3] = Math.max(box[j + 3], a[1], b[1]);
    }
    this.inletAt = options.inletAt ?? this.length * 0.59;
  }
  project(x: number, z: number, out = shoreSite()) {
    const data = this.segments,
      boxes = this.bounds,
      count = data.length / 5;
    let nearest = Infinity,
      best = this.nearestSegment;
    for (let group = -1; group < boxes.length / 4; group++) {
      if (group >= 0) {
        const k = group * 4,
          dx = Math.max(0, boxes[k] - x, x - boxes[k + 2]),
          dz = Math.max(0, boxes[k + 1] - z, z - boxes[k + 3]);
        if (dx * dx + dz * dz > nearest) continue;
      }
      const start = group < 0 ? 0 : group * 8,
        end = group < 0 ? 3 : Math.min(count, start + 8);
      for (let n = start; n < end; n++) {
        const i = group < 0 ? (n === 0 ? this.nearestSegment : n === 1 ? 0 : count - 1) : n,
          k = i * 5;
        const dx = x - data[k],
          dz = z - data[k + 1],
          tx = data[k + 2],
          tz = data[k + 3];
        const d = clamp(dx * tx + dz * tz, i === 0 ? -Infinity : 0, i === count - 1 ? Infinity : data[k + 4]);
        const ex = dx - tx * d,
          ez = dz - tz * d,
          sq = ex * ex + ez * ez;
        if (sq > nearest || (sq === nearest && i >= best)) continue;
        nearest = sq;
        best = i;
        out.along = this.cumulative[i] + d;
        out.cross = dx * tz - dz * tx;
        out.tangentX = tx;
        out.tangentZ = tz;
      }
    }
    this.nearestSegment = best;
    const c = out.cross,
      a = out.along;
    const channel = a - this.inletAt - 0.26 * c - 12 * Math.sin(c / 47);
    out.bank = this.options.inlet === false ? 1000 : Math.abs(channel);
    out.shelter = clamp(0.44 + 0.38 * Math.sin(a / 109 + this.phase) - 0.21 * this.exposure, 0, 1);
    out.brackish = (1 - smooth(out.bank, 8, 32)) * smooth(c, -9, 34);
    out.zone =
      out.bank < 12 && c > -65
        ? 'inlet'
        : c < -46
          ? 'offshore'
          : c < -14
            ? 'bar'
            : c < 16
              ? 'foreshore'
              : c < 30
                ? 'berm'
                : c < 82
                  ? 'dune'
                  : 'backshore';
    return out;
  }
  /** Use for authored spawn points. along is measured from the beginning of the spline. */
  point(along: number, cross: number, out = { x: 0, z: 0 }) {
    let i = 1;
    while (i < this.shoreline.length - 1 && along > this.cumulative[i]) i++;
    const a = this.shoreline[i - 1],
      b = this.shoreline[i],
      len = this.cumulative[i] - this.cumulative[i - 1],
      d = along - this.cumulative[i - 1];
    const tx = (b[0] - a[0]) / len,
      tz = (b[1] - a[1]) / len;
    out.x = a[0] + tx * d + tz * cross;
    out.z = a[1] + tz * d - tx * cross;
    return out;
  }
  get length() {
    return this.cumulative[this.cumulative.length - 1];
  }
  height(x: number, z: number) {
    if (this.options.heightAt) return this.options.heightAt(x, z);
    const s = this.project(x, z, this.site),
      c = s.cross,
      a = s.along;
    const surfSlope = this.slope * (0.9 + 0.12 * Math.sin(a / 61 + this.phase));
    const toe = 44 + 7 * Math.sin(a / 58 + this.phase),
      crest = toe + 15 + 5 * Math.sin(a / 38);
    const dune =
      this.duneHeight *
      (0.65 + 0.35 * Math.sin(a / 87 + this.phase) ** 2) *
      bell((c - crest) / (c < crest ? 24 : 13));
    const berm = 0.53 * bell((c - 24 - 2 * Math.sin(a / 31)) / 8);
    const bar = (0.75 + this.exposure * 0.52) * bell((c + 29 + 7 * Math.sin(a / 77)) / 10);
    const rise = surfSlope * Math.min(c, 42) + Math.max(c - 78, 0) * 0.038;
    const relief = (0.2 * Math.sin(x / 11 + Math.sin(z / 21)) + 0.14 * Math.sin(z / 7)) * smooth(c, 18, 50);
    const channel = (1 - smooth(s.bank, 6, 27)) * smooth(c, -65, -19) * (1 - smooth(c, 138, 206));
    let h = MathUtils.lerp(
      rise + dune + berm + bar + relief,
      -1.2 + 0.003 * c + 0.14 * Math.sin(a / 17),
      channel,
    );
    const region = this.options.relief ?? 'mainland',
      inland = smooth(c, 70, 230);
    const ridge =
      Math.sin(x * 0.011 + Math.sin(z * 0.0041) * 1.5 + this.phase) * 0.31 +
      Math.cos(z * 0.014 + x * 0.002) * 0.19;
    const spine = Math.max(0, 0.46 + ridge + 0.18 * Math.sin(x * 0.032 - z * 0.013));
    if (region === 'cay') {
      const width = 110 + 36 * Math.sin(a / 97 + this.phase);
      h = MathUtils.lerp(
        h,
        -0.06 * (c - width) + 0.5 * Math.sin(z * 0.035),
        smooth(c, width - 30, width + 22),
      );
    } else {
      const upland = region === 'lava' ? 112 : region === 'terrace' ? 22 : 54;
      h += inland * (upland * spine * spine + 5 * Math.sin(x * 0.047 + z * 0.024));
      if (region === 'lava')
        h += Math.exp(-(((c - 18) / 12) ** 2)) * Math.max(0, 3.4 * Math.sin(a * 0.058) - 1.1);
    }
    for (const pool of this.options.pools ?? []) {
      const distance = Math.hypot((a - pool.along * this.length) * 0.72, c - pool.cross) / pool.radius;
      if (distance < 1.38) {
        const inner = MathUtils.lerp(pool.floor, pool.lip, smooth(distance, 0.4, 0.88));
        h = MathUtils.lerp(inner, h, smooth(distance, 0.88, 1.38));
      }
    }
    if (this.options.islandRadius !== undefined) {
      const r = this.options.islandRadius;
      h = MathUtils.lerp(h, -26, smooth(Math.hypot(x * 0.91, z * 1.08), r * 0.77, r));
    }
    return h;
  }
  heightmap(size = 900, segments = 256): TerrainHeightmap {
    if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(segments) || segments < 2 || segments > 2048)
      throw new RangeError('Invalid coastal heightmap extent or segments');
    const heights = new Float32Array((segments + 1) ** 2);
    for (let iz = 0, k = 0; iz <= segments; iz++)
      for (let ix = 0; ix <= segments; ix++, k++)
        heights[k] = this.height((ix / segments - 0.5) * size, (iz / segments - 0.5) * size);
    return { size, segments, heights };
  }
}
