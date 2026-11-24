#!/usr/bin/env node
// Regenerates catalog.json from the module table below. Run after adding a module:
//   node scripts/build-catalog.mjs
// Validate files, specs, Three.js adapter entrypoints and transitive selective-install
// imports without writing catalog.json:
//   node scripts/build-catalog.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');

/** Recursively list matching source files under `dir`, sorted as POSIX repo-relative paths. */
function ls(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(ts|json|gd|gdshader|cs|shader)$/.test(entry.name)) out.push(next);
    }
  };
  walk(dir);
  return out.sort();
}

const G = 'adapters/godot', U = 'adapters/unity';
const entries = [
  {"id": "world-fields", "kind": "module", "title": "World field bus", "summary": "Shared wind, pressure, heat, wetness and cloud clearance. Set a climate profile for altitude-dependent temperature, aircraft humidity, surface frost and drying.", "tags": ["wind", "pressure", "heat", "wetness", "world bus", "climate", "humidity", "frost", "temperature"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": [], "requires": ["core"], "exports": ["export { WorldBus, WorldSource, FieldReading, surfaceWetnessNode, surfaceClimateNode } from './engine/world-bus';"]}, "godot": {"files": ["adapters/godot/lumina_world_bus.gd", "adapters/godot/lumina_world_surface.gdshader"]}, "unity": {"files": ["adapters/unity/LuminaWorldBus.cs", "adapters/unity/LuminaWorldFields.hlsl"]}}, "params": [{"name": "radius", "unit": "m"}, {"name": "radial / swirl / lift / rimLift", "unit": "m/s"}, {"name": "pressure", "note": "signed game-fluid forcing"}, {"name": "heat", "unit": "°C"}, {"name": "wetness / cloudCut", "range": [0, 1]}, {"name": "lifetime", "unit": "s"}]},
  {"id": "rotor-wash", "kind": "module", "title": "Helicopter rotor downwash and cloud carving", "summary": "Persistent rotor disc pressure, ragged radial mist and rising toroidal spray, land brownout, snow and swept cloud cavities.", "tags": ["helicopter", "downwash", "hover", "cloud carving", "brownout", "snow"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": [], "requires": ["aero"], "exports": ["export { RotorWash, type RotorSurface } from './modules/aero/rotor-wash';", "export { CloudTrail } from './modules/aero/cloud-trail';"]}}, "params": [{"name": "radius", "unit": "m"}, {"name": "load", "range": [0, 1]}, {"name": "surface", "values": "auto | water | soil | sand | snow"}, {"name": "landY", "unit": "m"}, {"name": "CloudTrail.lifetime", "unit": "s"}]},
  {"id": "weather-vortex", "kind": "module", "title": "Tornado and waterspout", "summary": "Translating air vortex, a tapered condensation funnel, spray or dust and distributed loads on dynamic bodies.", "tags": ["tornado", "waterspout", "wind", "funnel", "debris"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": ["modules/weather/vortex.ts"], "requires": ["core"], "exports": ["export { WeatherVortex, type VortexOptions } from './modules/weather/vortex';"]}}, "params": [{"name": "radius / height", "unit": "m"}, {"name": "groundHeight", "note": "function of world x and z"}, {"name": "dx / dz", "unit": "m/s"}]},
  {"id": "street-fluid", "kind": "module", "title": "Flooded streets and downhill liquid films", "summary": "Mass-conserving fluid transport, bow waves, hood spray, wet friction, oil interference and travelling game-art fire.", "tags": ["wading", "flood", "fuel", "oil", "car", "bow wave", "leak"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": [], "requires": ["wet-road"], "exports": ["export { FloodedStreet, StreetFlowGrid } from './modules/wet-road/street-fluid';"]}}, "params": [{"name": "setFlood(enabled, depthM = 0.34)", "unit": "m above local road"}, {"name": "clearance", "unit": "m", "default": 0.13}, {"name": "setLeak(enabled)", "values": "true | false"}, {"name": "depth(x, z)", "unit": "m"}, {"name": "grip(x, z)", "note": "sample local tire-grip multiplier"}]},
  {"id": "floodable-vessel", "kind": "module", "title": "Compartment flooding and sinking vessels", "summary": "Distributed hull buoyancy, asymmetric flooding, list, trim and escaping underwater bubbles.", "tags": ["boat", "vessel", "sinking", "listing", "buoyancy", "flooding"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": ["modules/water/floodable-vessel.ts"], "requires": ["core"], "exports": ["export { FloodableVessel, type HullCompartment, type FloodableHullOptions } from './modules/water/floodable-vessel';"]}}, "params": [{"name": "draft", "unit": "m"}, {"name": "compartments[].volume", "unit": "m³"}, {"name": "compartments[].center", "note": "hull-local position in metres"}, {"name": "damage(index, opening)", "note": "add a breach to one compartment; default opening 0.075"}]},
  {"id": "vehicle-damage", "kind": "module", "title": "Vehicle crumple zones and fractured glazing", "summary": "Contact-localized dents with attached trim, directional lacquer scuffs, exposed primer and bare metal, progressive glass cracks, fragments and load-driven tread heating.", "tags": ["crash", "crumple", "glass", "burnout", "tire smoke"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": ["modules/destruction/vehicle-damage.ts"], "requires": ["tire-smoke", "paint-wear"], "exports": ["export { VehicleDamage } from './modules/destruction/vehicle-damage';"]}}, "params": [{"name": "impact(worldPoint, intensity, worldNormal?, relativeVelocity?)", "note": "world-space contact and velocity in m/s"}, {"name": "attachTrim(mesh)", "note": "apply the shell dent to an attached static trim assembly"}, {"name": "tireContact(i, point, load, slipSpeed, wetness, dt, velocity?)", "note": "wheel index, contact point, normal load in newtons, slip in m/s, liquid fraction and elapsed seconds"}]},
  {"id": "flexible-tree", "kind": "module", "title": "Bending and snapping trees", "summary": "Hierarchical trunk and branch flex, pressure and collision response, dynamic fallen crown with a splintered stump.", "tags": ["tree", "branches", "splinters", "wind", "vegetation"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": ["modules/strands/sapling.ts"], "requires": ["core"], "exports": ["export { FlexibleTree, type SaplingOptions } from './modules/strands/sapling';"]}}, "params": [{"name": "height / radius", "unit": "m"}, {"name": "seed", "note": "procedural tree seed"}, {"name": "breakingStrain", "note": "local strain threshold for crown separation"}]},
  {"id": "active-ragdoll", "kind": "module", "title": "Procedural active ragdolls", "summary": "Articulated rescue character with limited hinges, balance recovery, impulses and distributed buoyancy.", "tags": ["ragdoll", "character", "joints", "stumble", "float", "rescue"], "specs": ["specs/21-world-coupling.md"], "engines": {"threejs": {"files": ["modules/ragdoll/active.ts", "modules/ragdoll/swimmer.ts"], "requires": ["core"], "exports": ["export { ActiveRagdoll } from './modules/ragdoll/active';"]}}, "params": [{"name": "origin", "unit": "m"}, {"name": "spawnPose", "values": "standing | afloat"}, {"name": "stumble(direction)", "note": "torso impulse vector in N·s"}]},
  {
    id: 'core', kind: 'module', title: 'Engine core: 5-tier quality, TRAA pipeline, SunFx, GPU particles, physics, wind',
    summary: 'WebGPURenderer + RenderPipeline (MRT colour/normal/velocity, GTAO, TRAA/TAAU, HDR bloom, AgX, sharpen), live-switchable low..ultra presets with GPU detection and frame-budget profiler, TSL compute particles, shared 4-slot HDR local fire-light field (LocalFireLights / fireLights), Rapier world with blast impulses and debris, shared wind, pressure, heat and wetness fields, camera trauma, in-material SSR, shockwave + heat-haze refraction, physics event bus, GPU-time telemetry, dynamic resolution scaling (0.55–1.0×, TAAU), half-resolution soft particle layer, pipeline effect hooks, wet-lens droplets (LensFx), standalone optical sun effects + god rays + 4-preset filmic grading (SunFx with structural SunWeather, grades tropicalNoon/goldenHour/sunset/stormyTwilight), spring-damper chase camera with speed FOV / lean / hitstop (CameraFeel), geometric specular AA, static mesh batching, cloud fire-bounce shader helper.',
    tags: ['quality', 'tiers', 'pipeline', 'traa', 'taa', 'upscaling', 'bloom', 'agx', 'gtao', 'ssr', 'particles', 'fire lights', 'rapier', 'wind', 'camera shake', 'trauma', 'shockwave', 'heat haze', 'events', 'webgpu', 'tsl', 'webgl2 fallback', 'dynamic resolution', 'drs', 'telemetry', 'gpu time', 'lens', 'droplets', 'rain on lens', 'sunfx', 'sun flare', 'lens flare', 'god rays', 'color grading', 'grading', 'anamorphic', 'chase camera', 'camera feel', 'hitstop', 'fov', 'specular aliasing', 'batching', 'draw calls', 'optimization'],
    specs: ['specs/00-conventions.md', 'specs/09-render-pipeline.md', 'specs/14-underwater-lens.md', 'specs/15-animation-camera.md'],
    engines: {
      threejs: {
        files: ls('engine'),
        requires: [],
        exports: [
          "export * from './engine';",
          "export { EffectsKit, type PoolName, type ShockwaveOptions, type HeatHazeOptions } from './engine/fx';",
          "export { traceReflection } from './engine/ssr';",
        ],
      },
      godot: { files: [`${G}/lumina_quality.gd`, `${G}/lumina_world_bus.gd`, `${G}/lumina_world_surface.gdshader`] },
      unity: { files: [`${U}/LuminaQuality.cs`, `${U}/LuminaWorldBus.cs`, `${U}/LuminaWorldFields.hlsl`] },
    },
    params: [
      { name: 'setClimate(profile)', note: 'CLIMATES.humidCoast | dryHeat | coldFront, or supply two altitude/temperature/ice-humidity endpoints and surfaceHumidity' },
      { name: 'tier', values: 'low | medium | high | xhigh | ultra | auto' },
      { name: 'renderScale', range: [0.5, 1], note: '< 1 switches TRAA to temporal upscaling' },
      { name: 'particles.budget', range: [2048, 90112] },
      { name: 'drs.min / drs.target', range: [0.55, 1], note: 'engine.setDynamicResolution(true)' },
      { name: 'lens.rain / lens.splash()', range: [0, 1] },
      { name: 'sunFx.grading', values: 'tropicalNoon | goldenHour | sunset | stormyTwilight' },
      { name: 'sunFx.halo / glare / ghosts / streak / godRays', range: [0, 2] },
    ],
  },
  {
    id: 'weather', kind: 'module', title: 'Weather: Rayleigh/Mie atmosphere, volumetric clouds, sun, environment lighting, fog',
    summary: 'Physically based sky LUT, Worley–Perlin raymarched clouds with Beer–powder + dual-lobe HG silver lining + fire-bounce underglow (single-pass analytic cloud dome on Low tier), optical-depth cloud shadows on every lit surface, cloud-bearing reflection environment + PMREM, aerial perspective, and SunWeather hooks for SunFx. Wind-reprojected cloud decks share altitude-dependent sunset lighting with aircraft and ice trails. Mirrors reuse visible cloud detail and capture the rest of the sky independently. Lunar phase follows the game clock’s sun and moon directions or an authored illuminated fraction.',
    tags: ['sky', 'atmosphere', 'rayleigh', 'mie', 'clouds', 'volumetric', 'cumulus', 'storm', 'overcast', 'sun', 'sunset', 'planetary horizon', 'flight sunset', 'latitude', 'solar clock', 'seasons', 'time of day', 'golden hour', 'blue hour', 'moonlight', 'moon phase', 'crescent', 'twilight', 'night', 'fog', 'haze', 'aerial perspective', 'cloud shadows', 'pmrem', 'environment', 'god rays', 'light shafts', 'crepuscular', 'horizon haze', 'cloud layers', 'hot climate', 'rain bank'],
    specs: ['specs/06-atmosphere-clouds-lightning.md'],
    engines: { threejs: { files: ['modules/weather/solar-clock.ts', 'modules/weather/atmosphere.ts', 'modules/weather/clouds.ts', 'modules/weather/reflection-probe.ts', 'modules/weather/weather.ts'], requires: ['core'], exports: ["export { setSolarTime, type SolarClock } from './modules/weather/solar-clock';", "export { Weather, WEATHER_PRESETS, CLOUD_LAYERS, type CloudLayerOptions, type WeatherOptions, type WeatherParams } from './modules/weather/weather';", "export { LocalReflectionProbe, type LocalProbeOptions } from './modules/weather/reflection-probe';"] } },
    params: [{ name: 'solarDiscVisibility', note: 'Read 0–1 visible area above the horizon at camera altitude, before cloud occlusion' }, { name: 'setSolarTime(weather.params, clock)', note: 'latitudeDeg, dayOfYear and local solarHour; optional map north and 365/366-day calendar' }, { name: 'sunElevation', range: [-90, 90], unit: 'deg' }, { name: 'moonIllumination', values: '0–1 or fromDirections' }, { name: 'moonlight', range: [0, 1] }, { name: 'turbidity', range: [1, 12] }, { name: 'coverage', range: [0, 1] }, { name: 'storm', range: [0, 1] }, { name: 'rain', range: [0, 1] }, { name: 'visibility', range: [500, 100000], unit: 'm' }, { name: 'cloudBase / cloudTop', unit: 'm' }, { name: 'cloudScale / upperClouds.scale', note: 'horizontal formation size multiplier' }, { name: 'cloudErosion / upperClouds.erosion', range: [0, 1], value: 0.62, note: 'turbulent breakup of the cloud boundary, separately per deck' }, { name: 'convection / upperClouds.convection', range: [-1, 1], note: 'biases vertical cell growth within each layer' }, { name: 'upperClouds.base / top', unit: 'm' }, { name: 'upperClouds.coverage / storm', range: [0, 1] }, { name: 'upperClouds.density', note: 'condensate multiplier' }, { name: 'upperClouds.windX / windZ', unit: 'm/s' }],
  },
  {
    id: 'rain-shelters', kind: 'module', title: 'Rain shadows and reflected openings under roofs',
    summary: 'Register finite horizontal roofs in world metres. Wind-driven rain, lens deposition, drying pavement and directional sky reflections share their bounds. Flood water and local spray can still reach a sheltered surface.',
    tags: ['underpass', 'shelter', 'overpass', 'rain shadow', 'roof', 'awning', 'garage', 'wet road', 'puddle', 'reflections'],
    specs: ['specs/05-wet-road-aquaplaning.md', 'specs/21-world-coupling.md'],
    engines: { threejs: { files: ['engine/rain-shelters.ts','engine/tsl.ts'], exports: ["export { RainShelters, type RainShelterOptions } from './engine/rain-shelters';"] } },
    params: [
      { name: 'center / width / depth / groundY / apronM', unit: 'world m' },
      { name: 'yaw', unit: 'radians around world Y' },
      { name: 'initialWetness', range: [0,1] },
      { name: 'underside', note: 'Matte underside colour for an off-screen reflection ray' },
      { name: 'exposureAt(x,y,z,dx?,dy?,dz?) / filmAt(x,y,z,outdoor)', note: 'Directional sky visibility and local rain film' },
    ],
  },
  {
    id: 'lightning', kind: 'module', title: 'Procedural branching lightning with cloud flash and strike events',
    summary: 'Recursive Lichtenberg bolts (midpoint displacement + forks), HDR ribbon core visible in reflections, multi-stroke flicker, in-cloud illumination, scene flash, world-space strike events. growBolt() also drives electrical arcs.',
    tags: ['lightning', 'thunder', 'storm', 'lichtenberg', 'electric', 'arc', 'flash'],
    specs: ['specs/06-atmosphere-clouds-lightning.md'],
    engines: { threejs: { files: ['modules/weather/lightning.ts'], requires: ['weather'], exports: ["export { Lightning, growBolt, boltGeometry, boltMaterial } from './modules/weather/lightning';"] } },
    params: [{ name: 'rate', range: [0, 40], unit: 'strikes/min' }, { name: 'range', unit: 'm' }],
  },
  {
    id: 'rain', kind: 'module', title: 'Wind-slanted rain streaks (stateless, every backend)',
    summary: 'Camera-centred wrapping volume evaluated in closed form in the vertex shader; slants with the wind field, lit by sky ambient and lightning.',
    tags: ['rain', 'storm', 'precipitation', 'streaks', 'snow base', 'weather'],
    specs: ['specs/06-atmosphere-clouds-lightning.md'],
    engines: { threejs: { files: ['modules/weather/rain.ts'], requires: ['weather'], exports: ["export { Rain } from './modules/weather/rain';"] } },
    params: [{ name: 'intensity', range: [0, 1] }],
  },
  {
    id: 'ocean', kind: 'module', title: 'Adaptive FFT ocean: lagoon to hurricane swell, physical optics, foam, shoreline',
    summary: 'Multi-cascade JONSWAP/Tessendorf FFT (WebGPU compute, CPU twin for WebGL 2 + buoyancy), live sea-state morph, Schlick Fresnel with cloud reflections + SSR, depth-buffer Beer–Lambert (sand → turquoise → navy), GGX sun glitter, crest SSS, Jacobian whitecaps, bathymetry shoaling, shoreline breakers, wet sand, dispersive refracted caustics, terrain horizon reflections, and a shared pressure-wave surface for spray and hull buoyancy.',
    tags: ['water', 'ocean', 'sea', 'lagoon', 'turquoise', 'waves', 'swell', 'fft', 'jonswap', 'tessendorf', 'foam', 'whitecaps', 'caustics', 'refraction', 'beer-lambert', 'fresnel', 'sss', 'shoreline', 'beach', 'shoaling', 'wake', 'kelvin', 'ripples', 'lake', 'still water', 'tidal beach', 'tides'],
    specs: ['specs/01-ocean-spectrum-fft.md', 'specs/02-water-optics.md', 'specs/03-shoaling-tsunami.md', 'specs/04-interaction-wakes-buoyancy.md'],
    engines: {
      threejs: { files: ['modules/water/shore-breaker.ts', 'modules/water/spectrum.ts', 'modules/water/fft-cpu.ts', 'modules/water/fft-gpu.ts', 'modules/water/ocean.ts', 'modules/water/interaction.ts', 'modules/water/wave-probe.ts', 'modules/water/tsunami.ts', 'modules/water/seabed.ts', 'modules/water/bed-mesh.ts'], requires: ['weather'], exports: ["export { Ocean, type OceanOptions, type TideOptions, type OceanOptics, type OceanSample } from './modules/water/ocean';", "export { OCEAN_PRESETS, waveSpectrum, cascadeLayout, type OceanParams } from './modules/water/spectrum';", "export { Bathymetry, lagoonIsland } from './modules/water/seabed';", "export { InteractionField, type FieldSource } from './modules/water/interaction';", "export { Tsunami, TSUNAMI_PRESETS, type TsunamiProfile } from './modules/water/tsunami';"] },
      godot: { files: [`${G}/lumina_wave_spectrum.gd`, `${G}/lumina_ocean.gdshader`] }, unity: { files: [`${U}/LuminaWaveSpectrum.cs`, `${U}/LuminaOcean.shader`] },
    },
    params: [{ name: 'windSpeed', range: [0, 40], unit: 'm/s' }, { name: 'windDirection', unit: 'rad' }, { name: 'fetch', range: [100, 800000], unit: 'm' }, { name: 'swellHeight', range: [0, 12], unit: 'm' }, { name: 'swellPeriod', range: [5, 20], unit: 's' }, { name: 'chop', range: [0, 1.4] }, { name: 'clarity', range: [0, 1] }, { name: 'foam', range: [0, 1] }, { name: 'morph', range: [0, 1], note: 'live blend between two sea states' }, { name: 'depthMap', note: 'Bathymetry height function' }, { name: 'tide.amplitude', unit: 'm', note: 'distance above or below mean level at an extremum' }, { name: 'tide.periodSeconds', unit: 's', note: 'positive full cycle duration' }, { name: 'tide.phase', unit: 'cycles', note: '0 rising, 0.25 high, 0.75 low' }],
  },
  {
    id: 'inland-water', kind: 'module', title: 'Inland water: flowmap-advected rivers, rocky rapids and ballistic waterfalls',
    summary: 'Spline-authored River channels with baked 2D RGBA HalfFloat flowmaps (parabolic thalweg velocity, potential-flow boulder deflection, bow pillows, churning wakes), dual-phase flowmap advection, cellular whitewater foam, merged single-draw boulder mesh with wet splash rings, zero-allocation CPU sample()/heightAt()/flowAt() queries, ballistic parabolic Waterfall curtains, boiling plunge rings and plunge mist/spray.',
    tags: ['river', 'inland', 'water', 'rapids', 'white water', 'stream', 'waterfall', 'cascade', 'plunge', 'flowmap', 'boulders', 'current', 'mist', 'canyon'],
    specs: ['specs/16-inland-water.md', 'specs/02-water-optics.md'],
    engines: {
      threejs: {
        files: ['modules/water/inland.ts'],
        requires: ['weather'],
        exports: [
          "export { InlandWater, River, Waterfall, RIVER_PRESETS, WATERFALL_PRESETS, createEmptyRiverSample, type InlandWaterOptions, type RiverOptions, type RiverPoint, type RapidRockSpec, type RiverOptics, type RiverSample, type WaterfallOptions } from './modules/water/inland';",
        ],
      },
    },
    params: [
      { name: 'river.width / speed / depth', unit: 'm, m/s, m' },
      { name: 'river.turbulence', range: [0, 1] },
      { name: 'river.optics.clarity / foam / rapidsFoam', range: [0, 2] },
      { name: 'waterfall.width / height / exitSpeed', unit: 'm, m, m/s' },
      { name: 'waterfall.aeration / flow / mistIntensity', range: [0, 2] },
    ],
  },
  {
    id: 'tsunami', kind: 'module', title: 'Adaptive tsunami / breaking mega-wave with crest spray and vessel hydrodynamics',
    summary: 'Parametric solitary wave over the FFT ocean: asymmetric sech² wall, leading drawdown, Green’s-law shoaling, plunging translucent lip, crest-collapse foam, spray curtains, bore flow that carries and throws buoyant bodies.',
    tags: ['tsunami', 'mega wave', 'rogue wave', 'breaking wave', 'tidal wave', 'surf', 'barrel', 'wall of water', 'bore'],
    specs: ['specs/03-shoaling-tsunami.md'],
    engines: { threejs: { files: ['modules/water/tsunami-fx.ts'], requires: ['ocean'], exports: ["export { TsunamiEffects } from './modules/water/tsunami-fx';"] }, godot: { files: [`${G}/lumina_tsunami.gd`] }, unity: { files: [`${U}/LuminaTsunami.cs`] } },
    params: [{ name: 'height', range: [4, 60], unit: 'm' }, { name: 'width', range: [15, 120], unit: 'm' }, { name: 'speed', range: [8, 40], unit: 'm/s' }, { name: 'breaking', range: [0, 1] }, { name: 'direction', unit: 'rad' }],
  },
  {
    id: 'buoyancy', kind: 'module', title: 'Multi-point buoyancy and hydrodynamic drag for hulls and floats',
    summary: 'Archimedes lift, linear + quadratic drag against moving water, heave damping and keel force at each sample point; reads FFT swell + tsunami from the CPU twin.',
    tags: ['buoyancy', 'boat', 'ship', 'hull', 'floatplane', 'seaplane', 'floating', 'drag', 'hydrodynamics', 'vessel'],
    specs: ['specs/04-interaction-wakes-buoyancy.md'],
    engines: { threejs: { files: ['modules/water/buoyancy.ts'], requires: ['ocean'], exports: ["export { BuoyantBody, type BuoyancyOptions } from './modules/water/buoyancy';"] }, godot: { files: [`${G}/lumina_buoyancy.gd`] }, unity: { files: [`${U}/LuminaBuoyancy.cs`] } },
    params: [{ name: 'volume', unit: 'm³' }, { name: 'draft', unit: 'm' }, { name: 'linearDrag / quadraticDrag' }, { name: 'keel', range: [0, 10] }],
  },
  {
    id: 'puddle-contacts', kind: 'module', title: 'Footsteps and bicycle tire ripples on shallow water',
    summary: 'A bounded pool of gravity-capillary wave packets from sole entry or rolling treads, sampled by world-space materials on any game surface.',
    tags: ['walking', 'footstep', 'bike', 'bicycle', 'tire', 'puddle', 'ripple', 'refraction', 'water'],
    specs: ['specs/05-wet-road-aquaplaning.md'],
    engines: {
      threejs: { files: ['modules/wet-road/puddle-contacts.ts', 'engine/tsl.ts'], exports: ["export { PuddleContacts, PuddleContact, type PuddleSurface } from './modules/wet-road/puddle-contacts';"] },
      godot: { files: [`${G}/lumina_wet_road.gdshader`, `${G}/lumina_wet_road.gd`] },
      unity: { files: [`${U}/LuminaWetRoad.shader`, `${U}/LuminaWetRoad.cs`] },
    },
    params: [{ name: 'kind', values: 'foot | wheel' }, { name: 'width', unit: 'm' }, { name: 'puddleDepth / heightAt', unit: 'm' }],
  },
  {
    id: 'tread-transfer', kind: 'module', title: 'Water and soil carried by tires between surfaces',
    summary: 'Wheel contacts pick up sediment by distance and deposit water and mud onto the next surface. A bounded scrolling mask drives asphalt colour, roughness and local surface wetness.',
    tags: ['mud', 'dirt', 'gravel', 'wet track', 'bicycle', 'puddle exit', 'tire', 'tyre', 'motorcycle'],
    specs: ['specs/05-wet-road-aquaplaning.md'],
    engines: { threejs: { files: ['modules/wet-road/tread-transfer.ts', 'engine/tsl.ts'], exports: ["export { TreadTransfer, TreadContact, retainedTreadFilm, type LooseSediment } from './modules/wet-road/tread-transfer';"] } },
    params: [{ name: 'width / retainedWater / depth / maxTravel', unit: 'm' }, { name: 'surfaceFilm / looseSoil / load', range: [0, 1] }, { name: 'cellX / cellZ', unit: 'm per texel' }],
  },
  {
    id: 'tire-smoke', kind: 'module', title: 'Slip-heated tire smoke and wet tread cooling',
    summary: 'Integrates friction work for each loaded wheel and emits smoke from heated tread. Water and airflow increase cooling.',
    tags: ['burnout', 'smoke', 'rubber', 'tire', 'drifting', 'braking', 'slip'],
    specs: ['specs/05-wet-road-aquaplaning.md'],
    engines: { threejs: { files: ['modules/wet-road/tire-smoke.ts'], requires: ['core'], exports: ["export { TireSmoke } from './modules/wet-road/tire-smoke';"] } },
    params: [{ name: 'load', unit: 'N' }, { name: 'slip', unit: 'm/s' }, { name: 'wetness', range: [0, 1] }],
  },
  {
    id: 'wheel-sheets', kind: 'module', title: 'Ballistic water sheets from tire contact',
    summary: 'A pooled world-space water fan with a lifted inner lip, outward fringe and re-entry callback. Accepts a bicycle, car or custom wheel controller.',
    tags: ['wheel', 'puddle', 'bicycle', 'tire spray', 'rooster tail', 'water sheet'],
    specs: ['specs/05-wet-road-aquaplaning.md'],
    engines: { threejs: { files: ['modules/wet-road/wheel-sheets.ts', 'engine/noise.ts', 'engine/loading.ts', 'engine/frame.ts', 'engine/tsl.ts'], exports: ["export { frame, updateFrameUniforms } from './engine/frame';", "export { WheelSpraySheets } from './modules/wet-road/wheel-sheets';"] } },
    params: [{ name: 'outletCount', range: [1, 64] }, { name: 'point', unit: 'world m' }, { name: 'innerVelocity / outerVelocity', unit: 'world m/s' }, { name: 'strength', range: [0, 1] }],
  },
  {
    id: 'paint-wear', kind: 'module', title: 'Persistent scuffs on painted metal',
    summary: 'A contact rubs the clearcoat and exposes primer and metal along the slide. Raycast contacts stay attached to skinned panels, morph targets and individual instances as their pose changes.',
    tags: ['paint', 'scrape', 'scratch', 'sideswipe', 'car', 'barrel', 'metal', 'damage', 'prop', 'impact', 'animated panel', 'skinned mesh', 'morph target', 'raycast hit'],
    specs: ['specs/11-destruction.md'],
    engines: { threejs: { files: ['modules/destruction/paint-wear.ts', 'engine/loading.ts', 'engine/noise.ts', 'engine/tsl.ts'], exports: ["export { PaintWear, type ScuffContact } from './modules/destruction/paint-wear';"] } },
    params: [{ name: 'faceIndex', note: 'optional rendered triangle from the game raycast, supports skinned poses and per-instance morph targets' }, { name: 'lengthM / widthM / reachM', unit: 'm' }, { name: 'strength', range: [0, 1] }, { name: 'materialIndex / instanceId', note: 'target material slot, plus instance ID for an instanced draw' }],
  },
  {
    id: 'wet-road', kind: 'module', title: 'Wet asphalt, puddles, real aquaplaning and tire spray',
    summary: 'Procedural asphalt with standing-water puddles shared by shader and physics, mirror reflections via in-material SSR, rain ripple rings, Rapier raycast vehicle with NASA hydroplaning model (per-wheel grip, water drag, crosswind), rooster tails, wake-convergence mist and splash sheets.',
    tags: ['walking', 'footstep', 'bicycle', 'contact ripples', 'refraction', 'road', 'asphalt', 'puddle', 'wet', 'rain', 'aquaplaning', 'hydroplaning', 'walking', 'footstep', 'bicycle', 'puddle refraction', 'car', 'vehicle', 'tire', 'tyre', 'spray', 'reflections', 'racing', 'driving', 'suspension'],
    specs: ['specs/05-wet-road-aquaplaning.md'],
    engines: {
      threejs: { files: ['modules/wet-road/street-fluid.ts', 'modules/wet-road/road.ts', 'modules/wet-road/vehicle.ts', 'modules/wet-road/spray.ts', 'modules/water/interaction.ts', 'modules/water/wave-probe.ts'], requires: ['weather', 'puddle-contacts', 'tire-smoke', 'wheel-sheets', 'tread-transfer'], exports: ["export { WetRoad } from './modules/wet-road/road';", "export { AquaplaningVehicle, hydroplaningSpeed, type VehicleRig } from './modules/wet-road/vehicle';", "export { TireSpray } from './modules/wet-road/spray';"] },
      godot: { files: [`${G}/lumina_aquaplaning.gd`], requires: ['puddle-contacts'] }, unity: { files: [`${U}/LuminaAquaplaning.cs`], requires: ['puddle-contacts'] },
    },
    params: [{ name: 'flood', range: [0, 1] }, { name: 'wetness', range: [0, 1] }, { name: 'rain', range: [0, 1] }, { name: 'tirePressure', range: [120, 320], unit: 'kPa' }, { name: 'treadDepth', unit: 'm' }],
  },
  {
    id: 'jet-exhaust', kind: 'module', title: 'Throttle-driven jet nozzle and exhaust plume',
    summary: 'A depth-clipped, emissive exhaust volume with a luminous throat, a cooler shear layer and compression cells. Orient +Z downstream for single or twin custom aircraft.',
    tags: ['jet', 'engine', 'afterburner', 'nozzle', 'exhaust', 'flame', 'plume'],
    specs: ['specs/07-aero.md'],
    engines: { threejs: { files: ['modules/aero/exhaust.ts'], requires: ['core'], exports: ["export { JetExhaust } from './modules/aero/exhaust';"] } },
    params: [{ name: 'radius / lengthM', unit: 'm' }, { name: 'setPower(intensity,seconds,aperture?)', note: '0–1 power, time in seconds, optional relative exit radius or slit height (0.5–1.25)' }],
  },
  {
    id: 'aero', kind: 'module', title: 'Extreme aerodynamics: jet-over-water downwash, vapour cone, sonic boom, vortices, rotor wash',
    summary: 'Travelling pressure trough + shock ripples + spray rooster tail under low passes, Prandtl–Glauert cone across Mach 0.95–1.05, Mach-1 refractive shockwave with physical blast on water and bodies, humidity- and lift-driven wingtip ribbons, drifting ice contrails, reusable depth-clipped JetExhaust with nozzle-anchored compression cells, exhaust heat haze, hover/rotor wash.',
    tags: ['jet', 'aircraft', 'fighter', 'sonic boom', 'mach', 'vapor cone', 'vapour cone', 'prandtl-glauert', 'downwash', 'rotor wash', 'helicopter', 'contrail', 'vortex', 'wingtip', 'engine out', 'independent engines', 'engine cutoff', 'jet engine', 'nozzle', 'afterburner', 'supersonic'],
    specs: ['specs/07-aero.md'],
    engines: { threejs: { files: ['modules/aero/aero.ts', 'modules/aero/trails.ts', 'modules/aero/flight.ts', 'modules/aero/rotor-wash.ts', 'modules/aero/cloud-trail.ts'], requires: ['ocean', 'jet-exhaust'], exports: ["export { JetAero, applyRotorWash, prandtlGlauertIntensity, type AeroRig, type AeroState, type AeroParams } from './modules/aero/aero';", "export { TrailRibbon, type TrailOptions } from './modules/aero/trails';", "export { RacetrackFlight } from './modules/aero/flight';"] } },
    params: [{ name: 'humidity', range: [0, 1] }, { name: 'relativeHumidity', range: [0, 1], note: 'local liquid-water humidity for wing vapor and transonic condensation' }, { name: 'engineThrottles', note: 'Optional nozzle-order 0–1 commands. Zero cuts one engine and its new ice trail. Missing channels inherit throttle.' }, { name: 'setNozzlePower(index,intensity,time,coreHeat)', note: 'Optional indexed rig callback for independent plume and metal heat.' }, { name: 'windVelocity', unit: 'world m/s', note: 'wind at aircraft altitude for airspeed, Mach and wake drift' }, { name: 'airTemperatureC', unit: '°C', note: 'local air temperature for Mach and ice trail formation' }, { name: 'iceHumidity', note: 'relative to ice, 1 = saturation' }, { name: 'TrailOptions.formationSeconds', unit: 's', note: 'delay before visible condensation on a custom ribbon' }, { name: 'wakeDescentMps', unit: 'm/s', note: 'optional visual drift opposite the lift direction' }, { name: 'contrailAltitude', unit: 'm' }, { name: 'surfaceLevel', unit: 'm' }, { name: 'downwashCeiling', unit: 'm', value: 70 }],
  },
  {
    id: 'explosions', kind: 'module', title: 'Staged fire and explosions: 8 game-art archetypes, charred debris, HDR fire lights',
    summary: 'Eight normalized game-art archetypes (petrol, c4, water, electrical, thermobaric, incendiary, airburst, magma) with staged timelines, artistic overrides, blackbody fire, self-shadowed smoke, charred fissure-glowing Rapier debris, HDR local fire lights (fx.fireLights), refractive shockwaves and convective heat haze, water/wind/trauma/event coupling and sustained fuel fires.',
    tags: ['fire', 'explosion', 'fireball', 'c4', 'thermobaric', 'incendiary', 'airburst', 'magma', 'blast', 'shockwave', 'smoke', 'embers', 'sparks', 'debris', 'destruction', 'geyser', 'electrical', 'arc', 'heat haze'],
    specs: ['specs/08-fire-explosions.md'],
    engines: {
      threejs: {
        files: ls('modules/fire'),
        requires: ['ocean', 'lightning'],
        exports: [
          "export { Explosions, EXPLOSION_KINDS, EXPLOSION_PRESETS, type ExplosionKind, type ExplosionArtPreset, type ExplosionArtOverrides, type ExplosionOptions, type FireExposure } from './modules/fire/explosions';",
        ],
      },
      godot: { files: [`${G}/lumina_explosion.gd`] },
      unity: { files: [`${U}/LuminaExplosion.cs`] },
    },
    params: [{ name: 'kind', values: 'petrol | c4 | water | electrical | thermobaric | incendiary | airburst | magma' }, { name: 'yield', range: [0.4, 2.5] }, { name: 'art.intensity / smoke / refraction / debris', range: [0, 2] }],
  },
  {
    id: 'underwater', kind: 'module', title: 'Underwater: waterline split, Beer–Lambert medium, god rays, Snell’s window, bubbles',
    summary: 'Per-pixel waterline from the CPU ocean twin (half-submerged cameras show both worlds), depth-buffer extinction with the ocean’s own absorption, coherent sun shafts through a moving caustic network, ocean underside with Snell’s window and total internal reflection, rising micro-bubbles; surfacing drenches the lens.',
    tags: ['underwater', 'dive', 'diving', 'submarine', 'swim', 'waterline', 'god rays', 'snell', 'total internal reflection', 'bubbles', 'fog', 'beer-lambert', 'caustics', 'scuba'],
    specs: ['specs/14-underwater-lens.md', 'specs/02-water-optics.md'],
    engines: { threejs: { files: ['modules/water/underwater.ts'], requires: ['ocean'], exports: ["export { Underwater, type UnderwaterParams } from './modules/water/underwater';"] } },
    params: [{ name: 'fog', range: [0, 3] }, { name: 'rays', range: [0, 2] }, { name: 'bubbles', range: [0, 3] }, { name: 'wobble', range: [0, 2] }],
  },
  {
    id: 'cloth', kind: 'module', title: 'Cloth and rope: flags, banners, sails, parachutes, power lines, tearing, LOD',
    summary: 'Unified particle solver (WebGPU compute Jacobi + CPU Gauss–Seidel twin): structural / shear / bend constraints, pressure + skin drag from the shared wind field, travelling-wave flutter, long-range tethers, ram-air canopy inflation, dynamic link tearing and rope snapping (tear / cut / tearGrid / snap / heal / tearThreshold), sphere and oriented-box colliders, frustum/distance simulation LOD, procedural fabric patterns and single-draw ropes.',
    tags: ['cloth', 'flag', 'banner', 'sail', 'parachute', 'canopy', 'rope', 'cable', 'power line', 'wire', 'tarp', 'curtain', 'verlet', 'pbd', 'wind', 'fabric', 'mooring', 'tearing', 'snap', 'cut', 'lod'],
    specs: ['specs/10-cloth-rope.md'],
    engines: {
      threejs: { files: ls('modules/cloth'), requires: ['core'], exports: ["export * from './modules/cloth';"] },
      godot: { files: [`${G}/lumina_cloth.gd`, `${G}/lumina_rope.gd`], requires: ['world-fields'] }, unity: { files: [`${U}/LuminaCloth.cs`, `${U}/LuminaRope.cs`], requires: ['world-fields'] },
    },
    params: [{ name: 'stiffness', range: [0, 1] }, { name: 'bend', range: [0, 1] }, { name: 'dragNormal', range: [0, 15], unit: '1/s' }, { name: 'gravity', range: [0, 1.5] }, { name: 'flutter', range: [0, 2] }, { name: 'inflate', range: [0, 8] }, { name: 'tearThreshold', range: [0, 3], note: '0 disables auto-tear' }, { name: 'slack', range: [1, 1.4], note: 'ropes' }],
  },
  {
    id: 'destruction', kind: 'module', title: 'Destruction: Voronoi pre-fracture for concrete, glass, wood and brick',
    summary: 'Pure-code convex Voronoi fracture (rubble for concrete, radial shards for glass, splinters for wood, running-bond courses for brick). One draw call per object via a chunk-matrix texture; chunks become convex-hull Rapier bodies with mass = volume × density; connectivity flood fill collapses what is no longer supported; breaks on impacts, blasts and contact forces; dust, glitter, buoyancy and splashes.',
    tags: ['destruction', 'fracture', 'voronoi', 'shatter', 'glass', 'window', 'concrete', 'wall', 'brick', 'wood', 'splinter', 'debris', 'rubble', 'collapse', 'demolition', 'chip', 'wall mark', 'scrape', 'sliding contact', 'sideswipe', 'breakable', 'destructible', 'mortar', 'timber grain', 'chipped masonry'],
    specs: ['specs/11-destruction.md'],
    engines: {
      threejs: { files: ls('modules/destruction'), requires: ['ocean', 'tire-smoke'], exports: ["export * from './modules/destruction';"] },
      godot: { files: [`${G}/lumina_fracture.gd`] }, unity: { files: [`${U}/LuminaFracture.cs`] },
    },
    params: [{ name: 'markSurface(worldPoint, radiusM, chunkIndex?)', note: 'Eight cosmetic marks per Three.js object. Supports intact surfaces and exposed faces on moving fragments.' }, { name: 'markScrape(from,to,radiusM,chunkIndex?)', note: 'Project a continuous cosmetic gouge onto the contacted face. World endpoints in the same pose. Shares the eight mark slots.' }, { name: 'clearSurfaceMarks()', note: 'Restore all marked faces on this object' }, { name: 'material', values: 'concrete | glass | wood | brick' }, { name: 'pieces', range: [4, 64] }, { name: 'anchor', values: 'bottom | frame | none' }, { name: 'toughness', range: [0.2, 5] }, { name: 'impact energy', unit: 'J', note: 'light fast impact ≈ 500, car at 50 km/h ≈ 150 000' }],
  },
  {
    id: 'thermo', kind: 'module', title: 'Thermo: 3D multi-elevation fire spread, walls/decks, charring, steam, melt, glow',
    summary: 'CPU temperature / fuel / moisture ground grid at 20 Hz plus oriented 3D ThermalSurface walls and stacked elevated decks (addSurface / addWall / addDeck) and 3D stacked prop coupling: wind-biased conduction + buoyant upward chimney spread, ragged char and blackbody ember cracks via surface() / shade(), finite boil-off steam, wood burn-out, glowing/quenching metal, melting ice, HDR fire lights and 3D blast coupling across all 8 explosion archetypes.',
    tags: ['fire', 'fire spread', 'burn', 'wildfire', 'char', 'ember', 'steam', 'extinguish', 'rain', 'hose', 'melt', 'ice', 'heat', 'temperature', 'glow', 'hot metal', 'thermal', 'flammable', 'wall fire', '3d fire', 'chimney'],
    specs: ['specs/12-thermo.md', 'specs/08-fire-explosions.md'],
    engines: {
      threejs: { files: ls('modules/thermo'), requires: ['ocean'], exports: ["export * from './modules/thermo';"] },
      godot: { files: [`${G}/lumina_thermo.gd`] }, unity: { files: [`${U}/LuminaThermoField.cs`] },
    },
    params: [{ name: 'size', unit: 'm' }, { name: 'resolution', range: [48, 160] }, { name: 'fuel', unit: 'kg/m²', note: '0.5 grass, 2–4 timber, 1.5 petrol film' }, { name: 'rain', range: [0, 1] }, { name: 'body.kind', values: 'wood | metal | ice' }, { name: 'surface.thickness', unit: 'm', note: 'ThermalSurface wall/deck projection' }],
  },
  {
    id: 'materials', kind: 'module', title: 'TSL PBR material library: concrete, asphalt, car paint, titanium, timber, glass, ice',
    summary: 'Seven procedural NodeMaterials with Mikkelsen height-derivative normals, triplanar world detail, specular AA, live .setParams() uniform controls, optional ThermoField/ThermalSurface scorch+wetness coupling and HDR local fire-light bounce: concrete, asphalt, carPaint (metallic Fresnel flop + 3D flakes), titanium (brushed + thin-film heat temper + blackbody glow), timber (3D grain + planks + char), seaSprayGlass (refractive droplets + salt crust), meltingIce (refractive cracks + bubbles + rivulets).',
    tags: ['materials', 'pbr', 'tsl', 'concrete', 'asphalt', 'car paint', 'clearcoat', 'titanium', 'metal', 'iridescence', 'timber', 'wood', 'glass', 'sea spray', 'ice', 'melting ice', 'triplanar', 'procedural'],
    specs: ['specs/17-pbr-materials.md'],
    engines: {
      threejs: { files: ls('modules/materials'), requires: ['core', 'thermo'], exports: ["export * from './modules/materials';"] },
    },
    params: [
      { name: 'kind', values: 'concrete | asphalt | carPaint | titanium | timber | seaSprayGlass | meltingIce' },
      { name: 'wetness / puddle / rain', range: [0, 1] },
      { name: 'heatTint / temperature', range: [0, 1], note: 'titanium' },
      { name: 'weathering / char / ember', range: [0, 1], note: 'timber' },
      { name: 'spray / salt / melt', range: [0, 1], note: 'seaSprayGlass / meltingIce' },
    ],
  },
  {
    id: 'softbody', kind: 'module', title: 'Inflatable soft bodies: spring + ideal-gas pressure solver (GPU + CPU)',
    summary: 'Closed-manifold inflatable soft-body system (SoftBodySystem) with structural surface springs, internal cross-bracing struts and ideal-gas internal pressure (P ∝ V_target / V). WebGPU compute Jacobi solver with automatic CPU Gauss–Seidel fallback; couples into wind, blasts, water buoyancy (Ocean / InlandWater / waterLevel) and Rapier sphere/cuboid/capsule colliders with two-way impulse transfer. Built-ins: ball, cushion, buoy, torus, custom BufferGeometry; live inflate() and puncture().',
    tags: ['softbody', 'soft body', 'inflatable', 'pressure', 'ball', 'beach ball', 'buoy', 'cushion', 'torus', 'life ring', 'squash', 'bounce', 'verlet', 'buoyancy', 'puncture'],
    specs: ['specs/18-softbody.md'],
    engines: {
      threejs: { files: ls('modules/softbody'), requires: ['core'], exports: ["export * from './modules/softbody';"] },
    },
    params: [
      { name: 'pressure', range: [0, 4], note: '0 = deflated, 1.6–2.2 = firm inflatable' },
      { name: 'inflation', range: [0.2, 1.5], note: 'target volume ratio V_target / V_0' },
      { name: 'stiffness / strutWeight', range: [0, 1] },
      { name: 'buoyancy', range: [0, 2] },
      { name: 'restitution / friction', range: [0, 1] },
      { name: 'leakRate', range: [0, 2], note: 'pressure units/s when punctured' },
    ],
  },
  {
    id: 'strands', kind: 'module', title: 'Instanced Verlet strands: grass, underwater kelp and hair with Kajiya–Kay shading',
    summary: 'Instanced inextensible Verlet strand solver (StrandSystem): 1 GPU thread per strand on WebGPU (zero ping-pong) plus CPU reference fallback. Rest-pose recovery, unified wind + travelling flutter, underwater kelp buoyancy + orbital surge, rotor/jet downwash with swirl, blast waves, sphere and oriented-box vehicle interactors (addVehicle), frustum/distance LOD, and dual-lobe shifted-cuticle Kajiya–Kay anisotropic ribbon shading.',
    tags: ['strands', 'grass', 'foliage', 'meadow', 'kelp', 'seaweed', 'hair', 'fur', 'kajiya-kay', 'anisotropic', 'verlet', 'wind', 'downwash', 'vehicle', 'instanced'],
    specs: ['specs/19-strands.md'],
    engines: {
      threejs: { files: ls('modules/strands'), requires: ['core'], exports: ["export * from './modules/strands';"] },
    },
    params: [
      { name: 'kind', values: 'grass | kelp | hair' },
      { name: 'stiffness', range: [1, 40] },
      { name: 'damping / drag', range: [0.5, 8] },
      { name: 'gravity', range: [-1.5, 2], note: 'negative = buoyant (kelp)' },
      { name: 'windResponse / downwashResponse / vehicleResponse', range: [0, 3] },
      { name: 'constraintIterations', range: [1, 6] },
    ],
  },
  {
    id: 'ballistics', kind: 'module', title: 'Arcade tracer trails: skipping stones, sparks and breakaway card impacts',
    summary: 'Pooled LineSegments visual trail system (TracerField) with gravity, wind-coupled exponential drag, artist-authored rectangular ImpactCard surfaces (water, steel, wood, glass), shallow-angle skips, breakaway visual exits and spray/spark/dust bursts via EffectsKit.',
    tags: ['tracers', 'trails', 'arcade', 'skipping stones', 'ricochet', 'sparks', 'impact cards', 'ballistics', 'line segments', 'breakaway'],
    specs: ['specs/20-arcade-trails.md'],
    engines: {
      threejs: { files: ls('modules/ballistics'), requires: ['core'], exports: ["export * from './modules/ballistics';"] },
    },
    params: [
      { name: 'capacity', range: [1, 512], note: 'default 96 pooled trails' },
      { name: 'gravity', range: [0, 30], note: 'default 9 scene units/s²' },
      { name: 'drag', range: [0, 2], note: 'default 0.13 1/s wind-coupled drag' },
      { name: 'card.kind', values: 'water | steel | wood | glass' },
    ],
  },
  {
    id: 'surface-deform', kind: 'module', title: 'Deformable ground: tire ruts and craters in sand, gravel, snow and mud',
    summary: 'GPU stamp buffer (compaction, berm, disturbance) with a CPU twin for physics: wheels, floats, debris and blasts press tracks that shade from their own height gradient; wind ripples on loose sand, blue compacted snow, angular gravel, glossy wet mud ruts; ballistic grit and windborne fines follow wheel load, direction and moisture; follows a target for open worlds; implements VehicleSurface (grip, rolling drag).',
    tags: ['sand', 'gravel', 'dust', 'snow', 'mud', 'tracks', 'ruts', 'footprints', 'deformation', 'displacement', 'terrain', 'rally', 'off-road', 'beach', 'desert', 'crater', 'tire tracks'],
    specs: ['specs/13-surface-deform.md'],
    engines: { threejs: { files: ls('modules/surface-deform'), requires: ['core'], exports: ["export * from './modules/surface-deform';"] } },
    params: [{ name: 'kind', values: 'sand | gravel | snow | mud' }, { name: 'moisture', range: [0, 1], note: 'baseline soil moisture; wet aggregate suppresses tire dust' }, { name: 'size', unit: 'm' }, { name: 'depth', range: [0.03, 0.4], unit: 'm' }, { name: 'grip', range: [0.3, 1] }, { name: 'recovery', range: [0, 0.05], unit: '1/s' }],
  },
  {
    id: 'animation', kind: 'module', title: 'Procedural animation: rotor blur, actuators, nozzles, chassis motion, tire tracks',
    summary: 'Shutter-accurate propeller / rotor motion-blur disc, rate-limited second-order actuators for control surfaces, variable-area exhaust nozzle, car body squat / dive / roll from the vehicle’s own acceleration, and wet tire-track ribbons (one mesh for every contact).',
    tags: ['animation', 'propeller', 'rotor', 'motion blur', 'helicopter', 'aileron', 'elevator', 'rudder', 'flaps', 'nozzle', 'afterburner', 'suspension', 'squat', 'dive', 'body roll', 'tire tracks', 'skid marks', 'actuator'],
    specs: ['specs/15-animation-camera.md'],
    engines: { threejs: { files: ls('modules/animation'), requires: ['core'], exports: ["export * from './modules/animation';"] } },
    params: [{ name: 'shutter', range: [0.004, 0.04], unit: 's' }, { name: 'pitchGain / rollGain', unit: 'rad per m/s²' }, { name: 'tracks.life', unit: 's' }],
  },
  { id: 'rig-beaver', kind: 'rig', title: 'DHC-2 Beaver floatplane test rig', summary: 'Procedural floatplane (fuselage loft, radial engine, stepped floats) with float sample points for buoyancy and wake emitters.', tags: ['seaplane', 'floatplane', 'beaver', 'aircraft', 'test rig', 'model'], specs: [], engines: { threejs: { files: ['test-rigs/beaver-model.ts', 'test-rigs/beaver.ts'], requires: ['animation'], exports: ["export { createBeaverRig, type BeaverRig } from './test-rigs/beaver';"] } }, params: [] },
  { id: 'rig-jets', kind: 'rig', title: 'Fighter jet test rigs: F-15E, F-16C, F-22A, F/A-18E, Su-57', summary: 'Parametric lofted jets with TSL afterburner plumes, animated control surfaces and variable nozzles; anchors for the aero module.', tags: ['jet', 'fighter', 'f-15', 'f-16', 'f-22', 'f/a-18', 'su-57', 'aircraft', 'test rig', 'model'], specs: [], engines: { threejs: { files: ['test-rigs/jets-model.ts', 'test-rigs/jets.ts'], requires: ['jet-exhaust', 'animation'], exports: ["export { createJetRig, JET_IDS, type JetId, type JetRig } from './test-rigs/jets';"] } }, params: [] },
  { id: 'rig-test-car', kind: 'rig', title: 'Minimal aerodynamic test car (4 articulated wheels, body roll)', summary: 'Lofted fastback proxy implementing VehicleRig for the aquaplaning controller.', tags: ['car', 'vehicle', 'test rig', 'model'], specs: [], engines: { threejs: { files: ['test-rigs/test-car.ts'], requires: [], exports: ["export { createTestCar, type TestCarRig } from './test-rigs/test-car';"] } }, params: [] },
  { id: 'rig-sports-coupe', kind: 'rig', title: 'Procedural sports coupe (lofted shell, wheel wells, LED lights, brake bar)', summary: 'Low fastback built from analytic profiles: 112-section lofted shell with glazing as shell faces, recessed wheel wells, lathed tyres with five-spoke alloys, LED headlight blades and a full-width tail bar that goes HDR under braking. Implements VehicleRig; batched static parts.', tags: ['car', 'coupe', 'sports car', 'vehicle', 'supercar', 'brake lights', 'headlights', 'model', 'test rig'], specs: ['specs/15-animation-camera.md'], engines: { threejs: { files: ['test-rigs/sports-coupe.ts', 'test-rigs/test-car.ts'], requires: ['core'], exports: ["export { createSportsCoupe, type SportsCoupeRig } from './test-rigs/sports-coupe';"] } }, params: [{ name: 'color' }] },
  // ---- recipes: parameter blueprints for effects that are remixes of the modules above ----
  {
    id: 'recipe-coastal-sky', kind: 'recipe', title: 'Coastal cloudscape, Caribbean daylight and hazy sunset',
    summary: 'Use tradeCumulus for broken cumulus groups over a lagoon or coastalHaze for the low sun. Share Weather between sky and water. Preload outdoor cloud noise during renderer startup.',
    tags: ['coastal', 'sky', 'cumulus', 'clouds', 'cloudscape', 'haze', 'sunset', 'caribbean', 'reflection', 'sun', 'startup'],
    specs: ['specs/22-scene-realism.md', 'specs/06-atmosphere-clouds-lightning.md', 'specs/02-water-optics.md'],
    engines: {}, params: [{ name: 'weather', value: 'tradeCumulus | coastalHaze' }, { name: 'preloadClouds', value: true }],
  },
  {
    id: 'outdoor-world', kind: 'module', title: 'Composable outdoor world',
    summary: 'Create a scene with independent climate, sky layers, sea state, tide, bathymetry and optics. Pass ocean: false for sky and atmosphere only.',
    tags: ['world', 'environment', 'climate', 'sky', 'coast', 'tide', 'water', 'clouds'],
    specs: ['specs/22-scene-realism.md'],
    engines: { threejs: { files: ['modules/weather/outdoor-world.ts', 'modules/weather/world-profile.ts', 'modules/weather/world-looks.json'], requires: ['ocean', 'rain'], exports: ["export * from './modules/weather/outdoor-world';", "export * from './modules/weather/world-profile';"] },
      godot: { files: [G + '/lumina_world_profile.gd', 'modules/weather/world-looks.json'] },
      unity: { files: [U + '/LuminaWorldProfile.cs', 'modules/weather/world-looks.json'] } },
    params: [{ name: 'weather / upperClouds', note: 'weather preset or parameters and optional independent upper cloud deck' }, { name: 'climate', note: 'two altitude endpoints, temperature and humidity' }, { name: 'localProbe', note: 'optional off-screen reflection capture: center, halfSize, layer, resolution, refreshSeconds' }, { name: 'ocean / waterLevel / tide / optics', note: 'sea state, mean level, tide and optical overrides' }],
  },
  { id: 'recipe-climate', kind: 'recipe', title: 'Hot coast, cold front and humid jet cruise', summary: 'Set a world air column for temperature by altitude, humidity-sensitive contrails, road frost and heat transfer. Combine it with an independent sky, swell and tide.', tags: ['warm', 'cold', 'climate', 'humidity', 'frost', 'shader', 'contrails', 'air temperature', 'dry heat'], specs: ['specs/21-world-coupling.md', 'specs/22-scene-realism.md'], engines: {}, params: [{ name: 'baseAltitude / topAltitude', unit: 'm' }, { name: 'baseTemperatureC / topTemperatureC', unit: '°C' }, { name: 'baseIceHumidity / topIceHumidity', note: 'ratio over ice' }, { name: 'surfaceHumidity', range: [0, 1] }] },
  { id: 'recipe-tidal-beach', kind: 'recipe', title: 'Still tidal pool, beach tide and surf', summary: 'Ocean with Bathymetry, a periodic tide and independently authored wind waves, swell and surf. Use still for a sheltered pool or blend lagoon and storm for a rising rough sea.', tags: ['water', 'still', 'tide', 'tidal', 'beach', 'calm', 'surf', 'waves'], specs: ['specs/03-shoaling-tsunami.md'], engines: {}, params: [{ name: 'tide', value: { amplitude: 1.2, periodSeconds: 44700, phase: 0 } }, { name: 'breakerHeight', unit: 'm', note: '0 for the sheltered pool' }, { name: 'bathymetry.shoreDryingSeconds', unit: 's', note: 'time constant for draining exposed sand, 900 by default' }] },
  { id: 'recipe-gta-rainy-chase', kind: 'recipe', title: 'GTA-style rainy street chase', summary: 'weather(storm) + rain + lightning + SunFx(stormyTwilight), WetRoad with flood 0.4, AquaplaningVehicle on the sports coupe, TireSpray, TireTracks, ChassisAnimator, CameraFeel chase (stiffness 1.6, fovGain 13, bank 0.5), lens rain; destructible glass and brick along the street; brake pool on the wet asphalt. Tier auto + DRS.', tags: ['gta', 'street', 'chase', 'city', 'rain', 'night', 'police', 'car chase', 'neon'], specs: ['specs/05-wet-road-aquaplaning.md', 'specs/15-animation-camera.md', 'specs/11-destruction.md'], engines: {}, params: [{ name: 'weather', value: 'storm' }, { name: 'road.flood', value: 0.4 }, { name: 'targetSpeed', value: '30–40 m/s' }, { name: 'lens.rain', value: 0.45 }] },
  { id: 'recipe-jet-hurricane', kind: 'recipe', title: 'Fighter jet over a hurricane ocean', summary: 'weather(hurricane) with shafts 0.8 + SunFx(stormyTwilight), ocean storm → hurricane morph 0.35–0.8, JetAero low pass (altitude 26 m, Mach 1.1) for downwash trough, vapour cone and sonic boom, lightning 14/min, rain, lens splashes from the rooster tail, CameraFeel chase on the jet (distance 38, stiffness 0.9). Enable DRS on high-DPI / large canvases.', tags: ['jet', 'fighter', 'hurricane', 'storm', 'ocean', 'top gun', 'carrier', 'low pass', 'sonic boom'], specs: ['specs/07-aero.md', 'specs/01-ocean-spectrum-fft.md', 'specs/06-atmosphere-clouds-lightning.md'], engines: {}, params: [{ name: 'weather', value: 'hurricane' }, { name: 'ocean.morph', value: 0.5 }, { name: 'passAltitude', value: 26 }, { name: 'machPeak', value: 1.12 }] },
  { id: 'recipe-cozy-island', kind: 'recipe', title: 'Cozy sunlit island with flags and a shallow lagoon', summary: 'weather(tropical, sunElevation 40–55, coverage 0.4) + SunFx(tropicalNoon), ocean lagoon preset with clarity 0.95 over lagoonIsland bathymetry (caustics, shoreline breakers 0.3), ClothSystem flags / bunting / a sail in 5–8 m/s wind, a mooring rope, StrandSystem coastal grass and kelp, Underwater for snorkelling, BuoyantBody boats. Runs on Low with single-pass water.', tags: ['island', 'tropical', 'cozy', 'lagoon', 'beach', 'flags', 'sailing', 'snorkel', 'relaxing'], specs: ['specs/02-water-optics.md', 'specs/10-cloth-rope.md', 'specs/14-underwater-lens.md', 'specs/19-strands.md'], engines: {}, params: [{ name: 'weather', value: 'tropical' }, { name: 'ocean', value: 'lagoon' }, { name: 'wind', value: '6 m/s' }, { name: 'optics.clarity', value: 0.95 }] },
  { id: 'recipe-warehouse-firefight', kind: 'recipe', title: 'Destructible warehouse with spreading 3D fire and steam', summary: 'DestructionSystem walls (concrete 0.35 m, brick 0.22 m), glass panes and wooden crates / planks; destruction.shoot(origin, dir, energy) with generic impact energies (500 J light, 3 kJ medium, 20 kJ heavy), Explosions for charges; ThermoField ground + addWall/addDeck 3D surfaces with timber fuel and materials library shaders, sprinklers = thermo.rain 0.8 (steam, then out); CameraFeel.impact + hitstop on heavy hits.', tags: ['warehouse', 'cover', 'sprinkler', 'steam', 'indoor', 'destructible', '3d fire'], specs: ['specs/11-destruction.md', 'specs/12-thermo.md', 'specs/08-fire-explosions.md', 'specs/17-pbr-materials.md'], engines: {}, params: [{ name: 'impact energy', value: '500–20 000 J' }, { name: 'fuel', value: '3 kg/m² timber' }, { name: 'sprinklers', value: 'thermo.rain = 0.8' }] },
  { id: 'recipe-snowy-rally', kind: 'recipe', title: 'Snowy rally race', summary: 'DeformableGround(kind snow, follow: car, size 48) as the VehicleSurface (grip 0.42, deeper ruts raise grip 25 %), AquaplaningVehicle + sports coupe with a lane or circle path, ChassisAnimator, CameraFeel chase with lean; weather overcast with turbidity 5 and visibility 6 km; rain module as snowfall (see recipe-snowstorm); mist pool powder from the clumps; flags and banners at the stage finish.', tags: ['rally', 'snow', 'ice', 'drift', 'race', 'winter', 'off-road', 'stage'], specs: ['specs/13-surface-deform.md', 'specs/15-animation-camera.md', 'specs/10-cloth-rope.md'], engines: {}, params: [{ name: 'ground.kind', value: 'snow' }, { name: 'ground.follow', value: 'car' }, { name: 'targetSpeed', value: '20–30 m/s' }, { name: 'weather', value: 'overcastSwell + visibility 6000' }] },
  { id: 'recipe-lava', kind: 'recipe', title: 'Lava flow / lava lake', summary: 'Ocean surface with clarity 0, absorption replaced by blackbody emission from the foam field (crust = low Jacobian, cracks = high), viscosity via damping; Explosions magma archetype + fire pool for embers.', tags: ['lava', 'magma', 'volcano', 'molten'], specs: ['specs/02-water-optics.md', 'specs/08-fire-explosions.md'], engines: {}, params: [{ name: 'windSpeed', value: 1.5 }, { name: 'chop', value: 0.2 }, { name: 'field.damping', value: 3 }] },
  { id: 'recipe-snowstorm', kind: 'recipe', title: 'Snowstorm / blizzard', summary: 'Rain module with fall speed 0.8–2.2 m/s, streak length → 0, larger soft sprites and strong wind turbulence; weather storm preset with cold turbidity; mist pool for spindrift.', tags: ['snow', 'blizzard', 'snowstorm', 'winter', 'ice'], specs: ['specs/06-atmosphere-clouds-lightning.md'], engines: {}, params: [{ name: 'fall', range: [0.8, 2.2] }, { name: 'wind.gustiness', value: 0.8 }] },
  { id: 'recipe-river-rapids', kind: 'recipe', title: 'River rapids, waterfall valley and buoyant inflatables', summary: 'InlandWater with RIVER_PRESETS.mountainRapids + Waterfall(WATERFALL_PRESETS.cascade), StrandSystem riverside grass + submerged kelp driven by inland.flowAt(), SoftBodySystem inflatable buoys and life rings floating on inland water, PBR materials (titanium, timber, seaSprayGlass) and TracerField skipping stones over water and breakaway cards; SunFx(goldenHour).', tags: ['river', 'rapids', 'white water', 'stream', 'waterfall', 'current', 'kayak', 'raft', 'buoy', 'kelp', 'valley'], specs: ['specs/16-inland-water.md', 'specs/18-softbody.md', 'specs/19-strands.md', 'specs/20-arcade-trails.md'], engines: {}, params: [{ name: 'river', value: 'RIVER_PRESETS.mountainRapids' }, { name: 'waterfall', value: 'WATERFALL_PRESETS.cascade' }, { name: 'grading', value: 'goldenHour' }] },
  { id: 'recipe-custom-tsunami', kind: 'recipe', title: 'Custom tsunami / surf break / dam burst', summary: 'Tune height, width, speed and breaking; multiple Tsunami instances summed for wave trains; low breaking + long width = tidal bore, high breaking + short width = surfable barrel.', tags: ['tsunami', 'surf', 'barrel', 'dam break', 'flood', 'tidal bore'], specs: ['specs/03-shoaling-tsunami.md'], engines: {}, params: [{ name: 'breaking', range: [0, 1] }, { name: 'width/height', note: '1.5–2.5 for walls, 4+ for bores' }] },
  { id: 'recipe-sandstorm', kind: 'recipe', title: 'Sandstorm / dust devil / desert convoy dust', summary: 'Dust pool driven by the wind field + rotor-wash style ground sources, turbidity 9+, warm fog tint; tire spray emitters with the dust pool on dry ground.', tags: ['sand', 'dust', 'desert', 'sandstorm', 'haboob'], specs: ['specs/08-fire-explosions.md'], engines: {}, params: [{ name: 'turbidity', value: 10 }, { name: 'visibility', value: 800 }] },
  { id: 'recipe-boat-wake', kind: 'recipe', title: 'Speedboat / ship wake', summary: 'BuoyantBody + interaction-field sources: bow push, stern foam, convergence sources aft; matchKelvin(speed) for the 19.47° V.', tags: ['boat', 'ship', 'wake', 'speedboat', 'jet ski', 'kelvin'], specs: ['specs/04-interaction-wakes-buoyancy.md'], engines: {}, params: [] },
];

// ---- validation: files, specs, Three.js adapter entrypoints & transitive selective installs ----

const byId = new Map();
for (const entry of entries) {
  if (byId.has(entry.id)) throw new Error(`catalog: duplicate entry id "${entry.id}"`);
  byId.set(entry.id, entry);
  for (const spec of entry.specs ?? []) {
    if (!fs.existsSync(path.join(root, spec))) throw new Error(`catalog: missing spec ${spec} (entry ${entry.id})`);
  }
  for (const engine of Object.values(entry.engines ?? {})) {
    for (const file of engine.files ?? []) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`catalog: missing file ${file} (entry ${entry.id})`);
    }
  }
}

/** Strip JS/TS comments so doc examples do not produce false import hits. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Extract relative import/export specifiers (`./...` or `../...`) from TS source text. */
function extractRelativeSpecifiers(source) {
  const clean = stripComments(source);
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(clean)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/** Resolve a repo-relative import specifier from `fromFile` (POSIX) to an existing repo-relative file. */
function resolveRepoRelative(fromFile, specifier) {
  const baseDir = path.posix.dirname(fromFile);
  const raw = path.posix.normalize(path.posix.join(baseDir, specifier));
  if (raw.startsWith('..')) return null;
  const candidates = /\.[a-z]+$/i.test(raw)
    ? [raw]
    : [raw, `${raw}.ts`, `${raw}/index.ts`, `${raw}.js`, `${raw}.mjs`];
  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c)) && fs.statSync(path.join(root, c)).isFile()) return c;
  }
  return null;
}

/** Compute the transitive closure of `threejs` files for a selective install of `id`. */
function threejsClosure(id) {
  const visited = new Set();
  const stack = new Set();
  const files = new Set();
  const visit = (cur) => {
    if (stack.has(cur)) throw new Error(`catalog: dependency cycle involving "${cur}"`);
    if (visited.has(cur)) return;
    const entry = byId.get(cur);
    if (!entry) throw new Error(`catalog: unknown dependency "${cur}" required by "${id}"`);
    const target = entry.engines?.threejs;
    if (!target) throw new Error(`catalog: dependency "${cur}" has no threejs target (required by "${id}")`);
    stack.add(cur);
    for (const dep of target.requires ?? []) visit(dep);
    stack.delete(cur);
    visited.add(cur);
    for (const f of target.files ?? []) files.add(f);
  };
  visit(id);
  return { entries: [...visited], files };
}

const threePeers = { three: '>=0.187.0', '@dimforge/rapier3d-compat': '>=0.21.0' };
let validatedClosures = 0;
let validatedImports = 0;
for (const entry of entries) {
  const target = entry.engines?.threejs;
  if (!target) continue;
  const closure = threejsClosure(entry.id);
  validatedClosures++;
  const peers = new Set();

  for (const file of closure.files) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of stripComments(src).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      for (const name of Object.keys(threePeers)) {
        if (spec === name || spec.startsWith(name + '/')) peers.add(name);
      }
    }
    for (const spec of extractRelativeSpecifiers(src)) {
      validatedImports++;
      const resolved = resolveRepoRelative(file, spec);
      if (!resolved) {
        throw new Error(`catalog: unresolved relative import "${spec}" in ${file} (selective install "${entry.id}")`);
      }
      if (!closure.files.has(resolved)) {
        throw new Error(`catalog: selective install "${entry.id}" is missing "${resolved}" imported by ${file} via "${spec}"`);
      }
    }
  }

  // Omit the override for packages that use the standard full-engine dependencies.
  if (peers.size !== Object.keys(threePeers).length) target.peers = [...peers].sort();
  for (const expLine of target.exports ?? []) {
    for (const spec of extractRelativeSpecifiers(expLine)) {
      validatedImports++;
      const resolved = resolveRepoRelative('index.ts', spec);
      if (!resolved || !closure.files.has(resolved)) {
        throw new Error(`catalog: selective install "${entry.id}" barrel export "${expLine}" resolves to "${resolved ?? 'missing'}", not in closure`);
      }
    }
  }
}

// Also validate the repository's Three.js adapter entrypoint resolves cleanly on disk.
const threeAdapter = 'adapters/threejs/index.ts';
if (fs.existsSync(path.join(root, threeAdapter))) {
  const adapterSrc = fs.readFileSync(path.join(root, threeAdapter), 'utf8');
  for (const spec of extractRelativeSpecifiers(adapterSrc)) {
    validatedImports++;
    const resolved = resolveRepoRelative(threeAdapter, spec);
    if (!resolved) throw new Error(`catalog: unresolved relative import "${spec}" in ${threeAdapter}`);
  }
}

const catalog = {
  name: pkg.name, version: pkg.version,
  description: 'Physics, water, weather, aerodynamics, explosions, cloth, destruction, thermo, PBR materials, soft bodies, strands, arcade trails and procedural animation modules for Three.js (WebGPU + TSL), Godot 4 and Unity.',
  engines: { threejs: { dest: 'src/lumina-physics', peer: threePeers }, godot: { dest: 'addons/lumina_physics' }, unity: { dest: 'Assets/LuminaPhysics' } },
  tiers: ['low', 'medium', 'high', 'xhigh', 'ultra'],
  entries,
};

if (checkOnly) {
  console.log(`catalog check ok: ${entries.length} entries, ${validatedClosures} threejs closures, ${validatedImports} relative imports verified`);
} else {
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`catalog.json: ${entries.length} entries (${validatedClosures} threejs closures, ${validatedImports} imports verified)`);
}
