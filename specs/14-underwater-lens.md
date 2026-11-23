# 14 · Underwater and wet lens

Source: `modules/water/underwater.ts`, `modules/water/ocean.ts` (underside), `engine/lens-fx.ts`.

## Waterline

For each pixel take the point where its view ray crosses the lens plane (1.02 × near):

```
lens = cam + ray · lensDistance / (ray · forward)
sd   = h + ∇h · (lens.xz − cam.xz) + ripple − lens.y        > 0 → under water
```

`h, ∇h` are the CPU ocean height and slope at the camera. `smoothstep(−2 mm, 2 mm, sd)` is
the split; `|sd| < 4.5 mm` draws the meniscus. The ocean uses the same test to decide where
back faces are the underside.

## Medium

```
σ      = absorption · fog + (0.03, 0.022, 0.02) · fog                 per metre, RGB
T      = e^{−σ d}                                                      d from the depth buffer
ambient = waterColor · 4.2 · e^{−0.3 σ · eyeDepth} · mix(0.55, 1.5, ½ + ½ ray.y)
color  = scene · T + ambient (1 − T)
```

`waterColor = scatter × downwelling` is the colour the surface shader gives deep water; the
factor 4.2 is the ratio of sideways in-water radiance to the upwelling radiance.

God rays: march the view ray (≤ 30 m, 4–10 steps). Sunlight reaching a sample entered the
surface at `p.xz + sunPath.xz · depth / sunPath.y`, where `sunPath` is the sun refracted by
Snell (n = 1.333). Light let through there is a ridged noise network,
`2.6 (1 − |2n − 1|)^3.5`. All shafts are parallel, so along a view ray the entry point
slides at a constant rate: where that slide per step exceeds the pattern scale the samples
are faded to the pattern's mean (0.55) instead of being left as noise, which leaves coherent
rays fanning out from the sun and a smooth glow elsewhere. Phase `0.15 + 0.85 cos⁴`.

## Underside (Snell's window)

```
cos θ_i = N_d · V ,  k = 1 − n² (1 − cos² θ_i)
k < 0  → total internal reflection: mirror of the water body
k ≥ 0  → refracted dir = n(−V) + (n cos θ_i − √k) N_d ;  radiance × n² (compressed sky)
F      = 0.02 + 0.98 (1 − √k)⁵ , blended across the critical angle over k ∈ [0, 0.03]
```

## Lens

Beads: one candidate droplet per hashed cell (13 and 27 cells per screen height), present
when `wetness > hash`, radius on a swell / sit / evaporate cycle, refraction offset
`−d · (0.25 + 0.75 r²)` toward the centre (a tiny fisheye). Runners: one drop per column in
stick-slip motion `y = 1.15 − 1.4 fract(t' + 0.11 sin 2πt')` with a thinning trail. Sheet
after surfacing: a flowing sine distortion decaying over ~1.2 s. Wetness eases toward the
rain level at 0.55 /s and dries over 5 s; splashes set it directly.
