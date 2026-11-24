import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { Coastline, shoreSite } from './coastline';
import type { ShoreBreak, LocalWater } from '../water/shore-breaker';

export interface SurfOptions {
  /** Square mapped area in world metres, centred about the origin. */
  size: number;
  resolution?: number;
  /** Optional fine window around a pool or prop. Its boundary receives the surrounding atlas head. */
  detail?: { x: number; z: number; size: number; resolution: number };
  period?: number;
  /** Return the top of an obstruction in world metres, or -Infinity for open ground. */
  barrierAt?: (x: number, z: number) => number;
}

/** Minimum ocean head needed to reach each cell. A priority flood routes around finite barriers. */
function spillHeights(floor: Float32Array, offshore: Uint8Array, n: number) {
  const count = n * n,
    head = new Float32Array(count).fill(Infinity);
  const heap = new Int32Array(count),
    visited = new Uint8Array(count);
  let used = 0;
  function push(id: number, level: number) {
    let i = used++;
    head[id] = level;
    visited[id] = 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (head[heap[parent]] <= level) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = id;
  }
  function visit(i: number, from: number) {
    if (!visited[i]) push(i, Math.max(from, floor[i]));
  }
  for (let i = 0; i < count; i++) if (offshore[i]) push(i, floor[i]);
  while (used > 0) {
    const id = heap[0],
      last = heap[--used],
      value = head[last];
    let i = 0;
    while (2 * i + 1 < used) {
      let c = 2 * i + 1;
      if (c + 1 < used && head[heap[c + 1]] < head[heap[c]]) c++;
      if (head[heap[c]] >= value) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = last;
    const x = id % n,
      h = head[id];
    if (x > 0) visit(id - 1, h);
    if (x + 1 < n) visit(id + 1, h);
    if (id >= n) visit(id - n, h);
    if (id + n < count) visit(id + n, h);
  }
  return head;
}

export class CoastalSurf implements ShoreBreak {
  /** A sheltered basin can retain a different stage from the open shore. */
  localWater?: LocalWater;
  readonly texture: THREE.DataTexture;
  readonly period: number;
  private readonly epoch = TSL.uniform(0);
  setEpoch(seconds: number) {
    if (!Number.isFinite(seconds)) throw new RangeError('Invalid swash epoch');
    this.epoch.value = seconds;
  }
  private readonly samples: Uint16Array;
  private readonly shadows?: Uint8Array;
  private readonly grid: Float32Array;
  private readonly n: number;
  private readonly size: number;
  private readonly omega: number;
  private readonly detail?: CoastalSurf;
  private readonly fineReading = new THREE.Vector4();
  private readonly origin: THREE.Vector2;
  private readonly sample = new THREE.Vector4();
  constructor(
    readonly coast: Coastline,
    options: SurfOptions,
    ground = (x: number, z: number) => coast.height(x, z),
    window?: { x: number; z: number; outer: CoastalSurf },
  ) {
    this.origin = new THREE.Vector2(window?.x ?? 0, window?.z ?? 0);
    this.period = options.period ?? 8.2;
    this.n = options.resolution ?? 192;
    this.size = options.size;
    if (
      !Number.isFinite(this.period) ||
      this.period <= 0 ||
      !Number.isFinite(this.size) ||
      this.size <= 0 ||
      !Number.isInteger(this.n) ||
      this.n < 4 ||
      this.n > 1024
    )
      throw new RangeError('Invalid surf period, extent or resolution');
    this.omega = (2 * Math.PI) / this.period;
    const n = this.n,
      count = n * n,
      floor = new Float32Array(count),
      sea = new Uint8Array(count),
      site = shoreSite();
    if (options.barrierAt) this.shadows = new Uint8Array(count);
    this.samples = new Uint16Array(count * 4);
    this.grid = new Float32Array(count * 4);
    for (let z = 0, i = 0; z < n; z++)
      for (let x = 0; x < n; x++, i++) {
        const wx = (x / (n - 1) - 0.5) * this.size + this.origin.x,
          wz = (z / (n - 1) - 0.5) * this.size + this.origin.y;
        coast.project(wx, wz, site);
        floor[i] = Math.max(ground(wx, wz), options.barrierAt?.(wx, wz) ?? -Infinity);
        const edge = x === 0 || x === n - 1 || z === 0 || z === n - 1;
        if (window && edge) floor[i] = Math.max(floor[i], window.outer.read(wx, wz, this.sample).w);
        sea[i] = Number(edge && (!!window || site.cross < 0));
        // Shorter wavelengths over a shallow bar bend the crest towards the shore.
        this.grid[4 * i] =
          Math.min(site.cross, 0) * 0.21 +
          site.along * 0.018 +
          1.4 * Math.sin(site.along / 35) +
          0.55 * Math.tanh(site.cross / 9);
        this.grid[4 * i + 1] = site.along * 0.052 + Math.min(site.cross, 0) * 0.075;
        let gain = (0.4 + 0.6 * coast.exposure) * (1 - site.shelter * 0.62);
        if (this.shadows && options.barrierAt) {
          // A nearby emergent obstacle interrupts the incident short wave. Open water can still flow around it.
          const pitch = this.size / (n - 1),
            step = Math.max(0.06, Math.min(0.42, pitch));
          for (let k = 1; k <= 8; k++) {
            const distance = k * step,
              sx = wx - site.tangentZ * distance,
              sz = wz + site.tangentX * distance;
            const obstruction = options.barrierAt(sx, sz);
            if (Number.isFinite(obstruction) && obstruction > ground(sx, sz) + 0.04) {
              gain *= 0.17 + (0.69 * (k - 1)) / 8;
              this.shadows[i] = 1;
              break;
            }
          }
        }
        this.grid[4 * i + 2] = gain;
      }
    const spill = spillHeights(floor, sea, n);
    for (let i = 0; i < count; i++) {
      this.grid[4 * i + 3] = Math.min(2048, spill[i]);
      for (let ch = 0; ch < 4; ch++) {
        const k = i * 4 + ch;
        this.samples[k] = THREE.DataUtils.toHalfFloat(this.grid[k]);
        this.grid[k] = THREE.DataUtils.fromHalfFloat(this.samples[k]);
      }
    }
    this.texture = new THREE.DataTexture(this.samples, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    if (options.detail) {
      const { x, z, size, resolution } = options.detail;
      if (![x, z, size, resolution].every(Number.isFinite) || size <= 0 || size >= this.size) {
        this.texture.dispose();
        throw new RangeError('Invalid coastal detail window');
      }
      this.detail = new CoastalSurf(
        coast,
        { size, resolution, period: this.period, barrierAt: options.barrierAt },
        ground,
        { x, z, outer: this },
      );
    }
  }
  private detailWeight(x: number, z: number) {
    const edge = Math.max(Math.abs(x - this.origin.x), Math.abs(z - this.origin.y)) / this.size;
    return 1 - THREE.MathUtils.smoothstep(edge, 0.38, 0.5);
  }
  hasWaveShadow(x: number, z: number): boolean {
    if (this.detail && this.detail.detailWeight(x, z) > 0 && this.detail.hasWaveShadow(x, z)) return true;
    if (!this.shadows) return false;
    x -= this.origin.x;
    z -= this.origin.y;
    const n = this.n,
      ix = THREE.MathUtils.clamp(Math.round((x / this.size + 0.5) * (n - 1)), 0, n - 1);
    const iz = THREE.MathUtils.clamp(Math.round((z / this.size + 0.5) * (n - 1)), 0, n - 1);
    return !!this.shadows[ix + n * iz];
  }
  read(x: number, z: number, out: THREE.Vector4): THREE.Vector4 {
    const wx = x,
      wz = z;
    x -= this.origin.x;
    z -= this.origin.y;
    const n = this.n,
      gx = THREE.MathUtils.clamp((x / this.size + 0.5) * (n - 1), 0, n - 1),
      gz = THREE.MathUtils.clamp((z / this.size + 0.5) * (n - 1), 0, n - 1);
    const ix = Math.min(n - 2, Math.floor(gx)),
      iz = Math.min(n - 2, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz;
    const k = 4 * (iz * n + ix),
      g = this.grid;
    for (let c = 0; c < 4; c++) {
      const a = g[k + c] + u * (g[k + 4 + c] - g[k + c]),
        j = k + 4 * n + c;
      out.setComponent(c, a + v * (g[j] + u * (g[j + 4] - g[j]) - a));
    }
    if (this.detail) {
      const blend = this.detail.detailWeight(wx, wz);
      if (blend > 0) out.lerp(this.detail.read(wx, wz, this.fineReading), blend);
    }
    return out;
  }
  /** Wave displacement relative to local still water; pass the untouched bed depth. */
  offset(x: number, z: number, depth: number, time: number, strength: number, level: number) {
    const exposed = this.localWater ? 1 - this.localWater.weightAt(x,z) : 1;
    if (exposed === 0) return 0;
    const q = this.read(x, z, this.sample);
    if (depth >= 2.4 && level >= q.w + 0.025) return 0;
    time -= this.epoch.value;
    const phase = time * this.omega - q.x;
    const shape = 0.22 + 0.76 * Math.sin(phase) + 0.16 * Math.sin(phase * 2 - 0.65);
    const offset =
      strength *
      q.z *
      (1 - THREE.MathUtils.smoothstep(depth, 1.25, 2.4)) *
      shape *
      (0.87 + 0.13 * Math.sin(q.y - time * 0.19));
    const reach = THREE.MathUtils.smoothstep(level + offset - q.w, -0.035, 0.025);
    return exposed * THREE.MathUtils.lerp(Math.min(offset, -depth - 0.045), offset, reach);
  }
  atlasNode(xz: N): N {
    const local = this.origin.x || this.origin.y ? xz.sub(TSL.vec2(this.origin.x, this.origin.y)) : xz;
    const coarse = TSL.texture(
      this.texture,
      local
        .div(this.size)
        .add(0.5)
        .mul((this.n - 1) / this.n)
        .add(0.5 / this.n),
    ).level(0);
    if (!this.detail) return coarse;
    const d = this.detail,
      offset = xz.sub(TSL.vec2(d.origin.x, d.origin.y)).abs();
    const weight = TSL.smoothstep(0.38, 0.5, TSL.max(offset.x, offset.y).div(d.size)).oneMinus();
    return TSL.mix(coarse, d.atlasNode(xz), weight);
  }
  node(xz: N, depth: N, time: N, strength: N, level: N): N {
    const { Fn, vec2, sin, cos, smoothstep, mix } = TSL;
    time = time.sub(this.epoch);
    return Fn(() => {
      const q = this.atlasNode(xz).toVar(),
        phase = time.mul(this.omega).sub(q.x).toVar();
      const shape = sin(phase)
        .mul(0.76)
        .add(0.22)
        .add(sin(phase.mul(2).sub(0.65)).mul(0.16));
      const offset = shape
        .mul(strength)
        .mul(q.z)
        .mul(smoothstep(1.25, 2.4, depth).oneMinus())
        .mul(
          sin(q.y.sub(time.mul(0.19)))
            .mul(0.13)
            .add(0.87),
        )
        .toVar();
      const reach = smoothstep(-0.035, 0.025, level.add(offset).sub(q.w));
      const wet = depth.add(offset);
      const foam = smoothstep(0.1, 0.63, shape)
        .mul(smoothstep(-0.045, 0.05, wet))
        .mul(smoothstep(0.28, 1.35, wet).oneMinus())
        .mul(cos(phase).mul(0.21).add(0.55))
        .mul(q.z)
        .mul(reach)
        .mul(strength.clamp(0, 1));
      const surface = vec2(mix(offset.min(depth.negate().sub(0.045)), offset, reach), foam);
      return this.localWater ? surface.mul(this.localWater.weightNode(xz).oneMinus()) : surface;
    })();
  }
  dispose() {
    this.detail?.dispose();
    this.texture.dispose();
  }
}
