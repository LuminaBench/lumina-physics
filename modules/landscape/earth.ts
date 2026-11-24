import { DataTexture, LinearFilter, RGBAFormat } from 'three/webgpu';
import { landscape } from '../terrain/landscape';
import { terrainReading, type TerrainHeightmap, type TerrainSurface } from '../terrain/surface';
import type { Habitat, RegionRecipe, Season, Site, Soil } from './library';
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const DAYS = { spring: 110, summer: 188, autumn: 288, winter: 15 };
export const solarDay = (season: Season, latitude: number) =>
  1 + ((DAYS[season] - 1 + (latitude < 0 ? 182 : 0)) % 365);
export function riverCenter(z: number, seed: number) {
  const k = (seed % 607) * 0.013;
  return Math.sin(z * 0.016 + k) * 22 + Math.sin(z * 0.039 - k) * 7;
}
export function regionHeight(r: RegionRecipe, seed: number) {
  const base = landscape(r.biome, seed),
    k = (seed % 827) * 0.01;
  return (x: number, z: number) => {
    const h = base(x, z),
      d = x - riverCenter(z, seed),
      bank = Math.abs(d),
      und = Math.sin(0.035 * x + k) * Math.cos(0.056 * z - k),
      gully = Math.sin(z * 0.047 + x * 0.015 + k);
    let y = h;
    switch (r.form) {
      case 'wood':
      case 'fans': {
        const outside = clamp01(0.5 + 0.5 * Math.sign(d) * Math.sin(z * 0.017 + k));
        const width = 5.9 + 2.7 * Math.sin(z * 0.022 + k) + 1.3 * Math.cos(z * 0.065);
        const pointBar =
          smooth((bank - width + 2) / 8) * (1 - smooth((bank - width - 5) / 12)) * (1 - outside);
        const creek = Math.abs(d - (33 + Math.sin(z * 0.043 + k) * 13 + z * 0.27));
        y =
          -2.6 +
          smooth((bank - width) / (16 - 8 * outside)) * 5.2 +
          smooth((bank - width - 8) / (34 - 15 * outside)) * (4 + 6 * outside) +
          Math.max(0, bank - 29) * 0.16 +
          und * smooth(bank / 18) * 2.7 +
          pointBar * 1.5 -
          Math.exp((-creek * creek) / 38) * smooth((bank - 8) / 20) * 3.8 +
          0.21 * Math.sin(x * 0.21 + z * 0.18) * Math.cos(z * 0.12);
        break;
      }
      case 'farm':
        y =
          -1.6 +
          smooth((bank - 4) / 9) * 5.4 +
          und * 0.45 +
          Math.cos(x * 2.25) * 0.17 * smooth((bank - 14) / 10);
        break;
      case 'marsh':
        y = -1.4 + smooth((bank - 2) / 22) * 2.9 + und * 0.85 + 0.35 * Math.sin(x * 0.23 + z * 0.14);
        break;
      case 'mountain':
        y =
          h * 0.68 +
          26 * Math.abs(Math.sin(x * 0.015 - z * 0.008 + k)) +
          11 * und -
          9 * smooth((gully - 0.45) / 0.55);
        break;
      case 'snowfield':
        y = 5 + h * 0.32 + 2.4 * und + 1.3 * Math.sin(x * 0.21 + z * 0.047) * smooth((gully + 0.15) / 1.1);
        break;
      case 'street': {
        const road = streetDistance(x, z);
        y = 2.55 - Math.min(5, road) * 0.022 + 0.0033 * z + smooth((road - 5) / 2) * (0.27 + und * 0.19);
        break;
      }
      case 'wash':
        y =
          0.7 +
          0.008 * z +
          smooth((bank - 2) / 12) * 2 +
          smooth((bank - 15) / 16) * (9 + 3 * und) +
          4 * Math.sin(x * 0.048 + z * 0.012 + k) * smooth(bank / 48) +
          0.38 * Math.sin(x * 0.32 + z * 0.13) * smooth((bank - 16) / 24);
        break;
      case 'watershed':
        y = watershedHeight(x, z, seed);
        break;
      case 'shore':
      case 'uplands':
        y = h + smooth((h - 2) / 5) * Math.max(0, gully - 0.42) * Math.sin(x * 0.31 + z * 0.07) * 1.9;
        break;
    }
    const result = y * r.relief;
    return r.shape ? r.shape(x, z, result, seed) : result;
  };
}
export const streetDistance = (x: number, z: number) => Math.abs(x - 8 * Math.sin(z * 0.015));
export function regionalRiver(x: number, seed: number, branch = 0) {
  const main = 58 * Math.sin(x * 0.003 + (seed % 1097) * 0.024) + 19 * Math.sin(x * 0.009) - 20;
  if (branch === 1) return main + Math.max(0, -x - 180) * 0.34 + 12 * Math.sin(Math.max(0, -180 - x) * 0.012);
  if (branch === 2) return main + 590 + 46 * Math.sin(x * 0.006);
  return main;
}
export function regionalChannel(x: number, z: number, seed: number) {
  return Math.min(
    Math.abs(z - regionalRiver(x, seed)),
    Math.abs(z - regionalRiver(x, seed, 1)),
    Math.abs(z - regionalRiver(x, seed, 2)),
  );
}
export function regionalWaterLevel(x: number, z: number, seed: number) {
  const coast = 115 + 45 * Math.sin(z * 0.003 + (seed % 1097) * 0.024) + 22 * Math.sin(z * 0.009);
  return Math.max(0, (coast - x) * 0.008 - 0.78);
}
export function watershedClimate(x: number, z: number, seed: number) {
  const coast = 115 + 45 * Math.sin(z * 0.003 + (seed % 1097) * 0.024) + 22 * Math.sin(z * 0.009);
  const inland = coast - x,
    lee = smooth((inland - 540) / 410);
  return clamp01(
    0.77 -
      lee * 0.49 +
      0.12 * Math.cos(z * 0.007 + x * 0.003) +
      0.19 * Math.exp(-regionalChannel(x, z, seed) / 46),
  );
}
export function watershedHeight(x: number, z: number, seed: number) {
  const p = (seed % 1097) * 0.024;
  const coast = 115 + 45 * Math.sin(z * 0.003 + p) + 22 * Math.sin(z * 0.009);
  const inland = coast - x;
  const divider = Math.sin(x * 0.0035 + z * 0.001 + p) * 0.5 + 0.5;
  const river = Math.abs(Math.sin(x * 0.009 + Math.sin(z * 0.004 + p) * 1.4));
  const ridge = Math.exp(-((inland - 670) ** 2) / 125000) * 85 * (0.63 + 0.37 * Math.cos(z * 0.005));
  const valley =
    Math.min(175, Math.max(-65, inland * 0.16)) *
      (0.24 + 0.76 * divider * divider) *
      (0.14 + 0.86 * smooth(river * 1.6)) +
    ridge +
    Math.sin(z * 0.04 + x * 0.008) * 1.8;
  const distance = regionalChannel(x, z, seed),
    bed = Math.max(-3, inland * 0.008 - 1.4);
  return inland < 0 ? valley : bed + (valley - bed) * smooth(distance / 61);
}
export function generateRegionMap(
  r: RegionRecipe,
  seed: number,
  size = 540,
  segments = 224,
): TerrainHeightmap {
  const height = regionHeight(r, seed),
    data = new Float32Array((segments + 1) ** 2);
  for (let j = 0, i = 0; j <= segments; j++)
    for (let k = 0; k <= segments; k++, i++)
      data[i] = height((k / segments - 0.5) * size, (j / segments - 0.5) * size);
  return { size, segments, heights: data };
}
export const SOILS: readonly Soil[] = ['loam', 'clay', 'gravel', 'sand', 'peat', 'snow', 'asphalt'];
const infiltration: Record<Soil, number> = {
  loam: 0.58,
  clay: 0.23,
  gravel: 0.91,
  sand: 0.83,
  peat: 0.28,
  snow: 0.42,
  asphalt: 0.025,
};
export interface SoilSite extends Site {
  soil: Soil;
  drainage: number;
  film: number;
  water: number;
  compaction: number;
  snow: number;
  frost:number;
  slush:number;
  litter: number;
  disturbance: number;
  reason: string;
}
export const soilSite = (): SoilSite => ({
  x: 0,
  z: 0,
  height: 0,
  slope: 0,
  moisture: 0,
  exposure: 0,
  shade: 0,
  soil: 'loam',
  drainage: 0,
  film: 0,
  water: 0,
  compaction: 0,
  snow: 0,
  frost:0,slush:0,
  litter: 0,
  disturbance: 0,
  reason: '',
});
type Stamp = { x: number; z: number; compression: number; water: number; flat: number };
export interface FallenPose {
  id: string;
  matrix: number[];
}
export interface EarthSave {
  poses?: FallenPose[];
  cells: Stamp[];
  fallen: string[];
  season: Season;
  rain: number;
}
export class EarthState {
  private readonly read = terrainReading();
  private readonly site = soilSite();
  private readonly cells = new Map<number, Stamp>();
  readonly fallen = new Set<string>();
  readonly fallenMatrices = new Map<string, number[]>();
  private readonly bytes: Uint8Array;
  readonly map: DataTexture;
  readonly habitatMap: DataTexture;
  private readonly transfers = new Map<number, number>();
  readonly resolution = 256;
  sunlight=.45;
  recoverySeconds = 78;
  rain = 0;
  private raining = 0;
  private seconds = 0;
  constructor(
    readonly region: RegionRecipe,
    readonly terrain: TerrainSurface,
    readonly seed: number,
    public season: Season,
    readonly allowed?: (x: number, z: number) => boolean,
    readonly substrate?: (x: number, z: number) => Soil | undefined,
  ) {
    this.bytes = new Uint8Array(this.resolution ** 2 * 4);
    this.map = new DataTexture(this.bytes, this.resolution, this.resolution, RGBAFormat);
    this.map.magFilter = this.map.minFilter = LinearFilter;
    this.map.needsUpdate = true;
    const sites = new Uint8Array(this.bytes.length),
      n = this.resolution;
    for (let v = 0, i = 0; v < n; v++)
      for (let u = 0; u < n; u++, i += 4) {
        const s = this.inspect(
          ((u + 0.5) / n - 0.5) * terrain.size,
          ((v + 0.5) / n - 0.5) * terrain.size,
          this.site,
        );
        sites[i] = Math.round(255 * s.moisture);
        sites[i + 1] = Math.round(255 * s.drainage);
        sites[i + 2] = Math.round(255 * s.shade);
        sites[i + 3] = Math.round((255 * SOILS.indexOf(s.soil)) / 6);
      }
    this.habitatMap = new DataTexture(sites, n, n, RGBAFormat);
    this.habitatMap.magFilter = this.habitatMap.minFilter = LinearFilter;
    this.habitatMap.needsUpdate = true;
  }
  private key(x: number, z: number) {
    const u = Math.floor((x / this.terrain.size + 0.5) * this.resolution),
      v = Math.floor((z / this.terrain.size + 0.5) * this.resolution);
    return u < 0 || v < 0 || u >= this.resolution || v >= this.resolution ? -1 : v * this.resolution + u;
  }
  private write(k: number, c: Stamp) {
    this.bytes[k * 4] = Math.round(255 * c.compression);
    this.bytes[k * 4 + 1] = Math.round(255 * clamp01(c.water / 0.12));
    this.bytes[k * 4 + 2] = Math.round(255 * c.flat);
  }
  inspect(x: number, z: number, out = soilSite()): SoilSite {
    const q = this.terrain.sample(x, z, this.read),
      r = this.region;
    const patch =
      0.5 +
      0.5 * Math.sin(x * 0.049 + (this.seed % 29) + Math.sin(z * 0.036)) * Math.cos(z * 0.057 - x * 0.013);
    const shelter = clamp01(0.24 + 0.49 * patch - 0.24 * q.normal.z - 0.18 * q.slope);
    const near = clamp01(1 - Math.max(0, q.height - this.terrain.waterLevel) / 8);
    let soil = r.soil;
    if (r.form === 'street') soil = streetDistance(x, z) < 4.5 ? 'asphalt' : 'loam';
    else if (q.slope > 0.9) soil = 'gravel';
    else if (r.form === 'wood' && near > 0.69) soil = patch > 0.5 ? 'clay' : 'gravel';
    soil = this.substrate?.(x, z) ?? soil;
    if(soil==='snow'&&this.season!=='winter')soil='loam';
    const drain = clamp01(infiltration[soil] + q.slope * 0.17 - 0.16 * shelter);
    const cell = this.cells.get(this.key(x, z));
    out.x = x;
    out.z = z;
    out.height = q.height;
    out.slope = q.slope;
    out.soil = soil;
    out.shade = shelter;
    out.exposure = 1 - shelter;
    out.drainage = drain;
    out.moisture = clamp01(r.rainfall * 0.4 + near * 0.34 + shelter * 0.16 + this.rain * (1 - drain) * 0.64);
    out.compaction = cell?.compression ?? 0;
    out.disturbance = cell?.flat ?? 0;
    out.film = clamp01(this.rain * (0.3 + 0.7 * (1 - drain)) + (cell?.water ?? 0) * 9);
    const submerged =
      this.terrain.biome === 'dry-highlands' ? 0 : Math.max(0, this.terrain.waterLevel - q.height);
    out.water =
      submerged +
      Math.max(0, this.rain - 0.57) * (1 - drain) * clamp01(1 - q.slope * 4) * 0.085 +
      (cell?.water ?? 0);
    out.snow =
      this.season === 'winter'
        ? clamp01(0.24 + 0.66 * shelter + 0.004 * q.height - out.compaction * 0.8 - this.rain * 0.38)
        : 0;
    const thaw=clamp01(this.sunlight*out.exposure*1.6+this.rain*.54+out.compaction*.4);
    out.slush=out.snow*thaw;out.frost=this.season==='winter'?clamp01((1-out.snow)*(.3+.7*shelter)*(1-thaw)):0;
    out.snow*=1-thaw*.62;out.water+=out.slush*.014;out.film=clamp01(out.film+out.slush*.81);
    out.litter = this.season === 'autumn' ? shelter * (1 - out.compaction) : 0;
    out.reason =
      this.allowed && !this.allowed(x, z)
        ? 'host exclusion'
        : soil === 'asphalt'
          ? 'pavement'
          : q.slope > 1
            ? 'steep rock'
            : submerged > 0.65
              ? 'open water'
              : 'plantable';
    return out;
  }
  habitat(site: SoilSite, h: Habitat) {
    if (
      site.reason !== 'plantable' ||
      site.moisture < (h.minMoisture ?? 0) ||
      site.moisture > (h.maxMoisture ?? 1) ||
      site.height < (h.minHeight ?? -Infinity) ||
      site.height > (h.maxHeight ?? Infinity) ||
      site.slope > (h.maxSlope ?? 0.88)
    )
      return 0;
    return h.weight * Math.max(0, this.region.place?.(site, h.plant) ?? 1);
  }
  stamp(x: number, z: number, radius: number, load: number, water = 0) {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(radius) ||
      !Number.isFinite(load) ||
      !Number.isFinite(water) ||
      radius <= 0
    )
      throw new RangeError('Invalid ground contact');
    const n = this.resolution,
      cellSize = this.terrain.size / n,
      center = this.key(x, z);
    if (center < 0) return;
    const cx = center % n,
      cz = Math.floor(center / n),
      span = Math.min(n, Math.ceil(radius / cellSize));
    for (let dz = -span; dz <= span; dz++)
      for (let dx = -span; dx <= span; dx++) {
        if (cx + dx < 0 || cx + dx >= n || cz + dz < 0 || cz + dz >= n) continue;
        const strength = clamp01(1 - (Math.hypot(dx, dz) * cellSize) / (radius + 0.5 * cellSize));
        if (!strength) continue;
        const k = (cz + dz) * n + cx + dx;
        let c = this.cells.get(k);
        if (!c) {
          c = {
            x: ((cx + dx + 0.5) / n - 0.5) * this.terrain.size,
            z: ((cz + dz + 0.5) / n - 0.5) * this.terrain.size,
            compression: 0,
            water: 0,
            flat: 0,
          };
          this.cells.set(k, c);
        }
        c.compression = clamp01(c.compression + load * strength * 0.36);
        c.flat = clamp01(c.flat + load * strength);
        c.water = Math.min(0.12, Math.max(0, c.water + water * strength));
        this.write(k, c);
      }
    this.map.needsUpdate = true;
  }
  /** A bounded source pulse advances downhill on the same grid used by the ground material. */
  discharge(x: number, z: number, depth: number, radius = 2) {
    this.stamp(x, z, radius, 0, Math.max(0, depth));
  }
  setRain(value: number) {
    this.raining = clamp01(value);
  }
  update(dt: number) {
    this.rain += (this.raining - this.rain) * -Math.expm1(-dt / (this.raining > this.rain ? 5 : 38));
    this.seconds += dt;
    if (this.seconds < 0.5) return;
    const elapsed = this.seconds;
    this.seconds = 0;
    const previousCells = this.cells.size;
    this.transfers.clear();
    for (const [k, c] of this.cells) {
      if (c.water > 0.002) {
        const q = this.terrain.sample(c.x, c.z, this.read),
          dx = q.normal.x,
          dz = q.normal.z;
        const next =
          Math.abs(dx) > Math.abs(dz)
            ? this.key(c.x + (Math.sign(dx) * this.terrain.size) / this.resolution, c.z)
            : this.key(c.x, c.z + (Math.sign(dz) * this.terrain.size) / this.resolution);
        if (next >= 0 && next !== k) {
          const n = this.resolution,
            w = this.terrain.size / n,
            height = q.height;
          const elevation = this.terrain.sample(
            (((next % n) + 0.5) / n - 0.5) * this.terrain.size,
            ((Math.floor(next / n) + 0.5) / n - 0.5) * this.terrain.size,
            this.read,
          ).height;
          const receiver = this.cells.get(next)?.water ?? 0,
            staged = this.transfers.get(next) ?? 0;
          const head = height + c.water - elevation - receiver - staged;
          const amount = Math.max(
            0,
            Math.min(c.water * 0.47, head * 0.5, (head * elapsed) / w, 0.12 - receiver - staged),
          );
          if (amount > 0.000001) {
            this.transfers.set(next, staged + amount);
            c.water -= amount;
          }
        }
      }
      c.flat *= Math.exp(-elapsed / this.recoverySeconds);
      c.water *= Math.exp(-elapsed / (35 + 95 * this.rain));
      this.write(k, c);
      if (c.flat < 0.002 && c.compression < 0.002 && c.water < 0.0002) this.cells.delete(k);
    }
    for (const [k, amount] of this.transfers) {
      if (amount <= 0) continue;
      let c = this.cells.get(k);
      if (!c) {
        const n = this.resolution;
        c = {
          x: (((k % n) + 0.5) / n - 0.5) * this.terrain.size,
          z: ((Math.floor(k / n) + 0.5) / n - 0.5) * this.terrain.size,
          compression: 0,
          water: 0,
          flat: 0,
        };
        this.cells.set(k, c);
      }
      c.water = Math.min(0.12, c.water + amount);
      this.write(k, c);
    }
    if (previousCells || this.cells.size) this.map.needsUpdate = true;
  }
  save(): EarthSave {
    return {
      season: this.season,
      rain: this.rain,
      fallen: [...this.fallen],
      poses: [...this.fallenMatrices].map(([id, matrix]) => ({ id, matrix: [...matrix] })),
      cells: [...this.cells.values()].map((c) => ({ ...c })),
    };
  }
  restore(s: EarthSave) {
    if (
      !['spring', 'summer', 'autumn', 'winter'].includes(s.season) ||
      !Number.isFinite(s.rain) ||
      s.rain < 0 ||
      s.rain > 1 ||
      !Array.isArray(s.fallen) ||
      s.fallen.some((id) => typeof id !== 'string') ||
      !Array.isArray(s.cells) ||
      s.cells.length > this.resolution ** 2
    )
      throw new RangeError('Invalid saved landscape');
    for (const c of s.cells)
      if (
        ![c.x, c.z, c.compression, c.flat, c.water].every(Number.isFinite) ||
        this.key(c.x, c.z) < 0 ||
        c.compression < 0 ||
        c.compression > 1 ||
        c.flat < 0 ||
        c.flat > 1 ||
        c.water < 0 ||
        c.water > 0.12
      )
        throw new RangeError('Invalid saved soil contact');
    for (const p of s.poses ?? [])
      if (
        !s.fallen.includes(p.id) ||
        !Array.isArray(p.matrix) ||
        p.matrix.length !== 16 ||
        !p.matrix.every(Number.isFinite)
      )
        throw new RangeError('Invalid fallen tree transform');
    this.bytes.fill(0);
    this.cells.clear();
    this.fallen.clear();
    this.fallenMatrices.clear();
    for (const p of s.poses ?? []) this.fallenMatrices.set(p.id, [...p.matrix]);
    this.season = s.season;
    this.rain = this.raining = clamp01(s.rain);
    for (const id of s.fallen) this.fallen.add(id);
    for (const c of s.cells) {
      const k = this.key(c.x, c.z);
      this.cells.set(k, { ...c });
      this.write(k, c);
    }
    this.map.needsUpdate = true;
  }
  wetnessAt(x: number, z: number) {
    return this.inspect(x, z, this.site).film;
  }
  waterAt(x: number, z: number) {
    return this.inspect(x, z, this.site).water;
  }
  gripAt(x: number, z: number) {
    const s = this.inspect(x, z, this.site);
    return Math.max(
      0.16,
      (s.soil === 'asphalt' ? 0.98 : s.soil === 'clay' ? 0.68 : 0.77) -
        s.film * 0.19 -
        s.snow * 0.26 - s.frost*.19 - s.slush*.09 -
        Math.min(0.29, s.water * 2),
    );
  }
  dispose() {
    this.cells.clear();
    this.fallen.clear();
    this.fallenMatrices.clear();
    this.map.dispose();
    this.habitatMap.dispose();
  }
}
