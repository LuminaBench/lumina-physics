# 19 · Instanced Verlet strands & Kajiya–Kay shading

Source: `modules/strands/*` (`strands.ts`, `types.ts`, `presets.ts`, `kajiya-kay.ts`, `gpu.ts`, `cpu.ts`).

Up to `MAX_STRAND_FIELDS = 16` fields (grass meadows, underwater kelp forests, character hair) pack
into contiguous buffers. Each strand is an anchored chain of `segments + 1` nodes (`2 ≤ segments ≤ 12`,
node `0` rigidly anchored to the field transform or `follow` object). On WebGPU (`gpu.ts`), one compute
thread solves an entire strand per substep (`compute(strandCount)`), eliminating cross-strand races and
ping-pong buffers; `cpu.ts` runs the matching solver on WebGL 2 or when `forceCpu` is set.

## Per-substep strand physics (`2` substeps GPU, `1` substep CPU)

For each free node `k ∈ [1, segs]` at normalised arc fraction `t = k / segs` along total length `L`:

```
target(t) = rootWorld + restDir · (t L) − (0, 0.25 · arch · t² · L, 0)
k_stiff   = stiffness · stiffScale · (1.25 − 0.65 t)
a_base    = (target − p) · k_stiff + (0, −9.81 · gravity, 0)
```

- **Air wind + flutter (`grass`, `hair`).** Samples `WindField` plus a two-harmonic travelling wave
  along the wind direction scaled by `|w| · 0.35 · flutter`; drag `a += (air − v) · drag · windResponse · (0.35 + 0.85 t)`.
- **Underwater kelp (`kelp`, negative gravity = buoyancy).** Orbital wave surge around `waterCurrent`:
  `surge = waterCurrent + (1.8 sin φ + 0.7 flutter cos(1.7 φ + 0.8 y), 0.45 sin(1.15 φ), 1.4 cos(0.87 φ + 3.1 seed))`,
  drag `a += (surge − v) · drag · windResponse`. Clamped beneath `waterLevel − 0.05`.
- **Transient blasts (`MAX_STRAND_BLASTS = 6`).** Automatically fed by `PhysicsWorld.onBlast` or
  `addBlast(pos, strength, radius, duration)`. Expanding shell `rad = radius (0.3 + 0.7 prog)` pushes
  radially with `(1 − dist/rad)² (1 − prog)^1.5`.
- **Rotor / jet downwash (`MAX_DOWNWASH_SOURCES = 8`).** Within horizontal `radius` and vertical band
  `(−2.5 radius, +4 m)`: outward radial push + tangential vortex swirl (`swirl`, default `0.35`) +
  downward flattening proportional to `(1 − horiz/radius)² · vertFall · strength · downwashResponse`.
- **Verlet step & interactors (`MAX_STRAND_INTERACTORS = 16`).**
  `p' = p + v h max(0, 1 − damping · h) + a h²`, followed by sphere and oriented-box pushout plus
  velocity wake transfer (`addVehicle(object, halfExtents)` tracks moving rigs automatically) and
  floor clamp `max(groundY, rootY + 0.01)` (`rootY − 0.1` for kelp). Hair uses the world ground height, allowing a strand to hang below its animated scalp root.
- **Inextensible distance constraint sweeps.** `constraintIterations` root-to-tip passes enforce
  `|p_k − p_{k−1}| = segLen`: node `1` takes 100% of the correction against the pinned root; inner links
  split `20%` parent / `80%` child so tension flows smoothly to the tip.

## Simulation LOD

Per-field frustum and distance culling (`sleepDistance = 160 m`, `reducedDistance = 60 m`):
- In frustum & `dist ≤ reducedDistance`: every frame (`lodStride = 1`)
- In frustum & `dist > reducedDistance`: every 2nd frame (`lodStride = 2`)
- Out of frustum within `sleepDistance`: every 3rd frame (`lodStride = 3`)
- Beyond `sleepDistance` (unless `follow` is set): sleeping (`lodStride = 0`)

## Instanced ribbons & Kajiya–Kay shading (`kajiya-kay.ts`)

Each field renders in **1 draw call** (`InstancedBufferGeometry`, `instanceCount = strandCount`),
extruding ribbons along a blend of per-strand twist and camera-facing billboard (`look.billboard`) with
kind-specific taper (`grass` pointed blade, `kelp` ruffled frond, `hair` tapered fiber).

Fragment lighting uses dual-lobe shifted-cuticle Kajiya–Kay shading:

```
T_shifted = normalize(T + N · (shift + jitter))
spec(T', V, L, e) = clamp(T'·H + 1, 0, 1) · (√max(0, 1 − (T'·H)²))^e
kkDiffuse         = mix(√max(0, 1 − (T·L)²), max(0, 0.5 N·L + 0.5), w_wrap)
```

- Primary specular lobe (`primaryShift`, `primaryExponent`, `primaryIntensity`) tinted by `specularColor`.
- Secondary lobe (`secondaryShift`, `secondaryExponent`, `secondaryIntensity`) tinted by strand albedo.
- Back-lit transmission `albedo · (0.65 max(0, −V·L)³ + 0.35 max(0, −N·L)) · translucency · (0.25 + 0.75 t)`.
- Root-to-tip ambient occlusion `mix(rootAO, 1, t^0.65)`, hemispherical sky ambient, and MRT
  `auxSurface(viewNormal, screenVelocity(P, P_prev))` for TRAA/TAAU and GTAO.

## Default presets

| Preset | Builder | Default count (GPU) | Segments | Stiffness | Damping | Gravity | Drag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Grass | `strands.grass(o)` | `2400` | `4` | `26` | `3.4` | `+0.35` | `2.2` |
| Kelp | `strands.kelp(o)` | `360` | `7` | `6.5` | `4.8` | `−0.75` | `4.5` |
| Hair | `strands.hair(o)` | `900` | `6` | `18` | `4.2` | `+1.0` | `2.8` |

For attached hair, supply the animated scalp transform before each update. Each strand interpolates its own scalp root across solver substeps, including rotation of offset roots. Mechanical damping acts on motion relative to that root. Flutter follows the wind relative to the moving attachment, and aerodynamic drag still uses the velocity of each individual node.
