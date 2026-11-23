# 07 · Extreme aerodynamics

Source: `modules/aero/aero.ts`, `trails.ts`, `flight.ts`.

Input: kinematic state `(position, quaternion, velocity, gLoad, throttle)`.
Pass world-space velocity in m/s. The module computes Mach from speed relative to the local wind. With an air temperature in °C, the local speed of sound is `sqrt(1.4 × 287.05 × (airTemperatureC + 273.15))` m/s. An explicit temperature overrides the world climate profile. Without either input the fallback is 340.3 m/s. Height over water is `y − η(x, z)`. [NASA Glenn on Mach and temperature](https://www.grc.nasa.gov/WWW/BGH/sound.html)

## Jet-over-water downwash (altitude < 70 m)

```
proximity = (1 − altitude/70)^1.6
energy    = proximity · clamp(|v|/140, 0.25, 2.4)
dwell     = max(|v|, 40)/100            push ∝ speed → imprint independent of dwell time
footprint = 6 + 0.45 altitude
```

| Field source | Position | radius | push | foam |
| --- | --- | --- | --- | --- |
| Pressure trough | under the fuselage | footprint | −9 proximity·dwell | 2.2 energy |
| Vortex furrows ×2 | wingtips, `14 + 0.3 alt` m aft | 0.6 footprint | −4 proximity·dwell | 1.6 energy |
| Exhaust scour | 18 m further aft | 1.4 footprint | −4 proximity·dwell·(0.4·smoothstep(0, 0.18, power) + power)·(1.8 if M > 1) | 3.5 energy·power |

The pooled exhaust scour follows the lateral center of operating nozzles and their mean combustion power. All engines off leaves the fuselage trough and wing furrows. The trough travels with the aircraft; released water rebounds as radial ripples.
Wing-skirt droplets start 10–26 m aft with lateral ejection, 0.16× aircraft velocity and an initial rise of `9 + 13 energy` m/s. A depth-clipped ten-sample spray volume describes the two rising sheets and their return to the trough. Its height follows proximity and speed.
Mist curtain: `0.07 v + (3 + 5 energy) up`, size 3 → 13–21 m, life 6.5 s.

## Prandtl–Glauert vapour cone

```
I(M) = smoothstep(0.93, 0.992, M) · (1 − smoothstep(1.015, 1.065, M)) · clamp(1.25 humidity)
```

Nine samples integrate condensation through the visible air between the wing shoulder and a flat cutoff 0.31 wingspans aft of the rig origin. The diameter increases with Mach, Cartesian noise moves aft, and aircraft depth clips the optical path.

## Sonic boom (Mach crosses 1 upward)

- The visual shell expands at 300 m/s to 650 m. Refraction strength is 0.45 and condensation increases with local humidity.
- wind blast 55 m/s over 260 m, rigid-body blast 2400 N·s over 260 m, camera trauma,
- if `altitude < 220 m`: water impulse `−1.3 (1 − alt/220)` over `18 + 0.7 alt` m + mist burst,
- The crossing emits one `sonicBoom` event. It rearms at Mach 0.98. Each aircraft excludes its own pressure pulse from its incoming wind measurement. Other objects still receive that pulse.

## Vortices, contrails, haze

- Wingtip ribbons use local liquid-water relative humidity, speed and absolute load factor. Supply `AeroState.relativeHumidity` (0–1) from the atmosphere at the wing. The fallback is `aero.params.humidity`. Samples retain their birth strength, spread from 0.22 to 1.5 m, drift with their release wind and the negative lift direction and evaporate over 1.6 s. Leaving humid air detaches the last visible sample. Re-entering humid air or teleporting starts a separate strip while the first one ages.
- Nozzle trails use local air temperature and humidity over ice when provided, or the authored `contrailAltitude` band. Lifetime is capped at 22 s and width grows from 1.4 to 16 m. At the nozzle the trail starts transparent. Ice starts to show after 0.20 s, leaving a longer clear gap at higher airspeed. The eddy pattern travels with each released sample. For custom ribbons set `TrailOptions.formationSeconds`, default 0. Sample spacing grows with airspeed to preserve the full lifetime on a continuous pass within 120 points per nozzle.
- Exhaust heat haze: screen-space refraction billboard, strength `0.55·coreHeat + 0.9·afterburner`. The core cools after throttle cuts and the shimmer disappears as it cools.

## Rotor wash

Call `rotor.step(position, radius, load, dt, surface, landY)`. Radius and height use metres, load ranges from 0 to 1, and `surface` accepts auto, water, soil, sand or snow. Water pressure forms the central dish. Rising droplets and irregular radial sheets trace its edge. See `specs/21-world-coupling.md` for field ownership and land response.


### Nozzle exhaust for custom aircraft

Import `JetExhaust` from the installed aero module. Attach one instance to each nozzle at its exit plane, with local +Z downstream. The constructor takes radius and full-power length in metres, optional inner and outer linear RGB colors, and a height/width ratio for flat nozzles. Feed `setPower(intensity, seconds, aperture)` from your rig’s `setAfterburner(intensity, seconds, coreHeat)` callback. The optional aperture is a linear scale relative to the exit at full opening, clamped to 0.5–1.25. Round exits scale radially and flat exits scale vertically. Use the optional core heat (0–1) for the recessed hardware glow. The controller smooths ignition and cutoff. At idle, the luminous volume drops out while the aero module continues to drive heat refraction. Dispose the plume when its host is removed.

The shader integrates eight depth-clipped samples inside a bounded volume. Front-to-back extinction transmits the exit face through the cooler plume. A cooler shear layer breaks up the outer edge farther behind the exit. Optical distance uses nozzle radii, so the center, translucent fringe and compression cells change with viewing angle. This is an optical approximation.

Set `state.windVelocity` to the game wind at aircraft altitude (world m/s, including vertical motion), or let the module sample Lumina’s 3D wind. Each emitted point keeps this wind during its short simulated life. A climb through wind shear can bend the young and old portions in different directions. The shader brightens vapor viewed toward the sun and uses the sky fill in shadow.

Wingtip and engine trails take different inputs. Keep `relativeHumidity` separate from `iceHumidity` (relative to ice, where values above one are valid) and `airTemperatureC`. This distinction follows the processes described in [NASA’s contrail overview](https://www.nasa.gov/wp-content/uploads/2023/06/contrails-k-12.pdf).


For a banked or inverted aircraft, supply the rig's world quaternion and signed load factor. Override the load-derived drift with `wakeDescentMps` (nonnegative m/s) if the game simulates the wake. Within one wingspan of the configured surface the visual drift transitions toward lateral spread. Zero load suppresses new wing vapor. Each released sample keeps its own velocity. These are visual wake approximations for games. [FAA description of wake behavior](https://www.faa.gov/air_traffic/publications/aim_html/chap7_section_4.html)

In the showcase, **Last light at altitude** puts the aircraft at 8.8 km in a cold air column. Its pale ice trails catch sunlight while the coast darkens. **Low ocean pass** returns to the original sea-level flight. For a custom world use `params.surfaceLevel` as the sea-level datum for trail lighting.

### Independent engine controls

Supply `AeroState.engineThrottles` as an array or typed array in `rig.nozzles` order. Each value is normalized combustion power. Missing or nonfinite channels inherit the collective `throttle`. Keep the array and edit it in place. A cut immediately stops new exhaust ice from that nozzle. Previously released samples drift and age, the flame contracts, then residual core heat and haze decay. Wing vapor continues to follow humidity and load.

Custom rigs can implement `setNozzlePower(index, intensity, time, coreHeat)`. Apply the intensity to that nozzle’s plume, and use the separate heat value for its metal. Older rigs receive the average through `setAfterburner`. With a bundled rig, pass the same commands to `rig.animate(dt, { throttle, afterburner, engineThrottles })` to drive each throat actuator. These are visual engine controls. The host flight controller supplies aircraft motion. In the jet showcase choose **Engine feed → Engine 1 off** to try a cutoff.
