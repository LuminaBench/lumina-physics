import { TSL } from '../../engine/tsl';
import { AuthoredLandscape, type LandscapeRuntime } from '../landscape/authored';
import type { Season } from '../landscape/library';
import { attachWorldRain, type ProfileControls, type RainHost, type RainAttachment } from './attach-rain';
import { QUALITY_TIERS, tierFromScore } from '../../engine/quality';
import { SunFx } from '../../engine/sun-fx';
import { Rain } from './rain';
import { setSolarTime } from './solar-clock';
import {
  resolveWorldProfile,
  patchWorldProfile,
  SKY_STATES,
  type WorldProfile,
  type ResolvedWorldProfile,
  type ProfilePatch,
} from './world-profile';
import { LuminaEngine, type EngineOptions } from '../../engine/engine';
import { validateClimate, type ClimateProfile } from '../../engine/climate';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS, type WeatherParams, type CloudLayerOptions } from './weather';
import type { LocalProbeOptions } from './reflection-probe';
import { Ocean, type OceanOptics, type TideOptions } from '../water/ocean';
import { OCEAN_PRESETS, type OceanParams } from '../water/spectrum';
import { TerrainSurface, terrainReading, type TerrainHeightmap } from '../terrain/surface';
import { LandGeology } from '../terrain/geology';
import { riverCenter } from '../landscape/earth';
import { alpineStream } from '../landscape/alpine-stream';
import { GeologicalDressing } from '../terrain/dressing';
import { BiomeFoliage } from '../terrain/foliage';
import { Bathymetry } from '../water/seabed';

export interface LuminaWorldOptions extends EngineOptions {
  weather?: Partial<WeatherParams> | keyof typeof WEATHER_PRESETS;
  climate?: ClimateProfile;
  distribution?: import('./clouds').CloudDistribution;
  upperClouds?: CloudLayerOptions;
  localProbe?: LocalProbeOptions;
  waterLevel?: number;
  tide?: TideOptions;
  optics?: Partial<OceanOptics>;
  /** Pass false for a scene without water. */
  ocean?: OceanParams | keyof typeof OCEAN_PRESETS | false;
  bathymetry?: Bathymetry;
  shoreBreak?: import('../water/shore-breaker').ShoreBreak;
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
async function createOutdoorWorld(options: LuminaWorldOptions, artDirection = false): Promise<LuminaWorld> {
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
    const weather = engine.add(
      new Weather(engine, { upperClouds: options.upperClouds, localProbe: options.localProbe, distribution:options.distribution, artDirection }),
    );
    Object.assign(weather.params, sky);
    let ocean: Ocean | null = null;
    if (waves) {
      ocean = engine.add(
        new Ocean(engine, {
          weather,
          bathymetry: options.bathymetry,
          shoreBreak: options.shoreBreak,
          waterLevel: options.waterLevel,
          tide: options.tide,
        }),
      );
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

export interface ProfileWorld extends LuminaWorld, ProfileControls {
  terrain: TerrainSurface;
  foliage: BiomeFoliage;
  bed: Bathymetry;
  dressing: GeologicalDressing;
  setDirection(id: string): void;
  prepare(extras?: readonly import('three/webgpu').Object3D[]): Promise<void>;
  land?: AuthoredLandscape;
  setSeason(season: Season): void;
}

export type ProfileRuntime = Partial<Omit<EngineOptions, 'tier'>> & LandscapeRuntime;
export function createLuminaWorld(options: LuminaWorldOptions): Promise<LuminaWorld>;
export function createLuminaWorld(
  input: WorldProfile & { mode: 'attach' },
  host: RainHost,
): Promise<RainAttachment>;
export function createLuminaWorld(input: WorldProfile, runtime?: ProfileRuntime): Promise<ProfileWorld>;
export async function createLuminaWorld(
  input: LuminaWorldOptions | WorldProfile,
  runtime: ProfileRuntime | RainHost = {},
): Promise<LuminaWorld | RainAttachment | ProfileWorld> {
  if (!('profileVersion' in input)) return createOutdoorWorld(input);
  if (input.mode === 'attach') {
    if (!('scene' in runtime) || !runtime.camera)
      throw new Error('Attach mode requires a host scene and camera');
    return attachWorldRain(input, runtime);
  }
  if ('scene' in runtime) throw new Error('A host scene requires attach mode');
  const land = input.landscape ? new AuthoredLandscape(input.landscape, input.seed ?? 7, runtime) : undefined;
  let profile = resolveWorldProfile(
    land
      ? {
          ...input,
          landscape: { ...land.profile, seeds: { ...land.seeds }, dependencies: land.dependencies },
        }
      : input,
    land?.library,
  );
  const canvas = runtime.canvas ?? document.createElement('canvas');
  const sea = (p: ResolvedWorldProfile) => ({ ...OCEAN_PRESETS[p.values.seaState], seed: p.seed });
  const terrain = land?.surface ?? new TerrainSurface(profile.biome, profile.seed, runtime.heightmap);
  const geology = new LandGeology(profile.biome, terrain.size, land);
  const reading = terrainReading();
  const bed = new Bathymetry({
    size: terrain.size,
    resolution: terrain.segments + 1,
    height: (x, z) => terrain.sample(x, z, reading).height,
    geometry: terrain.geometry(),
    shadeTerrain: geology.terrain,
  });
  let world: LuminaWorld;
  try {
    world = await createOutdoorWorld(
      {
        ...runtime,
        canvas,
        tier: profile.quality,
        bathymetry: bed,
        ocean: profile.biome === 'dry-highlands' ? false : sea(profile),
        weather: SKY_STATES[profile.weather],
      },
      true,
    );
  } catch (error) {
    bed.dispose();
    geology.dispose();
    land?.dispose();
    throw error;
  }
  try {
    if (!runtime.canvas) {
      document.body.appendChild(canvas);
      world.engine.add({ dispose: () => canvas.remove() });
    }
    const { engine, weather, ocean } = world;
    if (!ocean) engine.scene.add(bed.mesh);
    if (ocean && terrain.biome === 'temperate-river-valley')
      Object.assign(ocean.optics, { clarity: 0.26, sss: 0.32 });
    if (land) {
      if (ocean && ['marsh', 'wood', 'farm', 'fans'].includes(land.region.form)) {
        const seed = land.seeds.terrain;
        ocean.surfaceCurrent = (x, z, tideRate, out) => {
          const d = (x - riverCenter(z, seed)) / 11,
            speed =
              Math.exp(-d * d) *
              (land.region.form === 'marsh' ? tideRate * 9 : -0.58 - land.earth.rain * 0.8);
          out
            .set(riverCenter(z + 0.5, seed) - riverCenter(z - 0.5, seed), 0, 1)
            .normalize()
            .multiplyScalar(speed);
        };
      }
      land.cloudShadow = (p) => weather.cloudShadow(p);
      const groundMaterial = bed.mesh.material as import('three/webgpu').MeshStandardNodeMaterial;
      const shade = weather.cloudShadow(TSL.positionWorld).mul(0.43).add(0.57);
      groundMaterial.colorNode = TSL.mul(groundMaterial.colorNode, shade);
      engine.add({
        update() {
          land.focusX = engine.camera.position.x;
          land.focusZ = engine.camera.position.z;
        },
      });
      engine.add(land);
    }
    if (land?.region.form === 'mountain') {
      const stream = engine.add(alpineStream(land, engine.world));
      engine.scene.add(stream.mesh);
    }
    engine.add(bed);
    engine.add(geology);
    const dressing = engine.add(
      new GeologicalDressing(
        terrain,
        geology,
        land?.seeds.rocks ?? profile.seed,
        runtime.plantable,
        engine.camera,
        land?.seeds.debris,
      ),
    );
    engine.scene.add(dressing.root);
    if (ocean)
      engine.add({
        update() {
          terrain.waterLevel = ocean.waterLevel;
        },
      });
    const physics = engine.physics;
    if (physics) {
      const geom = bed.mesh.geometry;
      const vertices = geom.getAttribute('position').array as Float32Array;
      const indices = new Uint32Array(geom.index!.array);
      const collider = physics.world.createCollider(physics.RAPIER.ColliderDesc.trimesh(vertices, indices));
      engine.add({ dispose: () => physics.world.removeCollider(collider, true) });
    }
    const foliage = engine.add(
      new BiomeFoliage(
        terrain,
        engine.world,
        profile.seed,
        runtime.plantable,
        engine.camera,
        engine.backend === 'webgpu' ? engine.renderer : undefined,
        geology.shade,
        land,
      ),
    );
    foliage.setQuality(engine.quality.preset);
    engine.scene.add(foliage.root);
    weather.autoExposure = true;
    const score = engine.quality.capabilities?.score;
    const detected = score === undefined ? 'high' : tierFromScore(score);
    const autoTier = QUALITY_TIERS[Math.min(2, QUALITY_TIERS.indexOf(detected))];
    const lighting = engine.add(new SunFx(engine, { weather }));
    engine.add(new Rain(engine, weather, undefined, profile.seed % 8191));
    const apply = (p: ResolvedWorldProfile, previous?: ResolvedWorldProfile, seconds = 0) => {
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new RangeError('Expected nonnegative transition seconds');
      if (!previous || previous.time !== p.time || previous.weather !== p.weather) {
        const sky = { ...WEATHER_PRESETS[SKY_STATES[p.weather]] };
        setSolarTime(sky, {
          ...(land?.solar ?? { latitudeDeg: 42, dayOfYear: 80, northAzimuthDeg: 90 }),
          solarHour: p.time,
        });
        if (land) {
          land.earth.setRain(sky.rain);
          land.earth.sunlight = Math.max(0, Math.sin((sky.sunElevation * Math.PI) / 180));
          if (sky.sunElevation < 0) {
            sky.moonlight = 0.68;
            sky.exposure = Math.max(sky.exposure, 1.38);
          }
        }
        weather.transitionTo(sky, seconds);
      }
      const v = p.values;
      geology.tint.value.set(v.foliageTint);
      geology.bands.value = land?.direction.bands ?? v.cloudBands;
      foliage.setStyle(v.foliageTint, v.grassDensity, land?.direction.bands ?? v.cloudBands);
      weather.skyTint.value.set(v.skyTint);
      weather.cloudBands.value = v.cloudBands;
      lighting.setGrading(
        {
          temperature: v.temperature,
          tint: v.tint,
          saturation: v.saturation,
          contrast: v.contrast,
          exposureBias: v.exposureBias,
        },
        seconds,
      );
      if (ocean) {
        if (previous && v.seaState !== previous.values.seaState) {
          const waves = sea(p);
          ocean.setSeaStates(waves, waves);
        }
        ocean.setAppearance(v.waterTint, v.foamBands);
        ocean.optics.foam = v.foam;
      }
      if (previous && previous.quality !== p.quality) {
        engine.setQuality(p.quality === 'auto' ? autoTier : p.quality);
        engine.setDynamicResolution(runtime.dynamicResolution ?? p.quality === 'auto');
      }
    };
    apply(profile);

    return {
      ...world,
      terrain,
      foliage,
      bed,
      land,
      dressing,
      async prepare(extras = []) {
        const visibility: { mesh: import('three/webgpu').Object3D; visible: boolean }[] = [];
        for (const group of [foliage.root, dressing.root, ...extras]) {
          if (!group.visible && (group === foliage.root || group === dressing.root)) continue;
          group.traverse((mesh) => {
            visibility.push({ mesh, visible: mesh.visible });
            mesh.visible = true;
          });
        }
        try {
          engine.warmSceneMaterials();
          await engine.pipeline.prepareScenePasses();
        } finally {
          for (let i = visibility.length - 1; i >= 0; i--) visibility[i].mesh.visible = visibility[i].visible;
        }
      },
      setDirection(id) {
        if (!land) throw new Error('Direction requires an authored landscape');
        const next = resolveWorldProfile(
          { ...profile, landscape: { ...profile.landscape!, direction: id } },
          land.library,
        );
        const previousShader = land.direction.leafShader;
        land.setDirection(id);
        if (previousShader !== land.direction.leafShader) foliage.grove.applyLeafStyle();
        next.landscape!.dependencies = land.dependencies;
        apply(next, profile);
        profile = next;
      },
      setSeason(season) {
        if (!land) throw new Error('Season requires an authored landscape');
        land.setSeason(season);
        profile = { ...profile, landscape: { ...profile.landscape!, season } };
        apply(profile);
      },
      get profile() {
        return profile;
      },
      patch(change, seconds = 0) {
        const next = patchWorldProfile(profile, change, land?.library);
        apply(next, profile, seconds);
        return (profile = next);
      },
      dispose() {
        engine.dispose();
      },
    };
  } catch (error) {
    world.engine.dispose();
    if (!runtime.canvas) canvas.remove();
    throw error;
  }
}
