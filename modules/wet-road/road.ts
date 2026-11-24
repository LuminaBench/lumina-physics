/**
 * Procedural wet asphalt with standing-water puddles.
 *
 * One baked, tileable micro-relief map + an analytic road crown and wheel ruts define the
 * surface height. A single `flood` level decides where water stands and how deep it is –
 * the *same* function is evaluated by the shader (what you see) and on the CPU
 * (`puddleDepth`, what the tires feel), so aquaplaning always matches the visible puddles.
 *
 * Shading is custom-lit in the transparent pass so each fragment can trace its own
 * screen-space reflection: puddles become mirror-sharp and correctly show the car, lamps,
 * tail lights and lightning; damp asphalt gets a darker, rougher sheen. Rain adds
 * expanding ripple rings; tires leave ripples through the shared interaction field.
 */
import type { FloodedStreet } from './street-fluid';
import * as THREE from 'three/webgpu';
import { TreadTransfer, type LooseSediment } from './tread-transfer';
import { PuddleContacts } from './puddle-contacts';
import { fireLights } from '../../engine/particles';
import { TSL, type N } from '../../engine/tsl';
import { dielectricSunGlint, specularAARoughness } from '../../engine/shading';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import { valueNoise2, hash22, hash12, fbm2, mulberry32 } from '../../engine/noise';
import { FieldReading, surfaceTemperatureNode } from '../../engine/world-bus';
import { traceReflection } from '../../engine/ssr';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import type { Weather } from '../weather/weather';
import { InteractionField } from '../water/interaction';

const {
  Fn, If, Loop, int, float, vec2, vec3, vec4, uniform, texture, positionWorld, cameraPosition, cameraViewMatrix, normalize, dot, length,
  reflect, mix, smoothstep, exp, pow, max, min, fract, floor, sin, abs, mod,
} = TSL;

export const ROAD_TILE = 48;
const RELIEF = 0.03;
const ROAD_ROW_LENGTH = 2;
const CROWN = 0.03;
const RUT = 0.018;
const HALF_WIDTH = 7.5;

export interface WetRoadParams {
  /** 0 = bone dry, 1 = saturated asphalt (dark, glossy). */
  wetness: number;
  /** 0..1 standing-water level: 0 no puddles, 1 = ruts and low spots flooded several cm deep. */
  flood: number;
  /** 0..1 rain ripple intensity (defaults to the weather's rain). */
  rain: number;
}

const POOL_SPACING = 170;
const POOL_DEPTH = 0.034;
const POOL_LENGTH = 9;

/** Analytic profile: crowned centre, two wheel ruts per lane and periodic one-sided dips (metres). */
function crossSectionCPU(x: number, z: number): number {
  const crown = CROWN * (1 - (x / HALF_WIDTH) ** 2);
  let ruts = 0;
  for (const c of [-2.75, -1.05, 1.05, 2.75]) ruts -= RUT * Math.exp(-(((x - c) / 0.32) ** 2));
  // A sagging patch every POOL_SPACING metres that floods the whole left lane, deepest at
  // the verge: all four tires lift at speed while the deeper side drags harder, so the car
  // is yawed with no grip to resist – the classic aquaplaning trap.
  const along = (((z % POOL_SPACING) + POOL_SPACING) % POOL_SPACING) - POOL_SPACING / 2;
  const pool = POOL_DEPTH * Math.exp(-((along / POOL_LENGTH) ** 2)) * (0.95 * Math.exp(-(((x + 3.3) / 1.5) ** 2)) + 0.5 * Math.exp(-(((x + 1.9) / 2.2) ** 2)));
  return crown + ruts - pool;
}

function bakeRelief(size: number, seed = 11): { data: Float32Array; texture: THREE.DataTexture } {
  const rand = mulberry32(seed);
  const octaves = [3, 6, 13, 27].map((period) => {
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    return { period, grid };
  });
  const data = new Float32Array(size * size);
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let h = 0, amp = 0.5, norm = 0;
    for (const { period, grid } of octaves) {
      const fx = (x / size) * period, fy = (y / size) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = sm(fx - x0), ty = sm(fy - y0);
      const g = (ix: number, iy: number) => grid[(iy % period) * period + (ix % period)];
      h += (g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty) + g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty) * amp;
      norm += amp; amp *= 0.5;
    }
    data[y * size + x] = h / norm;
  }
  const half = new Uint16Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { half[i * 4] = THREE.DataUtils.toHalfFloat(data[i]); half[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1); }
  const tex = new THREE.DataTexture(half, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Mip-mapped + anisotropic: the film / dry boundary it defines is viewed at grazing angles.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { data, texture: tex };
}

/** Expanding raindrop ripple rings → surface slope (vec2). */
const rainRipples = Fn(([p, time]: N[]) => {
  const slope = vec2(0).toVar();
  for (const [scale, rate, seed] of [[2.6, 1.25, 0.0], [1.45, 0.9, 31.7]] as const) {
    const q = p.mul(scale);
    const cell = floor(q).toVar();
    const local = fract(q).toVar();
    Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'rj' }, ({ rj }: N) => {
      Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'ri' }, ({ ri }: N) => {
        const offset = vec2(float(ri), float(rj));
        const id = cell.add(offset).add(seed);
        const centre = offset.add(hash22(id));
        const phase = fract(time.mul(rate).add(hash12(id.add(17.13))));
        const delta = local.sub(centre);
        const d = length(delta).add(1e-4);
        const ring = d.sub(phase.mul(1.05));
        const wave = sin(ring.mul(34)).mul(exp(ring.mul(ring).mul(-70))).mul(float(1).sub(phase).pow(2));
        slope.addAssign(delta.div(d).mul(wave));
      });
    });
  }
  return slope;
});

export class WetRoad implements EngineModule {
  /** Follow rainfall with separate surface-film and standing-water storage. Zero leaves the game in control. */
  weatherTimeScale = 0;
  setSurroundingsVisible(visible: boolean): void { this.terrain.visible = visible; }
  readonly params: WetRoadParams = { wetness: 1, flood: 0.42, rain: 0.8 };
  readonly group = new THREE.Group();
  readonly contacts = new PuddleContacts(this);
  field!: InteractionField;
  /** Car pose for analytic headlight pooling + contact shadow. */
  readonly carPosition = new THREE.Vector3(0, 0, 0);
  private readonly fieldFocus = new THREE.Vector3();
  private readonly climatePoint = new THREE.Vector3();
  private readonly climateFields = new FieldReading();
  readonly carForward = new THREE.Vector3(0, 0, 1);
  /** Disable car-specific lighting and follow the camera when the road is used on foot or on a bicycle. */
  vehicleLighting = true;
  headlights = 1;
  /** 0..1 brake-light output of the car (red pool and streaks on the wet surface behind it). */
  brake = 0;
  private relief: { data: Float32Array; texture: THREE.DataTexture };
  private reliefSize = 512;
  private mesh!: THREE.Mesh;
  private terrain!: THREE.Mesh;
  private lamps!: THREE.InstancedMesh;
  private lampHeads!: THREE.InstancedMesh;
  private lampOrigin = Infinity;
  private readonly lampMatrix = new THREE.Matrix4();
  private reflections = false;
  private u = {
    waterLine: uniform(0.02), wetness: uniform(1), rain: uniform(0.8), ssrSteps: uniform(28),
    carPresent: uniform(1), carPos: uniform(new THREE.Vector3()), carFwd: uniform(new THREE.Vector3(0, 0, 1)), headlights: uniform(1), brake: uniform(0),
  };

  /** Optional bounded prints, owned by this road. Supply a matching soil sampler for a loose shoulder. */
  readonly tread?: TreadTransfer;
  private readonly treadSample = new THREE.Vector3();

  constructor(private engine: LuminaEngine, private weather: Weather,
    readonly transfer?: { soil?: LooseSediment; cellX?: number; cellZ?: number }) {
    if (transfer) this.tread = new TreadTransfer(transfer.cellX, transfer.cellZ);
    this.relief = bakeRelief(this.reliefSize);
    this.build(engine.quality.preset);
    engine.scene.add(this.group);
  }

  private build(preset: QualityPreset): void {
    const { renderer } = this.engine;
    const resolution = Math.min(preset.interaction.resolution, 768);
    const oldField = this.field;
    if (!oldField || oldField.resolution !== resolution) {
      this.field = new InteractionField(renderer, resolution, 96);
      this.field.waveSpeed = 2.4;
      this.field.damping = 1.6;
      this.field.foamDecay = 1.2;
    }
    const reflectionChanged = this.reflections !== preset.reflections.ssr;
    this.reflections = preset.reflections.ssr;
    this.u.ssrSteps.value = Math.round(14 + preset.reflections.ssrQuality * 46);
    if (this.mesh) {
      if (oldField !== this.field || reflectionChanged) {
        const previous = this.mesh.material as THREE.Material;
        this.mesh.material = this.createMaterial(preset);
        previous.dispose();
        if (oldField !== this.field) oldField.dispose();
      }
      return;
    }

    const geometry = new THREE.PlaneGeometry(HALF_WIDTH * 2, 900, 60, 900 / ROAD_ROW_LENGTH).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.createMaterial(preset));
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'lumina-wet-road';
    this.group.add(this.mesh);

    const ground = new THREE.MeshStandardNodeMaterial();
    const gxz = positionWorld.xz;
    ground.colorNode = mix(vec3(0.012, 0.02, 0.011), vec3(0.04, 0.05, 0.028), fbm2(gxz.mul(0.35), 4)).mul(mix(1.0, 0.55, this.u.wetness));
    ground.roughnessNode = mix(float(0.95), float(0.5), this.u.wetness.mul(fbm2(gxz.mul(0.9), 2)));
    this.terrain = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), ground);
    this.terrain.position.y = -0.06;
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);

    // Street lamps: emissive heads give the puddles something sharp to mirror.
    const count = 16;
    const pole = new THREE.CylinderGeometry(0.07, 0.11, 8.4, 8).translate(0, 4.2, 0);
    this.lamps = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.5, metalness: 0.8 }), count);
    const head = new THREE.BoxGeometry(0.9, 0.12, 0.3);
    this.lampHeads = new THREE.InstancedMesh(head, new THREE.MeshBasicMaterial({ color: new THREE.Color(42, 30, 15) }), count);
    this.lamps.frustumCulled = this.lampHeads.frustumCulled = false;
    this.group.add(this.lamps, this.lampHeads);
  }

  /** Surface micro-height (m) at a world position – CPU twin of the shader. */
  heightAt(x: number, z: number): number {
    const s = this.reliefSize, d = this.relief.data;
    const fx = ((x / ROAD_TILE) % 1 + 1) % 1 * s - 0.5, fz = ((z / ROAD_TILE) % 1 + 1) % 1 * s - 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const left=(x0+s)%s, right=(left+1)%s;
    const row=((z0+s)%s)*s, next=((z0+1+s)%s)*s;
    const a=d[row+left]+(d[row+right]-d[row+left])*tx;
    const b=d[next+left]+(d[next+right]-d[next+left])*tx;
    const h=a+(b-a)*tz;
    return h * RELIEF + crossSectionCPU(x, z);
  }

  /** `VehicleSurface`: how soaked the asphalt is (0 dry .. 1). */
  streetFluid?: FloodedStreet;
  private frozenFractionAt(x: number, z: number): number {
    const world = this.engine.world;
    if (!world.climate && world.ambientTemperature >= 0.5 && !world.sourceCount) return 0;
    const sample = world.disturbance(this.climatePoint.set(x, this.group.position.y, z), this.climateFields);
    return 1 - THREE.MathUtils.smoothstep(sample.temperature, -3, 0.5);
  }

  /** Local rain film on porous pavement. Flood water still enters from open ground. */
  rainFilmAt(x: number, z: number): number {
    const shelters = this.engine.world.shelters;
    return shelters.count ? shelters.filmAt(x, this.group.position.y, z, this.params.wetness) : this.params.wetness;
  }

  wetnessAt(x: number, z: number): number {
    const rain = this.rainFilmAt(x, z);
    if (!this.tread) return rain;
    const print = this.tread.sampleAt(x, z, this.treadSample);
    return Math.max(rain * (1 - print.z), print.x);
  }

  liquidWetnessAt(x: number, z: number): number {
    return this.wetnessAt(x, z) * (1 - this.frozenFractionAt(x, z));
  }

  grip(x: number, z: number): number {
    const fluidGrip = this.streetFluid?.grip(x, z) ?? 1;
    const frozen = this.frozenFractionAt(x, z);
    if (!frozen) return fluidGrip;
    const coating = Math.max(this.wetnessAt(x,z), THREE.MathUtils.smoothstep(this.waterLine - this.heightAt(x, z), 0, 0.0036));
    return fluidGrip * (1 - 0.75 * frozen * coating);
  }
  get wetness(): number { return this.params.wetness; }

  /** World height of the standing-water surface for the current flood level. */
  get waterLine(): number {
    const flood = this.params.flood;
    // Drain the deepest rut as the last standing water leaves the carriageway.
    return THREE.MathUtils.lerp(-0.07, 0.006 + 0.052 * flood, THREE.MathUtils.smoothstep(flood, 0, 0.15));
  }

  /** Standing-water depth in metres under a world position (0 off the road). */
  puddleDepth(x: number, z: number): number {
    if (Math.abs(x) > HALF_WIDTH) return 0;
    const water = Math.max(0, this.waterLine - this.heightAt(x, z), this.streetFluid?.depth(x,z) ?? 0);
    return Math.max(0, water - 0.0036 * this.frozenFractionAt(x, z));
  }

  private createMaterial(preset: QualityPreset): THREE.NodeMaterial {
    const u = this.u, weather = this.weather, field = this.field;
    const reliefTex = this.relief.texture;
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    material.fog = false;

    const heightNode = (xz: N, vertex = false): N => {
      const x = xz.x;
      const crown = float(1).sub(x.div(HALF_WIDTH).pow(2)).mul(CROWN);
      let ruts: N = float(0);
      for (const c of [-2.75, -1.05, 1.05, 2.75]) { const d = x.sub(c).div(0.32); ruts = ruts.sub(exp(d.mul(d).negate()).mul(RUT)); }
      const along = xz.y.mod(POOL_SPACING).add(POOL_SPACING).mod(POOL_SPACING).sub(POOL_SPACING / 2).div(POOL_LENGTH);
      const across = x.add(3.3).div(1.5);
      const lane = x.add(1.9).div(2.2);
      const pool = exp(along.mul(along).negate()).mul(exp(across.mul(across).negate()).mul(0.95).add(exp(lane.mul(lane).negate()).mul(0.5))).mul(POOL_DEPTH);
      const relief = texture(reliefTex, xz.div(ROAD_TILE));
      return (vertex ? relief.level(0) : relief).r.mul(RELIEF).add(crown).add(ruts).sub(pool);
    };

    // The tyre meets the bed while the reflecting interface rises to the waterline.
    // Evaluate XZ before displacement so a scrolling road samples fixed world coordinates.
    const local = TSL.positionGeometry;
    const worldXZ = TSL.modelWorldMatrix.mul(vec4(local, 1)).xz;
    material.positionNode = vec3(local.x, max(heightNode(worldXZ, true), u.waterLine), local.z);

    const shade = Fn(() => {
      const P = positionWorld;
      const xz = P.xz;
      const toCamera = cameraPosition.sub(P);
      const dist = length(toCamera);
      const V = toCamera.div(dist);
      const depth = max(u.waterLine.sub(heightNode(xz)), 0);
      const frozen = float(1).sub(smoothstep(-3, 0.5, surfaceTemperatureNode(P)));
      const film = smoothstep(0, 0.0036, depth.sub(frozen.mul(0.0036)));
      const shelters = this.engine.world.shelters;
      const ground = shelters.groundNode(P, u.wetness);
      const print = this.tread?.sampleNode(xz).toVar();
      const moisture = print ? max(ground.x.mul(float(1).sub(print.z)), print.x) : ground.x;
      const damp = moisture.mul(float(1).sub(frozen));
      const frost = frozen.mul(max(ground.x, smoothstep(0, 0.0036, depth)));

      // ---- normal: porous micro-relief on asphalt, calm glassy surface on puddles --
      const fineFade = float(1).sub(smoothstep(5, 24, dist));
      const medFade = float(1).sub(smoothstep(18, 65, dist));
      const e = 0.024;
      const s0 = valueNoise2(xz.mul(28));
      const micro = vec2(valueNoise2(xz.add(vec2(e, 0)).mul(28)).sub(s0), valueNoise2(xz.add(vec2(0, e)).mul(28)).sub(s0))
        .div(e).mul(0.0014).mul(fineFade);
      const medSlope = vec2(
        valueNoise2(xz.add(vec2(0.08, 0)).mul(6.5)).sub(valueNoise2(xz.mul(6.5))),
        valueNoise2(xz.add(vec2(0, 0.08)).mul(6.5)).sub(valueNoise2(xz.mul(6.5))),
      ).mul(0.018).mul(medFade);
      // Delicate rain rings + calm wind whisper on standing puddles (keeps reflections mirror-clear)
      const ripple = vec2(0).toVar();
      If(dist.lessThan(55).and(film.greaterThan(0)).and(u.rain.greaterThan(0)), () => {
        const rate = u.rain.mul(shelters.rainNode(P));
        If(rate.greaterThan(0.001), () => {
          ripple.assign(rainRipples(xz, frame.time).mul(rate).mul(0.062).mul(float(1).sub(smoothstep(18, 55, dist))));
        });
      });
      If(film.greaterThan(0).and(dist.lessThan(45)), () => {
        ripple.addAssign(this.contacts.slopeNode(xz).mul(float(1).sub(smoothstep(20, 45, dist))));
      });
      const breeze = vec2(
        valueNoise2(xz.mul(2.2).add(frame.time.mul(0.35))),
        valueNoise2(xz.mul(2.4).sub(frame.time.mul(0.30))),
      ).sub(0.5).mul(0.003);
      const slope = micro.add(medSlope).mul(float(1).sub(film))
        .add(ripple.add(breeze).add(field.slope(xz).mul(0.45)).mul(film));
      const Nw = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
      const NdotV = max(dot(Nw, V), 0.02);

      // Follow the transmitted ray from the liquid interface to the opaque pavement.
      // Ray direction is in world space; only substrate detail and road paint move.
      const bedXZ = this.contacts.bedXZNode(xz, V, Nw, depth.mul(film));
      // ---- wet porous asphalt -----------------------------------------------
      // Multi-scale aggregate & pore grain with clean distance fade (no single-pixel sparkle).
      const fineGrain = valueNoise2(bedXZ.mul(72)).mul(0.55).add(valueNoise2(bedXZ.mul(31)).mul(0.45));
      const pores = smoothstep(0.24, 0.72, valueNoise2(bedXZ.mul(18).add(1.7)));
      const patches = fbm2(bedXZ.mul(0.18).add(4.2), 3);
      // Polished tyre-wear tracks along the four wheel-rut centres
      const rutA = exp(bedXZ.x.add(2.75).div(0.45).pow(2).negate()).add(exp(bedXZ.x.add(1.05).div(0.45).pow(2).negate()));
      const rutB = exp(bedXZ.x.sub(1.05).div(0.45).pow(2).negate()).add(exp(bedXZ.x.sub(2.75).div(0.45).pow(2).negate()));
      const trackPolish = rutA.add(rutB).clamp(0, 1);

      const aggregate = mix(float(0.46), fineGrain, fineFade);
      let albedo: N = mix(vec3(0.022, 0.024, 0.027), vec3(0.095, 0.094, 0.091), aggregate.mul(mix(float(0.55), float(1.0), mix(float(0.5), pores, medFade))))
        .mul(mix(0.76, 1.12, patches))
        .mul(mix(float(1.0), float(0.84), trackPolish));
      // Lane paint: solid edge lines, dashed centre line, worn by traffic.
      const wear = smoothstep(0.25, 0.7, fbm2(bedXZ.mul(vec2(2.3, 0.35)), 3));
      const edgeLine = smoothstep(0.085, 0.06, abs(abs(bedXZ.x).sub(6.4)));
      const dash = smoothstep(0.085, 0.06, abs(bedXZ.x)).mul(smoothstep(0.34, 0.36, fract(bedXZ.y.div(9.0))));
      albedo = mix(albedo, vec3(0.60, 0.59, 0.54), max(edgeLine, dash).mul(wear.mul(0.75).add(0.2)));
      // Water filling the micro-pores roughly halves asphalt reflectance (index matching
      // in the pores). 0.36 crushed saturated pavement to near-black, so damp asphalt,
      // thin film and puddles could no longer be told apart.
      const soil = print ? max(this.transfer?.soil?.amountNode(bedXZ) ?? float(0), print.y) : float(0);
      if (print) {
        const loam = mix(vec3(0.058, 0.03, 0.016), vec3(0.24, 0.151, 0.076), aggregate);
        albedo = mix(albedo, loam, soil.mul(mix(0.64, 1, pores)));
      }
      albedo = albedo.mul(mix(1.0, 0.55, damp)).mul(mix(1.0, 0.74, film));

      albedo = mix(albedo, vec3(0.43, 0.49, 0.52), frost.mul(mix(0.36, 0.72, pores)));

      // ---- lighting ---------------------------------------------------------
      // Porous wet asphalt keeps subtle micro-stone roughness; puddles sit ultra-smooth & calm.
      const asphaltRough = mix(float(0.86), mix(float(0.44), float(0.28), trackPolish.mul(0.6).add(pores.mul(0.4))), damp);
      const bedRough = print ? mix(asphaltRough, mix(float(0.96), float(0.41), damp), soil) : asphaltRough;
      const baseRough = mix(mix(bedRough, float(0.24), frost), float(0.014), film);
      const roughness = specularAARoughness(Nw, baseRough, 0.42, 0.16);
      const L = frame.sunDirection;
      const shadow = weather.cloudShadow(P).mul(shelters.rayNode(P, L, float(0.00465)).a.oneMinus());
      const openAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.55);
      const ambient = openAmbient.mul(ground.y);

      // ---- two-stage car contact shadow + 4-wheel patch occlusion -----------
      const rel = P.sub(u.carPos);
      const fwd = normalize(vec3(u.carFwd.x, 0, u.carFwd.z));
      const lz = dot(rel, fwd), lx = dot(rel, vec3(fwd.z, 0, fwd.x.negate()));
      const bodyEllipse = length(vec2(lx.div(0.98), lz.div(2.28)));
      const coreUnder = smoothstep(1.12, 0.72, bodyEllipse);
      const softSkirt = smoothstep(1.48, 0.85, bodyEllipse);
      // Extra tight contact occlusion directly beneath the four tyres
      const wFL = exp(length(vec2(lx.add(0.81).div(0.24), lz.sub(1.40).div(0.42))).pow(2).negate());
      const wFR = exp(length(vec2(lx.sub(0.81).div(0.24), lz.sub(1.40).div(0.42))).pow(2).negate());
      const wRL = exp(length(vec2(lx.add(0.81).div(0.26), lz.add(1.33).div(0.44))).pow(2).negate());
      const wRR = exp(length(vec2(lx.sub(0.81).div(0.26), lz.add(1.33).div(0.44))).pow(2).negate());
      const tyreContact = max(max(wFL, wFR), max(wRL, wRR));
      // Tyre patches are fully occluded at their centre; the floor pan hides most of the sky.
      const contact = float(1).sub(coreUnder.mul(0.8).add(softSkirt.mul(0.14)).add(tyreContact.mul(0.55)).clamp(0, 0.96).mul(u.carPresent));

      // ---- twin headlamp dipped beams + nose bounce on wet asphalt ----------
      const ahead = lz.sub(2.05);
      const spread = ahead.mul(0.14).add(0.85);
      const beamL = exp(lx.add(0.56).div(spread).pow(2).negate());
      const beamR = exp(lx.sub(0.56).div(spread).pow(2).negate());
      const beamEnv = smoothstep(-0.15, 2.2, ahead).mul(exp(ahead.mul(-0.048)));
      const noseSplash = exp(ahead.sub(0.35).div(1.2).pow(2).negate()).mul(exp(lx.div(1.15).pow(2).negate())).mul(0.45);
      const headFactor = beamEnv.mul(beamL.add(beamR).mul(0.68)).add(noseSplash);
      const headlight = vec3(0.94, 0.97, 1.04).mul(headFactor).mul(u.headlights).mul(2.15);

      // ---- tail-light & brake-bar glow behind rear valance ------------------
      const behind = lz.negate().sub(2.15);
      const rearSpread = behind.mul(0.28).add(0.95);
      const pool = smoothstep(-0.1, 0.85, behind).mul(exp(behind.mul(-0.28))).mul(exp(lx.div(rearSpread).pow(2).negate()));
      const taillight = vec3(1.0, 0.055, 0.02).mul(pool).mul(u.brake.mul(1.85).add(0.14));

      // ---- overhead streetlamp warm pools on wet road -----------------------
      const lampCell = xz.y.div(42.0);
      const lampNearest = floor(lampCell.add(0.5)).mul(42.0);
      const lampSide = mod(floor(lampCell.add(0.5)).abs(), 2.0).mul(-2.0).add(1.0); // ±1 alternating
      const lampDx = xz.x.sub(lampSide.mul(HALF_WIDTH + 0.7));
      const lampDz = xz.y.sub(lampNearest);
      const lampPool = exp(lampDx.mul(lampDx).add(lampDz.mul(lampDz)).div(88.0).negate());
      const streetLight = vec3(1.0, 0.72, 0.36).mul(lampPool).mul(0.18);

      const diffuse = albedo.mul(
        frame.sunColor.mul(max(dot(Nw, L), 0)).mul(shadow).mul(1 / Math.PI)
          .add(ambient).mul(contact)
          .add(headlight).add(taillight).add(streetLight),
      );

      const F0 = mix(float(0.04), float(0.022), film);
      const fresnel = F0.add(float(1).sub(F0).mul(pow(float(1).sub(NdotV), 5)));
      const R = reflect(V.negate(), Nw);
      const lod = roughness.mul(7.5);
      const roof = shelters.rayNode(P, R, roughness.mul(roughness).mul(0.35));
      const background = mix(weather.reflection(R, lod), openAmbient.mul(roof.rgb), roof.a);
      const reflection = weather.reflectionAt(P, R, lod, background).toVar();
      const mirror = float(1).sub(roughness).pow(2);
      if (preset.reflections.ssr) {
        If(mirror.greaterThan(0.22).and(dist.lessThan(260)), () => {
          const hit = traceReflection(P.add(vec3(0, 0.003, 0)), normalize(vec3(R.x, max(R.y, 0.01), R.z)), { steps: u.ssrSteps, maxDistance: 150, growth: 1.30, thickness: 0.14, contactTolerance: 0.035 });
          // The sharp screen sample loses coherence as a thin film follows the asphalt grain.
          const coherence = smoothstep(0.22, 0.82, mirror).mul(smoothstep(260, 165, dist));
          reflection.assign(mix(reflection, hit.rgb, hit.a.mul(coherence)));
        });
      }
      // Crisp wet-film & puddle specular streaks from headlights, tail/brake bar, and streetlamps
      const headGlint = headlight.mul(pow(max(dot(R, fwd), 0), 7).mul(1.8).add(0.22)).mul(mirror);
      const tailGlint = taillight.mul(pow(max(dot(R, fwd.negate()), 0), 5).mul(2.8).add(0.25)).mul(mirror);
      const lampGlint = streetLight.mul(mirror).mul(1.2);
      const glint = headGlint.add(tailGlint).add(lampGlint);
      // The sky map supplies the broad aureole. Resolve the sun against the local
      // road normal separately so wet aggregate and puddles have different highlights.
      // Trace toward the sun past the rounded vehicle silhouette. At sunset the
      // blocked stretch of road extends beyond the ambient contact patch.
      const bodyAxes = vec3(0.94, 0.56, 2.18);
      const rayOrigin = vec3(lx, rel.y.sub(0.26), lz).div(bodyAxes);
      const ray = vec3(L.x.mul(fwd.z).sub(L.z.mul(fwd.x)), L.y, dot(L, fwd)).div(bodyAxes);
      const closest = max(dot(rayOrigin, ray).negate().div(dot(ray, ray).max(0.0001)), 0);
      const silhouette = length(rayOrigin.add(ray.mul(closest)));
      const penumbra = closest.mul(0.00465).add(0.035).min(0.25);
      const carSun = mix(float(1), smoothstep(float(1).sub(penumbra), float(1).add(penumbra), silhouette), u.carPresent);
      const solar = frame.sunColor.mul(shadow).mul(carSun).mul(contact).mul(
        dielectricSunGlint(Nw, V, L, NdotV, roughness.pow(4).add(0.00004), F0));
      const specular = reflection.mul(fresnel).mul(mix(0.14, 1.0, mirror)).mul(mix(1.0, contact, 0.85))
        .add(solar).add(glint.mul(fresnel.add(0.06)));
      // Aerated spray-wash from tires scatters light: a pale, rough patch that fades.
      const foam = field.sample(xz).b.mul(film).clamp(0, 1);
      const lit = diffuse.mul(float(1).sub(fresnel.mul(film))).add(specular);
      const color = mix(lit, ambient.mul(0.75).add(headlight.mul(0.4)), foam.mul(0.4));
      const fire = fireLights.sampleSurface(P, Nw, V, roughness);
      return vec4(weather.aerial(color.add(fire.specular.mul(film)).add(fire.diffuse.mul(0.055)), P), 1);
    });
    material.colorNode = shade();

    const normalView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    material.mrtNode = auxSurface(normalView, screenVelocity(positionWorld, positionWorld));
    return material;
  }

  setQuality(preset: QualityPreset): void { this.build(preset); }

  update(dt: number): void {
    const p = this.params;
    if (this.weatherTimeScale > 0) {
      const elapsed = dt * this.weatherTimeScale;
      const rain = p.rain = this.weather.params.rain;
      const climate = this.engine.world.climate;
      const humidity = climate?.surfaceHumidity ?? 0.56;
      const warmth = Math.max(0.12, Math.min(3, Math.exp((this.engine.world.ambientTemperature - 18) * 0.035)));
      const drying = warmth * (1 - humidity) * (0.55 + Math.min(1.1, this.engine.world.speed * 0.055));
      const filmTarget = Math.min(1, rain * 4);
      const poolTarget = rain * rain;
      p.wetness += (filmTarget - p.wetness) * -Math.expm1(-elapsed * (filmTarget > p.wetness ? 0.24 : drying / 15));
      p.flood += (poolTarget - p.flood) * -Math.expm1(-elapsed * (poolTarget > p.flood ? 0.075 : drying / 48));
    }
    this.contacts.update(dt);
    this.u.waterLine.value = this.waterLine;
    this.u.wetness.value = p.wetness;
    this.u.rain.value = p.rain;
    (this.u.carPos.value as THREE.Vector3).copy(this.carPosition);
    (this.u.carFwd.value as THREE.Vector3).copy(this.carForward);
    this.u.carPresent.value = this.vehicleLighting ? 1 : 0;
    this.u.headlights.value = this.vehicleLighting ? this.headlights : 0;
    this.u.brake.value = this.vehicleLighting ? this.brake : 0;

    // The strip rides with the car; all shading is in world space so nothing swims.
    const focus = this.vehicleLighting ? this.carPosition : this.engine.camera.position;
    const z = focus.z;
    this.tread?.update(dt, focus.x, z);
    this.mesh.position.set(0, 0, Math.round(z / ROAD_ROW_LENGTH) * ROAD_ROW_LENGTH + 120);
    this.terrain.position.set(0, -0.06, Math.round(z / 200) * 200);
    const spacing = 42;
    const base = Math.floor(z / spacing) * spacing;
    if (base !== this.lampOrigin) {
      this.lampOrigin = base;
      const m = this.lampMatrix;
      for (let i = 0; i < this.lamps.count; i++) {
        const lz = base + (i - 3) * spacing;
        const side = Math.round(lz / spacing) % 2 === 0 ? 1 : -1;
        m.makeTranslation(side * (HALF_WIDTH + 1.4), 0, lz);
        this.lamps.setMatrixAt(i, m);
        m.makeTranslation(side * (HALF_WIDTH + 0.7), 8.3, lz);
        this.lampHeads.setMatrixAt(i, m);
      }
      this.lamps.instanceMatrix.needsUpdate = true;
      this.lampHeads.instanceMatrix.needsUpdate = true;
    }
    this.fieldFocus.set(focus.x, 0, z + (this.vehicleLighting ? 14 : 0));
    this.field.update(dt,this.fieldFocus);
  }

  dispose(): void {
    this.tread?.dispose();
    this.field.dispose();
    this.lamps.dispose();
    this.lampHeads.dispose();
    this.group.removeFromParent();
    this.relief.texture.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    });
  }
}

export { min as _min };
