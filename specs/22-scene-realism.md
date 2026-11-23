# Outdoor scene realism

## Choose by shot

These settings target the Three.js renderer. The existing Godot and Unity adapters cover a subset of the modules. Treat their visual parity as a separate test.

| Scene intent | Starting point | What to look for |
| --- | --- | --- |
| Caribbean midday, seen from a cockpit | Weather with `tradeCumulus`, a lagoon ocean and the same sun direction for both. Place some shoals in the view. | From the carrier deck, gaps of blue divide shallow cloud fragments and taller banks. From above, the sun-facing crowns and shadowed bases give the banks depth. Shallows reveal the seabed while deeper water reflects the sky. |
| Hazy coastal sunset | Start with `coastalHaze`. Lock exposure while tuning sun elevation and turbidity. | Track the solar halo through thin and thick cloud. Rotate the camera over the ocean and check that glints follow the reflected sun direction. |
| Jet climbing through layers | Pass local `airTemperatureC` and `iceHumidity` in the aero state when available. Ice humidity is a ratio. Treat the optional formation model as a visual approximation. | Compare a warm sea-level pass with cold humid cruise. Watch previously emitted segments drift after the aircraft leaves favorable air. Wing condensation, a transonic cone and exhaust ice have different triggers. |
| Car crossing damp asphalt and a puddle | Feed actual wheel contacts, surface depth and vehicle velocity to TireSpray. Set road roughness from the material. | At idle the car emits no sustained road spray. At speed a single wheel entering standing water starts a local fan. The diffuse wake builds behind it. Inspect reflections both near the camera and at the screen edge. |
| Interior or sky-free scene | Use only the needed modules. Leave cloud preloading disabled. | Time opening the scene from a fresh tab. Its loading budget should go to assets visible in the first shot. |
| High-altitude flight over a broken deck | Set `cloudBase` and `cloudTop` in world metres. Adjust `convection` toward +1 for developed cells or −1 for a shallow bank, then put the aircraft above the top. | A nearby wing stays clear. Look down through gaps for terrain and water, then fly below the base to inspect the same formations from underneath. |
| Ebb tide on sand | Set the tide amplitude and period on the ocean and `shoreDryingSeconds` on the bathymetry. Choose swell separately from the tide. | Water retreats first, leaving darker exposed sand that dries over time. A still, sheltered pool has no moving wave caustics. |
| Afterburner cut in a banked turn | Mount one exhaust at each nozzle exit. Before the engine updates, pass the flight controller's pose, velocity, signed load and throttle to `aero.setState(state)`. Sample humidity at the wing and drive the rig's nozzle glow from core heat. | From behind, the plume fades quickly after a cut and the recessed metal cools more slowly. From the side, humid wingtip vapor curves away with the released wake. [Aircraft rig and atmosphere inputs](07-aero.md) |
| Drive from golden hour into night | For a continuous clock, call `setSolarTime(weather.params, clock)` and supply the host's moon direction. For an art-directed transition, blend the numeric `goldenHour`, `blueHour` and `clearNight` parameters. With `weather.morph`, use the per-frame weight `-Math.expm1(-dt / seconds)` for a time constant of `seconds > 0`. | Keep one camera looking over the same puddle and another at a tall cloud bank. The reflected opening cools as the sun sets. At twilight the upper bank can still receive direct light. [Sun and moon lighting](06-atmosphere-clouds-lightning.md) |
| Drive into a garage or under a bridge | Register the visible roof's underside and query tire contacts at each wheel. Supply the pool level separately from the rain film. Place the probe in open air beneath the roof and enable its capture layer on the nearby wall and pillars. | A dry lane can sit next to a reflective pool under the same roof. In a crosswind the exposed wet edge moves. [Shelter and surface queries](05-wet-road-aquaplaning.md#rain-under-an-overpass) |
| A car brushes a wall in a driving game | Send the game's world contact point, normal, relative sliding velocity and 0–1 intensity to `VehicleDamage.impact`. On a chip-capable wall, call `markSurface(point, radiusM)` once per visible contact mark. | A sliding contact leaves a shallow, directional scrape on the moving door. The wall retains a separate mark at the contact. [Surface marks and vehicle damage](11-destruction.md) |

## Compose a world from the installed skill

Install `outdoor-world` to use the same entry point in a game or in an agent-authored scene. A sheltered intertidal beach with a broken upper deck can be set up in one call.

```ts
import { Bathymetry, CLIMATES, CLOUD_LAYERS, createLuminaWorld } from './lumina-physics';

const bed = new Bathymetry({ size: 512, height: (x, z) => -0.025 * x + 0.15 * Math.sin(z / 24) });
const { engine, ocean, weather } = await createLuminaWorld({
  canvas, climate: CLIMATES.humidCoast, weather: 'hotFair',
  upperClouds: { ...CLOUD_LAYERS.highBank, coverage: 0.35, windZ: -12 },
  ocean: 'still', bathymetry: bed, tide: { amplitude: 1.2, periodSeconds: 44700 },
});
engine.camera.position.set(24, 4, 20);
engine.camera.lookAt(0, 0, 0);
engine.start();
```

Keep the same bed and tide to show the next day's storm. Apply `WEATHER_PRESETS.storm` to `weather.params`, set `engine.world.setClimate(CLIMATES.coldFront)`, then set `ocean.setSeaStates(OCEAN_PRESETS.still, OCEAN_PRESETS.storm)` and animate `ocean.morph` from 0 to 1. Set `ocean.optics.breakerHeight` for the exposed beach. For an inland scene, pass `ocean: false`. [Water and tide](03-shoaling-tsunami.md) · [Cloud layers](06-atmosphere-clouds-lightning.md) · [Climate](21-world-coupling.md)

## Reflections at the edge of the screen

For a moored hull or a building beside a wet road, enable a `localProbe` in the Weather constructor or `createLuminaWorld`. Give it a world-space `center`, positive `halfSize` and a dedicated Three.js `layer` from 1 to 31. Enable that layer on the opaque mesh children to capture and any extra lights that illuminate them. Keep the probe centre in open air, outside the hull or building, and fit the box to the area where the reflection should appear. The pier scene uses layer 24.

When a game enables the probe only near a reflective room or bridge, wait for `weather.localProbe.prepare(engine.renderer, engine.scene)` after adding capture meshes and lights, while rendering is stopped. The showcase prepares these capture materials with its loading screen visible. This avoids synchronous WebGL shader compilation when a player first crosses the activation boundary.

The probe captures one cubemap face per update at most. A complete six-face snapshot replaces the previous one. `resolution` is a power of two from 16–256 (default 64); `refreshSeconds` is the desired interval for an entire sweep (default 0.6). Reduce the interval for moving objects. Geometry reflects with box parallax; the weather sky fills empty directions. Roughness selects a filtered mip and screen-space hits blend over it. On 16-sampler WebGL 2 ocean materials the finest normal band yields its texture slot to the local probe and analytic capillaries cover the short ripples.

## Cold start and frame budget

For outdoor scenes pass `preloadClouds: true` to `LuminaEngine.create`. Cloud texture generation yields between slices while the renderer initializes. Weather still supports synchronous construction. Reuse the first physics world. Display the loading UI before constructing the scene and stage expensive entities across frames once the camera is live.

Measure a fresh page and a repeat visit separately. Record time to first input, time to the fourth rendered frame, longest main-thread task and frame-time p95 during play. Use the same viewport, tier, renderer and flight path for comparisons. At 60 Hz a frame has 16.7 ms. Record dynamic render scale alongside frame time so a smoother run can be interpreted correctly.

## Next realism pass

Use the same camera paths, sun position and random seeds for before-and-after captures. Record the tier and internal render scale with every 1080p result.

| Priority | Upgrade | Replay and acceptance |
| --- | --- | --- |
| 1. Tires on mixed surfaces | Use WetRoad for asphalt and separate DeformableGround patches for gravel or mud. Tune the transition where wheels cross a material boundary. | Drive through a puddle with the left wheels, reverse through it, then cross onto gravel at half speed. Check which tread throws each fan, where drops land and how the mist clears after the tires reach dry ground. |
| 2. Cloud depth in motion | Refine lighting inside broken cumulus and thick rain banks. Tune forward scattering and history rejection against a fixed flight so the exit from cloud retains a visible silhouette. | Fly below, between and above the decks at noon and low sun. Compare edge stability through a camera cut and verify the gap stays clear on both renderers. |
| 3. Sun and reflections | Tune the transition between screen-space hits, local geometry and reflected sky on rough asphalt and open water. Use separate roughness and wave settings for each surface. | Orbit a wet runway marker and a moored hull from daylight into sunset. Track the hull as it crosses the screen edge and the solar glint as the water turns from still to choppy. |
| 4. Weather across the scene | Match the spatial timing of a moving gust in grass, tree canopies and a hanging flag. Expose inertia and recovery by material. | Follow a single gust across the scene from a locked camera. Check that motion travels with the wind and that each material settles at a different rate. |
| 5. Impacts and heat | Carry the struck material and contact energy through debris shape, dust, wetting and cooling. | Replay the same game impact on wet concrete and dry timber. Compare first contact, debris silhouettes, settling, dust and steam from near and far cameras. |
| 6. First play on a fresh install | Profile cloud-noise preparation, renderer startup, pipeline compilation and scene construction separately. Exercise the selective installer from an empty game. | Record first input, fourth frame, longest main-thread task and frame-time p95 on a cold page and a repeat visit. Compare both renderers on the same device. |

## Rendering references

Rockstar describes how RDR2 ties sky, fog and clouds to lighting. Guerrilla describes authoring structure across an entire cloudscape. Both inform the shared light direction and regional formations here. [Rockstar, Creating the Atmospheric World of Red Dead Redemption 2](https://advances.realtimerendering.com/s2019/) · [Guerrilla, Nubis](https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine)

Playground describes photographing real skies to illuminate Forza Horizon 5. Use the same clear-to-overcast sequence to judge the sky and the reflected scene. GTA VI trailer footage supplies a coastal visual reference; it does not establish the implementation. [Xbox, Forza Horizon 5](https://news.xbox.com/en-us/2021/06/13/forza-horizon-5-experience-our-largest-most-diverse-open-world-ever/) · [Rockstar, GTA VI Trailer 2](https://www.youtube.com/watch?v=VQRLujxTm3c)

Flight-level temperature and moisture affect contrail formation and persistence. The optional weather inputs give games an inexpensive approximation suitable for changing air masses. [FAA, Contrails](https://www.faa.gov/contrails)
