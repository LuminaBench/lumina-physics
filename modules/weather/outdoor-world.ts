import type * as THREE from 'three/webgpu';
import { SunFx } from '../../engine/sun-fx';
import { TSL } from '../../engine/tsl';
import { WorldBus } from '../../engine/world-bus';
import { QUALITY_PRESETS } from '../../engine/quality';
import { Rain } from './rain';
import { setSolarTime } from './solar-clock';
import { resolveWorldProfile, patchWorldProfile, SKY_STATES, type WorldProfile, type ResolvedWorldProfile, type ProfilePatch } from './world-profile';
import { LuminaEngine, type EngineOptions } from '../../engine/engine';
import { validateClimate, type ClimateProfile } from '../../engine/climate';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS, type WeatherParams, type CloudLayerOptions } from './weather';
import type { LocalProbeOptions } from './reflection-probe';
import { Ocean, type OceanOptics, type TideOptions } from '../water/ocean';
import { OCEAN_PRESETS, type OceanParams } from '../water/spectrum';
import { TerrainSurface, terrainReading, type TerrainHeightmap } from '../terrain/surface';
import { BiomeFoliage } from '../terrain/foliage';
import { Bathymetry } from '../water/seabed';

export interface LuminaWorldOptions extends EngineOptions {
  weather?: Partial<WeatherParams> | keyof typeof WEATHER_PRESETS;
  climate?: ClimateProfile;
  upperClouds?: CloudLayerOptions;
  localProbe?: LocalProbeOptions;
  waterLevel?: number;
  tide?: TideOptions;
  optics?: Partial<OceanOptics>;
  /** Pass false for a scene without water. */
  ocean?: OceanParams | keyof typeof OCEAN_PRESETS | false;
  bathymetry?: Bathymetry;
}

export interface LuminaWorld {
  engine: LuminaEngine;
  weather: Weather;
  ocean: Ocean | null;
  fx: EffectsKit;
}

/**
 * Stand up a complete world in one call: renderer + TRAA pipeline + physics, sky, clouds,
 * sun, (optional) ocean and the shared effects kit. Add your own meshes to
 * `engine.scene`, place `engine.camera`, then `engine.start()`.
 */
async function createOutdoorWorld(options: LuminaWorldOptions): Promise<LuminaWorld> {
  const w = options.weather ?? 'tropical';
  const sky = typeof w === 'string' ? WEATHER_PRESETS[w] : w;
  const sea = options.ocean ?? 'breeze';
  const waves = typeof sea === 'string' ? OCEAN_PRESETS[sea] : sea;
  if (!sky) throw new RangeError('Unknown weather preset: ' + w);
  if (waves === undefined) throw new RangeError('Unknown ocean preset: ' + sea);
  if (options.climate) validateClimate(options.climate);
  const engine = await LuminaEngine.create({ ...options, preloadClouds: options.preloadClouds ?? true });
  try {
    if (options.climate) engine.world.setClimate(options.climate);
    const weather = engine.add(new Weather(engine, { upperClouds: options.upperClouds, localProbe: options.localProbe }));
    Object.assign(weather.params, sky);
    let ocean: Ocean | null = null;
    if (waves) {
      ocean = engine.add(new Ocean(engine, { weather, bathymetry: options.bathymetry, waterLevel: options.waterLevel, tide: options.tide }));
      ocean.setSeaStates(waves, waves);
      if (waves.windSpeed === 0 && waves.swellHeight === 0) ocean.optics.breakerHeight = 0;
      Object.assign(ocean.optics, options.optics);
      if (options.bathymetry) engine.scene.add(options.bathymetry.mesh);
      // Keep the interaction field centred on the camera unless the game re-targets it.
      engine.onUpdate = (dt) => ocean!.updateField(dt, engine.camera.position);
    }
    const fx = engine.add(new EffectsKit(engine));
    const resize = () => engine.resize();
    window.addEventListener('resize', resize);
    engine.add({ dispose: () => window.removeEventListener('resize', resize) });
    return { engine, weather, ocean, fx };
  } catch (error) {
    engine.dispose();
    throw error;
  }
}

export interface ProfileControls {
  readonly profile: ResolvedWorldProfile;
  patch(change: ProfilePatch, transitionSeconds?: number): ResolvedWorldProfile;
  dispose(): void;
}
export interface RainHost { scene: THREE.Scene; camera: THREE.Camera; fields?: WorldBus }
export interface RainAttachment extends ProfileControls { update(dt: number): void; rain: Rain }
export interface ProfileWorld extends LuminaWorld, ProfileControls { terrain: TerrainSurface; foliage: BiomeFoliage; bed: Bathymetry }

/** A host owns its renderer, scene graph, camera and clock. Only the rain mesh is attached. */
function attachRain(profile: ResolvedWorldProfile, host: RainHost): RainAttachment {
  const fields = host.fields ?? new WorldBus();
  const clock = TSL.uniform(0);
  const local = { scene: host.scene, camera: host.camera, world: fields, wind: fields, time: 0,
    quality: { preset: QUALITY_PRESETS[profile.quality === 'auto' ? 'high' : profile.quality] },
    stats: { frameMs: 16.67 }, lens: { rain: 0 } };
  const sky = { params: { rain: WEATHER_PRESETS[SKY_STATES[profile.weather]].rain } };
  const rain = new Rain(local, sky, clock, profile.seed % 8191);
  rain.update(0);
  let disposed = false;
  return {
    rain, get profile() { return profile; },
    update(dt) {
      if (disposed) return;
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Expected nonnegative seconds');
      local.time += dt;
      clock.value = local.time;
      rain.update(dt);
    },
    patch(change) {
      if (disposed) throw new Error('Rain attachment is disposed');
      const next = patchWorldProfile(profile, change);
      sky.params.rain = WEATHER_PRESETS[SKY_STATES[next.weather]].rain;
      if (next.quality !== profile.quality) rain.setQuality(QUALITY_PRESETS[next.quality === 'auto' ? 'high' : next.quality]);
      rain.update(0);
      return profile = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rain.dispose();
      if (!host.fields) fields.shelters.dispose();
    },
  };
}

export type ProfileRuntime = Partial<Omit<EngineOptions, 'tier'>> & { heightmap?: TerrainHeightmap; plantable?: (x:number,z:number) => boolean };
export function createLuminaWorld(options: LuminaWorldOptions): Promise<LuminaWorld>;
export function createLuminaWorld(input: WorldProfile & { mode: 'attach' }, host: RainHost): Promise<RainAttachment>;
export function createLuminaWorld(input: WorldProfile, runtime?: ProfileRuntime): Promise<ProfileWorld>;
export async function createLuminaWorld(input: LuminaWorldOptions | WorldProfile, runtime: ProfileRuntime | RainHost = {}):
    Promise<LuminaWorld | RainAttachment | ProfileWorld> {
  if (!('profileVersion' in input)) return createOutdoorWorld(input);
  let profile = resolveWorldProfile(input);
  if (profile.mode === 'attach') {
    if (!('scene' in runtime) || !runtime.camera) throw new Error('Attach mode requires a host scene and camera');
    return attachRain(profile, runtime);
  }
  if ('scene' in runtime) throw new Error('A host scene requires attach mode');
  const canvas = runtime.canvas ?? document.createElement('canvas');
  const sea = (p: ResolvedWorldProfile) => ({ ...OCEAN_PRESETS[p.values.seaState], seed: p.seed });
  const terrain = new TerrainSurface(profile.biome, profile.seed, runtime.heightmap);
  const reading = terrainReading();
  const bed = new Bathymetry({ size: terrain.size, resolution: terrain.segments + 1,
    height: (x,z) => terrain.sample(x,z,reading).height, geometry: terrain.geometry() });
  let world: LuminaWorld;
  try {
    world = await createOutdoorWorld({ ...runtime, canvas, tier: profile.quality, bathymetry: bed,
      ocean: profile.biome === 'dry-highlands' ? false : sea(profile), weather: SKY_STATES[profile.weather] });
  } catch (error) { bed.dispose(); throw error; }
  try {
    if (!runtime.canvas) document.body.appendChild(canvas);
    const { engine, weather, ocean } = world;
    if (!ocean) engine.scene.add(bed.mesh);
    engine.add(bed);
    const physics = engine.physics;
    if (physics) {
      const geom = bed.mesh.geometry;
      const vertices = geom.getAttribute('position').array as Float32Array;
      const indices = new Uint32Array(geom.index!.array);
      const collider = physics.world.createCollider(physics.RAPIER.ColliderDesc.trimesh(vertices, indices));
      engine.add({ dispose: () => physics.world.removeCollider(collider, true) });
    }
    const foliage = engine.add(new BiomeFoliage(terrain, engine.world, profile.seed, runtime.plantable));
    foliage.setQuality(engine.quality.preset);
    engine.scene.add(foliage.root);
    weather.autoExposure = true;
    const defaultTier = engine.quality.preset.tier;
    const lighting = engine.add(new SunFx(engine, { weather }));
    engine.add(new Rain(engine, weather, undefined, profile.seed % 8191));
    const apply = (p: ResolvedWorldProfile, previous?: ResolvedWorldProfile, seconds = 0) => {
      if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Expected nonnegative transition seconds');
      if (!previous || previous.time !== p.time || previous.weather !== p.weather) {
        const sky = { ...WEATHER_PRESETS[SKY_STATES[p.weather]] };
        setSolarTime(sky, { latitudeDeg: 42, dayOfYear: 80, solarHour: p.time, northAzimuthDeg: 90 });
        weather.transitionTo(sky, seconds);
      }
      const v = p.values;
      foliage.setStyle(v.foliageTint, v.grassDensity);
      lighting.setGrading({ temperature: v.temperature, tint: v.tint, saturation: v.saturation,
        contrast: v.contrast, exposureBias: v.exposureBias }, seconds);
      if (ocean) {
        if (previous && v.seaState !== previous.values.seaState) { const waves = sea(p); ocean.setSeaStates(waves, waves); }
        ocean.setAppearance(v.waterTint, v.foamBands);
        ocean.optics.foam = v.foam;
      }
      if (previous && previous.quality !== p.quality) engine.setQuality(p.quality === 'auto' ? defaultTier : p.quality);
    };
    apply(profile);
    if (!runtime.canvas) engine.add({ dispose: () => canvas.remove() });
    return { ...world, terrain, foliage, bed, get profile() { return profile; },
      patch(change, seconds = 0) { const next = patchWorldProfile(profile, change); apply(next, profile, seconds); return profile = next; },
      dispose() { engine.dispose(); } };
  } catch (error) {
    world.engine.dispose();
    if (!runtime.canvas) canvas.remove();
    throw error;
  }
}
