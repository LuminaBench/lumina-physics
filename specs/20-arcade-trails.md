# 20 · Visual arcade trails (`TracerField`)

Source: `modules/ballistics/index.ts` (`TracerField`, `ImpactCard`, `ImpactSurface`).

Lightweight, pooled visual trail module for skipping stones, sparks, and generic arcade streaks
against artist-authored collision cards. All parameters are generic scene-unit artist controls
(no real-world weapon data or ballistics tables).

## Pooled integration

`new TracerField(engine, fx, capacity = 96)` allocates a fixed ring buffer of `capacity` slots and a
single `THREE.LineSegments` draw call (`LineBasicNodeMaterial` with warm HDR emissive colour
`(2.8, 1.7, 0.65)`). `launch(position, velocity)` activates the next ring slot with lifetime `age = 4 s`
and `skips = 0`.

Each frame (`dt > 0`), active slots integrate in scene units (`gravity = 9`, `drag = 0.13`):

```
W    = engine.wind.sample(p, time)
v   ← lerp(v, W, 1 − exp(−drag · dt))
v.y −= gravity · dt
p_1  = p + v · dt
```

Each active trail draws one line segment from `p` to the resolved end position `p_end`, updating only
the active vertex slice (`addUpdateRange(0, count * 3)`).

## Artist-authored `ImpactCard` intersections

`addSurface(card)` registers an oriented rectangular collision card (`kind: 'water' | 'steel' | 'wood' | 'glass'`,
`center`, unit `orientation` quaternion spanning local `+X` (`width`), `+Y` (`height`), and `+Z`
(`normal` facing incoming trails), plus optional `breakaway?: boolean`) and returns an unregister callback.

For every active segment `p → p_1`, the earliest front-to-back plane crossing
(`d_0 = (p − c)·n > 0` and `d_1 = (p_1 − c)·n ≤ 0`) inside `|local.x| ≤ width/2`, `|local.y| ≤ height/2`
triggers at fraction `f = d_0 / (d_0 − d_1)`:

1. **Impact particles (`EffectsKit`).** Emits `14` particles along `card.normal` at the hit point:
   `water` → `fx.spray`, `steel` → `fx.sparks`, `wood` / `glass` → `fx.dust`.
2. **Response branch** (`v_n = v · n`, `shallow = (−v_n < 0.55 |v|)`, `brittle = kind ∈ {'glass', 'wood'}`):
   - **Breakaway visual exit** (`brittle && card.breakaway`): scales `v ← 0.74 v`, emits `5` exit
     particles offset `−0.08 n` along `v`, increments `stats.exited`, and continues for the remaining
     `(1 − f) dt`.
   - **Shallow skip** (`!brittle && shallow && skips < 3`): reflects velocity with energy loss
     `v ← (v − 1.65 v_n n) · 0.78`, increments `skips` and `stats.skipped`, and continues for
     `(1 − f) dt`.
   - **Stop**: sets `age = 0`, increments `stats.stopped`, and ends the segment at the hit point.

`stats` tracks `{ launched, skipped, exited, stopped }` for telemetry and gameplay hooks.
