import * as THREE from 'three/webgpu';
import { LuminaEngine, type EngineOptions } from '../../engine/engine';
import { frame } from '../../engine/frame';
import { EffectsKit } from '../../engine/fx';
import palettes from '../weather/world-looks.json' with { type: 'json' };
import { SunFx } from '../../engine/sun-fx';
import { TSL } from '../../engine/tsl';
import { TerrainSurface, terrainReading, type TerrainHeightmap } from '../terrain/surface';
import { Weather, WEATHER_PRESETS, type WeatherParams } from '../weather/weather';
import { TerrainHorizon, type TerrainHorizonOptions } from '../weather/terrain-horizon';
import { setAirRecipe, type AIR_RECIPES, type AirRecipe } from '../weather/air';
import { WeatherFront, type FrontOptions } from '../weather/front';
import { Rain } from '../weather/rain';
import { setSolarTime, type SolarClock } from '../weather/solar-clock';
import { Ocean, type TideOptions } from '../water/ocean';
import { OCEAN_PRESETS } from '../water/spectrum';
import { Bathymetry } from '../water/seabed';
import { Coastline, type CoastOptions } from './coastline';
import { CoastalSurf } from './surf';
import { CoastalSediment, type SedimentSave } from './sediment';
import { Saltation } from './saltation';
import { CoastalHeadlamps } from './headlamps';
import { CoastalRainShafts } from './rain-shafts';
import { CoastalSandRenderer } from './sand-renderer';

export interface CoastWorldOptions extends EngineOptions {
  coast: CoastOptions;
  front: FrontOptions;
  weather?: Partial<WeatherParams>;
  clock?: SolarClock;
  horizon?: boolean | Partial<Omit<TerrainHorizonOptions, 'heightAt'>>;
  air?: keyof typeof AIR_RECIPES | AirRecipe;
  size?: number;
  segments?: number;
  terrain?: TerrainHeightmap;
  tide?: TideOptions;
  swell?: keyof typeof OCEAN_PRESETS;
  strength?: number;
  period?: number;
  detail?: import('./surf').SurfOptions['detail'];
  barrierAt?: (x: number, z: number) => number;
  save?: SedimentSave;
  retainAt?: (x: number, z: number) => boolean;
  exposureResponse?: { brightenSceneSeconds: number; darkenSceneSeconds: number };
  skyGlow?: import('../weather/weather').WeatherOptions['skyGlow'];
}
export async function createCoastalWorld(options: CoastWorldOptions) {
  const engine = await LuminaEngine.create({ ...options, preloadClouds: true });
  try {
    const coast = new Coastline(options.coast);
    const front = new WeatherFront(options.front);
    engine.add({ dispose: () => front.dispose() });
    engine.world.region = front;
    const map = options.terrain ?? coast.heightmap(options.size ?? 560, options.segments ?? 144);
    const terrain = new TerrainSurface('coastal-cliffs', coast.seed, map),
      reading = terrainReading();
    const ground = (x: number, z: number) => terrain.sample(x, z, reading).height;
    const horizon = options.horizon ? new TerrainHorizon({
      size: terrain.size,
      ...(options.horizon === true ? {} : options.horizon),
      heightAt: ground,
    }) : undefined;
    if (horizon) engine.add({ dispose: () => horizon.dispose() });
    const weather = engine.add(
      new Weather(engine, {
        skyGlow: options.skyGlow,
        distribution: front,
        terrainHorizon: horizon,
        upperClouds: front.upperClouds,
        artDirection: true,
        localProbe: {
          center: new THREE.Vector3(),
          layer: 12,
          resolution: 64,
          halfSize: new THREE.Vector3(34, 14, 54),
        },
      }),
    );
    if (options.exposureResponse) {
      const { brightenSceneSeconds, darkenSceneSeconds } = options.exposureResponse;
      if (![brightenSceneSeconds, darkenSceneSeconds].every((s) => Number.isFinite(s) && s > 0))
        throw new RangeError('Exposure response times must be positive seconds');
      Object.assign(weather.exposureResponse, options.exposureResponse);
      weather.autoExposure = true;
    }
    Object.assign(weather.params, WEATHER_PRESETS.tradeCumulus, front.weather, options.weather);
    if (options.air) setAirRecipe(weather.params, options.air);
    if (options.clock) setSolarTime(weather.params, options.clock);
    weather.groundColor.set(coast.sand.mineral).multiplyScalar(0.37);
    const surf = new CoastalSurf(
      coast,
      {
        size: terrain.size,
        resolution: terrain.segments + 1,
        period: options.period,
        detail: options.detail,
        barrierAt: options.barrierAt,
      },
      ground,
    );
    engine.add({ dispose: () => surf.dispose() });
    const sediment = new CoastalSediment(coast, surf, {
      ground,
      barrierAt: options.barrierAt,
      retainAt: options.retainAt,
      rainAt: (x, z) => front.sample(x, z, engine.time).rain,
    });
    if (options.save) sediment.restore(options.save);
    const sand = new CoastalSandRenderer(
      sediment,
      options.front.heading ?? 0.24,
      OCEAN_PRESETS[options.swell ?? 'breeze'].swellDirection,
    );
    engine.add({ dispose: () => sand.dispose() });
    const bed = new Bathymetry(
      {
        size: terrain.size,
        resolution: terrain.segments + 1,
        geometry: terrain.geometry(),
        height: ground,
        shoreDryingSeconds: coast.sand.drainageSeconds,
        shadeTerrain: sand.shadeTerrain,
      },
      { cloudShadow: (p) => weather.cloudShadow(p) },
    );
    engine.scene.add(bed.mesh);
    engine.add({ dispose: () => bed.dispose() });
    sand.attach(bed, engine.scene);
    for (const m of [bed.mesh.material as THREE.MeshStandardNodeMaterial, sand.detail!.material]) {
      m.colorNode = TSL.mul(m.colorNode, weather.cloudShadow(TSL.positionWorld).mul(0.36).add(0.64));
    }
    if (engine.physics) {
      const physics = engine.physics,
        geom = bed.mesh.geometry;
      const collider = physics.world.createCollider(
        physics.RAPIER.ColliderDesc.trimesh(
          geom.getAttribute('position').array as Float32Array,
          new Uint32Array(geom.index!.array),
        ),
      );
      engine.add({ dispose: () => physics.world.removeCollider(collider, true) });
    }
    const ocean = engine.add(
      new Ocean(engine, {
        weather,
        bathymetry: bed,
        shoreBreak: surf,
        sedimentAt: sand.sedimentAt,
        tide: options.tide,
      }),
    );
    const spectrum = {
      ...OCEAN_PRESETS[options.swell ?? 'breeze'],
      windDirection: options.front.heading ?? 0.24,
      windSpeed: front.speed,
      seed: coast.seed,
    };
    ocean.setSeaStates(spectrum, spectrum);
    ocean.optics.clarity =
      coast.options.relief === 'cay' ? 0.94 : coast.options.relief === 'lava' ? 0.57 : 0.29;
    ocean.optics.breakerHeight = options.strength ?? 0.52;
    const beams = new CoastalHeadlamps();
    const shafts = new CoastalRainShafts(front, weather, engine.scene);
    engine.add({ dispose: () => shafts.dispose() });
    const fx = engine.add(new EffectsKit(engine, beams.radiance)),
      rain = engine.add(new Rain(engine, weather));
    const optics = engine.add(new SunFx(engine, { weather }));
    const focus = new THREE.Vector3(),
      p = engine.camera.position;
    let forcedFocus = false,
      wasNear = false;
    const inspectionPoint = new THREE.Vector3();
    const foliageTint = TSL.uniform(new THREE.Color(1, 1, 1));
    let look = 'natural-daylight';
    let grains: Saltation | undefined;
    engine.add({ dispose: () => grains?.dispose() });
    engine.add({
      update(dt: number) {
        if (!forcedFocus) focus.copy(p);
        shafts.update(engine.camera);
        rain.intensityOverride = front.sample(p.x, p.z, engine.time).rain;
        weather.shadowFocus.copy(focus);
        terrain.waterLevel = ocean.waterLevel;
        const near =
          focus.y - ground(focus.x, focus.z) < 9 &&
          !coast.options.protectedAt?.(focus.x, focus.z) &&
          Math.max(Math.abs(focus.x), Math.abs(focus.z)) < terrain.size * 0.5 - 5;
        if (near) {
          if (!wasNear) sediment.time = Math.max(0, engine.time - dt);
          if (sediment.update(dt, focus.x, focus.z, ocean.waterLevel, ocean.optics.breakerHeight) || !wasNear)
            sand.update(focus.x, focus.z, true);
        } else if (wasNear) sand.update(focus.x, focus.z, false);
        wasNear = near;
        grains?.update(dt, focus);
      },
    });
    engine.onUpdate = (dt) => ocean.updateField(dt, focus);
    const resize = () => engine.resize();
    window.addEventListener('resize', resize);
    engine.add({ dispose: () => window.removeEventListener('resize', resize) });
    const world = {
      engine,
      coast,
      front,
      terrain,
      ground,
      surf,
      sediment,
      sand,
      bed,
      weather,
      ocean,
      fx,
      rain,
      optics,
      beams,
      horizon,
      foliageTint,
      get look() {
        return look;
      },
      setFocus(target?: THREE.Vector3) {
        forcedFocus = !!target;
        if (target) focus.copy(target);
      },
      setAir(air: keyof typeof AIR_RECIPES | AirRecipe) {
        setAirRecipe(weather.params, air);
      },
      setClock(clock: SolarClock) {
        setSolarTime(weather.params, clock);
      },
      setLook(direction: string | (typeof palettes.looks)[number]) {
        const palette =
          typeof direction === 'string' ? palettes.looks.find((v) => v.name === direction) : direction;
        if (!palette) throw new RangeError('Unknown coastal art direction ' + direction);
        look = palette.name;
        foliageTint.value.set('#ffffff');
        if (look !== 'natural-daylight') foliageTint.value.lerp(new THREE.Color(palette.foliageTint), 0.33);
        weather.skyTint.value.set(palette.skyTint);
        weather.cloudBands.value = palette.cloudBands;
        ocean.setAppearance(look === 'natural-daylight' ? undefined : palette.waterTint, palette.foamBands);
        optics.setGrading(
          {
            temperature: palette.temperature,
            tint: palette.tint,
            saturation: palette.saturation,
            contrast: palette.contrast,
            exposureBias: palette.exposureBias,
          },
          0.35,
        );
      },
      async prepare(extras: THREE.Object3D[] = []) {
        const temporary = [sand.detail!, ...extras].filter((mesh) => !mesh.visible);
        for (const mesh of temporary) mesh.visible = true;
        try {
          engine.warmSceneMaterials();
          // A view change can expose refraction nodes after HDR textures already exist. Their
          // framebuffer copies require a live render pass with the matching colour attachment.
          if (engine.stats.frames > 0) engine.pipeline.render();
          else await engine.pipeline.prepareScenePasses();
          await weather.localProbe?.prepare(engine.renderer, engine.scene);
        } finally {
          for (const mesh of temporary) mesh.visible = false;
        }
      },
      inspect(x: number, z: number, y = ground(x, z)) {
        const sun = frame.sunDirection.value as THREE.Vector3;
        const attenuation = (base: number, top: number) => {
          if (sun.y <= 0.01 || top <= y) return 0;
          const bottom = Math.max(base, y),
            step = (top - bottom) / (sun.y * 8);
          let column = 0;
          for (let i = 0; i < 8; i++) {
            const distance = (bottom - y) / sun.y + (i + 0.5) * step;
            inspectionPoint.set(x, y, z).addScaledVector(sun, distance);
            column += weather.sampleCloudDensity(inspectionPoint) * step;
          }
          return column;
        };
        const lower = attenuation(weather.params.cloudBase, weather.params.cloudTop),
          upper = weather.upperClouds ? attenuation(weather.upperClouds.base, weather.upperClouds.top) : 0;
        return {
          site: coast.project(x, z),
          ground: { ...sediment.inspect(x, z) },
          weather: { ...front.sample(x, z, engine.time) },
          sun: {
            terrainVisibility: horizon?.visibilityAt(x, y, z) ?? 1,
            lower,
            upper,
            layer:
              sun.y <= 0
                ? 'below horizon'
                : Math.max(lower, upper) < 1
                  ? 'clear'
                  : lower >= upper
                    ? 'lower cloud'
                    : 'upper cloud',
          },
        };
      },
      dispose() {
        engine.dispose();
      },
    };
    grains = new Saltation(world);
    return world;
  } catch (error) {
    engine.dispose();
    throw error;
  }
}
export type CoastalWorld = Awaited<ReturnType<typeof createCoastalWorld>>;
