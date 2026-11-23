# 04 · Interaction field, wakes and buoyancy

Source: `modules/water/interaction.ts`, `modules/water/buoyancy.ts`, `showcase/actors/beaver.ts`.

## 2D wave + foam field

A scrolling `R²` half-float target (extent `E` metres) centred on the action and snapped
to whole texels (the scrolled copy is exact). State per texel: `(h, v, foam)`.

```
lap  = h_L + h_R + h_D + h_U − 4h
v   += c² lap dt / cell²                 c ≤ 0.68 cell/dt  (CFL)
v   *= e^{−damping dt}
h   += v dt
foam = (0.82 foam + 0.045 Σ neighbours) e^{−decay dt} + 2.5 dt max(0, 9|lap| − 0.55)
```

Sources (≤ 16 per frame), Gaussian `g = exp(−2.5 |x − x₀|²/r²)`:

| Field | Effect | Typical use |
| --- | --- | --- |
| `push` (m/s²) | `v += push · g · dt` | hull bow pressure (−), jet downwash (−), prop wash |
| `impulse` (m) | `h += impulse · g` (one frame) | blast cavity (−), splash, slam |
| `foam` (1/s) | `foam += foam · g · dt` | stern wash, spray fall-back, tire aeration |

A 5 % absorbing border prevents reflections. The ocean adds `h` to vertex height, the
central-difference slope to its normal and `0.34·foam` to its foam amount.

## Kelvin wake

A point source moving at `U` through a medium with phase speed `c` leaves a V of
half-angle `asin(c/U)`. `matchKelvin(U)` sets `c = clamp(U sin 19.47°, 2.2, 9)` so the
wake of the tracked vessel opens at the Kelvin angle. Per float / hull:

- bow: `push = −34 · planing · submersion`, radius 1 m → divergent arms,
- stern: `foam = 5.5 · planing` → aerated turbulent wash,
- centreline 6.5 m and 11 m aft: `push = −5`, `foam = 2.6` → **wake convergence** where the
  two float wakes meet,
- `planing = smoothstep(1.5, 14, U)`.

Bow spray: two sheets per bow, velocity `0.55 v_hull ± right (1.6 + 0.22 U) + up (1.6 + 0.2 U)`.
Slam (vertical impact > 2.2 m/s on a nearly dry point): impulse `−0.05 · slam` + spray burst.

## Multi-point buoyancy

For each sample point `i` (body space, e.g. 4 per float) every fixed 1/60 s step. The
surface is sampled from the two longest cascades only (swell + wind sea): shorter cascades
are centimetre ripples that would make a hull buzz.

```
depth_i = η(p_i) − p_i.y
sub_i   = clamp(depth_i / draft + ½, 0, 1)
F_up    = ρ g (V/n) sub_i                              ρ = 1025
v_rel   = v_body(p_i) − u_water(p_i)                   (tsunami flow)
F_drag  = −(k₁ + k₂|v_rel|) sub_i · v_rel              horizontal
η̇_i     ← lerp(η̇_i, (η_i − η_i,prev)/dt, 0.2)          low-passed surface rate
c       = 2 ζ √(k_h m) / n ,   k_h = ρ g V / draft     ζ = 1 → critically damped
F_heave = −c (v_y − clamp(η̇_i, ±6)) min(1, 4 sub_i) − k₂ |v_y| v_y sub_i
F_keel  = −keel · (k₁ + k₂|v_rel|) sub_i · (v_rel·right) right
```

The damper acts on vertical velocity **relative to the rising / falling surface**, so the
hull follows swells instead of fighting them, and is sized from the hydrostatic stiffness
and the body mass so any hull settles without bobbing. Forces are applied at `p_i` (pitch
and roll emerge). Reset both force **and torque** accumulators each step before adding
(Rapier keeps them otherwise).

Waterline trim: choose `V = m / (ρ · 0.5)` so the hull rests half submerged, and put the
sample points at the design waterline. Beaver rig: `V = 4.7 m³`, `draft = 0.7`, points at
`y = 0.1`, `k₁ = 60`, `k₂ = 18`, `ζ = 1`, `keel = 6`, mass 2300 kg → floats ~49 % submerged,
~1.5° nose-up, ~9 m/s at 90 % taxi power.

## Render interpolation

Physics runs at a fixed 1/60 s (frame `dt` clamped to 0.05 s). Every bound object stores the
previous and current step's pose and is drawn at `lerp / slerp(previous, current, α)`,
`α = accumulator / (1/60)`. Cameras and effects read that pose, never the raw body state.
Measured on the Beaver at 8 m/s: per-frame step jitter 0.5 %, identical at half speed
(render rate ≠ physics rate).
