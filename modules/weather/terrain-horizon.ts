import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface TerrainHorizonOptions {
  /** Square extent in metres, centred at centerX/centerZ. */
  size: number;
  heightAt(x: number, z: number): number;
  centerX?: number;
  centerZ?: number;
  resolution?: number;
  /** The regular terrain grid and its near shadow map cover features smaller than this spacing. */
  reach?: number;
}
const RADIUS = 0.00465;
const clamp = THREE.MathUtils.clamp;

/** Height of the shadow cast by each solar limb, at every receiver column. A moving eye,
 * roof or cloud can rise above a shaded road without rebuilding the cache. */
export class TerrainHorizon {
  readonly resolution: number;
  readonly spacing: number;
  readonly reach: number;
  readonly texture: THREE.DataTexture;
  private readonly ground: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly bounds;
  private readonly range;
  private readonly decode;
  private floor = Infinity;
  private ceiling = -Infinity;
  private lastElevation = NaN;
  private lastAzimuth = NaN;
  private readonly originX: number;
  private readonly originZ: number;

  constructor(readonly options: TerrainHorizonOptions) {
    const n = options.resolution ?? 65;
    this.reach = options.reach ?? options.size;
    if (
      !Number.isInteger(n) ||
      n < 3 ||
      n > 257 ||
      !Number.isFinite(options.size) ||
      options.size <= 0 ||
      !Number.isFinite(this.reach) ||
      this.reach <= 0
    )
      throw new RangeError('Invalid terrain horizon extent or resolution');
    this.resolution = n;
    this.spacing = options.size / (n - 1);
    this.originX = (options.centerX ?? 0) - options.size / 2;
    this.originZ = (options.centerZ ?? 0) - options.size / 2;
    this.ground = new Float32Array(n * n);
    for (let z = 0, i = 0; z < n; z++)
      for (let x = 0; x < n; x++, i++) {
        const h = options.heightAt(this.originX + x * this.spacing, this.originZ + z * this.spacing);
        if (!Number.isFinite(h)) throw new RangeError('Invalid terrain horizon elevation');
        this.ground[i] = h;
        this.floor = Math.min(this.floor, h);
        this.ceiling = Math.max(this.ceiling, h);
      }
    this.floor -= 2;
    this.bounds = TSL.uniform(new THREE.Vector2(this.originX, this.originZ));
    this.range = TSL.uniform(new THREE.Vector2(this.floor, 1));
    this.decode = TSL.vec2((255 * 256) / 65535, 255 / 65535);
    this.bytes = new Uint8Array(n * n * 4);
    this.texture = new THREE.DataTexture(this.bytes, n, n);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }
  private terrain(x: number, z: number) {
    const n = this.resolution,
      ix = Math.min(n - 2, Math.floor(x)),
      iz = Math.min(n - 2, Math.floor(z));
    const u = x - ix,
      v = z - iz,
      i = ix + iz * n,
      h = this.ground;
    return (h[i] * (1 - u) + h[i + 1] * u) * (1 - v) + (h[i + n] * (1 - u) + h[i + n + 1] * u) * v;
  }
  update(sun: THREE.Vector3) {
    const elevation = Math.asin(clamp(sun.y, -1, 1)),
      azimuth = Math.atan2(sun.z, sun.x);
    if (Math.abs(this.lastElevation - elevation) < 0.00018 && Math.abs(this.lastAzimuth - azimuth) < 0.00065)
      return;
    this.lastElevation = elevation;
    this.lastAzimuth = azimuth;
    const n = this.resolution,
      step = this.spacing,
      dx = Math.cos(azimuth),
      dz = Math.sin(azimuth);
    // Below civil twilight the atmospheric direct beam has already vanished. Limiting
    // the ray slope also avoids a singularity when looking straight up at the sun.
    const el = clamp(elevation, -0.12, Math.PI / 2 - 0.006);
    const lowSlope = Math.tan(el - RADIUS),
      highSlope = Math.tan(el + RADIUS);
    const range = Math.max(1, this.ceiling - this.floor + Math.max(0, -lowSlope) * this.reach);
    this.range.value.set(this.floor, range);
    const limit = Math.min(Math.ceil(this.reach / step), Math.ceil(n * Math.SQRT2));
    for (let z = 0, k = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        let shadowEnds = this.floor,
          shadowStarts = this.floor;
        for (let j = 1; j <= limit; j++) {
          const u = x + dx * j,
            v = z + dz * j,
            distance = j * step;
          if (u < 0 || u > n - 1 || v < 0 || v > n - 1 || distance > this.reach) break;
          if (lowSlope > 0 && this.ceiling - distance * lowSlope <= shadowStarts) break;
          const height = this.terrain(u, v);
          shadowStarts = Math.max(shadowStarts, height - distance * highSlope);
          shadowEnds = Math.max(shadowEnds, height - distance * lowSlope);
        }
        const start = Math.round(((shadowStarts - this.floor) * 65535) / range);
        const end = Math.round(((shadowEnds - this.floor) * 65535) / range);
        this.bytes[k++] = start >>> 8;
        this.bytes[k++] = start & 255;
        this.bytes[k++] = end >>> 8;
        this.bytes[k++] = end & 255;
      }
    this.texture.needsUpdate = true;
  }
  private heightAt(i: number, ch: number) {
    return (
      this.floor + ((this.bytes[4 * i + ch] * 256 + this.bytes[4 * i + ch + 1]) * this.range.value.y) / 65535
    );
  }
  private interpolate(i: number, ch: number, fx: number, fz: number) {
    const n = this.resolution;
    return (
      (this.heightAt(i, ch) * (1 - fx) + this.heightAt(i + 1, ch) * fx) * (1 - fz) +
      (this.heightAt(i + n, ch) * (1 - fx) + this.heightAt(i + n + 1, ch) * fx) * fz
    );
  }
  visibilityAt(x: number, y: number, z: number) {
    const u = (x - this.originX) / this.spacing,
      v = (z - this.originZ) / this.spacing,
      n = this.resolution;
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return 1;
    const ix = Math.min(n - 2, Math.floor(u)),
      iz = Math.min(n - 2, Math.floor(v)),
      i = ix + n * iz,
      fx = u - ix,
      fz = v - iz;
    const low = this.interpolate(i, 0, fx, fz),
      high = this.interpolate(i, 2, fx, fz),
      q = clamp((2 * (y - low)) / Math.max(0.0001, high - low) - 1, -1, 1);
    return (Math.acos(-q) + q * Math.sqrt(Math.max(0, 1 - q * q))) / Math.PI;
  }
  visibilityNode(position: N): N {
    const st = position.xz.sub(this.bounds).div(this.options.size);
    const n = this.resolution;
    const tap = TSL.texture(this.texture, st.mul((n - 1) / n).add(0.5 / n))
      .level(0)
      .toVar();
    const low = TSL.dot(tap.rg, this.decode).mul(this.range.y).add(this.range.x);
    const high = TSL.dot(tap.ba, this.decode).mul(this.range.y).add(this.range.x);
    const q = position.y.sub(low).mul(2).div(high.sub(low).max(0.0001)).sub(1).clamp(-1, 1);
    const visible = TSL.acos(q.negate())
      .add(q.mul(TSL.sqrt(TSL.max(0, TSL.float(1).sub(q.mul(q))))))
      .div(Math.PI);
    return TSL.select(st.greaterThanEqual(0).all().and(st.lessThanEqual(1).all()), visible, TSL.float(1));
  }
  dispose() {
    this.texture.dispose();
  }
}
