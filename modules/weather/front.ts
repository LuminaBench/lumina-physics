import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { mulberry32 } from '../../engine/noise';
import type { CloudDistribution } from './clouds';
import type { WeatherParams, CloudLayerOptions } from './weather';

export const FRONT_TYPES = ['streets', 'marine', 'towers', 'squall', 'clearing'] as const;
export type FrontType = (typeof FRONT_TYPES)[number];
export interface FrontOptions {
  type: FrontType;
  seed: number;
  span?: number;
  origin?: readonly [number, number];
  /** Heading radians from +X towards +Z. */
  heading?: number;
  windSpeed?: number;
  upperWindSpeed?: number;
}
const families: Record<FrontType, readonly [number, number, number, number, number, number, number]> = {
  // Floor, top, cover, condensate, convection, storm fraction, visibility.
  streets: [590, 1940, 0.60, 1.12, 0.15, 0.05, 65000],
  marine: [230, 630, 0.91, 1.46, -0.75, 0.19, 13000],
  towers: [780, 4240, 0.75, 1.49, 0.48, 0.39, 48000],
  squall: [340, 2930, 0.87, 1.68, 0.29, 0.85, 27000],
  clearing: [640, 1860, 0.74, 1.12, -0.08, 0.25, 58000],
};
const fract = (x: number) => x - Math.floor(x),
  sat = (x: number) => Math.min(1, Math.max(0, x));
export const frontReading = () => ({ coverage: 0, rain: 0, gust: 0, ice: 0, windX: 0, windZ: 0 });
/** Seeded world-space footprint shared by cloud density, shafts, precipitation, wind and wetting.
 * Data texels are at cell centres; the CPU reproduces hardware bilinear repeat. */
export class WeatherFront implements CloudDistribution {
  readonly iceVeil = true;
  readonly weather: Partial<WeatherParams>;
  readonly upperClouds: CloudLayerOptions;
  readonly map: THREE.DataTexture;
  readonly span: number;
  readonly speed: number;
  readonly upperSpeed: number;
  readonly origin: readonly [number, number];
  readonly axis: readonly [number, number];
  private readonly data = new Uint8Array(128 * 128 * 4);
  private readonly point = frontReading();
  constructor(readonly options: FrontOptions) {
    const spec = families[options.type];
    if (!spec) throw new RangeError('Unknown coastal weather formation');
    this.span = options.span ?? 4600;
    this.speed = options.windSpeed ?? 8;
    this.upperSpeed = options.upperWindSpeed ?? 21;
    this.origin = options.origin ?? [0, 0];
    if (
      !Number.isSafeInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > 0xffffffff ||
      this.speed < 0 ||
      this.upperSpeed < 0
    )
      throw new RangeError('Invalid weather seed or wind speed');
    const angle = options.heading ?? 0.24;
    if (
      ![this.span, this.speed, this.upperSpeed, ...this.origin, angle].every(Number.isFinite) ||
      this.span <= 0
    )
      throw new RangeError('Invalid weather map dimensions or wind');
    this.axis = [Math.cos(angle), Math.sin(angle)];
    const [cloudBase, cloudTop, coverage, cloudDensity, convection, storm, visibility] = spec;
    this.weather = {
      cloudBase,
      cloudTop,
      coverage,
      cloudDensity,
      convection,
      storm,
      visibility,
      cloudScale: options.type === 'marine' ? 0.68 : 1.13,
      cloudErosion: options.type === 'marine' ? 0.09 : 0.24,
    };
    this.upperClouds = {
      base: 5100,
      top: options.type === 'squall' ? 6700 : 5750,
      coverage: 0.64,
      density: 0.53,
      storm: 0.08,
      convection: -0.65,
      erosion: 0.11,
      scale: 1.8,
      windX: this.upperSpeed * this.axis[0],
      windZ: this.upperSpeed * this.axis[1] + 8,
    };
    const rand = mulberry32(options.seed),
      phases = Array.from({ length: 6 }, () => rand() * Math.PI * 2);
    for (let z = 0; z < 128; z++)
      for (let x = 0; x < 128; x++) {
        const u = ((x + 0.5) / 128) * Math.PI * 2,
          v = ((z + 0.5) / 128) * Math.PI * 2;
        const bends = 0.23 * Math.sin(v + phases[0]) + 0.12 * Math.sin(v * 3 + phases[1]);
        const bank = 0.5 + 0.5 * Math.sin(u + bends);
        const bend = Math.sin(u + phases[2]) * 0.82 + 0.53 * Math.sin(2 * u - v + phases[4]);
        const streak = 0.5 + 0.5 * Math.cos(4 * v + bend);
        const clump =
          0.5 +
          0.24 * Math.sin(2 * u + v + phases[3]) +
          0.18 * Math.sin(3 * v - u + phases[1]) +
          0.08 * Math.sin(5 * u + 2 * v + phases[4]);
        let cover: number, rain: number;
        switch (options.type) {
          case 'streets': {
            const cells =
              0.49 +
              0.25 * Math.sin(3 * u + v + phases[0]) +
              0.17 * Math.cos(7 * u - 2 * v + phases[1]) +
              0.09 * Math.sin(9 * u + 3 * v + phases[3]);
            cover =
              0.18 +
              0.81 * THREE.MathUtils.smoothstep(streak * 0.48 + cells * 0.34 + clump * 0.23, 0.32, 0.77);
            rain = 0;
            break;
          }
          case 'marine':
            cover = 0.29 + 0.7 * THREE.MathUtils.smoothstep(bank + clump * 0.19, 0.2, 0.66);
            rain = 0.2 * sat((cover - 0.78) * 6);
            break;
          case 'towers':
            cover = 0.04 + 0.96 * THREE.MathUtils.smoothstep(clump * 0.56 + bank * 0.6, 0.39, 0.76);
            rain = sat((cover - 0.67) * 3.2) * sat((clump - 0.35) * 3.4);
            break;
          case 'squall':
            cover = 0.09 + 0.91 * THREE.MathUtils.smoothstep(bank + clump * 0.17, 0.42, 0.64);
            rain = sat((bank - 0.55) * 5) * (0.58 + 0.42 * clump);
            break;
          case 'clearing':
            cover = 0.07 + 0.89 * THREE.MathUtils.smoothstep(bank * 0.68 + clump * 0.42, 0.35, 0.82);
            rain = 0.75 * sat((cover - 0.55) * 3) * streak;
            break;
        }
        const i = (x + z * 128) * 4;
        this.data[i] = 255 * sat(cover);
        this.data[i + 1] = 255 * sat(rain);
        this.data[i + 2] = 255 * sat(0.2 + bank * 0.35 + streak * 0.22 + rain * 0.22);
        const feather =
          0.5 +
          0.5 * Math.cos(v * 2 + u + 0.9 * Math.sin(u * 2 + phases[5]) + 0.45 * Math.cos(v + phases[1]));
        this.data[i + 3] = 255 * sat(0.11 + 0.74 * feather * (0.54 + 0.46 * clump));
      }
    this.map = new THREE.DataTexture(this.data, 128, 128);
    this.map.wrapS = this.map.wrapT = THREE.RepeatWrapping;
    this.map.minFilter = this.map.magFilter = THREE.LinearFilter;
    this.map.needsUpdate = true;
  }
  private channel(x: number, z: number, time: number, channel: number, upper: boolean) {
    const dx = x - this.origin[0],
      dz = z - this.origin[1],
      c = this.axis[0],
      s = this.axis[1];
    const u =
      fract((dx * c + dz * s - (upper ? this.upperSpeed : this.speed) * time) / this.span + 0.5) * 128 - 0.5;
    const v = fract((-dx * s + dz * c - (upper ? 8 : 0) * time) / this.span + 0.5) * 128 - 0.5;
    const i = Math.floor(u),
      j = Math.floor(v),
      a = u - i,
      b = v - j;
    const k0 = ((i & 127) + (j & 127) * 128) * 4 + channel,
      k1 = (((i + 1) & 127) + (j & 127) * 128) * 4 + channel;
    const k2 = ((i & 127) + ((j + 1) & 127) * 128) * 4 + channel,
      k3 = (((i + 1) & 127) + ((j + 1) & 127) * 128) * 4 + channel;
    return (
      ((1 - b) * ((1 - a) * this.data[k0] + a * this.data[k1]) +
        b * ((1 - a) * this.data[k2] + a * this.data[k3])) /
      255
    );
  }
  gainAt(x: number, z: number, time: number) {
    return 0.61 + 0.88 * this.channel(x, z, time, 2, false);
  }
  gainNode(xz: N, time: N) {
    return this.mapNode(xz, time).b.mul(0.88).add(0.61);
  }
  coverageAt(x: number, z: number, time: number, upper: boolean) {
    return this.channel(x, z, time, upper ? 3 : 0, upper);
  }
  sample(x: number, z: number, time: number, out = this.point) {
    out.coverage = this.coverageAt(x, z, time, false);
    out.ice = this.coverageAt(x, z, time, true);
    out.rain = this.channel(x, z, time, 1, false);
    out.gust = this.channel(x, z, time, 2, false);
    const wind = this.speed * (0.61 + 0.88 * out.gust);
    out.windX = this.axis[0] * wind;
    out.windZ = this.axis[1] * wind;
    return out;
  }
  mapNode(xz: N, time: N, upper = false): N {
    const { vec2, texture, dot } = TSL;
    const p = xz.sub(vec2(...this.origin)),
      c = this.axis[0],
      s = this.axis[1];
    const local = vec2(
      dot(p, vec2(c, s)).sub(time.mul(upper ? this.upperSpeed : this.speed)),
      dot(p, vec2(-s, c)).sub(time.mul(upper ? 8 : 0)),
    );
    return texture(this.map, local.div(this.span).add(0.5)).level(0);
  }
  coverageNode(xz: N, time: N, upper: boolean) {
    const sample = this.mapNode(xz, time, upper);
    return upper ? sample.a : sample.r;
  }
  dispose() {
    this.map.dispose();
  }
}
