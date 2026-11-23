# Wind, pressure, heat and wetness

The simulation uses metres, seconds, world-space XYZ and a positive vertical Y axis. An engine owns one `WorldBus`. Its wind accessor is the same instance as `engine.wind`. The event emitter remains available for discrete notifications.

## Swept sources

A source has endpoints A and B, radius R and a finite lifetime. For a sample P, project P onto segment AB and clamp the projection to the segment. Let D be the displacement from that closest point and q = dot(D,D)/R². The interior weight is (1−q)² for q below one and zero outside. Coincident endpoints produce a sphere. CPU probes, GPU compute and fragment shaders use this kernel. A held emitter refreshes its owned source. A transient fades with a cubic smoothstep. The pool holds 16 local sources. A full pool recycles its shortest-lived transient. Held sources retain their slots until release or expiry.

| Quantity | Use |
| --- | --- |
| Wind, m/s | Add radial, azimuthal and vertical flow to the background gust field. The rim lift contribution is proportional to 4q inside the envelope. Cloth, particles, strands, rain and dynamic bodies sample the local disturbance. |
| Pressure | Positive forcing depresses the local water interaction grid. Negative forcing lifts it. The wet surface responds with inertia and sends ripples outward. Once an external pressure source enters the ocean, a scrolling CPU wave grid follows the same forcing and supplies hull-scale displacement and vertical water velocity to buoyancy without GPU readback. |
| Heat, °C above ambient | Thermal grids receive local heat. Active fires publish a plume around their burning cells and props. |
| Wetness, 0–1 | Rain accumulates a surface film. Local spray adds spatial wetness. Film changes PBR roughness, water beading, coloration and melting-ice appearance. Rain and spray remove heat from thermal surfaces. |

`world.read(position,time,reading)` reuses a supplied `FieldReading`. `world.scalarNode(P)` returns pressure, temperature, wetness and cloud clearance in RGBA. `world.node(P)` returns wind velocity. Register finite water bodies with `world.addWater(surface)`. Return NaN outside their footprint. The highest valid waterline and its corresponding three-dimensional current win together. Ocean and inland-water hosts register themselves.

## Coupled effects

- A **rotor** deposits downward momentum in its core with outward flow and upward rim lift. It retains pressure while hovering. Curved spray sheets follow the pressure rim. Their projected optical thickness increases at grazing angles, with separately integrated droplets detaching into the airflow. The same rotating source lofts soil, sand or snow according to the contact surface. A **weather vortex** translates a tapered condensation funnel and a rotating contact cloud over the sampled waterline or terrain. Its fixed-step drag depends on slip speed and exposed area. Lightweight debris entrains earlier than a loaded chassis.
- A **combustion plume** integrates entrainment from the wind at its core. A second wind sample above the core bends the crown. Local spray and falling rain cool the luminous sheets over time. Reusing a pooled plume resets its transport and cooling state.
- A **cloud trail** deposits swept segments along a moving object's path. The volumetric marcher removes condensate at the core and concentrates wisps around its boundary. The viewer can enter or cross the layer. The camera moisture probe uses the same repeat-wrapped procedural density textures as the renderer. The Low tier retains its single-pass analytic cloud path.
- **Street water** integrates a damped shallow wave on a fixed grid. A moving hull displaces water at the front corners with a compensating stern source. Liquid film travels downhill by conservative neighbour transfers. Fire state travels between adjacent film-bearing cells and consumes inventory. The same film field controls tire grip and the thin-film color shift.
- A **floodable hull** splits displacement into authored compartments. A submerged breach fills its own compartment and reduces local buoyant lift. Separated force application points produce list and trim. The sampled surface elevations fit a local waterline plane for hull shading. Relative hull motion publishes signed pressure and wetness at the port and starboard waterlines, so a rolling hull can raise a ripple on one side while depressing the other. Trapped air escapes as rising bubbles while reserve volume remains. Dirigible and ship samples should choose displacement in cubic metres consistent with the body's mass.
- **Crumple geometry** displaces vertices within an impact neighbourhood and limits cumulative displacement from the undeformed hull. Partial glazing damage resolves into radiating cracks and arcs. Full glazing failure removes its material groups and creates independently moving fragments.
- **Flexible trees** integrate angular springs along tapered trunks and branches. A broken crown inherits its pose and bend motion as a rigid body. **Active ragdolls** use articulated colliders with limited hinges, inertia-scaled orientation drives and recovering muscle activation after an impulse. Loaded boot soles transmit leg extension and limited friction to the supporting body, including moving platforms. The stance releases in free fall and deep water. Torso contacts weaken the orientation drive. Distributed buoyancy, the local current and an immersion-dependent arm and torso pose determine how the character floats.

## Engine starters

The Three.js modules implement the reference effects. The Godot starter exposes `set_source`, `wind_at` and `fields_at` on `LuminaWorldBus` and supplies a wet/heat-responsive spatial material. In Unity, `LuminaWorldBus.SetSource` and `Sample` expose the same kernel. Include `LuminaWorldFields.hlsl` in a URP shader to read the field uploaded by the component. The Three.js renderer also binds ordinary standard and physical materials added by a host game. It preserves authored color, roughness and texture inputs when applying the water film. The Godot and Unity samples bind each moving actor or material to the scene bus. Discrete game events remain independent.

Stationary stock PBR meshes receive the material field in shared render uniforms, including when transforms and textures stay constant. Rooted instanced canopies sample wind at their world positions. The tree module also tracks structural failure. Aircraft demonstration routes sample actual cloud condensate along the inbound corridor before choosing altitude.

Aircraft wake capsules set `axialSwirl` to align circulation with the swept flight path. Spherical sources and vertical funnels use the vertical axis by default. The Godot and Unity source setters accept this as an optional final argument.

## Climate in Three.js

Call `engine.world.setClimate(CLIMATES.coldFront)` before constructing outdoor modules, or set a new profile during play. A profile defines `baseAltitude` and `topAltitude` in world metres, `baseTemperatureC` and `topTemperatureC` in Celsius, and `baseIceHumidity` and `topIceHumidity` as relative humidity over ice (1 means saturation). Values interpolate between the endpoints and hold beyond them. `surfaceHumidity` is relative humidity over liquid water in 0–1. Start with `humidCoast`, `dryHeat` or `coldFront` and pass a modified copy to change values. Call `setClimate()` to restore the default.

Gameplay and shaders sample the same ambient temperature by altitude. Local heat adds to it. Dry surfaces keep their finish. Moist surfaces frost below freezing and recover liquid highlights where heated. The frost shader approximates the phase of the available film at local temperature. The road uses up to 3.6 mm for a frozen coating and reduces contact grip accordingly. The global film dries faster in hot dry air. Thermal grids and props cool toward their local air temperature; existing heat and damage persist across changes. The ocean retains its independently authored liquid sea state.

`JetAero` samples temperature and ice humidity at the jet when there is a profile. Explicit flight-state weather overrides either value. Existing segments continue to drift after new contrails stop forming. The sky, winds and water spectrum remain independently specifiable for coastal inversions and sheltered bays.

### Local shelter

On Three.js, `world.shelters` holds registered overhead rectangles. The bus advances their moisture history using the local climate drying rate and prevailing wind. `world.rainFilmAt(x,y,z)` returns rain-deposited water at the point. `world.disturbance(point,out).wetness` also includes local spray and other published wetness sources. Ordinary PBR materials and procedural materials that read `surfaceClimateNode` receive that combined field. A sheltered fire can still be quenched by a local spray source. [Roof geometry, units and shader inputs](05-wet-road-aquaplaning.md#rain-under-an-overpass)
