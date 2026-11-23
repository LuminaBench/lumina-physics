import { LuminaEngine, type EngineOptions } from '../../engine/engine';
import { validateClimate, type ClimateProfile } from '../../engine/climate';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS, type WeatherParams, type CloudLayerOptions } from './weather';
import type { LocalProbeOptions } from './reflection-probe';
import { Ocean, type OceanOptics, type TideOptions } from '../water/ocean';
import { OCEAN_PRESETS, type OceanParams } from '../water/spectrum';
import type { Bathymetry } from '../water/seabed';

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
export async function createLuminaWorld(options: LuminaWorldOptions): Promise<LuminaWorld> {
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
