/**
 * Shared noise toolkit: TSL shader functions plus CPU bakers for tileable 3D/2D noise
 * volumes (clouds) and a deterministic PRNG (spectrum synthesis, debris).
 */
import { yieldToBrowser } from './loading';
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';

const { Fn, float, vec2, vec3, fract, floor, dot, mix, sin, min, max, Loop, int, length, abs } = TSL;

// ----------------------------------------------------------------------------
// TSL hashes (Dave Hoskins "hash without sine": stable across GPUs/precision)
// ----------------------------------------------------------------------------

export const hash12 = Fn(([p]: N[]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash22 = Fn(([p]: N[]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

export const hash13 = Fn(([p]: N[]) => {
  const p3 = fract(p.mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.zyx.add(31.32)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash33 = Fn(([p]: N[]) => {
  const p3 = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
});

/** Smooth 2D value noise in [0,1]. */
export const valueNoise2 = Fn(([p]: N[]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash12(i);
  const b = hash12(i.add(vec2(1, 0)));
  const c = hash12(i.add(vec2(0, 1)));
  const d = hash12(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** Smooth 3D value noise in [0,1]. */
export const valueNoise3 = Fn(([p]: N[]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const n000 = hash13(i);
  const n100 = hash13(i.add(vec3(1, 0, 0)));
  const n010 = hash13(i.add(vec3(0, 1, 0)));
  const n110 = hash13(i.add(vec3(1, 1, 0)));
  const n001 = hash13(i.add(vec3(0, 0, 1)));
  const n101 = hash13(i.add(vec3(1, 0, 1)));
  const n011 = hash13(i.add(vec3(0, 1, 1)));
  const n111 = hash13(i.add(vec3(1, 1, 1)));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z,
  );
});

/** Rotated-octave fBm built at graph-construction time (octave count is a JS constant). */
export function fbm2(p: N, octaves = 4, lacunarity = 2.03, gain = 0.5): N {
  let sum: N = float(0);
  let amp = 0.5;
  let norm = 0;
  let q: N = p;
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(valueNoise2(q).mul(amp));
    norm += amp;
    amp *= gain;
    // Rotate each octave ~37° to hide the lattice.
    q = vec2(q.x.mul(0.8).sub(q.y.mul(0.6)), q.x.mul(0.6).add(q.y.mul(0.8))).mul(lacunarity).add(17.3);
  }
  return sum.div(norm);
}

export function fbm3(p: N, octaves = 4, lacunarity = 2.02, gain = 0.5): N {
  let sum: N = float(0);
  let amp = 0.5;
  let norm = 0;
  let q: N = p;
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(valueNoise3(q).mul(amp));
    norm += amp;
    amp *= gain;
    q = q.yzx.mul(lacunarity).add(vec3(11.7, 5.3, 23.1));
  }
  return sum.div(norm);
}

/**
 * 2D Voronoi returning vec3(F1, F2, cellHash). `F2 - F1` gives the thin bright cell-edge
 * network used for caustics and foam lacing.
 */
export const voronoi2 = Fn(([p, jitterTime]: N[]) => {
  const cell = floor(p).toVar();
  const local = fract(p).toVar();
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  const id = float(0).toVar();
  Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'vj' }, ({ vj }: N) => {
    Loop({ start: int(-1), end: int(2), type: 'int', condition: '<', name: 'vi' }, ({ vi }: N) => {
      const offset = vec2(float(vi), float(vj));
      const h = hash22(cell.add(offset)).toVar();
      // Animate feature points on small circles so cells morph instead of sliding.
      const point = offset.add(sin(h.mul(6.2831).add(jitterTime)).mul(0.5).add(0.5)).sub(local);
      const d = dot(point, point);
      const isNearest = d.lessThan(f1);
      f2.assign(isNearest.select(f1, min(f2, d)));
      id.assign(isNearest.select(h.x, id));
      f1.assign(min(f1, d));
    });
  });
  return vec3(f1.sqrt(), f2.sqrt(), id);
});

/** Temporal raymarch jitter in [0,1) designed for TRAA accumulation. */
export const temporalIGN = Fn(([pixel, frameIndex]: N[]) => {
  // Per-pixel white noise + golden-ratio temporal sequence: every pixel walks a
  // low-discrepancy series, so temporal accumulation converges ~1/N instead of 1/√N.
  // White (hash) noise leaves fine grain – not the hatched streaks of ordered patterns –
  // whenever fast camera motion forces TRAA to drop history.
  return fract(hash12(pixel).add(frameIndex.mul(0.61803398875)));
});

/** Planck-fit blackbody radiator colour for a normalised temperature (0 = cold soot, 1 ≈ 3000 K+). */
export const blackbody = Fn(([t]: N[]) => {
  const x = max(t, 0.0);
  const r = x.mul(3.2).clamp(0, 1).pow(0.9);
  const g = x.sub(0.22).mul(1.9).clamp(0, 1).pow(1.6);
  const b = x.sub(0.62).mul(2.6).clamp(0, 1).pow(2.2);
  return vec3(r, g, b).mul(x.mul(x).mul(14).add(x.mul(1.6)));
});

export { length as _length, abs as _abs };

// ----------------------------------------------------------------------------
// CPU side
// ----------------------------------------------------------------------------

/** Small fast deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller Gaussian pair from a uniform generator. */
export function gaussianPair(rand: () => number): [number, number] {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

function ihash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrap = (v: number, period: number) => ((v % period) + period) % period;

/** Tileable 3D gradient (Perlin) noise in roughly [-1, 1]. */
function perlin3(x: number, y: number, z: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const grad = (ix: number, iy: number, iz: number, dx: number, dy: number, dz: number) => {
    const h = Math.floor(ihash(wrap(ix, period), wrap(iy, period), wrap(iz, period), seed) * 12);
    switch (h) {
      case 0: return dx + dy; case 1: return -dx + dy; case 2: return dx - dy; case 3: return -dx - dy;
      case 4: return dx + dz; case 5: return -dx + dz; case 6: return dx - dz; case 7: return -dx - dz;
      case 8: return dy + dz; case 9: return -dy + dz; case 10: return dy - dz; default: return -dy - dz;
    }
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(grad(xi, yi, zi, xf, yf, zf), grad(xi + 1, yi, zi, xf - 1, yf, zf), u),
      lerp(grad(xi, yi + 1, zi, xf, yf - 1, zf), grad(xi + 1, yi + 1, zi, xf - 1, yf - 1, zf), u), v),
    lerp(lerp(grad(xi, yi, zi + 1, xf, yf, zf - 1), grad(xi + 1, yi, zi + 1, xf - 1, yf, zf - 1), u),
      lerp(grad(xi, yi + 1, zi + 1, xf, yf - 1, zf - 1), grad(xi + 1, yi + 1, zi + 1, xf - 1, yf - 1, zf - 1), u), v),
    w,
  );
}

/** Tileable inverted Worley noise in [0,1] (1 at feature points → billowy blobs). */
function worleySampler(period: number, seed: number) {
  // Every voxel in a cell shares the same 27 feature points. A one-cell
  // periodic border lets the inner loop use contiguous reads without hashing.
  const span = period + 2;
  const points = new Float64Array(span ** 3 * 3);
  let i = 0;
  for (let z = -1; z <= period; z++) for (let y = -1; y <= period; y++) for (let x = -1; x <= period; x++) {
    const a = wrap(x, period), b = wrap(y, period), c = wrap(z, period);
    points[i++] = x + ihash(a, b, c, seed);
    points[i++] = y + ihash(a, b, c, seed + 101);
    points[i++] = z + ihash(a, b, c, seed + 211);
  }
  return (x: number, y: number, z: number) => {
    const cell = Math.floor(x) + span * (Math.floor(y) + span * Math.floor(z));
    let best = 1;
    for (let dz = 0; dz < 3; dz++) for (let dy = 0; dy < 3; dy++) {
      let j = (cell + span * (dy + span * dz)) * 3;
      for (let dx = 0; dx < 3; dx++) {
        const a = points[j++] - x, b = points[j++] - y, c = points[j++] - z;
        best = Math.min(best, a * a + b * b + c * c);
      }
    }
    return 1 - Math.sqrt(best);
  };
}

function make3D(size: number, data: Uint8Array): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export interface CloudNoiseTextures {
  /** R: Perlin–Worley base shape, G/B/A: Worley fBm at rising frequency. */
  base: THREE.Data3DTexture;
  /** R/G/B: high-frequency Worley octaves for edge erosion. */
  detail: THREE.Data3DTexture;
  /** 2D weather map – R: coverage, G: cloud-type / height variation, B: fine breakup. */
  weather: THREE.DataTexture;
}

let _cloudNoise: CloudNoiseTextures | null = null;

let activeBake: Generator<void, CloudNoiseTextures> | undefined;

/** Synchronous access for existing callers. A concurrent preload shares this work. */
export function bakeCloudNoise(baseSize = 64, detailSize = 32): CloudNoiseTextures {
  if (_cloudNoise) return _cloudNoise;
  activeBake ??= cloudSlices(baseSize, detailSize);
  while (!_cloudNoise) advanceCloudBake();
  return _cloudNoise;
}

function advanceCloudBake(): void {
  const slice = activeBake!.next();
  if (slice.done) {
    _cloudNoise = slice.value;
    activeBake = undefined;
  }
}

/** Let input and paint run between short batches before constructing outdoor modules. */
export async function prepareCloudNoise(): Promise<void> {
  if (_cloudNoise) return;
  activeBake ??= cloudSlices(64, 32);
  while (!_cloudNoise) {
    const deadline = performance.now() + 6;
    do { advanceCloudBake(); } while (!_cloudNoise && performance.now() < deadline);
    if (!_cloudNoise) await yieldToBrowser();
  }
}

function* cloudSlices(baseSize: number, detailSize: number): Generator<void, CloudNoiseTextures> {
  const weatherCells = worleySampler(5, 151);
  const detailLobes = worleySampler(8, 113);
  const detailBillows = worleySampler(4, 97);
  const detailCells = worleySampler(2, 83);
  const baseLobes = worleySampler(16, 59);
  const baseBillows = worleySampler(8, 47);
  const baseCells = worleySampler(4, 31);
  const base = new Uint8Array(baseSize ** 3 * 4);
  let o = 0;
  for (let z = 0; z < baseSize; z++) {
    for (let y = 0; y < baseSize; y++) for (let x = 0; x < baseSize; x++) {
      const u = x / baseSize, v = y / baseSize, w = z / baseSize;
      let perlin = 0, amp = 0.5, norm = 0;
      for (let oct = 0, f = 4; oct < 3; oct++, f *= 2) { perlin += perlin3(u * f, v * f, w * f, f, 7 + oct) * amp; norm += amp; amp *= 0.5; }
      perlin = Math.min(1, Math.max(0, perlin / norm * 0.85 + 0.5));
      const w1 = baseCells(u * 4, v * 4, w * 4);
      const w2 = baseBillows(u * 8, v * 8, w * 8);
      const w3 = baseLobes(u * 16, v * 16, w * 16);
      const worleyFbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
      // Perlin–Worley: dilate Perlin with Worley so shapes read as billows, not smoke.
      const pw = Math.min(1, Math.max(0, (perlin - (worleyFbm - 1)) / (1 - (worleyFbm - 1))));
      base[o++] = pw * 255; base[o++] = w1 * 255; base[o++] = w2 * 255; base[o++] = w3 * 255;
    }
    yield;
  }
  const detail = new Uint8Array(detailSize ** 3 * 4);
  o = 0;
  for (let z = 0; z < detailSize; z++) {
    for (let y = 0; y < detailSize; y++) for (let x = 0; x < detailSize; x++) {
      const u = x / detailSize, v = y / detailSize, w = z / detailSize;
      detail[o++] = detailCells(u * 2, v * 2, w * 2) * 255;
      detail[o++] = detailBillows(u * 4, v * 4, w * 4) * 255;
      detail[o++] = detailLobes(u * 8, v * 8, w * 8) * 255;
      detail[o++] = 255;
    }
    yield;
  }
  const ws = 256;
  const weatherData = new Uint8Array(ws * ws * 4);
  o = 0;
  for (let y = 0; y < ws; y++) {
    for (let x = 0; x < ws; x++) {
      const u = x / ws, v = y / ws;
      let cov = 0, amp = 0.5, norm = 0;
      for (let oct = 0, f = 3; oct < 4; oct++, f *= 2) { cov += perlin3(u * f, v * f, 0.37 * f, f, 131 + oct) * amp; norm += amp; amp *= 0.55; }
      cov = Math.min(1, Math.max(0, cov / norm * 1.15 + 0.5));
      const cells = weatherCells(u * 5, v * 5, 0.5);
      const type = Math.min(1, Math.max(0, perlin3(u * 2, v * 2, 1.7, 2, 173) * 0.9 + 0.5));
      const fine = Math.min(1, Math.max(0, perlin3(u * 16, v * 16, 3.1, 16, 191) * 0.8 + 0.5));
      weatherData[o++] = Math.min(1, cov * 0.7 + cells * cov * 0.6) * 255;
      weatherData[o++] = type * 255;
      weatherData[o++] = fine * 255;
      weatherData[o++] = 255;
    }
    yield;
  }
  const weather = new THREE.DataTexture(weatherData, ws, ws, THREE.RGBAFormat, THREE.UnsignedByteType);
  weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
  weather.minFilter = THREE.LinearFilter;
  weather.magFilter = THREE.LinearFilter;
  weather.needsUpdate = true;
  return { base: make3D(baseSize, base), detail: make3D(detailSize, detail), weather };
}

let _spriteNoise: THREE.DataTexture | null = null;

/**
 * Tileable value noise baked once into a 128² texture (16 lattice cells across, two
 * independent channels). Fill-rate-bound shaders (soft particles) read it with one bilinear
 * tap instead of hashing four lattice corners per octave: `spriteNoise(p)` matches
 * `valueNoise2(p)` in scale and statistics, with a period of 16 units.
 */
export function spriteNoiseTexture(): THREE.DataTexture {
  if (_spriteNoise) return _spriteNoise;
  const size = 128, cells = 16;
  const data = new Uint8Array(size * size * 4);
  for (let channel = 0; channel < 2; channel++) {
    const random = mulberry32(1337 + channel * 97);
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = random();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      // Same quintic fade as `valueNoise2`.
      const ux = tx * tx * tx * (tx * (tx * 6 - 15) + 10), uy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
      const g = (ix: number, iy: number) => lattice[(iy % cells) * cells + (ix % cells)];
      const v = (g(x0, y0) * (1 - ux) + g(x0 + 1, y0) * ux) * (1 - uy) + (g(x0, y0 + 1) * (1 - ux) + g(x0 + 1, y0 + 1) * ux) * uy;
      data[(y * size + x) * 4 + channel] = Math.round(v * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  _spriteNoise = texture;
  return texture;
}

/** One bilinear tap of the baked noise; `channel` 0 or 1 gives two uncorrelated fields. */
export function spriteNoise(p: N, channel: 0 | 1 = 0): N {
  const t = TSL.texture(spriteNoiseTexture(), p.div(16));
  return channel === 0 ? t.r : t.g;
}
