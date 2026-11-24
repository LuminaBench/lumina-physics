import { MathUtils } from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import type { Biome } from './biomes';

const smooth = (a: number, b: number, x: number) => MathUtils.smoothstep(x, a, b);
function hash(x: number, z: number, seed: number) {
  let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, z: number, seed: number) {
  const i = Math.floor(x),
    j = Math.floor(z),
    u = smooth(0, 1, x - i),
    v = smooth(0, 1, z - j);
  return (
    MathUtils.lerp(
      MathUtils.lerp(hash(i, j, seed), hash(i + 1, j, seed), u),
      MathUtils.lerp(hash(i, j + 1, seed), hash(i + 1, j + 1, seed), u),
      v,
    ) *
      2 -
    1
  );
}
/** All scales are metres. The channel, banks, bars and offshore shelves are present in the collision mesh. */
export function landscape(biome: Biome, seed: number) {
  const rand = mulberry32(seed ^ 0x34735),
    phase = Array.from({ length: 7 }, () => rand() * Math.PI * 2);
  const shore = (z: number) =>
    24 * Math.sin(z * 0.016 + phase[0]) + 16 * Math.cos(z * 0.036 + phase[1]) + 7 * noise(z * 0.048, 3, seed);
  const stacks = Array.from({ length: 14 }, (_, i) => {
    const z = (i - 6.5) * 34 + (rand() - 0.5) * 20;
    return {
      x: shore(z) + 17 + rand() * 41,
      z,
      rx: 3.3 + rand() * 6.3,
      rz: 4.2 + rand() * 7.6,
      height: 2.0 + rand() ** 1.4 * 12,
    };
  });
  return (x: number, z: number) => {
    const macro = noise(x * 0.013, z * 0.013, seed),
      bed = noise(x * 0.06, z * 0.06, seed ^ 73),
      grain = noise(x * 0.16, z * 0.16, seed ^ 978);
    if (biome === 'temperate-river-valley') {
      const theta = z * 0.019 + phase[1],
        center = 28 * Math.sin(theta) + 15 * Math.sin(z * 0.041 + phase[2]) + 6 * noise(z * 0.023, 2, seed);
      const dx = x - center,
        side = dx < 0 ? -1 : 1,
        outer = (1 + side * Math.sin(theta)) * 0.5;
      const half = 10 + 3 * Math.cos(z * 0.031 + phase[3]) + 3 * macro,
        offset = Math.abs(dx) - half;
      const shelf = 4 + 15 * (1 - outer),
        bank = smooth(-4, shelf + 1, offset);
      const escarp = smooth(7 + 10 * (1 - outer), 17 + 28 * (1 - outer), offset + bed * 2);
      const thalweg = -2.1 - 1.4 * smooth(0.12, 0.92, outer) + bed * 0.27;
      const bar =
        Math.exp(-Math.pow((offset + 2.4) / 5, 2)) *
        Math.pow(Math.max(0, Math.cos(z * 0.052 + phase[4])), 1.6) *
        (1 - outer) *
        2.1;
      return (
        thalweg +
        bar +
        (4.6 + macro * 0.9) * bank +
        escarp * (1.1 + outer * (4.4 + 2.8 * Math.sin(z * 0.037 + phase[1])) + 2 * macro) +
        Math.max(0, offset - 31) * (0.065 + 0.09 * (macro + 1)) +
        bank * (0.55 * bed + 0.19 * grain)
      );
    }
    if (biome === 'dry-highlands') {
      // Broad grass-bearing dip slopes alternate with sharp, discontinuous scarp faces.
      const axis = x + 0.29 * z - 16 * Math.sin(z * 0.014 + phase[1]) + 4.5 * bed;
      const ridge = (center: number, width: number, elevation: number) => {
        const d = axis - center,
          breakup = 0.81 + 0.19 * Math.cos(z * 0.018 + phase[4]);
        const foot = smooth(-width * 0.74, width * 0.09, d);
        const rim = smooth(0, width * 0.14, d + 1.7 * bed);
        const back = 1 - smooth(width * 0.21, width * 1.65, d);
        return elevation * breakup * back * (0.45 * foot + 0.55 * rim);
      };
      return (
        11 +
        5.8 * macro +
        1.0 * bed +
        0.16 * grain +
        ridge(-110, 36, 15) +
        ridge(31, 28, 18) +
        ridge(147, 45, 27)
      );
    }
    const coast = shore(z) - x;
    const cove = smooth(-0.58, 0.7, Math.sin(z * 0.028 + phase[2]) + 0.45 * macro);
    const terrace = coast + 2.9 * bed + 1.3 * grain,
      foot = 1.4 + 3 * cove;
    const first = smooth(foot, foot + 2.8 + 3 * cove, terrace);
    const second = smooth(8.5 + 5 * cove, 13.2 + 7 * cove, terrace + bed * 2.5);
    const upper = smooth(18.0, 29.0, terrace + macro * 5);
    const shelf = -0.55 + Math.min(coast * 0.14, 2.3) + bed * 0.43 + grain * 0.13;
    let height =
      shelf +
      first * (4.2 + 3.7 * (1 - cove)) +
      second * (4.3 + 4.8 * (1 - cove)) +
      upper * (3.8 + 4 * macro) +
      smooth(18, 75, coast) * (7.8 * macro + bed * 1.3);
    if (coast < 0 && coast > -84) {
      for (const st of stacks) {
        if (Math.abs(z - st.z) > st.rz * 1.6) continue;
        const sx = (x - st.x) / st.rx,
          sz = (z - st.z) / st.rz;
        const r =
          Math.max(
            Math.abs(sx * 0.86 + sz * 0.23),
            Math.abs(sz * 0.93 - sx * 0.15),
            Math.hypot(sx, sz) * 0.72,
          ) +
          bed * 0.23 +
          grain * 0.14;
        const joint = grain * 0.1 + bed * 0.081,
          base = 1 - smooth(0.61, 1.45, r);
        const pillar =
          (1 - smooth(0.67, 0.88, r + joint)) * 0.53 + (1 - smooth(0.38, 0.58, r - joint)) * 0.47;
        height = Math.max(
          height,
          -3.5 +
            base * 3.7 +
            pillar * st.height * (0.85 + 0.15 * Math.sin((x - st.x) * 0.53 + z * 0.12)) +
            base * bed * 1.15,
        );
      }
    }
    return height;
  };
}
