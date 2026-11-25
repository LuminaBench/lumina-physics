# 08 · Fire, explosions and destruction

Source: `modules/fire/explosions.ts`, `engine/particles.ts`, `engine/fx.ts`.

Burning volumes taper soot density before the outer boundary. Pier and water impacts distribute a fixed spray budget between uneven crown lobes and falling droplets. The instanced debris pool draws timber, masonry and steel fragments with distinct forms and cooling highlights.

## Particle integration (GPU)

```
a  = (0, −9.81 g + B·T, 0) + drag (W(p) − v) + turbulence
v += a dt ;  p += v dt ;  T *= e^{−cooling dt}
floor: bounce ? v ← (0.72 v_x, |v_y| restitution, 0.72 v_z), T ×0.78 : kill
```

| Pool | gravity | drag | buoyancy B | cooling | notes |
| --- | --- | --- | --- | --- | --- |
| spray | 1 | 0.35 | – | – | velocity-stretched micro-droplet streaks (1/22 s shutter), dies at the surface |
| mist | 0.03 | 1.3 | – | – | wind-borne wispy veils, turbulence 0.9 |
| smoke | 0 | 0.9 | 9 | 0.5 | soot albedo 0.012 → 0.085, sphere-normal lighting |
| fire | 0 | 1.6 | 7 | 1.5 | additive blackbody |
| sparks | 1 | 0.25 | – | 0.55 | bounce 0.5, velocity-stretched |
| dust | 0.08 | 1.8 | – | – | ground rings |

Blackbody ramp for normalised temperature `x`:
`rgb = (clamp(3.2x)^0.9, clamp(1.9(x − 0.22))^1.6, clamp(2.6(x − 0.62))^2.2) · (14x² + 1.6x)`.

Spray sprite: ribbon of length `1.5 w + |v|·0.045 s`, width `0.34·size` (≥ 1 px); alpha =
lateral falloff × soft ends × `(0.16 + 0.95·beads)` where `beads = smoothstep(0.52, 0.82,
noise(x, y·aspect))` breaks the streak into separate droplets. Mist sprite: soft disc eroded
by two drifting noise octaves. Every volumetric sprite fades as the camera enters it
(`smoothstep(0.45 s + 0.15, 1.9 s + 0.8, distance)`): no cotton balls, no white-outs.

Smoke is dark because it is lit, not tinted: wrapped diffuse `smoothstep(−0.35, 1, N·L)^1.6`,
self-shadow `mix(0.18, 1, smoothstep(−0.6, 0.6, y + noise))`, plus an inner blackbody glow
while young.

Blended sprites must leave the normal / velocity MRT attachments untouched: output
alpha 0 there **and** set the attachment blend mode to the material's blending.

## Archetypes (yield scale `s`)

| | Petrol fireball | C4 / HE | Water geyser | Electrical arc |
| --- | --- | --- | --- | --- |
| Flash | orange 0.5, decay 7/s | white 4.2, decay 30/s | pale 0.35 | strobing blue 1.5, decay 42/s |
| Light (cd) | 5.5·10⁴ s² e^{−1.5t} | 4.5·10⁵ s² e^{−16t} | – | 9·10⁴ s per flicker |
| Fire | burst 9 m/s + thermal rising 7.5 m/s for 1.5 s, then ground fire | 0.3 s, 23 m/s, T = 1.35 | – | – |
| Smoke | black column 8.5 s, T = 0.38 | grey puff 4.6 s | – | wisps |
| Shockwave | 190 m/s, 34 s m | 340 m/s, 115 s m, strength 1.7 | 240 m/s, 55 s m | – |
| Debris | 7 s hot fragments | 30 s fragments, 13–34 m/s | – | 14 s Rapier sparks, restitution 0.78 |
| Blast (N·s / radius) | 900 s / 15 s | 5200 s / 32 s | 3400 s / 34 s (up-biased) | 240 s / 7 s |
| Wind blast | 15 s | 42 s | 22 s | 8 s |
| Trauma yield | 0.6 s | 1.6 s | 0.85 s | 0.32 s |
| Water | cavity −0.55 s if over water | cavity −1.2 s + spray | cavity −2.0 s, radius 6.5 s | – |

Water geyser timeline: 0–0.6 s vertical column (`44 √s` m/s spray + `17 √s` mist core);
0.08–0.95 s base surge ring at 15 s m/s; 1.7–3.6 s fall-back foam sources 3–18 s m out.

## Coupling checklist for a new archetype

1. `physics.applyBlast(center, radius, impulse, upBias)`
2. `wind.addBlast(center, strength, 2·radius)`
3. `ocean.field.addSource({ impulse, foam })` when within 5 m of the surface
4. `trauma.blast(distance, yield)` + optional `engine.flash`
5. `engine.events.emit('explosion', payload)`

## Sustained fire in varying weather

`explosions.ignite(position, size, seconds, { rainExposure, followsWater })` returns the ID accepted by `extinguish(id)`. Use full rain exposure for an exposed fire, or reduce it under a canopy. Local spray can still quench a sheltered flame. Quenching emits a finite condensate plume in proportion to lost flame strength. Submerging a fixed fire immediately cuts new flame, soot, sparks and world heat. Condensate rises from the registered waterline as the fuel cools. Set `followsWater: true` for a floating fuel fire that rides the registered surface. Each active fire publishes local heat, responds to wind and reduces light, sparks and plume strength as it dies out. Particle counts are artistic controls.

## Fuel released by a moving game vehicle

A host can pass its vehicle velocity in world metres per second at the instant a visual cue fires. The detached flame volume and emission point inherit that motion, slow as they mix with air and leave smoke behind. Set `airborne` for a free-air release. A surface release can continue burning at the site. The caller owns the vehicle's damage state, mesh visibility and controls.

```ts
explosions.detonate({
  kind: 'petrol', position, yield: 0.8, debris: false,
  fuelCarrier: { velocity: vehicleWorldVelocity, airborne: isInAir },
});
```

Preview **Vehicle fuel burst** on the highway and **Airframe fuel burst** in the jet scene. Airbursts outside the surface interaction range leave the ground undisturbed.
