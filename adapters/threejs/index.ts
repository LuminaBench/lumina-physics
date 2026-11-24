/**
 * lumina-physics · Three.js (WebGPU + TSL) adapter.
 *
 * One import surface for a game. `scripts/install-physics.mjs --engine threejs` copies
 * this file next to the `engine/` and `modules/` folders it needs and rewrites the
 * relative paths, so in an installed project the import is simply:
 *
 *   import { createLuminaWorld, OCEAN_PRESETS } from './lumina-physics';
 */
import * as THREE from 'three/webgpu';
export * from '../../engine';
export { EffectsKit } from '../../engine/fx';
export { traceReflection } from '../../engine/ssr';
export { Weather, WEATHER_PRESETS, CLOUD_LAYERS, type WeatherParams, type WeatherOptions, type CloudLayerOptions } from '../../modules/weather/weather';
export { setSolarTime, type SolarClock } from '../../modules/weather/solar-clock';
export { LocalReflectionProbe, type LocalProbeOptions } from '../../modules/weather/reflection-probe';
export { Lightning, growBolt, boltGeometry, boltMaterial } from '../../modules/weather/lightning';
export { Rain } from '../../modules/weather/rain';
export { Ocean, type OceanOptions, type TideOptions, type OceanOptics, type OceanSample } from '../../modules/water/ocean';
export { OCEAN_PRESETS, waveSpectrum, cascadeLayout, type OceanParams } from '../../modules/water/spectrum';
export { Bathymetry, lagoonIsland } from '../../modules/water/seabed';
export { Tsunami, TSUNAMI_PRESETS, type TsunamiProfile } from '../../modules/water/tsunami';
export { TsunamiEffects } from '../../modules/water/tsunami-fx';
export { InteractionField, type FieldSource } from '../../modules/water/interaction';
export { BuoyantBody, type BuoyancyOptions } from '../../modules/water/buoyancy';
export { JetAero, applyRotorWash, prandtlGlauertIntensity, type AeroState } from '../../modules/aero/aero';
export { TrailRibbon } from '../../modules/aero/trails';
export { RacetrackFlight } from '../../modules/aero/flight';
export { Explosions, EXPLOSION_PRESETS, EXPLOSION_KINDS, type ExplosionKind, type ExplosionOptions, type FireExposure } from '../../modules/fire/explosions';
export { WetRoad } from '../../modules/wet-road/road';
export { AquaplaningVehicle, hydroplaningSpeed } from '../../modules/wet-road/vehicle';
export { TireSpray } from '../../modules/wet-road/spray';
export { Underwater, type UnderwaterParams } from '../../modules/water/underwater';
export * from '../../engine/sun-fx';
export * from '../../modules/softbody';
export * from '../../modules/strands';
export * from '../../modules/ballistics';
export * from '../../modules/water/inland';
export { createMaterial, MATERIAL_KINDS, type MaterialKind } from '../../modules/materials';
export * from '../../modules/cloth';
export * from '../../modules/destruction';
export * from '../../modules/thermo';
export * from '../../modules/surface-deform';
export * from '../../modules/animation';

export * from '../../modules/weather/outdoor-world';
export * from '../../modules/weather/world-profile';
export * from '../../modules/weather/attach-rain';

export * from '../../modules/landscape/library';
export * from '../../modules/landscape/collection';
export * from '../../modules/landscape/authored';
export * from '../../modules/landscape/earth';
export * from '../../modules/landscape/host';
export * from '../../modules/landscape/regional-flight';
export * from '../../modules/landscape/tree-contact';
export * from '../../modules/landscape/flowers';
export { THREE };

export { RotorWash, type RotorSurface } from '../../modules/aero/rotor-wash';
export { CloudTrail } from '../../modules/aero/cloud-trail';
export { WeatherVortex, type VortexOptions } from '../../modules/weather/vortex';
export { FloodedStreet, StreetFlowGrid } from '../../modules/wet-road/street-fluid';
export { FloodableVessel, type HullCompartment, type FloodableHullOptions } from '../../modules/water/floodable-vessel';
export { VehicleDamage } from '../../modules/destruction/vehicle-damage';
export { FlexibleTree, type SaplingOptions } from '../../modules/strands/sapling';
export { ActiveRagdoll } from '../../modules/ragdoll/active';

export * from '../../modules/terrain/surface';
export * from '../../modules/vegetation/botany';
export * from '../../modules/vegetation/grove';
export * from '../../modules/strands/meadow';
export * from '../../modules/strands/meadow-wind';
export * from '../../modules/terrain/geology';
export * from '../../modules/terrain/dressing';
export * from '../../modules/terrain/foliage';
