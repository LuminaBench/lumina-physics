# Author a landscape

Start with a playable world in [the field guide](../field.html) or import the [five editable project examples](../examples/landscape/chalk-stream.ts). The runtime uses metres, seconds, linear velocities in m/s, local solar hours and geographic angles in degrees. Content is generated from code on the user's device.

## Start from a relative

Run `node scripts/search.mjs "drooping tree on a wet bank" --engine threejs`. Inspect the recipe and the renderer before changing either. For a game that owns its scene use `landscape-host`. For a new game install `outdoor-world`. Keep game definitions alongside game code, outside the generated `src/lumina-physics` directory. Add them to the same library before loading a saved profile.

```ts
import { createLuminaWorld, createLandLibrary } from './lumina-physics';
const library = createLandLibrary();
library.define('plant', 'garden:white-birch', { height: 12, lean: 0.18 }, 'lumina:birch');
library.define('region', 'garden:valley', {
  plants: [{ plant: 'garden:white-birch', weight: 2 }, { plant: 'lumina:fern', weight: 1 }],
}, 'lumina:seasonal-woodland');
const world = await createLuminaWorld({
  profileVersion: 1, seed: 57, landscape: { revision: 1, region: 'garden:valley' }
}, { library });
world.engine.camera.position.set(20, 16, -40);
world.engine.camera.lookAt(0, 3, 8);
world.engine.start();
```

| Brief | Example function | A meaningful change and how to see it |
|---|---|---|
| Grow a pale wind-shaped birch | `addSilverBirch` | Raise lean and reduce crown breadth. Compare its longest limb against the same skyline, close up and far away. |
| Flower in sheltered hollows | `addWoodBluebell` | Change the six drooping petals, shade threshold or colony size. Inspect a sunny slope and a shaded bank in spring. |
| Support a tree on tidal roots | `addPropRootTree` | Increase lateral root spread in the growth callback. Lower the tide to see the exposed feet. |
| Compose a chalk-stream valley | `addChalkStream` | Change the bank profile or willow moisture requirement. Inspect the soil and planting weights on opposite banks. |
| Give leaves a gouache finish | `addGouache` | Change the number of paint values in the TSL callback. Switch direction with the camera fixed on the same tree. |

`library.ids(family)` lists actual definitions. `library.describe(family,id)` gives resolved values, the parent and the inherited and overridden fields. A typed growth callback receives the generated limbs and leaf sprays, and can add new geometry before distance variants and atlases are produced. A custom leaf painter draws into the recipe's alpha atlas. A custom cover geometry returns indexed triangles with position, normal and a vec3 attribute named `blade`. Its components are normalized height, density rank and material kind (0 grass, 1 dry, 2–3 petals, 4 spike, 5 centre).

## Controls and persistence

| Family | Controls |
|---|---|
| Plant | `height/breadth` in metres, crown-base fraction, lateral lean per metre, limb count, branch depth, leaf-width multiplier, flexible response, evergreen, shrub and 1–4 forms. |
| Cover | Height, blade width and flower radius in metres, petal count, bell curvature, stems per flower, bloom seasons, minimum shelter [0,1], patch size in metres and disturbance recovery in seconds. |
| Region | Terrain form, soil, lithology, latitude, relief multiplier, habitat weights and cutoffs for elevation, slope and moisture. `shape(x,z,h,seed)` returns metres. `place(site,plantId)` returns a relative weight. |
| Rock | Light and dark mineral colors, bedding frequency, fracture contrast and relief amplitude. |
| Direction | Ground, leaves, sky and water colors, leaf transmission/emission, separate ground/cloud/foam bands, saturation, exposure and temperature. A leaf shader can replace the color graph. |

Specify independent unsigned seeds for terrain, trees, understory, meadow, flowers, rocks and debris. Keep the master seed and revision stable across saves. Regional defaults can be overridden with `treeDensity`, `shrubDensity`, `meadowDensity`, `flowerDensity`, `latitude`, `dayOfYear` and `northAzimuth`. `world.setSeason()` and `world.setDirection()` update a live world. `world.patch()` edits weather, clock, quality and locked profile values.

Use `world.land.inspect(x,z)` to see why a site permits or suppresses growth. `world.foliage.grove.nearest(x,z,camera)` returns a stable instance ID, variant and distance level. `earth.save()` serializes local soil edits and fallen trees. Pass it back as `earthSave` when recreating the same map. A host can exclude roads or bridge envelopes through `plantable(x,z)` and supply its own `heightmap` and `substrate(x,z)`. Call one independent `land.contact(width)` per tire, then sample its world contact, signed speed, normalized load and seconds. An optional overlay describes a real elevated road deck. Each wheel samples its own contact and material. The film channels use metres of standing water and normalized surface wetness.

```ts
const tires = Array.from({ length: 4 }, () => world.land!.contact(0.24));
const deck = { soil: 'asphalt' as const, water: 0, film: 0.22, moisture: 0 };
// In the vehicle update, use each loaded wheel's contact point and the host's deck collider.
tires[i].sample(x, z, rollingSpeed, loadRatio, dt, onDeck ? deck : undefined);
// Use the same world-space sample on the elevated deck as on the adjacent terrain.
const tread = world.land!.tracks.sampleNode(TSL.positionWorld.xz);
material.colorNode = TSL.mix(TSL.color('#545854'), TSL.color('#70513b'), tread.g);
material.roughnessNode = TSL.float(0.82).sub(tread.r.mul(0.5));
```

For flowers that need both shelter and a hollow, set `minimumShade` and supply `canFlower(site, terrain)`. The bluebell example compares local ground height with the mean height five metres away in four directions. The renderer bakes this rule into a mask when the terrain loads. `inspect(x,z).flowerReason` reports which condition excluded a colony. Shelter is a terrain estimate from aspect and exposure. The renderer also applies changing canopy and cloud shadows.

To visit a specific plant, pass its namespaced recipe as the fifth argument to `grove.nearest(x,z,camera,true,recipeId)`. The returned instance ID survives camera changes and flower-only edits. Authored crowns include three side projections, a top projection for overhead cameras and a branch-only winter image from the same skeleton.

## A project grown from the installed skill

Brindle Reach starts from a chalk valley with a fixed bridge. The Cindercomb is an original wind-shaped tree. Vesper cups require both a hollow and shelter. The crossing samples all four tires independently. In the field guide open **Brindle Reach**, choose **Vesper cups** and press **Change flowers**. Then choose **Crossing** and **Roll cart**. The game keeps its own branch, flower, material, wheel and camera code. [Game source](../examples/brindle-reach) · [Original and revised flowers](../examples/brindle-reach/garden/flowers.ts)

The geology recipe controls both exposed strata and the loose stones below them. Wetness from accumulated rain darkens and smooths both surfaces, including rocks above the tide. On the authored coast, detached talus follows the downhill normal to a gentler slope while the shale beds intersect the parent face. [Dry and wet material comparison](../docs/gallery/field-surfaces.webp)

## Engine coverage

| Feature | Three.js WebGPU / WebGL 2 | Godot 4 and Unity starters |
|---|---|---|
| Authored region, time, art direction | Live shaders, placement and editable generators | Read resolved profile colors, time, region and named generation settings from JSON |
| Trees, flower geometry, local leaf shaders | Custom TypeScript and TSL generators, projected distance crowns | Use the recipe dimensions, colors and authored IDs in native meshes and materials |
| Terrain and earth state | Triangle-exact sampling, drainage, compaction, snow, tire films, sparse saves | Host terrain and physics supply the ground response |
| Host integration and regional flight | Attach vegetation to existing terrain or stream seeded tiles in a floating frame | Host manages instancing, origin shifts and tile lifetime |

Playable combinations include a painterly tidal marsh, an alien dry wash and an urban noir verge. The field guide changes direction without replanting the level. At a crossing, driving and walking share the same heightmap and saved soil.
