# 10 · Cloth and rope

Source: `modules/cloth/` (`gpu.ts` WebGPU compute, `cpu.ts` reference + WebGL 2 solver).

Every piece is a `cols × rows` grid of particles (a rope has one row). All pieces share one
set of arrays, so a scene is solved by a fixed number of passes however many pieces exist:

```
position  xyz + inverse mass (0 = pinned)      rest    local pin position + piece id
previous  xyz one substep ago                  tether  local anchor + maximum distance
```

## Step (per substep h, 2 substeps on GPU, 1 on CPU)

```
n   = (p_right − p_left) × (p_down − p_up)            surface normal, un-normalised
v   = (p − p_prev) / h
w   = wind(p) + flutter(p)                            shared wind field incl. blast fronts
rel = w − v
F   = k_t · rel + k_n · n (n·rel) / |n|²              skin drag + pressure drag
      rope:  k_n · (rel − t (t·rel) / |t|²)           cross-flow drag on a cylinder
      + inflate · n̂ · sign(n · (p − origin)) · max(rel.y, 0)     ram-air canopies
p'  = p + v h (1 − damping·h) + (F + g·gravity) h²
```

Flutter is what makes steady wind move cloth: a travelling wave in the cross-wind direction,
`(0.34 sin(3.1 a − 1.3 |w| t + 1.7 y) + 0.2 sin(7.3 a − 2.9 |w| t − 2.3 y)) · |w|`, where
`a` is the distance along the wind.

Constraints (position based, inverse-mass weighted): structural ±1 (rest dx, dy, weight
`stiffness`), shear diagonals (weight 0.6·stiffness), bend ±2 (weight `bend`·stiffness).
The CPU solver is Gauss–Seidel (each pair once per iteration, 5 iterations). The GPU solver
is Jacobi: read buffer A, write buffer B, each particle sums the corrections of its 12
neighbours and applies them scaled by 1/3.4 (the largest total weight a particle can
receive); 7 iterations, an odd count so the result lands back in A.

Then, per particle: tether `|p − M·anchor| ≤ L`, sphere colliders, ground plane.

**Long-range attachment.** Each free particle of a flag, banner or sail is tethered to its
pinned edge with `L = 1.03 ×` the rest distance along the cloth. This removes the stretch a
low iteration count would otherwise show, at the cost of one distance test.

| Preset | pins | k_n | k_t | gravity | damping | notes |
| --- | --- | --- | --- | --- | --- | --- |
| flag | hoist edge | 6.5 | 0.35 | 0.55 | 0.25 | 28 × 18 |
| banner | top edge or top corners | 5.5 | 0.3 | 0.8 | 0.4 | 30 × 14 |
| sail | yard (+ mast), clews tethered to sheets | 9 | 0.2 | 0.7 | 0.6 | 26 × 30 |
| parachute | none; every point tethered to the payload | 9 | 0.6 | 0.3 | 0.9 | inflate 5 |
| rope | both ends (or one) | 1.1 | 0.02 | 1 | 0.45 | rest length = span × slack |

Rope start pose: parabola with sag `span · √(3 (slack − 1) / 8)` (first-order catenary).

## Rendering

Vertices read the solver directly (storage buffer on WebGPU, a float texture on WebGL 2);
normals come from the four grid neighbours; motion vectors from the previous-frame
positions. Fabric transmits `albedo · sun · max(−N·L, 0) · translucency / π`. All ropes of
a system share one camera-facing ribbon (never thinner than 0.0007 × distance).
