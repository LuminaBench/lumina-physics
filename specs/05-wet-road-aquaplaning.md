# 05 · Wet road, puddles and aquaplaning

Source: `modules/wet-road/road.ts`, `vehicle.ts`, `spray.ts`.

## Surface height and standing water

```
h(x, z)   = 0.03 · relief(xz / 48 m) + crown(x) + ruts(x) − pool(x, z)
crown     = 0.03 (1 − (x/7.5)²)
ruts      = −0.018 Σ exp(−((x − c)/0.32)²),  c ∈ {±1.05, ±2.75}
pool      = 0.034 exp(−(z'/9)²) [0.95 exp(−((x + 3.3)/1.5)²) + 0.5 exp(−((x + 1.9)/2.2)²)],  z' = (z mod 170) − 85
waterLine = mix(−0.07, 0.006 + 0.052 · flood, smoothstep(0, 0.15, flood))
depth     = max(0, waterLine − h)
```

`relief` is a baked tileable 4-octave value noise sampled identically by the shader and by
`puddleDepth(x, z)` on the CPU: what the tire feels is exactly what the eye sees.

## Shading

- Film coverage rises smoothly over the first 3.6 mm of liquid. Fully damp asphalt scales its dry albedo by 0.55.
- Dry asphalt roughness is 0.86. Water in pores lowers it toward 0.28–0.44 according to aggregate polish. Standing water approaches 0.014 before normal-variance filtering.
- normal: asphalt micro bump ×(1 − f); on water: rain ripple rings + breeze + tire ripples.
- Sample the environment at `7.5·roughness`. Near coherent surfaces use SSR when `(1 − roughness)² > 0.22`; the reflected environment weight is `F · mix(0.14, 1, mirror)` before contact occlusion.
- analytic contact shadow under the car and analytic headlight pool + specular streak.

Rain ripples: two cell grids (2.6 and 1.45 cells/m); each cell owns one drop with phase
`fract(t·rate + hash)`; ring `r = d − 1.05·phase`,
`wave = sin(34 r) exp(−70 r²) (1 − phase)²`; summed over the 3×3 neighbourhood.

## Aquaplaning

NASA critical speed for dynamic hydroplaning:

```
V_p [km/h] = 6.35 √(tire pressure [kPa])          220 kPa → 94 km/h
```

Per wheel, per fixed step:

```
depthFactor = smoothstep(tread, tread + 9.5 mm, depth)          tread = 2.8 mm
lift        = smoothstep(0.74 V_p, 1.08 V_p, |v|)
hydro       = depthFactor · lift
viscous     = 0.22 depthFactor smoothstep(0.3 V_p, 0.74 V_p, |v|)
grip        = mix(dryGrip, wetGrip, wetness) · rear(1.12) · max(g_f, 1 − (1 − g_f) hydro − viscous)      g_f = 0.055
sideStiff   = mix(1, 0.18, hydro)
F_drag      = ½ ρ C_d (0.22 m · depth) v²   at the contact patch, opposing velocity     C_d = 1.0
```

`grip` → friction-slip limit and `sideStiff` → cornering stiffness of the raycast wheel
(Rapier `setWheelFrictionSlip` / `setWheelSideFrictionStiffness`, Godot
`VehicleWheel3D.wheel_friction_slip`, Unity `WheelCollider` friction curves).
Unequal depth left/right gives unequal drag → yaw toward the deeper side; a crosswind
side force from the wind field steers a floating car. Lifting off sheds speed → `lift`
falls → grip returns.

The pool floods the whole lane but is deepest at the verge: at speed all four tires lift
while the deeper side drags harder, so the car is yawed with almost no grip to resist.
Default `flood = 0.42` leaves the ruts damp (0–6 mm) so cruising is stable and the pools
are the event. Baseline stability: centre of mass 0.28 m ahead of centre, rear grip ×1.12.

Driver model (showcase): PD on lane offset + heading + yaw rate with authority
`1 − 0.55·hydro_front`; counter-steer `clamp(1.15·slip − 0.1·yawRate, ±0.45 rad)` once
`|slip| > 3°`; reacts 0.32 s after the car starts floating or sliding, then lifts for
0.75 s. Measured at 114 km/h: hydroplaning 100 %, slip angle ≈ 11°, lane excursion
< 0.5 m, recovery without leaving the road.


## Contact-driven spray

Use the simulator’s contact point, world velocity, normal, signed rolling speed, lateral slip, load and wheel angular speed. Sample liquid depth independently under each wheel. The visible surface sits at pavement height plus liquid depth.

| Condition | Response |
| --- | --- |
| Rolling tread crosses a film | The grooves pick up water. Tread rotation throws drops backward relative to the tire, with additional upward and outward velocity. |
| One wheel enters standing water | The forward-moving contact squeezes an outward sheet once depth exceeds 6 mm and vehicle speed exceeds 7 m/s. Only the wet side develops a substantial mist wake. |
| Tire locks under braking | Tread throw diminishes with rim speed. Translating through a puddle can still displace water sideways. |
| Tire leaves the puddle | Water retained in the tread drains over successive rotations. Released sheets, droplets and aerosol continue in world space. |
| Body enters a flood | Each leading corner displaces water according to local draft. Forward travel piles water at the grille, reverse travel at the rear bumper. Set the body’s lower edge with `fluid.clearance` in metres. |

`TireSpray.amount` scales emission. `fluid.setFlood(true, depthM)` sets the water level in metres above the road under the car when enabled. Sample `fluid.depth(x,z)` to query the moving surface.

### Custom wheel controllers

For a sloped street, pass a third argument to `new WheelSpraySheets(outletCount, onLanding, options)`. Supply `surfaceHeightAt(x,z)` in world metres, including standing water. Each lane of the fan traces its first surface crossing over its visible lifetime. The middle lane sends one landing event. Omit the height query for a flat water surface. The optional TSL `radiance(positionWorld)` adds local lighting such as brake lamps to the sheet.

For enclosed wheels install `wheel-arch`, or set `archSurface` on the road passed to `TireSpray`. Provide `exchangeLitres(x,z,request)`, returning the signed amount accepted at that location. Negative requests withdraw water. `StreetDrainage` implements this interface. Each arch keeps its own finite store. Tune clearance in metres, capacity in litres, coverage from 0 to 1 and a positive e-folding drain time in seconds. A rolling wet tire lifts water into the liner once the spray can reach it. The liner releases water beneath the arch while moving or stopped. `storedLitres`, `capturedLitres`, `dischargedLitres` and `outsideLitres` expose its budget. The host owns any runoff deposited outside its catchment. Decorative droplets sample that discharge. Keep a separate ledger if a game needs every other airborne droplet or tread print to carry water mass.

For a bicycle or another vehicle, selectively install `wheel-sheets` with Three.js as its only peer. In a custom renderer call `updateFrameUniforms(camera, elapsedSeconds, dt)` once per frame and set the shared `frame.sunDirection`, `sunColor`, `skyHorizon` and `skyZenith` uniform values from the lighting rig. A Lumina scene already updates them. Create one `WheelSpraySheets(outletCount, onLanding?)` and add its mesh to the world scene. Give each outlet a stable index. When the wheel displaces water, call `submit(index, surfacePoint, innerVelocity, outerVelocity, strength)`. Use world metres and m/s. The inner velocity sets the climbing lip and the outer velocity sets the flatter lateral fringe. For shallow tire spray keep the vertical components between 0 and 5 m/s. Scale strength by wet tread width, local depth and patch speed. End emission by omitting the outlet. Call `update(dt)` once after all outlets, and `dispose()` when removing the vehicle.

Each outlet keeps 40 launch samples at 30 Hz and uses five points across the sheet. The optional callback receives X, Z and strength once when a representative droplet returns to launch elevation. Query the recipient surface there before adding a ripple. This return estimate assumes locally level ground.

Wet-road daylight uses the local surface normal, film roughness and cloud shadow for the direct solar highlight. Rain ripples spread the highlight across puddles, while damp aggregate gives a broader, dimmer response. The reflected sky supplies the surrounding haze.

## Shoes, bicycle tires and submerged road detail

Use one `road.contacts.contact('foot', outsoleWidthM)` per animated foot, or one `contact('wheel', treadWidthM)` per bicycle wheel. Supply the outsole or bottom-of-tread point, its world velocity in m/s, and elapsed game seconds to `handle.sample(point, velocity, dt, enabled)`. Take foot velocity from consecutive animated poses before the foot is planted. Set `enabled` false on a contact break and call `reset()` on teleport. A planted sole emits one entry packet. A rolling tire lays packets by distance and the rear wheel can cross the front wheel's wake. The road's physics and shader share the same liquid depth. On foot or on a bicycle, set `road.vehicleLighting = false` to follow the camera and remove the car-specific light pools and shadow.

Install `puddle-contacts` independently for a custom material. A different game surface can implement `PuddleSurface` with bed elevation and liquid depth at world X/Z. Create a `PuddleContacts`, call `update(dt)` once per frame, and add `slopeNode(worldXZ)` under the material’s standing-water mask. The pool holds up to 24 active packets and expires them after 1.8 s. Their angular frequency follows finite-depth gravity–capillary dispersion. Pressure-driven splashes in deep floods use the street-fluid module.

Use `contacts.bedXZNode(worldXZ, unitViewToCamera, unitWorldNormal, liquidDepthM)` to shade submerged detail on a custom surface. The road traces the transmitted viewing ray through the puddle to sample the pavement grain and painted lines. Water depth, reflections, rain rings and contact positions are evaluated at the surface entry point. At normal incidence the bed has zero lateral offset. A thicker puddle or a more oblique view moves the submerged markings while the dry markings stay fixed.

## Rubber smoke

Install `tire-smoke` for the standalone `TireSmoke(fx, wheelCount)`. Call `updateWheel(index, contactPoint, loadN, slipMps, liquidFraction, dt, worldVelocity)` for each wheel every frame. Tread slip combines lateral scrub with angular speed times rolling radius minus patch speed. Use zero load in the air. Friction work heats an effective surface layer; airspeed and water accelerate cooling. The estimator drives game visuals and exposes `temperatureRise(index)` in °C above ambient. Tread smoke shares the particle pool with soot but scatters cooler, paler daylight. The legacy normalized-slip entry point on `VehicleDamage` remains available.

The wet-road solar lobe includes a rounded vehicle occluder. A low sun can cast its shadow beyond the patch directly under the chassis. Keep `vehicleLighting` disabled for pedestrian and bicycle cameras unless the game supplies its own vehicle lighting.


## Godot and Unity road starters

Install `puddle-contacts` for the road surface and contact component in either native engine. `wet-road` also includes the aquaplaning controller. Send one accepted sole entry to Godot’s `road.disturb_puddle(worldPoint, widthM, speedMps)` or Unity’s `road.DisturbPuddle(worldPoint, widthM, speedMps)`. Feed a bicycle tire successive tread positions spaced by travelled distance. A stationary foot sends a single event. Both starters supply 24 expiring packets, the two-interface view of road markings, a drained zero-flood state and a per-road shader clock. The game owns animation events and wheel spacing. Use a level road whose world X/Z coordinates match the road profile, and assign the same repeating linear relief data to the component and shader.


The Three.js road grid samples the crown, wheel ruts and relief at world coordinates. Geometry and the reflected ray begin at the higher of the bed and liquid surface. Rows advance in fixed two-metre increments as the road scrolls. Use `heightAt(x,z)` for the load-bearing contact and `Math.max(road.waterLine, road.heightAt(x,z))` for visible squeegee tracks.

## Rain under an overpass

Register each horizontal roof once when its game geometry loads. `center` lies on the underside. `width` spans local X, `depth` spans local Z and `yaw` follows the Three.js rotation around Y. All positions and dimensions use metres. The registration describes shelter and lighting. The host owns the visible mesh and its collision shape.

```ts
const releaseRoof = engine.world.shelters.add({
  center: new THREE.Vector3(0, 4.5, 30), width: 16, depth: 12, yaw: 0.2,
  groundY: 0, initialWetness: 0, underside: 0x615e59,
});
// On level unload
releaseRoof();
```

Rain streaks and lens deposition trace back toward the incoming rain. The porous road film and each tire sample the same drying footprint. A flooded rut still has its measured depth under a roof. Wheels and shoes can disturb that pool after raindrop rings stop. `road.wetnessAt(x,z)` gives the pavement film and `road.puddleDepth(x,z)` gives standing liquid in metres.

The road shader traces the light and the reflected view separately. Low sun can enter through the side. A puddle can reflect the dark underside in one direction and open sunset sky in another. The approximate matte underside colour supplies an off-screen fallback. An enabled local geometry probe and a successful screen-space reflection replace it with captured scene detail.

For a standalone Three.js surface, install `rain-shelters`, construct `RainShelters`, and call `update(dt, windX, windZ, rain, dryingRate)` with seconds, wind components in m/s, rain fraction and drying fraction per second. Use `rainNode(point)` for drop arrival, `groundNode(point,outdoorFilm)` for film and diffuse sky, and `rayNode(point,direction)` for underside colour and coverage. An explicit ray points from the surface toward its source.

The local set holds eight yaw-rotated rectangular roofs. Each uses a 24 × 24 film grid across the roof and its surrounding apron. The film updates at about 6 Hz and keeps drying history as wind shifts. Set `initialWetness: 1` when adding a roof over already soaked ground. Set `apronM` to widen the stored downwind region in a windy setting. Surfaces at other elevations sample the ground history along the rain direction. A game can retain additional wetness on carried objects in their own material state. In Storm Highway, **Rain under the overpass** parks the car beside a flooded rut.

The flooded-street surface samples the same roof for falling rain and off-screen reflected rays. Its shallow-water waves continue across the rain shadow. The grid samples atmospheric rainfall at the burning surface film, so a covered part of a spill can stay alight while an exposed part cools.

## Water and soil carried by tires

For a Three.js highway construct `new WetRoad(engine, weather, { soil })` and attach `TireSpray`. The optional soil object implements `amountAt(worldX, worldZ)` for contact pickup and `amountNode(worldXZ)` for visible soil coverage. Return the same fraction in both, including the edges of the patch. Pass an empty options object for water transfer alone. One wheel can enter a source while its axle partner stays on asphalt. Rain, puddle depth and hydroplaning still come from the road.

For another game surface, install `tread-transfer`. Create a `TreadTransfer` shared by the nearby wheels. Allocate a `field.contact(widthMetres)` per wheel. Each update:

1. Pass the previous retained film (initially zero), standing depth in metres, local liquid wetness (0–1), tread depth and wheel radius in metres, signed rim speed in m/s and elapsed seconds to `retainedTreadFilm`. Use its returned metres for droplet emission and this contact. Set depth and surface wetness to zero while airborne.
2. Call `contact.sample(x, z, retainedFilm, depth, rainFilm, looseSoil, load, maxTravel)`. Supply base surface film and soil coverage in 0–1, normalized effective contact load (zero off the ground) and a maximum continuous displacement for this tick in metres. For a bicycle use its physical contact width, e.g. 0.035 m. At respawn call `contact.reset()` and reset its retained film.
3. Call `field.update(dt, focusX, focusZ)` once before rendering. Sample `field.sampleNode(positionWorld.xz)` in the ground material. Red is deposited moisture, green is sediment coverage and blue is film squeezed from porous ground. Combine rain and prints with `max(rainFilm * (1 - blue), red)`. Darken the porous substrate and reduce roughness as that film builds. Let standing water keep its own reflecting interface. `field.sampleAt(x, z, scratchVector)` returns those channels for gameplay.

The default 256 × 512 RGBA8 map covers 10.24 × 40.96 m and occupies 512 KiB. Set `cellX` and `cellZ` in metres per texel to trade visible reach for fine tread detail. The map retains the overlap when the focus moves and clears cells that enter the window. Thin prints filter to partial coverage. A stationary wheel stops painting, reversing retraces the path, and water washes soil from the tire. Displaced surface film fills in before deposited wet tracks dry. Sediment persists longer. Soil supply and the drying times are visual approximations. Call `field.dispose()` for a standalone map. WetRoad owns its map and disposes of it.
