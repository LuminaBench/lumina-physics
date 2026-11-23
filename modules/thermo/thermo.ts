/**
 * Thermo: multi-elevation 3D temperature / fuel / moisture field with fire spread,
 * charring, steam, melting, heat glow and HDR local fire lighting.
 *
 * Primary ground grid (default 96², ≈ 0.4 m cells) plus any number of oriented 3D
 * `ThermalSurface` patches (vertical walls, bulkheads, stacked elevated decks/shelves)
 * and stacked `ThermalBody` props, stepped at 20 Hz:
 *
 *   combustion   fuel above its ignition point burns at a rate limited by moisture; burning
 *                releases heat toward a flame temperature
 *   3D spread    conduction + radiant pre-heating biased by wind AND upward buoyancy:
 *                  - ground flames lean downwind and send rising buoyant plumes up into
 *                    stacked props, walls and elevated decks
 *                  - vertical/sloped walls exhibit strong chimney upward flame spread
 *                  - stacked `ThermalBody` props conduct & convect heat in full 3D
 *                    (upward stack convection, lateral radiation, slower downward conduction)
 *   water        rain and splashes add moisture and carry heat away; moisture on a cell
 *                hotter than 100 °C boils off as steam and takes latent heat with it
 *   bodies       props react in 3D: wood ignites, chars and feeds stacked neighbours & walls;
 *                metal soaks up heat and glows; ice melts into a wet patch
 *
 * Every ground grid and 3D `ThermalSurface` publishes a DataTexture (`sample`, `surface`,
 * `shade`) so floors, stacked decks and vertical walls show ragged char, glowing ember
 * cracks and wet darkening without UV stretching.
 */
import type { RainShelters } from '../../engine/rain-shelters';
import { WorldSource } from '../../engine/world-bus';
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { blackbody, valueNoise2 } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit, FireLightHandle } from '../../engine/fx';
import type { Weather } from '../weather/weather';
import type { Ocean } from '../water/ocean';

const { texture, vec2, vec3, float, mix, smoothstep, max, dot, abs } = TSL;

export const AMBIENT = 22;
const IGNITION = 280;
const FLAME = 950;
/** Texture encoding: temperature is stored as T / T_SCALE. */
const T_SCALE = 1200;
const STEP = 1 / 20;

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _c = new THREE.Color();
const _uv = new THREE.Vector2();

/** Blackbody-ish emission colour for a temperature in °C (Draper point ≈ 525 °C). */
export function glowColor(celsius: number, out = new THREE.Color()): THREE.Color {
  const t = THREE.MathUtils.clamp((celsius - 480) / 900, 0, 1);
  if (t <= 0) return out.setRGB(0, 0, 0);
  const k = t * t * (0.6 + 2.4 * t);
  return out.setRGB(k * 1.0, k * (0.12 + 0.62 * t * t), k * (0.02 + 0.3 * t * t * t));
}

export interface ThermoOptions {
  /** Centre of the simulated ground patch (world XZ). */
  center?: THREE.Vector2;
  /** Side length of the ground patch in metres. */
  size?: number;
  resolution?: number;
  /** Height of the primary ground surface (particles spawn here). */
  surfaceY?: number;
  /** Rain intensity is read from the weather every frame when given. */
  weather?: Weather | null;
  /** Anything below the water surface is permanently quenched. */
  ocean?: Ocean | null;
}

export type ThermalKind = 'wood' | 'metal' | 'ice';

export interface ThermalBodyOptions {
  object: THREE.Object3D;
  kind: ThermalKind;
  /** Footprint radius on the field (m). */
  radius?: number;
  /** Height of the object (flames climb it and stacked neighbours couple across it). */
  height?: number;
  /** Material whose colour / emission follows the body's state (cloned per body by the caller). */
  material?: THREE.MeshStandardMaterial;
  /** Seconds of burning a wooden body can sustain. */
  burnTime?: number;
}

export class ThermalBody {
  /** °C */
  temperature = AMBIENT;
  /** 0..1 burnt (wood) or melted (ice). */
  progress = 0;
  burning = false;
  /** Fired once when wood is burnt out or ice has fully melted. */
  onSpent: (() => void) | null = null;
  readonly radius: number;
  readonly height: number;
  readonly baseColor = new THREE.Color(1, 1, 1);
  readonly baseScale = new THREE.Vector3(1, 1, 1);
  spent = false;
  /** Cached world position during each simulation step (zero allocations). */
  readonly _worldPos = new THREE.Vector3();

  constructor(readonly options: ThermalBodyOptions) {
    this.radius = options.radius ?? 0.5;
    this.height = options.height ?? 1;
    if (options.material) this.baseColor.copy(options.material.color);
    this.baseScale.copy(options.object.scale);
  }
}

// ----------------------------------------------------------------------------
// Multi-elevation 3D Thermal Surfaces (walls, bulkheads, stacked decks/shelves)
// ----------------------------------------------------------------------------

export interface ThermalSurfaceOptions {
  /** World-space centre of the planar patch. */
  position: THREE.Vector3;
  /** Outward surface normal (unit vector). */
  normal: THREE.Vector3;
  /** Optional local +U tangent axis (auto-computed perpendicular to `normal` if omitted). */
  tangentU?: THREE.Vector3;
  /** Patch width along tangentU (m). */
  width: number;
  /** Patch height/depth along tangentV (m). */
  height: number;
  /** Grid cells along U (default 24). */
  resolutionU?: number;
  /** Grid cells along V (default 24). */
  resolutionV?: number;
  /** Half-thickness (m) for world-space shader projection onto thick walls/slabs (default 0.45). */
  thickness?: number;
  /** Initial uniform fuel density (kg/m², default 0). */
  fuel?: number;
  /** Optional identifier for debugging. */
  name?: string;
}

export interface ThermalWallOptions {
  /** World-space centre of the wall. */
  position: THREE.Vector3;
  width: number;
  height: number;
  /** Outward normal (horizontal); alternatively pass `rotationY` (radians around +Y, 0 faces +Z). */
  normal?: THREE.Vector3;
  rotationY?: number;
  resolution?: number;
  thickness?: number;
  /** Initial uniform fuel (kg/m², e.g. 2.4 for timber cladding, 0 for concrete scorch-only). */
  fuel?: number;
  name?: string;
}

export interface ThermalDeckOptions {
  /** World-space centre of the elevated horizontal deck / stacked shelf. */
  position: THREE.Vector3;
  width: number;
  depth: number;
  resolution?: number;
  thickness?: number;
  fuel?: number;
  name?: string;
}

/**
 * Oriented 3D planar thermal grid (wall, sloped panel, or elevated stacked deck).
 * Supports anisotropic upward buoyancy flame spread, wind projection, rain exposure,
 * bidirectional 3D coupling with the ground field, other surfaces and stacked props,
 * and a zero-stretch local-coordinate TSL shader hook (`shade`).
 */
export class ThermalSurface {
  readonly origin: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly tangentU: THREE.Vector3;
  readonly tangentV: THREE.Vector3;
  readonly width: number;
  readonly height: number;
  readonly resU: number;
  readonly resV: number;
  readonly thickness: number;
  readonly name: string;
  /** Component of tangentV pointing straight up (1 = vertical wall, 0 = flat deck). */
  readonly upwardV: number;
  /** Fraction of rainfall landing directly on this surface (1 = flat deck, ~0.18 = vertical wall). */
  readonly rainExposure: number;

  T: Float32Array;
  T2: Float32Array;
  fuel: Float32Array;
  fuel0: Float32Array;
  wet: Float32Array;
  char: Float32Array;
  burn: Float32Array;
  steamMap: Float32Array;
  readonly burningList: number[] = [];
  readonly steamList: number[] = [];
  active = false;
  intensity = 0;

  private pixels: Uint8Array;
  readonly texture: THREE.DataTexture;

  constructor(options: ThermalSurfaceOptions, public ambient = AMBIENT) {
    this.origin = options.position.clone();
    this.normal = options.normal.clone().normalize();
    if (options.tangentU) {
      this.tangentU = options.tangentU.clone().addScaledVector(this.normal, -options.tangentU.dot(this.normal)).normalize();
      this.tangentV = new THREE.Vector3().crossVectors(this.normal, this.tangentU).normalize();
      // Keep tangentV pointing upward whenever the surface is not horizontal.
      if (this.tangentV.y < -0.01) { this.tangentV.negate(); this.tangentU.negate(); }
    } else if (Math.abs(this.normal.y) > 0.92) {
      // Horizontal deck / ceiling.
      this.tangentU = new THREE.Vector3(1, 0, 0);
      this.tangentV = new THREE.Vector3().crossVectors(this.normal, this.tangentU).normalize();
    } else {
      // Vertical or sloped wall: V points uphill along the wall!
      const up = new THREE.Vector3(0, 1, 0);
      this.tangentU = new THREE.Vector3().crossVectors(up, this.normal).normalize();
      this.tangentV = new THREE.Vector3().crossVectors(this.normal, this.tangentU).normalize();
    }
    this.width = Math.max(0.2, options.width);
    this.height = Math.max(0.2, options.height);
    this.resU = Math.max(6, Math.round(options.resolutionU ?? 24));
    this.resV = Math.max(6, Math.round(options.resolutionV ?? 24));
    this.thickness = options.thickness ?? 0.45;
    this.name = options.name ?? 'thermal-surface';
    this.upwardV = this.tangentV.y;
    this.rainExposure = Math.max(0.16, Math.max(0, this.normal.y));

    const n = this.resU * this.resV;
    this.T = new Float32Array(n).fill(this.ambient);
    this.T2 = new Float32Array(n).fill(this.ambient);
    this.fuel = new Float32Array(n);
    this.fuel0 = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.char = new Float32Array(n);
    this.burn = new Float32Array(n);
    this.steamMap = new Float32Array(n);
    if (options.fuel && options.fuel > 0) {
      this.fuel.fill(options.fuel);
      this.fuel0.fill(options.fuel);
    }

    this.pixels = new Uint8Array(n * 4);
    this.texture = new THREE.DataTexture(this.pixels, this.resU, this.resV, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.publish();
  }

  cellSizeU(): number { return this.width / this.resU; }
  cellSizeV(): number { return this.height / this.resV; }

  /** Project world position into local surface coordinates `(u, v)` in metres from origin; returns perpendicular signed distance. */
  worldToLocal(pos: THREE.Vector3, outUV: THREE.Vector2): number {
    const dx = pos.x - this.origin.x, dy = pos.y - this.origin.y, dz = pos.z - this.origin.z;
    outUV.set(
      dx * this.tangentU.x + dy * this.tangentU.y + dz * this.tangentU.z,
      dx * this.tangentV.x + dy * this.tangentV.y + dz * this.tangentV.z,
    );
    return dx * this.normal.x + dy * this.normal.y + dz * this.normal.z;
  }

  /** World position of grid cell `i`. */
  cellWorld(i: number, out: THREE.Vector3): THREE.Vector3 {
    const iu = i % this.resU;
    const iv = Math.floor(i / this.resU);
    const lu = ((iu + 0.5) / this.resU - 0.5) * this.width;
    const lv = ((iv + 0.5) / this.resV - 0.5) * this.height;
    return out.set(
      this.origin.x + this.tangentU.x * lu + this.tangentV.x * lv,
      this.origin.y + this.tangentU.y * lu + this.tangentV.y * lv,
      this.origin.z + this.tangentU.z * lu + this.tangentV.z * lv,
    );
  }

  indexAtWorld(pos: THREE.Vector3, maxPlaneDist = this.thickness): number {
    const d = Math.abs(this.worldToLocal(pos, _uv));
    if (d > maxPlaneDist) return -1;
    const nu = _uv.x / this.width + 0.5;
    const nv = _uv.y / this.height + 0.5;
    if (nu < 0 || nu >= 1 || nv < 0 || nv >= 1) return -1;
    return Math.floor(nv * this.resV) * this.resU + Math.floor(nu * this.resU);
  }

  /** Visit cells inside a 3D sphere intersecting this surface. */
  forSphere(center: THREE.Vector3, radius: number, fn: (i: number, falloff: number) => void): boolean {
    const dist = this.worldToLocal(center, _uv);
    const absDist = Math.abs(dist);
    if (absDist > radius + this.thickness * 0.5) return false;
    const planarR = Math.sqrt(Math.max(0, (radius + this.thickness * 0.5) ** 2 - absDist * absDist));
    const cu = (_uv.x / this.width + 0.5) * this.resU;
    const cv = (_uv.y / this.height + 0.5) * this.resV;
    const spanU = Math.ceil(planarR / this.cellSizeU());
    const spanV = Math.ceil(planarR / this.cellSizeV());
    const u0 = Math.max(0, Math.floor(cu - spanU)), u1 = Math.min(this.resU - 1, Math.ceil(cu + spanU));
    const v0 = Math.max(0, Math.floor(cv - spanV)), v1 = Math.min(this.resV - 1, Math.ceil(cv + spanV));
    if (u0 > u1 || v0 > v1) return false;
    let touched = false;
    const cellU = this.cellSizeU(), cellV = this.cellSizeV();
    const invR = 1 / Math.max(radius, 1e-3);
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        const du = (u + 0.5 - cu) * cellU;
        const dv = (v + 0.5 - cv) * cellV;
        const d3 = Math.sqrt(du * du + dv * dv + absDist * absDist);
        if (d3 <= radius + this.thickness * 0.35) {
          fn(v * this.resU + u, Math.max(0, 1 - d3 * invR));
          touched = true;
        }
      }
    }
    return touched;
  }

  fillFuel(amount: number): void {
    for (let i = 0; i < this.fuel.length; i++) {
      this.fuel[i] += amount;
      this.fuel0[i] = Math.max(this.fuel0[i], this.fuel[i]);
    }
  }

  addFuelWorld(position: THREE.Vector3, radius: number, amount: number): void {
    this.forSphere(position, radius, (i) => {
      this.fuel[i] += amount;
      this.fuel0[i] = Math.max(this.fuel0[i], this.fuel[i]);
    });
  }

  igniteWorld(position: THREE.Vector3, radius = 0.9): boolean {
    const hit = this.forSphere(position, radius, (i, k) => {
      this.T[i] = Math.max(this.T[i], IGNITION + 440 * (0.4 + 0.6 * k));
      this.wet[i] *= 0.3;
    });
    if (hit) this.active = true;
    return hit;
  }

  heatWorld(position: THREE.Vector3, radius: number, degrees: number): boolean {
    const hit = this.forSphere(position, radius, (i, k) => {
      this.T[i] = Math.min(1400, this.T[i] + degrees * k);
    });
    if (hit) this.active = true;
    return hit;
  }

  quenchWorld(position: THREE.Vector3, radius: number, amount = 1): boolean {
    const hit = this.forSphere(position, radius, (i, k) => {
      this.wet[i] = Math.min(1, this.wet[i] + amount * (0.4 + 0.6 * k));
    });
    if (hit) this.active = true;
    return hit;
  }

  temperatureAtWorld(position: THREE.Vector3): number {
    const i = this.indexAtWorld(position);
    return i < 0 ? this.ambient : this.T[i];
  }

  isBurningAtWorld(position: THREE.Vector3): boolean {
    const i = this.indexAtWorld(position);
    return i >= 0 && this.burn[i] > 0.02;
  }

  charAtWorld(position: THREE.Vector3): number {
    const i = this.indexAtWorld(position);
    return i < 0 ? 0 : this.char[i];
  }

  wetnessAtWorld(position: THREE.Vector3): number {
    const i = this.indexAtWorld(position);
    return i < 0 ? 0 : this.wet[i];
  }

  reset(): void {
    this.T.fill(this.ambient);
    this.T2.fill(this.ambient);
    this.fuel.set(this.fuel0);
    this.wet.fill(0);
    this.char.fill(0);
    this.burn.fill(0);
    this.steamMap.fill(0);
    this.burningList.length = 0;
    this.steamList.length = 0;
    this.active = false;
    this.intensity = 0;
    this.publish();
  }

  publish(): void {
    const n = this.resU * this.resV, px = this.pixels;
    for (let i = 0; i < n; i++) {
      px[i * 4] = Math.max(0, Math.min(255, (this.T[i] / T_SCALE) * 255));
      px[i * 4 + 1] = this.char[i] * 255;
      px[i * 4 + 2] = this.wet[i] * 255;
      px[i * 4 + 3] = this.burn[i] * 255;
    }
    this.texture.needsUpdate = true;
  }

  /**
   * Step this 3D surface one 20 Hz tick with buoyancy-driven vertical spread + projected wind.
   * Returns `{ charred, steam }` summary for parent field stats.
   */
  step(wind: THREE.Vector3, rain: number, waterLevel: number | null, shelters?: RainShelters): { charred: number; steam: number } {
    const ru = this.resU, rv = this.resV, n = ru * rv;
    const cu = this.cellSizeU(), cv = this.cellSizeV();
    const T = this.T, T2 = this.T2, fuel = this.fuel, fuel0 = this.fuel0, wet = this.wet, char = this.char, burn = this.burn;
    // Project wind onto the surface tangent plane + add vertical buoyancy chimney flow!
    const wU = wind.dot(this.tangentU);
    const wV = wind.dot(this.tangentV) + this.upwardV * 9.5; // Rising buoyant plume climbs walls rapidly.
    const flowSpeed = Math.hypot(wU, wV);
    const fx = flowSpeed > 0.01 ? wU / flowSpeed : 0;
    const fy = flowSpeed > 0.01 ? wV / flowSpeed : 0;
    const lean = Math.min(1.25, flowSpeed / 12);
    const incomingRain = rain * this.rainExposure;
    const checkRoof = incomingRain > 0 && shelters && shelters.count > 0;

    this.burningList.length = 0;
    this.steamList.length = 0;
    let anyHot = false, burningArea = 0, charred = 0, steam = 0;

    for (let i = 0; i < n; i++) {
      let t = T[i];
      if (waterLevel !== null || checkRoof) this.cellWorld(i, _p);
      if (waterLevel !== null && _p.y < waterLevel) {
        T[i] = this.ambient; wet[i] = 1; burn[i] = 0; this.steamMap[i] = 0;
        continue;
      }
      const effRain = checkRoof ? incomingRain * shelters.exposureAt(_p.x, _p.y, _p.z) : incomingRain;
      let rate = 0;
      if (fuel[i] > 0 && t > IGNITION && wet[i] < 0.4) {
        rate = 0.055 * (0.35 + 0.65 * Math.min(1, (t - IGNITION) / 320)) * (1 - wet[i] / 0.4) * (0.75 + 0.5 * Math.min(1, lean));
        const burnt = Math.min(fuel[i], rate * fuel0[i] * STEP);
        fuel[i] -= burnt;
        t += (FLAME - t) * Math.min(1, 2.6 * STEP);
        char[i] = Math.max(char[i], 1 - fuel[i] / Math.max(fuel0[i], 1e-4));
        if (fuel[i] <= 1e-4) fuel[i] = 0;
      } else if (t > 180) {
        char[i] = Math.min(1, char[i] + (t - 180) * (fuel0[i] > 0 ? 0.0006 : 0.00025) * STEP * 20);
      }
      burn[i] = rate > 0 ? Math.min(1, rate * 18) : 0;
      if (effRain > 0) {
        wet[i] = Math.min(1, wet[i] + effRain * 0.5 * STEP);
        t -= (t - this.ambient) * effRain * 0.9 * STEP;
      }
      let boiled = 0;
      if (wet[i] > 0 && t > 100) {
        boiled = Math.min(wet[i], (t - 100) * 0.00044 * STEP);
        wet[i] -= boiled;
        t -= boiled * 520;
        if (t < 60) t = 60;
      } else if (wet[i] > 0) {
        wet[i] = Math.max(0, wet[i] - (0.006 + 0.0004 * Math.max(0, t - this.ambient)) * STEP * (1 - effRain));
      }
      this.steamMap[i] = boiled;
      t -= (t - this.ambient) * (0.16 + 0.09 * Math.min(1, lean)) * STEP;
      T[i] = t;
      if (rate > 0) { this.burningList.push(i); burningArea += burn[i]; }
      if (boiled > 0.0015) { this.steamList.push(i); steam += boiled; }
      if (char[i] > 0.3) charred++;
      if (Math.abs(t - this.ambient) > 2 || wet[i] > 0.01) anyHot = true;
    }

    const cell = Math.min(cu, cv);
    const conduct = Math.min(0.022, (0.00095 * STEP) / (cell * cell) * 30);
    for (let v = 0; v < rv; v++) {
      for (let u = 0; u < ru; u++) {
        const i = v * ru + u;
        let acc = 0, radiant = 0;
        for (let dv = -1; dv <= 1; dv++) {
          for (let du = -1; du <= 1; du++) {
            if (!du && !dv) continue;
            const uu = u + du, vv = v + dv;
            if (uu < 0 || vv < 0 || uu >= ru || vv >= rv) continue;
            const j = vv * ru + uu;
            const len = du && dv ? 1.4142 : 1;
            const along = (-du * fx - dv * fy) / len;
            // Extra upward chimney acceleration on vertical/sloped walls.
            const up = (-dv * this.upwardV) / len;
            const bias = Math.max(0.2, 1 + lean * 2.2 * Math.max(0, along) - lean * 0.65 * Math.max(0, -along) + 1.15 * Math.max(0, up));
            acc += (T[j] - T[i]) * bias / len;
            if (burn[j] > 0) radiant += burn[j] * bias * bias / len;
          }
        }
        let t = T[i] + acc * conduct;
        if (radiant > 0 && fuel[i] > 0 && burn[i] === 0) {
          t += radiant * (28 + 64 * Math.min(1.2, lean)) * STEP * (1 - 0.85 * wet[i]);
        }
        T2[i] = Math.min(1400, t);
      }
    }
    this.T = T2;
    this.T2 = T;
    this.intensity = burningArea * cu * cv;
    this.active = anyHot || this.burningList.length > 0;
    this.publish();
    return { charred, steam };
  }

  /** TSL node: vec4(T/1200, char, wetness, burn) sampled at a 3D world position. */
  sample(worldPosition: N): N {
    const rel = worldPosition.sub(vec3(this.origin.x, this.origin.y, this.origin.z));
    const uCoord = dot(rel, vec3(this.tangentU.x, this.tangentU.y, this.tangentU.z)).div(this.width).add(0.5);
    const vCoord = dot(rel, vec3(this.tangentV.x, this.tangentV.y, this.tangentV.z)).div(this.height).add(0.5);
    const dist = abs(dot(rel, vec3(this.normal.x, this.normal.y, this.normal.z)));
    const inside = smoothstep(0.0, 0.015, uCoord)
      .mul(smoothstep(1.0, 0.985, uCoord))
      .mul(smoothstep(0.0, 0.015, vCoord))
      .mul(smoothstep(1.0, 0.985, vCoord))
      .mul(smoothstep(this.thickness, this.thickness * 0.55, dist));
    return texture(this.texture, vec2(uCoord, vCoord).clamp(0.001, 0.999)).mul(inside);
  }

  /**
   * TSL surface shader hook for walls and elevated decks: computes char, glowing ember
   * cracks and wetness in local tangent space so vertical walls never stretch noise.
   */
  shade(albedo: N, worldPosition: N): { color: N; emissive: N; wetness: N; char: N; temperature: N } {
    const rel = worldPosition.sub(vec3(this.origin.x, this.origin.y, this.origin.z));
    const localUV = vec2(
      dot(rel, vec3(this.tangentU.x, this.tangentU.y, this.tangentU.z)),
      dot(rel, vec3(this.tangentV.x, this.tangentV.y, this.tangentV.z)),
    );
    const s = this.sample(worldPosition);
    const grain = valueNoise2(localUV.mul(7.5)).mul(0.6).add(valueNoise2(localUV.mul(23)).mul(0.4));
    const charred = smoothstep(0.18, 0.55, s.y.add(grain.sub(0.5).mul(0.35)));
    const charcoal = vec3(0.022, 0.02, 0.019).mul(mix(0.7, 1.5, grain));
    const wetDark = mix(float(1), float(0.55), s.z);
    const color = mix(albedo.mul(wetDark), charcoal, charred.mul(0.94));
    const cracks = smoothstep(0.5, 0.78, valueNoise2(localUV.mul(31).add(vec2(0, frame.time.mul(-0.45)))));
    const veins = smoothstep(0.42, 0.7, valueNoise2(localUV.mul(13).sub(vec2(0, frame.time.mul(0.6)))));
    const hot = smoothstep(0.24, 0.62, s.x);
    const flicker = valueNoise2(localUV.mul(4).add(frame.time.mul(2.1))).mul(0.5).add(0.6);
    const pattern = max(cracks.mul(charred), veins.mul(s.w).mul(0.8));
    const emissive = blackbody(s.x.mul(0.68)).mul(hot).mul(pattern).mul(flicker).mul(0.6);
    return { color, emissive, wetness: s.z, char: charred, temperature: s.x };
  }

  dispose(): void {
    this.texture.dispose();
  }
}

// ----------------------------------------------------------------------------
// ThermoField (ground grid + multi-elevation 3D surfaces + stacked bodies)
// ----------------------------------------------------------------------------

export class ThermoField implements EngineModule {
  private readonly plume = new WorldSource();
  readonly size: number;
  readonly resolution: number;
  readonly center: THREE.Vector2;
  surfaceY: number;
  /** 0..1 rain intensity (set automatically from `weather` when provided). */
  rain = 0;
  /** Total active burning area across ground + 3D surfaces, for HUDs and mixing. */
  intensity = 0;
  /** Steam produced in the last step (arbitrary units; > 0 while water meets hot ground/surfaces). */
  steam = 0;
  /** Counters for QA and game logic. */
  readonly stats = {
    burningCells: 0,
    charredCells: 0,
    steamEvents: 0,
    ignitions: 0,
    burningSurfaceCells: 0,
    activeSurfaces: 0,
  };
  readonly bodies: ThermalBody[] = [];
  readonly surfaces: ThermalSurface[] = [];

  private T: Float32Array; private T2: Float32Array; private fuel: Float32Array; private fuel0: Float32Array;
  private wet: Float32Array; private char: Float32Array; private burn: Float32Array; private steamMap: Float32Array;
  private pixels: Uint8Array;
  private tex: THREE.DataTexture;
  private accumulator = 0;
  private active = false;
  private ambient = AMBIENT;
  private ambientAt(y: number): number {
    return this.engine.world.climate ? this.engine.world.airTemperatureAt(y) : AMBIENT;
  }
  private burningList: number[] = [];
  private steamList: number[] = [];
  private light: THREE.PointLight;
  private readonly shadowOrigin = new THREE.Vector3();
  private shadowAge = Infinity;
  private fireLight: FireLightHandle;
  private hissCooldown = 0;
  private weather: Weather | null;
  private ocean: Ocean | null;
  private unregister: () => void;

  constructor(private engine: LuminaEngine, private fx: EffectsKit, options: ThermoOptions = {}) {
    this.size = options.size ?? 40;
    this.resolution = options.resolution ?? 96;
    this.center = options.center?.clone() ?? new THREE.Vector2();
    this.surfaceY = options.surfaceY ?? 0;
    this.ambient = this.ambientAt(this.surfaceY);
    this.weather = options.weather ?? null;
    this.ocean = options.ocean ?? null;
    const n = this.resolution * this.resolution;
    this.T = new Float32Array(n).fill(this.ambient); this.T2 = new Float32Array(n).fill(this.ambient);
    this.fuel = new Float32Array(n); this.fuel0 = new Float32Array(n);
    this.wet = new Float32Array(n); this.char = new Float32Array(n); this.burn = new Float32Array(n); this.steamMap = new Float32Array(n);
    this.pixels = new Uint8Array(n * 4);
    this.tex = new THREE.DataTexture(this.pixels, this.resolution, this.resolution, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.generateMipmaps = false;
    this.publish();
    this.light = new THREE.PointLight(0xff8a3c, 0, 48, 1.6);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(256, 256);
    this.light.shadow.camera.near = 0.12;
    this.light.shadow.bias = -0.001;
    this.light.shadow.normalBias = 0.018;
    this.light.shadow.autoUpdate = false;
    engine.scene.add(this.light);
    this.fireLight = fx.addFireLight({
      position: new THREE.Vector3(this.center.x, this.surfaceY + 1.6, this.center.y),
      color: 0xff822e,
      intensity: 0,
      radius: 26,
      flicker: 0.2,
    });
    // All 8 explosion archetypes heat, ignite or quench the 3D field without tight coupling.
    this.unregister = engine.physics.onBlast((center, radius, _impulse, kind) => {
      if (kind === 'petrol') {
        this.addFuel3D(center, radius * 0.32, 1.6);
        this.ignite3D(center, radius * 0.36);
      } else if (kind === 'water') {
        this.quench3D(center, radius * 0.55, 1);
      } else if (kind === 'electrical') {
        this.ignite3D(center, radius * 0.25);
      } else if (kind === 'c4') {
        this.heat3D(center, radius * 0.18, 520);
      } else if (kind === 'thermobaric') {
        this.heat3D(center, radius * 0.45, 760);
        this.ignite3D(center, radius * 0.38);
      } else if (kind === 'incendiary') {
        this.addFuel3D(center, radius * 0.55, 1.4);
        this.ignite3D(center, radius * 0.48);
      } else if (kind === 'airburst') {
        this.heat3D(center, radius * 0.42, 460);
      } else if (kind === 'magma') {
        this.addFuel3D(center, radius * 0.38, 2.2);
        this.heat3D(center, radius * 0.45, 980);
        this.ignite3D(center, radius * 0.36);
      }
    });
  }

  // ---- addressing ---------------------------------------------------------------

  private cellSize(): number { return this.size / this.resolution; }
  private index(x: number, z: number): number {
    const u = (x - this.center.x) / this.size + 0.5, v = (z - this.center.y) / this.size + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1;
    return Math.floor(v * this.resolution) * this.resolution + Math.floor(u * this.resolution);
  }
  private worldOf(i: number, out: THREE.Vector3): THREE.Vector3 {
    const r = this.resolution;
    return out.set(((i % r) + 0.5) / r * this.size - this.size / 2 + this.center.x, this.surfaceY, (Math.floor(i / r) + 0.5) / r * this.size - this.size / 2 + this.center.y);
  }
  private forDisc(x: number, z: number, radius: number, fn: (i: number, falloff: number) => void): void {
    const r = this.resolution, cell = this.cellSize();
    const cu = (x - this.center.x) / this.size * r + r / 2, cv = (z - this.center.y) / this.size * r + r / 2;
    const span = Math.ceil(radius / cell);
    for (let v = Math.max(0, Math.floor(cv - span)); v <= Math.min(r - 1, Math.ceil(cv + span)); v++) {
      for (let u = Math.max(0, Math.floor(cu - span)); u <= Math.min(r - 1, Math.ceil(cu + span)); u++) {
        const d = Math.hypot(u + 0.5 - cu, v + 0.5 - cv) * cell;
        if (d <= radius) fn(v * r + u, 1 - d / Math.max(radius, 1e-3));
      }
    }
  }

  // ---- authoring / gameplay API (2D ground + 3D multi-elevation) ----------------

  /** Lay fuel in a ground disc (kg/m²): 0.5 dry grass, 2–4 timber decking, 1.5 a petrol film. */
  addFuel(x: number, z: number, radius: number, amount: number): void {
    this.forDisc(x, z, radius, (i) => { this.fuel[i] += amount; this.fuel0[i] = Math.max(this.fuel0[i], this.fuel[i]); });
  }

  /** Lay fuel in an axis-aligned ground rectangle (a boardwalk, a field). */
  addFuelRect(minX: number, minZ: number, maxX: number, maxZ: number, amount: number): void {
    const r = this.resolution;
    for (let v = 0; v < r; v++) for (let u = 0; u < r; u++) {
      this.worldOf(v * r + u, _p);
      if (_p.x >= minX && _p.x <= maxX && _p.z >= minZ && _p.z <= maxZ) { const i = v * r + u; this.fuel[i] += amount; this.fuel0[i] = Math.max(this.fuel0[i], this.fuel[i]); }
    }
  }

  /** Lay fuel across ground AND any 3D surfaces inside a sphere. */
  addFuel3D(position: THREE.Vector3, radius: number, amount: number): void {
    if (Math.abs(position.y - this.surfaceY) <= radius + 1.5) {
      this.addFuel(position.x, position.z, radius, amount);
    }
    for (const surf of this.surfaces) surf.addFuelWorld(position, radius, amount);
  }

  /** Raise a ground disc to flame temperature (a match, a flare, a spark). */
  ignite(x: number, z: number, radius = 0.8): void {
    this.forDisc(x, z, radius, (i, k) => { this.T[i] = Math.max(this.T[i], IGNITION + 420 * (0.4 + 0.6 * k)); this.wet[i] *= 0.3; });
    this.active = true;
    this.stats.ignitions++;
  }

  /** Raise ground, 3D wall/deck surfaces and stacked bodies inside a 3D sphere to flame temperature. */
  ignite3D(position: THREE.Vector3, radius = 1.0): void {
    let any = false;
    const dy = Math.abs(position.y - this.surfaceY);
    if (dy <= radius + 1.2) {
      const r2d = Math.sqrt(Math.max(0.25, (radius + 1.2) ** 2 - dy * dy));
      this.forDisc(position.x, position.z, Math.min(radius, r2d), (i, k) => {
        this.T[i] = Math.max(this.T[i], IGNITION + 420 * (0.4 + 0.6 * k));
        this.wet[i] *= 0.3;
      });
      any = true;
    }
    for (const surf of this.surfaces) {
      if (surf.igniteWorld(position, radius)) any = true;
    }
    for (const body of this.bodies) {
      if (body.spent) continue;
      const bp = body.options.object.getWorldPosition(_p);
      const d = bp.distanceTo(position);
      if (d <= radius + body.radius) {
        const k = 1 - d / Math.max(radius + body.radius, 1e-3);
        body.temperature = Math.max(body.temperature, IGNITION + 380 * (0.35 + 0.65 * k));
        any = true;
      }
    }
    if (any) {
      this.active = true;
      this.stats.ignitions++;
    }
  }

  /** Add heat to ground (°C at the centre, falling off to the edge). */
  heat(x: number, z: number, radius: number, degrees: number): void {
    this.forDisc(x, z, radius, (i, k) => { this.T[i] = Math.min(1400, this.T[i] + degrees * k); });
    this.active = true;
  }

  /** Add heat across ground, 3D surfaces and stacked bodies inside a 3D sphere. */
  heat3D(position: THREE.Vector3, radius: number, degrees: number): void {
    const dy = Math.abs(position.y - this.surfaceY);
    if (dy <= radius + 1.5) {
      const vertFade = Math.max(0, 1 - dy / (radius + 1.5));
      this.forDisc(position.x, position.z, radius, (i, k) => {
        this.T[i] = Math.min(1400, this.T[i] + degrees * k * vertFade);
      });
    }
    for (const surf of this.surfaces) surf.heatWorld(position, radius, degrees);
    for (const body of this.bodies) {
      if (body.spent) continue;
      const bp = body.options.object.getWorldPosition(_p);
      const d = bp.distanceTo(position);
      if (d <= radius + body.radius) {
        const k = Math.max(0, 1 - d / Math.max(radius + body.radius, 1e-3));
        body.temperature = Math.min(1400, body.temperature + degrees * k);
      }
    }
    this.active = true;
  }

  /** Throw water on a ground disc: soaks it and carries heat away (steam where it is hot). */
  quench(x: number, z: number, radius: number, amount = 1): void {
    this.forDisc(x, z, radius, (i, k) => { this.wet[i] = Math.min(1, this.wet[i] + amount * (0.4 + 0.6 * k)); });
    this.active = true;
  }

  /** Throw water in 3D: quenches ground, walls, elevated decks and burning props. */
  quench3D(position: THREE.Vector3, radius: number, amount = 1): void {
    if (Math.abs(position.y - this.surfaceY) <= radius + 2.5) {
      this.quench(position.x, position.z, radius, amount);
    }
    for (const surf of this.surfaces) surf.quenchWorld(position, radius, amount);
    for (const body of this.bodies) {
      if (body.spent) continue;
      const bp = body.options.object.getWorldPosition(_p);
      if (bp.distanceTo(position) <= radius + body.radius) {
        if (body.burning) { body.burning = false; this.emitSteam(bp, body.radius, 0.85 * amount); }
        body.temperature = Math.max(this.ambient, body.temperature - 360 * amount);
      }
    }
    this.active = true;
  }

  /** Register an oriented 3D thermal surface (wall, bulkhead, sloped roof or elevated deck). */
  addSurface(options: ThermalSurfaceOptions): ThermalSurface {
    const surf = new ThermalSurface(options, this.ambientAt(options.position.y));
    this.surfaces.push(surf);
    return surf;
  }

  /** Ergonomic helper to register a vertical wall surface for upward 3D flame spread & charring. */
  addWall(options: ThermalWallOptions): ThermalSurface {
    const normal = options.normal
      ? options.normal.clone().setY(0).normalize()
      : new THREE.Vector3(Math.sin(options.rotationY ?? 0), 0, Math.cos(options.rotationY ?? 0));
    const res = options.resolution ?? 24;
    const aspect = options.height / Math.max(options.width, 0.2);
    return this.addSurface({
      position: options.position,
      normal,
      width: options.width,
      height: options.height,
      resolutionU: res,
      resolutionV: Math.max(8, Math.round(res * THREE.MathUtils.clamp(aspect, 0.5, 2))),
      thickness: options.thickness ?? 0.45,
      fuel: options.fuel,
      name: options.name ?? 'thermal-wall',
    });
  }

  /** Ergonomic helper to register a stacked horizontal deck / shelf / upper floor. */
  addDeck(options: ThermalDeckOptions): ThermalSurface {
    const res = options.resolution ?? 24;
    const aspect = options.depth / Math.max(options.width, 0.2);
    return this.addSurface({
      position: options.position,
      normal: new THREE.Vector3(0, 1, 0),
      tangentU: new THREE.Vector3(1, 0, 0),
      width: options.width,
      height: options.depth,
      resolutionU: res,
      resolutionV: Math.max(8, Math.round(res * THREE.MathUtils.clamp(aspect, 0.5, 2))),
      thickness: options.thickness ?? 0.35,
      fuel: options.fuel,
      name: options.name ?? 'thermal-deck',
    });
  }

  removeSurface(surface: ThermalSurface): void {
    const i = this.surfaces.indexOf(surface);
    if (i >= 0) {
      surface.dispose();
      this.surfaces.splice(i, 1);
    }
  }

  /** Put the fire out everywhere, dry the field and surfaces, and restore burnt fuel and props. */
  reset(): void {
    this.T.fill(this.ambient); this.T2.fill(this.ambient);
    this.fuel.set(this.fuel0);
    this.wet.fill(0); this.char.fill(0); this.burn.fill(0); this.steamMap.fill(0);
    this.burningList.length = 0; this.steamList.length = 0;
    for (const surf of this.surfaces) surf.reset();
    this.intensity = 0; this.steam = 0;
    this.fireLight.setIntensity(0);
    for (const body of this.bodies) {
      body.temperature = this.ambientAt(body.options.object.getWorldPosition(_p).y); body.progress = 0; body.burning = false; body.spent = false;
      body.options.object.visible = true;
      body.options.object.scale.copy(body.baseScale);
      body.options.material?.color.copy(body.baseColor);
      body.options.material?.emissive.setRGB(0, 0, 0);
    }
    this.active = this.bodies.some((b) => b.options.kind === 'ice');
    this.publish();
  }

  temperatureAt(x: number, z: number): number { const i = this.index(x, z); return i < 0 ? this.ambient : this.T[i]; }
  isBurning(x: number, z: number): boolean { const i = this.index(x, z); return i >= 0 && this.burn[i] > 0.02; }
  wetnessAt(x: number, z: number): number { const i = this.index(x, z); return i < 0 ? 0 : this.wet[i]; }
  charAt(x: number, z: number): number { const i = this.index(x, z); return i < 0 ? 0 : this.char[i]; }

  /** Full 3D temperature query across ground (with buoyant plume), all walls/decks and props. */
  temperatureAt3D(x: number, y: number, z: number): number {
    const ambient = this.ambientAt(y);
    let best = ambient;
    const dy = y - this.surfaceY;
    if (dy >= -0.8 && dy <= 5.5) {
      const i = this.index(x, z);
      if (i >= 0) {
        const decay = dy <= 0.4 ? 1 : Math.exp(-dy * 0.38);
        best = Math.max(best, ambient + (this.T[i] - this.ambient) * decay);
      }
    }
    _p.set(x, y, z);
    for (const surf of this.surfaces) {
      const i = surf.indexAtWorld(_p);
      if (i >= 0) best = Math.max(best, surf.T[i]);
    }
    for (const body of this.bodies) {
      if (body.spent) continue;
      body.options.object.getWorldPosition(_p2);
      const reach = body.radius + body.height * 0.5 + 0.6;
      const d = _p.distanceTo(_p2);
      if (d < reach) {
        best = Math.max(best, ambient + (body.temperature - ambient) * (1 - d / reach));
      }
    }
    return best;
  }

  /** Full 3D burning query across ground, walls/decks and props. */
  isBurning3D(x: number, y: number, z: number): boolean {
    if (Math.abs(y - this.surfaceY) <= 0.9 && this.isBurning(x, z)) return true;
    _p.set(x, y, z);
    for (const surf of this.surfaces) {
      if (surf.isBurningAtWorld(_p)) return true;
    }
    for (const body of this.bodies) {
      if (body.burning && body.options.object.getWorldPosition(_p2).distanceTo(_p) <= body.radius + body.height * 0.6) return true;
    }
    return false;
  }

  /** Register a prop that reacts to heat and participates in 3D stacked heat spreading. */
  addBody(options: ThermalBodyOptions): ThermalBody {
    const body = new ThermalBody(options);
    body.temperature = this.ambientAt(options.object.getWorldPosition(_p).y);
    this.bodies.push(body);
    this.active = true;
    return body;
  }

  removeBody(body: ThermalBody): void { const i = this.bodies.indexOf(body); if (i >= 0) this.bodies.splice(i, 1); }

  // ---- shader hooks ----------------------------------------------------------------

  /** vec4(temperature / 1200, char, wetness, burn) at a world XZ node (primary ground field). */
  sample(worldXZ: N): N {
    const uvw = worldXZ.sub(vec2(this.center.x, this.center.y)).div(this.size).add(0.5);
    const inside = smoothstep(0.0, 0.01, uvw.x).mul(smoothstep(1.0, 0.99, uvw.x)).mul(smoothstep(0.0, 0.01, uvw.y)).mul(smoothstep(1.0, 0.99, uvw.y));
    return texture(this.tex, uvw.clamp(0.001, 0.999)).mul(inside);
  }

  /**
   * Apply the primary ground field to a surface: scorch, glowing ember cracks along the
   * burning front and wet darkening. Returns the modified albedo and an emissive term to add.
   */
  surface(albedo: N, worldPosition: N): { color: N; emissive: N; wetness: N } {
    const s = this.sample(worldPosition.xz);
    const grain = valueNoise2(worldPosition.xz.mul(7.5)).mul(0.6).add(valueNoise2(worldPosition.xz.mul(23)).mul(0.4));
    const charred = smoothstep(0.18, 0.55, s.y.add(grain.sub(0.5).mul(0.35)));
    const charcoal = vec3(0.022, 0.02, 0.019).mul(mix(0.7, 1.5, grain));
    const wetDark = mix(float(1), float(0.55), s.z);
    const color = mix(albedo.mul(wetDark), charcoal, charred.mul(0.94));
    const cracks = smoothstep(0.5, 0.78, valueNoise2(worldPosition.xz.mul(31).add(frame.time.mul(0.35))));
    const veins = smoothstep(0.42, 0.7, valueNoise2(worldPosition.xz.mul(13).sub(frame.time.mul(0.5))));
    const hot = smoothstep(0.24, 0.62, s.x);
    const flicker = valueNoise2(worldPosition.xz.mul(4).add(frame.time.mul(2.1))).mul(0.5).add(0.6);
    const pattern = max(cracks.mul(charred), veins.mul(s.w).mul(0.8));
    const emissive = blackbody(s.x.mul(0.66)).mul(hot).mul(pattern).mul(flicker).mul(0.55);
    return { color, emissive, wetness: s.z };
  }

  // ---- simulation -------------------------------------------------------------------

  private step(time: number): void {
    const r = this.resolution, n = r * r, cell = this.cellSize();
    const T = this.T, T2 = this.T2, fuel = this.fuel, fuel0 = this.fuel0, wet = this.wet, char = this.char, burn = this.burn;
    _p.set(this.center.x, this.surfaceY + 1.5, this.center.y);
    this.engine.wind.sample(_p, time, _wind);
    const speed = Math.hypot(_wind.x, _wind.z);
    const wx = speed > 0.01 ? _wind.x / speed : 0, wz = speed > 0.01 ? _wind.z / speed : 0;
    const lean = Math.min(1, speed / 14);
    const rain = this.rain;
    const shelters = this.engine.world.shelters;
    const checkRoof = rain > 0 && shelters.count > 0;
    this.burningList.length = 0;
    this.steamList.length = 0;
    let anyHot = false, burningArea = 0, charred = 0, steam = 0;

    for (let i = 0; i < n; i++) {
      let t = T[i];
      let rate = 0;
      if (fuel[i] > 0 && t > IGNITION && wet[i] < 0.4) {
        rate = 0.055 * (0.35 + 0.65 * Math.min(1, (t - IGNITION) / 320)) * (1 - wet[i] / 0.4) * (0.75 + 0.5 * lean);
        const burnt = Math.min(fuel[i], rate * fuel0[i] * STEP);
        fuel[i] -= burnt;
        t += (FLAME - t) * Math.min(1, 2.6 * STEP);
        char[i] = Math.max(char[i], 1 - fuel[i] / Math.max(fuel0[i], 1e-4));
        if (fuel[i] <= 1e-4) fuel[i] = 0;
      } else if (fuel0[i] > 0 && t > 180) {
        char[i] = Math.min(1, char[i] + (t - 180) * 0.0006 * STEP * 20);
      }
      burn[i] = rate > 0 ? Math.min(1, rate * 18) : 0;
      let cellRain = rain;
      if (checkRoof) {
        this.worldOf(i, _p);
        cellRain *= shelters.exposureAt(_p.x, _p.y, _p.z);
      }
      if (cellRain > 0) {
        wet[i] = Math.min(1, wet[i] + cellRain * 0.5 * STEP);
        t -= (t - this.ambient) * cellRain * 0.9 * STEP;
      }
      let boiled = 0;
      if (wet[i] > 0 && t > 100) {
        boiled = Math.min(wet[i], (t - 100) * 0.00044 * STEP);
        wet[i] -= boiled;
        t -= boiled * 520;
        if (t < 60) t = 60;
      } else if (wet[i] > 0) wet[i] = Math.max(0, wet[i] - (0.006 + 0.0004 * Math.max(0, t - this.ambient)) * STEP * (1 - cellRain));
      this.steamMap[i] = boiled;
      t -= (t - this.ambient) * (0.16 + 0.1 * lean) * STEP;
      T[i] = t;
      if (rate > 0) { this.burningList.push(i); burningArea += burn[i]; }
      if (boiled > 0.0015) { this.steamList.push(i); steam += boiled; }
      if (char[i] > 0.3) charred++;
      if (Math.abs(t - this.ambient) > 2 || wet[i] > 0.01) anyHot = true;
    }

    const conduct = Math.min(0.02, (0.0009 * STEP) / (cell * cell) * 30);
    for (let v = 0; v < r; v++) for (let u = 0; u < r; u++) {
      const i = v * r + u;
      let acc = 0, radiant = 0;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        if (!du && !dv) continue;
        const uu = u + du, vv = v + dv;
        if (uu < 0 || vv < 0 || uu >= r || vv >= r) continue;
        const j = vv * r + uu;
        const len = du && dv ? 1.4142 : 1;
        const along = (-du * wx - dv * wz) / len;
        const bias = 1 + lean * 2.2 * Math.max(0, along) - lean * 0.75 * Math.max(0, -along);
        acc += (T[j] - T[i]) * bias / len;
        if (burn[j] > 0) radiant += burn[j] * bias * bias / len;
      }
      let t = T[i] + acc * conduct;
      if (radiant > 0 && fuel[i] > 0 && burn[i] === 0) t += radiant * (26 + 60 * lean) * STEP * (1 - 0.85 * wet[i]);
      T2[i] = Math.min(1400, t);
    }
    this.T = T2; this.T2 = T;

    const waterLevel = this.ocean ? this.ocean.waterLevel : null;
    if (waterLevel !== null && this.surfaceY < waterLevel) {
      this.T.fill(this.ambient); this.wet.fill(1); this.burn.fill(0);
    }

    // ---- multi-elevation 3D surface coupling & stepping ----------------------------
    let surfaceBurning = 0, activeSurfaces = 0, surfaceIntensity = 0;
    if (this.surfaces.length > 0) {
      this.coupleSurfaces3D(_wind);
      for (const surf of this.surfaces) {
        if (!surf.active && rain <= 0) continue;
        const res = surf.step(_wind, rain, waterLevel, shelters);
        charred += res.charred;
        steam += res.steam;
        surfaceBurning += surf.burningList.length;
        surfaceIntensity += surf.intensity;
        if (surf.active) activeSurfaces++;
      }
    }

    this.stats.burningCells = this.burningList.length;
    this.stats.burningSurfaceCells = surfaceBurning;
    this.stats.activeSurfaces = activeSurfaces;
    this.stats.charredCells = charred;
    this.intensity = burningArea * cell * cell + surfaceIntensity;
    this.steam = steam;
    if (steam > 0.01) this.stats.steamEvents++;

    this.stepBodies3D(lean, _wind);
    this.active = anyHot
      || this.burningList.length > 0
      || activeSurfaces > 0
      || this.bodies.some((b) => !b.spent && (b.options.kind === 'ice' || b.temperature > this.ambient + 3));
    this.publish();
  }

  /**
   * Bidirectional 3D buoyant/radiant heat exchange between:
   *  - Ground burning cells → walls & elevated decks above/adjacent
   *  - Burning walls/decks → ground below & other stacked decks/walls above
   */
  private coupleSurfaces3D(wind: THREE.Vector3): void {
    const plumeDriftX = wind.x * 0.14;
    const plumeDriftZ = wind.z * 0.14;

    // 1. Ground burning cells → rising buoyant heat into walls and elevated decks.
    if (this.burningList.length > 0) {
      const stride = Math.max(1, Math.floor(this.burningList.length / 48));
      for (let k = 0; k < this.burningList.length; k += stride) {
        const gi = this.burningList[k];
        this.worldOf(gi, _p);
        const strength = this.burn[gi];
        for (const surf of this.surfaces) {
          const dy = surf.origin.y - _p.y;
          if (dy < -surf.height * 0.6 - 1.5 || dy > surf.height * 0.6 + 5.0) continue;
          // Shift sampling point slightly downwind with elevation for realistic buoyant plume rise.
          const h = Math.max(0, dy);
          _p2.set(_p.x + plumeDriftX * h, Math.max(_p.y, surf.origin.y - surf.height * 0.5), _p.z + plumeDriftZ * h);
          const reach = 1.35 + h * 0.25;
          if (surf.heatWorld(_p2, reach, (175 + 90 * strength) * STEP * Math.exp(-h * 0.22))) {
            surf.active = true;
          }
        }
      }
    }

    // 2. Burning 3D surface cells → ground below & higher/adjacent 3D surfaces.
    for (let si = 0; si < this.surfaces.length; si++) {
      const src = this.surfaces[si];
      if (src.burningList.length === 0) continue;
      const stride = Math.max(1, Math.floor(src.burningList.length / 24));
      for (let k = 0; k < src.burningList.length; k += stride) {
        const ci = src.burningList[k];
        src.cellWorld(ci, _p);
        const strength = src.burn[ci];
        // Radiate down to ground if close enough.
        const dyG = _p.y - this.surfaceY;
        if (dyG >= -0.6 && dyG <= 2.4) {
          const gFade = Math.max(0, 1 - Math.abs(dyG) / 2.4);
          this.forDisc(_p.x, _p.z, 1.1, (gi, fall) => {
            this.T[gi] = Math.min(1400, this.T[gi] + 150 * strength * gFade * fall * STEP);
          });
        }
        // Transfer buoyant heat to other stacked decks & adjacent walls.
        for (let sj = 0; sj < this.surfaces.length; sj++) {
          if (si === sj) continue;
          const dst = this.surfaces[sj];
          const dy = dst.origin.y - _p.y;
          if (dy < -2.2 || dy > 5.5) continue;
          const upBoost = dy > 0 ? 1.85 * Math.exp(-dy * 0.28) : 0.65 * Math.exp(dy * 0.9);
          const h = Math.max(0, dy);
          _p2.set(_p.x + plumeDriftX * h, _p.y + Math.min(h, 2.8), _p.z + plumeDriftZ * h);
          if (dst.heatWorld(_p2, 1.55 + h * 0.22, 190 * strength * upBoost * STEP)) {
            dst.active = true;
          }
        }
      }
    }
  }

  /**
   * 3D thermal step for stacked props (crates, drums, steel beams, ice blocks):
   * couples ground plumes, 3D walls/decks AND stacked body-to-body vertical/lateral heat spread.
   */
  private stepBodies3D(lean: number, wind: THREE.Vector3): void {
    const cell = this.cellSize();
    const bodies = this.bodies;
    for (const body of bodies) {
      if (!body.spent) body.options.object.getWorldPosition(body._worldPos);
    }

    for (let bi = 0; bi < bodies.length; bi++) {
      const body = bodies[bi];
      if (body.spent) continue;
      const pos = body._worldPos;
      const ambient = this.ambientAt(pos.y);
      const dyGround = pos.y - this.surfaceY;

      // 1. Ground field (with height-aware rising buoyant plume so upper stacked crates feel flames below!).
      let env = ambient, wetness = 0, flames = 0;
      if (dyGround >= -0.8 && dyGround <= 5.5) {
        // Sample upwind on the ground if elevated, because the hot plume tilts downwind as it rises.
        const h = Math.max(0, dyGround - body.height * 0.5);
        const sx = pos.x - wind.x * h * 0.12;
        const sz = pos.z - wind.z * h * 0.12;
        let gT = ambient, gWet = 0, gBurn = 0;
        this.forDisc(sx, sz, body.radius + cell + h * 0.2, (i) => {
          gT = Math.max(gT, this.T[i]);
          gWet = Math.max(gWet, this.wet[i]);
          gBurn = Math.max(gBurn, this.burn[i]);
        });
        const vertDecay = h <= 0.35 ? 1 : Math.exp(-h * 0.35);
        env = Math.max(env, ambient + (gT - ambient) * vertDecay);
        if (gBurn > 0) {
          flames = Math.max(flames, gBurn * vertDecay);
          env = Math.max(env, ambient + (FLAME * 0.9 - ambient) * vertDecay);
        }
        if (h <= 0.5) wetness = Math.max(wetness, gWet);
      }

      // 2. Nearby 3D walls / stacked decks.
      for (const surf of this.surfaces) {
        if (!surf.active) continue;
        const dist = Math.abs(surf.worldToLocal(pos, _uv));
        if (dist > body.radius + 1.8) continue;
        const sT = surf.temperatureAtWorld(pos);
        if (sT > ambient + 5) {
          const fade = Math.max(0, 1 - dist / (body.radius + 1.8));
          env = Math.max(env, ambient + (sT - ambient) * (0.4 + 0.6 * fade));
          if (surf.isBurningAtWorld(pos)) flames = Math.max(flames, fade);
          if (dist <= body.radius + surf.thickness) wetness = Math.max(wetness, surf.wetnessAtWorld(pos));
        }
      }

      // 3. 3D stacked prop-to-prop convection & radiation (bottom → middle → top stack spread!).
      for (let bj = 0; bj < bodies.length; bj++) {
        if (bi === bj) continue;
        const other = bodies[bj];
        if (other.spent) continue;
        if (!other.burning && other.temperature < 220) continue;
        const op = other._worldPos;
        const dx = pos.x - op.x, dy = pos.y - op.y, dz = pos.z - op.z;
        // Shift plume center slightly downwind when `body` sits above `other`.
        const hAbove = Math.max(0, dy);
        const px = dx - wind.x * hAbove * 0.1;
        const pz = dz - wind.z * hAbove * 0.1;
        const horiz = Math.hypot(px, pz);
        const reachH = body.radius + other.radius + 1.15 + hAbove * 0.25;
        if (horiz > reachH || dy < -(body.height + other.height) * 0.9 || dy > other.height * 2.8 + 2.4) continue;
        const hFactor = Math.max(0, 1 - horiz / reachH);
        // Strong upward convective plume when stacked above a burning prop; moderate lateral radiation; gentler downward.
        const vFactor = dy > 0.15
          ? Math.exp(-dy * 0.28) * 1.15
          : dy >= -0.35
            ? 0.85
            : Math.exp(dy * 0.85) * 0.52;
        const srcTemp = other.burning ? Math.max(other.temperature, FLAME * 0.88) : other.temperature;
        const transfer = Math.min(1, hFactor * vFactor);
        env = Math.max(env, ambient + (srcTemp - ambient) * transfer);
        if (other.burning && transfer > 0.35) flames = Math.max(flames, transfer);
      }

      const under = this.ocean !== null && pos.y < this.ocean.heightAt(pos.x, pos.z);
      if (under) env = 14;
      const shelters = this.engine.world.shelters;
      const localRain = this.rain > 0 && shelters.count ? this.rain * shelters.exposureAt(pos.x, pos.y, pos.z) : this.rain;
      const kind = body.options.kind;

      if (kind === 'metal') {
        const k = env > body.temperature ? 0.5 : 0.045 + 0.06 * lean;
        body.temperature += (env - body.temperature) * k * STEP;
        if (body.temperature > 120 && (localRain > 0.05 || under || wetness > 0.2)) {
          const quench = under ? 6 : localRain * 0.9 + wetness * 0.6;
          this.emitSteam(pos, body.radius, Math.min(1, (body.temperature - 100) / 500) * Math.min(1, quench));
          body.temperature -= (body.temperature - 60) * Math.min(1, quench * STEP * 1.6);
        }
      } else if (kind === 'wood') {
        body.temperature += (env - body.temperature) * 0.36 * STEP;
        if (!body.burning && body.temperature > IGNITION && localRain < 0.7 && !under) {
          body.burning = true;
          this.stats.ignitions++;
        }
        if (body.burning) {
          if (under || localRain > 0.85) { body.burning = false; this.emitSteam(pos, body.radius, 0.8); }
          body.progress = Math.min(1, body.progress + STEP / (body.options.burnTime ?? 26) * (1 - 0.7 * localRain));
          body.temperature = Math.max(body.temperature, 720);
          // Radiate back to ground (if near ground) and to adjacent 3D walls / stacked decks!
          if (dyGround <= body.height + 1.0) {
            this.forDisc(pos.x, pos.z, body.radius + cell, (i) => { this.T[i] = Math.max(this.T[i], 620); });
          }
          for (const surf of this.surfaces) {
            surf.heatWorld(pos, body.radius + 1.15, 360 * STEP);
          }
          if (body.progress >= 1) { body.burning = false; body.spent = true; body.onSpent?.(); }
        }
      } else {
        // Ice: every degree above freezing melts it; fire & stacked hot props melt it rapidly.
        const melt = Math.max(0, env) * 0.00042 * STEP * (flames > 0 || env > 200 ? 6 : 1);
        body.progress = Math.min(1, body.progress + melt);
        if (melt > 0 && dyGround <= body.height + 2.5) {
          this.forDisc(pos.x, pos.z, body.radius * (1.1 + body.progress), (i, k) => {
            this.wet[i] = Math.min(1, this.wet[i] + melt * 9 * k);
            this.T[i] -= Math.max(0, this.T[i] - 4) * 0.5 * STEP * k;
          });
        }
        for (const surf of this.surfaces) {
          surf.quenchWorld(pos, body.radius * (1.1 + body.progress), melt * 6);
        }
        if (env > 160) this.emitSteam(pos, body.radius, 0.35);
        if (body.progress >= 1) { body.spent = true; body.onSpent?.(); }
      }
    }
  }

  private emitSteam(position: THREE.Vector3, radius: number, strength: number): void {
    if (strength <= 0.02) return;
    const mist = this.fx.mist;
    mist.emit({ position: { x: position.x, y: position.y + 0.3, z: position.z }, radius: radius * 0.8, velocity: { x: 0, y: 2.2 + 2 * strength, z: 0 }, spread: 0.7, life: 2.6, lifeJitter: 0.5, size: 0.5, sizeEnd: 2.2 + 1.8 * strength, count: Math.ceil(mist.capacity * 0.004 * strength) });
    this.hiss(position, strength);
  }

  private hiss(position: THREE.Vector3, strength: number): void {
    if (this.hissCooldown > 0 || strength < 0.15) return;
    this.hissCooldown = 0.7 + Math.random() * 0.5;
    this.stats.steamEvents++;
    this.engine.events.emit('steam', { position: [position.x, position.y, position.z], intensity: Math.min(1, strength) });
  }

  private publish(): void {
    const n = this.resolution * this.resolution, px = this.pixels;
    for (let i = 0; i < n; i++) {
      px[i * 4] = Math.max(0, Math.min(255, (this.T[i] / T_SCALE) * 255));
      px[i * 4 + 1] = this.char[i] * 255;
      px[i * 4 + 2] = this.wet[i] * 255;
      px[i * 4 + 3] = this.burn[i] * 255;
    }
    this.tex.needsUpdate = true;
  }

  /** Exchange heat and moisture with swept emitters, including their far endpoints. */
  private receiveWeather():void{
    const bus=this.engine.world,scale=this.resolution/this.size,half=this.resolution*0.5;
    for(let k=0;k<bus.sourceCount;k++){
      const s=bus.sourceAt(k);
      if((!s.heat&&!s.wetness)||bus.ownedBy(k,this.plume))continue;
      const a=s.start,b=s.end,r=s.radius;
      const minX=Math.min(a.x,b.x)-r,maxX=Math.max(a.x,b.x)+r;
      const minY=Math.min(a.y,b.y)-r,maxY=Math.max(a.y,b.y)+r;
      const minZ=Math.min(a.z,b.z)-r,maxZ=Math.max(a.z,b.z)+r;
      if(minY<this.surfaceY&&maxY>this.surfaceY){
        const x0=Math.max(0,Math.floor((minX-this.center.x)*scale+half)),x1=Math.min(this.resolution-1,Math.ceil((maxX-this.center.x)*scale+half));
        const z0=Math.max(0,Math.floor((minZ-this.center.y)*scale+half)),z1=Math.min(this.resolution-1,Math.ceil((maxZ-this.center.y)*scale+half));
        for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){
          const i=z*this.resolution+x;this.worldOf(i,_p);
          const w=bus.weightAt(k,_p.x,_p.y,_p.z)*STEP;
          if(w<=0)continue;
          this.T[i]=Math.max(-80,Math.min(1400,this.T[i]+s.heat*w*0.45));
          this.wet[i]=Math.max(0,Math.min(1,this.wet[i]+s.wetness*w*0.65));this.active=true;
        }
      }
      for(const patch of this.surfaces){
        const o=patch.origin,reach=(patch.width+patch.height)*0.5;
        if(o.x+reach<minX || o.x-reach>maxX || o.y+reach<minY || o.y-reach>maxY || o.z+reach<minZ || o.z-reach>maxZ)continue;
        for(let i=0;i<patch.T.length;i++){
          patch.cellWorld(i,_p);const w=bus.weightAt(k,_p.x,_p.y,_p.z)*STEP;
          if(w<=0)continue;
          patch.T[i]=Math.max(-80,Math.min(1400,patch.T[i]+s.heat*w*0.45));
          patch.wet[i]=Math.max(0,Math.min(1,patch.wet[i]+s.wetness*w*0.65));
          patch.active=this.active=true;
        }
      }
      for(const body of this.bodies){
        if(body.spent)continue;
        body.options.object.getWorldPosition(_p);
        const w=bus.weightAt(k,_p.x,_p.y,_p.z)*STEP;
        if(w<=0)continue;
        body.temperature=Math.min(1400,Math.max(this.ambient,body.temperature+(s.heat*0.45-200*s.wetness)*w));
        if(body.burning&&body.temperature<IGNITION)body.burning=false;
        this.active=true;
      }
    }
  }

  update(dt: number, time: number): void {
    const ambient = this.ambientAt(this.surfaceY);
    if (ambient !== this.ambient) {
      this.ambient = ambient;
      this.active = true;
    }
    for (const surface of this.surfaces) {
      const temperature = this.ambientAt(surface.origin.y);
      if (temperature !== surface.ambient) {
        surface.ambient = temperature;
        surface.active = this.active = true;
      }
    }
    if (this.weather || this.engine.world.cloudBase < Infinity) this.rain = this.weather?.params.rain ?? this.engine.world.rainfall;
    this.hissCooldown -= dt;
    if (this.active || this.rain > 0 || this.engine.world.sourceCount > 0) {
      this.accumulator = Math.min(this.accumulator + dt, STEP * 3);
      while (this.accumulator >= STEP) {
        this.receiveWeather();
        if(this.active || this.rain>0) this.step(time);
        this.accumulator-=STEP;
      }
    }
    this.present(dt);
  }

  /** Per-frame effects: 3D flames, smoke, steam, HDR local fire light and body appearance. */
  private present(dt: number): void {
    const { fx, engine } = this;
    const cell = this.cellSize();
    const burning = this.burningList;
    let cx = 0, cy = 0, cz = 0, cCount = 0;

    if ((burning.length || this.stats.burningSurfaceCells > 0) && dt > 0) {
      engine.wind.sample(_p.set(this.center.x, this.surfaceY + 1, this.center.y), engine.time, _wind);
    }

    if (burning.length && dt > 0) {
      const emitters = Math.min(6, Math.ceil(burning.length / 5));
      const share = Math.min(1, burning.length / 140);
      for (let e = 0; e < emitters; e++) {
        const i = burning[Math.floor(Math.random() * burning.length)];
        this.worldOf(i, _p);
        cx += _p.x; cy += this.surfaceY + 1.6; cz += _p.z; cCount++;
        const strength = this.burn[i];
        fx.fire.emitRate(`thermo${e}`, (fx.fire.capacity / 22) * (0.25 + 0.75 * share) * strength, dt, {
          position: { x: _p.x, y: this.surfaceY + 0.15, z: _p.z }, radius: cell * 1.6,
          velocity: { x: _wind.x * 0.22, y: 2.4 + 1.6 * strength, z: _wind.z * 0.22 }, spread: 0.9, life: 0.85, lifeJitter: 0.5,
          size: 0.55, sizeEnd: 1.5 + strength, temperature: 0.95,
        });
        fx.smoke.emitRate(`thermoS${e}`, (fx.smoke.capacity / 60) * (0.3 + 0.7 * share), dt, {
          position: { x: _p.x, y: this.surfaceY + 1.4, z: _p.z }, radius: cell * 2,
          velocity: { x: _wind.x * 0.3, y: 3.2, z: _wind.z * 0.3 }, spread: 0.8, life: 4.5, lifeJitter: 0.4, size: 0.9, sizeEnd: 4.2, temperature: 0.35,
        });
      }
      if (Math.random() < dt * 0.5) {
        fx.heatHaze(_p.set(cx / Math.max(cCount, 1), this.surfaceY + 1.5, cz / Math.max(cCount, 1)), 2.2 + 3 * share, 0.8, 2.5, 1.6, 0.16);
      }
    }

    // 3D wall & elevated deck flames, smoke and steam.
    for (let si = 0; si < this.surfaces.length; si++) {
      const surf = this.surfaces[si];
      const sb = surf.burningList;
      if (sb.length && dt > 0) {
        const emitters = Math.min(4, Math.ceil(sb.length / 4));
        const share = Math.min(1, sb.length / 48);
        const sCell = Math.min(surf.cellSizeU(), surf.cellSizeV());
        for (let e = 0; e < emitters; e++) {
          const ci = sb[Math.floor(Math.random() * sb.length)];
          surf.cellWorld(ci, _p);
          _p.addScaledVector(surf.normal, 0.12);
          cx += _p.x; cy += _p.y + 0.8; cz += _p.z; cCount++;
          const strength = surf.burn[ci];
          fx.fire.emitRate(`tsf${si}_${e}`, (fx.fire.capacity / 28) * (0.25 + 0.75 * share) * strength, dt, {
            position: { x: _p.x, y: _p.y, z: _p.z }, radius: sCell * 1.4,
            velocity: { x: _wind.x * 0.18 + surf.normal.x * 0.8, y: 2.8 + 1.8 * strength, z: _wind.z * 0.18 + surf.normal.z * 0.8 },
            spread: 0.75, life: 0.75, lifeJitter: 0.45, size: 0.48, sizeEnd: 1.35 + strength, temperature: 0.96,
          });
          fx.smoke.emitRate(`tss${si}_${e}`, (fx.smoke.capacity / 85) * (0.3 + 0.7 * share), dt, {
            position: { x: _p.x, y: _p.y + 0.9, z: _p.z }, radius: sCell * 1.8,
            velocity: { x: _wind.x * 0.25 + surf.normal.x * 0.6, y: 3.4, z: _wind.z * 0.25 + surf.normal.z * 0.6 },
            spread: 0.7, life: 4.2, lifeJitter: 0.4, size: 0.8, sizeEnd: 3.6, temperature: 0.35,
          });
        }
        if (Math.random() < dt * 0.35) {
          fx.heatHaze(_p.set(surf.origin.x, surf.origin.y + 0.6, surf.origin.z), 1.8 + 2.2 * share, 0.72, 2.2, 1.8, 0.14);
        }
      }
      if (surf.steamList.length && dt > 0) {
        const count = Math.min(2, surf.steamList.length);
        for (let e = 0; e < count; e++) {
          const ci = surf.steamList[Math.floor(Math.random() * surf.steamList.length)];
          surf.cellWorld(ci, _p);
          const strength = Math.min(1, surf.steamMap[ci] * 60);
          fx.mist.emitRate(`tsm${si}_${e}`, (fx.mist.capacity / 40) * Math.min(1, surf.steamList.length / 20), dt, {
            position: { x: _p.x, y: _p.y + 0.2, z: _p.z }, radius: 0.5,
            velocity: { x: _wind.x * 0.15 + surf.normal.x * 0.5, y: 2.4 + 1.5 * strength, z: _wind.z * 0.15 + surf.normal.z * 0.5 },
            spread: 0.5, life: 2.5, lifeJitter: 0.4, size: 0.45, sizeEnd: 2.2,
          });
        }
      }
    }

    // Body appearance & burning prop flames (also contribute to 3D fire-light centroid).
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const body = this.bodies[bi];
      const { material, object, kind } = body.options;
      if (kind === 'ice') {
        const k = 1 - body.progress;
        object.scale.set(body.baseScale.x * (0.35 + 0.65 * Math.sqrt(k)), body.baseScale.y * Math.max(0.001, k), body.baseScale.z * (0.35 + 0.65 * Math.sqrt(k)));
        object.visible = !body.spent;
        continue;
      }
      if (kind === 'wood' && body.burning && dt > 0) {
        const p = object.getWorldPosition(_p);
        cx += p.x; cy += p.y + body.height * 0.6; cz += p.z; cCount++;
        fx.fire.emitRate(`body${bi}`, fx.fire.capacity / 40, dt, {
          position: { x: p.x, y: p.y + body.height * 0.3, z: p.z }, radius: body.radius * 0.9,
          velocity: { x: _wind.x * 0.2, y: 2.6, z: _wind.z * 0.2 }, spread: 0.8, life: 0.8, lifeJitter: 0.5, size: 0.5, sizeEnd: 1.4, temperature: 0.95,
        });
      }
      if (!material) continue;
      if (kind === 'wood') {
        material.color.copy(body.baseColor).lerp(_c.setRGB(0.03, 0.027, 0.025), Math.min(1, body.progress * 1.5));
        glowColor(body.burning ? 620 + 160 * Math.sin(this.engine.time * 9 + body.radius * 50) : Math.min(body.temperature, 560), material.emissive);
        material.emissiveIntensity = body.burning ? 0.9 : 0.5;
      } else {
        glowColor(body.temperature, material.emissive);
        material.emissiveIntensity = 2.2;
        material.color.copy(body.baseColor).lerp(_c.setRGB(0.16, 0.15, 0.17), Math.min(1, Math.max(0, body.temperature - 300) / 500));
      }
    }

    const anyBurning = cCount > 0;
    if (anyBurning) {
      const lx = cx / cCount, ly = cy / cCount, lz = cz / cCount;
      const plume=this.plume.at(lx,ly,lz);
      plume.end.y+=2; plume.radius=2.2+Math.sqrt(this.stats.burningCells+this.stats.burningSurfaceCells)*this.cellSize()*0.28;
      plume.heat=60+180*this.intensity; plume.lift=Math.min(5,1+this.intensity*2);
      this.engine.world.publish(plume,0.25);
      this.light.position.set(lx, ly, lz);
      this.shadowAge += dt;
      if (this.shadowAge >= 0.25 || this.light.position.distanceToSquared(this.shadowOrigin) > 0.36) {
        this.light.shadow.needsUpdate = true;
        this.shadowOrigin.copy(this.light.position);
        this.shadowAge = 0;
      }
      this.fireLight.setPosition(lx, ly, lz);
    }
    const fireScale = Math.min(1, (this.intensity + (anyBurning ? 3 : 0)) / 30);
    const target = anyBurning ? (18 + 70 * fireScale) * (0.82 + 0.3 * Math.random()) : 0;
    this.light.intensity += (target - this.light.intensity) * Math.min(1, dt * 9);
    this.fireLight.setIntensity(anyBurning ? 6 + 22 * fireScale : 0);
    this.fireLight.setRadius(14 + 20 * fireScale);

    // Steam from wet ground on hot cells.
    const steamCells = this.steamList;
    if (steamCells.length && dt > 0) {
      const count = Math.min(4, steamCells.length);
      for (let e = 0; e < count; e++) {
        const i = steamCells[Math.floor(Math.random() * steamCells.length)];
        this.worldOf(i, _p);
        const strength = Math.min(1, this.steamMap[i] * 60);
        fx.mist.emitRate(`steam${e}`, (fx.mist.capacity / 26) * (0.3 + 0.7 * Math.min(1, steamCells.length / 60)), dt, {
          position: { x: _p.x, y: this.surfaceY + 0.2, z: _p.z }, radius: cell * 1.8,
          velocity: { x: _wind.x * 0.15, y: 2.4 + 1.8 * strength, z: _wind.z * 0.15 }, spread: 0.6, life: 2.8, lifeJitter: 0.5, size: 0.5, sizeEnd: 2.6,
        });
      }
      this.hiss(_p, Math.min(1, this.steam * 2 + 0.2));
    }

  }

  dispose(): void {
    this.engine.world.removeSource(this.plume);
    this.unregister();
    this.fireLight.remove();
    this.light.removeFromParent();
    this.light.dispose();
    this.tex.dispose();
    for (const surf of this.surfaces) surf.dispose();
    this.surfaces.length = 0;
  }
}
