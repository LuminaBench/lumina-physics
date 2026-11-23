# 11 · Destruction

Source: `modules/destruction/` (`fracture.ts` geometry, `destruction.ts` runtime).

## Convex Voronoi fracture

A solid is a list of planar faces. The cell of site `s_i` is the solid clipped by the
bisector half-space of every other site, nearest first:

```
n = (s_j − s_i)/|s_j − s_i| ,  keep  n·x ≤ n·s_i + |s_j − s_i|/2
stop when |s_j − s_i|/2 exceeds the farthest remaining vertex from s_i
```

Clipping keeps the vertices on the inside, inserts the edge crossings and closes the cut
with a face made of those crossings sorted by angle (the cut of a convex solid is convex).
The new face remembers `j`, which gives the adjacency graph for free. Volume and centroid
come from signed tetrahedra; the cells of a box sum to its volume to 4 digits.

| Material | sites | density | fracture energy |
| --- | --- | --- | --- |
| concrete | half scattered, half clustered within 0.22·size of the impact | 2400 kg/m³ | 240 kJ/m³ |
| glass | rings × spokes in the pane's mid-plane, radius × 2.1 per ring | 2500 | 2.5 kJ/m³ |
| wood | scattered in a space squashed to 0.16 along the grain (splinters) | 620 | 60 kJ/m³ |
| brick | none: running-bond courses of 0.44 × 0.2 m blocks | 1900 | 110 kJ/m³ |

Glass re-fractures around the first hit so cracks radiate from it.

## Damage

```
impact(E):  V = E / (e_f · toughness) ,  r = ∛(3V / 4π)      chunks with centroid within r break
            v = min(14, √(2 · 0.25E / m_broken))              a quarter of E becomes kinetic
blast:      chunk breaks when (1 − d/reach)² · impulse/2600 > threshold(material)
contact:    intact collider reports force > F_c → impact(½ m v² of the striker)
collapse:   flood fill from anchored chunks over the adjacency graph;
            whatever is unreached falls
```

Anchors: `bottom` (chunks touching the base), `frame` (glass: chunks touching the outline),
`none`. Loose chunks are dynamic bodies with convex-hull colliders and mass = volume ×
density; in water they receive `(ρ_w/ρ) m g` lift, heavy damping and one splash.

## Rendering

One mesh per object for its whole life: vertices are stored relative to their chunk's
centroid with a chunk index, and placed by that chunk's matrix read from an 8 × N float
texture (current + previous frame, for motion vectors). Element [3][3] of the matrix doubles
as an intact / loose flag so glass can hide its cut faces until they are real cracks.
Chunk budget per object and simultaneous bodies scale with the tier.


## Cosmetic contacts and grazing collisions

On Three.js destructibles, `object.markSurface(worldPoint, radiusM)` returns whether a cosmetic contact reached an exposed face of concrete, brick or timber. Structural impacts also mark the surface. Each object keeps eight marks in material coordinates. The broken lip, recessed center and exposed grain or aggregate affect color, roughness and the lighting normal. Read `surfaceMarkCount` or call `clearSurfaceMarks()` to restore the finish.

For a bumper or tool dragged across a face, call `markScrape(from, to, radiusM, chunkIndex?)`. Use world-space endpoints measured in the same body pose. The mark starts on the contacted face and projects the displacement into its tangent plane. A single segment occupies one slot regardless of length. Submit another segment when the contact turns or crosses onto another face. A stationary touch produces a chip.

After fracture, the original marks travel with the pieces. To mark moving rubble, pass its current world point to `markSurface(point, radiusM, chunkIndex?)`. An optional chunk index restricts the search to that piece. A fresh chip can land on the angled face revealed by the break.

Standing brick courses carry recessed mortar at their bed and head joints. Released blocks keep traces around the clay edges. Timber grain runs along local X and growth rings cross the end cut. Give neighboring planks different `seed` values to vary knot position and fibre direction. Glass uses its fracture shader.

`VehicleDamage.impact(worldPoint, intensity, worldNormal?, relativeVelocity?)` accepts the contact normal and sliding velocity in world coordinates. Rapier supplies both for chassis collisions. Sideways motion spreads a shallower dent along the panel, while a square hit compresses along the normal. The two-argument API retains its original radial response. Use **Sideswipe**, **Repair bodywork** and **Dent front wing** in Storm Highway to compare.

## Painted surfaces and vehicle trim

For vehicles, supply `VehicleDamage(engine, fx, rigidBody, shell, glassIndex = 1, paintIndex = 0)`. The paint slot accepts a standard or physical PBR material. Pass a negative paint index for an unpainted shell. Supply relative velocity in world m/s to orient rubbing along the panel. A light rub roughens lacquer, while stronger contact exposes broken streaks of primer and metal. A glancing contact primarily rubs the paint. A direct contact with the pane can still crack it.

Register rigid, body-mounted fittings such as liners, door cards and lamp housings with `damage.attachTrim(mesh)`. The module applies the shell deformation in each attachment’s own coordinate system. It copies a fitting’s geometry when a dent first reaches it. `repair()` clears wear, restores the shell positions and authored normals, and reattaches the original fitting geometries. `dispose()` restores the original shell material and geometry. The sports coupe exposes `crumpleAttachments` for this purpose. Wheels, suspension and the driver retain their own animation.

### Standalone painted props

Install `paint-wear` for Three.js. It has one peer dependency, Three.js. Construct `new PaintWear(originalNodeMaterial)` for a painted object. Assign `wear.material` to its paint slot. One instance can serve a single instanced draw. Supply the selected instance on each contact.

```ts
const accepted = wear.stamp(mesh, contactPoint, relativeVelocity, {
  lengthM: 0.42, widthM: 0.08, strength: 0.75, materialIndex: 0,
  faceIndex: hit.faceIndex, instanceId: hit.instanceId, reachM: 0.08
});
```

Length and width are full world-space dimensions. The world velocity gives the stroke direction. Strength controls coating loss from 0 to 1. Reach is the allowed gap between a physics contact and the rendered surface. The nearest visible material group receives the mark if it matches `materialIndex`. A successful ninth contact reuses the oldest of eight slots in that material. A single-material mesh needs no group setup.

On a CPU-deformed mesh, save its initial local positions and normals as geometry attributes before deformation, then construct `new PaintWear(material, restPositionName, restNormalName)`. Submit the contact before applying its new dent. Projection uses the current triangles and stores the stroke in their rest coordinates. Call `clear()` for repair and `dispose()` after unbinding the material.

### Contacts on animated painted surfaces

For a rendered hit, pass the Three.js raycast's world point, `faceIndex`, material slot and instance ID. The indexed path checks that triangle against the current draw range, visible material and contact tolerance. On a mesh containing thousands of faces, a successful indexed contact reads at most six posed vertices. A controller with only a world point can omit the triangle index and use the nearest visible triangle search.

Skinned meshes use their current bone pose. Morph targets use the mesh weights or the selected instance’s weights. Update animation and any external skeleton's world transforms before reporting the hit. The renderer carries the mark in rest coordinates when the piece moves again. For a CPU dent system that overwrites positions or normals, give the constructor immutable rest attributes for both. Arbitrary displacement performed by a custom vertex shader requires a matching CPU contact surface.

[Animated contacts, instancing and repair checks](../qa/surface-wear.spec.ts)
