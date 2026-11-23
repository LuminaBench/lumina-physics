/**
 * Procedural organic coastal headlands, volcanic archipelagos, distant ranges and rocky outcrops.
 *
 * Avoids geometric cones/pyramids by sculpting each landform from domain-warped multi-octave
 * gradient noise + ridged erosion spines + asymmetric spur lobes, tapering smoothly below the
 * waterline so waves never reveal floating skirts.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../engine/noise';
import type { SceneryRegistry } from './materials';
import { buildCoastalCanopy, type TreePlacement } from './vegetation';

import { noise2D, fbmCPU, ridgedCPU } from './terrain-noise';
export { noise2D, fbmCPU, ridgedCPU } from './terrain-noise';

export interface HeadlandSpec {
  x: number;
  z: number;
  /** Semi-axes (m) along local X and Z before rotation. */
  radiusX: number;
  radiusZ: number;
  /** Peak elevation above sea level (m). */
  height: number;
  /** Y-axis rotation in radians. */
  rotation?: number;
  /** Grid resolution per side (default 48). */
  segments?: number;
  /** Underwater skirt floor (m, negative, default -14). */
  skirtDepth?: number;
  /** 0 = gentle rolling hills, 1 = dramatic ridged volcanic/coastal cliffs. */
  cragginess?: number;
  /** Optional subtle coastal bluff terrace strength (0..0.4). */
  terracing?: number;
  /** Deterministic shape seed. */
  seed: number;
}

export interface BuiltHeadlands {
  mesh: THREE.Mesh;
  heightAt(x: number, z: number): number;
  /** Slope ny ∈ [0, 1] (1 = flat, 0 = vertical cliff). */
  slopeAt(x: number, z: number): number;
  specs: HeadlandSpec[];
}

function makeHeadlandSampler(spec: HeadlandSpec): (wx: number, wz: number) => number {
  const rot = spec.rotation ?? 0;
  const cosR = Math.cos(-rot), sinR = Math.sin(-rot);
  const rx = spec.radiusX, rz = spec.radiusZ;
  const skirt = spec.skirtDepth ?? -14;
  const crag = spec.cragginess ?? 0.55;
  const terrace = spec.terracing ?? 0.14;
  const rand = mulberry32(spec.seed);

  // 3–4 asymmetric sub-peaks/spurs so the silhouette has saddles, headlands and coves.
  const lobeCount = 3 + Math.floor(rand() * 2);
  const lobes: Array<{ cx: number; cz: number; sx: number; sz: number; w: number }> = [
    { cx: (rand() - 0.5) * 0.24, cz: (rand() - 0.5) * 0.2, sx: 0.68, sz: 0.62, w: 1.0 },
  ];
  for (let i = 1; i < lobeCount; i++) {
    const a = (i / lobeCount) * Math.PI * 2 + (rand() - 0.5) * 0.8;
    const dist = 0.28 + rand() * 0.34;
    lobes.push({
      cx: Math.cos(a) * dist,
      cz: Math.sin(a) * dist * 0.85,
      sx: 0.32 + rand() * 0.34,
      sz: 0.30 + rand() * 0.32,
      w: 0.42 + rand() * 0.48,
    });
  }
  // 1–2 shallow cove indentations along the coastline.
  const coveAngle = rand() * Math.PI * 2;
  const coveX = Math.cos(coveAngle) * 0.62;
  const coveZ = Math.sin(coveAngle) * 0.58;
  const freqScale = 1.65 / Math.sqrt(rx * rz);

  return (wx: number, wz: number): number => {
    const dx = wx - spec.x;
    const dz = wz - spec.z;
    const lx = (dx * cosR - dz * sinR) / rx;
    const lz = (dx * sinR + dz * cosR) / rz;

    // Domain warp breaks any elliptical regularity into natural jagged bays and spurs.
    const warpX = fbmCPU(lx * 1.9 + 3.1, lz * 1.9 - 1.7, 3, spec.seed + 11) * 0.34;
    const warpZ = fbmCPU(lx * 1.9 - 4.3, lz * 1.9 + 5.2, 3, spec.seed + 29) * 0.34;
    const ux = lx + warpX;
    const uz = lz + warpZ;

    // Combine asymmetric peak lobes smoothly (smooth-max via soft envelope).
    let mask = 0;
    for (const l of lobes) {
      const qx = (ux - l.cx) / l.sx;
      const qz = (uz - l.cz) / l.sz;
      const d2 = qx * qx + qz * qz;
      if (d2 < 2.2) {
        const g = Math.exp(-d2 * 1.75) * l.w;
        mask = Math.max(mask, g) + Math.min(mask, g) * 0.32;
      }
    }
    // Carve an organic shoreline cove so coast bends naturally.
    const cd2 = ((ux - coveX) / 0.34) ** 2 + ((uz - coveZ) / 0.34) ** 2;
    mask = Math.max(0, mask - Math.exp(-cd2 * 1.8) * 0.35);

    // Hard fade to zero at the outer boundary of the patch grid so mesh perimeter sits cleanly underwater.
    const edgeR = Math.hypot(lx, lz);
    const boundary = 1 - THREE.MathUtils.smoothstep(edgeR, 0.72, 1.0);
    mask *= boundary;

    if (mask <= 1e-4) return skirt;

    // Sculpted elevation: asymmetric ridged mountain spines, eroded gullies and coastal bluff spurs.
    const nx = wx * freqScale * 1.15;
    const nz = wz * freqScale * 1.15;
    const broad = fbmCPU(nx, nz, 4, spec.seed + 71) * 0.5 + 0.5;
    const ridge = ridgedCPU(nx * 1.25, nz * 1.25, 4, spec.seed + 109);
    const fineRidge = ridgedCPU(nx * 2.9 + 4.1, nz * 2.9 - 2.3, 3, spec.seed + 157);
    const relief = THREE.MathUtils.lerp(broad * 0.6 + ridge * 0.4, ridge * 0.8 + broad * 0.2, crag);

    // Asymmetric coastal shoulder: steeper windward cliff, gentler tapering leeward headland spur.
    const skew = 0.86 + 0.28 * THREE.MathUtils.smoothstep(ux, -0.6, 0.6);
    const shaped = Math.pow(Math.min(1, mask * 1.22), THREE.MathUtils.lerp(1.18, 0.84, crag));
    let h = shaped * spec.height * skew * (0.40 + 0.82 * relief) - (1 - fineRidge) * spec.height * 0.12 * shaped;

    // Optional subtle coastal benching / bluff shelves (avoiding uniform steps).
    if (terrace > 0 && h > 2.5) {
      const step = Math.max(8, spec.height * 0.22);
      const t = (h + broad * 3.5) / step;
      const frac = t - Math.floor(t);
      const bench = (Math.floor(t) + Math.pow(frac, 0.72)) * step - broad * 3.5;
      h = THREE.MathUtils.lerp(h, bench, terrace * THREE.MathUtils.smoothstep(h, 3, 22));
    }

    // Smooth underwater apron below sea level.
    const above = THREE.MathUtils.smoothstep(mask, 0.06, 0.22);
    return THREE.MathUtils.lerp(skirt, h, above);
  };
}

// World-space horizon elevations in eight compass directions. A single bake lets
// headlands outside the moving shadow map still cast shadows into their gullies.
function bakeHorizons(geometry: THREE.PlaneGeometry, spec: HeadlandSpec, segments: number): void {
  const pos = geometry.getAttribute('position'), stride = segments + 1;
  const cellX = spec.radiusX * 2.15 / segments, cellZ = spec.radiusZ * 2.15 / segments;
  const rotation = spec.rotation ?? 0;
  const step = Math.min(cellX, cellZ);
  const cardinals = new Uint8Array(pos.count * 4), diagonals = new Uint8Array(pos.count * 4);
  for (let direction = 0; direction < 8; direction++) {
    const angle = direction * Math.PI / 4;
    const du = Math.cos(angle - rotation) * step / cellX;
    const dv = Math.sin(angle - rotation) * step / cellZ;
    const field = direction % 2 ? diagonals : cardinals;
    const channel = direction >> 1;
    for (const distance of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const di = Math.round(du * distance), dj = Math.round(dv * distance);
      if (di === 0 && dj === 0) continue;
      const dx = di * cellX, dz = dj * cellZ, flatSquared = dx * dx + dz * dz;
      for (let z = Math.max(0, -dj); z <= Math.min(segments, segments - dj); z++) {
        let at = z * stride + Math.max(0, -di);
        const end = z * stride + Math.min(segments, segments - di);
        for (; at <= end; at++) {
          const rise = pos.getY(at + dj * stride + di) - pos.getY(at);
          if (rise <= 0) continue;
          const sine = rise / Math.sqrt(flatSquared + rise * rise);
          const index = at * 4 + channel;
          field[index] = Math.max(field[index], Math.round(sine * 255));
        }
      }
    }
  }
  geometry.setAttribute('horizonCardinal', new THREE.Uint8BufferAttribute(cardinals, 4, true));
  geometry.setAttribute('horizonDiagonal', new THREE.Uint8BufferAttribute(diagonals, 4, true));
}

/** Include nearby crowns in the same eight horizons as the underlying terrain.
 * Bake once in world space. At runtime the sun can move through the canopy and
 * skylight remains attenuated underneath it, beyond the shadow camera's reach. */
export function addCanopyHorizons(mesh: THREE.Mesh, trees: ReadonlyArray<{x: number; y: number; z: number; scale: number}>,
  crownHeight: number, radius: number, halfHeight: number): void {
  const geometry = mesh.geometry, pos = geometry.getAttribute('position');
  const cardinal = geometry.getAttribute('horizonCardinal') as THREE.BufferAttribute;
  const diagonal = geometry.getAttribute('horizonDiagonal') as THREE.BufferAttribute;
  const bins = new Map<string, number[]>(), cell = 24;
  const world = new THREE.Vector3(), positions = new Float32Array(pos.count * 3);
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < pos.count; i++) {
    world.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (world.y < -1) continue;
    world.toArray(positions, i * 3);
    const key = Math.floor(world.x / cell) + ',' + Math.floor(world.z / cell);
    let vertices = bins.get(key);
    if (!vertices) bins.set(key, vertices = []);
    vertices.push(i);
  }
  const axes = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
  for (const tree of trees) {
    const r = radius * tree.scale, centreY = tree.y + crownHeight * tree.scale;
    const halfY = halfHeight * tree.scale, reach = tree.scale * (3 * crownHeight + radius);
    for (let bz = Math.floor((tree.z - reach) / cell); bz <= Math.floor((tree.z + reach) / cell); bz++) {
      for (let bx = Math.floor((tree.x - reach) / cell); bx <= Math.floor((tree.x + reach) / cell); bx++) {
        const vertices = bins.get(bx + ',' + bz);
        if (!vertices) continue;
        for (const i of vertices) {
          const dx = tree.x - positions[3*i], dz = tree.z - positions[3*i+2], dy = centreY - positions[3*i+1];
          if (dy + halfY <= 0 || dx*dx + dz*dz > reach*reach) continue;
          for (let dir = 0; dir < 8; dir++) {
            const [ux, uz] = axes[dir], across = dx*uz - dz*ux, along = dx*ux + dz*uz;
            if (Math.abs(across) >= r) continue;
            const section = Math.sqrt(1 - across*across / (r*r));
            if (along + section*r <= 0) continue;
            // Tangent from the receiver to the vertical ellipse of the crown.
            const a = along/r, b = dy/halfY, distance = Math.hypot(a,b);
            const angle = Math.min(Math.PI/2, Math.atan2(b,a) + Math.asin(Math.min(1, section / distance)));
            if (angle <= 0) continue;
            const rise = halfY * Math.sin(angle), run = r * Math.cos(angle);
            const horizon = 0.93 * rise / Math.hypot(rise,run);
            const attribute = dir % 2 ? diagonal : cardinal, channel = dir >> 1;
            if (horizon > attribute.getComponent(i,channel)) attribute.setComponent(i,channel,horizon);
          }
        }
      }
    }
  }
  cardinal.needsUpdate = diagonal.needsUpdate = true;
}

/** Relax loose upper slopes towards their angle of repose. Pairwise transfers
 * conserve material and leave the wave-cut cliff and submerged apron in place. */
function settleTalus(heights: Float32Array, seg: number, dx: number, dz: number, crag: number): void {
  const stride = seg + 1, change = new Float32Array(heights.length);
  const grade = 0.70 + 0.34 * crag;
  function transfer(a: number, b: number, distance: number): void {
    const low = Math.min(heights[a], heights[b]);
    if (low <= 1.5) return;
    const difference = heights[a] - heights[b];
    const loose = Math.abs(difference) - grade * distance;
    if (loose <= 0) return;
    const amount = Math.sign(difference) * Math.min(1, (low - 1.5) * 0.25) * loose * 0.12;
    change[a] -= amount;
    change[b] += amount;
  }
  const diag = Math.hypot(dx, dz);
  for (let pass = 0; pass < 8; pass++) {
    change.fill(0);
    for (let z = 0; z < seg; z++) for (let x = 0; x < seg; x++) {
      const i = z * stride + x;
      transfer(i, i + 1, dx); transfer(i, i + stride, dz);
      transfer(i, i + stride + 1, diag); transfer(i + 1, i + stride, diag);
    }
    for (let i = 0; i < heights.length; i++) heights[i] += change[i];
  }
}

/** Route contributing area downhill before cutting drainage into the bedrock.
 * Each cell splits runoff between lower neighbours according to grade. Flow
 * joins at saddles and hollows instead of radiating from a prescribed peak. */
function erodeDrainage(heights: Float32Array, seg: number, width: number, depth: number, relief: number): Float32Array {
  const stride = seg + 1, count = heights.length;
  const area = new Float32Array(count).fill(1), drainage = new Float32Array(count);
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  order.sort((a,b) => heights[b] - heights[a]);
  const dx = width / seg, dz = depth / seg, diagonal = Math.hypot(dx, dz);
  const offsets = [-stride-1, -stride, -stride+1, -1, 1, stride-1, stride, stride+1];
  const distance = [diagonal, dz, diagonal, dx, dx, diagonal, dz, diagonal];
  const weights = new Float64Array(8), cut = new Float32Array(count);
  for (const i of order) {
    const y = heights[i], x = i % stride;
    if (y < 0 || i < stride || i >= count - stride || x === 0 || x === seg) continue;
    let sum = 0, steepest = 0;
    for (let n = 0; n < 8; n++) {
      const slope = Math.max(0, (y - heights[i + offsets[n]]) / distance[n]);
      steepest = Math.max(steepest, slope);
      weights[n] = slope * slope * slope * slope;
      sum += weights[n];
    }
    if (sum === 0) continue;
    for (let n = 0; n < 8; n++) area[i + offsets[n]] += area[i] * weights[n] / sum;
    const catchment = (area[i] - 1) * dx * dz;
    const channel = THREE.MathUtils.smoothstep(Math.log1p(catchment / (width * depth * 0.00016)), 0.7, 3.85);
    drainage[i] = channel * THREE.MathUtils.smoothstep(y, 0.3, 3.8);
    cut[i] = Math.min(y * 0.22, relief * 0.078 * drainage[i] * Math.min(1, Math.sqrt(steepest)));
  }
  for (let i = 0; i < count; i++) heights[i] -= cut[i];
  return drainage;
}

/** Build a single irregular headland BufferGeometry in world space. */
export function createHeadlandGeometry(spec: HeadlandSpec): { geometry: THREE.BufferGeometry; heightAt: (x: number, z: number) => number } {
  const seg = Math.max(2, Math.floor(spec.segments ?? 48));
  const sample = makeHeadlandSampler(spec);
  const rot = spec.rotation ?? 0;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);

  const width = spec.radiusX * 2.15, depth = spec.radiusZ * 2.15;
  const heights = new Float32Array((seg + 1) * (seg + 1));
  const g = new THREE.PlaneGeometry(width, depth, seg, seg);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getZ(i);
    const wx = spec.x + lx * cosR - lz * sinR;
    const wz = spec.z + lx * sinR + lz * cosR;
    heights[i] = sample(wx, wz);
    pos.setXYZ(i, wx, heights[i], wz);
  }
  const drainage = erodeDrainage(heights, seg, width, depth, spec.height);
  g.setAttribute('drainage', new THREE.BufferAttribute(drainage, 1));
  settleTalus(heights, seg, width / seg, depth / seg, spec.cragginess ?? 0.55);
  for (let i = 0; i < heights.length; i++) pos.setY(i, heights[i]);
  g.computeVertexNormals();
  bakeHorizons(g, spec, seg);
  // The outer apron meets the seabed. Rendering coplanar rectangles between
  // unrelated islands caused dark seams through clear water and wasted fill.
  const index = g.getIndex()!, shore: number[] = [], floor = spec.skirtDepth ?? -14;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    if (Math.max(heights[a], heights[b], heights[c]) > floor + 1e-4) shore.push(a, b, c);
  }
  g.setIndex(shore);

  // Use the rendered triangle for tree roots, boulder footings and shore
  // probes. A continuous noise surface may lie metres above a coarse triangle.
  const heightAt = (x: number, z: number): number => {
    const dx = x - spec.x, dz = z - spec.z;
    const gx = ((dx * cosR + dz * sinR) / width + 0.5) * seg;
    const gz = ((dz * cosR - dx * sinR) / depth + 0.5) * seg;
    if (gx < 0 || gz < 0 || gx > seg || gz > seg) return floor;
    const ix = Math.min(seg - 1, Math.floor(gx)), iz = Math.min(seg - 1, Math.floor(gz));
    const u = gx - ix, v = gz - iz, i = iz * (seg + 1) + ix;
    const a = heights[i], b = heights[i + 1], c = heights[i + seg + 1], d = heights[i + seg + 2];
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  };
  return { geometry: g, heightAt };
}

type Woodland = 'broadleaf' | 'evergreen';

/** Ground distant stands on the eroded mesh. A single depth slice per view
 * retains bough silhouettes at this scale for twelve triangles per tree. */
function distantGroves(reg: SceneryRegistry, land: BuiltHeadlands, woodland: Woodland): void {
  const trees: TreePlacement[] = [];
  const evergreen = woodland === 'evergreen';
  for (const hill of land.specs) {
    const random = mulberry32(hill.seed + 628);
    const c = Math.cos(hill.rotation ?? 0), s = Math.sin(hill.rotation ?? 0);
    const count = Math.min(1900, Math.ceil(Math.PI * hill.radiusX * hill.radiusZ / 138));
    const first = trees.length;
    for (let attempt = 0; attempt < count * 6 && trees.length - first < count; attempt++) {
      const u = (random() * 2 - 1) * hill.radiusX, v = (random() * 2 - 1) * hill.radiusZ;
      const x = hill.x + c * u - s * v, z = hill.z + s * u + c * v;
      if (noise2D(x * 0.012, z * 0.012, 67) < -0.18) continue;
      const y = land.heightAt(x,z);
      if (y < 4 || y > hill.height*0.94 || land.slopeAt(x,z)<0.70) continue;
      const exposure = Math.min(1,y/hill.height), tone = 0.72 + random()*0.32;
      trees.push({x,y:y-0.22,z,scale:(0.62+random()*0.87)*(1-0.24*exposure),rotY:random()*Math.PI*2,
        tint:[tone*(0.9+random()*0.15),tone,tone*(0.86+random()*0.13)]});
    }
  }
  const grove = buildCoastalCanopy(reg, trees, evergreen?'pine':'tropical',
    { seed:7403, distant:true, castShadow:false, name:'wooded coastal ridges' });
  if (grove) land.mesh.add(grove);
}

/**
 * Merge a collection of organic headlands / distant coastal ranges into ONE draw call,
 * while exposing an exact combined `heightAt(x, z)` and `slopeAt(x, z)` for grounded dressing.
 */
export function buildHeadlands(
  reg: SceneryRegistry,
  specs: HeadlandSpec[],
  material: THREE.Material,
  options: { name?: string; castShadow?: boolean; receiveShadow?: boolean; woodland?: Woodland } = {},
): BuiltHeadlands {
  const parts: THREE.BufferGeometry[] = [];
  const samplers: Array<{ spec: HeadlandSpec; fn: (x: number, z: number) => number; maxR: number }> = [];

  for (const spec of specs) {
    // Resolve near gullies and distant ridge silhouettes. The old submerged
    // grid area is omitted from the index buffer at every resolution.
    const longAxis = Math.max(spec.radiusX, spec.radiusZ);
    const segments = Math.min(112, Math.max(spec.segments ?? 48, Math.ceil(Math.sqrt(longAxis) * 4.1)));
    const built = createHeadlandGeometry({ ...spec, segments });
    parts.push(built.geometry);
    samplers.push({ spec, fn: built.heightAt, maxR: Math.max(spec.radiusX, spec.radiusZ) * 1.15 });
  }

  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
  if (parts.length > 1) parts.forEach((p) => p.dispose());
  reg.trackGeometry(merged);

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = options.name ?? 'coastal-headlands';
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.frustumCulled = false;
  reg.group.add(mesh);

  const heightAt = (x: number, z: number): number => {
    let best = -50;
    for (const s of samplers) {
      const dx = x - s.spec.x, dz = z - s.spec.z;
      if (dx * dx + dz * dz > s.maxR * s.maxR) continue;
      const h = s.fn(x, z);
      if (h > best) best = h;
    }
    return best;
  };

  const slopeAt = (x: number, z: number): number => {
    const e = 2.0;
    const hx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const hz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return 1 / Math.sqrt(1 + hx * hx + hz * hz);
  };

  const land = { mesh, heightAt, slopeAt, specs };
  if (options.woodland) distantGroves(reg, land, options.woodland);
  return land;
}

// ---- sculpted angular coastal boulders & sea-stacks -------------------------------

export interface RockPlacement {
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotY: number;
  tiltX?: number;
  tiltZ?: number;
  variant?: number;
}

/** Build 3 distinct angular-organic rock geometries (stratified displaced polyhedra). */
export function createRockVariants(reg: SceneryRegistry, seed = 31): THREE.BufferGeometry[] {
  const variants: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 3; v++) {
    const rand = mulberry32(seed + v * 97);
    const g = new THREE.IcosahedronGeometry(1, 3);
    const pos = g.attributes.position as THREE.BufferAttribute;
    // Randomize fracture planes so boulders have crisp flat geological facets + weathered bevels.
    const planes = Array.from({ length: 5 }, () => {
      const n = new THREE.Vector3(rand() - 0.5, (rand() - 0.35) * 0.9, rand() - 0.5).normalize();
      return { n, d: 0.62 + rand() * 0.28 };
    });
    const stretchX = 0.85 + rand() * 0.45;
    const stretchY = 0.55 + rand() * 0.35;
    const stretchZ = 0.8 + rand() * 0.45;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const n = fbmCPU(tmp.x * 1.9 + v * 5.1, tmp.z * 1.9 + tmp.y * 1.7, 3, seed + v * 37);
      let r = 1.0 + n * 0.32;
      // Subtle horizontal bedding step
      r += Math.sin(tmp.y * 7.5 + v * 2.1) * 0.045;
      tmp.multiplyScalar(r);
      for (const pl of planes) {
        const proj = tmp.dot(pl.n);
        if (proj > pl.d) tmp.addScaledVector(pl.n, (pl.d - proj) * 0.58);
      }
      // Slightly flatten underside so rocks sit solidly on sand/shorelines.
      if (tmp.y < -0.35) tmp.y = -0.35 + (tmp.y + 0.35) * 0.3;
      tmp.set(tmp.x * stretchX, tmp.y * stretchY, tmp.z * stretchZ);
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    // The source polyhedron has disjoint triangles. Smooth weathered faces
    // across their shared positions while leaving steep fracture edges crisp.
    variants.push(reg.trackGeometry(toCreasedNormals(g, Math.PI * 0.27)));
  }
  return variants;
}

/** Instanced coastal boulders, breakwater riprap and sea stacks (up to 3 draw calls total). */
export function buildRockClusters(
  reg: SceneryRegistry,
  placements: RockPlacement[],
  material: THREE.Material,
  options: { name?: string; castShadow?: boolean; receiveShadow?: boolean; seed?: number } = {},
): THREE.InstancedMesh[] {
  if (placements.length === 0) return [];
  const variants = createRockVariants(reg, options.seed ?? 31);
  const buckets: RockPlacement[][] = [[], [], []];
  placements.forEach((p, idx) => buckets[(p.variant ?? idx) % 3].push(p));

  const meshes: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  buckets.forEach((list, v) => {
    if (list.length === 0) return;
    const im = new THREE.InstancedMesh(variants[v], material, list.length);
    im.name = `${options.name ?? 'coastal-rocks'}-${v}`;
    im.castShadow = options.castShadow ?? true;
    im.receiveShadow = options.receiveShadow ?? true;
    im.frustumCulled = false;
    list.forEach((p, i) => {
      e.set(p.tiltX ?? 0, p.rotY, p.tiltZ ?? 0);
      q.setFromEuler(e);
      pos.set(p.x, p.y, p.z);
      scl.set(p.scaleX, p.scaleY, p.scaleZ);
      m.compose(pos, q, scl);
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    reg.group.add(im);
    meshes.push(im);
  });
  return meshes;
}
