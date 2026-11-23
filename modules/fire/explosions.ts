/**
 * Staged game-art fire, explosions and charred debris.
 *
 * Eight purely artistic game-art archetypes share one staged orchestration layer,
 * scaled by normalized `yield` (0.4..2.5) and optional artistic overrides:
 *   petrol       3-stage fuel fireball: ignition bloom → rising mushroom thermal → pool burn
 *   c4           crisp ivory flash → sharp refractive shock ring + ground dust → settling haze
 *   water        subsurface pressure thump → vertical white-water column + base surge → fall-back foam
 *   electrical   strobing cyan-white Lichtenberg arcs → bouncing molten droplets → ozone wisps
 *   thermobaric  aerosol dome dispersal → incandescent wide cloud ignition + double shock → stem inrush
 *   incendiary   blinding starburst → cascading fiery streamer arcs & smoke ribbons → lingering firelets
 *   airburst     elevated solar flash + spherical shock shell → toroidal smoke ring + ground downwash → raining embers
 *   magma        crimson crust swell → ballistic molten basalt fountain + dark ash plume → glowing crater bed
 *
 * Every detonation couples into the world via normalized artistic intensities:
 *   - Rapier rigid bodies (blast impulse + custom TSL charred/glowing debris)
 *   - Shared HDR local fire lights (`fx.fireLights`) lighting nearby smoke, spray, mist,
 *     wet asphalt, water and PBR materials + Three.js PointLights + volumetric cloud underglow
 *   - Refractive shockwave shells and depth-softened convective heat refraction
 *   - Water interaction field, unified wind field, camera trauma and `engine.events`
 */
import { FieldReading, WorldSource } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { FireVolume } from './fire-volume';
import { GeyserSheets } from './geyser';
import { TSL, type N } from '../../engine/tsl';
import { DebrisPool } from '../../engine/physics';
import { valueNoise3, blackbody, mulberry32 } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit, FireLightHandle } from '../../engine/fx';
import type { QualityPreset } from '../../engine/quality';
import type { Ocean } from '../water/ocean';
import { growBolt, boltGeometry, boltMaterial } from '../weather/lightning';

const { uniform, positionLocal, positionGeometry, instanceColor, attribute, select, vec3, float, mix, smoothstep, max } = TSL;

export type ExplosionKind =
  | 'petrol'
  | 'c4'
  | 'water'
  | 'electrical'
  | 'thermobaric'
  | 'incendiary'
  | 'airburst'
  | 'magma';

export const EXPLOSION_KINDS: readonly ExplosionKind[] = [
  'petrol',
  'c4',
  'water',
  'electrical',
  'thermobaric',
  'incendiary',
  'airburst',
  'magma',
] as const;

/** Purely artistic, normalized game-art tuning preset for an explosion archetype. */
export interface ExplosionArtPreset {
  readonly label: string;
  /** Total cinematic staging duration in seconds. */
  readonly duration: number;
  /** Normalized 0..1 screen-flash weight. */
  readonly flash: number;
  readonly flashColor: number;
  /** Normalized 0..1 local HDR fire-light intensity weight. */
  readonly light: number;
  readonly lightColor: number;
  /** Normalized 0..1 fire volume / flame density. */
  readonly fire: number;
  /** Normalized 0..1 smoke / ash / mist volume. */
  readonly smoke: number;
  /** Normalized 0..1 spark / streamer intensity. */
  readonly sparks: number;
  /** Normalized 0..1 air & heat refraction weight. */
  readonly refraction: number;
  /** Normalized 0..1 charred debris amount. */
  readonly debris: number;
  /** Normalized 0..1 initial glowing heat on debris fragments. */
  readonly debrisHeat: number;
  /** Normalized 0..1 physics & wind coupling force. */
  readonly force: number;
  /** Normalized 0..1 camera trauma weight. */
  readonly trauma: number;
  /** Normalized stage boundary times [stage1Start, stage2Start] in 0..1 of duration. */
  readonly stages: readonly [number, number];
}

export const EXPLOSION_PRESETS: Record<ExplosionKind, ExplosionArtPreset> = {
  petrol: {
    label: 'Petrol Fireball',
    duration: 9.5,
    flash: 0.35, flashColor: 0xff8a3a,
    light: 0.72, lightColor: 0xff7a22,
    fire: 0.88, smoke: 0.9, sparks: 0.55,
    refraction: 0.75, debris: 0.38, debrisHeat: 0.75,
    force: 0.42, trauma: 0.45,
    stages: [0.03, 0.17],
  },
  c4: {
    label: 'Crisp Shock Blast',
    duration: 5.5,
    flash: 1.0, flashColor: 0xfff4e2,
    light: 1.0, lightColor: 0xfff1d6,
    fire: 0.45, smoke: 0.55, sparks: 0.78,
    refraction: 1.0, debris: 0.92, debrisHeat: 0.32,
    force: 0.95, trauma: 0.95,
    stages: [0.035, 0.18],
  },
  water: {
    label: 'Water Geyser',
    duration: 5.2,
    flash: 0.22, flashColor: 0xcfe8ff,
    light: 0.18, lightColor: 0xbce2ff,
    fire: 0, smoke: 0.85, sparks: 0,
    refraction: 0.55, debris: 0, debrisHeat: 0,
    force: 0.72, trauma: 0.58,
    stages: [0.02, 0.35],
  },
  electrical: {
    label: 'Electrical Arc',
    duration: 3.4,
    flash: 0.62, flashColor: 0x9cc0ff,
    light: 0.68, lightColor: 0x9cc4ff,
    fire: 0.08, smoke: 0.22, sparks: 0.86,
    refraction: 0.3, debris: 0.45, debrisHeat: 1.0,
    force: 0.18, trauma: 0.24,
    stages: [0.04, 0.28],
  },
  thermobaric: {
    label: 'Aerosol Cloud Bloom',
    duration: 10.5,
    flash: 0.92, flashColor: 0xffc67c,
    light: 1.0, lightColor: 0xff8c2e,
    fire: 1.0, smoke: 1.0, sparks: 0.65,
    refraction: 1.0, debris: 0.68, debrisHeat: 0.82,
    force: 1.0, trauma: 1.0,
    stages: [0.042, 0.14],
  },
  incendiary: {
    label: 'Incendiary Starburst',
    duration: 11.5,
    flash: 0.85, flashColor: 0xfff8d8,
    light: 0.84, lightColor: 0xffb347,
    fire: 0.78, smoke: 0.72, sparks: 1.0,
    refraction: 0.82, debris: 0.74, debrisHeat: 1.0,
    force: 0.35, trauma: 0.38,
    stages: [0.03, 0.28],
  },
  airburst: {
    label: 'Airburst Ring',
    duration: 7.2,
    flash: 0.96, flashColor: 0xfff6e0,
    light: 0.94, lightColor: 0xffd088,
    fire: 0.65, smoke: 0.78, sparks: 0.85,
    refraction: 0.95, debris: 0.6, debrisHeat: 0.72,
    force: 0.85, trauma: 0.82,
    stages: [0.03, 0.2],
  },
  magma: {
    label: 'Magma Rupture',
    duration: 12.0,
    flash: 0.48, flashColor: 0xff4c12,
    light: 0.88, lightColor: 0xff4a10,
    fire: 0.92, smoke: 0.95, sparks: 0.88,
    refraction: 0.96, debris: 0.95, debrisHeat: 1.0,
    force: 0.66, trauma: 0.74,
    stages: [0.038, 0.21],
  },
};

export interface ExplosionArtOverrides {
  /** Normalized multiplier on light & flash intensity (0..2, default 1). */
  intensity?: number;
  /** Normalized multiplier on smoke / ash output (0..2, default 1). */
  smoke?: number;
  /** Normalized multiplier on heat & shock refraction (0..2, default 1). */
  refraction?: number;
  /** Normalized multiplier on charred debris count (0..2, default 1). */
  debris?: number;
  /** Optional custom HDR light color override. */
  lightColor?: THREE.ColorRepresentation;
}

export interface ExplosionOptions {
  kind: ExplosionKind;
  position: THREE.Vector3;
  /** Artistic size scale: 0.4 = small, 1 = medium, 2.5 = heroic. */
  yield?: number;
  /** Spawn rigid-body charred debris (default: true for land detonations). */
  debris?: boolean;
  /**
   * What the charge sits on. Default: inferred (within 5 m of open water → `'water'`). Set
   * `'ground'` for decks, piers and bridges that stand over water.
   */
  surface?: 'ground' | 'water';
  /** Optional extra vertical offset (m) for `'airburst'` when triggered on ground. */
  altitude?: number;
  /** Optional normalized artistic overrides. */
  art?: ExplosionArtOverrides;
}

/**
 * TSL PBR material for charred, fissure-glowing rigid-body debris.
 * Reads `DebrisPool`'s HDR `instanceColor` (base soot + decaying heat excess) and sculpts
 * cracked charcoal crust with glowing molten fissures that cool to matte black soot.
 */
function createCharredDebrisMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  const inst = instanceColor as N;
  // A number that belongs to the piece and holds still while it cools. The pool adds its heat
  // glow to the instance colour along (6, 1.6, 0.25); this combination cancels the glow and
  // leaves the piece's own randomly scaled soot tone. Triangle waves of it give three
  // independent 0..1 values without a jump anywhere.
  const signature = inst.r.mul(1.6).sub(inst.g.mul(6));
  const pick = (frequency: number, phase: number): N => signature.mul(frequency).add(phase).fract().mul(2).sub(1).abs();
  const form = pick(260, 0.13), kind = pick(431, 0.57), tone = pick(977, 0.31);

  // One of the baked fragments per piece: the others collapse to a point and draw nothing.
  const chosen = form.mul(SHARD_VARIANTS).floor().min(SHARD_VARIANTS - 1);
  const mine = (attribute('shard', 'float') as N).sub(chosen).abs().lessThan(0.5);
  material.positionNode = select(mine, positionLocal, vec3(0, -1e6, 0));

  // Grain and cracks ride with the fragment (geometry space), not with the world it flies through.
  const p = positionGeometry.mul(5.5);
  const n1 = valueNoise3(p);
  const n2 = valueNoise3(p.mul(2.4).add(vec3(7.1, 3.3, 11.7)));
  const charGrain = n1.mul(0.62).add(n2.mul(0.38));
  // Narrow glowing crack network where hot fragments split open.
  const crackMask = smoothstep(0.54, 0.84, n2.mul(0.65).add(n1.mul(0.35)));
  const baseDark = inst.clamp(0, 0.35);
  // Heat excess above normal soot albedo drives incandescent fissures.
  const heatSignal = max(inst.r.sub(0.45), float(0));
  const heatNorm = heatSignal.div(heatSignal.add(2.2));

  // What the piece is made of: charred timber, scorched masonry or torn steel.
  const masonry = smoothstep(0.4, 0.48, kind).mul(smoothstep(0.8, 0.72, kind));
  const steel = smoothstep(0.76, 0.84, kind);
  const charColor = mix(vec3(0.018, 0.017, 0.016), baseDark.mul(0.85), charGrain.mul(0.8).add(0.15));
  const masonryColor = mix(vec3(0.2, 0.19, 0.175).mul(charGrain.mul(0.7).add(0.45)), charColor, 0.3);
  const steelColor = mix(vec3(0.045, 0.047, 0.052), vec3(0.13, 0.052, 0.024), smoothstep(0.45, 0.8, n1));
  material.colorNode = mix(mix(charColor, masonryColor, masonry), steelColor, steel).mul(tone.mul(0.7).add(0.65));
  const coldRoughness = mix(mix(float(0.93), float(0.97), masonry), float(0.52), steel);
  material.roughnessNode = mix(coldRoughness, float(0.42), heatNorm.mul(crackMask));
  material.metalnessNode = mix(mix(mix(float(0.08), float(0.28), charGrain), float(0.02), masonry), float(0.8), steel);
  // Heat shows in the fissures, not as an even orange coat: faces between cracks stay dark,
  // pieces hold their heat unequally, masonry barely glows and steel glows dully across its face.
  const retention = mix(float(0.3), float(1), tone).mul(mix(float(1), float(0.12), masonry));
  const glowing = mix(crackMask, crackMask.mul(0.6).add(0.4), steel);
  const ember = blackbody(heatNorm.mul(1.15)).mul(glowing.mul(0.97).add(0.03)).mul(smoothstep(0.02, 0.25, heatNorm));
  material.emissiveNode = ember.mul(retention).mul(1.65);
  return material;
}

/** How many differently broken fragments `shardGeometry` bakes. */
const SHARD_VARIANTS = 3;

/** One fractured fragment: a subdivided icosahedron clipped by random fracture planes, flat
 * shaded, so charred debris reads as a broken shard rather than one regular solid scaled on
 * three axes. `taper` (0..1) narrows it toward one end into a splinter; `depth` is how close
 * the fracture planes come to the centre (smaller cuts larger flat faces). Fills the pool's
 * ±0.45 cuboid collider on every axis; 80 triangles. */
function fragmentGeometry(seed: number, planeCount: number, depth: number, taper: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(0.5, 1);
  const position = geometry.getAttribute('position');
  const random = mulberry32(seed);
  const planes: number[][] = [];
  for (let i = 0; i < planeCount; i++) {
    const y = random() * 2 - 1, theta = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
    planes.push([Math.cos(theta) * r, y, Math.sin(theta) * r, depth + random() * 0.16]);
  }
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) * 2, y = position.getY(i) * 2, z = position.getZ(i) * 2;
    let radius = Math.min(0.5, 0.5 * (0.94 + 0.12 * Math.sin(5.1 * x + 3.3 * y) * Math.cos(4.7 * z - 2.1 * x)));
    for (const [nx, ny, nz, d] of planes) {
      const projected = x * nx + y * ny + z * nz;
      if (projected > 0.2) radius = Math.min(radius, d / projected);
    }
    const narrow = 1 - taper * (x * radius + 0.5);
    position.setXYZ(i, x * radius, y * radius * 0.82 * narrow, z * radius * narrow);
  }
  // Fill the collider on every axis so fragments rest on their faces without a gap.
  geometry.center();
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  geometry.scale(0.45 / Math.max(-min.x, max.x), 0.45 / Math.max(-min.y, max.y), 0.45 / Math.max(-min.z, max.z));
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals();
  return geometry;
}

/** The debris mesh: a chunk, a tapering splinter and a deeply cut slab in one buffer. A `shard`
 * attribute says which fragment a vertex belongs to and the material keeps one per piece, so a
 * burst is a mix of shapes for the same instance count. */
function shardGeometry(): THREE.BufferGeometry {
  const fragments = [
    fragmentGeometry(90127, 7, 0.24, 0),
    fragmentGeometry(51473, 5, 0.26, 0.74),
    fragmentGeometry(27691, 10, 0.13, 0.22),
  ];
  const count = fragments.reduce((sum, g) => sum + g.getAttribute('position').count, 0);
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), shard = new Float32Array(count);
  let offset = 0;
  fragments.forEach((g, variant) => {
    const n = g.getAttribute('position').count;
    position.set(g.getAttribute('position').array as Float32Array, offset * 3);
    normal.set(g.getAttribute('normal').array as Float32Array, offset * 3);
    shard.fill(variant, offset, offset + n);
    offset += n;
    g.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('shard', new THREE.BufferAttribute(shard, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// Fractions live with each effect and are released with it, including independent
// mist and spray streams that overlap during the short-lived fountain stage.
const enum Stream { Flame, Smoke, Sparks, Spray, Mist, SecondaryMist, SecondarySpray, Dust, AfterSmoke, AfterFlame, Count }
/** Long-lived spawn descriptors. A particle queue copies their values synchronously. */
function geyserSpray(size: number) {
  const column = Math.sqrt(size);
  return {
    jet: { position: new THREE.Vector3(), radius: 1.7 * size, velocity: { x: 0, y: 44 * column, z: 0 },
      spread: 4.6 * size, speedJitter: 0.55, life: 3.8, lifeJitter: 0.35, size: 0.22 * size, sizeEnd: 0.95 * size },
    vapour: { position: new THREE.Vector3(), radius: 1.7 * size, velocity: { x: 0, y: 17 * column, z: 0 },
      spread: 3.4 * size, speedJitter: 0.6, life: 4.2, size: 1.5 * size, sizeEnd: 6.8 * size },
    skirt: { position: new THREE.Vector3(), radius: 2 * size, velocity: { x: 0, y: 2.5, z: 0 },
      spread: 5 * size, life: 3.4, size: 1.6 * size, sizeEnd: 6.5 * size },
    droplets: { position: new THREE.Vector3(), radius: 3.2 * size, velocity: { x: 0, y: 10 * column, z: 0 },
      spread: 13 * size, life: 2.4, size: 0.35, sizeEnd: 1.4 },
    impact: { x: 0, z: 0, radius: 1, impulse: -0.12 * size, foam: 7 },
  };
}

interface SubCluster {
  carry: Float64Array;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; age: number;
  landed: boolean;
}

interface Active {
  fountain: ReturnType<typeof geyserSpray> | null;
  carry: Float64Array;
  id: number;
  kind: ExplosionKind;
  position: THREE.Vector3;
  groundOrigin: THREE.Vector3;
  age: number;
  yield: number;
  overWater: boolean;
  wantDebris: boolean;
  light: THREE.PointLight | null;
  fireLight: FireLightHandle | null;
  duration: number;
  flags: number;
  stage: number;
  arcs: THREE.Group | null;
  nextFlicker: number;
  flickers: number;
  flickerAge: number;
  intensityMul: number;
  smokeMul: number;
  refractionMul: number;
  debrisMul: number;
  lightColor: THREE.Color;
  clusters: SubCluster[];
}

export interface FireExposure {
  /** Direct exposure to rain and rain-wetted ground. Use zero beneath a roof. */
  rainExposure?: number;
  /** Keep a floating surface fire on registered water as its level changes. */
  followsWater?: boolean;
}

interface FireSource {
  heat: WorldSource;
  exposure: number;
  followsWater: boolean;
  vigor: number;
  carry: Float64Array;
  position: THREE.Vector3;
  size: number;
  remaining: number;
  id: number;
  fireLight: FireLightHandle;
}

/** The point-light intensities below were authored without a daylight reference: at the
 * Fire Lab's low sun a nominal petrol fireball lit the deck at ~500× the sun's irradiance
 * and flattened it to a white slab. Scale them so that fireball (5.5e4) gives ≈0.6× the
 * daylight irradiance (sun ≈ 10 scene units) at 10 m under this pool's 1.75 decay; the
 * relative strength of every kind and its envelope are unchanged. */
const DAYLIGHT_IRRADIANCE = 10;
const POINT_LIGHT_SCALE = (0.6 * DAYLIGHT_IRRADIANCE * Math.pow(10, 1.75)) / 5.5e4;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _crown = new THREE.Vector3();

export class Explosions implements EngineModule {
  private readonly thermalPulse = new WorldSource();
  private readonly fireFields = new FieldReading();
  private readonly steam = { position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    radius: 0, spread: 0.7, life: 2.1, size: 0, sizeEnd: 0, temperature: 0.08 };
  readonly debris: DebrisPool;
  /** Ground height for land detonations (dust, scorch, debris floor). */
  groundY = 0;
  /** Count of detonations (QA / HUD). */
  count = 0;

  private active: Active[] = [];
  private readonly volumes: FireVolume[];
  private volumeCursor = 0;
  private readonly geysers: GeyserSheets[];
  private geyserCursor = 0;
  private fires: FireSource[] = [];
  private lights: THREE.PointLight[] = [];
  private lightCursor = 0;
  private arcIntensity = uniform(0);
  private arcCore: THREE.NodeMaterial;
  private arcGlow: THREE.NodeMaterial;
  private fireId = 0;
  private activeId = 0;

  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit,
    private ocean: Ocean | null = null,
  ) {
    this.geysers = [new GeyserSheets(engine), new GeyserSheets(engine)];
    this.volumes = [new FireVolume(engine), new FireVolume(engine)];
    this.debris = new DebrisPool(engine.physics, 256);
    this.debris.setCapacity(engine.quality.preset.physics.maxDebris);
    // Replace default standard debris material with TSL charred/glowing fissure material.
    const oldMat = this.debris.mesh.material as THREE.Material;
    this.debris.mesh.material = createCharredDebrisMaterial();
    oldMat.dispose();
    const oldGeometry = this.debris.mesh.geometry;
    this.debris.mesh.geometry = shardGeometry();
    oldGeometry.dispose();
    engine.scene.add(this.debris.mesh);
    this.debris.onSplash = (position, speed) => this.splash(position, Math.min(1, speed / 25));

    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 0, 1.75);
      this.lights.push(light);
      engine.scene.add(light);
    }

    const arcColor = uniform(new THREE.Color(0.55, 0.75, 1.0));
    this.arcCore = boltMaterial(this.arcIntensity.mul(90), arcColor, 0.06, false);
    this.arcGlow = boltMaterial(this.arcIntensity.mul(40), arcColor, 0.9, true);

    // Compile arc + charred debris pipelines up front so the first detonation never hitches.
    const warm = boltGeometry([{ a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(0, 1, 0), power: 1 }]);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(warm, this.arcCore), new THREE.Mesh(warm, this.arcGlow));
    const debrisWarm = new THREE.InstancedMesh(this.debris.mesh.geometry, this.debris.mesh.material, 1);
    debrisWarm.setMatrixAt(0, new THREE.Matrix4());
    debrisWarm.setColorAt(0, new THREE.Color(0.2, 0.18, 0.16));
    debrisWarm.castShadow = true;
    group.add(debrisWarm);
    engine.prewarm(group);
  }


  /** Number of currently staged active explosions. */
  get activeCount(): number { return this.active.length; }

  /** Number of sustained fuel fires currently burning. */
  get fireCount(): number { return this.fires.length; }

  setQuality(preset: QualityPreset): void { this.debris.setCapacity(preset.physics.maxDebris); }

  private isOverWater(position: THREE.Vector3): boolean {
    if (!this.ocean) return false;
    if (this.ocean.depthAt(position.x, position.z) < 0.2) return false;
    return position.y - this.ocean.heightAt(position.x, position.z) < 5;
  }

  /** Small secondary splash (falling debris, spray fallback). */
  splash(position: THREE.Vector3, strength: number): void {
    if (!this.ocean) return;
    this.ocean.field.addSource({ x: position.x, z: position.z, radius: 1.2 + strength * 2, impulse: -0.25 * strength, foam: 4 * strength });
    this.emitCrown(position.x, position.y, position.z, 0.25 + 0.35 * strength, 3 + 3.4 * strength, 5 + 7 * strength, 1.4, 0.15, 0.6, Math.floor(40 + 160 * strength));
    this.engine.events.emit('splash', { position: [position.x, position.y, position.z], intensity: strength });
    this.engine.lens.splashAt(position, 2.5 + strength * 2, 0.7 * strength);
  }

  /**
   * Water thrown up by an impact, as a broad broken crown rather than a burst from one point
   * (which the velocity-stretched spray sprites drew as a spiky star). Lobes of unequal weight
   * leave a ring at uneven bearings, each leaning outward and smeared from the surface up to its
   * lip into a ragged sheet, with a scatter of heavier droplets falling inside. `count` is the
   * whole particle budget of the splash and is never exceeded.
   */
  private emitCrown(x: number, y: number, z: number, radius: number, outward: number, lift: number, life: number, size: number, sizeEnd: number, count: number): void {
    const spray = this.fx.spray;
    const lobes = count < 90 ? 3 : 5;
    const share = (count * 0.78) / lobes;
    let left = Math.floor(count * 0.78);
    let bearing = Math.random() * Math.PI * 2;
    for (let i = 0; i < lobes && left > 0; i++) {
      bearing += ((Math.PI * 2) / lobes) * (0.6 + Math.random() * 0.8);
      const ca = Math.cos(bearing), sa = Math.sin(bearing);
      const thrown = outward * (0.6 + Math.random() * 0.6);
      const n = Math.min(left, Math.max(1, Math.floor(share * (0.45 + Math.random() * 1.1))));
      left -= n;
      spray.emit({
        position: _crown.set(x + ca * radius, y, z + sa * radius), radius: radius * 0.7,
        velocity: { x: ca * thrown, y: lift * (0.7 + Math.random() * 0.5), z: sa * thrown },
        spread: thrown * 0.45, speedJitter: 0.8, life, lifeJitter: 0.45, size, sizeEnd, count: n,
      });
    }
    const droplets = count - (Math.floor(count * 0.78) - left);
    spray.emit({
      position: _crown.set(x, y, z), radius: radius * 1.6, velocity: { x: 0, y: lift * 0.55, z: 0 },
      spread: outward * 0.75, speedJitter: 0.6, life: life * 0.8, lifeJitter: 0.5, size: size * 1.7, sizeEnd: sizeEnd * 0.9, count: droplets,
    });
  }

  private coupleWorld(position: THREE.Vector3, blastRadius: number, impulse: number, windStrength: number, trauma: number, upBias = 0.35, kind = 'blast'): void {
    const { physics, wind, camera } = this.engine;
    physics?.applyBlast(position, blastRadius, impulse, upBias, kind);
    wind.addBlast(position, windStrength, blastRadius * 2, 1.1);
    this.engine.trauma.blast(position.distanceTo(camera.position), trauma);
  }

  private takeLight(position: THREE.Vector3, color: THREE.ColorRepresentation): THREE.PointLight {
    const light = this.lights[this.lightCursor++ % this.lights.length];
    light.position.copy(position);
    light.color.set(color);
    return light;
  }

  private emitDustOrSprayRing(center: THREE.Vector3, surfaceY: number, overWater: boolean, s: number, speed: number, segments: number, scale = 1): void {
    const pool = overWater ? this.fx.mist : this.fx.dust;
    const perSeg = Math.max(3, Math.floor(pool.burstBudget * 0.56 * scale / segments));
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2 + Math.random() * 0.4;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      pool.emit({
        position: _p.set(center.x + ca * 2.2 * s, surfaceY + 0.6, center.z + sa * 2.2 * s),
        radius: 2.0 * s,
        velocity: { x: ca * speed * s, y: 1.6, z: sa * speed * s },
        spread: 5.5 * s,
        life: 3.4,
        size: 2.1 * s,
        sizeEnd: 8.8 * s,
        count: perSeg,
      });
    }
  }

  /** Trigger any of the 8 staged game-art explosion archetypes. */
  detonate(options: ExplosionOptions): void {
    const { camera } = this.engine;
    const fx = this.fx;
    const preset = EXPLOSION_PRESETS[options.kind];
    const s = Math.max(0.25, options.yield ?? 1);
    const intensityMul = options.art?.intensity ?? 1;
    const smokeMul = options.art?.smoke ?? 1;
    const refractionMul = options.art?.refraction ?? 1;
    const debrisMul = options.art?.debris ?? 1;

    const position = options.position.clone();
    const overWater = options.kind === 'water' || (options.surface ? options.surface === 'water' : this.isOverWater(position));
    const sea = this.ocean ? this.ocean.heightAt(position.x, position.z) : this.groundY;
    const surfaceY = overWater ? sea : this.groundY;
    if (options.kind === 'water') position.y = sea;
    const groundOrigin = position.clone().setY(surfaceY);

    // Airburst naturally elevates above ground if triggered on a surface.
    if (options.kind === 'airburst') {
      const lift = options.altitude !== undefined ? options.altitude : (position.y - surfaceY < 2.2 ? 6.5 * s : 0);
      position.y += lift;
    }

    const thermal = this.thermalPulse.at(position.x,position.y,position.z);
    thermal.radius=Math.max(2,7*Math.sqrt(s)); thermal.heat=preset.fire*260;
    thermal.wetness=overWater?0.8:0; thermal.cloudCut=0.52;
    this.engine.world.publish(thermal,1.8,true);
    const distance = position.distanceTo(camera.position);
    const near = Math.min(1, 60 / (distance + 20));
    const wantDebris = (options.debris ?? !overWater) && debrisMul > 0.01;
    if (overWater) this.engine.lens.splashAt(position, 9 * s, options.kind === 'water' ? 1 : 0.7);

    const lightColor = new THREE.Color(options.art?.lightColor ?? preset.lightColor);
    const a: Active = {
      fountain: options.kind === 'water' ? geyserSpray(s) : null,
      carry: new Float64Array(Stream.Count),
      id: ++this.activeId,
      kind: options.kind,
      position,
      groundOrigin,
      age: 0,
      yield: s,
      overWater,
      wantDebris,
      light: null,
      fireLight: null,
      duration: preset.duration,
      flags: 0,
      stage: 0,
      arcs: null,
      nextFlicker: 0,
      flickers: 0,
      flickerAge: 1,
      intensityMul,
      smokeMul,
      refractionMul,
      debrisMul,
      lightColor,
      clusters: [],
    };
    if (options.kind === 'petrol' || options.kind === 'thermobaric') {
      const volume = this.volumes[this.volumeCursor++ % this.volumes.length];
      volume.start(position, s, options.kind === 'petrol' ? 0 : 0.48, a.id);
    }
    if (options.kind === 'water') this.geysers[this.geyserCursor++ % this.geysers.length].start(position, s, a.id);
    this.count++;
    this.engine.events.emit('explosion', { kind: options.kind, position: [position.x, position.y, position.z], intensity: s });

    switch (options.kind) {
      case 'petrol': {
        a.light = this.takeLight(_p.copy(position).setY(position.y + 3 * s), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 48 * s * intensityMul, radius: 28 * s, flicker: 0.16 });
        this.engine.flash(preset.flashColor, 0.5 * near * s * intensityMul, 7);
        // The ray-marched volume carries the fireball body; sprites add licking edges only.
        fx.fire.emit({ position: _p.copy(position).setY(position.y + 1.2 * s), radius: 1.4 * s, velocity: { x: 0, y: 4 * s, z: 0 }, spread: 9 * s, life: 1.1, size: 2.2 * s, sizeEnd: 5.6 * s, temperature: 0.95, count: Math.floor(fx.fire.burstBudget * 0.15) });
        fx.smoke.emit({ position: _p.copy(position).setY(position.y + 1.5 * s), radius: 1.6 * s, velocity: { x: 0, y: 3 * s, z: 0 }, spread: 6 * s, life: 6.5, size: 3 * s, sizeEnd: 11 * s, temperature: 0.95, count: Math.floor(fx.smoke.burstBudget * 0.1 * smokeMul) });
        fx.sparks.emit({ position, radius: 0.8 * s, velocity: { x: 0, y: 9 * s, z: 0 }, spread: 15 * s, life: 2.6, size: 0.14, temperature: 1, count: Math.floor(fx.sparks.burstBudget * 0.2) });
        fx.shockwave(position, { speed: 190, maxRadius: 34 * s, strength: 0.55 * refractionMul, hemisphere: !overWater, warmth: 0.45 });
        fx.heatHaze(_p.copy(position).setY(position.y + 3 * s), 6.5 * s, 1.1 * refractionMul, 6, 2.4, 0.22);
        if (wantDebris) this.debris.spawn({ count: Math.round(9 * s * debrisMul), origin: position, speed: [6, 16 * Math.sqrt(s)], size: [0.07, 0.5], upward: 0.6, heat: 1.2, color: 0x1a1715 });
        this.coupleWorld(position, 15 * s, 900 * s, 15 * s, 0.6 * s, 0.35, 'petrol');
        if (overWater) this.ocean!.field.addSource({ x: position.x, z: position.z, radius: 7 * s, impulse: -0.55 * s, foam: 6 });
        break;
      }

      case 'c4': {
        a.light = this.takeLight(_p.copy(position).setY(position.y + 1.5), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 140 * s * intensityMul, radius: 36 * s });
        this.engine.flash(preset.flashColor, 4.2 * near * Math.min(2, s) * intensityMul, 30);
        fx.fire.emit({ position: _p.copy(position).setY(position.y + 0.8), radius: 0.8 * s, velocity: { x: 0, y: 2, z: 0 }, spread: 23 * s, life: 0.3, lifeJitter: 0.5, size: 2 * s, sizeEnd: 7 * s, temperature: 1.35, count: Math.floor(fx.fire.burstBudget * 0.13) });
        fx.smoke.emit({ position: _p.copy(position).setY(position.y + 1.2), radius: 1.5 * s, velocity: { x: 0, y: 2.5, z: 0 }, spread: 10 * s, life: 4.6, size: 3 * s, sizeEnd: 10 * s, temperature: 0.22, count: Math.floor(fx.smoke.burstBudget * 0.08 * smokeMul) });
        fx.sparks.emit({ position, radius: 0.5, velocity: { x: 0, y: 7, z: 0 }, spread: 30 * Math.sqrt(s), life: 1.7, size: 0.1, temperature: 1.1, count: Math.floor(fx.sparks.burstBudget * 0.26) });
        fx.shockwave(position, { speed: 340, maxRadius: 115 * s, strength: 1.7 * refractionMul, condensation: 0.5 });
        fx.heatHaze(_p.copy(position).setY(position.y + 2 * s), 5 * s, 0.9 * refractionMul, 3.2, 1.8, 0.12);
        this.emitDustOrSprayRing(position, surfaceY, overWater, s, 19, 6, smokeMul);
        if (wantDebris) this.debris.spawn({ count: Math.round(30 * s * debrisMul), origin: position, speed: [13, 34 * Math.sqrt(s)], size: [0.06, 0.58], upward: 0.35, heat: 0.45, color: 0x332f2b });
        this.coupleWorld(position, 32 * s, 5200 * s, 42 * s, 1.6 * s, 0.35, 'c4');
        if (overWater) {
          this.ocean!.field.addSource({ x: position.x, z: position.z, radius: 9 * s, impulse: -1.2 * s, foam: 8 });
          this.emitCrown(position.x, sea + 0.3, position.z, 2.2 * s, 9 * s, 15 * s, 2.8, 0.4, 1.6, Math.floor(fx.spray.burstBudget * 0.2));
        }
        break;
      }

      case 'water': {
        a.fireLight = fx.addFireLight({ position: _p.set(position.x, sea + 2 * s, position.z), color: lightColor, intensity: 14 * s * intensityMul, radius: 18 * s });
        this.engine.flash(preset.flashColor, 0.35 * near * s * intensityMul, 14);
        this.ocean?.field.addSource({ x: position.x, z: position.z, radius: 6.5 * s, impulse: -2.0 * s, foam: 9 });
        fx.shockwave(_p.copy(position).setY(sea + 0.5), { speed: 240, maxRadius: 55 * s, strength: 0.9 * refractionMul, hemisphere: true, condensation: 0.65 });
        this.coupleWorld(_p.copy(position).setY(sea - 2), 34 * s, 3400 * s, 22 * s, 0.85 * s, 1.2, 'water');
        break;
      }

      case 'electrical': {
        a.light = this.takeLight(_p.copy(position).setY(position.y + 1), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 55 * s * intensityMul, radius: 22 * s });
        fx.smoke.emit({ position: _p.copy(position).setY(position.y + 0.6), radius: 0.5 * s, velocity: { x: 0, y: 1.5, z: 0 }, spread: 1.6, life: 3.2, size: 0.8 * s, sizeEnd: 3.2 * s, temperature: 0.12, count: Math.floor(fx.smoke.burstBudget * 0.014 * smokeMul) });
        this.debris.spawn({ count: Math.round(14 * s * debrisMul), origin: _p.copy(position).setY(position.y + 0.5), speed: [4, 13], size: [0.04, 0.09], upward: 0.7, heat: 3.5, color: 0x3a3632, lifetime: 3.2, restitution: 0.78 });
        fx.heatHaze(_p.copy(position).setY(position.y + 1.2), 2.8 * s, 0.65 * refractionMul, 2.8, 1.4, 0.05);
        this.coupleWorld(position, 7 * s, 240 * s, 8 * s, 0.32 * s, 0.35, 'electrical');
        break;
      }

      case 'thermobaric': {
        // Stage 0 (0..0.44 s): Aerosol dispersal cloud + subtle warm crackle before main bloom.
        a.light = this.takeLight(_p.copy(position).setY(position.y + 3.5 * s), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 16 * s * intensityMul, radius: 42 * s, flicker: 0.14 });
        this.engine.flash(0xffd29e, 0.25 * near * s * intensityMul, 16);
        fx.dust.emit({ position: _p.copy(position).setY(position.y + 1.4 * s), radius: 2.2 * s, velocity: { x: 0, y: 2.2 * s, z: 0 }, spread: 15 * s, life: 2.6, size: 2.8 * s, sizeEnd: 9.5 * s, count: Math.floor(fx.dust.burstBudget * 0.22 * smokeMul) });
        fx.mist.emit({ position: _p.copy(position).setY(position.y + 1.8 * s), radius: 2.6 * s, velocity: { x: 0, y: 1.5 * s, z: 0 }, spread: 13 * s, life: 1.8, size: 3.0 * s, sizeEnd: 10.5 * s, count: Math.floor(fx.mist.burstBudget * 0.14 * smokeMul) });
        fx.sparks.emit({ position, radius: 1.2 * s, velocity: { x: 0, y: 5 * s, z: 0 }, spread: 12 * s, life: 0.7, size: 0.12, temperature: 1.0, count: Math.floor(fx.sparks.burstBudget * 0.1) });
        this.engine.wind.addBlast(position, 14 * s, 26 * s, 0.5);
        break;
      }

      case 'incendiary': {
        // Stage 0 (0..0.35 s): High-luminance white-gold starburst + arcing burning sub-clusters.
        a.light = this.takeLight(_p.copy(position).setY(position.y + 2.5 * s), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 95 * s * intensityMul, radius: 34 * s, flicker: 0.24 });
        this.engine.flash(preset.flashColor, 2.4 * near * Math.min(1.8, s) * intensityMul, 18);
        fx.fire.emit({ position: _p.copy(position).setY(position.y + 1.1 * s), radius: 1.1 * s, velocity: { x: 0, y: 5 * s, z: 0 }, spread: 14 * s, life: 0.75, size: 1.6 * s, sizeEnd: 4.5 * s, temperature: 1.45, count: Math.floor(fx.fire.burstBudget * 0.2) });
        fx.sparks.emit({ position: _p.copy(position).setY(position.y + 0.8), radius: 0.9 * s, velocity: { x: 0, y: 11 * s, z: 0 }, spread: 24 * Math.sqrt(s), life: 2.8, lifeJitter: 0.45, size: 0.15, temperature: 1.45, count: Math.floor(fx.sparks.burstBudget * 0.36) });
        fx.shockwave(position, { speed: 210, maxRadius: 28 * s, strength: 0.48 * refractionMul, warmth: 0.65 });
        fx.heatHaze(_p.copy(position).setY(position.y + 2.4 * s), 5.2 * s, 1.05 * refractionMul, 6.5, 2.0, 0.26);
        if (wantDebris) this.debris.spawn({ count: Math.round(18 * s * debrisMul), origin: position, speed: [8, 22 * Math.sqrt(s)], size: [0.08, 0.26], upward: 0.72, heat: 3.4, color: 0x221c18, lifetime: 8, restitution: 0.48 });

        // Spawn 8–12 lightweight ballistic ember streamer clusters (pure game-art fountain).
        const clusterCount = Math.min(12, Math.max(6, Math.round(8 * Math.sqrt(s))));
        for (let c = 0; c < clusterCount; c++) {
          const ang = (c / clusterCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.45;
          const horiz = (6 + Math.random() * 11) * Math.sqrt(s);
          const up = (7 + Math.random() * 9) * Math.sqrt(s);
          a.clusters.push({
            carry: new Float64Array(Stream.Count),
            x: position.x, y: position.y + 0.7, z: position.z,
            vx: Math.cos(ang) * horiz, vy: up, vz: Math.sin(ang) * horiz,
            life: 6.5 + Math.random() * 4.2, age: 0, landed: false,
          });
        }
        this.coupleWorld(position, 14 * s, 720 * s, 14 * s, 0.52 * s, 0.45, 'incendiary');
        if (overWater) this.ocean!.field.addSource({ x: position.x, z: position.z, radius: 5 * s, impulse: -0.35 * s, foam: 5 });
        break;
      }

      case 'airburst': {
        // Stage 0 (0..0.22 s): Elevated solar flash + full spherical shockwave shell + cloud flash.
        a.light = this.takeLight(position, lightColor);
        a.fireLight = fx.addFireLight({ position, color: lightColor, intensity: 135 * s * intensityMul, radius: 48 * s, flicker: 0.08 });
        this.engine.flash(preset.flashColor, 3.6 * near * Math.min(2, s) * intensityMul, 24);
        fx.fire.emit({ position, radius: 1.4 * s, velocity: { x: 0, y: 1.5, z: 0 }, spread: 20 * s, life: 0.45, lifeJitter: 0.35, size: 2.4 * s, sizeEnd: 7.4 * s, temperature: 1.4, count: Math.floor(fx.fire.burstBudget * 0.22) });
        fx.sparks.emit({ position, radius: 1.0 * s, velocity: { x: 0, y: -1.5, z: 0 }, spread: 28 * Math.sqrt(s), life: 2.1, size: 0.13, temperature: 1.25, count: Math.floor(fx.sparks.burstBudget * 0.28) });
        fx.shockwave(position, { speed: 320, maxRadius: 120 * s, strength: 1.55 * refractionMul, condensation: 0.72, warmth: 0.25 });
        fx.heatHaze(position, 7.2 * s, 1.05 * refractionMul, 4.5, 1.4, 0.18);
        if (wantDebris) this.debris.spawn({ count: Math.round(18 * s * debrisMul), origin: position, speed: [10, 26 * Math.sqrt(s)], size: [0.09, 0.34], upward: 0.05, heat: 1.8, color: 0x24211f });
        this.coupleWorld(position, 34 * s, 4200 * s, 36 * s, 1.3 * s, -0.25, 'airburst');
        break;
      }

      case 'magma': {
        // Stage 0 (0..0.46 s): Volcanic crust swell, crimson underglow, intense rising heat refraction.
        a.light = this.takeLight(_p.copy(position).setY(position.y + 1.8 * s), lightColor);
        a.fireLight = fx.addFireLight({ position: _p, color: lightColor, intensity: 36 * s * intensityMul, radius: 34 * s, flicker: 0.25 });
        this.engine.flash(preset.flashColor, 0.55 * near * s * intensityMul, 6);
        fx.dust.emit({ position: _p.copy(position).setY(surfaceY + 0.5), radius: 2.6 * s, velocity: { x: 0, y: 3.5 * s, z: 0 }, spread: 8 * s, life: 3.2, size: 2.2 * s, sizeEnd: 7.5 * s, count: Math.floor(fx.dust.burstBudget * 0.16 * smokeMul) });
        fx.sparks.emit({ position: _p.copy(position).setY(surfaceY + 0.5), radius: 1.8 * s, velocity: { x: 0, y: 8 * s, z: 0 }, spread: 9 * s, life: 2.2, size: 0.16, temperature: 1.2, count: Math.floor(fx.sparks.burstBudget * 0.18) });
        fx.heatHaze(_p.copy(position).setY(surfaceY + 2.4 * s), 6.2 * s, 1.45 * refractionMul, 9.0, 1.6, 0.42);
        this.engine.trauma.blast(distance, 0.55 * s);
        break;
      }
    }

    this.active.push(a);
  }

  /** Start a sustained fuel fire (flames, black smoke column, HDR local fire light, heat refraction). Returns an id for `extinguish`. */
  ignite(position: THREE.Vector3, size = 1, duration = 30, options: FireExposure = {}): number {
    const id = ++this.fireId;
    const fireLight = this.fx.addFireLight({
      position: _p.set(position.x, position.y + 1.6 * size, position.z),
      color: 0xff7a22,
      intensity: 14 * size,
      radius: 18 * size,
      flicker: 0.22,
    });
    const heat = new WorldSource().at(position.x, position.y, position.z);
    heat.radius = Math.max(1, 3 * size);
    this.fires.push({ heat, vigor: 1, exposure: THREE.MathUtils.clamp(options.rainExposure ?? 1, 0, 1),
      followsWater: options.followsWater ?? false, carry: new Float64Array(Stream.Count), position: position.clone(), size, remaining: duration, id, fireLight });
    return id;
  }

  extinguish(id?: number): void {
    for (const f of this.fires) {
      if (id === undefined || f.id === id) { f.fireLight.remove(); this.engine.world.removeSource(f.heat); }
    }
    this.fires = id === undefined ? [] : this.fires.filter((f) => f.id !== id);
  }

  private rebuildArcs(a: Active): void {
    this.disposeArcs(a);
    const group = new THREE.Group();
    const origin = _p.copy(a.position).setY(a.position.y + 0.9);
    const segments: import('../weather/lightning').BoltSegment[] = [];
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 - 0.3, Math.random() - 0.5).normalize();
      const end = origin.clone().addScaledVector(dir, (1.8 + Math.random() * 4.5) * a.yield);
      end.y = Math.max(end.y, this.groundY + 0.02);
      segments.push(...growBolt(origin.clone(), end, { jaggedness: 0.32, branching: 0.5, depth: 2 }));
    }
    const geometry = boltGeometry(segments);
    const core = new THREE.Mesh(geometry, this.arcCore);
    const glow = new THREE.Mesh(geometry, this.arcGlow);
    core.frustumCulled = glow.frustumCulled = false;
    glow.renderOrder = 26;
    group.add(core, glow);
    this.engine.scene.add(group);
    a.arcs = group;
  }

  private disposeArcs(a: Active): void {
    if (!a.arcs) return;
    a.arcs.removeFromParent();
    (a.arcs.children[0] as THREE.Mesh).geometry.dispose();
    a.arcs = null;
  }

  private updateFountain(a: Active, plume: ReturnType<typeof geyserSpray>, sea: number, dt: number): void {
    const { age, position, carry } = a;
    const { mist, spray } = this.fx;
    if (age < 0.6) {
      plume.jet.position.set(position.x, sea + 0.4, position.z);
      spray.emitRateAt(carry, Stream.Spray, spray.burstBudget * 0.95, dt, plume.jet);
      plume.vapour.position.set(position.x, sea + 2, position.z);
      mist.emitRateAt(carry, Stream.Mist, mist.burstBudget * 0.16 * a.smokeMul, dt, plume.vapour);
    }
    if (age > 0.08 && age < 0.95) {
      const angle = Math.random() * Math.PI * 2;
      const dx = Math.cos(angle) * a.yield, dz = Math.sin(angle) * a.yield;
      plume.skirt.position.set(position.x + dx * 3, sea + 0.8, position.z + dz * 3);
      plume.skirt.velocity.x = dx * 15;
      plume.skirt.velocity.z = dz * 15;
      mist.emitRateAt(carry, Stream.SecondaryMist, mist.burstBudget * 0.12 * a.smokeMul, dt, plume.skirt);
      plume.droplets.position.set(position.x, sea + 0.3, position.z);
      spray.emitRateAt(carry, Stream.SecondarySpray, spray.burstBudget * 0.22, dt, plume.droplets);
    }
    if (age > 1.7 && age < 3.6 && this.ocean) {
      const angle = Math.random() * Math.PI * 2, r = (3 + Math.random() * 15) * a.yield;
      plume.impact.x = position.x + Math.cos(angle) * r;
      plume.impact.z = position.z + Math.sin(angle) * r;
      plume.impact.radius = 2.5 + Math.random() * 3;
      this.ocean.field.addSource(plume.impact);
      if (!(a.flags & 1) && age > 2.3) {
        a.flags |= 1;
        this.engine.events.emit('splash', { position: [position.x, sea, position.z], intensity: 1 });
      }
    }
  }

  update(dt: number): void {
    const fx = this.fx;
    const { camera } = this.engine;
    let arcLevel = 0;
    for (let i = 0; i < this.geysers.length; i++) this.geysers[i].update(dt);
    for (let i = 0; i < this.volumes.length; i++) this.volumes[i].update(dt);

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.age += dt;
      const s = a.yield, t = a.age, pos = a.position;
      const sea = this.ocean ? this.ocean.waterLevel : this.groundY;
      const surfaceY = a.overWater ? sea : this.groundY;
      const preset = EXPLOSION_PRESETS[a.kind];
      const frac = t / Math.max(a.duration, 1e-3);
      a.stage = frac < preset.stages[0] ? 0 : frac < preset.stages[1] ? 1 : 2;
      let localHdr = 0;

      if (a.kind === 'petrol') {
        const env = Math.exp(-t * 1.45) * (0.85 + 0.15 * Math.sin(t * 38)) + 0.07 * Math.max(0, 1 - t / a.duration);
        localHdr = 52 * s * env * a.intensityMul;
        if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 5.5e4 * s * s * env * a.intensityMul;
        if (a.fireLight) {
          a.fireLight.setPosition(pos.x, pos.y + Math.min(12 * s, 2.5 * s + t * 4.5 * s), pos.z);
          a.fireLight.setIntensity(localHdr);
        }
        if (t < 1.55) {
          const rise = 2 * s + 7.5 * t * s;
          fx.fire.emitRateAt(a.carry, Stream.Flame, fx.fire.burstBudget * 0.26, dt, { position: _p.set(pos.x, pos.y + rise, pos.z), radius: 2.6 * s, velocity: { x: 0, y: 7.5 * s, z: 0 }, spread: 3.8 * s, life: 0.95, size: 3 * s, sizeEnd: 6.2 * s, temperature: 0.95 - t * 0.2 });
          fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.11 * a.smokeMul, dt, { position: _p.set(pos.x, pos.y + rise * 0.8, pos.z), radius: 2.6 * s, velocity: { x: 0, y: 6 * s, z: 0 }, spread: 3.2 * s, life: 7.5, size: 4 * s, sizeEnd: 14 * s, temperature: 0.75 });
        } else {
          const k = Math.max(0, 1 - (t - 1.55) / (a.duration - 1.55));
          // Pool burn: ~40 % fewer, slightly larger, cooler tongues spread over the film.
          // Dozens of hot additive sprites stacked in one spot summed to a white slab.
          fx.fire.emitRateAt(a.carry, Stream.Flame, fx.fire.burstBudget * 0.08 * k, dt, { position: _p.set(pos.x, pos.y + 0.6, pos.z), radius: 2.6 * s, velocity: { x: 0, y: 3.2, z: 0 }, spread: 1.6, life: 0.85, size: 2.0 * s, sizeEnd: 3.4 * s, temperature: 0.8 });
          fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.065 * (0.35 + 0.65 * k) * a.smokeMul, dt, { position: _p.set(pos.x, pos.y + 2.2 * s, pos.z), radius: 1.6 * s, velocity: { x: 0, y: 3.6, z: 0 }, spread: 1.4, life: 8.5, size: 2.6 * s, sizeEnd: 12.5 * s, temperature: 0.38 });
          fx.sparks.emitRateAt(a.carry, Stream.Sparks, 22 * k * s, dt, { position: _p.set(pos.x, pos.y + 1, pos.z), radius: 1.5 * s, velocity: { x: 0, y: 6, z: 0 }, spread: 3.5, life: 2.6, size: 0.1, temperature: 0.9 });
          if (!(a.flags & 1) && t > 1.6) { a.flags |= 1; fx.heatHaze(_p.set(pos.x, pos.y + 3 * s, pos.z), 5 * s, 0.9 * a.refractionMul, 7, 1.2, 0.2); }
        }
      } else if (a.kind === 'c4') {
        const env = Math.exp(-t * 15);
        localHdr = 140 * s * env * a.intensityMul;
        if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 4.5e5 * s * s * env * a.intensityMul;
        if (a.fireLight) a.fireLight.setIntensity(localHdr);
      } else if (a.fountain) {
        localHdr = 14 * s * Math.exp(-t * 6) * a.intensityMul;
        if (a.fireLight) a.fireLight.setIntensity(localHdr);
        this.updateFountain(a, a.fountain, sea, dt);
      } else if (a.kind === 'electrical') {
        if (t >= a.nextFlicker && a.flickers < 7 && t < 0.92) {
          a.flickers++;
          a.nextFlicker = t + 0.045 + Math.random() * 0.13;
          a.flags = 1;
          this.rebuildArcs(a);
          const near = Math.min(1, 50 / (pos.distanceTo(camera.position) + 15));
          this.engine.flash(0x9cc0ff, 1.5 * near * Math.min(1.5, s) * a.intensityMul, 42);
          fx.sparks.emit({ position: _p.set(pos.x, pos.y + 0.8, pos.z), radius: 0.3, velocity: { x: 0, y: 5.5, z: 0 }, spread: 13 * Math.sqrt(s), life: 2.3, lifeJitter: 0.6, size: 0.085, temperature: 1.25, count: Math.floor(fx.sparks.burstBudget * 0.07) });
          a.flickerAge = 0;
        }
        a.flickerAge += dt;
        const level = a.flags ? Math.exp(-a.flickerAge / 0.035) : 0;
        arcLevel = Math.max(arcLevel, level);
        localHdr = 68 * s * level * a.intensityMul;
        if (a.arcs) a.arcs.visible = level > 0.04;
        if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 9e4 * s * level * a.intensityMul;
        if (a.fireLight) a.fireLight.setIntensity(localHdr);
      } else if (a.kind === 'thermobaric') {
        // Stage 0 (0..0.44 s): aerosol mist/dust cloud grows.
        if (t < 0.44) {
          const env = 0.25 + 0.75 * (t / 0.44);
          localHdr = 18 * s * env * a.intensityMul;
          if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 1.6e4 * s * s * env * a.intensityMul;
          if (a.fireLight) a.fireLight.setIntensity(localHdr);
          fx.dust.emitRateAt(a.carry, Stream.Dust, fx.dust.burstBudget * 0.25 * a.smokeMul, dt, { position: _p.set(pos.x, pos.y + 1.5 * s, pos.z), radius: (2.2 + t * 9) * s, velocity: { x: 0, y: 1.8 * s, z: 0 }, spread: 10 * s, life: 2.2, size: 3.2 * s, sizeEnd: 11 * s });
        } else {
          // Stage 1 trigger at t >= 0.44 s: entire cloud flashes into incandescent bloom + double shock.
          if (!(a.flags & 1)) {
            a.flags |= 1;
            const near = Math.min(1, 75 / (pos.distanceTo(camera.position) + 20));
            this.engine.flash(preset.flashColor, 3.4 * near * Math.min(2, s) * a.intensityMul, 14);
            fx.fire.emit({ position: _p.set(pos.x, pos.y + 2.4 * s, pos.z), radius: 4.5 * s, velocity: { x: 0, y: 6.5 * s, z: 0 }, spread: 18 * s, life: 1.45, lifeJitter: 0.35, size: 3.8 * s, sizeEnd: 9.5 * s, temperature: 1.35, count: Math.floor(fx.fire.burstBudget * 0.38) });
            fx.smoke.emit({ position: _p.set(pos.x, pos.y + 2.6 * s, pos.z), radius: 5.0 * s, velocity: { x: 0, y: 5.5 * s, z: 0 }, spread: 11 * s, life: 8.5, size: 4.5 * s, sizeEnd: 16 * s, temperature: 1.05, count: Math.floor(fx.smoke.burstBudget * 0.16 * a.smokeMul) });
            fx.sparks.emit({ position: _p.set(pos.x, pos.y + 1.8 * s, pos.z), radius: 3.2 * s, velocity: { x: 0, y: 11 * s, z: 0 }, spread: 24 * s, life: 3.0, size: 0.14, temperature: 1.25, count: Math.floor(fx.sparks.burstBudget * 0.24) });
            fx.shockwave(_p.set(pos.x, pos.y + 1.4 * s, pos.z), { speed: 290, maxRadius: 110 * s, strength: 1.65 * a.refractionMul, hemisphere: !a.overWater, condensation: 0.85, warmth: 0.5 });
            fx.shockwave(_p.set(pos.x, pos.y + 2.2 * s, pos.z), { speed: 185, maxRadius: 68 * s, strength: 0.9 * a.refractionMul, hemisphere: !a.overWater, condensation: 0.55, warmth: 0.85 });
            fx.heatHaze(_p.set(pos.x, pos.y + 4.5 * s, pos.z), 9.5 * s, 1.4 * a.refractionMul, 8.5, 2.8, 0.34, 0.6);
            this.emitDustOrSprayRing(pos, surfaceY, a.overWater, s * 1.2, 22, 8, a.smokeMul);
            if (a.wantDebris) this.debris.spawn({ count: Math.round(22 * s * a.debrisMul), origin: pos, speed: [11, 28 * Math.sqrt(s)], size: [0.12, 0.48], upward: 0.45, heat: 1.5, color: 0x1e1916 });
            this.coupleWorld(pos, 38 * s, 5600 * s, 48 * s, 1.75 * s, 0.4, 'thermobaric');
            if (a.overWater) {
              this.ocean!.field.addSource({ x: pos.x, z: pos.z, radius: 11 * s, impulse: -1.4 * s, foam: 9 });
              this.emitCrown(pos.x, sea + 0.4, pos.z, 3 * s, 10.5 * s, 17 * s, 3.0, 0.4, 1.7, Math.floor(fx.spray.burstBudget * 0.22));
            }
          }
          const t1 = t - 0.44;
          const env = Math.exp(-t1 * 1.15) * (0.88 + 0.12 * Math.sin(t1 * 32)) + 0.08 * Math.max(0, 1 - t1 / (a.duration - 0.44));
          localHdr = 115 * s * env * a.intensityMul;
          const rise = Math.min(18 * s, 3.2 * s + t1 * 6.8 * s);
          if (a.light) {
            a.light.position.set(pos.x, pos.y + rise * 0.7, pos.z);
            a.light.intensity = POINT_LIGHT_SCALE * 1.4e5 * s * s * env * a.intensityMul;
          }
          if (a.fireLight) {
            a.fireLight.setPosition(pos.x, pos.y + rise * 0.75, pos.z);
            a.fireLight.setIntensity(localHdr);
          }
          if (t1 < 1.35) {
            fx.fire.emitRateAt(a.carry, Stream.Flame, fx.fire.burstBudget * 0.48, dt, { position: _p.set(pos.x, pos.y + rise, pos.z), radius: 3.6 * s, velocity: { x: 0, y: 9.5 * s, z: 0 }, spread: 5.2 * s, life: 1.1, size: 3.8 * s, sizeEnd: 8.4 * s, temperature: 1.15 - t1 * 0.25 });
            fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.14 * a.smokeMul, dt, { position: _p.set(pos.x, pos.y + rise * 0.85, pos.z), radius: 4.0 * s, velocity: { x: 0, y: 7.5 * s, z: 0 }, spread: 4.5 * s, life: 9.0, size: 4.8 * s, sizeEnd: 17 * s, temperature: 0.82 });
          } else {
            // Stage 2: Stem inrush and towering glowing-belly mushroom cap.
            if (!(a.flags & 2)) {
              a.flags |= 2;
              fx.heatHaze(_p.set(pos.x, pos.y + 4 * s, pos.z), 7.5 * s, 1.0 * a.refractionMul, 7.5, 2.2, 0.24);
            }
            const k = Math.max(0, 1 - (t1 - 1.35) / (a.duration - 1.8));
            // Inward-drawn stem smoke pulled into the rising thermal column.
            const ang = Math.random() * Math.PI * 2;
            const ringR = 5.5 * s;
            fx.smoke.emitRateAt(a.carry, Stream.AfterSmoke, fx.smoke.burstBudget * 0.08 * (0.25 + 0.75 * k) * a.smokeMul, dt, {
              position: _p.set(pos.x + Math.cos(ang) * ringR, surfaceY + 1.0, pos.z + Math.sin(ang) * ringR),
              radius: 1.8 * s,
              velocity: { x: -Math.cos(ang) * 4.5 * s, y: 5.5 * s, z: -Math.sin(ang) * 4.5 * s },
              spread: 2.0,
              life: 8.5,
              size: 2.8 * s,
              sizeEnd: 14 * s,
              temperature: 0.45 * k,
            });
            fx.fire.emitRateAt(a.carry, Stream.AfterFlame, fx.fire.burstBudget * 0.09 * k, dt, { position: _p.set(pos.x, pos.y + 1.2, pos.z), radius: 2.8 * s, velocity: { x: 0, y: 4.0, z: 0 }, spread: 2.0, life: 0.85, size: 1.9 * s, sizeEnd: 3.8 * s, temperature: 0.85 });
          }
        }
      } else if (a.kind === 'incendiary') {
        const env = Math.exp(-t * 2.1) * 0.75 + 0.25 * Math.max(0, 1 - t / a.duration) * (0.8 + 0.2 * Math.sin(t * 29));
        localHdr = 72 * s * env * a.intensityMul;
        if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 8.5e4 * s * s * env * a.intensityMul;
        if (a.fireLight) a.fireLight.setIntensity(localHdr);

        // Step arcing burning streamer clusters → curling smoke ribbons + lingering ground firelets.
        for (let ci = 0; ci < a.clusters.length; ci++) {
          const cl = a.clusters[ci];
          cl.age += dt;
          if (cl.age > cl.life) continue;
          const k = Math.max(0, 1 - cl.age / cl.life);
          if (!cl.landed) {
            cl.vy -= 9.81 * dt;
            cl.vx *= Math.exp(-0.22 * dt);
            cl.vz *= Math.exp(-0.22 * dt);
            cl.x += cl.vx * dt;
            cl.y += cl.vy * dt;
            cl.z += cl.vz * dt;
            if (cl.y <= surfaceY + 0.12) {
              cl.y = surfaceY + 0.12;
              if (a.overWater) {
                this.splash(_p.set(cl.x, sea, cl.z), 0.32 * s);
                fx.mist.emit({ position: _p, radius: 0.7, velocity: { x: 0, y: 3.4, z: 0 }, spread: 1.6, life: 3.0, size: 0.9, sizeEnd: 3.6, count: 14 });
                cl.age = cl.life; // quenched in water
                continue;
              }
              cl.vx *= 0.25; cl.vz *= 0.25; cl.vy = 0; cl.landed = true;
              if (ci % 3 === 0) fx.heatHaze(_p.set(cl.x, cl.y + 1.8, cl.z), 2.8 * s, 0.75 * a.refractionMul, 5.5, 1.3, 0.25);
            }
            fx.sparks.emitRateAt(cl.carry, Stream.Sparks, 36 * s, dt, { position: _p.set(cl.x, cl.y, cl.z), radius: 0.18, velocity: { x: -cl.vx * 0.15, y: 1.2, z: -cl.vz * 0.15 }, spread: 2.6, life: 0.9, size: 0.11, temperature: 1.4 });
            fx.smoke.emitRateAt(cl.carry, Stream.Smoke, 14 * a.smokeMul, dt, { position: _p.set(cl.x, cl.y, cl.z), radius: 0.22, velocity: { x: 0, y: 1.8, z: 0 }, spread: 0.7, life: 4.8, size: 0.55 * s, sizeEnd: 2.6 * s, temperature: 0.55 });
          } else {
            // Stage 2: Lingering ground ember firelets.
            fx.fire.emitRateAt(cl.carry, Stream.Flame, 14 * k * s, dt, { position: _p.set(cl.x, cl.y + 0.2, cl.z), radius: 0.45 * s, velocity: { x: 0, y: 2.5, z: 0 }, spread: 0.9, life: 0.65, size: 0.65 * s, sizeEnd: 1.5 * s, temperature: 1.05 });
            fx.smoke.emitRateAt(cl.carry, Stream.AfterSmoke, 7 * k * a.smokeMul, dt, { position: _p.set(cl.x, cl.y + 0.7, cl.z), radius: 0.5 * s, velocity: { x: 0, y: 2.8, z: 0 }, spread: 0.8, life: 5.5, size: 0.8 * s, sizeEnd: 3.4 * s, temperature: 0.25 });
            if (Math.random() < dt * 2.2 * k) {
              fx.sparks.emit({ position: _p.set(cl.x, cl.y + 0.15, cl.z), radius: 0.3, velocity: { x: 0, y: 4.2, z: 0 }, spread: 3.0, life: 1.6, size: 0.08, temperature: 1.15, count: 4 });
            }
          }
        }
      } else if (a.kind === 'airburst') {
        const env = Math.exp(-t * 2.6) * 0.85 + 0.15 * Math.exp(-t * 0.45);
        localHdr = 130 * s * env * a.intensityMul;
        if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 2.8e5 * s * s * env * a.intensityMul;
        if (a.fireLight) a.fireLight.setIntensity(localHdr);

        // Stage 1 trigger (t >= 0.18 s): Toroidal fire/smoke ring + ground/water downwash ring underneath!
        if (!(a.flags & 1) && t >= 0.16) {
          a.flags |= 1;
          const ringSegs = 10;
          const ringR = 2.8 * s;
          for (let k = 0; k < ringSegs; k++) {
            const ang = (k / ringSegs) * Math.PI * 2;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            fx.fire.emit({
              position: _p.set(pos.x + ca * ringR, pos.y, pos.z + sa * ringR),
              radius: 1.2 * s,
              velocity: { x: ca * 11 * s, y: 1.2 * s, z: sa * 11 * s },
              spread: 3.2 * s,
              life: 0.9,
              size: 2.2 * s,
              sizeEnd: 5.8 * s,
              temperature: 1.1,
              count: Math.max(4, Math.floor(fx.fire.burstBudget * 0.018)),
            });
            fx.smoke.emit({
              position: _p.set(pos.x + ca * ringR * 1.1, pos.y + 0.5, pos.z + sa * ringR * 1.1),
              radius: 1.6 * s,
              velocity: { x: ca * 8.5 * s, y: 2.0 * s, z: sa * 8.5 * s },
              spread: 2.6 * s,
              life: 6.5,
              size: 2.6 * s,
              sizeEnd: 10.5 * s,
              temperature: 0.45,
              count: Math.max(4, Math.floor(fx.smoke.burstBudget * 0.012 * a.smokeMul)),
            });
          }
          // Ground/water pressure front reflection ring directly underneath.
          this.emitDustOrSprayRing(a.groundOrigin, surfaceY, a.overWater, s * 1.15, 18, 7, a.smokeMul);
          if (a.overWater && this.ocean) {
            this.ocean.field.addSource({ x: pos.x, z: pos.z, radius: 10 * s, impulse: -1.1 * s, foam: 8 });
            this.emitCrown(pos.x, sea + 0.3, pos.z, 3 * s, 11 * s, 11 * s, 2.4, 0.3, 1.3, Math.floor(fx.spray.burstBudget * 0.16));
          }
        }
        // Stage 2: Lingering smoky ring drift + faint glowing embers.
        if (t > 0.45 && t < 3.5) {
          const k = Math.max(0, 1 - (t - 0.45) / 3.05);
          const ang = t * 11;
          const ringR = (3.5 + t * 3.2) * s;
          fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.05 * k * a.smokeMul, dt, {
            position: _p.set(pos.x + Math.cos(ang) * ringR, pos.y + t * 1.2, pos.z + Math.sin(ang) * ringR),
            radius: 1.4 * s,
            velocity: { x: 0, y: 2.2, z: 0 },
            spread: 1.8,
            life: 5.5,
            size: 2.4 * s,
            sizeEnd: 9.5 * s,
            temperature: 0.18 * k,
          });
        }
      } else if (a.kind === 'magma') {
        if (t < 0.46) {
          // Stage 0: Crust swell & crimson fissure glow builds up.
          const ramp = t / 0.46;
          localHdr = (25 + 65 * ramp) * s * a.intensityMul;
          if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 6e4 * s * s * ramp * a.intensityMul;
          if (a.fireLight) a.fireLight.setIntensity(localHdr);
          fx.fire.emitRateAt(a.carry, Stream.AfterFlame, fx.fire.burstBudget * 0.16 * ramp, dt, { position: _p.set(pos.x, surfaceY + 0.4, pos.z), radius: 2.2 * s, velocity: { x: 0, y: 4.5 * s, z: 0 }, spread: 3.5 * s, life: 0.6, size: 1.4 * s, sizeEnd: 3.0 * s, temperature: 0.88 });
        } else {
          // Stage 1 eruption trigger at t >= 0.46 s: heavy ballistic molten lava bombs + volcanic ash plume.
          if (!(a.flags & 1)) {
            a.flags |= 1;
            const near = Math.min(1, 65 / (pos.distanceTo(camera.position) + 20));
            this.engine.flash(0xff5214, 1.35 * near * s * a.intensityMul, 9);
            fx.fire.emit({ position: _p.set(pos.x, surfaceY + 1.2 * s, pos.z), radius: 2.0 * s, velocity: { x: 0, y: 14 * s, z: 0 }, spread: 9 * s, life: 1.4, size: 2.4 * s, sizeEnd: 6.2 * s, temperature: 1.15, count: Math.floor(fx.fire.burstBudget * 0.28) });
            fx.smoke.emit({ position: _p.set(pos.x, surfaceY + 1.8 * s, pos.z), radius: 2.4 * s, velocity: { x: 0, y: 9.5 * s, z: 0 }, spread: 6.5 * s, life: 10.5, size: 3.6 * s, sizeEnd: 16 * s, temperature: 0.9, count: Math.floor(fx.smoke.burstBudget * 0.15 * a.smokeMul) });
            fx.sparks.emit({ position: _p.set(pos.x, surfaceY + 0.9, pos.z), radius: 1.5 * s, velocity: { x: 0, y: 18 * Math.sqrt(s), z: 0 }, spread: 13 * s, life: 3.4, size: 0.18, temperature: 1.3, count: Math.floor(fx.sparks.burstBudget * 0.3) });
            fx.shockwave(_p.set(pos.x, surfaceY + 0.8, pos.z), { speed: 170, maxRadius: 42 * s, strength: 0.85 * a.refractionMul, hemisphere: true, condensation: 0.45, warmth: 0.95 });
            if (a.wantDebris) {
              // Heavy volcanic basaltic lava bombs that arc high and cool from incandescent orange to black crust.
              this.debris.spawn({ count: Math.round(28 * s * a.debrisMul), origin: _p.set(pos.x, surfaceY + 0.6, pos.z), speed: [10, 24 * Math.sqrt(s)], size: [0.16, 0.56], upward: 0.85, heat: 3.8, color: 0x161211, lifetime: 11, restitution: 0.22 });
            }
            this.coupleWorld(pos, 22 * s, 2600 * s, 26 * s, 1.15 * s, 0.78, 'magma');
            if (a.overWater && this.ocean) {
              this.ocean.field.addSource({ x: pos.x, z: pos.z, radius: 9 * s, impulse: -1.1 * s, foam: 9 });
              fx.mist.emit({ position: _p.set(pos.x, sea + 0.8, pos.z), radius: 4.5 * s, velocity: { x: 0, y: 11 * s, z: 0 }, spread: 10 * s, life: 6.0, size: 3.4 * s, sizeEnd: 13 * s, count: Math.floor(fx.mist.burstBudget * 0.24 * a.smokeMul) });
            }
          }
          const t1 = t - 0.46;
          const k = Math.max(0, 1 - t1 / (a.duration - 0.46));
          const pulse = 0.82 + 0.18 * Math.sin(t1 * 17) + 0.12 * Math.sin(t1 * 41);
          const env = (Math.exp(-t1 * 0.65) * 0.75 + 0.25 * k) * pulse;
          localHdr = 92 * s * env * a.intensityMul;
          if (a.light) a.light.intensity = POINT_LIGHT_SCALE * 9.5e4 * s * s * env * a.intensityMul;
          if (a.fireLight) a.fireLight.setIntensity(localHdr);

          if (t1 < 2.2) {
            // Stage 1: Pulsing molten ejecta fountain & thick ash plume.
            fx.fire.emitRateAt(a.carry, Stream.Flame, fx.fire.burstBudget * 0.34, dt, { position: _p.set(pos.x, surfaceY + 1.0 * s, pos.z), radius: 2.0 * s, velocity: { x: 0, y: 12 * s, z: 0 }, spread: 4.5 * s, life: 1.05, size: 2.0 * s, sizeEnd: 5.0 * s, temperature: 0.98 });
            fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.11 * a.smokeMul, dt, { position: _p.set(pos.x, surfaceY + 3.0 * s, pos.z), radius: 2.4 * s, velocity: { x: 0, y: 8.5 * s, z: 0 }, spread: 3.8 * s, life: 10.0, size: 3.4 * s, sizeEnd: 15 * s, temperature: 0.65 });
            fx.sparks.emitRateAt(a.carry, Stream.Sparks, 42 * s, dt, { position: _p.set(pos.x, surfaceY + 0.8, pos.z), radius: 1.6 * s, velocity: { x: 0, y: 15 * Math.sqrt(s), z: 0 }, spread: 9 * s, life: 2.8, size: 0.14, temperature: 1.2 });
          } else {
            // Stage 2: Sustained glowing magma crater bed + heavy convective shimmer + ash column.
            if (!(a.flags & 2)) {
              a.flags |= 2;
              fx.heatHaze(_p.set(pos.x, surfaceY + 2.8 * s, pos.z), 6.0 * s, 1.25 * a.refractionMul, 8.5, 1.5, 0.38);
            }
            fx.fire.emitRateAt(a.carry, Stream.Flame, fx.fire.burstBudget * 0.11 * k, dt, { position: _p.set(pos.x, surfaceY + 0.4, pos.z), radius: 2.4 * s, velocity: { x: 0, y: 2.8, z: 0 }, spread: 1.8, life: 0.85, size: 1.6 * s, sizeEnd: 3.2 * s, temperature: 0.82 });
            fx.smoke.emitRateAt(a.carry, Stream.Smoke, fx.smoke.burstBudget * 0.065 * (0.25 + 0.75 * k) * a.smokeMul, dt, { position: _p.set(pos.x, surfaceY + 2.2 * s, pos.z), radius: 2.0 * s, velocity: { x: 0, y: 4.5, z: 0 }, spread: 1.6, life: 9.5, size: 2.8 * s, sizeEnd: 14 * s, temperature: 0.35 * k });
            if (a.overWater) {
              fx.mist.emitRateAt(a.carry, Stream.Mist, fx.mist.burstBudget * 0.08 * k * a.smokeMul, dt, { position: _p.set(pos.x, sea + 0.5, pos.z), radius: 3.0 * s, velocity: { x: 0, y: 4.2, z: 0 }, spread: 2.4, life: 4.2, size: 2.0 * s, sizeEnd: 8.5 * s });
            }
          }
        }
      }

      if (a.age >= a.duration) {
        if (a.light) a.light.intensity = 0;
        a.fireLight?.remove();
        this.disposeArcs(a);
        this.active.splice(i, 1);
      }
    }
    this.arcIntensity.value = arcLevel;

    // Sustained fuel fires.
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      const world = this.engine.world;
      const fields = world.read(f.position, this.engine.time, this.fireFields);
      const surface = world.waterHeight(f.position.x, f.position.z);
      if (f.followsWater && Number.isFinite(surface)) {
        f.position.y = surface;
        f.fireLight.setPosition(f.position.x, surface + 1.6 * f.size, f.position.z);
      }
      const submerged = f.position.y < surface - 0.15 * f.size;
      const localSpray = Math.max(0, fields.wetness - world.rainFilmAt(f.position.x, f.position.y, f.position.z));
      const quench = submerged ? 2 : 0.15 * world.rainfall * f.exposure * world.shelters.exposureAt(f.position.x, f.position.y, f.position.z) + 0.4 * localSpray;
      const before = f.vigor;
      f.vigor = Math.max(0, f.vigor - quench * dt / Math.max(0.25, Math.sqrt(f.size)));
      const lost = before - f.vigor;
      if (lost > 0 && dt > 0) {
        const steam = this.steam;
        steam.position.copy(f.position);
        steam.position.y = (submerged ? surface : f.position.y) + 0.12 * f.size;
        steam.velocity.set(fields.wind.x * 0.25, 1.1 + Math.sqrt(f.size), fields.wind.z * 0.25);
        steam.radius = 0.6 * f.size; steam.size = 0.36 * f.size; steam.sizeEnd = 1.8 * f.size;
        // Each unit of extinguished fuel can produce a bounded amount of visible condensate.
        const particles = Math.min(fx.mist.burstBudget * 0.32, 58 * f.size * f.size);
        fx.mist.emitRateAt(f.carry, Stream.Mist, lost * particles / dt, dt, steam);
      }
      f.remaining -= dt;
      if (f.remaining <= 0 || f.vigor <= 0.005) {
        world.removeSource(f.heat);
        f.fireLight.remove();
        this.fires.splice(i, 1);
        continue;
      }
      if (submerged) {
        f.fireLight.setIntensity(0);
        world.removeSource(f.heat);
        continue;
      }
      const k = Math.min(1, f.remaining / 3) * f.vigor, z = f.size;
      f.heat.at(f.position.x, f.position.y, f.position.z);
      f.heat.heat = 270 * k;
      f.heat.lift = 1.4 * z * k;
      world.publish(f.heat, 0.3);
      const wind = fields.wind;
      f.fireLight.setIntensity(14 * z * k);
      fx.fire.emitRateAt(f.carry, Stream.Flame, fx.fire.burstBudget * 0.16 * k, dt, { position: _p.set(f.position.x, f.position.y + 0.5 * z, f.position.z), radius: 1.5 * z, velocity: _v.set(wind.x * 0.16, 3.4 * z, wind.z * 0.16), spread: 1.4 * z, life: 0.9, size: 1.6 * z, sizeEnd: 3 * z, temperature: 0.95 });
      fx.smoke.emitRateAt(f.carry, Stream.Smoke, fx.smoke.burstBudget * 0.07 * k, dt, { position: _p.set(f.position.x, f.position.y + 2.4 * z, f.position.z), radius: 1.2 * z, velocity: _v.set(wind.x * 0.44, 3.8 * z, wind.z * 0.44), spread: 1.2 * z, life: 8, size: 2.2 * z, sizeEnd: 12 * z, temperature: 0.42 });
      fx.sparks.emitRateAt(f.carry, Stream.Sparks, 16 * z * k, dt, { position: _p.set(f.position.x, f.position.y + 0.8, f.position.z), radius: z, velocity: { x: 0, y: 5, z: 0 }, spread: 2.8, life: 2.4, size: 0.09, temperature: 0.9 });
      if (Math.random() < dt * 0.35 * k) fx.heatHaze(_v.set(f.position.x, f.position.y + 2.5 * z, f.position.z), 4 * z, 0.9, 5, 1.4, 0.18);
    }

    this.debris.update(dt, this.ocean ? this.ocean.waterLevel : null);
  }

  dispose(): void {
    for (const a of this.active) {
      a.fireLight?.remove();
      this.disposeArcs(a);
    }
    for (const f of this.fires) {
      this.engine.world.removeSource(f.heat);
      f.fireLight.remove();
    }
    this.active = [];
    this.fires = [];
    for (const l of this.lights) l.removeFromParent();
    this.debris.mesh.removeFromParent();
    this.debris.dispose();
    for (const geyser of this.geysers) geyser.dispose();
    for (const volume of this.volumes) volume.dispose();
    this.arcCore.dispose();
    this.arcGlow.dispose();
  }
}
