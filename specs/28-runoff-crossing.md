# A low-water crossing fed by upstream rain

Install `runoff-crossing` into a Three.js game. A ground-rain callback, one or more contributing areas and a surveyed shallow-water patch are sufficient. The solver runs on the CPU. A half-float field supplies water stage, X/Z velocity and suspended sediment concentration to a WebGPU or WebGL 2 material. The host owns rainfall, clock, terrain and rendering.

```ts
import { RunoffCrossing } from './lumina-physics';

const crossing = new RunoffCrossing({
  bands: [{ gauge: [68, 21, -30], areaM2: 14000, travelSeconds: 28, infiltrationMmHour: 4 }],
  channelSeconds: 9,
  patch: {
    x: -10, z: -6, columns: 40, rows: 24, spacing: 0.5,
    bedAt: game.heightAt, initialStageAt: () => -1, seaLevel: -0.45, seaEdge: 'east',
    mouthAt: (_x, z) => Math.abs(z) < 1.1, tributary: [-8, 0], tributarySiltKgM3: 0.25,
    culvert: { inlet: [-3, -0.18, 0], outlet: [3, -0.26, 0], width: 1.2, height: 0.4 },
  },
});
crossing.water.setCulvertOpening(0.3);
// Advance once per game update. Both callbacks receive absolute simulation seconds.
crossing.update(dtSeconds, (x, y, z, t) => game.groundRainMmHour(x, y, z, t),
  t => game.downstreamElevation(t));
const depthM = crossing.water.depthAt(wheelX, wheelZ);
```

## Survey and routing

- World Y is up. The ground sampler returns elevations in metres, including the actual road crest above the channel. The patch origin is its minimum X/Z corner. Each square cell has the given spacing in metres. The tributary and both distinct port cells must lie in the patch. At least one boundary face must be open. Use the mouth mask to close most of a boundary.
- Each band has a ground gauge in XYZ metres, a representative area in m², a nonnegative travel delay up to 86,400 seconds, and constant soil intake capacity in mm/h. Sample rain that reaches that location. Rain absorbed by the atmosphere or falling on a different catchment contributes zero. Use disjoint areas to avoid double-counting. A distant catchment can deliver runoff to a dry road.
- Every 50 ms, sample at the tick midpoint. Rain minus soil intake is multiplied by the area to obtain excess volume. A bounded circular queue apportions a fractional travel time between adjacent ticks. A linear reservoir with a positive recession time releases the arriving volume analytically over the tick. The outlet feeds the actual shallow-water grid. One queue, a fixed number of bands and a local patch bound the cost.
- Port coordinates are [x, invert elevation, z]. Width and height are metres. The opening scales clear width between 0 and 1. The submerged opening and the head difference determine signed discharge, capped by water above the donor’s invert. The dimensionless discharge coefficient defaults to 0.65. High downstream head can reverse flow. Water and suspended sediment share the surface and culvert donor budget. Surface overflow follows the mesh elevations independently of the buried path.
- The box opening approximates a short hydraulic connection. It has no internal pipe storage, unsteady pipe momentum or barrel friction. Contributing areas use travel-time routing and fixed intake. Choose local terrain and time scales appropriate to a game. An extended watershed, changing groundwater storage and a network of pipes need their own models.

## Rendering, controls and state

Use `water.depthAt(x,z)` for contacts (metres, zero outside), `water.fieldNode(xz)` for stage and flow, and `water.culvertDischargeM3s` for the jet at the mouth. Positive discharge points from the named inlet to the outlet. A rendered surface should be masked where its level does not cover the actual terrain. Keep the grid dense enough to resolve the exposed road crest. The buried jet should not appear on top of the road.

`balance()` returns captured rain, soil intake, water in transit, channel storage, source volume delivered, local patch storage, outward discharge and incoming tailwater, all in m³. The two residuals check catchment and local-grid conservation separately. Include initial water and tailwater input when accounting for a pre-filled patch. The grid also reports suspended, settled, imported and exported sediment in kg. Fast or slow gameplay uses the same simulation seconds and replayable forcing.

Save with `crossing.save()` and restore with `crossing.restore(snapshot)`. Preserve any host rainfall/clock authoring and other external state alongside the snapshot. Its survey fingerprint binds it to the original grid, ports, bands and reservoir. It stores in-transit water, stored water, the fractional clock, clear opening, momentum and sediment. A different survey or invalid water budget rejects the restore before mutation. Release its GPU texture with `crossing.dispose()`.

The [surveyed wash](../examples/dry-lake/wash-recipe.ts) supplies three game-owned bands and a local rain column. [Interactive controls](../examples/dry-lake/README.md#low-water-crossing).
