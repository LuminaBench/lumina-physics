# 12 · Thermo: fire spread, char, steam, melt

Source: `modules/thermo/thermo.ts`. A CPU grid (default 96², ≈ 0.4 m cells) at 20 Hz.

Per cell: temperature `T` (°C), fuel `F` (kg/m²), moisture `W` (0..1), char `C` (0..1).
Ambient 22 °C, ignition 280 °C, flame 950 °C, wind lean `ℓ = min(1, |wind| / 14)`.

```
burn      if F > 0, T > 280, W < 0.4:
            r = 0.055 (0.35 + 0.65 min(1, (T − 280)/320)) (1 − W/0.4) (0.75 + 0.5 ℓ)
            F −= r F₀ Δt ;  T += (950 − T) · 2.6 Δt ;  C = max(C, 1 − F/F₀)
rain      W += 0.5 rain Δt ;  T −= 0.9 rain (T − 22) Δt
boil      if W > 0, T > 100:  b = min(W, 0.00044 (T − 100) Δt) ;  W −= b ;  T −= 520 b
cool      T −= (0.16 + 0.1 ℓ)(T − 22) Δt
spread    for the 8 neighbours j, direction j→i against the wind unit vector ŵ:
            bias = 1 + 2.2 ℓ max(0, a) − 0.75 ℓ max(0, −a) ,  a = −(d̂_ij · ŵ)
            T_i += conduct · Σ (T_j − T_i) bias / |d|
            unburnt fuel:  T_i += (26 + 60 ℓ) Δt (1 − 0.85 W) · Σ burn_j bias² / |d|
```

The finite boil-off rate is what separates the cases: light rain is flashed to steam and
only cools a fire; heavy rain or a hose delivers water faster than 0.35 /s, the fuel soaks
past 0.4 and combustion stops, with steam until the surface drops under 100 °C. Front speed
is ≈ 0.1–0.3 m/s downwind at 9 m/s, a few cm/s upwind.

Bodies read the hottest cell under their footprint:

| Kind | behaviour |
| --- | --- |
| wood | heats at 0.35 /s; ignites above 280 °C; burns for `burnTime`, charring and keeping the ground under it at ≥ 620 °C |
| metal | heats at 0.5 /s, cools at 0.045–0.1 /s; glows `((T − 480)/900)` → red, orange, yellow-white; rain or immersion quenches it in steam |
| ice | melt rate `0.00042 · T_env` /s (× 6 next to flames); meltwater wets and chills the ground |

Output texture: R = T/1200, G = char, B = wetness, A = burn. `surface()` turns it into
scorch (noise-ragged char edge), ember cracks `blackbody(0.66 T)` through two animated
noise networks, and wet darkening. Blasts arrive through `PhysicsWorld.onBlast`: petrol
lays a 1.6 kg/m² film and lights it, water quenches, electrical arcs ignite, C4 adds a
520 °C pulse.

### Rain under roofs

`ThermoField` samples the world's directional rain shelter at each ground cell, each cell on an oriented surface and each thermal prop. A single deck can straddle the edge of a roof. Rain cools the exposed portion while the sheltered portion retains heat. Immersion, `quench3D` and published wetness still work indoors. A standalone `ThermalSurface.step(wind, rain, waterLevel, shelters?)` accepts the same optional shelter collection. [Registration and release](05-wet-road-aquaplaning.md#rain-under-an-overpass)
