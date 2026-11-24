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

On the limestone cay, **Skiff** follows a four-point buoyant dinghy. Set **Load** from 0 to 120 kg and shift it up to 0.42 m to either side. The same mass and centre of gravity drive Rapier, draft and heel. Its hull material samples the sea at four stations for the wet band. Bow and stern disturbances use hull speed relative to the sampled current. Set `ocean.surfaceCurrent(x,z,tideRate,out)` on a game-owned ocean to move floating bodies in a local current. W/S controls the motor and A/D turns the hull. Propeller wash stirs a bounded patch only in shallow water. Ocean colour and retained pools sample that concentration while local flow transports it and quiet water clears. See the [game-owned skiff](../examples/coast/skiff.ts).

The independent [Salt Crossing game](../examples/salt-crossing/README.md) uses host-owned bridge, terrain and camera, two gauges and an editable reed. For an inland game, install `recipe-inland-sediment`. Pick river silt, red dirt or gravel for the same host-owned terrain and contact layers. Pass the local river stage, or a water level below the terrain and zero waves for a dry track. [Editable inland materials](../examples/coast/inland-track.ts)

In a game-owned sand recipe, `paleFraction` and `heavyFraction` control the areal fractions of pale grains and dense minerals. Both are in the range 0–1 and their sum is at most one. Unresolved grains average through the texture mip chain. Wind and swell each orient their own bedforms.

Set `exposureResponse: { brightenSceneSeconds: 0.95, darkenSceneSeconds: 0.24 }` on a coastal world for gradual underpass exposure. Leave it out for fixed-exposure comparisons. The regional upper deck accepts an along-front `upperWindSpeed` and a signed `upperCrosswind` in m/s. Its cloud texture and its weather footprint use the same velocity.

For an obstacle smaller than a terrain tile, pass `detail: { x, z, size, resolution }` and the same `barrierAt` used for its visible shape. Coordinates and size are metres. The local flood map inherits the surrounding water head at its perimeter and blends into the coarse map. The Atlantic footprint has a 2.8 m window with 81 samples per axis. A stone beside the sole shelters the portion downstream. [Game-owned rock](../examples/coast/print-rock.ts)

For narrow shoreline hollows, set `coast.runnelDepth` in metres and `gridFocus: {width: 112, segments: 144}` on the coastal world. With 256 total terrain segments over 2200 m, the inner 112 m uses 0.78 m cells. The remaining cells span the outer shore. The visible bed, depth queries and terrain collider share these triangles. Detail outside the focus becomes coarser. The swash atlas has its own resolution; give narrow tidal channels a local `detail` region covering their connection to the sea.

With `front.lifeSeconds` between 20 and 86400, lower cloud groups grow and evaporate as they move with the lower wind. The upper layer drifts at its own heading and evolves more slowly. Omit the lifetime to keep the original steady formations.

## Roof runoff and street drainage

Install `street-drainage` for a game-owned roof and road. Construct `StreetDrainage` with a rectangular street in world metres, `columns`, `rows`, `ground(x,z)` and optional `initialDepth(x,z)`. The finite-volume cells cover the rectangle. Author a surveyed crossfall or hollow wherever standing water should collect. Four-neighbour flow follows the local water surface. The perimeter acts as a curb. Set each grate's position and capacity in L/s and use `setGrate(index,clearFraction)` to obstruct it.

Supply `roof: {area, seconds, outletX, outletZ}` and call `update(dt,rainMmHour,evaporationMmHour)` in seconds. Incoming rain collects across the surveyed area and the roof. The roof supplies its own delayed downspout flow to the outlet cell. Read `budget` for litres in storage, collected rain, evaporation and sewer outflow. Sample `depthAt(x,z)` for each wheel and `depthNode(worldXZ)` for its road material. Both return metres. The WebGPU and WebGL 2 reference uses a half-float depth texture. `save()` and `restore(snapshot)` preserve water, grate settings and the partial simulation step for the same surveyed catchment. Call `dispose()` when unloading it.

On **Rain-cleared boulevard**, turn on **Street shower**, block the grate and inspect roof litres and downspout L/s. Clear the shower, then open the grate. The first lit building supplies the curb outlet. Outside this short surveyed road segment, the showcase uses its existing regional surface film.

## Loose dune sand

Install `mobile-dune` for a host-owned land surface or pass `dune` to a coastal world. Supply a centre, side length in metres, seed, vertex resolution and `thicknessAt(x,z)` in metres above the compact terrain. The edge ring joins the static ground. `rootsAt` gives a stabilising fraction and `protectedAt` excludes a road or other host structure. Author a gentle falloff towards the perimeter. The headland example has an 8.4 m patch at 97 × 97 resolution.

Call `cut(x,z,length,width,yaw,depth,offsetX,offsetZ)` to move a strip to its spoil bank. Yaw runs from +Z toward +X in radians. The return value is transferred bulk volume in cubic metres. `update(dt,windX,windZ,damp)` takes seconds, m/s and a moisture fraction. Dry sand above the repose slope slumps, damp or rooted sand holds a steeper face and an upstream obstruction reduces the local wind transport. An edge or protected cell cannot receive spoil. The model uses a fixed 12 Hz exchange.

The coastal world samples the changed height for walking, water depth, footprint wetting and the Rapier terrain collider. The exposed compact layer uses the sand recipe’s heavy and pale minerals. Select **Cut dune** to reach the example face. Store `world.dune.save()` beside `world.sediment.save()`; pass the former to `duneSave` when re-entering the same authored patch. `MobileDune.depthAt` returns the loose thickness. `volume()` measures the whole layer.

## Wet streets beside lit rooms

For a standard or physical Three.js node material, assign `material.envNode = weather.materialEnvironment()`. The weather environment reads each material lobe's world direction and roughness. Inside a configured local probe it adds opaque, box-projected objects to sky radiance. Put the room and its frame on the capture layer. Keep the reflecting road on the main layer. Place the projection boundary at the façade and the capture origin near the height of the windows.

The boulevard example has thirty independently dimmable rooms. `road.shops.setPower(index,value)` accepts a zero-based window index and brightness from 0 to 1. Their interiors brighten as solar elevation falls from +3° to −4°. Street fixtures have their own daylight response. Ripples from actual wheel or sole contacts deflect the standing-water clearcoat. The sloping pavement and vehicle collision mesh share their surveyed heights.

## Terrain-hidden sun and local air

For a coast below a ridge, set `horizon: { resolution: 97, reach: 1100 }`. The optional cache samples the game terrain in metres. It projects the upper and lower solar limbs across each receiver column and interpolates their shadow elevations. Standard materials and the ocean query at their own XYZ. The lens queries at the camera. Skylight is independent of the ridge. Outside the mapped area the terrain contribution is fully open. Geometry finer than a grid interval belongs in the near shadow map.

Install `terrain-horizon` independently for a host-owned weather rig. Call `update(directionToSun)` with a unit world vector before querying `visibilityAt(x,y,z)` or its shader twin `visibilityNode(position)`. The static terrain is sampled at construction. Call `dispose()` at unload. The headland recipe uses the same ridge for the mesh, collider and horizon.

Use `world.setAir('humid-sea-breeze')`, `'clear-post-front'`, `'dusty-inland'` or a game-owned pair such as `{turbidity: 3.4, visibility: 26000}`. Visibility is in metres. The air controls preserve clock, exposure and weather formation. In **Shell beach below the headland**, move the solar hour through sunrise, then switch air. The inspector reports the uncovered solar fraction at the selected receiver height.

## Engine coverage

Three.js WebGPU and WebGL 2 share the reference surface, contacts, weather map and shaders. Godot 4 and Unity starters expose the local wave-offset formula and exponential drying. Supply the four atlas channels and depth from the game. The native starters do not build the terrain, flood atlas, fine sediment grid or showcase scene.
