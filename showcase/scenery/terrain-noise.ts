/** Seeded gradient noise shared by landforms and vegetation placement. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

// Adjacent terrain vertices repeatedly sample the same lattice corners. A hash
// collision replaces a cached direction without changing the generated landscape.
const gradientKeys = new Float64Array(4096);
const gradientX = new Float64Array(4096);
const gradientZ = new Float64Array(4096);
function gradient(ix: number, iz: number, dx: number, dz: number, seed: number): number {
  const hash = hash2(ix, iz, seed);
  const slot = hash & 4095;
  if (gradientKeys[slot] !== hash + 1) {
    const angle = (hash / 4294967296) * Math.PI * 2;
    gradientX[slot] = Math.cos(angle);
    gradientZ[slot] = Math.sin(angle);
    gradientKeys[slot] = hash + 1;
  }
  return gradientX[slot] * dx + gradientZ[slot] * dz;
}

export function noise2D(x: number, z: number, seed = 17): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const n00 = gradient(xi, zi, xf, zf, seed);
  const n10 = gradient(xi + 1, zi, xf - 1, zf, seed);
  const n01 = gradient(xi, zi + 1, xf, zf - 1, seed);
  const n11 = gradient(xi + 1, zi + 1, xf - 1, zf - 1, seed);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

export function fbmCPU(x: number, z: number, octaves = 4, seed = 17): number {
  let sum = 0, amp = 0.5, norm = 0;
  let qx = x, qz = z;
  for (let i = 0; i < octaves; i++) {
    sum += noise2D(qx, qz, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    const rx = qx * 0.8 - qz * 0.6;
    const rz = qx * 0.6 + qz * 0.8;
    qx = rx * 2.04 + 13.7;
    qz = rz * 2.04 + 7.9;
  }
  return sum / norm;
}

/** Ridged multifractal noise in [0, 1] for eroded mountain spines and coastal spurs. */
export function ridgedCPU(x: number, z: number, octaves = 4, seed = 53): number {
  let sum = 0, amp = 0.55, weight = 1, norm = 0;
  let qx = x, qz = z;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2D(qx, qz, seed + i * 41) * 1.45);
    n = Math.max(0, Math.min(1, n));
    n = n * n * weight;
    weight = Math.max(0.25, Math.min(1, n * 1.6));
    sum += n * amp;
    norm += amp;
    amp *= 0.48;
    const rx = qx * 0.8 - qz * 0.6;
    const rz = qx * 0.6 + qz * 0.8;
    qx = rx * 2.07 + 19.1;
    qz = rz * 2.07 + 5.3;
  }
  return sum / norm;
}
