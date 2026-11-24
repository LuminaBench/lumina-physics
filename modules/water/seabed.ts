/**
 * Bathymetry + seabed.
 *
 * `Bathymetry` owns the depth map used for shoaling, shoreline breakers, Beer–Lambert
 * optics and the tsunami's Green's-law amplification, and builds the visible seabed /
 * island mesh: rippled sand with refractive wave caustics that are strictly attenuated
 * by depth, plus wet darkened sand in the swash zone above the waterline.
 */
import * as THREE from 'three/webgpu';
import { seabedGeometry } from './bed-mesh';
import { perturbNormalHeight } from '../../engine/shading';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { swashPhaseNode } from './shore-breaker';
import { valueNoise2, mulberry32 } from '../../engine/noise';

const { Fn, If, float, vec2, vec3, uniform, texture, positionWorld, exp, max, min, mix, smoothstep, pow, normalWorld, sin, dot, normalize } = TSL;

export type HeightFunction = (x: number, z: number) => number;

export interface BathymetryOptions {
  /** World extent (metres) covered by the depth map, centred on `center`. */
  size: number;
  center?: THREE.Vector2;
  /** Depth-map resolution. */
  resolution?: number;
  /** Seabed / terrain height relative to mean sea level (negative = under water). */
  height: HeightFunction;
  /** E-folding time for exposed sand to drain after the tide falls (seconds). Zero drains immediately. */
  shoreDryingSeconds?: number;
  /** Optional terrain mesh in local metres with an RGB terrainColor attribute. Ownership transfers to the bed. */
  geometry?: THREE.BufferGeometry;
  shadeTerrain?: (material: THREE.MeshStandardNodeMaterial, waterColor: N, shore: N, wet: N, damp: N, relief: N) => void;
  /** Visible mesh tessellation. */
  segments?: number;
}

const snoise = (x: number, z: number) =>
  Math.sin(x * 1.31 + Math.sin(z * 0.93) * 1.7) * 0.5 + Math.sin(z * 1.71 + Math.sin(x * 0.57 + 1.3) * 1.9) * 0.5;

/** A tropical islet with a beach, a shallow turquoise lagoon, a fringing reef and a deep drop-off. */
export function lagoonIsland(centerX = 260, centerZ = 40): HeightFunction {
  return (x, z) => {
    const dx = x - centerX, dz = z - centerZ;
    const angle = Math.atan2(dz, dx);
    const warp = 1 + 0.11 * Math.sin(angle * 3 + 0.7) + 0.06 * Math.sin(angle * 7 + 2.1) + 0.03 * snoise(x * 0.02, z * 0.02);
    const r = Math.hypot(dx, dz) / warp;
    const lerp = THREE.MathUtils.lerp, ss = THREE.MathUtils.smoothstep;
    const hill = 2.6 + 11 * Math.pow(Math.max(0, 1 - r / 90), 1.4) * (0.8 + 0.2 * snoise(x * 0.05, z * 0.05));
    const beach = lerp(hill, -2.3, ss(r, 78, 168));
    const lagoonFloor = -2.3 - 2.4 * ss(r, 168, 290)
      + 0.14 * snoise(x * 0.9, z * 0.33) * ss(r, 150, 200)                                      // sand ripples
      + 1.5 * Math.max(0, snoise(x * 0.045, z * 0.045) - 0.45) * ss(r, 190, 240) * (1 - ss(r, 330, 380)); // patch reefs
    let h = r < 168 ? beach : lagoonFloor;
    // Fringing reef crest, then the wall into the abyss.
    h += 2.7 * Math.exp(-(((r - 400) / 34) ** 2)) * (0.75 + 0.25 * snoise(x * 0.06, z * 0.06));
    if (r > 430) h = lerp(h, -85, 1 - Math.exp(-(r - 430) / 170));
    return h;
  };
}

/** Continuous, periodic sediment fields. Integer wave vectors close the tile at
 * both edges while oblique, independent directions avoid square lattice plateaus.
 * The three channels describe sediment supply, sheltered growth and small stones. */
function sedimentTexture(): THREE.DataTexture {
  const size = 256, random = mulberry32(90281);
  const pixels = new Uint8Array(size * size * 4).fill(255);
  const field = new Float32Array(size * size);
  const sineX = new Float64Array(size), cosineX = new Float64Array(size);
  for (let channel = 0; channel < 3; channel++) {
    field.fill(0);
    let variance = 0;
    for (let band = 0; band < 4; band++) {
      const amplitude = 0.58 ** band;
      for (let wave = 0; wave < 7; wave++) {
        const angle = (wave + random()) * Math.PI / 7;
        const frequency = (3.2 + random() * 2.8) * 2 ** band;
        const kx = Math.round(Math.cos(angle) * frequency), ky = Math.round(Math.sin(angle) * frequency);
        const phase = random() * 2 * Math.PI;
        for (let x = 0; x < size; x++) {
          const a = 2 * Math.PI * kx * x / size + phase;
          sineX[x] = Math.sin(a); cosineX[x] = Math.cos(a);
        }
        for (let y = 0; y < size; y++) {
          const b = 2 * Math.PI * ky * y / size;
          const sy = amplitude * Math.sin(b), cy = amplitude * Math.cos(b);
          for (let x = 0; x < size; x++) field[y * size + x] += sineX[x] * cy + cosineX[x] * sy;
        }
        variance += 0.5 * amplitude * amplitude;
      }
    }
    const scale = 0.205 / Math.sqrt(variance);
    for (let i = 0; i < field.length; i++)
      pixels[4 * i + channel] = Math.round(255 * THREE.MathUtils.clamp(0.5 + scale * field[i], 0, 1));
  }
  const tile = new THREE.DataTexture(pixels, size, size);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.magFilter = THREE.LinearFilter;
  tile.minFilter = THREE.LinearMipmapLinearFilter;
  tile.generateMipmaps = true;
  tile.anisotropy = 4;
  tile.needsUpdate = true;
  return tile;
}

export class Bathymetry {
  readonly size: number;
  readonly center: THREE.Vector2;
  readonly texture: THREE.DataTexture;
  private readonly sediment = sedimentTexture();
  readonly mesh: THREE.Mesh;
  /** Water absorption (1/m, RGB) shared with the ocean so sand tint and water tint agree. */
  readonly absorption = uniform(new THREE.Vector3(0.42, 0.063, 0.019));
  /** Instantaneous sea surface datum in world metres, shared by depth and shore shading. */
  readonly waterLevel = uniform(0);
  /** Highest swash above the instantaneous sea level, in metres. */
  readonly runup = uniform(0);
  readonly wetHighWater = uniform(0);
  shoreDryingSeconds: number;

  /** Rising water wets the beach immediately. On the ebb a damp band survives above the waterline. */
  updateShoreMoisture(dt: number): void {
    const level = this.waterLevel.value;
    const previous = this.wetHighWater.value;
    if (previous === level) return;
    this.wetHighWater.value = level >= previous || this.shoreDryingSeconds <= 0 ? level :
      level + (previous - level) * Math.exp(-Math.max(0, dt) / this.shoreDryingSeconds);
  }
  readonly causticStrength = uniform(1);
  /** Relative sunlight focusing from the active wind sea and residual swell. */
  readonly waveFocusing = uniform(1);
  /** Chromatic dispersion strength for seabed caustics (0 = monochromatic, 1 = physical water). */
  readonly causticDispersion = uniform(1);
  /** Lowers the whole seabed by this many metres (morph a lagoon into open ocean). */
  private uSink = uniform(0);
  private sinkValue = 0;
  private heightFn: HeightFunction;
  private readonly resolution: number;
  private readonly triangleGrid: boolean;
  private shorelineLift: Float32Array | null = null;
  private uCenter: N;

  constructor(options: BathymetryOptions, hooks: { cloudShadow?: (p: N) => N } = {}) {
    this.shoreDryingSeconds = options.shoreDryingSeconds ?? 900;
    if (!Number.isFinite(this.shoreDryingSeconds) || this.shoreDryingSeconds < 0)
      throw new RangeError('shoreDryingSeconds must be finite and nonnegative');
    this.size = options.size;
    this.center = options.center?.clone() ?? new THREE.Vector2();
    this.heightFn = options.height;
    this.triangleGrid = !!options.geometry;
    this.uCenter = uniform(this.center.clone());
    const res = this.resolution = Math.max(2, Math.floor(options.resolution ?? 512));
    const data = new Uint16Array(res * res * 4);
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      const wx = this.center.x + (x / (res - 1) - 0.5) * this.size;
      const wz = this.center.y + (y / (res - 1) - 0.5) * this.size;
      const o = (y * res + x) * 4;
      data[o] = THREE.DataUtils.toHalfFloat(this.heightFn(wx, wz));
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    if (this.triangleGrid) this.packTriangleSlopes(data);
    this.texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.mesh = this.createMesh(options.segments ?? 384, hooks.cloudShadow, options.geometry, options.shadeTerrain);
  }

  /**
   * Bake static coastal terrain into the depth used by waves and optics. The mesh stays
   * independently shaded and visible. Overlapping triangles keep their upper surface.
   * Call after placing the mesh and before moving the coast with setSink().
   */
  addCoast(mesh: THREE.Mesh): void {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry, positions = geometry.getAttribute('position');
    if (!positions?.count) return;
    const res = this.resolution, span = res - 1, scale = span / this.size;
    const lift = this.shorelineLift ??= new Float32Array(res * res);
    const data = this.texture.image.data as Uint16Array;
    const indices = geometry.getIndex();
    const grid = new Float64Array(positions.count * 3);
    const p = new THREE.Vector3();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      p.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld);
      const i = vertex * 3;
      grid[i] = (p.x - this.center.x) * scale + span * 0.5;
      grid[i + 1] = p.y + this.sinkValue;
      grid[i + 2] = (p.z - this.center.y) * scale + span * 0.5;
    }
    const count = indices ? indices.count : positions.count;
    for (let vertex = 0; vertex + 2 < count; vertex += 3) {
      const a = (indices ? indices.getX(vertex) : vertex) * 3;
      const b = (indices ? indices.getX(vertex + 1) : vertex + 1) * 3;
      const c = (indices ? indices.getX(vertex + 2) : vertex + 2) * 3;
      const ax = grid[a], az = grid[a + 2], bx = grid[b], bz = grid[b + 2], cx = grid[c], cz = grid[c + 2];
      const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(det) < 1e-9) continue;
      const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(span, Math.floor(Math.max(ax, bx, cx)));
      const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), z1 = Math.min(span, Math.floor(Math.max(az, bz, cz)));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const u = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / det;
        const v = ((z - az) * (bx - ax) - (x - ax) * (bz - az)) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1.000001) continue;
        const elevation = grid[a + 1] + u * (grid[b + 1] - grid[a + 1]) + v * (grid[c + 1] - grid[a + 1]);
        const i = z * res + x;
        const offset = i * 4, previous = THREE.DataUtils.fromHalfFloat(data[offset]);
        if (elevation <= previous) continue;
        const encoded = THREE.DataUtils.toHalfFloat(elevation);
        data[offset] = encoded;
        lift[i] += THREE.DataUtils.fromHalfFloat(encoded) - previous;
      }
    }
    if (this.triangleGrid) this.packTriangleSlopes(data);
    this.texture.needsUpdate = true;
  }

  /** Store both triangle planes alongside each cell origin for single-tap shader queries. */
  private packTriangleSlopes(data: Uint16Array): void {
    const n = this.resolution;
    for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) {
      const i = 4 * (z * n + x);
      const a = THREE.DataUtils.fromHalfFloat(data[i]), b = THREE.DataUtils.fromHalfFloat(data[i + 4]);
      const c = THREE.DataUtils.fromHalfFloat(data[i + 4*n]), d = THREE.DataUtils.fromHalfFloat(data[i + 4*n + 4]);
      data[i + 1] = THREE.DataUtils.toHalfFloat(b - a);
      data[i + 2] = THREE.DataUtils.toHalfFloat(c - a);
      data[i + 3] = THREE.DataUtils.toHalfFloat(d + a - b - c);
    }
  }

  /** Height of the original bed before overlaid coastal meshes are rasterized. */
  baseHeightAt(x: number, z: number): number { return this.heightFn(x, z) - this.sinkValue; }

  /** CPU seabed height (m, relative to mean sea level). */
  heightAt(x: number, z: number): number {
    let h = this.heightFn(x, z);
    const map = this.shorelineLift;
    if (map) {
      const res = this.resolution, scale = (res - 1) / this.size;
      const gx = (x - this.center.x) * scale + (res - 1) * 0.5;
      const gz = (z - this.center.y) * scale + (res - 1) * 0.5;
      if (gx >= 0 && gx <= res - 1 && gz >= 0 && gz <= res - 1) {
        const ix = Math.min(res - 2, Math.floor(gx)), iz = Math.min(res - 2, Math.floor(gz)), i = iz * res + ix;
        const fx = gx - ix, fz = gz - iz;
        // Keep the analytic base terrain and interpolate only the added relief.
        const a = map[i], b = map[i + 1], c = map[i + res], d = map[i + res + 1];
        h += (a + fx * (b - a)) * (1 - fz) + (c + fx * (d - c)) * fz;
      }
    }
    if (this.triangleGrid) {
      const beyond = Math.max(Math.abs(x - this.center.x), Math.abs(z - this.center.y)) - this.size * 0.5;
      h = THREE.MathUtils.lerp(h, -80, THREE.MathUtils.smoothstep(beyond, 0, 24));
    }
    return h - this.sinkValue;
  }

  /** CPU still-water depth (m, ≥ 0 under water). */
  depthAt(x: number, z: number): number { return this.waterLevel.value - this.heightAt(x, z); }

  /** Sink (or raise) the entire seabed + island. 0 = as authored. */
  setSink(metres: number): void {
    this.sinkValue = metres;
    this.uSink.value = metres;
    this.mesh.position.y = -metres;
    this.mesh.visible = metres < 400;
  }

  get sink(): number { return this.sinkValue; }

  private uvOf(worldXZ: N): N {
    // The height grid samples both endpoints; normalized UV endpoints sit at texel centers.
    return worldXZ.sub(this.uCenter).mul((this.resolution - 1) / (this.resolution * this.size)).add(0.5);
  }

  /** TSL: seabed height at world XZ (explicit LOD → usable in the vertex stage). */
  heightNode(worldXZ: N): N {
    if (this.triangleGrid) {
      const grid = worldXZ.sub(this.uCenter).div(this.size).add(0.5).saturate().mul(this.resolution - 1);
      const cell = grid.floor().min(this.resolution - 2), local = grid.sub(cell);
      const plane = texture(this.texture, cell.add(0.5).div(this.resolution)).level(0);
      const height = plane.r.add(plane.g.mul(local.x)).add(plane.b.mul(local.y))
        .add(plane.a.mul(local.x.add(local.y).sub(1).max(0)));
      // Outside a finite mesh its last dry cliff texel must give way to open water.
      const offset = worldXZ.sub(this.uCenter).abs();
      const beyond = max(offset.x, offset.y).sub(this.size * 0.5);
      return mix(height, -80, smoothstep(0, 24, beyond)).sub(this.uSink);
    }
    return texture(this.texture, this.uvOf(worldXZ)).level(0).r.sub(this.uSink);
  }

  /** Elevation slope of the coast seen from a water vertex. The same terrain
   * height map serves on- and off-screen hills, including sinking bathymetry. */
  reflectedHorizonNode(xz: N, sea: N, eyeXZ: N): N {
    return Fn(() => {
      const delta = xz.sub(eyeXZ), direction = delta.div(TSL.length(delta).max(0.01));
      const origin = this.uvOf(xz), stride = direction.mul((this.resolution - 1) / (this.resolution * this.size));
      const end = origin.add(stride.mul(9 * 1.86 ** 8));
      const intersects = min(origin, end).lessThanEqual(1).all().and(max(origin, end).greaterThanEqual(0).all());
      const horizon = float(0).toVar();
      If(intersects, () => {
        const range = float(9).toVar();
        TSL.Loop(9, () => {
          const st = origin.add(stride.mul(range));
          If(st.greaterThanEqual(0).all().and(st.lessThanEqual(1).all()), () => {
            const elevation = texture(this.texture, st).level(0).r.sub(this.uSink).sub(sea);
            horizon.assign(max(horizon, elevation.div(range)));
          });
          range.mulAssign(1.86);
        });
      });
      return horizon;
    })();
  }

  /** TSL: still-water depth (positive under water). */
  depthNode(worldXZ: N, waterLevel: N | number = this.waterLevel): N {
    return float(waterLevel as any).sub(this.heightNode(worldXZ));
  }

  /**
   * Approximate the footprint of refracted sunlight cast by crossing surface waves.
   * Where neighboring rays converge, the determinant of their horizontal displacement
   * gradient approaches zero. A finite solar disc softens the narrow focus lines.
   */
  private caustics(worldXZ: N, depth: N): N {
    return Fn(() => {
      const t = frame.time;
      const warp = vec2(valueNoise2(worldXZ.mul(0.21).add(t.mul(0.046))),
        valueNoise2(worldXZ.mul(0.18).sub(t.mul(0.038)).add(15))).sub(0.5);
      const q = worldXZ.add(warp.mul(2.7));
      // Accumulate the three independent entries (xx, xz, zz) of the wave curvature.
      const curvature = vec3(0).toVar();
      const wave = (kx: number, kz: number, amplitude: number, phase: number) => {
        const omega = Math.sqrt(9.81 * Math.hypot(kx, kz));
        const crest = sin(dot(q, vec2(kx, kz)).sub(t.mul(omega)).add(phase));
        curvature.addAssign(vec3(kx * kx, kx * kz, kz * kz).mul(crest.mul(amplitude)));
      };
      wave(2.55, 1.12, 0.085, 0.0);
      wave(-1.36, 3.12, 0.044, 1.9);
      wave(3.72, -2.16, 0.020, 3.4);
      wave(0.90, 5.06, 0.008, 0.7);
      // Wavelength-dependent focal distance. RGB paths share the same wave field.
      const dispersion = vec3(-0.012, 0, 0.014).mul(this.causticDispersion).add(1);
      const travel = depth.mul(0.24).add(0.35).min(2.75).mul(dispersion);
      const jacobian = vec3(1).sub(travel.mul(curvature.x)).mul(vec3(1).sub(travel.mul(curvature.z)))
        .sub(travel.mul(curvature.y).pow2());
      const blur = depth.mul(0.006).add(0.065);
      const radiance = vec3(blur).div(TSL.abs(jacobian).add(blur)).pow2().mul(2.7);
      return radiance.mul(exp(depth.mul(-0.16))).mul(smoothstep(0, 0.4, depth));
    })();
  }

  private createMesh(segments: number, cloudShadow?: (p: N) => N, supplied?: THREE.BufferGeometry, shadeTerrain?: BathymetryOptions['shadeTerrain']): THREE.Mesh {
    const geometry = supplied ?? seabedGeometry(this.size, this.center, segments, this.heightFn);
    const material = new THREE.MeshStandardNodeMaterial();
    material.metalness = 0;

    const P = positionWorld;
    const h = P.y;
    const shoreHeight = h.sub(this.waterLevel);
    const depth = max(shoreHeight.negate(), 0);
    const xz = P.xz;
    // Sand waves, rocky substrate and dark eelgrass beds have different
    // length scales. Broad beds can colonize flat sheltered shallows.
    const supply = texture(this.sediment, xz.mul(1 / 141)).toVar();
    const driftUV = vec2(xz.x.mul(0.86).add(xz.y.mul(0.51)), xz.y.mul(0.86).sub(xz.x.mul(0.51)));
    const drift = texture(this.sediment, driftUV.mul(1 / 48).add(supply.rg.mul(0.12))).g.toVar();
    const gravel = texture(this.sediment, xz.mul(1 / 4.9).add(supply.gb.mul(0.24))).b.toVar();
    const shelf = supply.r;
    const grain = gravel.mul(0.35).add(drift.mul(0.65));
    const sand = mix(vec3(0.57,0.46,0.33),vec3(0.86,0.77,0.57),grain);
    const reef = mix(vec3(0.12,0.14,0.105),vec3(0.36,0.30,0.20),gravel);
    const submerged = smoothstep(0.7,2.4,depth);
    const slope = float(1).sub(normalWorld.y).mul(4).clamp(0,1);
    const coarse = shelf.mul(0.72).add(drift.mul(0.28));
    const reefMask = smoothstep(0.64,0.76,coarse.add(slope.mul(0.22))).mul(submerged);
    const meadow = smoothstep(0.52,0.68,coarse).mul(submerged)
      .mul(float(1).sub(smoothstep(6,13,depth))).mul(float(1).sub(slope));
    const patchEdge = mix(float(0.44), float(0.96), smoothstep(0.16,0.84,gravel.add(drift.sub(0.5).mul(0.24))));
    const eelgrass = mix(vec3(0.10,0.16,0.088),vec3(0.27,0.30,0.15),gravel);
    const grass = mix(vec3(0.10,0.17,0.055),vec3(0.26,0.31,0.13),gravel);
    const grassMask = smoothstep(3.2,5.5,h.add(drift.mul(2.5)));
    let albedo:N = mix(mix(mix(sand,eelgrass,meadow.mul(patchEdge)),reef,reefMask),grass,grassMask);

    // Swash zone: sand that the last wave reached stays dark and glossy.
    const swash = Fn(() => {
      const offset = float(0).toVar();
      If(shoreHeight.abs().lessThan(0.35).and(this.runup.greaterThan(0)), () => {
        offset.assign(TSL.sin(swashPhaseNode(xz, frame.time)).mul(this.runup));
      });
      return offset;
    })();
    const grainEdge = shoreHeight.add(gravel.sub(0.5).mul(0.018));
    const wet = smoothstep(0.047, -0.008, grainEdge.sub(swash)).mul(smoothstep(-0.6, -0.03, shoreHeight));
    // The abandoned high-water band holds pore water after its mirror film drains.
    // Grain size and small height variations break up the drying edge.
    const poreHeight = h.sub(this.wetHighWater).add(gravel.sub(0.5).mul(0.13));
    const damp = smoothstep(this.runup.add(0.22), this.runup.mul(0.25), poreHeight)
      .mul(smoothstep(-0.6, 0.02, shoreHeight)).max(wet);
    albedo = albedo.mul(mix(1.0, 0.64, damp)).mul(mix(1.0, 0.78, wet));

    // Under water: sunlight is filtered on the way down (Beer–Lambert) and focused into caustics.
    const sunY = frame.sunDirection.y.clamp(0, 1);
    // Snell's law gives the submerged path length and its entry point at the surface.
    const refractedCos = sunY.pow2().oneMinus().div(1.333 * 1.333).oneMinus().sqrt();
    const pathLength = depth.div(refractedCos);
    const downwelling = exp(this.absorption.mul(pathLength).negate());
    const shadow = cloudShadow ? cloudShadow(P) : float(1);
    // Evaluate refracted ray concentration only in the sunlit shallows.
    const caustic = Fn(() => {
      const c = vec3(0).toVar();
      If(depth.greaterThan(0.02).and(depth.lessThan(18)).and(this.waveFocusing.greaterThan(0)).and(sunY.greaterThan(0)), () => {
        const entryXZ = xz.add(frame.sunDirection.xz.mul(pathLength.div(1.333)));
        c.assign(this.caustics(entryXZ, depth).mul(this.causticStrength).mul(this.waveFocusing)
          .mul(smoothstep(0, 0.48, sunY)).mul(shadow));
      });
      return c;
    })();
    const underwater = smoothstep(0.0, 0.08, depth);
    albedo = albedo.mul(mix(vec3(1), downwelling.mul(vec3(0.78).add(caustic.mul(1.3))), underwater));

    if (!shadeTerrain && supplied?.hasAttribute('terrainColor')) {
      const weights = normalWorld.abs().pow(4.0);
      const strata = texture(this.sediment, P.yz.mul(0.069)).r.mul(weights.x)
        .add(texture(this.sediment, P.xz.mul(0.052)).g.mul(weights.y))
        .add(texture(this.sediment, P.xy.mul(0.069)).r.mul(weights.z))
        .div(weights.x.add(weights.y).add(weights.z).max(0.001));
      const terrain = TSL.attribute('terrainColor', 'vec3').mul(strata.mul(0.56).add(0.74));
      albedo = mix(albedo, terrain, smoothstep(-0.6, 0.9, shoreHeight));
    }
    material.colorNode = albedo;
    material.roughnessNode = mix(mix(float(0.92), float(0.59), damp), float(0.22), wet);
    // Fine ripple relief so grazing sunlight sparkles on dry sand and reads through shallow water.
    const sandPhase = dot(xz,vec2(7.5,2.9)).add(drift.mul(13)).add(supply.b.mul(4));
    const rippleH = sin(sandPhase).mul(0.009).mul(float(1).sub(grassMask.max(meadow).max(reefMask)));
    material.normalNode = perturbNormalHeight(rippleH.add(gravel.mul(0.012)),1.0);
    shadeTerrain?.(material, albedo, shoreHeight, wet, damp, rippleH.add(gravel.mul(0.012)));
    // Under water a cast shadow is filled in by light scattered within the water column:
    // it fades with depth instead of staying a hard black cut-out, which also hides
    // shadow-map filtering noise on the seabed.
    (material as any).receivedShadowNode = Fn(([shadowFactor]: N[]) => {
      const fill = float(1).sub(exp(depth.mul(-0.2))).mul(0.82);
      return shadowFactor.mul(float(1).sub(fill)).add(fill);
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(this.center.x, 0, this.center.y);
    mesh.receiveShadow = true;
    mesh.name = 'lumina-seabed';
    return mesh;
  }

  dispose(): void {
    this.texture.dispose();
    this.sediment.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

export { min as _min };
