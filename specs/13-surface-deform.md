# 13 · Deformable ground

Source: `modules/surface-deform/ground.ts`.

A stamp buffer (256²–1024² by tier) over a square patch: R = compaction (0..1 of the layer
depth), G = berm, B = disturbance. One full-screen pass per frame applies up to 16 stamps:

```
foot = (1 − smoothstep(0.55 r, r, d)) · depth          flat-bottomed footprint
lip  = smoothstep(0.85 r, 1.15 r, d) (1 − smoothstep(1.15 r, 1.9 r, d)) · depth
R ← max(R (1 − recovery), foot) ;  G ← max(G (1 − recovery), 0.6 lip) ;  B ← max(B, foot, 0.7 lip)
height = (0.45 G (1 − R) − R) · layerDepth
```

`track(id, …)` lays stamps along the path since the last call (spacing 0.7 r), so a fast
wheel leaves an unbroken rut, and throws clumps above 2.5 m/s. A follow target recentres
the patch in whole texels; the pass samples the previous buffer at `uv + shift`. Vertices
are authored around the origin and offset by the patch centre in the shader, so nothing
swims. A 128² CPU twin answers `depthAt` for physics.

| Ground | layer depth | grip | rolling drag (N per m/s per wheel) | recovery /s |
| --- | --- | --- | --- | --- |
| sand | 0.09 m | 0.72 | 55 | 0.004 |
| gravel | 0.045 m | 0.81 | 34 | 0.0005 |
| snow | 0.24 m | 0.42 | 70 | 0.0015 |
| mud | 0.16 m | 0.50 | 120 | 0.0008 |

Grip rises by 25 % and drag falls by 60 % inside an existing rut. Shading: normal from the
height gradient one texel apart plus grain noise and, on untouched sand and snow,
`0.2 cos(7.5 x + 2.6 z + 9·noise)` wind ripples faded out by 70 m; compacted sand darkens to
0.4 (damp), compacted snow turns blue and smooth, mud ruts go glossy (roughness 0.1).
Albedos are linear reflectance (dry sand ≈ 0.35).

### Gravel, moisture and tire ejection

Use `new DeformableGround(engine, fx, { center, size, surfaceY, kind: 'gravel', moisture: 0.15 })` for compactable crushed stone. The ground shader uses a tiled field of angular aggregate with filtered facet slopes. Coarse grains follow short ballistic arcs. The wheel emits them per metre of loaded contact, with lateral slip dislodging more chips. Fine dust lifts with distance travelled, contact depth and lateral slip, and then drifts with the wind. The square of the dry fraction controls fine dust. A saturated patch still throws coarse grains.

Pass the wheel's signed rolling speed, rolling direction and lateral speed as the final three arguments to `track`. Lift a wheel with `lift(id)`. Bound separate patches with `contains(x,z)` when composing a course. Set `ground.wetness` to adjust local moisture. Use `ground.wetnessAt(x,z)` at a contact to sample patch moisture, the rain film and local spray sources together. Fine dust stays dry a few metres outside a soaked strip. Changing terrain kind restores that material's baseline moisture.

Rain shelter also applies to loose ground. A wheel or sole under an overhang queries local rain film, authored soil moisture and published spray with `ground.wetnessAt(x,z)`. A dry gravel strip can still emit fine dust beside a rain-soaked strip. [Roof setup](05-wet-road-aquaplaning.md#rain-under-an-overpass)

## Salt plates over mud

Install `salt-crust` for a brittle surface over yielding ground in a Three.js host. Supply a finite survey and the mud height at its vertices. Each seeded salt plate has a raised, split seam. The skin’s thickness, its measured strength at a reference thickness of 16 mm and the local plate variation determine the contact pressure required to break it. `coverAt(x,z)` returns 0–1 for the distribution of salt. Distances and coordinates are in metres, pressure is in kPa and force is in newtons.

```ts
const pan = new SaltCrust({
  x: -4, z: -6, cellSize: 0.04, columns: 201, rows: 301, seed: 741,
  bedAt: (x, z) => yourMudElevation(x, z),
  plateWidthM: 0.83, thicknessM: 0.019, strengthKPa: 46, mudSettlementM: 0.05,
});
const material = createSaltCrustMaterial({ salt: '#d8cab5', bed: '#705143' });
const mesh = new THREE.Mesh(pan.geometry, material);
scene.add(mesh);
pan.press(contactX, contactZ, widthM, lengthM, yawRadians, normalForceN);
pan.flush();
pan.sample(contactX, contactZ, reusableReading); // Triangle height (m) and broken fraction (0–1)
```

`columns` and `rows` count vertices, from 3 to 513 on each axis. The example uses 40 mm spacing. Keep several vertices across a contact or use a smaller cell for a thin bicycle tire. Width and length describe the full contact ellipse. At each point inside it, applied pressure is proportional to the square root of the remaining squared radius fraction. Its area integral equals the applied normal force. A previously broken plate retains its peak pressure while the contact rests or repeats. Exposed clay settles toward `mudSettlementM`. This is a game constitutive model. Calibrate the loading curve against the surface your game needs.

Call `press` along a tyre path at sub-footprint spacing and `flush` once per changed frame. The host owns the clock, contact loads, collisions, material and optional water. A character or game controller can use `sample(x,z,out)` for floor height. A host with an existing rigid-body collider must update its collision surface when gameplay needs the displaced geometry. `save()` records changed vertices only. `restore()` validates the survey, material parameters, seed and sampled host bed and cover before applying edits. Dispose the geometry with `pan.dispose()` and release game-owned materials at unload.

[Playable basin and controls](../examples/dry-lake/README.md) · [Pressure model](../modules/surface-deform/salt-crust.ts)
