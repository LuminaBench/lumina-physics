import * as THREE from 'three/webgpu';

interface Patch { x0: number; z0: number; x1: number; z1: number }

/** Simplify a heightfield at load time. Adjacent patches use the same edge vertices,
 * and normals come from the original samples, including along a coarse/fine boundary. */
export function seabedGeometry(size: number, center: THREE.Vector2, segments: number, elevation: (x: number, z: number) => number): THREE.BufferGeometry {
  const n = Math.max(1, Math.floor(segments)), stride = n + 1, cell = size / n;
  const heights = new Float32Array(stride * stride);
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
    heights[z * stride + x] = elevation(center.x + x * cell - size / 2, center.y + z * cell - size / 2);
  }
  const corner = new Uint8Array(heights.length), patches: Patch[] = [];
  const height = (x: number, z: number) => heights[z * stride + x];
  function split(x0: number, z0: number, x1: number, z1: number): void {
    const width = x1 - x0, depth = z1 - z0;
    const a = height(x0,z0), b = height(x1,z0), c = height(x0,z1), d = height(x1,z1);
    const tolerance = 0.048 + Math.max(0, -Math.max(a,b,c,d) - 9) * 0.006;
    // A bilinear saddle can agree with every sample yet deviate from either
    // triangulation. Its maximum diagonal error is one quarter of the twist.
    let exceeds = width > 24 || depth > 24 || ((width > 1 || depth > 1) && Math.abs(a - b - c + d) > 2 * tolerance);
    if (!exceeds && (width > 1 || depth > 1)) {
      for (let z = z0; z <= z1 && !exceeds; z++) {
        const v = (z - z0) / depth, left = a + (c - a) * v, right = b + (d - b) * v;
        for (let x = x0; x <= x1; x++) {
          const linear = left + (right - left) * (x - x0) / width;
          if (Math.abs(height(x,z) - linear) > tolerance) { exceeds = true; break; }
        }
      }
    }
    if (exceeds) {
      const midX = x0 + Math.max(1, width >> 1), midZ = z0 + Math.max(1, depth >> 1);
      split(x0, z0, midX, midZ);
      if (midX < x1) split(midX, z0, x1, midZ);
      if (midZ < z1) split(x0, midZ, midX, z1);
      if (midX < x1 && midZ < z1) split(midX, midZ, x1, z1);
      return;
    }
    corner[z0 * stride + x0] = corner[z0 * stride + x1] = 1;
    corner[z1 * stride + x0] = corner[z1 * stride + x1] = 1;
    patches.push({ x0, z0, x1, z1 });
  }
  split(0, 0, n, n);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const vertexIndices = new Int32Array(heights.length).fill(-1);
  function vertex(x: number, z: number): number {
    const at = z * stride + x;
    if (vertexIndices[at] >= 0) return vertexIndices[at];
    const id = vertexIndices[at] = positions.length / 3;
    const xl = Math.max(0, x - 1), xr = Math.min(n, x + 1), zb = Math.max(0, z - 1), zf = Math.min(n, z + 1);
    const sx = (height(xl,z) - height(xr,z)) / ((xr - xl) * cell);
    const sz = (height(x,zb) - height(x,zf)) / ((zf - zb) * cell);
    const inv = 1 / Math.sqrt(1 + sx * sx + sz * sz);
    positions.push(x * cell - size / 2, heights[at], z * cell - size / 2);
    normals.push(sx * inv, inv, sz * inv);
    uvs.push(x / n, 1 - z / n);
    return id;
  }
  const perimeter: number[] = [];
  for (const { x0, z0, x1, z1 } of patches) {
    perimeter.length = 0;
    for (let z = z0; z < z1; z++) if (corner[z * stride + x0]) perimeter.push(vertex(x0,z));
    for (let x = x0; x < x1; x++) if (corner[z1 * stride + x]) perimeter.push(vertex(x,z1));
    for (let z = z1; z > z0; z--) if (corner[z * stride + x1]) perimeter.push(vertex(x1,z));
    for (let x = x1; x > x0; x--) if (corner[z0 * stride + x]) perimeter.push(vertex(x,z0));
    if (perimeter.length === 4) {
      indices.push(perimeter[0], perimeter[1], perimeter[3], perimeter[1], perimeter[2], perimeter[3]);
      continue;
    }
    // Nonuniform edge subdivisions need a central fan so none of the shared edges
    // becomes a zero-area triangle. Position and normal are interpolated at its center.
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, ix = Math.floor(mx), iz = Math.floor(mz);
    const fx = mx - ix, fz = mz - iz;
    const a = height(ix, iz), b = height(ix + 1, iz), c = height(ix, iz + 1), d = height(ix + 1, iz + 1);
    const y = (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
    const sx = -((b - a) * (1 - fz) + (d - c) * fz) / cell;
    const sz = -((c - a) * (1 - fx) + (d - b) * fx) / cell, inv = 1 / Math.sqrt(1 + sx * sx + sz * sz);
    const id = positions.length / 3;
    positions.push(mx * cell - size / 2, y, mz * cell - size / 2);
    normals.push(sx * inv, inv, sz * inv); uvs.push(mx / n, 1 - mz / n);
    for (let i = 0; i < perimeter.length; i++) indices.push(id, perimeter[i], perimeter[(i + 1) % perimeter.length]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
