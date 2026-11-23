# 00 · Conventions

Engine-agnostic reference for every lumina-physics module. The Three.js sources under
`engine/` and `modules/` are the canonical implementation; the Godot and Unity adapters
implement the same math.

## Units and axes

| Quantity | Unit | Notes |
| --- | --- | --- |
| Length | metre | 1 world unit = 1 m. Never scale scenes: wave dispersion and buoyancy depend on real size. |
| Time | second | Fixed physics step 1/60 s. |
| Mass / force | kg / N | Rapier, Godot and PhysX all use SI when lengths are metres. |
| Axes | +Y up | Rig forward = −Z, right = +X. Unity adapter converts (forward = +Z). |
| Angles | radians | Directions are "travelling toward", 0 = +X, π/2 = +Z. |
| Radiance | scene-referred linear | Sun irradiance at top of atmosphere = 12.6 → sun-lit white ≈ 4. Exposure 0.5–1.4 before AgX. |

## Shared fields

Every effect reads and writes four shared fields instead of talking to other effects:

1. **Wind field** `W(p, t)` – mean flow + analytic gusts + transient radial blasts
   (`engine/wind.ts`). Ocean chop direction, rain slant, smoke, spray and clouds read it;
   explosions and sonic booms write blasts into it.
2. **Water surface** `η(x, z, t)` – FFT swell + tsunami + interaction field
   (`modules/water`). Buoyancy and aero read it; hulls, jets, tires and blasts write
   sources into the interaction field.
3. **Rigid-body world** – Rapier / Godot Physics / PhysX. Blasts apply radial impulses.
4. **Physics events** use `engine/events.ts` and carry a world position and intensity.

Adding a new effect means deciding what it reads from and writes to these four fields.

## Quality tiers

| Knob | low | medium | high | xhigh | ultra |
| --- | --- | --- | --- | --- | --- |
| Max DPR | 1 | 1.25 | 1.5 | 1.75 | 2 |
| Internal render scale | 0.67 (TAAU) | 0.77 (TAAU) | 1 (TRAA) | 1 | 1 |
| Internal pixel budget | 2.6 MP | 3.0 MP | 3.0 MP | 2.6 MP | 2.15 MP |
| FFT cascades × grid | 2 × 64² | 3 × 128² | 3 × 256² | 4 × 256² | 4 × 512² |
| Ocean mesh (segments) | 128 | 192 | 288 | 384 | 512 |
| Interaction field | 256² / 192 m | 384² / 224 m | 512² / 256 m | 768² / 288 m | 1024² / 320 m |
| Cloud buffer scale · steps / light steps | 0.4 · 10 / 2 | 0.5 · 14 / 3 | 0.5 · 20 / 4 | 0.5 · 28 / 5 | 0.5 · 32 / 5 |
| Environment map · steps | 256×128 · 6 | 384×192 · 8 | 512×256 · 8 | 512×256 · 10 | 512×256 · 10 |
| In-material SSR (steps) | off | off | 16 | 21 | 24 |
| GPU particle budget | 2 048 | 8 192 | 20 480 | 49 152 | 90 112 |
| …of which soft sprites (capped) | mist ≤ 5 200 · smoke ≤ 7 000 · fire ≤ 6 000 · dust ≤ 3 600; rain streaks ≤ 22 000 | | | | |
| Shadows / GTAO (½ res) | off / off | 1024 / off | 2048 / 8 smp | 2048 / 12 | 4096 / 16 |
| Rapier debris | 24 | 48 | 96 | 160 | 256 |

**Pixel budget.** The canvas always stays at display resolution (capped at 5.6 MP). When
`width · height · dpr²` exceeds the tier's budget, the scene pass renders at
`scale = floor(20·√(budget / pixels)) / 20` and is reconstructed by temporal upscaling.
Cost per pixel rises with the tier, which is why Ultra's budget is the smallest.

**Tier selection.** Boot at High. `calibrateTier(58)` measures mean frame time (46 frames
after 28 warm-up frames, two worst frames trimmed): while it exceeds 1000/58 ms step down;
otherwise probe one tier up and keep it only if it still holds.

A preset is plain data (`QualityPreset`); modules read numbers, never tier names, so custom
presets work everywhere. Tier changes rebuild GPU resources but keep simulation state
(spectra are re-synthesised from an integer hash of the wavenumber, so the same sea
returns at any resolution).

## Determinism

- Random phases: integer hash of `(n, m, cascade, seed)` → identical ocean on every
  resolution, backend and on the CPU twin.
- Ocean time wraps at 1200 s with ω quantised to 2π/1200 so float32 phase stays exact.
- Road relief is a baked tile sampled identically by shader and tire physics.
