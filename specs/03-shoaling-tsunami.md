# 03 · Shoaling, breakers and tsunami

Source: `modules/water/ocean.ts` (`breaker`), `modules/water/tsunami.ts`, `tsunami-fx.ts`.

## Bathymetry

A depth map (`Bathymetry`) gives still-water depth `d(x, z)`. `setSink(m)` lowers the
whole seabed so a lagoon can morph into open ocean live.

- FFT displacement and slopes are scaled by `shoal = smoothstep(−0.05, 5.5, d)^0.8`.
- CPU sampling applies the same factor.

## Shoreline breakers

Crests follow depth contours because the phase is a function of depth:

```
φ      = 8.5 d + 0.95 t + 3.2 n(0.035 xz)         s = fract(φ / 2π)
env    = smoothstep(0.03, 0.5, d) · smoothstep(1.7, 0.68, d)
height = H_b · env · (e^{−4.2 s} − 0.2) + swash
swash  = 0.07 sin(0.95 t + 6 n) smoothstep(1.2, 0, d) · min(1, 2.5 H_b)
foam   = 1.3 env e^{−2.6 s} smoothstep(1.45, 0.5, d) + smoothstep(0.3, 0, d)(0.7 + 0.3 sin(...))
```

`e^{−4.2 s}` is a bore: near-vertical shoreward face, long back. Wet sand: the beach
material darkens (×0.5 albedo, roughness 0.22) between the waterline and the run-up
height `0.12 + 0.9 H_b`.

## Tsunami profile

Parameters: crest height `H₀`, width `W`, direction, speed `c`, breaking `b ∈ [0, 1]`.

```
s    = dir·xz − front(t) + 0.12 W sin(0.011 q + 1.3) + 0.06 W sin(0.037 q + 0.4)     q = lateral coordinate
H    = H₀ · amplitude · (1 + 0.16 sin(0.017 q + 0.5) + 0.06 sin(0.083 q + 0.9)) · clamp((60/d)^¼, 1, 1.8)                    Green's law
fold = 0.73 + 0.27 sin(0.043 q + 1.4) cos(0.013 q)
b'   = fold · max(b, smoothstep(0.45, 0.95, H/d))                                           depth-induced breaking
w_f  = W mix(0.6, 0.24, b') ,  w_b = 1.6 W
crest  = sech²(s / (s > 0 ? w_f : w_b))
bore   = s < 0 ? 0.3 (1 − smoothstep(−2.5 w_b, 0.4 w_b, s)) e^{s/(12 W)} : 0
trough = −0.1 exp(−((s − 2.4 w_f)/(1.6 w_f))²)                                       drawdown before arrival
η      = H (max(crest, bore) + trough)
```

The mesh and physical probes share this plunging lip profile.

```
lip     = b' smoothstep(0.42, 1, crest)
forward = lip · H · (0.62 + 0.75 crest)       horizontal throw along dir
drop    = lip² · H · 0.2                      the tip starts to fall
```

**Crest ribbon (adaptive tessellation).** While a wave is active a dense strip rides the
crest: 1800 m along the crest (≈ 3–5 m spacing), `±2.7 W` across it with rows concentrated
at the lip (`z' = sign(z)|z|^1.9`, ≈ 0.4 m). It uses the same material; the polar grid
discards fragments inside the strip's footprint (8 m overlap). The lip silhouette stays
smooth at any distance. The strip's pipeline is pre-warmed so launching a wave never hitches.

The vertex stage evaluates the deformation at `xz`, `xz + (ε, 0)`, `xz + (0, ε)` to build a
tangent frame; cascade slopes are applied inside that frame. The dense mesh carries the crest, lip and bore coverage into the fragment stage. Local turbulence breaks up the foam along that mesh.

## Hydrodynamics

The displaced surface has height `η − drop` at longitudinal coordinate `s + forward`. Hull probes and the camera waterline invert this horizontal displacement. They bracket the exposed branch at the crest and check the leading turning point when the sheet folds over. Spray originates at the displaced lip. Flow under the wave (solitary-wave theory):

```
u = min(c, c η/(d' + η) + 0.8 c b crest²) ,   d' = clamp(d, 2, 40)
```

Buoyancy drag acts on `v_body − u`, so the bore carries vessels with it.

## Crest effects

Three random emitters per frame along the crest near the focus: spray thrown forward at
`0.95 c` with `3 + 0.22 H` m/s lift; mist curtain behind the crest; foam sources at the
foot of the face. Camera rumble increases with proximity. The engine emits one standalone `waveBreak` event on arrival.

## Still pools and tidal beaches in Three.js

Pass `tide` in `OceanOptions` or call `ocean.setTide({ amplitude, periodSeconds, phase })` while playing. The surface datum is `waterLevel + amplitude * sin(2π * (phase + elapsed / periodSeconds))`, in world metres. Phase is measured in cycles from the time of the call. A phase of 0 starts at mean water rising, 0.25 at high water and 0.75 at low water. A period of 44,700 seconds gives a semidiurnal example. The showcase accelerates the cycle to 120 seconds.

Give an intertidal beach a bed with elevations on both sides of mean water. The water mesh, wet-sand strip, underwater boundary, buoyancy samples and registered world-water footprint follow the moving datum. `flowAt` includes the vertical speed of the tide. This harmonic model describes local water level. For a horizontal inlet current, use a separately authored flow. Call `setTide()` to restore mean water.

For a sheltered reflecting pool use `OCEAN_PRESETS.still` at both ends of the morph, zero breaker height and zero rain. A passing boat or helicopter can still disturb it locally. For long swell on a windless day start with `OCEAN_PRESETS.swell` and set `windSpeed: 0`. Tide, incoming swell and local wind waves are independent controls.

A receding tide leaves a damp band on the exposed bed. Set `BathymetryOptions.shoreDryingSeconds` to the decay time in simulation seconds (default 900, zero for immediate drainage). Rising water updates the mark immediately. Damp sand retains its darker diffuse appearance after the glossy surface film drains. A point in this band can already be dry for hulls and wheel contacts.

Seabed caustics trace the solar ray through the air–water interface. Local wind waves and residual swell control focusing strength. A still pool has no moving wave caustics.

## Short surf cycle

The breaker phase varies along the shore. A continuous fundamental and first harmonic drive the steep face, and the rising swash carries more foam than the draining sheet. `Ocean.heightAt` and batched hull samples include the same breaker used by the shader. `flowAt` includes its vertical velocity. The world water query checks the displaced height against the bed near the intertidal edge. Short-term sand sheen follows the local swash phase; the slow high-water mark controls pore moisture left behind by the tide. Setting `breakerHeight` to zero removes the moving swash.
