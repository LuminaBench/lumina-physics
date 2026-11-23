# 16 · Inland water: rivers, rapids and waterfalls

Source: `modules/water/inland.ts` (`River`, `Waterfall`, `InlandWater`, `RIVER_PRESETS`, `WATERFALL_PRESETS`).

## River spline & flowmap

Control points `RiverPoint { x, y, z, width?, speed?, depth?, turbulence? }` (at least 2) are
interpolated by Catmull–Rom (24 sub-samples per segment) and arc-length parameterised into
cumulative downstream distance `s ∈ [0, L]`, unit tangent `T̂`, horizontal right vector
`R̂ = normalize(−T_z, 0, T_x)` and downward slope `m = max(0, −T_y)`.

A 2D `DataTexture` (`RGBAFormat`, `HalfFloatType`, default `256²`) is baked across
`u ∈ [−1, 1]` (left to right bank) and `v ∈ [0, 1]` (head to mouth):

```
bankProfile = max(0.22, 1 − 0.72 |u|²)
v_along     = speed · (1 + 3.8 m) · bankProfile
v_across    = 0
turb        = turbulence · (0.45 + 0.55 bankProfile) + 2.6 m  (+ 0.35 smoothstep(0.78, 0.98, |u|))
```

For each rapids boulder (`RapidRockSpec { x, z, radius, height?, y?, seed? }`, explicit or
scattered via `autoRocks`) with effective cylinder radius `a = 1.12 · radius` and local flow
frame `(ds, dr)` (`ds > 0` downstream):

```
Potential-flow cylinder deflection (clamped invR² = min(1.15, a² / max(r², 0.35 a²))):
  Δv_along  = −0.75 · U_loc · invR² · cos(2θ)
  Δv_across = −1.15 · U_loc · invR² · sin(2θ)    where U_loc = 0.9 · speed_rock

Upstream bow pillow (−2.6 a < ds < 0.3 a, |dr| < 1.8 a):
  G_up = exp(−((ds + 0.75 a) / 0.75 a)² − (dr / 0.95 a)²)
  pillowH += G_up · min(0.45, 0.056 U_loc + 0.12) ;   turb += 1.05 G_up

Downstream churning V-wake (−0.2 a < ds < 5.8 a):
  tail = max(0, ds / 5.5 a) ,  spread = a (0.75 + 1.25 tail)
  G_wk = exp(−(dr / spread)²) (1 − tail) smoothstep(−0.2 a, 0.45 a, ds)
  turb    += (1.25 + 0.14 U_loc) G_wk
  pillowH += 0.12 sin(3.2 ds / max(a, 0.5)) · G_wk
```

Channels stored: `R = v_across` (`[−12, 12]`), `G = v_along` (`[0.05, 18]`), `B = turb` (`[0, 2.2]`),
`A = pillowH` (`[−0.4, 0.75]`).

## Dual-phase flowmap advection & river optics

The river mesh lifts vertically by `(pillowH + 0.065 · clamp(turb, 0, 1.8) · sin(2.1 s − t (1.25 |v| + 2.2) + 1.3 sin(1.7 w)))`,
feathered to zero at the banks.

In the fragment stage, metric coordinates `r = (u·meanWidth, v·length)` advect along `vel = flow.xy · flowScale`
with two half-cycle-offset phases jittered by low-frequency noise (`cycleRate = 0.42`):

```
p0 = fract(0.42 t + jitter) ,  p1 = fract(0.42 t + 0.5 + jitter) ,  blend = |2 p0 − 1|
adv_k = r − vel · (p_k / 0.42)
```

Two band-limited gradient-noise octaves (weighted by pixel footprint `footprintMax`) build the
perturbed normal `N_w` with `specularAA(N_w, α²)`. Shading combines Schlick Fresnel (`F₀ = 0.02`),
GGX sun glitter, crest SSS, Beer–Lambert depth extinction (`clarity ∈ [0, 1]`, screen-space refraction
under 180 m when `preset.ocean.refraction` is on, analytic riverbed fallback otherwise), flow-stretched
Voronoi + fBm whitewater lace, and soft `bankFade` alpha feathering.

All boulders merge into a single geometry (`rocksMesh`, 1 draw call) displaced by deterministic 3D
harmonic noise with a wet darkened splash zone (`aWetHeight < 0.52 m`, roughness `0.18` vs `0.84` dry)
and waterline foam rim.

## Waterfall & plunge pool

`Waterfall` builds a ballistic parabolic sheet (`v ∈ [0, 1]`, `vDrop = 1.03 v`):

```
t_fall = √(2 h / g) ,  throwDistance = exitSpeed · t_fall  (or explicit override)
forward(v) = throwDistance · vDrop
y(v)       = y_crest − h · vDrop²
spread(v)  = 1 + 0.18 v
```

Elongated downward noise ribbons (`accelV = v^0.72 · 0.32 h`) and cellular foam webs fade smoothly
across edges and scene depth (`depthSoft`), lit with wrapped diffuse + forward sun scatter (`(−V·L)^4.5`).
A horizontal `plungeMesh` renders outward-advected radial boil rings at `plungePosition`.
`plungeFlowAt(x, z)` returns an outward push velocity up to `0.22 √(2 g h) · flow` within
`1.4 · plungeRadius`. Plunge mist and ballistic splash particles share `EffectsKit` (`fx.mist` / `fx.spray`)
or allocate tier-budgeted local `ParticleSystem` pools, and splash `engine.lens` when the camera is nearby.

## Presets & query API

| River preset | width (m) | speed (m/s) | depth (m) | turbulence | autoRocks | clarity |
| --- | --- | --- | --- | --- | --- | --- |
| `mountainRapids` | 11 | 4.4 | 1.5 | 0.62 | 14 | 0.86 |
| `forestStream` | 6.5 | 2.1 | 0.9 | 0.22 | 6 | 0.92 |
| `canyonTorrent` | 16 | 6.2 | 2.8 | 0.85 | 20 | 0.64 |

| Waterfall preset | width (m) | height (m) | exitSpeed (m/s) | aeration | mistIntensity |
| --- | --- | --- | --- | --- | --- |
| `cascade` | 7.5 | 12 | 3.8 | 0.82 | 1.0 |
| `bridalveil` | 4.5 | 26 | 2.8 | 0.94 | 1.35 |
| `cataract` | 16 | 18 | 6.2 | 0.90 | 1.65 |

`InlandWater` hosts multiple rivers (`addRiver` / `removeRiver`) and waterfalls (`addWaterfall` / `removeWaterfall`)
and provides zero-allocation CPU queries: `sample(x, z, out)` → `RiverSample`, `heightAt(x, z, fallback)`,
and `flowAt(x, z, out)` (compatible with `SoftBodySystem`'s `WaterSurfaceLike` and `StrandSystem.waterCurrent`).
