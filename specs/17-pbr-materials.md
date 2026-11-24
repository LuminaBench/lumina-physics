# 17 · Reusable TSL PBR material library

Source: `modules/materials/*` (`index.ts`, `common.ts`, `concrete.ts`, `asphalt.ts`, `car-paint.ts`, `titanium.ts`, `timber.ts`, `sea-spray-glass.ts`, `melting-ice.ts`).

## Shared architecture (`common.ts`)

Every factory returns a Three.js `MeshPhysicalNodeMaterial` augmented as `LuminaMaterial<TMat, TParams>`:
- `.kind: MaterialKind`
- `.uniforms: Record<string, N>` (live reactive TSL uniform nodes)
- `.setParams(partial: Partial<TParams>)` (updates uniforms without recompiling)

Unified factory: `createMaterial(kind, options?)` over `MATERIAL_KINDS = ['concrete', 'asphalt', 'carPaint', 'titanium', 'timber', 'seaSprayGlass', 'meltingIce']`.

Shared options (`SharedMaterialOptions`): `scale` (default `1`), `thermo?: ThermoField | null`,
`thermalSurface?: ThermalSurface | null`, `fireLighting?: boolean` (default `true`), `fireLightGain?: number` (default `1`).

### Shared TSL building blocks

1. **Mikkelsen screen-space derivative bump (`perturbNormalHeight(h, scale)`).** Computes view-space
   tangent gradients without requiring UVs:
   ```
   σ_x = dFdx(P_view) ,  σ_y = dFdy(P_view)
   R1  = σ_y × N_view ,  R2  = N_view × σ_x ,  det = (σ_x · R1) · faceDirection
   N'  = normalize(N_view · (|det| + 10⁻⁶) − sign(det) · (R1 · ∂h/∂x + R2 · ∂h/∂y))
   ```
2. **Triplanar world noise (`triplanarNoise`, `triplanarDetail`).** Three bilinear taps of baked
   `spriteNoise` along `(zy, xz, xy)` weighted by `|N_world|⁴ / (Σ|N_world|⁴ + 10⁻⁴)`.
3. **Rain-ripple rings (`rainRippleHeight(xz, time)`).** 3×3 Voronoi cell lattice at `2.35 /m`,
   emitting expanding damped wavelets `sin(30 r) · exp(−65 r²) · (1 − phase)²`.
4. **Thermal coupling (`applyThermo`).** Composes `ThermalSurface.shade` or `ThermoField.surface`
   into albedo, roughness, emissive ember cracks and `wetness = max(wetness, t.wetness)`.
5. **Specular AA & HDR fire-light bounce.** Every material passes its perturbed normal and base
   roughness through `specularAARoughness` and adds `fireLightBounce` (`fireLights.samplePBR`,
   skipped uniformly when `fireLights.hasActive == 0`).

## Seven procedural materials

| Kind | Factory | Key live parameters (defaults) | Physical shading notes |
| --- | --- | --- | --- |
| `concrete` | `createConcreteMaterial` | `color` (`0x8b8982`), `wetness` (`0.15`), `puddle` (`0`), `rain` (`0`), `roughness` (`0.88`), `slabSize` (`4.0`), `bumpScale` (`0.012`) | Triplanar aggregate/pores, slab expansion joints on upward faces, porous darkening (`×0.46` when saturated), puddle clearcoat (`0.03` roughness) + rain ripples, optional Thermo coupling. |
| `asphalt` | `createAsphaltMaterial` | `color` (`0x262729`), `wetness` (`0.35`), `puddle` (`0.2`), `rain` (`0`), `wear` (`0.35`), `cracks` (`0.25`), `bumpScale` (`0.015`) | Coarse tar patches, crushed stone aggregate, hairline tar cracks, low-basin puddles (roughness `0.025`, darkening `×0.38`) with ripples, optional Thermo coupling. |
| `carPaint` | `createCarPaintMaterial` | `color` (`0xb81822`), `flopColor` (`0x2b050d`), `flopStrength` (`0.65`), `metalness` (`0.72`), `roughness` (`0.24`), `flakeScale` (`140`), `flakeIntensity` (`0.45`), `clearcoat` (`1.0`), `clearcoatRoughness` (`0.04`), `dirt` (`0`), `wetness` (`0`) | Dual-layer Fresnel colour flop `(1 − N·V)^2.4`, local-space `hash33` metallic micro-flakes, orange-peel + water-beading clearcoat bump, road grime dulling metalness and clearcoat. |
| `titanium` | `createTitaniumMaterial` | `color` (`0xb6bcc2`), `roughness` (`0.28`), `metalness` (`0.96`), `brushScale` (`36`), `heatTint` (`0.28`), `temperature` (`0`), `wear` (`0.2`), `wetness` (`0`) | Anisotropic stretched brushed grain + micro-scratches, thin-film heat-temper band (silver → straw → violet → cobalt → oxide) driving `iridescence` (`ior 1.85`, thickness `160–520 nm`), blackbody incandescence when `temperature > 0.18`. |
| `timber` | `createTimberMaterial` | `color` (`0x7c5432`), `grainColor` (`0x3b2413`), `plankWidth` (`0.24`), `weathering` (`0.2`), `wetness` (`0.1`), `char` (`0`), `ember` (`0`), `roughness` (`0.82`), `bumpScale` (`0.008`) | Warped annual wood rings + fibrous grain oriented cleanly on decks and walls, per-plank tonal shift + seam grooves, coastal silvering (`weathering`), manual + Thermo char and flickering ember cracks. |
| `seaSprayGlass` | `createSeaSprayGlassMaterial` | `tintColor` (`0xcbe8e6`), `spray` (`0.65`), `salt` (`0.22`), `roughness` (`0.04`), `refraction` (`0.032`), `ior` (`1.52`), `opacity` (`0.14`) | Transparent (`depthWrite: false`, `auxPassthrough()`), `viewportSharedTexture` backdrop refraction bent by glass normal + beaded droplets + gravity-driven trickling runners, frosted sea-salt crust haze, Schlick Fresnel (`F₀ = 0.04`). |
| `meltingIce` | `createMeltingIceMaterial` | `color` (`0xd8f1fb`), `deepColor` (`0x2c8bb8`), `melt` (`0.25`), `cracks` (`0.65`), `bubbles` (`0.5`), `refraction` (`0.055`), `ior` (`1.31`), `bumpScale` (`0.018`) | Transparent (`auxPassthrough()`), `viewportSharedTexture` glacial refraction, parallax-offset internal fracture veins + trapped air bubbles (`p − 0.28 V`), downward meltwater rivulets as `melt → 1`, forward sun SSS. |

## Mineral faces

Install `mineral-facets` on a Three.js game with a physical node material. One seeded RGBA texture carries the illuminated grain area, mean slope and mean squared slope. Filtering those moments broadens the clearcoat as many faces merge into one pixel. The renderer supplies directional lighting, shadows and the reflection environment. A moving camera can resolve individual reflections at close range. Coordinates passed to the finish are in metres.

```ts
import * as THREE from 'three/webgpu';
import { positionWorld, normalView } from 'three/tsl';
import { MineralFacets } from './lumina-physics';

const ground = new THREE.MeshPhysicalNodeMaterial({ color: 0x866742, roughness: 0.86 });
const finish = new MineralFacets({ seed: 721, fraction: 0.08, diameterMm: 1.2, tilt: 0.45 });
finish.apply(ground, positionWorld.xz, normalView);
// Reuse this material on ground tiles. At level unload:
finish.dispose();
ground.dispose();
```

This finish owns the material's three clearcoat inputs. Use the existing perturbed view-space normal for rough terrain. An optional fourth argument sets exposed area from zero to one, for example where a water film covers the grains. An optional fifth argument supplies the view-space tangent along increasing U for a differently oriented surface. `finish.strength.value` scales the exposed area without recompilation. For moving props, use attached surface coordinates in metres and a tangent that follows the prop. This module needs Three.js and has no scene or simulation-loop dependency.
