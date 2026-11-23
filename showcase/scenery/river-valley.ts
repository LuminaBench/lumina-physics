import type { WorldBus } from '../../engine/world-bus';
import { SceneryRegistry } from './materials';
import { buildCoastalCanopy, type TreePlacement } from './vegetation';
import { canopyBendNode } from '../../modules/strands/canopy';
import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, spriteNoise } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';
import { perturbNormalHeight } from '../../modules/materials/common';

const smooth = THREE.MathUtils.smoothstep;
const ridge = (x: number, z: number) =>
  Math.sin(x * 0.35 + Math.sin(z * 0.21)) * 0.55 + Math.sin(z * 0.52 + x * 0.24) * 0.32 + Math.sin(x * 1.4 - z * 0.8) * 0.13;

/** Upstream of z = -33 the channel bends 16 m to the left around a forested spur, so the
 * view up the valley ends on wooded slopes instead of running straight out to the sky.
 * Everything downstream of z = -33 (physics heightfield, bank vegetation, the QA upper
 * station at z = -32) keeps the original centreline exactly. */
const BEND = -16;
export function riverCenter(z: number): number {
  return 2.4 * Math.sin(z * 0.052) + 0.05 * z + BEND * smooth(-z, 33, 66);
}
export const fallsZ = -17;
export const crestY = 5.5;
/** Upper-reach water surface: level over the brink, then climbing toward the valley head
 * (~0.4 % at z = -32, ~7 % at z = -100), as a mountain stream does above a fall. */
export function upperWater(z: number): number {
  const run = Math.max(0, -24 - z);
  return crestY + 0.004 * run + 0.00045 * run * run;
}
export function valleyHeight(x: number, z: number): number {
  const distance = Math.abs(x - riverCenter(z));
  // The lip stays level beneath the falling sheet. Bedrock shelves on either
  // bank retreat at different rates instead of cutting one straight wall.
  const bankEdge = smooth(distance, 3.6, 13);
  const stepZ = fallsZ + bankEdge * (3.4 * Math.sin(x * 0.38 + 0.7) + 2.2 * Math.sin(x * 0.12));
  const lip = 1 - smooth(z, stepZ - 1.8 - 2.5 * bankEdge, stepZ + 0.65 + 3.2 * bankEdge);
  const watershed = smooth(-z, 56, 99) * (11 + 5 * Math.sin(x * 0.039 + 1.4) + 3 * Math.cos(z * 0.041 - x * 0.033));
  const bank = smooth(distance, 4.4 + 0.72 * ridge(x, z), 8.3);
  // Valley walls steepen upstream (only beyond z = -26) into a closed, wooded valley head.
  const upstream = smooth(-z, 26, 62);
  const hill = Math.max(0, distance - 8) * (0.27 + 0.4 * upstream) + Math.max(0, -z - 35) * 0.065;
  const h = -1.05 + crestY * lip + watershed + bank * (2.15 + hill + 0.94 * ridge(x * 0.54, z * 0.71))
    + ridge(x, z) * (0.3 + 0.45 * bank) + Math.sin(x * 0.22 + z * 0.1) * hill * 0.28;
  // The upper reach carves its own bed below the climbing water surface. Without it the
  // rising watershed buried the river from z ≈ -66 and left a bare chute up to the sky.
  const reach = smooth(-z, 23, 26);
  if (reach <= 0) return h;
  const carved = upperWater(z) - 0.95 + 1.55 * smooth(distance, 3.8, 7) + Math.max(0, distance - 7) * 1.6;
  return h + (Math.min(h, carved) - h) * reach;
}

/** Four slender branchlets with distinct leaf spacing. Transparent margins and narrow
 * tips survive minification through ordinary mipmaps and alpha testing. */
function leafSprigs(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const width = 128, height = 192;
  canvas.width = width * 4; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(3589);
  for (let variety = 0; variety < 4; variety++) {
    ctx.save();
    ctx.translate(variety * width, 0);
    const foot = 56 + rand() * 16, bend = 0.08 * (rand() - 0.5);
    ctx.strokeStyle = '#695f3b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(foot, 185); ctx.lineTo(foot + bend * 180, 5); ctx.stroke();
    for (let i = 0; i < 14; i++) {
      const progress = (i + 0.5) / 15, y = 177 - progress * 166, x = foot + (185 - y) * bend;
      const side = i % 2 ? 1 : -1;
      const length = (19 + Math.sin(progress * Math.PI) * 28) * (0.8 + rand() * 0.33);
      const endY = y - 12 - rand() * 17;
      const endX = x + side * length;
      const breadth = 5 + rand() * 6;
      const g = ctx.createLinearGradient(x, y, endX, endY);
      const light = Math.floor(8 * rand() + progress * 10);
      g.addColorStop(0, 'rgb('+ (47+light) +','+(68+light)+','+(32+light)+')');
      g.addColorStop(0.56, 'rgb('+(64+light)+','+(88+light)+','+(44+light)+')');
      g.addColorStop(1, 'rgb('+(79+light)+','+(105+light)+','+(50+light)+')');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x,y);
      ctx.quadraticCurveTo(x + side * length * 0.55, endY - breadth, endX, endY);
      ctx.quadraticCurveTo(x + side * length * 0.74, y + breadth, x, y);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,181,115,0.36)'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(endX,endY); ctx.stroke();
    }
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

/** Regional bedding shared by the cliff mesh, slab blocks and rock shaders: a gently
 * dipping, warped layer coordinate (beds ≈ 0.65 m) so strata line up across neighbouring
 * rock instead of each stone carrying its own unrelated pattern. */
const DIP_X = 0.045, DIP_Z = -0.03, BED = 1.55;
function strataCoord(x: number, y: number, z: number): number {
  // Beds vary from ~0.45 to ~1 m: identical 0.65 m steps read as stacked masonry.
  return (y + DIP_X * x + DIP_Z * z + 0.22 * Math.sin(x * 0.31 + z * 0.17)) * BED + 0.5 * Math.sin(y * 1.1 + x * 0.13);
}
const hash1 = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
function strataNode(p: N): N {
  return p.y.add(p.x.mul(DIP_X)).add(p.z.mul(DIP_Z)).add(TSL.sin(p.x.mul(0.31).add(p.z.mul(0.17))).mul(0.22)).mul(BED)
    .add(TSL.sin(p.y.mul(1.1).add(p.x.mul(0.13))).mul(0.5));
}
const hashNode = (n: N): N => TSL.fract(TSL.sin(n.mul(12.9898)).mul(43758.5453));

/** Four age/erosion profiles. Intersect rough ellipsoids with inclined fracture
 * planes, retaining rounded shoulders between the split faces. Profiles 2–3 are bedded
 * slabs: each bed steps back at its base, so ledges catch sun over shadowed notches. */
function riverStone(profile: number): THREE.BufferGeometry {
  const stratified = profile >= 2;
  // Rounded boulders stay at 500 triangles (detail 4 = 20·5²). Bedded slabs need ~3
  // vertex rings per bed to resolve their ledges: detail 6 (980 triangles), used only for
  // the minority of stones that are slabs.
  const shell = new THREE.IcosahedronGeometry(1, stratified ? 6 : 4);
  shell.deleteAttribute('normal');
  shell.deleteAttribute('uv');
  const rock = mergeVertices(shell);
  shell.dispose();
  const points = rock.getAttribute('position');
  const random = mulberry32(2771 + profile * 97);
  const faces: { x: number; y: number; z: number; distance: number }[] = [];
  for (let face = 0; face < 5; face++) {
    const theta = 2.4 * face + random() * 0.62;
    // Slabs split along their bedding (top and base faces) as well as steep joints.
    const y = face === 0 ? 0.95 : stratified && face === 1 ? -0.97 : random() * 1.3 - 0.6;
    const radial = Math.sqrt(1 - y * y);
    faces.push({ x: Math.cos(theta)*radial, y, z: Math.sin(theta)*radial,
      distance: (stratified ? 0.56 : 0.63) + random() * 0.23 + (profile % 2) * 0.15 });
  }
  const bedPhase = random();
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), z = points.getZ(i);
    let radius = 1 + 0.12*Math.sin(3.2*x + 3.7*z + profile) + 0.08*Math.cos(4.1*y - 1.7*x + profile);
    for (const f of faces) {
      const projected = x*f.x + y*f.y + z*f.z;
      if (projected > 0.35) radius = Math.min(radius, f.distance/projected);
    }
    if (stratified) {
      const bed = (y + 1) * 2.0 + bedPhase, f = bed - Math.floor(bed);
      radius *= 1 - (0.085 + 0.03 * hash1(Math.floor(bed) + profile)) * (1 - smooth(f, 0, 0.3)) * Math.sqrt(1 - y * y);
    }
    points.setXYZ(i, x*radius + 0.14*y, y*radius, z*radius + 0.07*x);
  }
  rock.computeVertexNormals();
  return rock;
}

/** Cliff behind and beside the fall. Rows follow the terrain step (the valley
 * heightfield, and therefore physics, is unchanged), stand vertical under the brink and
 * protrude as stratified beds with undercut notches and offset vertical joints. A short
 * cap shelf runs under the brink so the water pours over rock, not over a hanging edge. */
function fallsCliff(material: THREE.Material): THREE.Mesh {
  const crestZ = fallsZ - 1, crestX = riverCenter(crestZ);
  const cols = 72, faceRows = 56, span = 20;
  const capShelf = [[-0.18, 0.03], [-1.2, -0.04], [-2.6, -0.45]];
  const rows = faceRows + 1 + capShelf.length;
  const positions = new Float32Array((cols + 1) * rows * 3);
  const relief = (x: number, y: number, z: number): number => {
    const L = strataCoord(x, y, z), layer = Math.floor(L), f = L - layer;
    const resist = 0.45 + 0.55 * hash1(layer);
    // Undercut notch at each bed's base, full face mid-bed, eroded rounded top edge.
    const bed = smooth(f, 0, 0.22) * (1 - 0.3 * smooth(f, 0.7, 1));
    // Near-vertical joints split beds into blocks, offset bed to bed.
    const j = x * 0.55 + hash1(layer + 31.7) * 3 + 0.08 * Math.sin(y * 2.1), jf = j - Math.floor(j);
    const joint = 1 - smooth(Math.min(jf, 1 - jf), 0, 0.07);
    return 0.12 + resist * 0.34 * bed - 0.14 * joint + 0.05 * Math.sin(x * 1.7 + y * 3.1) * Math.sin(z * 2.3);
  };
  for (let i = 0; i <= cols; i++) {
    const x = crestX - span / 2 + (span * i) / cols, dx = Math.abs(x - crestX);
    const core = 1 - smooth(dx, 4.6, 6.4);
    // Highest terrain along the search window caps the solve, so rows never jump.
    let hMax = -Infinity;
    for (let z = crestZ + 6; z >= crestZ - 7; z -= 0.25) hMax = Math.max(hMax, valleyHeight(x, z));
    const cap = core * (crestY - 0.16) + (1 - core) * (hMax + 0.08);
    const bottom = Math.min(-0.9, valleyHeight(x, crestZ + 4) - 0.4);
    const fade = smooth(dx, 6.5, 9.8);
    const terrainZ = (y: number): number => {
      const target = Math.min(y, hMax - 0.03);
      let z = crestZ + 6;
      if (valleyHeight(x, z) >= target) return z;
      for (; z > crestZ - 7; z -= 0.25) if (valleyHeight(x, z - 0.25) >= target) break;
      let lo = z - 0.25, hi = z;
      for (let k = 0; k < 10; k++) { const mid = (lo + hi) / 2; if (valleyHeight(x, mid) >= target) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    const faceZ = (y: number) => crestZ - 0.22 - 0.09 * (cap - y);
    for (let j = 0; j <= faceRows; j++) {
      const y = bottom + ((cap - bottom) * j) / faceRows;
      const zT = terrainZ(y), zF = faceZ(y);
      const z = zT + (Math.max(zT, zF) - zT) * core;
      // Offset along the local terrain normal on the ramp, straight downstream on the face.
      const e = 0.3, gx = (valleyHeight(x + e, z) - valleyHeight(x - e, z)) / (2 * e);
      const gz = (valleyHeight(x, z + e) - valleyHeight(x, z - e)) / (2 * e);
      const onFace = zF > zT ? core : 0;
      let nx = -gx * (1 - onFace), ny = 1 * (1 - onFace) + 0.15 * onFace, nz = -gz * (1 - onFace) + onFace;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      // Keep the sill flush under the brink so it never reaches the falling sheet.
      const topClamp = 1 - core * 0.75 * (1 - smooth(y, cap, cap - 1.4));
      const r = (relief(x, y, z) - fade * 0.55) * topClamp;
      const o = (j * (cols + 1) + i) * 3;
      positions[o] = x + nx * r; positions[o + 1] = y + ny * r; positions[o + 2] = z + nz * r;
    }
    const top = faceZ(cap);
    capShelf.forEach(([dz, dy], k) => {
      const o = ((faceRows + 1 + k) * (cols + 1) + i) * 3;
      positions[o] = x; positions[o + 1] = cap + dy - fade * 0.5; positions[o + 2] = top + dz;
    });
  }
  const indices: number[] = [];
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const cliff = new THREE.Mesh(geometry, material);
  cliff.name = 'falls cliff';
  cliff.castShadow = cliff.receiveShadow = true;
  return cliff;
}

/** Tubes along a polyline with per-ring radius; `lobes` adds root buttresses at the base. */
function tube(path: THREE.Vector3[], radius: (t: number) => number, radial: number, lobes = 0, seed = 0): THREE.BufferGeometry {
  const positions: number[] = [], index: number[] = [];
  const tangent = new THREE.Vector3(), side = new THREE.Vector3(), normal = new THREE.Vector3(), ref = new THREE.Vector3(1, 0, 0);
  for (let k = 0; k < path.length; k++) {
    const t = k / (path.length - 1);
    tangent.subVectors(path[Math.min(k + 1, path.length - 1)], path[Math.max(k - 1, 0)]).normalize();
    side.crossVectors(tangent, Math.abs(tangent.x) > 0.9 ? normal.set(0, 0, 1) : ref).normalize();
    normal.crossVectors(side, tangent).normalize();
    for (let r = 0; r < radial; r++) {
      const theta = (r / radial) * Math.PI * 2;
      const buttress = lobes ? (1 - smooth(t, 0, 0.14)) * 0.55 * Math.max(0, Math.cos(lobes * theta + seed)) ** 2 : 0;
      const rr = radius(t) * (1 + buttress);
      positions.push(path[k].x + (side.x * Math.cos(theta) + normal.x * Math.sin(theta)) * rr,
        path[k].y + (side.y * Math.cos(theta) + normal.y * Math.sin(theta)) * rr,
        path[k].z + (side.z * Math.cos(theta) + normal.z * Math.sin(theta)) * rr);
    }
  }
  for (let k = 0; k < path.length - 1; k++) for (let r = 0; r < radial; r++) {
    const a = k * radial + r, b = k * radial + ((r + 1) % radial), c = a + radial, d = b + radial;
    index.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** One riparian tree form: a sinuous leaning trunk with buttressed root flare and
 * upswept branches that droop at their tips, crowned by leaf clusters. Three seeds give
 * three silhouettes at about the previous per-tree triangle count. */
function treeVariant(seed: number): { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry } {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const leafPosition: number[] = [], leafColor: number[] = [], leafUV: number[] = [];
  const shade = new THREE.Color();
  const leaf = (x: number, y: number, z: number, w: number, h: number, theta: number) => {
    const dx = Math.cos(theta) * w, dz = Math.sin(theta) * w;
    const tx = x + Math.sin(theta) * h * 0.42, tz = z - Math.cos(theta) * h * 0.42;
    leafPosition.push(x-dx,y,z-dz, x+dx,y,z+dz, tx+dx,y+h,tz+dz, x-dx,y,z-dz, tx+dx,y+h,tz+dz, tx-dx,y+h,tz-dz);
    const cell = Math.floor(rand() * 4) * 0.25;
    leafUV.push(cell,0, cell+0.25,0, cell+0.25,1, cell,0, cell+0.25,1, cell,1);
    for (let j = 0; j < 6; j++) leafColor.push(shade.r, shade.g, shade.b);
  };
  const cluster = (cx: number, cy: number, cz: number, count: number, spread: number) => {
    for (let j = 0; j < count; j++) {
      const theta = rand() * Math.PI * 2, radius = Math.sqrt(rand()) * spread;
      const crown = 1 - (radius / spread) ** 2;
      const light = 0.52 + crown * 0.27 + rand() * 0.19;
      shade.setRGB(light * (0.85 + rand() * 0.19), light, light * (0.91 + rand() * 0.12));
      leaf(cx + Math.cos(theta) * radius, cy + crown * rand() * 0.68 - 0.12, cz + Math.sin(theta) * radius,
        0.115 + rand() * 0.13, 0.26 + rand() * 0.27, theta);
    }
  };
  const height = 4.9 + rand() * 1.3;
  const leanX = (rand() - 0.5) * 0.7, leanZ = (rand() - 0.5) * 0.7, phase = rand() * 6.28;
  const trunk: THREE.Vector3[] = [];
  const at = (t: number, out = new THREE.Vector3()) => out.set(
    leanX * t * t + 0.13 * Math.sin(t * 5.2 + phase) * t,
    height * t - 0.3,
    leanZ * t * t + 0.11 * Math.cos(t * 4.3 + phase * 1.7) * t);
  for (let k = 0; k <= 7; k++) trunk.push(at(k / 7));
  const girth = 0.17 + rand() * 0.07;
  parts.push(tube(trunk, t => girth * (1 - 0.74 * t) + 0.1 * (1 - smooth(t, 0, 0.1)), 8, 3 + Math.floor(rand() * 2), phase));
  const branches = 15 + Math.floor(rand() * 4);
  for (let i = 0; i < branches; i++) {
    const t = 0.36 + 0.6 * (i / branches) + rand() * 0.04;
    const base = at(t);
    const azimuth = i * 2.39996 + rand() * 0.7;
    const dirX = Math.cos(azimuth), dirZ = Math.sin(azimuth);
    const len = (1 - t * 0.55) * (1.5 + rand() * 0.9);
    const rise = 0.55 + t * 0.6 + rand() * 0.25;
    const mid = new THREE.Vector3(base.x + dirX * len * 0.55, base.y + len * 0.45 * rise, base.z + dirZ * len * 0.55);
    const tip = new THREE.Vector3(mid.x + dirX * len * 0.5, mid.y + len * (0.18 * rise - 0.16), mid.z + dirZ * len * 0.5);
    const r0 = girth * (1 - 0.74 * t) * 0.55;
    parts.push(tube([base, mid, tip], s => r0 * (1 - 0.75 * s) + 0.012, 5));
    cluster(tip.x, tip.y, tip.z, 34 + Math.floor(rand() * 10), 0.75 + len * 0.15);
    cluster(mid.x, mid.y + 0.1, mid.z, 12, 0.5);
  }
  // A few short dead stubs below the crown break the clean pole.
  for (let i = 0; i < 3; i++) {
    const t = 0.16 + rand() * 0.16, base = at(t), azimuth = rand() * 6.28, len = 0.25 + rand() * 0.3;
    const tip = new THREE.Vector3(base.x + Math.cos(azimuth) * len, base.y + len * 0.35, base.z + Math.sin(azimuth) * len);
    parts.push(tube([base, tip], s => girth * 0.32 * (1 - 0.7 * s), 4));
  }
  const wood = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(leafPosition, 3));
  leaves.setAttribute('color', new THREE.Float32BufferAttribute(leafColor, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(leafUV, 2));
  leaves.computeVertexNormals();
  return { wood, leaves };
}

const BACKDROP_Z = -29;
/** Wooded ridges around the valley (m above datum): every horizon ends on hills, not on
 * the 160 m terrain edge. Below the terrain plane near its edges, rising beyond it. */
function ridgeHeight(r: number, a: number): number {
  const crest = 50 + 17 * Math.sin(3 * a + 0.4) + 10 * Math.sin(7 * a + 1.9) + 5 * Math.sin(13 * a + 0.3) + 2.5 * Math.sin(29 * a + 2.2);
  return crest * smooth(r, 70, 150) * (1 + 0.45 * smooth(r, 220, 560)) - 4;
}
const onTerrainPlane = (x: number, z: number) => Math.abs(x) < 80 && Math.abs(z - BACKDROP_Z) < 82;

function horizonRidges(): THREE.Mesh {
  const radii = [70, 82, 96, 112, 130, 152, 180, 215, 260, 320, 400, 500, 620], seg = 180;
  const positions: number[] = [], colors: number[] = [], index: number[] = [];
  const rand = mulberry32(5521), forest = new THREE.Color(), rock = new THREE.Color(0x3d3c38);
  for (let i = 0; i < radii.length; i++) for (let j = 0; j < seg; j++) {
    const a = (j / seg) * Math.PI * 2, r = radii[i] * (1 + 0.04 * Math.sin(a * 11 + i));
    const y = ridgeHeight(r, a);
    positions.push(Math.sin(a) * r, y, BACKDROP_Z - Math.cos(a) * r);
    // Dark conifer cover, thinning to grey rock on the highest crests.
    const crest = smooth(y, 55, 80);
    forest.setRGB(0.032, 0.046, 0.03).multiplyScalar(0.8 + rand() * 0.45).lerp(rock, crest * 0.7);
    colors.push(forest.r, forest.g, forest.b);
    if (i === 0) continue;
    const p0 = (i - 1) * seg + j, p1 = (i - 1) * seg + (j + 1) % seg;
    index.push(p0, p1, p0 + seg, p1, p1 + seg, p0 + seg);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 });
  // Canopy mottling at hill scale; the weather's fog node hazes the distance.
  material.colorNode = TSL.vec3(spriteNoise(TSL.positionWorld.xz.mul(0.045)).mul(0.5).add(0.75));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'horizon ridges';
  return mesh;
}

/** Chunky glacial boulders, riparian trees and fern understory use instanced geometry. */
export function buildRiverValley(world?:WorldBus): THREE.Group {
  const root = new THREE.Group();
  const random = mulberry32(14093);
  const place = new THREE.Object3D();
  const tint = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0), tilt = new THREE.Vector3(), yaw = new THREE.Quaternion();
  function instance(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
    const batch = new THREE.InstancedMesh(geometry, material, count);
    batch.receiveShadow = true;
    root.add(batch);
    return batch;
  }
  function set(batch: THREE.InstancedMesh, i: number, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, angle: number) {
    place.position.set(x, y, z); place.scale.set(sx, sy, sz); place.rotation.set(0, angle, 0);
    place.updateMatrix(); batch.setMatrixAt(i, place.matrix);
  }
  const crestZ = fallsZ - 1, crestX = riverCenter(crestZ);
  // The falling sheet and plunge entry stay clear of placed rock.
  const inFall = (x: number, z: number) => Math.abs(x - crestX) < 5.1 && z > crestZ - 0.9 && z < crestZ + 3.9;

  const ground = new THREE.PlaneGeometry(160, 164, 230, 240).rotateX(-Math.PI / 2).translate(0, 0, -29);
  const pos = ground.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const bedColor = new THREE.Color(0x665d4c), shale = new THREE.Color(0x655f52), moss = new THREE.Color(0x4f5636);
  const outcrop = new THREE.Color(0x56534c);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = valleyHeight(x, z);
    pos.setY(i, h);
    const above = smooth(h, 0.2, 2.8);
    tint.copy(bedColor).lerp(shale, smooth(h, -0.8, 0.5));
    tint.lerp(moss, above * (0.58 + 0.39 * ridge(x, z))).multiplyScalar(0.91 + 0.18 * ridge(x * 2, z * 2));
    // Soil cannot hold on steep ground: expose grey rock where the slope exceeds ~45°.
    const slope = Math.hypot(valleyHeight(x + 0.35, z) - valleyHeight(x - 0.35, z), valleyHeight(x, z + 0.35) - valleyHeight(x, z - 0.35)) / 0.7;
    tint.lerp(outcrop, smooth(slope, 0.85, 1.6) * 0.75);
    colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b;
  }
  ground.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.86 });
  const point = TSL.positionWorld;
  const uv = point.xz.add(point.y.mul(TSL.vec2(0.21, 0.52)));
  const grain = spriteNoise(uv.mul(12.1), 1);
  const strata = spriteNoise(uv.mul(TSL.vec2(1.4, 5)).add(grain.mul(0.14)));
  material.colorNode = TSL.vec3(grain.mul(0.41).add(strata.mul(0.61)).add(0.45));
  material.normalNode = perturbNormalHeight(strata.mul(0.026).add(grain.mul(0.004)), TSL.float(1));
  const land = new THREE.Mesh(ground, material);
  land.receiveShadow = true;
  root.add(land);

  // Mineral inclusions follow nonparallel cleavage planes; bedding partings follow the
  // shared regional strata. World coordinates keep grain size constant in metres.
  const stoneMat = new THREE.MeshStandardNodeMaterial({ color: 0xa9a7a2, roughness: 0.79 });
  const section = TSL.vec2(point.x.add(point.z.mul(0.43)), point.y.add(point.z.mul(0.67)).sub(point.x.mul(0.13)));
  const block = spriteNoise(section.mul(0.83));
  const patches = spriteNoise(section.mul(2.95).add(block.mul(0.59)), 1);
  const mineral = spriteNoise(section.mul(17.6).add(patches.mul(0.67)));
  const fissure = spriteNoise(section.mul(TSL.vec2(1.1, 4.8)).add(block.mul(1.65)), 1);
  const bedding = strataNode(point).add(patches.sub(0.5).mul(0.12));
  const bedFrac = TSL.fract(bedding);
  const parting = TSL.smoothstep(0.07, 0.0, bedFrac).add(TSL.smoothstep(0.95, 1.0, bedFrac)).mul(0.6);
  const seam = TSL.smoothstep(0.048, 0.012, fissure.sub(0.48).abs()).mul(TSL.smoothstep(0.33, 0.61, patches)).max(parting);
  const quartz = TSL.smoothstep(0.59, 0.85, mineral.mul(0.73).add(patches.mul(0.27)));
  const damp = TSL.smoothstep(0.53, -0.06, point.y.add(patches.sub(0.5).mul(0.24)));
  const bedTone = TSL.mix(TSL.float(0.86), TSL.float(1.1), hashNode(TSL.floor(bedding)));
  const lithology = TSL.mix(TSL.vec3(0.48,0.53,0.54), TSL.vec3(1.06,0.98,0.87), block).mul(bedTone);
  const base = TSL.materialColor.mul(lithology).mul(patches.mul(0.3).add(0.79))
    .mul(seam.mul(-0.34).add(1)).add(quartz.mul(TSL.vec3(0.07,0.06,0.05)));
  const mossPatch = TSL.smoothstep(0.49,0.75, patches.mul(0.58).add(block.mul(0.42)))
    .mul(TSL.smoothstep(0.08,0.84, TSL.normalWorld.y)).mul(damp.oneMinus());
  stoneMat.colorNode = TSL.mix(base.mul(damp.mul(-0.48).add(1)), base.mul(TSL.vec3(0.41,0.68,0.25)), mossPatch);
  stoneMat.normalNode = perturbNormalHeight(fissure.mul(0.015).add(mineral.mul(0.004)).sub(seam.mul(0.004)), TSL.float(1));
  stoneMat.roughnessNode = TSL.mix(patches.mul(0.13).add(0.71), mineral.mul(0.15).add(0.20), damp);

  // Cliff rock: per-bed tone, shadowed undercut notches, seep-darkened wet face behind
  // the fall and a splash zone over the pool, moss only on dry ledge tops.
  const cliffMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.84 });
  const L = strataNode(point), bedId = TSL.floor(L), withinBed = TSL.fract(L);
  const cliffGrain = spriteNoise(section.mul(6.3).add(block.mul(0.7)), 1);
  const seep = spriteNoise(TSL.vec2(point.x.mul(3.1), point.y.mul(0.32).add(point.x.mul(0.4))));
  const curtain = TSL.float(1).sub(TSL.smoothstep(4.0, 5.8, point.x.sub(crestX).abs()))
    .mul(TSL.smoothstep(crestY + 0.25, crestY - 0.5, point.y));
  const splash = TSL.smoothstep(1.8, 0.1, point.y).mul(TSL.smoothstep(9, 3.5, TSL.length(point.xz.sub(TSL.vec2(crestX, crestZ + 2.4)))));
  const wet = curtain.max(splash).max(TSL.smoothstep(0.62, 0.8, seep).mul(TSL.smoothstep(crestY + 1.5, crestY - 1, point.y)).mul(0.7)).clamp(0, 1);
  // Sandstone/shale reflectance ~0.17–0.30. At 0.30–0.47 the sunlit flanks of the fall
  // rendered near-white (sRGB ≈ 216/200/179 in the native capture).
  const cliffTone = TSL.mix(TSL.vec3(0.17, 0.162, 0.148), TSL.vec3(0.3, 0.282, 0.25), hashNode(bedId))
    .mul(cliffGrain.mul(0.3).add(0.82)).mul(block.mul(0.2).add(0.9));
  const notchShade = TSL.mix(TSL.float(0.5), TSL.float(1), TSL.smoothstep(0.0, 0.2, withinBed));
  const algae = TSL.smoothstep(0.9, 0.05, point.y).mul(wet);
  const ledgeMoss = TSL.smoothstep(0.55, 0.85, TSL.normalWorld.y).mul(wet.oneMinus()).mul(TSL.smoothstep(0.4, 0.7, patches));
  // Dark runoff stains hang below ledges: water and organic film streak the dry face.
  const stain = TSL.smoothstep(0.55, 0.82, spriteNoise(TSL.vec2(point.x.mul(2.3).add(point.z.mul(1.1)), point.y.mul(0.22)), 1)).mul(0.38);
  const cliffBase = cliffTone.mul(notchShade).mul(stain.oneMinus()).mul(TSL.mix(TSL.float(1), TSL.float(0.42), wet));
  cliffMat.colorNode = TSL.mix(TSL.mix(cliffBase, cliffBase.mul(TSL.vec3(0.55, 0.72, 0.42)), algae.mul(0.7)),
    cliffBase.mul(TSL.vec3(0.45, 0.66, 0.28)), ledgeMoss);
  cliffMat.roughnessNode = TSL.mix(cliffGrain.mul(0.1).add(0.8), TSL.float(0.24), wet);
  cliffMat.normalNode = perturbNormalHeight(cliffGrain.mul(0.012).add(mineral.mul(0.003)).add(withinBed.mul(0.01)), TSL.float(1));
  root.add(fallsCliff(cliffMat));

  // Placement first, batches second, so slabs and boulders can use different profiles.
  interface Rock { x: number; z: number; sx: number; sy: number; sz: number; angle: number; shade: number; profile: number; }
  const geometries = [0, 1, 2, 3].map(riverStone);
  // Lower-belt vertices of each profile: used to seat every stone on the actual terrain.
  const belts = geometries.map(geometry => {
    const p = geometry.getAttribute('position'), out: number[] = [];
    for (let i = 0; i < p.count; i += 2) if (p.getY(i) < -0.3) out.push(p.getX(i), p.getY(i), p.getZ(i));
    return out;
  });
  const v = new THREE.Vector3();
  /** Seat a stone into `place.matrix`: align 70 % with the terrain normal, then drop it
   * until no part of its lower belt hovers above the ground, plus a small embed so it
   * reads as set into the soil. Returns any hover left after the bounded sink. */
  function seat(rock: Rock): number {
    const e = 0.35;
    const gx = (valleyHeight(rock.x + e, rock.z) - valleyHeight(rock.x - e, rock.z)) / (2 * e);
    const gz = (valleyHeight(rock.x, rock.z + e) - valleyHeight(rock.x, rock.z - e)) / (2 * e);
    tilt.set(-gx, 1, -gz).normalize().lerp(up, 0.3).normalize();
    place.quaternion.setFromUnitVectors(up, tilt).multiply(yaw.setFromAxisAngle(up, rock.angle));
    place.scale.set(rock.sx, rock.sy, rock.sz);
    place.position.set(rock.x, valleyHeight(rock.x, rock.z) + rock.sy * 0.5, rock.z);
    place.updateMatrix();
    const belt = belts[rock.profile];
    let hover = -Infinity;
    for (let k = 0; k < belt.length; k += 3) {
      v.set(belt[k], belt[k + 1], belt[k + 2]).applyMatrix4(place.matrix);
      hover = Math.max(hover, v.y - valleyHeight(v.x, v.z));
    }
    const need = Math.max(0, hover) + rock.sy * 0.08, sink = Math.min(need, rock.sy * 1.1);
    place.position.y -= sink;
    place.updateMatrix();
    return need - sink;
  }
  // Stones cannot rest where the ground is too steep to seat them: resample (bounded).
  const accept = (rock: Rock, tries: number) => tries >= 24 || (!inFall(rock.x, rock.z) && seat(rock) < 0.02);
  const rocks: Rock[] = [];
  const looseStones = 340, ledgeBlocks = 76;
  for (let i = 0; i < looseStones; i++) {
    const rock: Rock = { x: 0, z: 0, sx: 1, sy: 1, sz: 1, angle: 0, shade: 1, profile: i % 4 === 3 ? 2 : i % 2 };
    for (let tries = 0; ; tries++) {
      rock.z = random() * 88 - 52;
      const outer = random() < 0.78;
      rock.x = riverCenter(rock.z) + (random() < 0.5 ? -1 : 1) * (outer ? 3.6 + random() * 6 : random() * 4);
      const size = 0.12 + random() ** 3.2 * (outer ? 1.65 : 1.04);
      rock.sx = size * 1.3; rock.sy = size; rock.sz = size * (0.78 + random() * 0.55); rock.angle = random() * 6.28;
      if (accept(rock, tries)) break;
    }
    rock.shade = 0.62 + random() * 0.67;
    rocks.push(rock);
  }
  // Bedded slabs lie flat along the brink and as talus beside the plunge pool; their
  // strata continue the cliff's. Keep the plunge pool and the sheet open.
  for (let i = 0; i < ledgeBlocks; i++) {
    const rock: Rock = { x: 0, z: 0, sx: 1, sy: 1, sz: 1, angle: 0, shade: 1, profile: 2 + (i % 2) };
    for (let tries = 0; ; tries++) {
      const bank = i % 2 ? -1 : 1, talus = random() < 0.4;
      rock.x = crestX + bank * (4.9 + random() ** 1.3 * 8);
      rock.z = talus ? crestZ + 1.5 + random() * 3.5 : crestZ - 4 + random() * 4.6;
      const size = 0.34 + random() ** 1.4 * 1.17;
      rock.sx = size * (1.35 + random()); rock.sy = size * 0.62; rock.sz = size * (0.95 + random() * 0.4);
      rock.angle = random() * 6.28;
      if (accept(rock, tries)) break;
    }
    rock.shade = 0.75 + random() * 0.4;
    rocks.push(rock);
  }
  // Fractured bedrock breaks through both banks of the upper reach and the bend.
  const bedrockRandom = mulberry32(7741);
  for (let i = 0; i < 46; i++) {
    const rock: Rock = { x: 0, z: 0, sx: 1, sy: 1, sz: 1, angle: 0, shade: 1, profile: 2 + (i % 2) };
    for (let tries = 0; ; tries++) {
      rock.z = -24 - bedrockRandom() * 82;
      rock.x = riverCenter(rock.z) + (i % 2 ? -1 : 1) * (5.6 + bedrockRandom() * 2.6);
      const size = 0.45 + bedrockRandom() ** 1.3 * 1.25;
      rock.sx = size * (1.4 + bedrockRandom()); rock.sy = size * 0.55; rock.sz = size * (1 + bedrockRandom() * 0.5);
      rock.angle = bedrockRandom() * 6.28;
      if (accept(rock, tries)) break;
    }
    rock.shade = 0.7 + bedrockRandom() * 0.4;
    rocks.push(rock);
  }
  const counts = [0, 0, 0, 0];
  for (const rock of rocks) counts[rock.profile]++;
  const stoneBatches = geometries.map((geometry, i) => {
    const batch = instance(geometry, stoneMat, counts[i]);
    batch.castShadow = true;
    return batch;
  });
  const contacts: { x: number; z: number; r: number }[] = [];
  const slots = [0, 0, 0, 0];
  for (const rock of rocks) {
    seat(rock);
    const batch = stoneBatches[rock.profile], slot = slots[rock.profile]++;
    batch.setMatrixAt(slot, place.matrix);
    const slab = rock.profile >= 2 && rock.sy < rock.sx * 0.6;
    tint.setRGB(slab ? 0.29 : 0.34, slab ? 0.32 : 0.36, slab ? 0.3 : 0.32).multiplyScalar(rock.shade);
    batch.setColorAt(slot, tint);
    if (rock.sy > 0.22) contacts.push({ x: rock.x, z: rock.z, r: Math.max(rock.sx, rock.sz) });
  }

  // Contact occlusion: soil darkens where stones sit, so they read as resting on it.
  const colsG = 231, cellX = 160 / 230, cellZ = 164 / 240;
  for (const c of contacts) {
    const reach = c.r * 1.35;
    const i0 = Math.max(0, Math.floor((c.x - reach + 80) / cellX)), i1 = Math.min(230, Math.ceil((c.x + reach + 80) / cellX));
    const j0 = Math.max(0, Math.floor((c.z - reach + 111) / cellZ)), j1 = Math.min(240, Math.ceil((c.z + reach + 111) / cellZ));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * colsG + i;
      const d = Math.hypot(pos.getX(k) - c.x, pos.getZ(k) - c.z) / reach;
      if (d >= 1) continue;
      const occlusion = 1 - 0.42 * (1 - d) * (1 - d);
      colors[k * 3] *= occlusion; colors[k * 3 + 1] *= occlusion; colors[k * 3 + 2] *= occlusion;
    }
  }
  ground.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Bark: darker, damp and mossy at the root flare, pale lichen in patches, with
  // per-tree tone so a stand no longer reads as one cloned pole.
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  const furrow = spriteNoise(point.xz.add(point.y.mul(0.045)).mul(24));
  const blotch = spriteNoise(point.xz.add(point.y.mul(0.59)).mul(1.3), 1);
  const lichen = TSL.smoothstep(0.6, 0.78, spriteNoise(point.xz.mul(7.3).add(point.y.mul(2.1)), 1).mul(0.7).add(blotch.mul(0.3)));
  const rootZone = TSL.smoothstep(0.9, -0.2, TSL.positionGeometry.y);
  const barkTone = TSL.mix(TSL.vec3(0.035,0.03,0.025), TSL.vec3(0.15,0.13,0.104), furrow.mul(0.54).add(blotch.mul(0.46)));
  bark.colorNode = TSL.mix(TSL.mix(barkTone, TSL.vec3(0.2, 0.21, 0.17), lichen.mul(0.55)),
    barkTone.mul(TSL.vec3(0.55, 0.7, 0.36)), rootZone.mul(0.75));
  bark.normalNode = perturbNormalHeight(furrow.mul(0.012), TSL.float(1));
  const foliage = new THREE.MeshStandardNodeMaterial({ map: leafSprigs(), vertexColors: true,
    side: THREE.DoubleSide, alphaTest: 0.33, roughness: 0.86 });
  if(world){bark.positionNode=canopyBendNode(world,5.5,0.006);foliage.positionNode=canopyBendNode(world,5.5,0.007);}
  const variants = [7121, 9043, 12007].map(treeVariant);
  const treeCount = 176;
  const trunkBatches = variants.map((form, k) => instance(form.wood, bark, Math.ceil((treeCount - k) / variants.length)));
  const leafBatches = variants.map((form, k) => instance(form.leaves, foliage, trunkBatches[k].count));
  for (const batch of [...trunkBatches, ...leafBatches]) batch.castShadow = true;
  for (let i = 0; i < treeCount; i++) {
    const z = random() * 115 - 87, x = riverCenter(z) + (random() < 0.5 ? -1 : 1) * (8.6 + random() ** 1.3 * 35);
    const size = 0.55 + random() * 1.08, angle = random() * 6.28;
    // Seat the root flare on the lowest point under it so no side floats on a slope.
    const reach = 0.45 * size;
    const y = Math.min(valleyHeight(x, z), valleyHeight(x + reach, z), valleyHeight(x - reach, z),
      valleyHeight(x, z + reach), valleyHeight(x, z - reach)) - 0.06;
    const girth = 0.8 + random() * 0.4;
    const k = i % variants.length, slot = Math.floor(i / variants.length);
    set(trunkBatches[k], slot, x, y, z, size * girth, size * 1.2, size * girth, angle);
    set(leafBatches[k], slot, x, y, z, size, size * 1.2, size, angle);
    trunkBatches[k].setColorAt(slot, tint.setRGB(1, 1, 1).multiplyScalar(0.78 + random() * 0.4));
    const health = random();
    leafBatches[k].setColorAt(slot, tint.setRGB(0.92 + health * 0.12, 0.94 + health * 0.1, 0.86 + random() * 0.14));
  }
  // Distance: wooded ridges close the horizon; clumped canopy covers the outer slopes,
  // the spur inside the upstream bend and the near ridge band. Own generator, so the
  // near-field layout above is unchanged.
  const ridges = horizonRidges();
  root.add(ridges);
  const distant = new SceneryRegistry('watershed forest',world);
  root.add(distant.group);
  const forest: TreePlacement[][] = [[],[]];
  // The radial ridge mesh linearly interpolates amongst its rings. Plant on
  // the rendered triangles, including places where the two terrains overlap.
  const down = new THREE.Vector3(0,-1,0);
  const ray = new THREE.Raycaster(new THREE.Vector3(),down,0,300);
  const intersections: THREE.Intersection[] = [];
  const gridHeight = (x: number,z: number): number => {
    const u=(x+80)*230/160, v=(z+111)*240/164;
    if(u<0||u>=230||v<0||v>=240) return -Infinity;
    const col=Math.floor(u), row=Math.floor(v), a=row*231+col;
    const fx=u-col, fz=v-row;
    if(fx+fz<=1) return (1-fx-fz)*pos.getY(a)+fx*pos.getY(a+1)+fz*pos.getY(a+231);
    const c=a+232;
    return (fx+fz-1)*pos.getY(c)+(1-fx)*pos.getY(c-1)+(1-fz)*pos.getY(c-231);
  };
  const forestRandom = mulberry32(31337);
  for (let i = 0; i < 1040; i++) {
    let x = 0, z = 0, scale = 1, ok = false;
    for (let tries = 0; tries < 12 && !ok; tries++) {
      if (i < 560) {
        x = forestRandom() * 156 - 78; z = BACKDROP_Z + forestRandom() * 160 - 80;
        const off = Math.abs(x - riverCenter(z));
        ok = off > 20 || (z < -36 && off > 9.5);
        if (ok) scale = 5 + forestRandom() * 5;
      } else {
        const a = forestRandom() * Math.PI * 2, r = 74 + forestRandom() ** 1.4 * 170;
        x = Math.sin(a) * r; z = BACKDROP_Z - Math.cos(a) * r;
        ok = !onTerrainPlane(x, z);
        if (ok) scale = 9 + forestRandom() * 8;
      }
    }
    if (!ok) continue;
    let groundY=gridHeight(x,z);
    if(x*x+(z-BACKDROP_Z)**2>66*66) {
      ray.ray.origin.set(x,180,z);
      intersections.length=0;
      ray.intersectObject(ridges,false,intersections);
      if(intersections.length) groundY=Math.max(groundY,intersections[0].point.y);
    }
    if(!Number.isFinite(groundY)) continue;
    const k=forestRandom()<0.62?0:1, tone=0.76+0.28*forestRandom();
    forest[k].push({x,y:groundY-0.14,z,scale:scale*(k===0?0.105:0.11),
      rotY:forestRandom()*Math.PI*2,tint:[tone*0.93,tone,tone*0.89]});
  }
  buildCoastalCanopy(distant,forest[0],'pine',{seed:6421,distant:true,castShadow:false,name:'watershed pines'});
  buildCoastalCanopy(distant,forest[1],'tropical',{seed:3329,distant:true,castShadow:false,name:'watershed broadleaves'});
  const a = new THREE.Vector3(), b = new THREE.Vector3(), axis = new THREE.Vector3();
  // Local ferns have paired pinnae, curved rachises and different front/back
  // silhouettes at grazing angles. All clumps share one mesh and one material.
  const fernVerts: number[] = [], fernColors: number[] = [];
  function blade(base: THREE.Vector3, tip: THREE.Vector3, width: number, light: number) {
    axis.subVectors(tip, base);
    const len = Math.hypot(axis.x, axis.z) || 1;
    const wx = -axis.z / len * width, wz = axis.x / len * width;
    const mx = base.x + axis.x * 0.43, my = base.y + axis.y * 0.43 + width * 0.28, mz = base.z + axis.z * 0.43;
    fernVerts.push(base.x,base.y,base.z, mx+wx,my,mz+wz, tip.x,tip.y,tip.z,
      base.x,base.y,base.z, tip.x,tip.y,tip.z, mx-wx,my,mz-wz);
    tint.setRGB(0.055 * light, 0.115 * light, 0.024 * light);
    for (let k = 0; k < 6; k++) fernColors.push(tint.r, tint.g, tint.b);
  }
  for (let f = 0; f < 9; f++) {
    const angle = f * 2.39996, dx = Math.cos(angle), dz = Math.sin(angle);
    const reach = 0.34 + random() * 0.42, rise = 0.17 + random() * 0.25;
    for (let k = 1; k < 10; k++) {
      const t = k / 10;
      a.set(dx * reach * t, rise * Math.sin(t * 1.9), dz * reach * t);
      const length = reach * 0.31 * Math.sin(t * Math.PI) + 0.012;
      for (const side of [-1, 1]) {
        b.set(a.x + dx * 0.07 - dz * side * length, a.y + 0.032, a.z + dz * 0.07 + dx * side * length);
        blade(a, b, length * 0.18, 0.63 + t * 0.37 + random() * 0.14);
      }
    }
  }
  const fernGeometry = new THREE.BufferGeometry();
  fernGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fernVerts,3));
  fernGeometry.setAttribute('color', new THREE.Float32BufferAttribute(fernColors,3));
  fernGeometry.computeVertexNormals();
  const ferns = instance(fernGeometry, new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.84 }), 560);
  for (let i = 0; i < ferns.count; i++) {
    const z = random() * 52 - 34, side = random() < 0.5 ? -1 : 1;
    const x = riverCenter(z) + side * (5.2 + random() ** 1.8 * 12);
    const size = 0.45 + random() * 1.06;
    set(ferns, i, x, valleyHeight(x,z), z, size, size, size, random() * Math.PI * 2);
  }
  return root;
}

export function disposeValley(root: THREE.Group): void {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    object.material.map?.dispose();
    object.material.dispose();
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  root.removeFromParent();
}
