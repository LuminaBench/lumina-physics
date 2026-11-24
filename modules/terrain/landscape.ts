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
      height: 3.9 + rand() * 10,
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
        escarp * (1.3 + outer * 8.6 + 2 * macro) +
        Math.max(0, offset - 31) * (0.065 + 0.09 * (macro + 1)) +
        bank * (0.55 * bed + 0.19 * grain)
      );
    }
    if (biome === 'dry-highlands') {
      const fold = noise(x * 0.01 + 0.8 * macro, z * 0.012, seed ^ 31),
        ridge = 1 - Math.abs(fold);
      const mesa = smooth(0.43, 0.56, ridge) * 5.4 + smooth(0.64, 0.7, ridge + bed * 0.035) * 4.0;
      return 3.1 + 20 * ridge ** 2 + mesa + 5.2 * macro + 1.9 * bed + 0.55 * grain;
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
        const r = Math.hypot((x - st.x) / st.rx, (z - st.z) / st.rz) + bed * 0.13 + grain * 0.09;
        const base = 1 - smooth(0.66, 1.45, r),
          pillar = 1 - smooth(0.52, 0.97, r);
        height = Math.max(height, -3.5 + base * 3.7 + pillar * st.height + base * bed * 1.15);
      }
    }
    return height;
  };
}
