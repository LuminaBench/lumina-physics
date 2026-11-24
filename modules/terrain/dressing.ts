import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL } from '../../engine/tsl';
import { perturbNormalHeight } from '../../engine/shading';
import type { LandGeology } from './geology';
import { terrainReading, type TerrainSurface } from './surface';

type Rock = 'talus' | 'cobble' | 'shale' | 'stack';
/** Faulted polygonal cross-sections. A fallen slab, river-polished cobble and standing stack have different bedding profiles. */
function stone(kind: Rock, seed: number, fracture = 0.65, bedding = 3.2) {
  const rand = mulberry32(seed),
    sides = kind === 'cobble' ? 15 : Math.round(13 - 4.6 * fracture),
    rings = kind === 'stack' ? 11 : 7;
  const angles = Array.from({ length: sides }, (_, i) => ((i + 0.36 * rand()) * Math.PI * 2) / sides);
  const radial = angles.map(() => 0.75 + 0.38 * rand()),
    pos: number[] = [],
    ids: number[] = [];
  for (let j = 0; j < rings; j++) {
    const t = j / (rings - 1),
      round = Math.pow(Math.sin(Math.PI * t), 0.54);
    const profile =
      kind === 'cobble'
        ? 0.16 + 0.89 * round
        : kind === 'stack'
          ? (j === rings - 1 ? 0.43 : 1 - 0.28 * t) *
            (j % Math.max(2, Math.round(5 - bedding * 0.62)) === 0 ? 1 - fracture * 0.17 : 1)
          : 0.47 + 0.57 * round;
    for (let k = 0; k < sides; k++) {
      const a = angles[k],
        r =
          profile *
          radial[k] *
          (1 + 0.07 * Math.sin(3 * a + t * 7) + rand() * (kind === 'cobble' ? 0.025 : 0.13));
      const x = r * Math.cos(a) + 0.12 * t,
        y = t * (kind === 'shale' ? 0.48 : kind === 'stack' ? 2.9 : 1.23),
        z = r * Math.sin(a);
      pos.push(
        x,
        y + (kind === 'cobble' ? 0.035 : 0.1) * (Math.sin(2 * a + seed) + 0.5 * rand()) + x * 0.09,
        z,
      );
      if (j) {
        const a = (j - 1) * sides + k,
          b = (j - 1) * sides + ((k + 1) % sides);
        ids.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
  }
  const top = pos.length / 3;
  pos.push(0.1, kind === 'stack' ? 2.95 : kind === 'shale' ? 0.52 : 1.24, 0);
  for (let i = 0; i < sides; i++)
    ids.push(top, (rings - 1) * sides + ((i + 1) % sides), (rings - 1) * sides + i);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(ids);
  if (kind !== 'cobble') {
    const unrolled = g.toNonIndexed();
    g.dispose();
    g = unrolled;
  }
  g.computeVertexNormals();
  return g;
}

function driftwood(seed: number) {
  const rand = mulberry32(seed),
    pos: number[] = [],
    idx: number[] = [];
  function stem(from: THREE.Vector3, to: THREE.Vector3, r: number, taper: number) {
    const start = pos.length / 3,
      axis = to.clone().sub(from).normalize(),
      side = new THREE.Vector3(0, 1, 0).cross(axis).normalize(),
      up = axis.clone().cross(side);
    for (let end = 0; end < 2; end++)
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4,
          radius = r * (end ? taper : 1) * (0.91 + 0.12 * rand());
        const p = (end ? to : from)
          .clone()
          .addScaledVector(side, Math.cos(a) * radius)
          .addScaledVector(up, Math.sin(a) * radius);
        pos.push(p.x, p.y, p.z);
        if (end) {
          const k = start + j,
            l = start + ((j + 1) % 8);
          idx.push(k, l, k + 8, l, l + 8, k + 8);
        }
      }
  }
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  stem(v(-1.6, 0.1, 0), v(0.4, 0.16, 0.12), 0.19, 0.76);
  stem(v(0.4, 0.16, 0.12), v(1.6, 0.23, 0.03), 0.14, 0.26);
  stem(v(-0.7, 0.15, 0.05), v(-1.18, 0.48, 0.45), 0.1, 0.18);
  stem(v(0.34, 0.16, 0.12), v(0.85, 0.4, -0.31), 0.083, 0.13);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
export class GeologicalDressing {
  readonly root = new THREE.Group();
  private readonly draws: {
    mesh: THREE.InstancedMesh;
    cells: { bounds: THREE.Box3; rows: THREE.Matrix4[] }[];
  }[] = [];
  private readonly clip = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly direction = new THREE.Vector3();
  private readonly previousDir = new THREE.Vector3();
  private readonly previousPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  constructor(
    surface: TerrainSurface,
    geology: LandGeology,
    seed: number,
    allow?: (x: number, z: number) => boolean,
    private readonly camera?: THREE.Camera,
    debrisSeed?: number,
  ) {
    const rocksRandom = mulberry32(seed ^ 0x6a6123),
      debrisRandom = debrisSeed === undefined ? rocksRandom : mulberry32(debrisSeed),
      read = terrainReading(),
      pose = new THREE.Object3D();
    let rand = rocksRandom;
    const land = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    const wet =
      surface.biome === 'dry-highlands'
        ? TSL.float(0)
        : TSL.smoothstep(-0.45, 1.45, TSL.positionWorld.y).oneMinus();
    const rock = geology.rock(TSL.positionWorld, TSL.normalWorldGeometry, wet);
    land.colorNode = rock.color;
    land.roughnessNode = rock.rough;
    land.normalNode = perturbNormalHeight(rock.height, 0.68);
    const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.87, side: THREE.DoubleSide });
    const fibre = TSL.texture(geology.atlas, TSL.positionGeometry.xy.mul(TSL.vec2(0.71, 5.2)));
    wood.colorNode = TSL.mix(TSL.vec3(0.119, 0.09, 0.063), TSL.vec3(0.33, 0.289, 0.223), fibre.g);
    wood.normalNode = perturbNormalHeight(fibre.r.mul(0.03), 1);
    const families = ['talus', 'cobble', 'shale', 'stack', 'wood'] as const;
    const placements = families.map(() => [[], [], []] as THREE.Matrix4[][]);
    function place(kind: (typeof families)[number], x: number, z: number, scale: number, yScale: number) {
      if (Math.abs(x) > surface.size / 2 || Math.abs(z) > surface.size / 2 || (allow && !allow(x, z))) return;
      const s = surface.sample(x, z, read);
      const timber = kind === 'wood';
      pose.position.set(x, s.height - (timber ? 0.025 : scale * (0.12 + 0.25 * s.slope)), z);
      pose.rotation.set((rand() - 0.5) * 0.19, rand() * 6.283, (rand() - 0.5) * (timber ? 0.08 : 0.26));
      pose.scale.set(scale * (0.69 + 0.68 * rand()), yScale, scale * (0.66 + 0.55 * rand()));
      pose.updateMatrix();
      placements[families.indexOf(kind)][Math.floor(rand() * 3)].push(pose.matrix.clone());
    }
    // Fractured ledges run across the face. Their long axes follow the local contour,
    // while the lower portion of each plate intersects the supporting steep terrain.
    if (surface.biome === 'coastal-cliffs') {
      const spacing = Math.max(3, surface.size / 160);
      for (let j = 1; j < surface.size / spacing - 1; j++)
        for (let i = 1; i < surface.size / spacing - 1; i++) {
          const x = (i + 0.25 * rand()) * spacing - surface.size / 2,
            z = (j + 0.25 * rand()) * spacing - surface.size / 2;
          if (allow && !allow(x, z)) continue;
          const s = surface.sample(x, z, read);
          if (s.height < -0.25 || s.height > 25 || s.slope < 0.69) continue;
          const seam = Math.sin(s.height * 1.65 + x * 0.18 - z * 0.07);
          if (seam < -0.04 || rand() > 0.68) continue;
          const n = s.normal,
            run = 1.3 + rand() * 2.7,
            thick = 0.75 + rand() * 1.85;
          pose.position.set(x + n.x * 0.34, s.height - thick * 0.45, z + n.z * 0.34);
          pose.rotation.set(
            (rand() - 0.5) * 0.08,
            Math.atan2(n.z, -n.x) + Math.PI / 2,
            (rand() - 0.5) * 0.16,
          );
          pose.scale.set(run, thick, 1.0 + rand() * 0.85);
          pose.updateMatrix();
          placements[2][Math.floor(rand() * 3)].push(pose.matrix.clone());
        }
    }
    const count = Math.min(21000, Math.max(500, Math.round(surface.size ** 2 / 16)));
    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * surface.size,
        z = (rand() - 0.5) * surface.size;
      const { height: h, slope, moisture } = surface.sample(x, z, read);
      if (surface.biome === 'coastal-cliffs') {
        if (h < -4 || h > 12 || (h > 3.4 && slope < 0.46) || rand() > 0.21) continue;
        const shoal = h < -0.4;
        if (shoal && h > -2.8 && rand() < 0.023) {
          place('stack', x, z, 1.5 + rand() * 1.8, 1.1 + rand() * 2.7);
          continue;
        }
        const scale = 0.55 + rand() ** 2 * 2.5;
        place('talus', x, z, scale, scale * (0.65 + rand() * 0.47));
        for (let k = 0; k < 4; k++) {
          const a = rand() * 6.283,
            d = (0.45 + rand() * 1.45) * scale,
            r = 0.09 + rand() * 0.4;
          place('talus', x + d * Math.cos(a), z + d * Math.sin(a), r, r * 0.67);
        }
      } else if (surface.biome === 'temperate-river-valley') {
        if (h < -1.25 || h > 3.4 || rand() > 0.4) continue;
        if (debrisSeed === undefined && h > 0.16 && h < 1.52 && rand() < 0.052) {
          place('wood', x, z, 0.58 + rand() * 0.63, 1);
          continue;
        }
        const r = 0.16 + rand() ** 3 * 1.3;
        place('cobble', x, z, r, r * (0.46 + rand() * 0.45));
        for (let k = 0; k < 5; k++) {
          const r = 0.06 + 0.16 * rand();
          place('cobble', x + (rand() - 0.5) * 4, z + (rand() - 0.5) * 4, r, r * 0.67);
        }
      } else {
        const band = 0.5 + 0.5 * Math.sin(x * 0.076 + z * 0.031 + 2 * Math.sin(z * 0.046));
        if ((slope < 0.19 && band < 0.92) || rand() > 0.11 + 0.15 * band) continue;
        const scale = 0.25 + rand() ** 3 * 2.8;
        place('shale', x, z, scale, scale);
        if (moisture < 0.4)
          for (let k = 0; k < 3; k++) {
            const r = 0.11 + 0.35 * rand();
            place('shale', x + (rand() - 0.5) * 5, z + (rand() - 0.5) * 5, r, r);
          }
      }
    }
    if (debrisSeed !== undefined && surface.biome !== 'dry-highlands') {
      rand = debrisRandom;
      for (let i = 0; i < count * 0.66; i++) {
        const x = (rand() - 0.5) * surface.size,
          z = (rand() - 0.5) * surface.size;
        const h = surface.sample(x, z, read).height - surface.waterLevel;
        if (h > 0.12 && h < 1.7 && rand() < 0.09)
          place('wood', x, z, 0.45 + rand() * 0.84, 0.8 + rand() * 0.4);
      }
    }
    families.forEach((kind, i) =>
      placements[i].forEach((rows, variant) => {
        if (!rows.length) return;
        const mesh = new THREE.InstancedMesh(
          kind === 'wood'
            ? driftwood((debrisSeed ?? seed) + variant)
            : stone(kind, seed + variant * 17, geology.rockRecipe?.fracture, geology.rockRecipe?.bedding),
          kind === 'wood' ? wood : land,
          rows.length,
        );
        mesh.name = kind + ' ' + variant;
        if (this.camera) {
          const cells = new Map<string, { bounds: THREE.Box3; rows: THREE.Matrix4[] }>();
          for (const m of rows) {
            const e = m.elements,
              key = Math.floor(e[12] / 32) + ',' + Math.floor(e[14] / 32);
            let cell = cells.get(key);
            if (!cell) {
              cell = { bounds: new THREE.Box3(), rows: [] };
              cells.set(key, cell);
            }
            cell.bounds.expandByPoint(pose.position.set(e[12], e[13], e[14]));
            cell.rows.push(m);
          }
          for (const cell of cells.values()) cell.bounds.expandByScalar(8);
          this.draws.push({ mesh, cells: [...cells.values()] });
          mesh.count = 0;
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        } else {
          rows.forEach((m, i) => mesh.setMatrixAt(i, m));
          mesh.computeBoundingSphere();
        }
        this.root.add(mesh);
      }),
    );
    if (!this.root.children.some((o) => (o as THREE.Mesh).material === wood)) wood.dispose();
    if (!this.root.children.some((o) => (o as THREE.Mesh).material === land)) land.dispose();
  }
  update() {
    const c = this.camera;
    if (!c || !this.root.visible) return;
    c.getWorldDirection(this.direction);
    if (this.previousPos.distanceToSquared(c.position) < 1 && this.direction.dot(this.previousDir) > 0.9995)
      return;
    this.previousPos.copy(c.position);
    this.previousDir.copy(this.direction);
    this.clip.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.clip, c.coordinateSystem);
    for (const { mesh, cells } of this.draws) {
      mesh.count = 0;
      for (const cell of cells) {
        if (!this.frustum.intersectsBox(cell.bounds)) continue;
        for (const m of cell.rows) {
          const e = m.elements,
            dx = e[12] - c.position.x,
            dy = e[13] - c.position.y,
            dz = e[14] - c.position.z;
          const radiusSquared = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
          if (dx * dx + dy * dy + dz * dz > radiusSquared * 330 * 330) continue;
          mesh.setMatrixAt(mesh.count++, m);
        }
      }
      mesh.visible = mesh.count > 0;
      if (mesh.visible) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
  dispose() {
    const materials = new Set<THREE.Material>();
    for (const obj of this.root.children) {
      const m = obj as THREE.InstancedMesh;
      materials.add(m.material as THREE.Material);
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of materials) m.dispose();
    this.root.removeFromParent();
  }
}
