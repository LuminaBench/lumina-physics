# 18 · Inflatable soft bodies

Source: `modules/softbody/*` (`softbody.ts`, `types.ts`, `mesh-gen.ts`, `presets.ts`, `gpu.ts`, `cpu.ts`).

Every soft body is a welded closed manifold triangle mesh with structural edge springs, opposite-triangle
bend springs, internal antipodal cross-bracing struts, and ideal-gas internal pressure. Up to
`MAX_SOFT_BODIES = 32` bodies pack into shared flat arrays so WebGPU compute (`gpu.ts`) and the CPU
reference / WebGL 2 fallback (`cpu.ts`) execute the same physics.

## Topology generation (`mesh-gen.ts`)

`topologyFromGeometry(geometry, { weldTolerance?, internalStruts?, bendSprings?, pinned? })` welds
coincident vertices, centres the rest pose, verifies outward CCW winding by computing signed rest volume:

```
V₀ = (1/6) Σ_t  a · (b × c)        (flips triangle winding if V₀ < 0)
```

and builds up to `MAX_VALENCE = 14` springs per vertex:
- `kind = 0`: structural triangle edges
- `kind = 1`: opposite-triangle bend pairs + antipodal cross-bracing struts (`p_i · p_j < 0`, farthest vertex)

Built-in topology generators: `sphereTopology` (icosahedron), `boxTopology` (corner-puffed subdivided
box), `buoyTopology` (capsule), `torusTopology` (horizontal torus).

## Per-substep dynamics (3 substeps / 7 Jacobi iters GPU; 2 substeps / 5 Gauss–Seidel iters CPU)

1. **Area-weighted normals & exact signed volume.**
   For each triangle `(a, b, c)`, accumulate `(1/6)((b − a) × (c − a))` onto each vertex; its magnitude
   is the dual vertex area `A_i` and its unit direction is `n̂_i`. Body centroid `c` and exact signed
   volume `V = (1/6) Σ (p_a − c)·((p_b − c) × (p_c − c))` are computed in 1 thread per body on GPU
   (no float atomics).

2. **Ideal-gas internal pressure.**
   When punctured (`leakRate > 0`), `pressure ← max(0, pressure − leakRate · Δt)`. Otherwise:
   ```
   V_target      = V₀ · max(0.2, inflation)
   pressureScale = pressure · 45 · max(0.5, mass / max(restArea, 0.25))
   P_gas         = pressureScale · clamp(V_target / max(V, 0.15 V₀), 0.25, 3.8)
   F_pressure,i  = n̂_i · A_i · P_gas
   ```

3. **External forces & Verlet integration.**
   ```
   v     = (p − p_prev) / h
   F_i   = F_pressure,i + (0, −9.81 · gravity · m_i, 0) + airDrag · m_i · (wind(p) − v) + F_water,i
   p'    = p + v · h · max(0, 1 − damping · h) + (F_i / m_i) · h²
   ```
   **Water buoyancy (`WaterSurfaceLike` — `Ocean`, `InlandWater`, or flat `waterLevel`):**
   ```
   sub   = clamp((η − p.y) / max(0.12, 0.45 restRadius) + 0.25, 0, 1)
   F_b,y = 1025 · 9.81 · displacedPerVert · sub
   F_d   = −(waterDrag + 0.65 |v − u_flow|) · sub · m_i · (v − u_flow)   (×1.35 vertical)
   ```
   On WebGPU, a lightweight CPU center-of-mass proxy samples the local ocean height/slope plane
   `(nx, η, nz)` and flow velocity, emits water wake sources + splash events, and feeds impulses back
   to dynamic Rapier rigid bodies without GPU readback.

4. **Spring relaxation & collisions.**
   Each spring `(a, b)` with rest length `L` and weight `w = kind === 0 ? stiffness : stiffness · strutWeight`
   projects inverse-mass-weighted error `(len − L) / len`. GPU Jacobi sums all `≤ 14` incident spring
   corrections scaled by `JACOBI_SCALE = 1 / 4.2` across an odd iteration count so the result lands in
   buffer `A`. Collisions push vertices out of `groundY`, up to `16` sphere colliders, and up to `12`
   oriented box colliders (automatically synced from nearby Rapier balls, cuboids, capsules and cylinders
   when `syncRapierColliders` is true) with `restitution`, tangential `friction`, two-way Rapier impulse
   coupling, and `impact` events.

## Presets & API (`SoftBodySystem`)

| Preset | Builder | Default shape | Pressure / inflation | Mass (kg) | Buoyancy |
| --- | --- | --- | --- | --- | --- |
| Beach ball | `soft.ball(o)` / `sphere(o)` | icosphere `r = 0.65` | `2.0` / `1.02` | `4.5` | `1.2` |
| Air cushion | `soft.cushion(o)` / `box(o)` | `1.8 × 0.55 × 1.2 m` | `1.6` / `1.0` | `12` | `1.1` |
| Marine buoy | `soft.buoy(o)` | capsule `r = 0.42, l = 0.9` | `2.2` / `1.03` | `14` | `1.35` |
| Life ring | `soft.torus(o)` | torus `R = 0.72, r = 0.26` | `1.9` / `1.02` | `6.5` | `1.4` |
| Custom | `soft.custom(geo, o)` | any closed `BufferGeometry` | default `1.8` / `1.0` | `8` | `1.0` |

Live controls on `SoftBody`: `inflate(pressure, inflation)`, `puncture(leakRate)`, `kick(velocity)`,
`impulseAt(point, velocity, radius)`, `reset(position, quaternion)`, `getCenter()`, `getVelocity()`,
`vertex(index)`. System controls: `setWater(water)`, `addSphereCollider`, `addBoxCollider`,
`coupleRapierBody`, automatic `PhysicsWorld.onBlast` coupling, and frustum/distance sleeping (`sleepDistance`).
Shading uses `MeshStandardNodeMaterial` reading live positions, normals and previous-frame velocity
(`auxSurface`) with procedural patterns (`solid`, `beachball`, `stripes`, `buoy`, `checker`) and backlit
vinyl translucency.
