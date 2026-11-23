# 02 · Water optics

Source: `modules/water/ocean.ts`, `modules/water/seabed.ts`, `engine/ssr.ts`.

The water surface renders in the transparent pass with depth write on, so it can read the
opaque scene colour + depth and still occlude particles.

```
V = normalize(camera − P),  N = surface normal (cascade slopes + interaction field + breakers + micro detail)
F = 0.02 + 0.98 (1 − N·V)⁵                         Schlick
F ← mix(F, 0.62 F + 0.02, min(1, 6 σ²))            rough-sea grazing correction (σ² = unresolved slope variance)
```

## Reflection

`R = reflect(−V, N)`, `R.y ← |R.y|`. Environment radiance comes from the weather module's
equirect map (atmosphere + raymarched clouds), mip level `7·roughness`. With SSR enabled
the fragment traces `R` against the opaque depth buffer (geometric step growth 1.12,
temporal jitter, 5-step binary refinement) and **mixes the hit over the environment**
(`mix(env, hit, hitWeight)`), so hulls and aircraft occlude the sky.

Sun glitter: GGX with `α² = 0.0007 + ½σ² (+ rain)`, clamped to 90 scene units:

```
D = α² / (π ((N·H)² (α² − 1) + 1)²)
L_sun = E_sun · shadow · D · F(V·H) · (N·L) / (4 (N·L)(N·V) + 0.02)
```

## Refraction + Beer–Lambert

```
column = (sceneViewZ − surfaceViewZ) · |P − camera| / surfaceViewZ          path length under water (m)
T      = exp(−a · column)                         a = absorption (1/m, RGB)
body   = background(refractedUV) · T + scatter · E_down · (1 − T)
E_down = E_sun max(L.y, 0) shadow / π + ambient
```

Refracted UV = `screenUV + viewNormal.xy · 0.045 · smoothstep(0, 1.5, column) / (1 + 0.04 z)`;
if the offset sample lies in front of the surface the unrefracted UV is used (no leaking).

Clarity `c ∈ [0, 1]`, `murk = mix(5.5, 1, c)`:

```
a       = (0.42 (0.6 + 0.4 murk), 0.063 murk, 0.019·0.6·murk² + 0.008)   1/m
scatter = (mix(0.018, 0.0035, c), mix(0.05, 0.021, c), mix(0.035, 0.05, c))
```

Clear water (c ≈ 0.95): white sand under 1–4 m reads turquoise, > 30 m converges to navy.
The seabed attenuates its own illumination by `exp(−a · depth / sun.y)` so both legs of
the light path are accounted for.

## Subsurface scattering

```
back   = max(0, V · −normalize(L.x, −0.15, L.z))³           looking toward the sun
thin   = smoothstep(0.1, 1, η / (0.5 Hs + 0.15)) · (0.3 + 0.7 (1 − N·V))
SSS    = (0.02, 0.36, 0.30) · E_sun/π · shadow · (0.55 back·thin + 0.45 lip·(0.2 + 0.8 back))
```

`lip` comes from the tsunami deformation: the overturning crest glows translucent.

## Caustics (seabed)

Four directions of travelling surface waves define a curvature matrix at the refracted
sun position on the sand. Adjacent light rays concentrate when their projected
footprint narrows. For each color channel the shader evaluates

```
J = det(I − opticalTravel · curvature)
I = 2.7 (blur / (|J| + blur))² · exp(−0.16 depth) · smoothstep(0, 0.4, depth)
```

Optical travel differs slightly across red, green and blue, separating the narrow
focal lines in shallow water. A finite focus width softens them with depth.
Cloud shadows attenuate the result.

## Foam

`amount = FFT foam · gain · shoal + min(0.34·field foam, 0.9) + shore + tsunami`.
Mask = `smoothstep(1 − 0.72a, 1.34 − 0.72a, lace + 0.12a)` with `lace` = drifting fBm, so
thin foam is lacy. Albedo `mix((0.5, 0.56, 0.56), 0.93, thickness)` × bubble noise
(0.78–1): a bubble raft, never flat white paint. The sun term is wrapped
(`(N·L + 0.55) / 1.55`) because foam is a multiple-scattering medium: white water on a
shadowed face (the underside of a breaking lip) stays bright.

## Seabed shadow

Cast shadows on the seabed are filled in by light scattered in the water column:
`shadow' = shadow (1 − f) + f`, `f = 0.82 (1 − e^{−0.2 depth})`, with a wide PCF penumbra
(radius × 1.6, 16 taps). Deep shadows are soft and faint instead of hard, noisy cut-outs.
