// A bounded, steady shower. Precomputed source and fall tables are shared by gameplay and rendering.
export interface RainColumnOptions {
  center: readonly [number, number];
  radius: readonly [number, number];
  baseY: number;
  minimumY: number;
  seed: number;
  rainMmHour: number;
  dropDiameterMm: number;
  fallSpeed: number;
  /** Relative humidity at the cloud base and the lower bound, from zero to one. */
  humidity: readonly [number, number];
  /** XZ wind at the cloud base and below the column, in metres per second. */
  upperWind: readonly [number, number];
  lowerWind: readonly [number, number];
  /** Horizontal translation of the emitting cloud, in metres per second. */
  motion?: readonly [number, number];
  /** Representative drop-area loss at zero humidity, in square millimetres per second. */
  evaporation?: number;
}

const side = 64;
const levels = 129;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mix = (a: number, b: number, f: number) => a + (b - a) * f;

export class RainColumn {
  readonly sourceSize = side;
  readonly profileSize = levels;
  readonly source = new Uint8Array(side * side);
  /** RGBA rows contain downwind X/Z displacement, lost diameter² and fractional fall distance. */
  readonly profile = new Float32Array(levels * 4);
  readonly height: number;
  readonly motion: readonly [number, number];
  private readonly baseHumidity: number;
  private humidity: number;
  private readonly loss: number;
  private revision = 0;

  readonly options: Readonly<RainColumnOptions>;
  constructor(options: RainColumnOptions) {
    const pair = (p: readonly [number, number]) => Object.freeze([p[0], p[1]] as const);
    const o = (this.options = Object.freeze({
      ...options,
      center: pair(options.center),
      radius: pair(options.radius),
      humidity: pair(options.humidity),
      upperWind: pair(options.upperWind),
      lowerWind: pair(options.lowerWind),
      motion: pair(options.motion ?? [0, 0]),
    }));
    this.motion = o.motion;
    this.loss = o.evaporation ?? 0.031;
    if (
      ![
        ...o.center,
        ...o.radius,
        o.baseY,
        o.minimumY,
        o.rainMmHour,
        o.dropDiameterMm,
        o.fallSpeed,
        ...o.humidity,
        ...o.upperWind,
        ...o.lowerWind,
        ...this.motion,
        this.loss,
      ].every(Number.isFinite) ||
      !Number.isSafeInteger(o.seed) ||
      o.seed < 0 ||
      o.seed > 0xffffffff ||
      o.radius.some((r) => r <= 0) ||
      o.baseY <= o.minimumY ||
      o.rainMmHour < 0 ||
      o.fallSpeed <= 0 ||
      o.dropDiameterMm <= 0 ||
      this.loss < 0 ||
      o.humidity.some((h) => h < 0 || h > 1)
    )
      throw new RangeError('Invalid rain column');
    this.height = o.baseY - o.minimumY;
    this.baseHumidity = o.humidity[0];
    this.humidity = o.humidity[1];
    let seed = o.seed;
    const phase = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 4294967296) * 2 * Math.PI;
    };
    const a = phase(),
      b = phase(),
      c = phase();
    for (let j = 0; j < side; j++)
      for (let i = 0; i < side; i++) {
        const x = (2 * i) / (side - 1) - 1,
          z = (2 * j) / (side - 1) - 1;
        const r = Math.hypot(x, z),
          angle = Math.atan2(z, x);
        const edge = 0.88 + 0.062 * Math.sin(3 * angle + a) + 0.036 * Math.cos(5 * angle + b);
        const t = clamp((edge - r) / (edge - 0.17), 0, 1);
        const streak = 0.5 + 0.5 * Math.cos(18 * x + 9 * z + a + 2 * Math.sin(7 * z + c));
        this.source[j * side + i] = Math.round(255 * t * t * (3 - 2 * t) * (1 - 0.31 * (1 - t) * streak));
      }
    this.rebuildProfile();
  }

  get lowerHumidity() {
    return this.humidity;
  }
  get profileVersion() {
    return this.revision;
  }

  setLowerHumidity(h: number) {
    if (!Number.isFinite(h) || h < 0 || h > 1) throw new RangeError('Humidity must be in [0, 1]');
    if (h !== this.humidity) {
      this.humidity = h;
      this.rebuildProfile();
    }
  }

  private rebuildProfile() {
    const o = this.options;
    for (let j = 0; j < levels; j++) {
      const f = j / (levels - 1),
        t = (f * this.height) / o.fallSpeed;
      // Integral of linear vertical profiles along the drop path at constant representative fall speed.
      this.profile[j * 4] =
        t * (o.upperWind[0] - this.motion[0] + 0.5 * f * (o.lowerWind[0] - o.upperWind[0]));
      this.profile[j * 4 + 1] =
        t * (o.upperWind[1] - this.motion[1] + 0.5 * f * (o.lowerWind[1] - o.upperWind[1]));
      this.profile[j * 4 + 2] =
        this.loss * t * (1 - this.baseHumidity + 0.5 * f * (this.baseHumidity - this.humidity));
      this.profile[j * 4 + 3] = f;
    }
    this.revision++;
  }

  /** Flux in mm/hour at a world point, including the surviving drop volume and the finite source footprint. */
  rainAt(x: number, y: number, z: number, seconds = 0): number {
    const o = this.options;
    if (y < o.minimumY || y > o.baseY) return 0;
    const v = ((o.baseY - y) / this.height) * (levels - 1);
    const j = Math.min(levels - 2, Math.floor(v)),
      f = v - j,
      k = j * 4;
    const dx = mix(this.profile[k], this.profile[k + 4], f),
      dz = mix(this.profile[k + 1], this.profile[k + 5], f);
    const u = (((x - o.center[0] - this.motion[0] * seconds - dx) / o.radius[0]) * 0.5 + 0.5) * (side - 1);
    const w = (((z - o.center[1] - this.motion[1] * seconds - dz) / o.radius[1]) * 0.5 + 0.5) * (side - 1);
    if (u < 0 || w < 0 || u > side - 1 || w > side - 1) return 0;
    const col = Math.min(side - 2, Math.floor(u)),
      row = Math.min(side - 2, Math.floor(w));
    const i = row * side + col,
      a = u - col,
      b = w - row;
    const source =
      mix(
        mix(this.source[i], this.source[i + 1], a),
        mix(this.source[i + side], this.source[i + side + 1], a),
        b,
      ) / 255;
    const diameter2 = o.dropDiameterMm ** 2 * (0.47 + 0.53 * source);
    const area = Math.max(0, 1 - mix(this.profile[k + 2], this.profile[k + 6], f) / diameter2);
    return o.rainMmHour * source * area * Math.sqrt(area);
  }
}
