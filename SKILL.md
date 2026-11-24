---
name: lumina-physics
description: Author procedural terrain, trees, flowers, grass, earth, art directions and game physics. Use for oceans, lagoons, tsunamis, foam, caustics, underwater views, buoyancy, rivers, waterfalls, soft bodies, wind-swept strands, ricocheting tracer effects, PBR materials, boat wakes, wet roads, puddles, aquaplaning, tire spray and tracks, rain on the lens, volumetric clouds, god rays, lightning, jets, sonic booms, rotor wash, fire that spreads, steam, melting ice, explosions, destructible glass / concrete / wood / brick, cloth, flags, sails, parachutes, ropes, power lines, sand / snow / mud ruts, chase cameras, quality tiers, dynamic resolution and 60 fps tuning in Three.js WebGPU/TSL, Godot 4 or Unity, and for shared world fields, aircraft cloud carving, waterspouts, sinking boats, flooded streets, vehicle crumple, tree breakage and active ragdolls.
---

# Lumina Physics

Pure-code physics, shader and animation modules for Three.js (WebGPU + TSL, WebGL 2
fallback) with starter adapters for Godot 4 and Unity URP. No textures, models or audio on
disk. Run commands from this skill's directory with Node.js 20+; pass absolute paths to
`--project` / `--dest`. Everything works offline.

`engine/` + `modules/` are the reference implementation, `specs/` the engine-agnostic math
(00–27), `adapters/` drop-in starters per engine, `showcase/` an eight-scene testbed.

## 1. Search for the closest module

Describe the circumstance (surface, weather, vehicle, event). Every word must match.
For outdoor scenes, choose the camera height, time of day, air conditions and surface first.
Read [the scene realism guide](specs/22-scene-realism.md) for coastal daylight, hazy sunset,
flight and wet-road choices, plus cold-start and visual checks. Search with two concrete terms.

```sh
node scripts/search.mjs tsunami wave --json
node scripts/search.mjs flag wind --engine godot
node scripts/search.mjs --kind recipe            # remix blueprints: rainy chase, snowy rally, lava…
```

Each entry lists its id, engines, tunable physical parameters with ranges and the spec to
read. `kind: recipe` entries are parameter blueprints built from existing modules.

## 2. Install only what the game needs

```sh
node scripts/install-physics.mjs --engine threejs ocean cloth destruction --project /abs/game
node scripts/install-physics.mjs --engine godot cloth thermo --project /abs/godot-project
node scripts/install-physics.mjs --engine unity --dest /abs/Unity/Assets/LuminaPhysics
```

Dependencies resolve automatically (`ocean` pulls `weather` and `core`). Destinations:
`src/lumina-physics/` (Three.js, with a generated `index.ts`), `addons/lumina_physics/`
(Godot), `Assets/LuminaPhysics/` (Unity). The copy belongs to the game; re-running reports
edited files as conflicts instead of overwriting (`--force`, `--dry-run`, `--with-specs`).
The installer prints the peers for the selected modules. Standalone `puddle-contacts` uses Three.js 0.187 or later. Modules that include the physics engine also use Rapier 0.21 or later.

For a new outdoor game, install `outdoor-world`. Ask which parts are owned by the host. Keep art direction, physical sea state, weather and clock independent. See the [profile schema, units and ownership](specs/24-world-profiles.md).

```ts
const world = await createLuminaWorld({ profileVersion: 1, seed: 721, biome: 'coastal-cliffs',
  look: 'cold-overcast', weather: 'overcast', time: 15, quality: 'auto',
  overrides: { seaState: 'swell', grassDensity: 0.2 }, locks: ['waterTint', 'seaState', 'grassDensity'] }, { canvas });
world.engine.camera.position.set(-45, 45, -85);
world.engine.camera.lookAt(12, 8, -15);
world.engine.start();
world.patch({ time: 17.55, look: 'painterly' }, 4);
const saved = JSON.stringify(world.profile);
```

For a rain-only game install `profile-rain` and call `attachWorldRain(profile, host)`. With `outdoor-world` installed, use `mode: 'attach', weather: 'squall'` and pass `{scene,camera}` as the second argument. Call `attachment.update(dtSeconds)` from the host loop and `dispose()` at unload. A profile can also load a custom heightmap. Use `terrain.sample(x,z,reusableReading)` for grounded objects. Give a vehicle the terrain as its surface and use `ground:false` so its tires hit the terrain collider. In Godot/Unity, load resolved JSON plus the shared look library into the starter config loader.

For a custom landscape start with `land-authoring` and a named parent. Define plants, flowers, geology and material hooks in game-owned code. Use one unsigned seed per subsystem. Read the five runnable examples and inspect the nearest plant and soil before tuning the look. [Authoring recipes, units and examples](specs/26-land-authoring.md)
For a new game install `outdoor-world`. For a host-owned level install `landscape-host` and pass its terrain, camera, fields and planting exclusions. Use `regional-flight` for distance tiles and `grove-contacts` to turn a landmark into a physical tree. [Terrain controls](specs/25-landscapes.md)
In the preview open **World profiles → Landscape field guide**. Change art direction or season in place. Reuse the same road for the ridge, walk and drive views. A project can keep a chalk stream and change just the flowers by preserving the terrain and tree seeds. [Five editable recipes](examples/landscape/chalk-stream.ts) · [Independent playable game and source](examples/brindle-reach) · [Field checks and gallery](specs/releases/v1.0.0-fields.md)

For a playable beach install `coastal-world` and optionally `coastal-habitat`. Start with the four [game-owned shore recipes](examples/coast/recipes.ts). Use `coastal-contacts` on an existing road or bridge and `weather-front` for local rain. Inspect the last water source before tuning a footprint. [Shore geometry, surface units, weather and saves](specs/27-coastal-worlds.md) · [Playable estuary revision](examples/salt-crossing/README.md)

For a configurable sky, climate and coastline in one call, install `outdoor-world` and use `createLuminaWorld`. See [contrasting scene examples](specs/22-scene-realism.md).

For an ebb tide set `shoreDryingSeconds` in the Bathymetry constructor. For shallow cloudlets or tall cumulus set `weather.params.convection` from −1 to +1. For a rally road use `DeformableGround` with `kind: 'gravel'` and `moisture` from 0 to 1. [Surface parameters](specs/13-surface-deform.md)

Base module ids: `core`, `weather`, `lightning`, `rain`, `ocean`, `tsunami`, `buoyancy`,
`underwater`, `wet-road`, `aero`, `explosions`, `cloth`, `destruction`, `thermo`,
`surface-deform`, `animation`; rigs `rig-beaver`, `rig-jets`, `rig-sports-coupe`,
`rig-test-car`. Godot / Unity ship quality, ocean, tsunami, buoyancy, wet road,
aquaplaning, explosions, cloth, rope, fracture and thermo.

For coupled MVP features, search `world-fields`, `rotor-wash`, `weather-vortex`, `street-fluid`, `floodable-vessel`, `vehicle-damage`, `flexible-tree` or `active-ragdoll`. The catalog lists inputs and units. Use local `AeroState.relativeHumidity` or the fallback `JetAero.params.humidity` for transonic condensation and `downwashCeiling` for the height of water interaction.

## 3. Three.js in one screen

```ts
import { LuminaEngine, EffectsKit, Weather, WEATHER_PRESETS, Ocean, OCEAN_PRESETS, BuoyantBody, Explosions,
  ClothSystem, DestructionSystem, ThermoField } from './lumina-physics';

const engine = await LuminaEngine.create({ canvas, tier: 'auto', preloadClouds: true });        // WebGPU, falls back to WebGL 2
const weather = engine.add(new Weather(engine));
Object.assign(weather.params, WEATHER_PRESETS.tropical);
const ocean = engine.add(new Ocean(engine, { weather }));
ocean.setSeaStates(OCEAN_PRESETS.breeze, OCEAN_PRESETS.storm);            // morph end points
const fx = engine.add(new EffectsKit(engine));
const blasts = engine.add(new Explosions(engine, fx, ocean));
const cloth = engine.add(new ClothSystem(engine));
cloth.flag({ origin: poleTop, pattern: 'stripes', colors: [0xb8141f, 0xf2efe6] });
const wreck = engine.add(new DestructionSystem(engine, fx, { ocean }));
const wall = wreck.add({ material: 'concrete', size: new THREE.Vector3(4, 2.4, 0.35), position });
const heat = engine.add(new ThermoField(engine, fx, { size: 40, surfaceY: 0, weather, ocean }));

engine.onUpdate = (dt) => {                                               // game logic, input, forces
  ocean.morph = stormAmount;                                              // 0..1, no rebuild
  ocean.field.addSource({ x, z, radius: 1, push: -30, foam: 2 });         // hull / jet / tire disturbance
  ocean.updateField(dt, player.position);
};
engine.onBeforeRender = (dt) => { /* place the camera here: runs after physics */ };
engine.start();
await engine.calibrateTier(58);                                           // best tier for this window

new BuoyantBody(engine.physics, ocean, rapierBody, { points, volume: 6.4 });
blasts.detonate({ kind: 'c4', position, yield: 1.2 });                    // breaks the wall, heats the field, snaps the flag
```

Frame order: `onUpdate` → Rapier fixed 1/60 s steps (pre-step callbacks) → bound objects get
**render-interpolated** transforms → `onBeforeRender` (camera rigs) → reprojection uniforms →
module `update` → `pipeline.render()`. Read poses for cameras and effects from the bound
`Object3D` (interpolated), never from `body.translation()` (raw 60 Hz).

Never add `EffectComposer`, `ShaderMaterial`, `RawShaderMaterial` or `onBeforeCompile`.
Author materials as node materials with TSL pulled from `engine/tsl.ts`; add screen-space
effects with `engine.pipeline.addEffect({ id, scene?, distort?, lens? })`.

## 4. Quality tiers, dynamic resolution, telemetry

`engine.setQuality('low' | 'medium' | 'high' | 'xhigh' | 'ultra')` switches live.
`tier: 'auto'` starts from a capability score, `await engine.calibrateTier(58)` measures
frame pacing at the real canvas size and settles on the highest tier that holds 58+ fps,
and `engine.quality.auto = true` keeps guarding afterwards (never auto-steps up unless
`autoUp`).

| Tier | Resolve | FFT ocean | Water | Clouds / shafts | SSR | Particles |
| --- | --- | --- | --- | --- | --- | --- |
| low | 0.67× + TAAU | 2 × 64² | single-pass analytic column | single-pass analytic dome / – | – | 2 k |
| medium | 0.77× + TAAU | 3 × 128² | refraction + depth taps | 14 @ ½ / 6 | – | 8 k |
| high | native TRAA ≤ 3.0 MP | 3 × 256² | 〃 | 20 @ ½ / 8 | on | 20 k |
| xhigh | native TRAA ≤ 2.6 MP | 4 × 256² | 〃 | 28 @ ½ / 12 | on | 49 k |
| ultra | native TRAA ≤ 2.15 MP | 4 × 512² | 〃 | 32 @ ½ / 16 | on | 90 k |

- **Pixel budget.** Canvases above a tier's `maxPixels` keep display resolution and render
  the scene at a lower internal scale, reconstructed by temporal upscaling.
- **Dynamic resolution** (`engine.setDynamicResolution(true)`, on by default with
  `tier: 'auto'`): the internal scale follows measured GPU load between 0.55× and the tier's
  scale, in 0.05 steps, without rebuilding the pipeline. Tune `engine.drs.{min, target}`.
- **Telemetry.** `engine.stats` = `{ frameMs, simMs, submitMs, gpuMs, gpuHeadroom,
  drawCalls, triangles, renderScale }`. `gpuMs` is a conservative estimate (WebGPU only).
  The 1080p release targets are ≤ 10 ms estimated GPU on Ultra and ≤ 2.5 ms WebGL 2 simulation in the playground.
- **Shader LOD.** Every tier fades the ocean to the analytic water column and drops foam
  lace beyond 250 m; soft sprites (mist, smoke, dust, fire) render in a half-resolution layer.
- **Draw calls.** `mergeStaticMeshes(root, dynamicNodes)` bakes rigid parts of a code-built
  model into one mesh per material. Instance repeated props; one `ClothSystem` /
  `DestructionSystem` per scene.

A preset is plain data (`QUALITY_PRESETS`); pass your own object to `engine.quality.set`.
Modules read numbers from the preset in `setQuality(preset)`; they never branch on names.

## 5. Module cheat sheet

| Need | Call |
| --- | --- |
| Rapids and falls | `water = engine.add(new InlandWater(engine, { weather, fx }))`; `water.addRiver({ ...RIVER_PRESETS.mountainRapids, points })`, `water.addWaterfall({ position, direction, width, height })`, `water.flowAt(x, z, out)` |
| Soft bodies | `new SoftBodySystem(engine, { ocean: water })`; add `.buoy()`, `.torus()` or `.cushion()`, then adjust pressure, apply a local impulse or attach a collider |
| Grass, kelp and hair | `strands = engine.add(new StrandSystem(engine))`; `strands.grass({ center, size, count, heightAt })`, `.kelp()`, `.hair()`; set `strands.waterCurrent` from the river |
| Surface materials | `createMaterial('timber', { thermalSurface: wall })`; use the returned material on a mesh, change live uniforms with `setParams()` |
| Sun and optics | `engine.add(new SunFx(engine, { weather, grading: 'goldenHour' }))`; `setGrading('stormyTwilight', seconds)` transitions the grade |
| Arcade trails | `field = engine.add(new TracerField(engine, fx))`; `addSurface({ kind, center, orientation, width, height })` returns an unregister function. `launch(origin, velocity)` uses world coordinates |
| Simulation events | `unsubscribe = engine.events.on('splash', payload => …)`; positions are optional world-space triples. Release the listener on teardown |
| Sea height for gameplay | `ocean.heightAt(x, z)`, `ocean.sample(x, z, out)`, `ocean.flowAt`, `ocean.depthAt` |
| Sea state | `ocean.params` / `targetParams` + `rebuildSpectrum(slot)`, `ocean.morph`, `ocean.optics.{clarity, foam, sss, breakerHeight}` |
| Still pool / tidal beach | For flat water use `OCEAN_PRESETS.still` at both sea-state endpoints and `ocean.optics.breakerHeight = 0`. Add `ocean.setTide({ amplitude: 1.2, periodSeconds: 44700, phase: 0.25 })` for high water at the current time. Waves, wakes and tides can be tuned independently. |
| Shoreline / lagoon | `new Bathymetry({ size, height: (x, z) => metres })` → `new Ocean(engine, { weather, bathymetry })`. Call `bathymetry.addCoast(mesh)` for additional shore geometry. |
| Tsunami | `ocean.tsunami.launch(target, distance, { height, width, speed, breaking, direction })`, `TsunamiEffects` |
| Wakes / ripples | `ocean.field.addSource({ x, z, radius, push?, impulse?, foam? })`, `field.matchKelvin(speed)` |
| Floating bodies | `new BuoyantBody(physics, ocean, body, { points, volume, draft, keel })` |
| Underwater | `engine.add(new Underwater(engine, ocean))`; `.submerged`, `.depth`, `.params.{fog, rays, bubbles}`, `.burst(pos)`; let the camera go below `ocean.heightAt` |
| Wet lens | `engine.lens.rain = 0..1`, `.splash(amount)`, `.splashAt(pos, radius)`, `.drench()`, `.enabled` |
| Warm / cold air and materials | Use `engine.world.setClimate(CLIMATES.humidCoast)`, `dryHeat`, `coldFront` or your own two-altitude profile. Surface moisture, frost, drying, thermal props and jet exhaust respond. Keep the sun and sea state independently adjustable. |
| Sky / time of day | For a game clock call `setSolarTime(weather.params, { latitudeDeg, dayOfYear, solarHour })`. For an authored sky set `sunElevation` and `sunAzimuth` in degrees. Weather presets control the air, cloud cover and exposure. [Calendar inputs](specs/06-atmosphere-clouds-lightning.md#sunlight-from-a-game-clock) |
| Layered clouds | Pass `{ upperClouds: CLOUD_LAYERS.highBank }` to the Weather constructor. Tune soft cloud edges with `weather.params.cloudErosion` and `upperClouds.erosion` (0–1). For small fair-weather cells start with `WEATHER_PRESETS.hotFair`. For deep rain use `storm` and an upper `rainBank`. Probe condensate with `weather.sampleCloudDensity(position)` and call `weather.resetCloudHistory()` on a scripted camera cut. |
| Off-screen hulls / buildings | Pass `localProbe: { center, halfSize, layer: 24 }` in Weather options. Enable layer 24 on the opaque objects to reflect. Call `await weather.localProbe.prepare(engine.renderer,engine.scene)` during loading. |
| Shader hooks | `weather.reflection(dir, lod)`, `weather.cloudShadow(p)`, `weather.aerial(color, p)`, `specularAA(normal, alpha2)` |
| Lightning / rain | `new Lightning(engine, weather)`, `.strike(target?)`, `.rate`; `new Rain(engine, weather)` |
| Wet road + car | `new WetRoad(engine, weather)`, `road.params.{flood, wetness, rain}`, `road.brake`; `new AquaplaningVehicle(engine, rig, surface, { path, groundY })`; `new TireSpray(…)` |
| Jet nozzle and wing vapor | Mount `JetExhaust(radiusM,lengthM)` at each exit, +Z aft. For independent engines pass `AeroState.engineThrottles` in nozzle order. In the rig’s `setNozzlePower(i,power,time,heat)`, drive `JetExhaust.setPower` and the corresponding hot metal. Pass local `AeroState.relativeHumidity` for lifting-wing vapor and `airTemperatureC` plus `iceHumidity` for engine trails. |
| Sunset into night | Start with `WEATHER_PRESETS.blueHour` or `clearNight`, animate solar elevation, and supply a world-space unit `weather.moonDirection` and `params.moonlight`. Set `params.moonIllumination = 'fromDirections'` for a sun-facing lunar phase that also dims reflections and opaque PBR lighting. |
| Chipped walls and sideswipes | For Three.js use `Destructible.markSurface(point,radiusM)` for chips or `markScrape(from,to,radiusM,chunkIndex?)` for a sliding contact. Pass a world contact normal and sliding velocity to `VehicleDamage.impact` for a glancing dent. |
| Shoe or bicycle in a puddle | Install `puddle-contacts` for a custom surface, or create one `road.contacts.contact('foot', 0.1)` per foot or `contact('wheel', 0.045)` per tire. Feed the world sole/tread point and contact velocity to `.sample(point, velocity, dt, enabled)`. Reset after teleport. [Water contact and optical inputs](specs/05-wet-road-aquaplaning.md) |
| Rain and reflections under a roof | Register the underside with `engine.world.shelters.add({ center, width, depth, yaw, groundY, underside })`. Roads, tires, rain, lens, thermal surfaces and world materials read its footprint. Keep the returned release function for unloading. [Shelter inputs](specs/05-wet-road-aquaplaning.md#rain-under-an-overpass) |
| Water squeezed out by moving tires | Use `TireSpray` with the Rapier coupe. For a bike or custom controller, install `wheel-sheets` and submit the free-surface contact point and two world ejection velocities per wet wheel. Pair it with `puddle-contacts` for slow ripples. |
| A muddy or wet wheel rolling onto clean ground | Install `tread-transfer` for Three.js. Use one contact per wheel, sample the local material and feed the retained groove water to both spray and prints. The road shades the deposited film and sediment in its existing lighting pass. [Inputs and update order](specs/05-wet-road-aquaplaning.md#water-and-soil-carried-by-tires) |
| Jet banking between air masses | Give `JetAero` local `relativeHumidity`, `airTemperatureC`, `iceHumidity` and optional world `windVelocity` in m/s. Mach uses wind-relative speed and local air temperature. Vapor drifts where the aircraft released it. [Flight inputs](specs/07-aero.md) |
| Native wet-road contact | Install `puddle-contacts` for the road shader and contact component. Godot accepts `disturb_puddle(worldPoint, widthM, speedMps)`, Unity accepts `DisturbPuddle(worldPoint, widthM, speedMps)`. Call once per sole entry or at distance-spaced wheel samples. |
| Burnout or drifting tire | Install `tire-smoke`. Feed `TireSmoke.updateWheel` actual load, tread slip speed, liquid fraction and world velocity every frame, including coasting. A wet contact cools the tread. |
| Any drivable surface | implement `VehicleSurface { puddleDepth, wetness, grip?, rollingDrag? }` (`WetRoad` and `DeformableGround` do) |
| Outdoor fires | `explosions.ignite(pos, size, seconds, { rainExposure: 0.25, followsWater: false })` starts a sheltered fire. Set full exposure outdoors or follow the surface for floating fuel. |
| Aircraft | `new JetAero(engine, fx, rig, ocean)`, `aero.setState({…})`, `rig.animate(dt, { throttle, afterburner, pitch, roll })`, `applyRotorWash(…)` |
| Explosions | `explosions.detonate({ kind, position, yield, surface? })`, `explosions.ignite(position, size, seconds)` |
| Cloth | `cloth.cutLine(a, b)` severs links across a segment. `cloth.flag / banner / sail / parachute / rope / powerLines({…})`, `piece.follow = object`, `piece.kick(v)`, `cloth.colliders.push({ center, radius })`, `cloth.groundY` |
| Destruction | `wreck.add({ material, size, position, pieces, anchor })`, `object.impact(point, dir, joules)`, `wreck.shoot(origin, dir, joules)`, `object.shatter()`, `object.onBreak` |
| Fire and heat | `wall = heat.addWall({ position, width, height, fuel })`, `heat.ignite3D(point, radius)`, `wall.shade(albedo, worldPos)`; `heat.addFuel / addFuelRect`, `.ignite(x, z, r)`, `.quench(x, z, r)`, `.heat(x, z, r, °C)`, `.isBurning(x, z)`, `.addBody({ object, kind: 'wood' \| 'metal' \| 'ice', material })`, `heat.surface(albedo, worldPos)` in a material |
| Sand / gravel / snow / mud | `new DeformableGround(engine, fx, { center, size, surfaceY, kind, follow?, extent? })`, `.track(id, x, z, radius, depth, signedSpeed, heading, lateralSpeed)`, `.stamp`, `.crater`, `.depthAt`, `.setKind` |
| Mechanical animation | `new RotorBlur({ radius, blades, chord })`, `Actuator`, `ControlSurfaces`, `NozzleAnimator`, `new ChassisAnimator(rig.body).update(dt, vehicle.acceleration)`, `new TireTracks(engine).lay(id, x, y, z, heading)` |
| Chase camera | `new CameraFeel(engine, { distance, height, stiffness, fovGain, bank })`, `.follow(object)`, `.update(dt, velocity, lateralAccel)` in `onBeforeRender`, `.impact(strength, hitstop)` |
| Particles | `fx.spray \| mist \| smoke \| fire \| sparks \| dust` `.emit({…})` / `.emitRate(key, perSecond, dt, {…})` |
| Refraction FX | `fx.shockwave(position, { speed, maxRadius, strength })`, `fx.heatHaze(position, radius)` |
| Wind | `engine.wind.sample(pos, t, out)`, `.node(posNode)`, `.addBlast(pos, strength, radius)`; with an `Ocean`, set the wind through `ocean.params.windSpeed / windDirection` |
| Blast coupling | `engine.physics.applyBlast(center, radius, impulse, upBias, kind)`, `physics.onBlast(listener)`, `physics.onContactForce(collider, newtons, listener)` |
| Trauma / flash | `engine.trauma.add(x)`, `.blast(distance, yield)`, `.rumble`, `engine.flash(color, intensity)` |
| First-use hitches | `engine.prewarm(object)` compiles a late-appearing effect's pipeline up front |

### Coupled world effects in v3

A `LuminaEngine` owns one `engine.world`. Ocean and inland water register their surfaces with it. Cloth, strands, particles, rain, vehicles and thermal surfaces consume the shared fields. Use `canopyBendNode(world,height,flexibility)` for rooted, instanced foliage. Rotor and blast waves feed both optical displacement and hull buoyancy.

| Situation | Module and entry point |
| --- | --- |
| Wind, local pressure, heat and wetness | `world-fields` · fill a reusable `WorldSource`, call `engine.world.publish(source)`, sample with `world.read(point,time,reading)` |
| Hover jet of air or cloud tunnel | `rotor-wash` · one `RotorWash` per helicopter, one `CloudTrail` per fast mover. `JetAero` includes a trail |
| Tornado entraining debris and vehicles on land and water | `weather-vortex` · `engine.add(new WeatherVortex(engine,fx,{ groundHeight }))`, then `start(x,z,dx,dz)` |
| Wading and spilled liquid | `street-fluid` · `FloodedStreet(engine,fx,weather,road,car)`, `setFlood`, `setLeak`, `ignite` |
| Leak on one side of a boat | `floodable-vessel` · supply compartment centres and displacement volumes, then call `damage(compartment,opening)` |
| Paint rubbed through on a prop or vehicle | Install `paint-wear` for a standard or physical Three.js node material. Feed a world contact, slide velocity and stroke dimensions. Pass a raycast’s `faceIndex` for a single-triangle lookup and `instanceId` on instanced meshes. Skinned and morphing props keep their marks through animation. The vehicle module also takes `attachTrim(mesh)` for liners, lamps and interior door cards. [Paint and impact inputs](specs/11-destruction.md) |
| Bent panels and broken glazing | `vehicle-damage` · wrap the render shell and a Rapier chassis with `VehicleDamage` |
| Living trunk and broken crown | `flexible-tree` · `FlexibleTree(engine,base,options)` |
| Character balance and flotation | `active-ragdoll` · `ActiveRagdoll(engine,origin)`, `stumble(impulse)` |

Read `specs/21-world-coupling.md` for units, contact rules, compact source lifetimes and native-engine field bindings.

## 6. Recipe and remix playbook

Recipes with game-ready source files accept the same install command. Try `recipe-inland-sediment` for a dry trail. For parameter blueprints, start from the listed modules and change numbers
before code. `node scripts/search.mjs --kind recipe` lists them with specs.

**GTA-style rainy street chase** (`recipe-gta-rainy-chase`)

```ts
Object.assign(weather.params, WEATHER_PRESETS.storm, { sunElevation: 12, exposure: 1.2 });
const road = engine.add(new WetRoad(engine, weather));   road.params.flood = 0.4;
engine.add(new Rain(engine, weather));                   // also wets the lens
const car = engine.add(new AquaplaningVehicle(engine, createSportsCoupe(), road));   car.targetSpeed = 34;
engine.add(new TireSpray(engine, fx, car, road));
const tracks = engine.add(new TireTracks(engine, { life: 5, color: 0x8f979c, opacity: 0.16 }));
const body = new ChassisAnimator(car.rig.body);
const cam = new CameraFeel(engine, { distance: 8.4, height: 2.5, stiffness: 1.6, fovGain: 13, bank: 0.5 });
cam.follow(car.root);                                    // road.brake = car.brakeLight each frame
```

Add `wreck.add({ material: 'glass' … })` shop fronts and brick corners; the car breaks them
by contact force. Above 0.75 V_p (94 km/h at 220 kPa) in more than 3 mm of water it floats.

**Fighter jet over a hurricane ocean** (`recipe-jet-hurricane`): `WEATHER_PRESETS.hurricane`
with `shafts: 0.8`; `ocean.setSeaStates(OCEAN_PRESETS.storm, OCEAN_PRESETS.hurricane)`,
`morph` 0.35–0.8; `new JetAero(engine, fx, createJetRig('su57'), ocean)` on a pass at
26 m and Mach 1.12 (trough, rooster tail, vapour cone, boom); `Lightning.rate` 14;
`rig.animate(dt, { throttle, afterburner, roll, pitch })`; `CameraFeel` at distance 38,
stiffness 0.9. The rooster tail splashes the lens on its own. Ultra holds 60 fps at 1080p;
enable dynamic resolution above that.

**Cozy sunlit island with flags and a shallow lagoon** (`recipe-cozy-island`):
`WEATHER_PRESETS.tropical` (sun 40–55°, coverage 0.4); `new Bathymetry({ size: 1500, height:
lagoonIsland() })`; `OCEAN_PRESETS.lagoon`, `optics.clarity` 0.95, `breakerHeight` 0.3;
`cloth.flag` / `cloth.banner({ hang: 'corners' })` bunting / `cloth.sail` in 5–8 m/s wind,
`cloth.rope({ slack: 1.18 })` moorings; `new Underwater(engine, ocean)` for snorkelling;
`BuoyantBody` boats. Runs on Low (single-pass water).

**Warehouse collapse with spreading fire and steam** (`recipe-warehouse-firefight`)

Anchor breakable glass to its frame and leave stacked timber free to fall. Connect
`heat.addFuelRect` to the pallet footprint and use `heat.addBody({ kind: 'wood' })` on
crates at different heights. Place a staged visual burst at the impact point. The hot
fuel film persists on surrounding surfaces. Set `heat.rain` for sprinkler cooling and
steam, and call `cam.impact(0.5, true)` for the initial camera response.

**Snowy rally race** (`recipe-snowy-rally`): `new DeformableGround(engine, fx, { kind:
'snow', size: 48, follow: car.root, … })` passed to `AquaplaningVehicle` as its surface
(grip 0.42, 25 % more in an existing rut); each frame `ground.track('w' + i, x, z, 0.2, 0.9,
speed, car.forward)` per wheel in contact; `ChassisAnimator`, `CameraFeel` with `bank` 0.6;
overcast weather with visibility 6 km; snowfall from `recipe-snowstorm`; finish-line
`cloth.banner`. Swap `'snow'` for `'sand'` (dunes, dust) or `'mud'` (glossy ruts).

More remixes (same shared fields: wind, water surface, rigid bodies, heat):

| Target | Start from | Change |
| --- | --- | --- |
| Lava | `ocean` + `thermo` | wind 1.5, chop 0.2, field damping 3; body colour = `blackbody(1 − crust)`; `heat.heat` along the flow ignites what it touches |
| Snowstorm | `rain` | fall 0.8–2.2 m/s, streak length 0.02, soft 6–12 mm discs, sideways wobble; `mist` spindrift; turbidity 6 |
| River rapids | `ocean` + `Bathymetry` | bed as the depth map, fetch 300 m; advect foam along a flow map; `flowAt()` carries rafts |
| Surf break / tidal bore | `tsunami` | barrel: height 4–8, speed 9–11, breaking 1; bore: width/height > 4, breaking 0.2 |
| Sandstorm | `dust` + `weather` | turbidity 10, visibility 800 m; `DeformableGround('sand')` for tracks |
| Burning building | `destruction` + `thermo` | timber as fuel + `wood` bodies; `body.onSpent = () => object.shatter()` |
| Sailing boat | `cloth.sail` + `buoyancy` | `piece.follow = hull`; drive the hull with the sail's wind load |
| Wrecking ball | `cloth.rope` + Rapier ball | ball on a rope end; walls break by contact force |
| Helicopter | `RotorBlur` + `applyRotorWash` | blur disc on the hub; wash on water, cloth and dust |

When writing new TSL: share one function between shader and CPU when gameplay must match
visuals (`Tsunami.deform` / `heightAt`, `WetRoad.puddleDepth`); use `frame.time`,
`frame.sunDirection`, `frame.sunColor`, `frame.skyZenith / skyHorizon`; displaced geometry
needs `material.mrtNode = auxSurface(normalView, screenVelocity(P, Pprev))`, blended sprites
`auxPassthrough()`; albedos are linear reflectance (dry sand 0.35, concrete 0.25). Port to
Godot / Unity from the spec, not from TSL.

[Environment upgrade plan and verification shots](specs/23-environment-upgrade-plan.md)

## 7. Circumstance tuning

| Circumstance | Weather | Surface | Extras |
| --- | --- | --- | --- |
| Tranquil turquoise lagoon | `tropical`, sun 45–60° | `lagoon`, clarity 0.95, bathymetry 2–5 m over pale sand | caustics need depth < 12 m and a high sun |
| Open-ocean swell | `overcastSwell` | `swell`: wind 11, swell 3.2 m @ 13 s | buoyancy `keel` 4–6 |
| Hurricane sea | `hurricane`, exposure 1.3–1.5 | `hurricane`: wind 33, swell 8.5 m, foam 0.85 | `Rain`, lightning 10–15 /min, rumble 0.25 |
| Breaking tsunami | low sun backlights the lip | height 18–40, width ≈ 22 + 1.05·height, breaking 0.75–0.9 | launch 350–450 m out |
| Storm highway | `storm` | `flood` 0.5–0.8, `wetness` 1 | lens rain, tire tracks, brake pool |
| Low jet pass | humidity 0.7–1 | any sea | altitude 10–40 m, Mach 0.95–1.15 |
| Flags in a gale | wind 15–25 m/s | – | `flutter` 1, `dragNormal` 6.5; raise `stiffness` if it looks rubbery |
| Shop-window impact | – | – | Anchor the frame and let the glazing progress from stress cracks to detached shards. |
| Deck fire | wind 6–10 m/s | fuel 3 kg/m² timber | front runs 0.1–0.3 m/s downwind; rain 1 or a hose puts it out |
| Beach driving | sun 30–40° (raking light shows ruts) | `sand`, depth 0.09 | patch 40–50 m for 8 cm texels on High |
| Diving | sun > 35° for strong rays | clarity 0.8–0.95 | look up for Snell's window; `rays` 1–1.5 |

Rules that hold everywhere: wave size comes from wind, fetch and swell (never mesh scale);
water colour comes from depth and clarity (never a tint); foam, steam, dust and debris are
consequences of events; exposure ≈ 0.5 at midday, 0.85 at golden hour, 1.1–1.5 under storm
decks; yield scales radius linearly; impact energy is ½mv² in joules.

## 8. Verify

```sh
npm install && npm run preview     # eight scenes (keys 1–8), tier switcher ([ ]), HUD with frame bar
npm run typecheck
npm run qa                         # Playwright, headless Chromium with a real GPU (≈ 15 min)
python3 scripts/lint-adapters.py   # GDScript, GDShader, C# and embedded HLSL checks
```

| Suite | Checks |
| --- | --- |
| `showcase` | all eight scenes on WebGPU and WebGL 2: zero console / shader errors, physics invariants, captures screened for blank or "plastic" frames |
| `v2-modules` | blast buttons, wall ignition and cooling, GPU buffer readback and CPU deformation, cloth cuts and river current |
| `allocation` | sampled project allocations divided by rendered engine frames on the source dev server |
| `qa/grade.mjs` | Neon reviews actual 1920×1080 WebGPU PNGs and records scores, evidence and image hashes |
| `interaction` | real pointer clicks on every tab, tier button, slider and toggle; orbit; hotkeys |
| `motion` | per-frame step jitter of physics-driven objects at real time and half speed |
| `modules` | dive / waterline split, wet lens, CPU and GPU cloth, parachute, fracture volume and mass, glass, fire spread, steam, ruts, braking, rotor blur, nozzles |
| `telemetry` | JS time, draw calls, triangles and GPU headroom on all five tiers; dynamic resolution |
| `performance` | all 80 scene/tier/backend combinations at 1920×1080, plus large canvases |

Dev helpers: `qa/shot.mjs`, `qa/seq.mjs` (timed captures after a trigger), `qa/eval.mjs`,
`qa/perf-probe.mjs`, `qa/drs-trace.mjs`, `qa/spike-probe.mjs` (GPU cost of one effect with
layers hidden), `qa/alloc-profile.mjs` (allocations by source file).

Look at the captures. Reject and fix:

| Symptom | Cause → fix |
| --- | --- |
| Smooth jelly water | finest cascade too coarse → more cascades / higher tier |
| White horizon band | grazing Fresnel on rough sea → keep the variance correction |
| Sparkling far waves or puddles | specular aliasing → `specularAA` on the lobe |
| Dark rectangles around sprites | MRT attachments not blended → pitfall 1 |
| GPU time doubles during one effect | sprite overdraw → put the pool in the soft layer, cap it |
| Whole frame under water at the waterline | effect assumed a texture row order → use `ndc` |
| Rubbery flag | stretch → add long-range tethers, more iterations |
| Fire ignores rain | boil-off faster than supply → keep the finite boil-off rate |
| Glowing white ground | emissive not masked / albedo given in sRGB → mask by cracks, use linear |

## 9. Pitfalls (each cost real debugging time)

1. **MRT + blending.** Auxiliary attachments default to no blending: call
   `mrt.setBlendMode(name, new BlendMode(MaterialBlending))` for `normal` and `velocity`.
2. **Rapier keeps user torques.** Call `resetForces(true)` **and** `resetTorques(true)`
   every step; prefer impulses for per-step forces on pooled bodies.
3. **`smoothstep(a, b, x)` with `a > b` is undefined** in GLSL/WGSL. The TSL shim makes it
   safe in shaders; on the CPU write `1 - smoothstep(x, lo, hi)`.
4. **Refraction of transparents** needs `viewportTexture`; the shared opaque copy has no water.
5. **Quad passes address textures top-down on WebGPU, bottom-up on WebGL 2 targets.**
   Sampling with `uv()` is consistent, deriving a screen position from it is not: use the
   `ndc` / `toNdc` / `toUv` the pipeline hands to effects.
6. **Never render a physics body from its raw 60 Hz state.** `physics.bind` it and read the
   interpolated `Object3D`; place cameras in `onBeforeRender`.
7. **Large soft sprites are fill-rate, not vertex, cost.** Half-resolution single-target
   layer, baked noise instead of per-fragment hashing, capped pools.
8. **Vsync hides headroom.** Frame pacing says 60 fps until the GPU saturates; steer by GPU
   time. Timestamp-query sums are not frame time on tile-based GPUs.
9. **`Ocean.update` owns the wind field.** Set wind through the sea-state parameters.
10. **A material created per effect instance recompiles per instance.** Share one material
    and vary it with `userData(...)` nodes or a data texture (chunk matrices, cloth).
11. **Profile numeric boxing as well as object creation.** Batch hull samples into preallocated
    typed arrays. Measure project and library allocations separately with GC-inclusive sampling.
12. **Jacobi needs under-relaxation** (sum of constraint weights ≤ 1) and an odd pass count
    when ping-ponging two buffers.
13. **Voronoi cut faces are shared objects.** Clone points that end up in two faces before
    transforming them.
14. **Explicit diffusion on a grid is unstable** once the eight neighbour weights sum past 1.
15. **Full-screen UI wrappers must not take pointer events**; test with real clicks.
16. **Compute needs WebGPU.** On WebGL 2 the CPU twins run the ocean (2–3 cascades ≤ 64²)
    and the cloth (0.6× grids, one substep).

Use `const off = engine.events.on('explosion', (event) => { /* use event.position, kind, intensity */ });`. Call `off()` when disposing the subscriber.
