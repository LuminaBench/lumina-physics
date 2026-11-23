/**
 * Shared procedural PBR materials and resource registry for showcase scenery.
 *
 * All albedo palettes are authored in linear RGB so lighting, shadows and atmospheric
 * scattering match Ocean, Weather and Bathymetry naturally on both WebGPU and WebGL 2.
 */
import * as THREE from 'three/webgpu';
import { perturbNormalHeight } from '../../engine/shading';
import { TSL, type N } from '../../engine/tsl';
import { fbm2, valueNoise2 } from '../../engine/noise';
import { frame } from '../../engine/frame';
import type { WorldBus } from '../../engine/world-bus';
import { surfaceWetnessNode } from '../../engine/world-bus';
import type { Weather } from '../../modules/weather/weather';

const {
  float, vec2, vec3, positionWorld, cameraPosition, normalWorld,
  normalize, length, mix, smoothstep, exp, max, abs, fract,
} = TSL;

export type TerrainPalette = 'tropical' | 'temperate' | 'golden' | 'storm';

/** Tracks scenery geometries, materials and root groups for one-call disposal. */
export class SceneryRegistry {
  readonly group = new THREE.Group();
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();

  constructor(name = 'showcase-scenery',readonly world?: WorldBus) {
    this.group.name = name;
  }

  trackGeometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.add(g);
    return g;
  }

  trackMaterial<T extends THREE.Material>(m: T): T {
    this.materials.add(m);
    return m;
  }

  /** Walk `group` before disposal to catch geometries created by `mergeStaticMeshes`. */
  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        if (mesh.geometry) this.geometries.add(mesh.geometry);
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => this.materials.add(m));
        else if (mesh.material) this.materials.add(mesh.material);
      }
    });
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}

export interface AerialOptions {
  /** Distance (m) before extra marine-layer haze begins. */
  mistStart?: number;
  /** E-folding distance (m) for the low-altitude coastal mist. */
  mistRange?: number;
  /** Maximum mist blend (0..0.9). */
  mistMax?: number;
  /** Height scale (m) of the marine boundary layer. */
  mistHeight?: number;
  /** Optional subtle colour tint multiplier on the sky haze. */
  hazeTint?: [number, number, number];
}

/**
 * Physically composed marine-layer aerial perspective for PBR node materials.
 * Attenuates surface albedo by `transmittance` and adds in-scattered sky horizon
 * radiance via `emissiveNode`, composing cleanly with `scene.fogNode`.
 */
function applyMarineAerial(
  material: THREE.MeshStandardNodeMaterial,
  albedo: N,
  weather: Weather,
  options: AerialOptions = {},
): void {
  const mistStart = options.mistStart ?? 380;
  const mistRange = options.mistRange ?? 3000;
  const mistMax = options.mistMax ?? 0.72;
  const mistHeight = options.mistHeight ?? 260;
  const tint = options.hazeTint ?? [1, 1, 1];

  const P = positionWorld;
  const view = P.sub(cameraPosition);
  const dist = length(view);
  const dir = view.div(max(dist, 0.001));
  const d = max(dist.sub(mistStart), 0);
  const lowLayer = exp(max(P.y, 0).div(-mistHeight)).mul(0.65).add(0.35);
  const mist = float(1).sub(exp(d.mul(lowLayer).div(mistRange).negate())).mul(mistMax);
  const transmittance = float(1).sub(mist);

  const flatDir = normalize(vec3(dir.x, max(dir.y, 0).mul(0.32).add(0.038), dir.z));
  const hazeColor = weather.skyColor(flatDir).mul(vec3(tint[0], tint[1], tint[2]));

  material.colorNode = albedo.mul(transmittance);
  material.emissiveNode = hazeColor.mul(mist);
}

interface TerrainColors {
  sand: [number, number, number];
  rockDark: [number, number, number];
  rockLight: [number, number, number];
  vegDeep: [number, number, number];
  vegWarm: [number, number, number];
  ridge: [number, number, number];
  vegAltitude: number;
  vegSlopeMin: number;
  sandCeiling: number;
  wetLine: number;
}

// Calibrated linear-space albedos (natural dark coastal greens and weathered stone — never pastel clay).
const PALETTES: Record<TerrainPalette, TerrainColors> = {
  tropical: {
    sand: [0.56, 0.47, 0.33],
    rockDark: [0.055, 0.052, 0.048],
    rockLight: [0.165, 0.148, 0.122],
    vegDeep: [0.024, 0.068, 0.018],
    vegWarm: [0.072, 0.132, 0.032],
    ridge: [0.052, 0.088, 0.028],
    vegAltitude: 2.2,
    vegSlopeMin: 0.46,
    sandCeiling: 2.3,
    wetLine: 1.5,
  },
  temperate: {
    sand: [0.32, 0.28, 0.22],
    rockDark: [0.045, 0.048, 0.052],
    rockLight: [0.135, 0.132, 0.125],
    vegDeep: [0.022, 0.046, 0.024],
    vegWarm: [0.058, 0.088, 0.042],
    ridge: [0.075, 0.082, 0.065],
    vegAltitude: 2.8,
    vegSlopeMin: 0.50,
    sandCeiling: 1.4,
    wetLine: 1.9,
  },
  golden: {
    sand: [0.38, 0.31, 0.22],
    rockDark: [0.048, 0.042, 0.038],
    rockLight: [0.145, 0.122, 0.098],
    vegDeep: [0.026, 0.052, 0.022],
    vegWarm: [0.078, 0.096, 0.038],
    ridge: [0.095, 0.085, 0.052],
    vegAltitude: 2.0,
    vegSlopeMin: 0.48,
    sandCeiling: 1.6,
    wetLine: 1.6,
  },
  storm: {
    sand: [0.12, 0.115, 0.105],
    rockDark: [0.022, 0.025, 0.028],
    rockLight: [0.078, 0.084, 0.088],
    vegDeep: [0.015, 0.030, 0.018],
    vegWarm: [0.036, 0.054, 0.028],
    ridge: [0.044, 0.050, 0.052],
    vegAltitude: 1.6,
    vegSlopeMin: 0.48,
    sandCeiling: 0.8,
    wetLine: 2.6,
  },
};

export interface TerrainMaterialOptions extends AerialOptions {
  palette: TerrainPalette;
  /** Use the eight-direction horizon baked into a headland mesh. */
  terrainShadows?: boolean;
  /** Extra rockiness (0..1) for rugged sea-stacks and basalt bluffs. */
  rockiness?: number;
  /** Subtle wet gloss across slopes (storm highway embankments). */
  wetness?: number;
}

/**
 * World-space organic coastal terrain material: domain-warped rock crags, deep mossy
 * coastal forest carpets, sheltered cove sand, glossy tidal line and marine-layer mist.
 * Zero periodic horizontal contour stripes.
 */
export function createTerrainMaterial(
  reg: SceneryRegistry,
  weather: Weather,
  options: TerrainMaterialOptions,
): THREE.MeshStandardNodeMaterial {
  const pal = PALETTES[options.palette];
  const rockiness = options.rockiness ?? 0;
  const globalWet = options.wetness ?? (options.palette === 'storm' ? 0.45 : 0);

  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `terrain-${options.palette}`;
  material.metalness = 0;

  const P = positionWorld;
  const xz = P.xz;
  const h = P.y;
  const ny = TSL.normalWorldGeometry.y.clamp(0, 1);

  // Domain-warped multi-scale noise (completely non-periodic, organic geological patches).
  const warp = vec2(fbm2(xz.mul(0.0055).add(3.1), 2), fbm2(xz.mul(0.0055).add(17.9), 2)).sub(0.5);
  const wxz = xz.add(warp.mul(65));
  const macro = fbm2(wxz.mul(0.009), 3);
  const mid = fbm2(wxz.mul(0.042).add(7.1), 3);
  const fine = fbm2(xz.mul(0.24).add(19.3), 2);
  // Subtle non-periodic rock fracture variation combining horizontal and vertical coordinates.
  const crag = fbm2(vec2(wxz.x.mul(0.028).add(wxz.y.mul(0.021)), h.mul(0.085).add(macro.mul(2.4))), 3);

  // Short bedding planes crop out on exposed faces. Their dip and thickness
  // vary across a rock formation, including along vertical faces at the shore.
  const dip = h.add(wxz.x.mul(0.18)).sub(wxz.y.mul(0.27)).add(macro.mul(14));
  const bedding = valueNoise2(vec2(wxz.x.add(wxz.y.mul(0.67)).mul(0.055), dip.mul(0.39)));
  const exposure = float(1).sub(smoothstep(0.40, 0.82, ny));
  const ledge = smoothstep(0.44, 0.73, bedding).mul(exposure).mul(smoothstep(0.30, 0.69, mid));
  const rock = mix(
    vec3(...pal.rockDark),
    vec3(...pal.rockLight),
    smoothstep(0.26, 0.77, crag.mul(0.48).add(mid.mul(0.23)).add(fine.mul(0.16)).add(ledge.mul(0.20))),
  );

  // Deep lush coastal woodland/scrub carpet with dappled canopy mottling.
  const canopyDapple = fbm2(xz.mul(0.085).add(11.3), 3);
  const vegBase = mix(vec3(...pal.vegDeep), vec3(...pal.vegWarm), macro.mul(0.5).add(canopyDapple.mul(0.38)).add(fine.mul(0.12)));
  const vegRidge = mix(vegBase, vec3(...pal.ridge), smoothstep(42, 175, h).mul(0.5));
  const altFade = smoothstep(pal.vegAltitude - 1.0, pal.vegAltitude + 4.5, h.add(mid.mul(4.0)));
  const slopeFade = smoothstep(
    pal.vegSlopeMin + rockiness * 0.22,
    pal.vegSlopeMin + 0.22 + rockiness * 0.16,
    ny.add(mid.sub(0.5).mul(0.18)),
  );
  const vegMask = altFade.mul(slopeFade).mul(1 - rockiness * 0.85);

  // Pocket sand/shingle beaches on flat low shorelines only.
  const sandTone = vec3(...pal.sand).mul(mix(float(0.84), float(1.1), fine));
  const sandMask = smoothstep(pal.sandCeiling + 1.2, pal.sandCeiling - 1.0, h.add(mid.mul(1.6)))
    .mul(smoothstep(0.82, 0.96, ny))
    .mul(1 - rockiness * 0.75);

  let albedo: N = mix(rock, vegRidge, vegMask);
  albedo = mix(albedo, sandTone, sandMask);
  // Sculpted natural occlusion: slightly deeper tone in steep gullies/crevices, sun-catching ridges.
  albedo = albedo.mul(mix(float(0.68), float(1.12), macro.mul(0.45).add(canopyDapple.mul(0.25)).add(ny.mul(0.3))));

  // Rain darkens porous stone even on a wall. Only water held in shallow
  // hollows forms a smooth reflector. Moss and shingle retain local relief.
  const tidalWet = smoothstep(pal.wetLine + 1.1, 0.1, h.sub(mid.mul(0.55))).mul(smoothstep(-4.0, -0.3, h));
  const rainfall = reg.world ? max(surfaceWetnessNode(P), globalWet) : float(globalWet);
  const soaked = max(tidalWet, rainfall);
  const shelter = smoothstep(0.68, 0.99, ny).mul(smoothstep(0.71, 0.28, fine));
  const film = soaked.mul(shelter).mul(float(1).sub(vegMask.mul(0.94))).mul(float(1).sub(sandMask.mul(0.62)));
  albedo = albedo.mul(mix(float(1), mix(float(0.52), float(0.78), vegMask), soaked));
  material.userData.luminaWorldSurface = true;

  if (options.terrainShadows) {
    // Catchments hold darker vegetation on gentle slopes. Steep, deeply cut
    // gullies instead expose rock beneath the canopy.
    const drainage = TSL.attribute('drainage', 'float');
    const cutRock = drainage.mul(smoothstep(0.96, 0.55, ny)).mul(smoothstep(1.2, 5.5, h));
    albedo = mix(albedo, rock.mul(0.68), cutRock.mul(0.8))
      .mul(drainage.mul(-0.19).add(1));
    const card = TSL.attribute('horizonCardinal', 'vec4');
    const diag = TSL.attribute('horizonDiagonal', 'vec4');
    const sun = frame.sunDirection;
    const east = TSL.step(0, sun.x), north = TSL.step(0, sun.z);
    const ax = abs(sun.x), az = abs(sun.z);
    const alongX = mix(card.z, card.x, east);
    const alongZ = mix(card.w, card.y, north);
    const major = mix(alongZ, alongX, TSL.step(az, ax));
    const corner = mix(mix(diag.z, diag.w, east), mix(diag.y, diag.x, east), north);
    const blend = TSL.min(ax, az).div(max(TSL.max(ax, az), 0.001));
    const horizon = mix(major, corner, blend);
    const sunVisible = smoothstep(horizon.sub(0.035), horizon.add(0.045), sun.y);
    const skyBlocked = TSL.dot(card, card).add(TSL.dot(diag, diag)).mul(0.125);
    const daylight = sunVisible.mul(0.71).add(0.29);
    albedo = albedo.mul(mix(float(1), daylight, frame.sunVisibility)).mul(float(1).sub(skyBlocked.mul(0.58)));
  }
  applyMarineAerial(material, albedo, weather, options);

  const dryRough = mix(float(0.93), float(0.88), vegMask);
  const wetRough = mix(float(0.64), float(0.84), vegMask);
  material.roughnessNode = mix(mix(dryRough, wetRough, soaked), float(0.17), film);

  // Canopy relief fully replaces bedrock relief on forested slopes.
  const bareRelief = crag.mul(0.78).add(ledge.mul(0.24));
  const bumpH = mix(bareRelief, canopyDapple.mul(0.44), vegMask).add(fine.mul(0.058));
  material.normalNode = perturbNormalHeight(bumpH, 1.55);

  return reg.trackMaterial(material);
}

/** Weathered coastal boulders, riprap armor and sea-stack rock material. */
export function createRockMaterial(
  reg: SceneryRegistry,
  weather: Weather,
  palette: TerrainPalette,
  aerial: AerialOptions = {},
): THREE.MeshStandardNodeMaterial {
  const pal = PALETTES[palette];
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `rock-${palette}`;
  material.metalness = 0;

  const P = positionWorld;
  const n1 = fbm2(P.xz.mul(0.32).add(P.y.mul(0.25)), 3);
  const n2 = valueNoise2(P.xz.mul(2.2).add(P.y.mul(1.8)));
  const crag = fbm2(vec2(P.x.mul(0.55).add(P.z.mul(0.42)), P.y.mul(0.95).add(n1.mul(2.0))), 2);
  const lichen = smoothstep(0.58, 0.86, normalWorld.y).mul(smoothstep(1.2, 3.2, P.y)).mul(smoothstep(0.44, 0.74, n1));

  let albedo: N = mix(vec3(...pal.rockDark), vec3(...pal.rockLight), crag.mul(0.48).add(n1.mul(0.32)).add(n2.mul(0.2)));
  albedo = mix(albedo, vec3(...pal.vegDeep).mul(1.35), lichen.mul(palette === 'storm' ? 0.35 : 0.45));

  const wet = smoothstep(pal.wetLine + 0.55, 0.05, P.y.sub(n1.mul(0.35)));
  const rainWet = palette === 'storm' ? 0.55 : 0;
  albedo = albedo.mul(mix(float(1.0), float(0.4), wet)).mul(1 - rainWet * 0.25);

  applyMarineAerial(material, albedo, weather, { mistStart: 260, mistRange: 2800, mistMax: 0.65, ...aerial });
  material.roughnessNode = mix(float(0.91 - rainWet * 0.35), float(0.22), wet);
  material.normalNode = perturbNormalHeight(n2.mul(0.025).add(crag.mul(0.022)), 1.35);

  return reg.trackMaterial(material);
}

/** Poured harbor concrete with salt weathering and dark green/brown tidal fouling near y = 0. */
export function createMarineConcreteMaterial(
  reg: SceneryRegistry,
  weather: Weather,
  options: { tone?: [number, number, number]; wetLine?: number } = {},
): THREE.MeshStandardNodeMaterial {
  const tone = options.tone ?? [0.27, 0.265, 0.25];
  const wetLine = options.wetLine ?? 0.65;
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'marine-concrete';
  material.metalness = 0;

  const P = positionWorld;
  const blotch = fbm2(P.xz.mul(0.32).add(P.y.mul(0.4)), 3);
  const grit = valueNoise2(P.xz.mul(9.5).add(P.y.mul(7.0)));
  const seamX = smoothstep(0.0, 0.02, abs(fract(P.x.div(4.0)).sub(0.5)).oneMinus().sub(0.5));
  const seamZ = smoothstep(0.0, 0.02, abs(fract(P.z.div(4.0)).sub(0.5)).oneMinus().sub(0.5));
  const seam = mix(float(0.74), float(1.0), seamX.mul(seamZ));

  let albedo: N = vec3(tone[0], tone[1], tone[2])
    .mul(mix(float(0.76), float(1.12), blotch.mul(0.7).add(grit.mul(0.3))))
    .mul(seam);

  // Dark wet algae / barnacle band in the tidal zone.
  const tidal = smoothstep(wetLine + 0.55, -0.1, P.y.sub(blotch.mul(0.28)));
  const algae = vec3(0.04, 0.06, 0.038);
  albedo = mix(albedo, algae, tidal.mul(0.74));

  applyMarineAerial(material, albedo, weather, { mistStart: 420, mistRange: 3800, mistMax: 0.45 });
  material.roughnessNode = mix(mix(float(0.84), float(0.95), grit), float(0.26), tidal);
  material.normalNode = perturbNormalHeight(grit.mul(0.012).add(blotch.mul(0.015)), 0.9);
  return reg.trackMaterial(material);
}

/** Creosote / weathered marine dock timber (rub-fenders, pilings, cross-bracing). */
export function createMarineTimberMaterial(
  reg: SceneryRegistry,
  weather: Weather,
  options: { weathered?: boolean } = {},
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = 'marine-timber';
  material.metalness = 0;

  const P = positionWorld;
  const grain = fbm2(vec2(P.x.add(P.z).mul(7.5), P.y.mul(1.1)), 3);
  const sunBleach = options.weathered ? vec3(0.20, 0.17, 0.13) : vec3(0.18, 0.125, 0.08);
  const darkWood = vec3(0.075, 0.052, 0.035);
  let albedo: N = mix(darkWood, sunBleach, grain);

  const wet = smoothstep(0.85, -0.1, P.y.sub(grain.mul(0.25)));
  albedo = albedo.mul(mix(float(1.0), float(0.38), wet));

  applyMarineAerial(material, albedo, weather, { mistStart: 420, mistRange: 3800, mistMax: 0.45 });
  material.roughnessNode = mix(float(0.88), float(0.3), wet);
  material.normalNode = perturbNormalHeight(grain.mul(0.02), 1.0);
  return reg.trackMaterial(material);
}

/** Weathered marine iron, galvanized railing steel, painted dock hardware, or rubber fenders. */
export function createMarineMetalMaterial(
  reg: SceneryRegistry,
  options: { name: string; color: number; roughness: number; metalness: number },
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: options.color,
    roughness: options.roughness,
    metalness: options.metalness,
  });
  m.name = options.name;
  return reg.trackMaterial(m);
}

/** Non-plastic matte foliage PBR material supporting baked vertex AO and per-instance tinting. */
export function createFoliageMaterial(
  reg: SceneryRegistry,
  options: { name?: string; color?: number; roughness?: number; doubleSided?: boolean } = {},
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    color: options.color ?? 0xffffff,
    roughness: options.roughness ?? 0.87,
    metalness: 0.0,
    vertexColors: true,
    side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  m.name = options.name ?? 'coastal-foliage';
  return reg.trackMaterial(m);
}

/** Emissive HDR material for restrained harbor beacons, lighthouse lanterns, and highway reflectors. */
export function createBeaconMaterial(
  reg: SceneryRegistry,
  rgb: [number, number, number],
  name = 'scenery-beacon',
): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]) });
  m.name = name;
  return reg.trackMaterial(m);
}
