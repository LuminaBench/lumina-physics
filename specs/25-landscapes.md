# Procedural landscapes

Choose `outdoor-world` for a complete Three.js scene. On existing levels install `terrain-query`, `botanical-grove`, `meadow-cover` or `land-geology` individually. Terrain and vegetation use metres, +Y up and linear-light shading. All meshes and maps are generated from code. These landscape renderers target Three.js WebGPU and WebGL 2. The Godot and Unity starters can load the profile metadata and palette.

## Choose the terrain

| Biome | Ground and water | Plants |
| --- | --- | --- |
| `coastal-cliffs` | Tilted coastal beds, stepped headlands, shelves, wave-wet sand, sea stacks and fallen talus | Curved cypress, oak, palms, gorse, heather, marram and clover |
| `temperate-river-valley` | A meandering channel with an eroded outer bank, lower inner gravel bars, cobbles and driftwood | Willow on damp banks, emergent cattails, ferns and flowering meadow |
| `dry-highlands` | Broad dip slopes, sharper escarpments, weathered shale and scree | Silvery sagebrush, drought-tolerant scrub, clumps of golden grass |

```ts
const world = await createLuminaWorld({
  profileVersion: 1, biome: 'temperate-river-valley', look: 'natural-daylight',
  quality: 'high', weather: 'mixed', time: 16, seed: 721
}, { canvas, heightmap, plantable: (x, z) => Math.abs(x - roadCenter(z)) > 4 })
```

Omit `heightmap` to use the generated biome. A host map provides `{size, segments, heights}` as described in [World Profiles](24-world-profiles.md). Landforms, water depth, roots and wheel contacts share the same triangle heights. The `plantable` predicate also excludes loose geological props from roads and buildings. The Rapier terrain collider includes landforms in the heightmap. Loose cobbles, brush and driftwood are visual instances. Add host colliders to individual props when gameplay requires contact.

## Trees and ground cover

`growPlant(species,seed)` returns wood paths, endpoint sprays, height and radius. Species identifiers are `cypress`, `oak`, `palm`, `willow`, `gorse`, `fern`, `heather` and `sagebrush`. Wood, botanical colour/alpha, normal/roughness tiles and three far silhouettes share each archetype. The grove uses seeded scale, rotation, placement and species selection. Save the profile seed alongside the host heightmap for reproducible placement.

`BotanicalGrove(surface, worldBus, seed, plantable?)` owns an instanced group. Add `grove.root` to the host scene, call `grove.updateView(camera)` after updating the camera's world matrix, and call `grove.dispose()` at unload. The regular profile entry point does this automatically.

Set `overrides.grassDensity` in [0, 1]. Zero clears grass and trees. Cypress and willow crowns share the same gusts as grass and cloth. Wheel contacts on a profiled terrain automatically part stems. A host vehicle or character can call `world.foliage.wind.part(x,y,z,radiusM,speedMps)` at its ground contact. Rotor and blast wind come from the shared world fields. WebGPU samples the local wind on a compute grid. WebGL 2 uploads a CPU-sampled equivalent. Both use instanced blades with spatial culling, thinner distant cover and height-dependent bending.

For render telemetry, `world.foliage.meadow.submittedBlades` counts blades in submitted grass patches. `visibleBlades` estimates individual blades after frustum and density selection, before depth occlusion. Reeds and woody plants are counted separately. The five quality tiers adjust density and LOD distance. `world.patch({look:'painterly'}, 2)` retains the seed, branches, road mask and physical surface.

## Inspect the results

Open **World profiles** from `npm run preview`, then select the biome and the headland or tire-height view. The six looks can be compared at the same solar hour. For night lighting set the solar hour to 2 or open `/profiles.html?look=neon-night&hour=2`. For a reproducible media gallery run the following against a production preview with an FFmpeg executable supporting MJPEG and VP9.

```sh
npm run build
npx vite preview --port 5285
# In a second terminal
node qa/capture-profiles.mjs --landscapes
```

The stills, clips and offline HTML viewer are written to `qa/output/landscapes-1.0/`. Run `npm run qa -- foliage.spec.ts` for the three-biome, two-camera, two-backend and five-tier benchmark.
