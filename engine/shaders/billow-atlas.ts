import * as THREE from 'three/webgpu';
import { mulberry32 } from '../noise';

let atlas: THREE.DataTexture | undefined;

/** Bake extinction, scattering depth and light gradients through four turbulent
 * density volumes. The shaded normal is an optical-depth moment, so overlapping
 * wisps share light instead of reading as separate solid spheres.
 *
 * Channels: R = opacity (1 - transmission), GB = shading normal (xy, biased),
 * A = multiple-scatter occlusion (thick cores darker, thin fringes bright).
 *
 * Every density is windowed by the tile's inscribed disc, so no variant can be cut
 * by the tile border — a cut there reads as a straight opaque-card silhouette. The
 * fringe is eroded by ridged, domain-warped noise into thin rolling filaments while
 * the interior stays continuous, so lighting reads as form rather than leathery
 * mottling. Same 256² RGBA8 footprint as before. */
export function billowAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  const tile = 128,
    size = tile * 2,
    rgba = new Uint8Array(size * size * 4);
  const random = mulberry32(193515),
    lattice = new Float32Array(32 * 32 * 32);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  const noise = (x: number, y: number, z: number): number => {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z);
    let tx = x - ix,
      ty = y - iy,
      tz = z - iz;
    tx *= tx * (3 - 2 * tx);
    ty *= ty * (3 - 2 * ty);
    tz *= tz * (3 - 2 * tz);
    const x0 = ix & 31,
      x1 = (ix + 1) & 31,
      y0 = (iy & 31) * 32,
      y1 = ((iy + 1) & 31) * 32,
      z0 = (iz & 31) * 1024,
      z1 = ((iz + 1) & 31) * 1024;
    const a = lattice[z0 + y0 + x0] * (1 - tx) + lattice[z0 + y0 + x1] * tx;
    const b = lattice[z0 + y1 + x0] * (1 - tx) + lattice[z0 + y1 + x1] * tx;
    const c = lattice[z1 + y0 + x0] * (1 - tx) + lattice[z1 + y0 + x1] * tx;
    const d = lattice[z1 + y1 + x0] * (1 - tx) + lattice[z1 + y1 + x1] * tx;
    return (a + (b - a) * ty) * (1 - tz) + (c + (d - c) * ty) * tz;
  };
  const depth = new Float32Array(tile * tile),
    optical = new Float32Array(tile * tile),
    illumination = new Float32Array(tile * tile);
  const samples = 20,
    dz = 1.8 / samples;
  for (let variant = 0; variant < 4; variant++) {
    const seed = variant * 6.71 + 17.3;
    // Each variant gets its own lobe count and lean so the four never read as one
    // shape rotated; mirrored and rotated in the sprite shader this gives 8+ silhouettes.
    const lean = (variant - 1.5) * 0.07;
    const lobes = 0.3 + 0.08 * variant;
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        const u = ((x + 0.5) * 2) / tile - 1,
          v = ((y + 0.5) * 2) / tile - 1,
          i = y * tile + x;
        const rr = Math.sqrt(u * u + v * v);
        // Inscribed-disc window: zero density over the outer band of the tile.
        const fringeWidth = Math.max(0, Math.min(1, (0.97 - rr) / 0.25));
        const window = fringeWidth * fringeWidth * (3 - 2 * fringeWidth);
        let transmission = 1,
          moment = 0,
          total = 0,
          light = 0,
          tau = 0;
        if (window > 0) {
          // Two-octave domain warp: the coarse octave bends the envelope into rolling
          // lobes, the fine one twists the fringe so filaments curl rather than radiate.
          const warpX = noise(2.2 * u + seed, 2.2 * v, 3.7) - 0.5;
          const warpY = noise(2.0 * u + 2, 2.0 * v + seed, 5.3) - 0.5;
          const wx0 = u + 0.2 * warpX + lean * v,
            wy0 = v + 0.2 * warpY;
          const twistX = noise(6.1 * wx0 + seed, 6.1 * wy0, 9.1) - 0.5;
          const twistY = noise(6.1 * wx0 - 4.4, 6.1 * wy0 + seed, 1.9) - 0.5;
          const wx = wx0 + 0.07 * twistX,
            wy = wy0 + 0.07 * twistY;
          for (let step = 0; step < samples; step++) {
            const z = 0.9 - (step + 0.5) * dz;
            const r2 = wx * wx * (1.12 + 0.12 * v) + wy * wy + 1.24 * z * z;
            if (r2 > 0.82) continue;
            // Cauliflower lobes displace the envelope; the interior stays continuous.
            const n = noise(wx * 3.1 + seed, wy * 3.1, z * 3.1 + 8);
            const edge0 = 0.5 - r2 + lobes * (n - 0.5) * 2;
            if (edge0 <= -0.04) continue;
            // Ridged erosion only near the fringe: thin, sharp strands survive where the
            // ridge is low; the deep core is untouched, so it never looks leathery.
            const fine = noise(wy * 8.3 + seed, z * 8.3, wx * 8.3 + 3.2);
            const ridge = Math.abs(fine * 2 - 1);
            const curl = noise(z * 15.3, wx * 15.3 + seed, wy * 15.3 - 5.6);
            const fringe = Math.max(0, 1 - edge0 * 4.2);
            const edge = edge0 - fringe * (0.19 * ridge + 0.05 * (curl - 0.5)) + 0.03;
            if (edge <= 0) continue;
            const density = Math.min(1, edge * 10) * (0.18 + 0.82 * n * n) * (0.55 + 0.45 * fine) * window;
            const absorb = 1 - Math.exp(-density * 3.4 * dz),
              scatter = transmission * absorb;
            moment += scatter * z;
            total += scatter;
            // Multiple-scatter occlusion: light reaching a scatter point falls with the
            // optical depth already crossed plus a share of what lies deeper, so dense
            // cores shade down smoothly and thin strands stay luminous.
            light += scatter * (Math.exp(-tau * 0.55) * 0.8 + 0.2 * Math.exp(-density * 1.4));
            tau += density * 3.4 * dz;
            transmission *= 1 - absorb;
          }
        }
        optical[i] = 1 - transmission;
        depth[i] = total > 0.005 ? moment / total : 0;
        illumination[i] = total > 0.005 ? light / total : 1;
      }
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        const i = y * tile + x;
        const xl = Math.max(0, x - 2),
          xr = Math.min(tile - 1, x + 2),
          yd = Math.max(0, y - 2),
          yu = Math.min(tile - 1, y + 2);
        // Macro form from the opacity gradient (wide stencil, smooth lobes) plus a
        // weaker depth-moment term for surface relief. The narrow-only gradient used
        // previously amplified texel noise into a leathery, hammered surface.
        const ox = (optical[y * tile + xl] - optical[y * tile + xr]) * tile * 0.11;
        const oy = (optical[yd * tile + x] - optical[yu * tile + x]) * tile * 0.11;
        const dx = (depth[y * tile + xl] - depth[y * tile + xr]) * tile * 0.05 * optical[i];
        const dy = (depth[yd * tile + x] - depth[yu * tile + x]) * tile * 0.05 * optical[i];
        const nx = ox + dx,
          ny = oy + dy;
        const inv = 1 / Math.sqrt(1 + nx * nx + ny * ny);
        const off = ((y + (variant >> 1) * tile) * size + x + (variant % 2) * tile) * 4;
        rgba[off] = Math.round(Math.max(0, Math.min(1, optical[i])) * 255);
        rgba[off + 1] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        rgba[off + 2] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        rgba[off + 3] = Math.round(Math.max(0, Math.min(1, illumination[i])) * 255);
      }
  }
  atlas = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;
  return atlas;
}
