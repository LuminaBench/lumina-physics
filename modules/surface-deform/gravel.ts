import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';

/** Tileable crushed aggregate. RG encodes a stone facet slope, B mineral tone, A the fines between stones. */
export function createGravelTexture(): THREE.DataTexture {
  const size = 192, cells = 18, random = mulberry32(8843);
  const sites = new Float32Array(cells * cells * 3);
  for (let i = 0; i < sites.length; i++) sites[i] = random();
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) * cells / size, py = (y + 0.5) * cells / size;
    const cx = Math.floor(px), cy = Math.floor(py);
    let near = Infinity, second = Infinity, dx = 0, dy = 0, tone = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const key = 3 * (((cy + j + cells) % cells) * cells + (cx + i + cells) % cells);
      const sx = px - (cx + i + 0.15 + 0.7 * sites[key]);
      const sy = py - (cy + j + 0.15 + 0.7 * sites[key + 1]);
      const d = sx * sx + sy * sy;
      if (d < near) {
        second = near; near = d; dx = sx; dy = sy; tone = sites[key + 2];
      } else if (d < second) second = d;
    }
    const face = THREE.MathUtils.smoothstep(second - near, 0.025, 0.22);
    const k = 4 * (y * size + x);
    data[k] = 128 + 92 * Math.sign(dx) * Math.min(1, Math.abs(dx) * 2.5) * face;
    data[k + 1] = 128 + 92 * Math.sign(dy) * Math.min(1, Math.abs(dy) * 2.5) * face;
    data[k + 2] = 255 * tone; data[k + 3] = 255 * (1 - face);
  }
  const result = new THREE.DataTexture(data, size, size);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.magFilter = THREE.LinearFilter; result.minFilter = THREE.LinearMipmapLinearFilter;
  result.generateMipmaps = true; result.anisotropy = 4; result.needsUpdate = true;
  return result;
}
