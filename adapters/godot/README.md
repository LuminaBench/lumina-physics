# Godot 4 adapter (GDShader + GDScript)

Starter implementations of the lumina-physics math for Godot 4.3+ (Forward+).
**Status: source-level starter – written against the Godot 4 API and the specs in
`specs/`, but not run inside the Godot editor by this repository's QA.** Expect to adjust
node paths and export values in your project.

| File | What it gives you | Spec |
| --- | --- | --- |
| `lumina_quality.gd` | 5 tiers: render scale + FSR2/TAA, SSR, SSAO, shadows, budgets | 00 |
| `lumina_wave_spectrum.gd` | JONSWAP + swell → Gerstner wave bank, CPU `height_at` | 01 |
| `lumina_ocean.gdshader` | Displacement, Beer–Lambert, refraction, SSS, whitecaps, tsunami lip | 01–03 |
| `lumina_tsunami.gd` | Breaking mega-wave profile + flow, synced to the shader | 03 |
| `lumina_buoyancy.gd` | Multi-point buoyancy / drag / keel on `RigidBody3D` | 04 |
| `lumina_wet_road.gdshader` + `.gd` | Puddles, rain ripples, mirror film + CPU `puddle_depth` | 05 |
| `lumina_aquaplaning.gd` | Per-wheel hydroplaning grip + water drag for `VehicleBody3D` | 05 |
| `lumina_explosion.gd` | Petrol / C4 / water / electrical archetypes, blast, signals | 08 |
| `lumina_world_bus.gd` + `lumina_world_surface.gdshader` | Local wind, pressure, temperature, cloud clearance and a rain film shared with materials and rigid bodies | 21 |
| `lumina_cloth.gd` | Verlet cloth on a `MeshInstance3D`: flags, banners, sails, canopies; wind, flutter, blasts, tethers, colliders | 10 |
| `lumina_rope.gd` | Verlet rope / cable / power line between two nodes | 10 |
| `lumina_fracture.gd` | Convex Voronoi pre-fracture (concrete, glass, wood); chunks become `RigidBody3D` with real mass; connectivity collapse | 11 |
| `lumina_thermo.gd` | Temperature / fuel / moisture grid: fire spread downwind, char, steam; `ImageTexture` for ground shaders | 12 |

Load a saved World Profiles 1.0 JSON string with `LuminaWorldProfile.from_json(profile_json, looks_json)`. Read `world-looks.json` alongside the installed GDScript file. The returned dictionary includes the resolved look, water and foliage colors, foam values and profile metadata. The host maps those values onto its Godot materials.

Install: `node scripts/install-physics.mjs --engine godot --project /abs/path/to/godot-project`
copies the files to `res://addons/lumina_physics/`.

Wiring an ocean:

1. `MeshInstance3D` with a 512×512-subdivision `PlaneMesh` (400 m) following the camera,
   `ShaderMaterial` → `lumina_ocean.gdshader`.
2. In a script: `var spectrum := LuminaWaveSpectrum.new(); spectrum.wind_speed = 11; spectrum.rebuild(); spectrum.apply_to(material, LuminaQuality.preset["geometry_waves"])`.
3. Vessels: add `lumina_buoyancy.gd`, assign the same `spectrum` (and `tsunami`).
4. `WorldEnvironment`: enable SSR + glow (HDR threshold ≈ 1.15), AgX/ACES tone mapping, and a
   `ProceduralSkyMaterial` or your own volumetric sky.

Cloth: add a `MeshInstance3D`, attach `lumina_cloth.gd`, pick `hang`, set `wind` from your
weather each frame and call `add_blast()` from explosions. Fracture: attach
`lumina_fracture.gd` to a `StaticBody3D`, set `kind` and `size`, call `impact(point, dir,
joules)` or `blast(centre, radius, strength)`. Thermo: one `LuminaThermoField` over the
play area, `add_fuel()` where things can burn, `ignite()`, `quench()`, and sample `texture`
(R = temperature / 1200, G = char, B = wetness, A = burning) in the ground shader.

Parent cloth nodes to a `LuminaWorldBus` or assign their `world_fields` override. Refresh `set_rotor` or `set_vortex` from the emitting node’s physics tick. Assign loose bodies to `driven_bodies` and wettable shader materials to `materials`. Each body samples the pressure gradient and moving air at its centre of mass.

Syntax check (no editor needed): `python3 scripts/lint-adapters.py` parses every `.gd` file
with gdtoolkit's Godot 4 grammar and lints it with `gdlintrc`. That proves the scripts are
well-formed GDScript; it does not run them or check them against the engine API.

Differences from the Three.js reference: cloth, rope, fracture and thermo are ports of the
CPU reference solvers (the WebGPU compute cloth and the one-draw-call chunk renderer are
not ported: each chunk is its own node); brick courses, glass edge shading, surface-deform,
underwater and the animation helpers are specified in `specs/10`–`15` only. The ocean uses a spectrum-sampled Gerstner bank
instead of the compute FFT (port `specs/01` to `RenderingDevice` compute for parity);
volumetric clouds, lightning, the interaction field and the aero module are specified in
`specs/04`, `06`, `07` but not shipped as Godot code.

Send a sole entry or distance-spaced tread contact to `disturb_puddle(worldPoint, widthM, speedMps)` on the wet road. Contacts disturb the film normal and the view of submerged markings. The material and gameplay query share flood level and relief. Input units and timing are documented in spec 05 of the source skill.
