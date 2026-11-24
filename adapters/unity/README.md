# Unity adapter (URP · HLSL + C#)

Use `LuminaCoast.WaveOffset` and `LuminaCoast.DrainFilm` for the local coastal wave and drying formulas. Supply the mapped phase, gain, connected spill elevation and local depth described in spec 27.

Starter implementations of the lumina-physics math for Unity 2022.3+ / Unity 6 with the
Universal Render Pipeline. **Status: source-level starter – written against the URP 14+
shader library and the specs in `specs/`, but not compiled in the Unity editor by this
repository's QA.** (`Rigidbody.linearVelocity` is the Unity 6 name; use `velocity` on 2022.3.)

| File | What it gives you | Spec |
| --- | --- | --- |
| `LuminaQuality.cs` | 5 tiers: render scale, TAA, shadows, budgets | 00 |
| `LuminaWaveSpectrum.cs` | JONSWAP + swell → Gerstner wave bank, CPU `HeightAt` | 01 |
| `LuminaOcean.shader` | Displacement, Beer–Lambert, refraction, Fresnel, glitter, SSS, foam, tsunami lip | 01–03 |
| `LuminaTsunami.cs` | Breaking mega-wave profile + flow, synced to the shader | 03 |
| `LuminaBuoyancy.cs` | Multi-point buoyancy / drag / keel on `Rigidbody` | 04 |
| `LuminaWetRoad.shader` + `.cs` | Puddles, rain ripples, mirror film + CPU `PuddleDepth` | 05 |
| `LuminaAquaplaning.cs` | Per-wheel hydroplaning grip + water drag for `WheelCollider` | 05 |
| `LuminaExplosion.cs` | Petrol / C4 / water / electrical archetypes, blast, events | 08 |
| `LuminaWorldBus.cs` + `LuminaWorldFields.hlsl` | CPU and shader sampling of local wind, pressure, temperature, rain film and cloud clearance | 21 |
| `LuminaCloth.cs` | Verlet cloth on a `MeshFilter`: flags, banners, sails, canopies; wind, flutter, blasts, tethers, colliders | 10 |
| `LuminaRope.cs` | Verlet rope / cable / power line between two transforms (`LineRenderer`) | 10 |
| `LuminaFracture.cs` | Convex Voronoi pre-fracture (concrete, glass, wood); chunks become `Rigidbody` + convex `MeshCollider` with real mass; connectivity collapse | 11 |
| `LuminaThermoField.cs` | Temperature / fuel / moisture grid: fire spread downwind, char, steam; `Texture2D` for ground shaders | 12 |

Import the saved World Profiles 1.0 JSON and `world-looks.json` as TextAssets. Pass them to `LuminaPhysics.LuminaWorldProfile.Load(profileJson, lookLibrary)` and read the resulting metadata and `values` from the host component. The starter supplies water and foliage colors, foam settings and grading controls for host materials.

Install: `node scripts/install-physics.mjs --engine unity --project /abs/path/to/UnityProject`
copies the files to `Assets/LuminaPhysics/`.

Setup: URP asset → enable **Depth Texture** and **Opaque Texture**, HDR on, TAA on the
camera, bloom threshold ≈ 1.15. Ocean: a dense plane mesh following the camera with a
material using `Lumina/Ocean`, plus a `LuminaWaveSpectrum` component pointing at that
material. Vessels: `LuminaBuoyancy` with the same spectrum (and tsunami).

Cloth: add `LuminaCloth` to an object with a double-sided material, pick `hang`, set `wind`
from your weather each frame and call `AddBlast()` from explosions. Fracture: add
`LuminaFracture`, set `kind`, `size` and `material`, call `Impact(point, dir, joules)` or
`Blast(centre, radius, strength)` (`Rigidbody.velocity` is used; rename to `linearVelocity`
on Unity 6). Thermo: one `LuminaThermoField` over the play area, `AddFuel()` where things
can burn, `Ignite()`, `Quench()`, and sample `Texture` (R = temperature / 1200, G = char,
B = wetness, A = burning) in the ground shader.

Parent cloth objects to a `LuminaWorldBus` or assign their `worldFields` override. Refresh `SetRotor` or `SetVortex` from the emitter’s `FixedUpdate`. Add loose bodies to `DrivenBodies` to apply the pressure gradient and local air velocity at the centre of mass. Materials can read the same sources through `LuminaWorldFields.hlsl`.

Syntax check (no editor needed): `python3 scripts/lint-adapters.py` parses every `.cs` file
with tree-sitter's C# grammar and fails on any error node. That proves the files are
syntactically valid C#; it does not compile them against UnityEngine.

Differences from the Three.js reference: cloth, rope, fracture and thermo are ports of the
CPU reference solvers (no compute cloth, one GameObject per chunk); brick courses,
surface-deform, underwater and the animation helpers are specified in `specs/10`–`15` only.
The ocean: Gerstner bank instead of the compute FFT (port
`specs/01` to a `ComputeShader` for parity); volumetric clouds, lightning, the 2D
interaction field and the aero module are specified in `specs/04`, `06`, `07` but not
shipped as Unity code. Unity is left-handed with +Z forward – directions (radians,
0 = +X, π/2 = +Z) are used unchanged.

Send a sole entry or distance-spaced tread contact to `DisturbPuddle(worldPoint, widthM, speedMps)` on the wet road. Contacts disturb the film normal and the view of submerged markings. The material and gameplay query share flood level and relief. Input units and timing are documented in spec 05 of the source skill.
