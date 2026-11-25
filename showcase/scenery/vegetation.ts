/**
 * Lush, irregular coastal vegetation: curved tropical palms, broadleaf jungle canopies,
 * wind-sculpted coastal pines/cypresses and shoreline scrub.
 *
 * Every grove uses baked vertex-color internal AO + InstancedMesh per-instance tinting,
 * scale and lean so large islands and coastal hillsides render in 1–3 draw calls with
 * natural organic silhouettes and zero uniform stamping.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../engine/noise';
import { canopyBendNode } from '../../modules/strands/canopy';
import { TSL } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { createFoliageMaterial, type SceneryRegistry } from './materials';
import { fbmCPU } from './terrain-noise';

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotY: number;
  leanX?: number;
  leanZ?: number;
  /** Optional RGB tint multiplier around 1.0 for tree-to-tree variation. */
  tint?: [number, number, number];
}

function setVertexColors(geometry: THREE.BufferGeometry, fn: (x: number, y: number, z: number, out: THREE.Color) => void): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ---- Tropical Coastal Palms -------------------------------------------------------

function createPalmGeometries(reg: SceneryRegistry): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry } {
  // Curved, subtly ringed tapered trunk (height ~ 9.5m at scale = 1).
  const segY = 11, radial = 7, height = 9.5;
  const trunk = new THREE.CylinderGeometry(0.11, 0.30, height, radial, segY, false);
  trunk.translate(0, height / 2, 0);
  const tPos = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < tPos.count; i++) {
    const x = tPos.getX(i), y = tPos.getY(i), z = tPos.getZ(i);
    const t = Math.max(0, Math.min(1, y / height));
    // Natural graceful coastal curve toward +X with slight S-bend near crown.
    const bendX = Math.pow(t, 1.65) * 1.45 - Math.sin(t * Math.PI) * 0.15;
    const bendZ = Math.sin(t * Math.PI * 1.1) * 0.22;
    // Slight trunk ring ridges.
    const ring = 1 + Math.sin(t * 28) * 0.055;
    tPos.setXYZ(i, x * ring + bendX, y, z * ring + bendZ);
  }
  trunk.computeVertexNormals();
  setVertexColors(trunk, (_x, y, _z, out) => {
    const t = Math.max(0, Math.min(1, y / height));
    // Natural linear-space weathered palm bark, darker near root flare and under crown shadow.
    const shade = 0.56 + 0.40 * Math.sin(t * Math.PI * 0.85) - 0.18 * Math.pow(t, 4);
    out.setRGB(0.17 * shade, 0.135 * shade, 0.095 * shade);
  });

  // Multi-frond arching palm crown positioned at trunk apex (1.45, 9.45, 0).
  const frondParts: THREE.BufferGeometry[] = [];
  const rand = mulberry32(409);
  const tiers = [
    { count: 8, pitch: 0.40, length: 4.1, width: 0.72, droop: 1.65, yOff: 0.05 },
    { count: 6, pitch: 0.80, length: 3.2, width: 0.58, droop: 1.0, yOff: 0.24 },
  ];

  for (const tier of tiers) {
    for (let f = 0; f < tier.count; f++) {
      const yaw = (f / tier.count) * Math.PI * 2 + (rand() - 0.5) * 0.36 + (tier.pitch > 0.6 ? 0.35 : 0);
      const len = tier.length * (0.86 + rand() * 0.28);
      const wid = tier.width * (0.88 + rand() * 0.24);
      const droop = tier.droop * (0.85 + rand() * 0.3);
      const steps = 6;
      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const r = t * len;
        const archY = Math.sin(t * Math.PI * 0.65) * len * Math.sin(tier.pitch) * 0.58 - t * t * droop + tier.yOff;
        // Tapered V-fold blade profile (left edge, center spine, right edge) so fronds catch light naturally.
        const w = Math.sin(Math.pow(t, 0.72) * Math.PI) * wid;
        const fold = w * 0.36;
        const cx = r * cosY;
        const cz = r * sinY;
        const sx = -sinY * w;
        const sz = cosY * w;

        // Calibrated linear-space palm greens: deep shaded crown heart → sunlit warm frond tips.
        const ao = 0.42 + 0.58 * Math.pow(t, 0.55);
        const sunTip = 0.76 + 0.38 * t;
        const lr = 0.048 * ao * sunTip, lg = 0.118 * ao * sunTip, lb = 0.024 * ao * sunTip;
        const sr = 0.062 * ao * sunTip, sg = 0.135 * ao * sunTip, sb = 0.028 * ao * sunTip;

        positions.push(cx - sx, archY - fold, cz - sz);
        colors.push(lr, lg, lb);
        positions.push(cx, archY, cz);
        colors.push(sr, sg, sb);
        positions.push(cx + sx, archY - fold, cz + sz);
        colors.push(lr, lg, lb);

        if (s < steps) {
          const a = s * 3, b = (s + 1) * 3;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
          indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
        }
      }

      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      fg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      fg.setIndex(indices);
      fg.translate(1.42, height - 0.1, 0);
      fg.computeVertexNormals();
      const nonIdx = fg.toNonIndexed();
      fg.dispose();
      frondParts.push(nonIdx);
    }
  }

  const crown = mergeGeometries(frondParts, false)!;
  frondParts.forEach((p) => p.dispose());
  return { trunk: reg.trackGeometry(trunk), crown: reg.trackGeometry(crown) };
}

/** Instanced tropical coastal palm grove (2 draw calls total: trunks + arching frond crowns). */
export function buildPalmGrove(
  reg: SceneryRegistry,
  placements: TreePlacement[],
  options: { name?: string; castShadow?: boolean } = {},
): { trunks: THREE.InstancedMesh; crowns: THREE.InstancedMesh } | null {
  if (placements.length === 0) return null;
  const { trunk, crown } = createPalmGeometries(reg);
  const trunkMat = createFoliageMaterial(reg, { name: 'palm-trunk', roughness: 0.92, doubleSided: false });
  const crownMat = createFoliageMaterial(reg, { name: 'palm-crown', roughness: 0.80, doubleSided: true });

  if(reg.world){
    trunkMat.positionNode=canopyBendNode(reg.world,9.5,0.006);
    crownMat.positionNode=canopyBendNode(reg.world,9.5,0.0075);
  }
  const trunks = new THREE.InstancedMesh(trunk, trunkMat, placements.length);
  const crowns = new THREE.InstancedMesh(crown, crownMat, placements.length);
  trunks.name = `${options.name ?? 'palms'}-trunks`;
  crowns.name = `${options.name ?? 'palms'}-crowns`;
  trunks.castShadow = crowns.castShadow = options.castShadow ?? true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  trunks.frustumCulled = crowns.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  placements.forEach((p, i) => {
    e.set(p.leanX ?? 0, p.rotY, p.leanZ ?? 0);
    q.setFromEuler(e);
    pos.set(p.x, p.y - 0.25, p.z);
    scl.set(p.scale, p.scale * (0.9 + ((i * 37) % 10) * 0.025), p.scale);
    m.compose(pos, q, scl);
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    const t = p.tint ?? [1, 1, 1];
    col.setRGB(t[0], t[1], t[2]);
    crowns.setColorAt(i, col);
    col.setRGB(0.95 + (t[0] - 1) * 0.4, 0.95 + (t[1] - 1) * 0.4, 0.95 + (t[2] - 1) * 0.4);
    trunks.setColorAt(i, col);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

  reg.group.add(trunks, crowns);
  return { trunks, crowns };
}

// ---- Organic Multi-Lobed Broadleaf Canopy & Coastal Pines -------------------------

export type CanopyStyle = 'tropical' | 'scrub' | 'pine';

/** Render three projections of a seeded branch skeleton. Each leaf clump has a near
 * and a shaded side, and clearings between boughs survive the texture mip chain. */
function canopyImpostor(reg: SceneryRegistry, style: CanopyStyle, seed: number, distant: boolean) {
  const rand = mulberry32(seed);
  const pine = style === 'pine', scrub = style === 'scrub';
  const h = scrub ? 2.4 : pine ? 8.2 : 7.1;
  const w = h * (scrub ? 1.65 : pine ? 0.67 : 1.32);
  const branches: { a: THREE.Vector3; b: THREE.Vector3; radius: number }[] = [];
  const leaves: { x: number; y: number; z: number; size: number; light: number }[] = [];
  const root = new THREE.Vector3();
  const top = new THREE.Vector3(0.02 * w, h * 0.91, -0.04 * w);
  branches.push({ a: root, b: top, radius: h * 0.022 });
  const branchCount = pine ? 82 : 43;
  for (let j = 0; j < branchCount; j++) {
    const layer = j / branchCount;
    const angle = j * 2.399963 + rand() * 0.55;
    // Whorls create shelves of needles and intervening skylight. Keep a little
    // height variation inside each whorl so the lower boughs never form discs.
    const branchLevel = pine ? (Math.floor(layer * 14) + 0.26 + rand() * 0.41) / 14 : layer;
    const y = h * ((pine ? 0.17 : 0.25) + branchLevel * (pine ? 0.77 : 0.44));
    const crown = pine ? (1 - layer) ** 0.72 : Math.sqrt(Math.max(0.03, 1 - ((layer - 0.54) / 0.60) ** 2));
    const lobe = 0.9 + 0.19 * Math.cos(3 * angle + seed) + 0.11 * Math.sin(2 * angle - seed);
    const reach = w * crown * lobe * (0.26 + rand() * 0.24);
    const a = new THREE.Vector3(top.x * layer, y, top.z * layer);
    const end = new THREE.Vector3(a.x + reach * Math.cos(angle),
      y + h * (pine ? -0.03 + 0.05 * layer + rand() * 0.04 : 0.085 + rand() * 0.17), a.z + reach * Math.sin(angle));
    branches.push({ a, b: end, radius: h * (pine ? 0.004 : 0.011) * (1 - 0.65 * layer) });
    const twigs = pine ? 12 : 17;
    for (let k = 0; k < twigs; k++) {
      const u = 0.16 + 0.82 * k / twigs;
      const base = a.clone().lerp(end, u);
      const spread = (0.19 + 0.35 * (1 - u)) * reach;
      const side = angle + (k % 2 ? 1 : -1) * (0.46 + rand() * 0.8);
      const twig = new THREE.Vector3(base.x + Math.cos(side) * spread, base.y + h * (pine ? 0.028 : 0.054), base.z + Math.sin(side) * spread);
      branches.push({ a: base, b: twig, radius: h * 0.002 });
      for (let n = 0; n < 18; n++) {
        const f = rand();
        const radius = h * (pine ? 0.02 : 0.046) * (0.55 + rand() * 0.75);
        const x = base.x + (twig.x - base.x) * f + (rand() - 0.5) * radius * 2;
        const z = base.z + (twig.z - base.z) * f + (rand() - 0.5) * radius * 2;
        const ly = base.y + (twig.y - base.y) * f + (rand() - 0.5) * radius * 1.5;
        const light = 0.33 + 0.22 * ly / h + 0.16 * Math.hypot(x, z) / w + 0.15 * f + 0.13 * rand();
        leaves.push({ x, y: ly, z, size: radius * (pine ? 0.39 : 0.46), light });
      }
    }
  }
  // Integrate hemispherical skylight through the actual leaf clusters. This
  // bakes soft mutual occlusion into all three views of the same tree, without
  // adding shadow-map draws or giving crowns a fixed world-space sun angle.
  const cells = 32, layerSize = cells * cells, volume = new Float32Array(layerSize * cells);
  const sky = new Float32Array(volume.length), span = w * 1.48, tall = h * 1.12;
  const cellOf = (x: number, y: number, z: number): number => {
    const ix = Math.min(cells - 1, Math.max(0, Math.floor((0.5 + x / span) * cells)));
    const iz = Math.min(cells - 1, Math.max(0, Math.floor((0.5 + z / span) * cells)));
    const iy = Math.min(cells - 1, Math.max(0, Math.floor(y / tall * cells)));
    return iy * layerSize + iz * cells + ix;
  };
  for (const leaf of leaves) volume[cellOf(leaf.x, leaf.y, leaf.z)] += 2.8 * (leaf.size * cells / span) ** 2;
  for (let y = cells - 1; y >= 0; y--) for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
    const i = y * layerSize + z * cells + x, above = i + layerSize;
    const incoming = y === cells - 1 || x === 0 || x === cells - 1 || z === 0 || z === cells - 1 ? 1 :
      0.48 * sky[above] + 0.13 * (sky[above - 1] + sky[above + 1] + sky[above - cells] + sky[above + cells]);
    sky[i] = incoming * Math.exp(-volume[i] * 0.38);
  }
  for (const leaf of leaves) {
    const i = cellOf(leaf.x, leaf.y, leaf.z);
    leaf.light *= 0.65 + 0.47 * Math.sqrt(sky[i]);
  }
  const canvas = document.createElement('canvas');
  const tileW = distant ? 160 : 320, tileH = distant ? 192 : 384, slices = distant ? 1 : 4;
  // Keep projecting geometry inside its tile, including outlying twigs and treetops.
  const extent = w * 1.48, height = h * 1.12;
  canvas.width = tileW * 4; canvas.height = tileH * slices;
  const ctx = canvas.getContext('2d')!;
  const parts: THREE.BufferGeometry[] = [];
  const normal = new THREE.Vector3();
  for (let plane = 0; plane < 3; plane++) {
    const yaw = plane * Math.PI / 3;
    const dx = Math.cos(yaw), dz = -Math.sin(yaw);
    const along = (x: number, z: number) => tileW * (0.5 + (x * dx + z * dz) / extent);
    const up = (y: number) => tileH * (1 - y / height);
    const layer = (x: number, z: number) => Math.max(0, Math.min(slices - 1,
      Math.floor((0.5 + (-x * dz + z * dx) / extent) * slices)));
    leaves.sort((a,b) => (a.z - b.z) * dx - (a.x - b.x) * dz);
    for (let k = 0; k < slices; k++) {
      let minX = tileW, maxX = 0, minY = tileH, maxY = 0;
      const include = (x: number, y: number, radius: number) => {
        minX = Math.min(minX, x - radius); maxX = Math.max(maxX, x + radius);
        minY = Math.min(minY, y - radius); maxY = Math.max(maxY, y + radius);
      };
      ctx.save(); ctx.translate(plane * tileW, k * tileH);
      ctx.beginPath(); ctx.rect(0, 0, tileW, tileH); ctx.clip();
      ctx.strokeStyle = '#493f32'; ctx.lineCap = 'round';
      for (const branch of branches) {
        if (layer((branch.a.x + branch.b.x) * 0.5, (branch.a.z + branch.b.z) * 0.5) !== k) continue;
        ctx.lineWidth = Math.max(0.55, branch.radius / extent * tileW * 2);
        include(along(branch.a.x, branch.a.z), up(branch.a.y), ctx.lineWidth);
        include(along(branch.b.x, branch.b.z), up(branch.b.y), ctx.lineWidth);
        ctx.beginPath(); ctx.moveTo(along(branch.a.x, branch.a.z), up(branch.a.y));
        ctx.lineTo(along(branch.b.x, branch.b.z), up(branch.b.y)); ctx.stroke();
      }
      for (const leaf of leaves) {
        if (layer(leaf.x, leaf.z) !== k) continue;
        const lit = Math.max(0.2, leaf.light + (leaf.x * -0.26 + leaf.z * 0.14) / w);
        const g = Math.round((pine ? 112 : 139) * lit);
        ctx.fillStyle = 'rgb(' + Math.round(g * (pine ? 0.61 : 0.75)) + ',' + g + ',' + Math.round(g * (pine ? 0.50 : 0.42)) + ')';
        const width = Math.max(0.55, leaf.size / extent * tileW);
        include(along(leaf.x, leaf.z), up(leaf.y), width + 1);
        ctx.beginPath(); ctx.ellipse(along(leaf.x, leaf.z), up(leaf.y), width, Math.max(0.55, width * (pine ? 0.51 : 0.78)), leaf.x, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      // Leaves in a near bough move across the far boughs as the camera moves.
      const depth = ((k + 0.5) / slices - 0.5) * extent;
      if (maxX <= minX || maxY <= minY) continue;
      const left = Math.max(0.002, minX / tileW), right = Math.min(0.998, maxX / tileW);
      const top = Math.min(0.998, 1 - minY / tileH), bottom = Math.max(0.002, 1 - maxY / tileH);
      const part = new THREE.PlaneGeometry(extent * (right - left), height * (top - bottom), distant ? 1 : 2, distant ? 2 : 3)
        .translate(((right + left) / 2 - 0.5) * extent, (top + bottom) / 2 * height, depth).rotateY(yaw);
      const uv = part.getAttribute('uv'), points = part.getAttribute('position'), normals = part.getAttribute('normal');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (plane + left + uv.getX(i) * (right - left)) / 4, (slices - 1 - k + bottom + uv.getY(i) * (top - bottom)) / slices);
        normal.set(points.getX(i) / w, 0.36 + 0.55 * points.getY(i) / h, points.getZ(i) / w).normalize();
        normals.setXYZ(i, normal.x, normal.y, normal.z);
      }
      part.setAttribute('crownOverhead', new THREE.Float32BufferAttribute(new Float32Array(uv.count), 1));
      parts.push(part);
    }
  }
  // A pilot looking straight down sees the upper boughs. The crossed side views
  // otherwise collapse into three thin lines, especially on distant slopes.
  const ox = (x:number) => (3.5 + x / extent) * tileW;
  const oz = (z:number) => (0.5 + z / extent) * tileH;
  ctx.save();
  ctx.beginPath(); ctx.rect(3 * tileW, 0, tileW, tileH); ctx.clip();
  leaves.sort((a,b) => a.y - b.y);
  for (const leaf of leaves) {
    const light = leaf.light * (0.78 + 0.33 * leaf.y / h);
    const g = Math.round((pine ? 116 : 143) * light);
    ctx.fillStyle = 'rgb(' + Math.round(g * (pine ? 0.67 : 0.77)) + ',' + g + ',' + Math.round(g * 0.49) + ')';
    const size = Math.max(0.7, leaf.size * tileW / extent);
    ctx.beginPath(); ctx.ellipse(ox(leaf.x), oz(leaf.z), size, size * (pine ? 0.64 : 0.84), leaf.x, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  const topView = new THREE.PlaneGeometry(extent, extent).rotateX(-Math.PI / 2).translate(0, h * 0.69, 0);
  const topUV = topView.getAttribute('uv');
  for (let i=0; i<topUV.count; i++) topUV.setXY(i, (3.002 + topUV.getX(i) * 0.996) / 4,
    (slices - 1 + 0.002 + topUV.getY(i) * 0.996) / slices);
  topView.setAttribute('crownOverhead', new THREE.Float32BufferAttribute(new Float32Array(topUV.count).fill(1), 1));
  parts.push(topView);
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 4;
  const geom = reg.trackGeometry(mergeGeometries(parts)!);
  for (const part of parts) part.dispose();
  const mat = reg.trackMaterial(new THREE.MeshPhysicalNodeMaterial({
    map: atlas, alphaTest: 0.22, roughness: 0.93, side: THREE.DoubleSide,
    // A projected bough contains needles facing many directions. Only a
    // fraction of its area can reflect the same bright patch of overcast sky.
    ior: 1.42, specularIntensity: pine ? 0.28 : 0.45,
  }));
  const backlight = TSL.dot(TSL.positionWorld.sub(TSL.cameraPosition).normalize(), frame.sunDirection)
    .max(0).pow(3).mul(frame.sunVisibility);
  const elevation = TSL.cameraPosition.sub(TSL.positionWorld).normalize().y;
  const birdseye = TSL.smoothstep(0.47, 0.86, elevation);
  mat.opacityNode = TSL.mix(birdseye.oneMinus(), birdseye, TSL.attribute('crownOverhead', 'float'));
  const pigment = TSL.materialColor.rgb;
  const thinLeaf = pigment.g.sub(pigment.r).max(0);
  mat.emissiveNode = frame.sunColor.mul(backlight).mul(thinLeaf).mul(TSL.vec3(0.12, 0.23, 0.045));
  // Individual leaf normals in the crown point outwards on either side of a slice.
  mat.normalNode = TSL.normalViewGeometry;
  if(reg.world)mat.positionNode=canopyBendNode(reg.world,h,pine?0.0038:0.006);
  mat.addEventListener('dispose', () => atlas.dispose());
  return { geom, mat };
}

/** Instanced coastal canopy / scrub / pine grove (1 draw call per style). */
export function buildCoastalCanopy(
  reg: SceneryRegistry,
  placements: TreePlacement[],
  style: CanopyStyle,
  options: { name?: string; castShadow?: boolean; seed?: number; distant?: boolean } = {},
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const { geom, mat } = canopyImpostor(reg, style, options.seed ?? (style === 'pine' ? 77 : style === 'scrub' ? 91 : 43),options.distant ?? false);

  const mesh = new THREE.InstancedMesh(geom, mat, placements.length);
  mesh.name = options.name ?? `canopy-${style}`;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  placements.forEach((p, i) => {
    e.set(p.leanX ?? 0, p.rotY, p.leanZ ?? 0);
    q.setFromEuler(e);
    pos.set(p.x, p.y - 0.18, p.z);
    const sx = p.scale * (0.88 + ((i * 29) % 9) * 0.032);
    const sy = p.scale * (0.86 + ((i * 53) % 11) * 0.03);
    const sz = p.scale * (0.88 + ((i * 17) % 9) * 0.032);
    scl.set(sx, sy, sz);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    const t = p.tint ?? [1, 1, 1];
    col.setRGB(t[0], t[1], t[2]);
    mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  reg.group.add(mesh);
  return mesh;
}

// ---- Organic Noise-Clustered Placement Helper -------------------------------------

export interface ScatterOptions {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  count: number;
  heightAt: (x: number, z: number) => number;
  slopeAt?: (x: number, z: number) => number;
  minHeight: number;
  maxHeight: number;
  minSlope?: number;
  minSpacing?: number;
  scaleRange: [number, number];
  leanMax?: number;
  /** Optional exclusion predicate (return true to skip). */
  exclude?: (x: number, z: number) => boolean;
  /** Noise clustering frequency (higher = tighter pockets). */
  clusterFreq?: number;
  /** Minimum cluster noise threshold in [-0.5, 0.5] to accept. */
  clusterThreshold?: number;
  seed: number;
}

/** Generate organic, noise-clustered non-uniform placements grounded on a terrain heightfield. */
export function scatterOnTerrain(opt: ScatterOptions): TreePlacement[] {
  const rand = mulberry32(opt.seed);
  const out: TreePlacement[] = [];
  const minSpacing2 = (opt.minSpacing ?? 4) ** 2;
  const minSlope = opt.minSlope ?? 0.68;
  const leanMax = opt.leanMax ?? 0.12;
  const freq = opt.clusterFreq ?? 0.035;
  const thresh = opt.clusterThreshold ?? -0.05;
  const maxAttempts = opt.count * 14;

  for (let attempt = 0; attempt < maxAttempts && out.length < opt.count; attempt++) {
    const x = opt.bounds.minX + rand() * (opt.bounds.maxX - opt.bounds.minX);
    const z = opt.bounds.minZ + rand() * (opt.bounds.maxZ - opt.bounds.minZ);
    if (opt.exclude?.(x, z)) continue;

    // Noise clustering creates natural groves + clearings instead of uniform distribution.
    const cl = fbmCPU(x * freq, z * freq, 2, opt.seed + 71);
    if (cl < thresh) continue;

    const y = opt.heightAt(x, z);
    if (y < opt.minHeight || y > opt.maxHeight) continue;
    if (opt.slopeAt && opt.slopeAt(x, z) < minSlope) continue;

    let tooClose = false;
    for (const prev of out) {
      const dx = prev.x - x, dz = prev.z - z;
      if (dx * dx + dz * dz < minSpacing2) { tooClose = true; break; }
    }
    if (tooClose) continue;

    const scale = opt.scaleRange[0] + Math.pow(rand(), 1.2) * (opt.scaleRange[1] - opt.scaleRange[0]);
    const tone = 0.80 + rand() * 0.36;
    const warm = 0.92 + rand() * 0.18;
    out.push({
      x, y, z, scale,
      rotY: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 2 * leanMax,
      leanZ: (rand() - 0.5) * 2 * leanMax,
      tint: [tone * warm, tone * (0.96 + rand() * 0.1), tone * (0.88 + rand() * 0.14)],
    });
  }
  return out;
}
