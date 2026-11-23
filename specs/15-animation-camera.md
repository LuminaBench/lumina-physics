# 15 · Procedural animation and camera feel

Source: `modules/animation/`, `engine/camera-feel.ts`, `test-rigs/sports-coupe.ts`.

## Rotor blur

Exposure τ smears each blade over `φ = ω τ`. A blade of angular width `β(r) = chord / r`
covers `β / (β + φ)` of its smear:

```
span     = min(β + φ, 2π/N)
alpha(θ) = [θ' ∈ (0, span)] · min(1, β/span) · density ,  θ' = (θ − angle) mod 2π/N
```

Small φ: N soft blades. `φ ≥ 2π/N − β`: a uniform veil of opacity `N β / 2π`, denser at the
hub. The real blades are hidden once `φ > 0.06 · 2π/N`.

## Actuators

Second-order follower with a rate limit: `v += (ω²(target − x) − 2ζω v) dt`, `|v| ≤ rate`.
Control surfaces: pitch 5 Hz / ζ 0.8, roll 7 Hz / 0.75, yaw 4.5 Hz / 0.85, flaps 1.2 Hz.
Nozzle area: open 0.75 at idle, closing to 0 at military power, opening to 1 in afterburner.
Chassis: pitch = −0.0105 a_long, roll = 0.0125 a_lat (rad per m/s²), 2 Hz, ζ 0.42–0.45,
limits 0.055 / 0.075 rad; the body drops by 0.18 × (|pitch| + |roll|) m.

## Tire tracks

A ring buffer of quads across the direction of travel, one point every 0.22 m; opacity
`(1 − smoothstep(0.25 L, L, age)) · edge`. Lifting or hydroplaning breaks the ribbon.

## Camera feel

```
ideal    = subject − heading_flat · distance + up · height
spring   v += (ω²(ideal − x) − 2ω (v − v_subject)) dt          critically damped, 120 Hz substeps
aim      subject + aimHeight + v_subject · lookAhead, low-passed at 14 /s
lean     −0.012 · bank · a_lat rad, low-passed at 4.5 /s, |lean| ≤ 0.16
fov      base + gain · smoothstep(4, fovSpeed, speed) + clamp(0.12 · accel, −1.5, 3)
hitstop  timeScale × 0.04 for 0.04–0.09 s of real time
```

## Coupe

One lofted shell: 112 cross-sections × 13 control points per side. Belt line, roof arc,
plan taper and floor rise are analytic functions of z; wheel wells are real recesses (shell
vertices inside an arch pushed in to 0.58 m and vertex-coloured dark). Brake light bar:
emissive intensity `1.8 + 22 · brake`; the wet road adds a red pool
`e^{−0.3 b} e^{−x²/(1.1 + 0.3 b)²} (0.1 + 1.5 brake)` behind the car and its streak
reflection toward a following camera.
