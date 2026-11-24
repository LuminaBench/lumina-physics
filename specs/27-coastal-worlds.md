# Authoring a coast

For a new scene install `coastal-world`. For a game with a terrain, camera, lights, bridge or renderer of its own, install `coastal-contacts`. The latter has no render loop and creates no scene objects. Its terrain callback returns world elevation in metres. Install `weather-front` to add local precipitation. [Four game-owned recipes](../examples/coast/recipes.ts)

```sh
node scripts/install-physics.mjs --engine threejs coastal-world coastal-habitat --project /absolute/game
node scripts/install-physics.mjs --engine threejs coastal-contacts weather-front --project /absolute/host
```

```ts
import {createCoastalWorld, SANDS, CoastalHabitat} from './lumina-physics';
const world = await createCoastalWorld({
  canvas, coast: {seed: 87, sand: {...SANDS.basalt, grainMm: .63}, relief: 'lava'},
  front: {type: 'marine', seed: 29, heading: .4, windSpeed: 6}, period: 9,
  clock: {latitudeDeg: 62, dayOfYear: 190, solarHour: 20}, strength: .48,
});
const plants = world.engine.add(new CoastalHabitat(world, {reedHeight: 1.9, duneDensity: .43}, 109));
world.engine.camera.position.set(8, 2, 4);
world.engine.camera.lookAt(-6, .15, 0);
await world.prepare();
world.engine.start();
```

## Land, water and contacts

| Control | Meaning |
| --- | --- |
| `shoreline` | At least two distinct XZ points in metres. Forward travel has land on the right. Three or more points describe a centripetal spline. `point(along,cross)` gives an authored spawn. `project(x,z)` reports signed distance, shelter, brackish influence and landform. |
| `heightAt`, `terrain`, `protectedAt` | Supply host elevation, a triangle height grid, or exclusion geometry. A protected column keeps underlying sand unedited. Use `deckAt(x,y,z)` on a stacked bridge when the sand below it should remain independently reachable. |
| `SANDS` | Quartz, shell, basalt and ochre. Copy and override grain diameter in mm, angularity and packing in [0,1], three mineral colours and drainage seconds. Sand colour, relief, roughness, contact depth and film use the selected recipe. |
| `CoastalSurf` | The four atlas channels describe crest phase, secondary phase, exposure gain and minimum connected spill elevation. An offshore-seeded priority flood finds which routes clear a sill. Grid pitch is extent divided by resolution minus one. Use a sufficiently dense local atlas for narrow barriers. |
| `pools` | Rock basins defined by a fractional distance along the shoreline, cross-shore centre and radius in metres, floor and lip elevations in world metres. The volcanic recipe cuts a shallow bowl into the rendered terrain. The resolved spill elevation also controls retained water after retreat. |
| `barrierAt` | Height of a continuous rock or wall in metres, or negative infinity in open ground. Supply the same function to both the surf and the sediment. A roof over open water is a shelter, not a submerged barrier. |
| `strength`, `period`, tide | Wave amplitude in metres and swash cycle in seconds. Long tide amplitude, period and phase are independent. Ground contact, vertex displacement and water optics share the wave model. |
| `imprint(kind,x,z,yaw,width,length,load,slip)` | One shoe or wheel contact in metres. Yaw is radians from +Z to +X, load is normalized and steering slip is signed. Heel/toe, tread and displaced rims are sampled every 4 cm. |
| `sediment.inspect(x,z,out)` | Ground elevation and relief in metres, compaction, standing water depth, wet film, suspended sediment and last wetting source. Supply reusable output in a hot loop. |
| `save()`, `restore(save)` | Versioned, seed-checked edited tiles. The active solver updates neighbouring tiles at 12 Hz. The default 384-tile resident limit favours edited tiles for revisit. At capacity the oldest eligible edited tile can be evicted. Save before travelling farther when a game needs permanent history. |
| `ImmersionFilm` | Install `immersion-film`. Create one band per boot, door, sleeve or hull region. Feed submersion depth in metres and real delta time; the shader samples the same receding film and absorbed moisture. `shedding` is the available drainage rate for a host drip emitter. |

## Existing level and layered roads

```ts
import {CoastalAttachment, WeatherFront, SANDS, TSL} from './lumina-physics';
const front = new WeatherFront({type:'towers', seed:31, origin:[180,0], heading:0});
const coast = new CoastalAttachment({
  coast:{seed:87, shoreline:[[0,-400],[8,20],[-12,400]], sand:SANDS.basalt},
  surf:{size:800, resolution:257, period:8},
  heightAt:(x,z)=>host.terrain.heightAt(x,z),
  deckAt:(x,y,z)=>host.bridge.contactAt(x,y,z), // {id,water,film,soil} or undefined
  rainAt:(x,z)=>front.sample(x,z,host.seconds).rain
});
const wheels = [0,1,2,3].map(()=>coast.wheel(.23));
const bridgeTracks = coast.trackNode('bridge', TSL.positionWorld.xz);
function fixedUpdate(dt) {
  coast.update(dt,host.player.x,host.player.z,host.tide,.48);
  for (const [i,p] of host.wheelContacts.entries())
    wheels[i].sample(p.x,p.y,p.z,dt,p.rollingSpeed,p.load,p.yaw,p.slip);
}
```

A deck reports water in metres, film and soil in [0,1]. Choose the deck from the game's actual contact height or collider. Use the returned track node R channel for film, G for deposited soil and B for cleared film on that deck's material. Use one contact handle per wheel. Sample an unloaded wheel with zero load. Keep player position, road ID, world seed and the sediment save in the game save. Give `retainAt(tileCenterX,tileCenterZ)` the game’s landmark mask to preferentially retain its edited tiles during travel. The cache evicts untouched tiles first, then ordinary edits by age, then landmark edits if the budget is exceeded. Call `dispose()` on unloading. Each attachment supports up to eight named contact surfaces including ground.

## Weather, plants and light

`WeatherFront` accepts streets, marine, towers, squall and clearing. It bakes a deterministic periodic map. The map moves down the supplied heading; upper clouds have independent advection. `span` is the map repeat distance in metres, `origin` shifts its centre and `windSpeed` is m/s. The returned `weather` and `upperClouds` configure the layer geometry and lighting. Pass `distribution:front` into Weather, use its `sample(x,z,seconds)` for ground rain and use `engine.world.region=front` before constructing wind-sensitive shaders. `world.setClock()` leaves geography and contact history intact. The coastal example uses a local rain gauge for each query and a separate camera gauge for rain on the lens.

Use `CoastalHabitat` for marram, reeds, shells, wrack and roots. Give it a distinct seed and override the heights, densities and colours in game-owned code. Its site comes from the same shoreline and barrier exclusions as the sand. For custom leaves and flowers, combine the habitat reading with the growth callbacks in [land authoring](26-land-authoring.md).

The [promenade](../examples/coast/promenade.ts) adds an off-screen geometry probe, an open-sided pier, warm ground bounce and cool sky fill. `addOpenShade` accepts world-space centre, half sizes and the direction of open sky. `CoastalHeadlamps` supports two independently moving beams for existing aerosol and spray particles. The [vehicle route](../showcase/coast-vehicles.ts) demonstrates a pressured tire, transferred sediment and a passing light.

The **Art direction** selector changes sky, water, cloud shading, foliage and grading in the active game. Use `world.setLook('natural-daylight' | 'painterly' | 'neon-night')` or pass a game-owned copy of an entry from the look library. Tide range changes wave reach independently. The inspector samples the last water source, current regional shower and integrated condensate along the ray to the sun. On the driving route it also reports the front-left contact depth and retained film in millimetres.

On the limestone cay, **Skiff** follows a four-point buoyant dinghy. W/S controls the motor and A/D turns the hull. Propeller wash stirs a bounded patch only in shallow water. Ocean colour and retained pools sample that concentration while local flow transports it and quiet water clears. See the [game-owned skiff](../examples/coast/skiff.ts).

The independent [Salt Crossing game](../examples/salt-crossing/README.md) uses host-owned bridge, terrain and camera, two gauges and an editable reed. A smaller inland fixture in `qa/coastal-process.spec.ts` reuses the contact attachment on a dry ochre track and raised deck at a sea level of −20 m.

## Engine coverage

Three.js WebGPU and WebGL 2 share the reference surface, contacts, weather map and shaders. Godot 4 and Unity starters expose the local wave-offset formula and exponential drying. Supply the four atlas channels and depth from the game. The native starters do not build the terrain, flood atlas, fine sediment grid or showcase scene.
