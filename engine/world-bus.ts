import * as THREE from 'three/webgpu';
import { RainShelters, shelteredRainFilmNode } from './rain-shelters';
import { TSL, type N } from './tsl';
import { validateClimate, type ClimateProfile } from './climate';
import { WindField } from './wind';

const { uniform, Fn, Loop, If, vec3, vec4, float, int, dot, max } = TSL;
const CAPACITY = 16;
/** `Math.min(1, Math.max(0, x))` as selects: the same result for every input (NaN stays NaN,
 * -0 becomes 0), but a select hands back an operand where each Math call boxes a new number. */
function saturate(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

// Channel bits of a slot, derived once when a source is published. The first eight mark the
// strengths that are not zero: a zero strength adds exactly nothing to a sample and its uniform
// does not move while the source fades, so that arithmetic is skipped. (Heat alone counts -0 as
// present, because adding -0 leaves an ambient temperature of -0 as it is.) The last
// three hold the tests the bus applies to a source (`swirl || radial || ...`, `heat || wetness`,
// `cloudCut <= 0`) so they need no second read of its fields.
const RADIAL = 1, SWIRL = 2, LIFT = 4, RIM_LIFT = 8, PRESSURE = 16, HEAT = 32, WETNESS = 64, CLOUD_CUT = 128;
const FORCES_BODIES = 256, WETS_OR_HEATS = 512, CUTS_CLOUD = 1024;
/** All eight strengths: a NaN weight or gain spreads to every one of them, +0 or not. */
const EVERY_STRENGTH = 255;

/** A world-space swept sphere. Coincident endpoints give a sphere, separated endpoints
 * give a capsule. Wind is in m/s; pressure is signed game-fluid forcing, heat is °C
 * above ambient and wetness is the fraction of the surface covered by water. */
export class WorldSource {
  readonly start = new THREE.Vector3();
  readonly end = new THREE.Vector3();
  radius = 1;
  radial = 0;
  swirl = 0;
  /** Spin around the swept path instead of the vertical, as in an aircraft wake. */
  axialSwirl = false;
  lift = 0;
  rimLift = 0;
  pressure = 0;
  heat = 0;
  wetness = 0;
  cloudCut = 0;

  at(x: number, y: number, z: number): this {
    this.start.set(x, y, z);
    this.end.copy(this.start);
    return this;
  }

  /** `WorldBus.publish` takes the same snapshot field by field; keep the two in step. */
  copy(other: WorldSource): this {
    this.start.copy(other.start);
    this.end.copy(other.end);
    this.radius = other.radius;
    this.radial = other.radial;
    this.swirl = other.swirl;
    this.axialSwirl = other.axialSwirl;
    this.lift = other.lift;
    this.rimLift = other.rimLift;
    this.pressure = other.pressure;
    this.heat = other.heat;
    this.wetness = other.wetness;
    this.cloudCut = other.cloudCut;
    return this;
  }
}

export class FieldReading {
  readonly pressureForce = new THREE.Vector3();
  readonly wind = new THREE.Vector3();
  pressure = 0;
  temperature = 18;
  wetness = 0;
  cloudCut = 0;
}

type Slot = {
  source: WorldSource;
  owner: WorldSource | null;
  remaining: number;
  duration: number;
  gain: number;
  /** Channel bits of `source`. */
  channels: number;
};
type RenderFields = ReturnType<typeof makeUniforms>;
function makeUniforms() {
  // World fields change between submissions even on stationary stock PBR
  // meshes. Render-group bindings refresh once per render, independently of
  // Three's per-object material/matrix change detector.
  const shared = (value: N) => value.setGroup(TSL.renderGroup);
  // vec4 data already has the std140/WGSL alignment expected by both backends.
  const vectors = () => shared(TSL.buffer(new Float32Array(CAPACITY * 4), 'vec4', CAPACITY));
  return {
    count: shared(uniform(0, 'int')),
    wet: shared(uniform(0)),
    ambient: shared(uniform(18)),
    column: shared(uniform(new THREE.Vector3())),
    start: vectors(),
    axis: vectors(),
    wind: vectors(),
    spin: vectors(),
    scalar: vectors(),
    minimum: shared(uniform(new THREE.Vector3(1e20, 1e20, 1e20))),
    maximum: shared(uniform(new THREE.Vector3(-1e20, -1e20, -1e20))),
    cloudMin: shared(uniform(1e20)),
    cloudMax: shared(uniform(-1e20)),
  };
}

// Materials can be constructed before an engine. Each renderer binds its own bus before
// submission, just as it binds the frame camera, solar position and simulation clock.
const surfaceFields = makeUniforms();
let boundSurface: WorldBus | undefined;
let boundRevision = -1;

function accumulateNode(u: RenderFields, p: N, velocity: boolean, cloudOnly = false): N {
  return Fn(() => {
    const result = (velocity ? vec3(0) : vec4(0)).toVar();
    const inside = cloudOnly
      ? p.y.greaterThan(u.cloudMin).and(p.y.lessThan(u.cloudMax))
      : u.count.greaterThan(0);
    const inBounds = p.greaterThanEqual(u.minimum).all().and(p.lessThanEqual(u.maximum).all());
    If(inside.and(inBounds), () => {
      Loop(
        { start: int(0), end: u.count, type: 'int', condition: '<', name: 'worldSlot' },
        ({ worldSlot }: N) => {
          const a = u.start.element(worldSlot),
            ab = u.axis.element(worldSlot);
          const ap = p.sub(a.xyz),
            along = dot(ap, ab.xyz).mul(ab.w).clamp(0, 1);
          const d = ap.sub(ab.xyz.mul(along)),
            q = dot(d, d).mul(a.w);
          If(q.lessThan(1), () => {
            const w = float(1).sub(q).pow(2);
            if (velocity) {
              const v = u.wind.element(worldSlot),
                inv = max(dot(d, d), 0.0025).inverseSqrt();
              const tangent = TSL.cross(d,u.spin.element(worldSlot).xyz);
              const drift = d.mul(v.x).add(tangent.mul(v.y)).mul(inv);
              result.addAssign(drift.add(vec3(0, v.z.add(v.w.mul(q).mul(4)), 0)).mul(w));
            } else result.addAssign(u.scalar.element(worldSlot).mul(w));
          });
        }
      );
    });
    return result;
  })();
}

function airTemperatureNode(u: RenderFields, altitude: N): N {
  return u.ambient.add(altitude.sub(u.column.x).mul(u.column.y).clamp(0, 1).mul(u.column.z));
}

/** Temperature alone for materials that supply their own water film. */
export function surfaceTemperatureNode(position: N): N {
  return accumulateNode(surfaceFields, position, false).y.add(airTemperatureNode(surfaceFields,position.y));
}

/** Temperature and total deposited water film, including local heat and spray. */
export function surfaceClimateNode(position: N): N {
  const local = accumulateNode(surfaceFields, position, false);
  return TSL.vec2(local.y.add(airTemperatureNode(surfaceFields, position.y)), local.z.add(shelteredRainFilmNode(position,surfaceFields.wet)).clamp(0, 1));
}

// Stock PBR and procedural materials read the same field once at the shading point.
const materialClimate = surfaceClimateNode(TSL.positionWorld);
function frozenFraction(temperature: N): N {
  return float(1).sub(TSL.smoothstep(-3, 0.5, temperature));
}

/** Material-side liquid film. Cold deposited moisture instead appears on the frost layer. */
export function surfaceWetnessNode(position: N): N {
  const climate = position === TSL.positionWorld ? materialClimate : surfaceClimateNode(position);
  return climate.y.mul(float(1).sub(frozenFraction(climate.x)));
}

/** Surface hoarfrost or frozen spray. Dry materials retain their authored finish. */
export function applySurfaceFrost(material: THREE.MeshStandardNodeMaterial, authoredWater?: N): void {
  const film = authoredWater ? materialClimate.y.max(authoredWater) : materialClimate.y;
  const frost = film.clamp(0, 1).mul(frozenFraction(materialClimate.x));
  const color = vec4(material.colorNode ?? TSL.materialColor);
  const roughness = material.roughnessNode ?? TSL.materialRoughness;
  const metalness = material.metalnessNode ?? TSL.materialMetalness;
  material.colorNode = vec4(TSL.mix(color.rgb, vec3(0.72, 0.80, 0.83), frost.mul(0.70)), color.a);
  material.roughnessNode = TSL.mix(roughness, TSL.max(roughness, 0.54), frost);
  material.metalnessNode = metalness.mul(float(1).sub(frost));
  const physical = material as THREE.MeshPhysicalNodeMaterial;
  if (physical.isMeshPhysicalNodeMaterial && physical.clearcoatRoughnessNode) {
    const coat = physical.clearcoatRoughnessNode;
    physical.clearcoatRoughnessNode = TSL.mix(coat, TSL.max(coat, 0.45), frost);
  }
}

/** Extend Three's renderer-owned material translation at shader-build time. This also
 * covers new ordinary PBR meshes attached by an embedding game after startup. */
export function installWorldMaterials(renderer: THREE.WebGPURenderer): () => void {
  const library = renderer.library,
    fromMaterial = library.fromMaterial;
  const adapt: typeof fromMaterial = function (material) {
    const translated = fromMaterial.call(library, material);
    const pbr = translated as THREE.MeshStandardNodeMaterial;
    if (!pbr?.isMeshStandardNodeMaterial || pbr.fragmentNode || material.userData.luminaWorldSurface)
      return translated;
    // Build against a lightweight view. The original material, maps, uniforms and
    // custom node graphs remain owned by the caller, including when shared by renderers.
    const view = Object.create(pbr) as THREE.MeshStandardNodeMaterial;
    const film = surfaceWetnessNode(TSL.positionWorld);
    const base = vec4(pbr.colorNode ?? TSL.materialColor);
    const rough = pbr.roughnessNode ?? TSL.materialRoughness;
    const metal = pbr.metalnessNode ?? TSL.materialMetalness;
    view.colorNode = vec4(base.rgb.mul(float(1).sub(film.mul(float(1).sub(metal)).mul(0.21))), base.a);
    // A thin film fills small grooves first. Aggregate and leaf clusters
    // retain a broad specular lobe even after prolonged rainfall.
    const microrelief = TSL.smoothstep(0.57, 0.96, rough);
    const saturated = float(0.065).add(rough.mul(0.15)).add(microrelief.mul(0.26));
    view.roughnessNode = TSL.mix(rough, TSL.min(rough, saturated), film.mul(0.9));
    applySurfaceFrost(view);
    return view;
  };
  library.fromMaterial = adapt;
  return () => {
    if (library.fromMaterial === adapt) library.fromMaterial = fromMaterial;
  };
}

function rowViews(packed: Float32Array): Float32Array[] {
  return Array.from({ length: CAPACITY }, (_, i) => packed.subarray(i * 4, i * 4 + 4));
}

export interface WaterSurface {
  /** Return NaN outside a finite surface. */
  heightAt(x: number, z: number, velocity?: THREE.Vector3): number;
}

export class WorldBus extends WindField {
  readonly shelters = new RainShelters();
  ambientTemperature = 18;
  private atmosphere: Readonly<ClimateProfile> | null = null;

  get climate(): Readonly<ClimateProfile> | null { return this.atmosphere; }

  /** Set the gameplay and shader air column together. Omit to restore the default atmosphere. */
  setClimate(profile?: ClimateProfile): void {
    if (profile) validateClimate(profile);
    this.atmosphere = profile ? Object.freeze({ ...profile }) : null;
    this.ambientTemperature = profile?.baseTemperatureC ?? 18;
    const column = this.u.column.value;
    if (profile) column.set(profile.baseAltitude, 1 / (profile.topAltitude - profile.baseAltitude),
      profile.topTemperatureC - profile.baseTemperatureC);
    else column.set(0, 0, 0);
    this.u.ambient.value = this.ambientTemperature;
  }

  airTemperatureAt(altitude: number): number {
    if (!this.atmosphere) return this.ambientTemperature;
    const column = this.u.column.value;
    return this.ambientTemperature + saturate((altitude - column.x) * column.y) * column.z;
  }

  /** Ratio of water vapour to ice saturation. Undefined until a profile is supplied. */
  iceHumidityAt(altitude: number): number | undefined {
    const climate = this.atmosphere;
    if (!climate) return undefined;
    const column = this.u.column.value;
    const f = saturate((altitude - column.x) * column.y);
    return climate.baseIceHumidity + f * (climate.topIceHumidity - climate.baseIceHumidity);
  }

  cloudBase = Infinity;
  cloudTop = -Infinity;
  upperCloudBase = Infinity;
  upperCloudTop = -Infinity;

  inCloudLayer(altitude: number, margin = 0): boolean {
    return (altitude >= this.cloudBase - margin && altitude <= this.cloudTop + margin) ||
      (altitude >= this.upperCloudBase - margin && altitude <= this.upperCloudTop + margin);
  }
  rainfall = 0;
  surfaceWetness = 0;
  private readonly positions = Array.from(
    { length: CAPACITY },
    (): Slot => ({
      source: new WorldSource(),
      owner: null,
      remaining: 0,
      duration: 0,
      gain: 1,
      channels: 0,
    })
  );
  private size = 0;
  bodyForcing = false;
  private surfaceRevision = 0;
  private readonly u = makeUniforms();
  /** Bounding box of each source, [min xyz, max xyz] per row, kept beside its uniform rows. */
  private readonly boxes = new Float64Array(CAPACITY * 6);
  /** Per-row views of the packed rows that surface materials share, for block copies. */
  private readonly startRows = rowViews(this.u.start.value);
  private readonly axisRows = rowViews(this.u.axis.value);
  private readonly scalarRows = rowViews(this.u.scalar.value);
  /** Whether the last `disturbance` sample lay inside the bounds of the sources. */
  private reached = false;
  private readonly pulseSource = new WorldSource();
  private readonly local = new FieldReading();
  private readonly waters: WaterSurface[] = [];
  private readonly candidateCurrent = new THREE.Vector3();
  get sourceCount(): number {
    return this.size;
  }
  override get blastCount(): number {
    return super.blastCount + this.size;
  }
  sourceAt(index: number): Readonly<WorldSource> {
    return this.positions[index].source;
  }
  ownedBy(index: number, owner: WorldSource): boolean {
    return this.positions[index].owner === owner;
  }
  gainAt(index: number): number {
    return this.positions[index].gain;
  }

  /** Refresh an emitter in place. Transient pulses have no owner and fade over their
   * lifetime. At capacity replace the shortest-lived transient before a held emitter. */
  publish(input: WorldSource, lifetime = 0.3, transient = false): boolean {
    if (!(input.radius > 0 && lifetime > 0) || !Number.isFinite(input.radius + lifetime)) return false;
    const count = this.size;
    let next = -1,
      replace = -1,
      timeLeft = Infinity;
    for (let i = 0; i < count; i++) {
      const slot = this.positions[i];
      if (!transient && slot.owner === input) {
        next = i;
        break;
      }
      if (!slot.owner && slot.remaining < timeLeft) {
        timeLeft = slot.remaining;
        replace = i;
      }
    }
    if (next < 0) next = count < CAPACITY ? this.size++ : replace;
    if (next < 0) return false;
    const slot = this.positions[next], source = slot.source;
    const before = slot.channels;
    const channels = (slot.channels = this.adoptStrengths(source, input, next * 4));
    this.adoptShape(source, input, next * 4);
    this.enclose(source, next * 6);
    if (((before | channels) & WETS_OR_HEATS) !== 0) this.surfaceRevision++;
    slot.owner = transient ? null : input;
    slot.duration = slot.remaining = lifetime;
    slot.gain = 1;
    this.refreshBounds();
    return true;
  }

  // `adoptStrengths` and `adoptShape` together take the snapshot `WorldSource.copy` would, but
  // read each field of `input` once and write what depends on it in the same pass. They are
  // kept small on purpose: V8 only inlines short functions into `publish`, and a helper too
  // long to inline stays in the unoptimised tiers long after its caller has left them.

  /** Copy the strengths of `input` into `s`, write its strength rows at full gain and return
   * its channel bits. */
  private adoptStrengths(s: WorldSource, input: WorldSource, k: number): number {
    const radial = (s.radial = input.radial), swirl = (s.swirl = input.swirl);
    const lift = (s.lift = input.lift), rimLift = (s.rimLift = input.rimLift);
    const pressure = (s.pressure = input.pressure), heat = (s.heat = input.heat);
    const wetness = (s.wetness = input.wetness), cloudCut = (s.cloudCut = input.cloudCut);
    let channels = 0;
    if (radial !== 0) channels |= RADIAL;
    if (swirl !== 0) channels |= SWIRL;
    if (lift !== 0) channels |= LIFT;
    if (rimLift !== 0) channels |= RIM_LIFT;
    if (pressure !== 0) channels |= PRESSURE;
    if (!Object.is(heat, 0)) channels |= HEAT;
    if (wetness !== 0) channels |= WETNESS;
    if (cloudCut !== 0) channels |= CLOUD_CUT;
    if (swirl || radial || lift || rimLift || pressure) channels |= FORCES_BODIES;
    if (heat || wetness) channels |= WETS_OR_HEATS;
    if (!(cloudCut <= 0)) channels |= CUTS_CLOUD;
    // A newly published source is at full gain, so its strengths go up as they are.
    const wind = this.u.wind.value, scalar = this.u.scalar.value;
    wind[k] = radial;
    wind[k + 1] = swirl;
    wind[k + 2] = lift;
    wind[k + 3] = rimLift;
    scalar[k] = pressure;
    scalar[k + 1] = heat;
    scalar[k + 2] = wetness;
    scalar[k + 3] = cloudCut;
    return channels;
  }

  /** Copy the swept sphere of `input` into `s` and write its geometry rows. */
  private adoptShape(s: WorldSource, input: WorldSource, k: number): void {
    const a = s.start.copy(input.start), b = s.end.copy(input.end);
    const ax = a.x, ay = a.y, az = a.z;
    const radius = (s.radius = input.radius), axialSwirl = (s.axialSwirl = input.axialSwirl);
    const x = b.x - ax,
      y = b.y - ay,
      z = b.z - az;
    const start = this.u.start.value,
      axis = this.u.axis.value,
      spin = this.u.spin.value;
    start[k] = ax;
    start[k + 1] = ay;
    start[k + 2] = az;
    start[k + 3] = 1 / (radius * radius);
    axis[k] = x;
    axis[k + 1] = y;
    axis[k + 2] = z;
    const lengthSq = x*x + y*y + z*z;
    // 1 / Math.max(1e-6, lengthSq).
    axis[k + 3] = 1 / (lengthSq < 1e-6 ? 1e-6 : lengthSq);
    if (axialSwirl && lengthSq > 1e-6) {
      const inv = 1 / Math.sqrt(lengthSq);
      spin[k] = x*inv; spin[k+1] = y*inv; spin[k+2] = z*inv;
    } else {
      spin[k] = 0; spin[k+1] = 1; spin[k+2] = 0;
    }
  }

  /**
   * Cache the bounding box of a swept sphere at offset `o` of `boxes`. The selects are
   * `Math.min` / `Math.max` of the two ends, including their NaN result, which switches the
   * field off for a source with no position.
   */
  private enclose(s: WorldSource, o: number): void {
    const a = s.start, b = s.end, radius = s.radius, boxes = this.boxes;
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    boxes[o] = (ax < bx || ax !== ax ? ax : bx) - radius;
    boxes[o + 1] = (ay < by || ay !== ay ? ay : by) - radius;
    boxes[o + 2] = (az < bz || az !== az ? az : bz) - radius;
    boxes[o + 3] = (ax > bx || ax !== ax ? ax : bx) + radius;
    boxes[o + 4] = (ay > by || ay !== ay ? ay : by) + radius;
    boxes[o + 5] = (az > bz || az !== az ? az : bz) + radius;
  }

  removeSource(owner: WorldSource): void {
    for (let i = 0; i < this.size; i++)
      if (this.positions[i].owner === owner) {
        this.removeAt(i);
        break;
      }
  }

  private removeAt(i: number): void {
    const last = --this.size,
      old = this.positions[i];
    this.positions[i] = this.positions[last];
    this.positions[last] = old;
    old.owner = null;
    if (i < last) {
      // The source that takes over row `i` brings its rows along as they stand.
      const u = this.u, from = last * 4, to = i * 4;
      u.start.value.copyWithin(to, from, from + 4);
      u.axis.value.copyWithin(to, from, from + 4);
      u.wind.value.copyWithin(to, from, from + 4);
      u.spin.value.copyWithin(to, from, from + 4);
      u.scalar.value.copyWithin(to, from, from + 4);
      this.boxes.copyWithin(i * 6, last * 6, last * 6 + 6);
    }
    this.refreshBounds();
    if ((old.channels & WETS_OR_HEATS) !== 0) this.surfaceRevision++;
  }

  /** Rewrite the strengths of a fading source. A zero strength stays as it was published. */
  private fade(slot: Slot, k: number): void {
    const s = slot.source, g = slot.gain, channels = Number.isNaN(g) ? EVERY_STRENGTH : slot.channels;
    const wind = this.u.wind.value, scalar = this.u.scalar.value;
    if ((channels & RADIAL) !== 0) wind[k] = g * s.radial;
    if ((channels & SWIRL) !== 0) wind[k + 1] = g * s.swirl;
    if ((channels & LIFT) !== 0) wind[k + 2] = g * s.lift;
    if ((channels & RIM_LIFT) !== 0) wind[k + 3] = g * s.rimLift;
    if ((channels & PRESSURE) !== 0) scalar[k] = g * s.pressure;
    if ((channels & HEAT) !== 0) scalar[k + 1] = g * s.heat;
    if ((channels & WETNESS) !== 0) scalar[k + 2] = g * s.wetness;
    if ((channels & CLOUD_CUT) !== 0) scalar[k + 3] = g * s.cloudCut;
  }

  /**
   * Rebuild what the bus keeps about its sources as a whole: their count, whether any moves air
   * or bodies, their bounds and the bounds of those that cut cloud. It runs over the cached
   * boxes and channel bits rather than deriving each box from its source again.
   */
  private refreshBounds(): void {
    const positions = this.positions, boxes = this.boxes, size = this.size, u = this.u;
    u.count.value = size;
    let lowX = 1e20, lowY = 1e20, lowZ = 1e20, highX = -1e20, highY = -1e20, highZ = -1e20;
    let low = Infinity,
      high = -Infinity;
    let forcing = false;
    for (let i = 0, o = 0; i < size; i++, o += 6) {
      const x0 = boxes[o], y0 = boxes[o + 1], z0 = boxes[o + 2];
      const x1 = boxes[o + 3], y1 = boxes[o + 4], z1 = boxes[o + 5];
      // Math.min / Math.max folds, NaN included.
      if (x0 < lowX || x0 !== x0) lowX = x0;
      if (y0 < lowY || y0 !== y0) lowY = y0;
      if (z0 < lowZ || z0 !== z0) lowZ = z0;
      if (x1 > highX || x1 !== x1) highX = x1;
      if (y1 > highY || y1 !== y1) highY = y1;
      if (z1 > highZ || z1 !== z1) highZ = z1;
      const channels = positions[i].channels;
      if ((channels & FORCES_BODIES) !== 0) forcing = true;
      if ((channels & CUTS_CLOUD) === 0) continue;
      if (y0 < low || y0 !== y0) low = y0;
      if (y1 > high || y1 !== y1) high = y1;
    }
    this.bodyForcing = forcing;
    const lo = u.minimum.value as THREE.Vector3,
      hi = u.maximum.value as THREE.Vector3;
    lo.x = lowX; lo.y = lowY; lo.z = lowZ;
    hi.x = highX; hi.y = highY; hi.z = highZ;
    // Math.min(low, 1e20) and Math.max(high, -1e20), stored only when they moved (a number
    // uniform holds a tagged value, so storing an unchanged number would box it again).
    const cloudMin = low < 1e20 || low !== low ? low : 1e20, cloudMax = high > -1e20 || high !== high ? high : -1e20;
    if (u.cloudMin.value !== cloudMin) u.cloudMin.value = cloudMin;
    if (u.cloudMax.value !== cloudMax) u.cloudMax.value = cloudMax;
  }

  override update(dt: number): void {
    super.update(dt);
    const rain = saturate(this.rainfall), film = this.surfaceWetness;
    const climate = this.atmosphere;
    const drying = climate ? 0.018 * Math.min(4, Math.exp((this.ambientTemperature - 18) * 0.035))
      * (1 - climate.surfaceHumidity) * 2 * (this.ambientTemperature < 0 ? 0.12 : 1) : 0.018;
    if (this.shelters.count) this.shelters.update(dt, this.direction.x * this.speed, this.direction.y * this.speed, rain, drying);
    let wet: number;
    // The film is at rest when it is dry under a dry sky or saturated under full rain: the
    // rate below is then exactly zero, or only pushes against the clamp.
    if (dt >= 0 && dt < Infinity && ((rain === 0 && film === 0) || (rain === 1 && film === 1))) wet = rain;
    else {
      wet = saturate(film + dt * (rain * 0.45 * (1 - film) - (1 - rain) * drying));
    }
    this.surfaceWetness = wet;
    // Number uniforms hold tagged values, so storing an unchanged number would box it again.
    const u = this.u, ambient = this.ambientTemperature;
    if (u.wet.value !== wet) u.wet.value = wet;
    if (u.ambient.value !== ambient) u.ambient.value = ambient;
    if (dt <= 0) return;
    for (let i = this.size - 1; i >= 0; i--) {
      const slot = this.positions[i];
      const remaining = (slot.remaining -= dt);
      if (remaining <= 0) this.removeAt(i);
      else if (!slot.owner) {
        const fade = remaining / slot.duration;
        slot.gain = fade * fade * (3 - 2 * fade);
        // The fade changes intensity; the swept capsule geometry stays fixed.
        this.fade(slot, i * 4);
        if ((slot.channels & WETS_OR_HEATS) !== 0) this.surfaceRevision++;
      }
    }
  }

  rainFilmAt(x: number, y: number, z: number): number {
    return this.shelters.count ? this.shelters.filmAt(x,y,z,this.surfaceWetness) : this.surfaceWetness;
  }

  bindMaterials(): void {
    this.shelters.bindMaterials();
    const wet = this.surfaceWetness, ambient = this.ambientTemperature;
    surfaceFields.column.value.copy(this.u.column.value);
    if (surfaceFields.wet.value !== wet) surfaceFields.wet.value = wet;
    if (surfaceFields.ambient.value !== ambient) surfaceFields.ambient.value = ambient;
    if (boundSurface === this && boundRevision === this.surfaceRevision) return;
    // The rows of a warm or wet source are already packed for this bus; surface materials get
    // block copies of them rather than a second derivation from the source.
    const start = surfaceFields.start.value, axis = surfaceFields.axis.value, scalar = surfaceFields.scalar.value;
    let count = 0;
    for (let i = 0; i < this.size; i++) {
      if ((this.positions[i].channels & WETS_OR_HEATS) === 0) continue;
      const k = count++ * 4;
      start.set(this.startRows[i], k);
      axis.set(this.axisRows[i], k);
      scalar.set(this.scalarRows[i], k);
    }
    surfaceFields.count.value = count;
    surfaceFields.minimum.value.copy(this.u.minimum.value);
    surfaceFields.maximum.value.copy(this.u.maximum.value);
    boundSurface = this;
    boundRevision = this.surfaceRevision;
  }

  /** Atmospheric pressure transients also clear local cloud moisture. The inherited
   * wind field already drives the expanding air front for v2 callers. */
  override addBlast(p: THREE.Vector3, strength: number, radius: number, duration = 1.2, sourceId?: number): void {
    super.addBlast(p, strength, radius, duration, sourceId);
    const s = this.pulseSource.at(p.x, p.y, p.z);
    s.radius = radius;
    s.pressure = strength * 0.15;
    s.cloudCut = 0.9;
    this.publish(s, duration, true);
  }

  /** Scalar coupling coefficient for one registered capsule at a world coordinate. */
  weightAt(index: number, x: number, y: number, z: number): number {
    const slot = this.positions[index],
      start = slot.source.start,
      axis = this.u.axis.value,
      k = index * 4;
    const px = x - start.x,
      py = y - start.y,
      pz = z - start.z;
    const ax = axis[k], ay = axis[k + 1], az = axis[k + 2];
    const t = saturate((px * ax + py * ay + pz * az) * axis[k + 3]);
    const dx = px - ax * t,
      dy = py - ay * t,
      dz = pz - az * t;
    const fall = 1 - (dx * dx + dy * dy + dz * dz) * this.u.start.value[k + 3];
    // Math.max(0, fall).
    const envelope = fall > 0 || fall !== fall ? fall : 0;
    return envelope * envelope * slot.gain;
  }

  contains(p: THREE.Vector3): boolean {
    const lo = this.u.minimum.value,
      hi = this.u.maximum.value;
    const x = p.x, y = p.y, z = p.z;
    return x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y && z >= lo.z && z <= hi.z;
  }

  /** Sample disturbance velocity plus pressure, temperature and water film. */
  disturbance(p: THREE.Vector3, out: FieldReading): FieldReading {
    let px = 0,
      py = 0,
      pz = 0;
    let vx = 0,
      vy = 0,
      vz = 0,
      pressure = 0,
      heat = this.airTemperatureAt(p.y),
      wet = this.rainFilmAt(p.x,p.y,p.z),
      cloud = 0;
    // The sample point and each row are read once and reused by every term below.
    const x0 = p.x, y0 = p.y, z0 = p.z;
    const lo = this.u.minimum.value,
      hi = this.u.maximum.value;
    const reached = x0 >= lo.x && x0 <= hi.x && y0 >= lo.y && y0 <= hi.y && z0 >= lo.z && z0 <= hi.z;
    this.reached = reached;
    if (reached) {
      const positions = this.positions, count = this.size;
      const starts = this.u.start.value, ab = this.u.axis.value, spin = this.u.spin.value;
      let unheated = false;
      for (let i = 0, k = 0; i < count; i++, k += 4) {
        const slot = positions[i],
          s = slot.source,
          a = s.start;
        const x = x0 - a.x,
          y = y0 - a.y,
          z = z0 - a.z;
        const abx = ab[k], aby = ab[k + 1], abz = ab[k + 2];
        const t = saturate((x * abx + y * aby + z * abz) * ab[k + 3]);
        const dx = x - t * abx,
          dy = y - t * aby,
          dz = z - t * abz,
          d2 = dx * dx + dy * dy + dz * dz;
        const invRadiusSq = starts[k + 3];
        const q = d2 * invRadiusSq;
        if (q >= 1) continue;
        const gain = slot.gain, core = 1 - q;
        // Math.max(0.0025, d2) under the root.
        const w = core * core * gain,
          scale = w / Math.sqrt(d2 < 0.0025 ? 0.0025 : d2);
        const channels = Number.isNaN(w) ? EVERY_STRENGTH : slot.channels;
        // A zero strength would only add zero here, so its terms are left out. (`vy` takes
        // its radial and lift terms as one sum, as before, whenever both are present.)
        const rises = (channels & (LIFT | RIM_LIFT)) !== 0;
        if ((channels & RADIAL) !== 0) {
          const radial = s.radial;
          vx += dx * radial * scale;
          vy += rises ? dy * radial * scale + (s.lift + 4 * q * s.rimLift) * w : dy * radial * scale;
          vz += dz * radial * scale;
        } else if (rises) vy += (s.lift + 4 * q * s.rimLift) * w;
        if ((channels & SWIRL) !== 0) {
          const omega = s.swirl * scale, sx = spin[k], sy = spin[k + 1], sz = spin[k + 2];
          vx += (dy*sz - dz*sy) * omega;
          vy += (dz*sx - dx*sz) * omega;
          vz += (dx*sy - dy*sx) * omega;
        }
        if ((channels & PRESSURE) !== 0) {
          const strength = s.pressure;
          const gradient = 4 * core * gain * strength * invRadiusSq;
          px += dx * gradient;
          py += dy * gradient;
          pz += dz * gradient;
          pressure += w * strength;
        }
        if ((channels & HEAT) !== 0) heat += w * s.heat;
        else unheated = true;
        if ((channels & WETNESS) !== 0) wet += w * s.wetness;
        if ((channels & CLOUD_CUT) !== 0) cloud += w * s.cloudCut;
      }
      // Adding the +0 of an unheated source turned an ambient temperature of -0 into 0.
      if (unheated && heat === 0) heat = 0;
    }
    const force = out.pressureForce, wind = out.wind;
    force.x = px; force.y = py; force.z = pz;
    wind.x = vx; wind.y = vy; wind.z = vz;
    out.pressure = pressure;
    out.temperature = heat;
    out.wetness = saturate(wet);
    out.cloudCut = saturate(cloud);
    return out;
  }

  ambientWind(p: THREE.Vector3, time: number, out: THREE.Vector3): THREE.Vector3 {
    return super.sample(p, time, out);
  }
  override sample(p: THREE.Vector3, time: number, out = new THREE.Vector3(), excludeSourceId?: number): THREE.Vector3 {
    super.sample(p, time, out, excludeSourceId);
    if (this.size === 0) return out;
    // One bounds test: `disturbance` reports whether the point was inside.
    const wind = this.disturbance(p, this.local).wind;
    return this.reached ? out.add(wind) : out;
  }
  read(p: THREE.Vector3, time: number, out: FieldReading): FieldReading {
    this.disturbance(p, out);
    super.sample(p, time, this.local.wind);
    out.wind.add(this.local.wind);
    return out;
  }
  override node(p: N): N {
    return super.node(p).add(accumulateNode(this.u, p, true));
  }
  localWindNode(p: N): N {
    return accumulateNode(this.u, p, true);
  }
  scalarNode(p: N): N {
    const f = accumulateNode(this.u, p, false);
    const film = this.shelters.groundNode(p, this.u.wet, false).x;
    return vec4(f.x, f.y.add(airTemperatureNode(this.u, p.y)), f.z.add(film).clamp(0, 1), f.w.clamp(0, 1));
  }
  cloudNode(p: N): N {
    return accumulateNode(this.u, p, false, true).w.clamp(0, 1);
  }

  addWater(surface: WaterSurface): () => void {
    this.waters.push(surface);
    return () => {
      const i = this.waters.indexOf(surface);
      if (i >= 0) this.waters.splice(i, 1);
    };
  }
  waterHeight(x: number, z: number, velocity?: THREE.Vector3): number {
    let highest = -Infinity;
    velocity?.set(0, 0, 0);
    for (let i = 0; i < this.waters.length; i++) {
      const current = velocity ? this.candidateCurrent.set(0, 0, 0) : undefined;
      const h = this.waters[i].heightAt(x, z, current);
      if (h > highest) {
        highest = h;
        if (velocity) velocity.copy(this.candidateCurrent);
      }
    }
    return highest;
  }

  clearWorld(): void {
    this.shelters.clear();
    while (this.size) this.removeAt(this.size - 1);
    this.waters.length = 0;
    this.rainfall = 0;
    this.surfaceWetness = 0;
    this.setClimate();
    this.cloudBase = this.upperCloudBase = Infinity;
    this.cloudTop = this.upperCloudTop = -Infinity;
    super.clearBlasts();
    this.bindMaterials();
  }
}
