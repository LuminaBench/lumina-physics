import { frame as engineFrame } from '../../engine/frame';
import type { N } from '../../engine/tsl';
import { Color, DataTexture, RedFormat, NearestFilter } from 'three/webgpu';
import { TreadTransfer, retainedTreadFilm } from '../wet-road/tread-transfer';
import { TSL } from '../../engine/tsl';
import { createLandLibrary } from './collection';
import { EarthState, generateRegionMap, soilSite, solarDay, type SoilSite, type EarthSave } from './earth';
import { SEASONS, seedFor, type LandLibrary, type Soil, type Season } from './library';
import { TerrainSurface, type TerrainHeightmap } from '../terrain/surface';
import type { LandscapeProfile } from './profile';
export type { LandscapeProfile } from './profile';
export interface LandscapeRuntime {
  lighting?: Pick<typeof engineFrame, 'sunColor' | 'sunVisibility' | 'sunDirection' | 'time'>;
  library?: LandLibrary;
  substrate?: (x: number, z: number) => Soil | undefined;
  heightmap?: TerrainHeightmap;
  plantable?: (x: number, z: number) => boolean;
  earthSave?: EarthSave;
}
export class AuthoredLandscape {
  cloudShadow?: (position: N) => N;
  readonly lighting;
  readonly library;
  readonly region;
  readonly surface;
  readonly earth;
  readonly seeds;
  readonly cover;
  readonly rock;
  direction;
  readonly groundTint = TSL.uniform(new Color());
  readonly transmission = TSL.uniform(0);
  readonly emission = TSL.uniform(0);
  readonly treeDensity;
  readonly shrubDensity;
  readonly meadowDensity;
  readonly flowerDensity;
  readonly tracks: TreadTransfer;
  readonly flowerMask?: DataTexture;
  focusX = 0;
  focusZ = 0;
  readonly budding = TSL.uniform(0);
  readonly winter = TSL.uniform(0);
  readonly autumn = TSL.uniform(0);
  readonly rain = TSL.uniform(0);
  readonly bloom = TSL.uniform(1);
  private readonly reading = soilSite();
  constructor(
    readonly profile: LandscapeProfile,
    seed: number,
    runtime: LandscapeRuntime = {},
  ) {
    if (profile.revision !== 1) throw new RangeError('Unsupported landscape generation revision');
    this.lighting = runtime.lighting ?? engineFrame;
    this.profile = { ...profile, seeds: { ...profile.seeds } };
    this.library = runtime.library ?? createLandLibrary();
    this.region = this.library.get('region', profile.region);
    this.cover = this.library.get('cover', profile.cover ?? this.region.cover);
    this.rock = this.library.get('rock', profile.rock ?? this.region.rock);
    this.direction = this.library.get('direction', profile.direction ?? this.region.direction);
    this.setDirection(profile.direction ?? this.region.direction);
    for (const key of profile.dependencies ?? []) {
      const [family, id] = key.split('/');
      if (!['plant', 'cover', 'rock', 'direction', 'region'].includes(family) || !id)
        throw new Error('Invalid saved dependency ' + key);
      this.library.get(family as import('./library').Family, id);
    }
    for (const h of this.region.plants) this.library.get('plant', h.plant);
    const stream = (k: keyof NonNullable<LandscapeProfile['seeds']>) => {
      const v = profile.seeds?.[k] ?? seedFor(seed, k);
      if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError('Invalid ' + k + ' seed');
      return v;
    };
    this.seeds = {
      terrain: stream('terrain'),
      trees: stream('trees'),
      meadow: stream('meadow'),
      flowers: stream('flowers'),
      rocks: stream('rocks'),
      understory: stream('understory'),
      debris: stream('debris'),
    };
    const density = (v: number) => {
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError('Density must be in [0,1]');
      return v;
    };
    this.treeDensity = density(profile.treeDensity ?? this.region.canopy);
    this.shrubDensity = density(profile.shrubDensity ?? 0.82);
    this.meadowDensity = density(profile.meadowDensity ?? this.region.grass);
    this.flowerDensity = density(profile.flowerDensity ?? 0.8);
    if (
      profile.latitude !== undefined &&
      (!Number.isFinite(profile.latitude) || Math.abs(profile.latitude) > 90)
    )
      throw new RangeError('Latitude must be in [-90,90]');
    if (
      profile.dayOfYear !== undefined &&
      (!Number.isInteger(profile.dayOfYear) || profile.dayOfYear < 1 || profile.dayOfYear > 366)
    )
      throw new RangeError('Invalid calendar day');
    if (profile.northAzimuth !== undefined && !Number.isFinite(profile.northAzimuth))
      throw new RangeError('Invalid north azimuth');
    const map = runtime.heightmap ?? generateRegionMap(this.region, this.seeds.terrain);
    this.surface = new TerrainSurface(this.region.biome, this.seeds.terrain, map);
    this.earth = new EarthState(
      this.region,
      this.surface,
      this.seeds.terrain,
      profile.season ?? this.region.season,
      runtime.plantable,
      runtime.substrate,
    );
    try {
      if (runtime.earthSave) this.earth.restore(runtime.earthSave);
      if (this.cover.canFlower) {
        const n = this.earth.resolution,
          bytes = new Uint8Array(n * n),
          site = soilSite();
        for (let i = 0; i < bytes.length; i++) {
          const x = (((i % n) + 0.5) / n - 0.5) * this.surface.size,
            z = ((Math.floor(i / n) + 0.5) / n - 0.5) * this.surface.size;
          this.earth.inspect(x, z, site);
          bytes[i] = site.reason === 'plantable' && this.cover.canFlower(site, this.surface) ? 255 : 0;
        }
        this.flowerMask = new DataTexture(bytes, n, n, RedFormat);
        this.flowerMask.magFilter = this.flowerMask.minFilter = NearestFilter;
        this.flowerMask.needsUpdate = true;
      }
    } catch (error) {
      this.earth.dispose();
      throw error;
    }
    this.tracks = new TreadTransfer(0.07, 0.09);
    this.earth.recoverySeconds = this.cover.recoverySeconds ?? 78;
    this.setSeason(this.earth.season);
    this.surface.contactLayer = this.earth;
  }
  get dependencies() {
    const pairs = [
      ['region', this.profile.region],
      ['direction', this.profile.direction ?? this.region.direction],
      ['rock', this.profile.rock ?? this.region.rock],
      ['cover', this.profile.cover ?? this.region.cover],
      ...this.region.plants.map((h) => ['plant', h.plant]),
    ];
    const used = new Set<string>();
    for (const [family, id] of pairs) {
      let key: string | undefined = id;
      while (key) {
        used.add(family + '/' + key);
        key = this.library.describe(family as import('./library').Family, key).parent;
      }
    }
    return [...used].sort();
  }
  setDirection(id: string) {
    this.direction = this.library.get('direction', id);
    this.profile.direction = id;
    this.groundTint.value.set(this.direction.ground);
    this.transmission.value = this.direction.transmission;
    this.emission.value = this.direction.emission;
  }
  setSeason(s: Season) {
    if (!SEASONS.includes(s)) throw new RangeError('Unknown season ' + s);
    this.profile.season = s;
    this.earth.season = s;
    this.budding.value = Number(s === 'spring');
    this.winter.value = Number(s === 'winter');
    this.autumn.value = Number(s === 'autumn');
    this.bloom.value = this.cover.bloom.includes(s) ? this.flowerDensity : 0;
  }
  get solar() {
    const latitudeDeg = this.profile.latitude ?? this.region.latitude;
    return {
      latitudeDeg,
      dayOfYear: this.profile.dayOfYear ?? solarDay(this.earth.season, latitudeDeg),
      northAzimuthDeg: this.profile.northAzimuth ?? 90,
    };
  }
  choose(x: number, z: number, choice: number, shrubs?: boolean) {
    const site = this.earth.inspect(x, z, this.reading),
      habitats = this.region.plants;
    const weight = (h: (typeof habitats)[number]) =>
      shrubs === undefined || shrubs === this.library.get('plant', h.plant).shrub
        ? this.earth.habitat(site, h)
        : 0;
    let total = 0;
    for (const h of habitats) total += weight(h);
    if (total <= 0) return;
    let p = choice * total;
    for (const h of habitats) {
      p -= weight(h);
      if (p < 0) return h.plant;
    }
  }
  inspect(x: number, z: number) {
    const site = this.earth.inspect(x, z);
    const n = this.earth.resolution,
      cell = (v: number) => Math.max(0, Math.min(n - 1, Math.floor((v / this.surface.size + 0.5) * n)));
    const excluded = this.flowerMask && !this.flowerMask.image.data![cell(x) + cell(z) * n];
    return {
      ...site,
      region: this.profile.region,
      cover: this.profile.cover ?? this.region.cover,
      flowerReason:
        site.reason !== 'plantable'
          ? site.reason
          : !this.cover.bloom.includes(this.earth.season)
            ? 'outside flowering season'
            : site.shade < (this.cover.minimumShade ?? 0)
              ? 'insufficient shelter'
              : excluded
                ? 'outside project flower habitat'
                : 'within flowering habitat',
      plants: this.region.plants.map((h) => ({ id: h.plant, weight: this.earth.habitat(site, h) })),
      season: this.earth.season,
    };
  }
  contact(width = 0.22) {
    const channel = this.tracks.contact(width),
      s = soilSite();
    let film = 0,
      lastX = Infinity,
      lastZ = Infinity;
    return {
      sample: (
        x: number,
        z: number,
        speed: number,
        load: number,
        dt: number,
        overlay?: Pick<SoilSite, 'soil' | 'water' | 'film' | 'moisture'>,
      ) => {
        this.earth.inspect(x, z, s);
        if (overlay) Object.assign(s, overlay);
        film = retainedTreadFilm(film, s.water, s.film, 0.007, 0.34, speed, dt);
        const loose =
          s.soil === 'asphalt'
            ? 0
            : s.soil === 'clay' || s.soil === 'peat'
              ? 0.91
              : s.soil === 'gravel'
                ? 0.22
                : 0.38;
        if (s.snow > 0) film = Math.max(film, 0.00065 * s.snow * (1 - s.compaction));
        channel.sample(
          x,
          z,
          film,
          s.water,
          s.film,
          loose * s.moisture,
          load,
          Math.max(2, Math.abs(speed) * dt * 2),
        );
        if (load > 0 && Math.hypot(x - lastX, z - lastZ) > 0.28) {
          if (!overlay) this.earth.stamp(x, z, width, load * 0.64, Math.min(0.003, film * 0.37));
          this.surface.partFoliage?.(x, s.height, z, width * 1.8, Math.abs(speed));
          lastX = x;
          lastZ = z;
        }
        return film;
      },
      reset: () => {
        film = 0;
        lastX = lastZ = Infinity;
        channel.reset();
      },
      get sediment() {
        return channel.soil;
      },
    };
  }
  update(dt: number) {
    this.tracks.update(dt, this.focusX, this.focusZ);
    this.earth.update(dt);
    this.rain.value = this.earth.rain;
  }
  dispose() {
    this.flowerMask?.dispose();
    this.tracks.dispose();
    this.surface.contactLayer = undefined;
    this.earth.dispose();
  }
}
