import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import {
  watershedHeight,
  watershedClimate,
  regionalChannel,
  regionalRiver,
  regionalWaterLevel,
} from './earth';
import { mulberry32 } from '../../engine/noise';
import { seedFor } from './library';
export interface RegionLocation {
  east: number;
  north: number;
}
type Tile = { mesh: THREE.Mesh; water?: THREE.Mesh; trees: THREE.InstancedMesh; gx: number; gz: number };
const WIDTH = 256,
  GRID = 24;
const ORIGIN_STEP = 1024;
/** Coordinates in metres. The host keeps absolute positions; draw everything relative to origin. */
export class RegionalFlight {
  readonly root = new THREE.Group();
  readonly origin = { east: 0, north: 0 };
  private readonly tiles = new Map<string, Tile>();
  private readonly rock = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.93 });
  private readonly foliage = new THREE.MeshStandardNodeMaterial({ color: 0x475b40, roughness: 0.88 });
  private readonly water = new THREE.MeshStandardNodeMaterial({
    color: '#587c78',
    metalness: 0.23,
    roughness: 0.18,
    side: THREE.DoubleSide,
  });
  private readonly canopy: THREE.BufferGeometry;
  private readonly last = { x: Infinity, z: Infinity };
  private readonly pending: { x: number; z: number }[] = [];
  private readonly riverTint = new THREE.Color('#537577');
  private readonly dryTint = new THREE.Color('#ad975e');
  private readonly pose = new THREE.Object3D();
  private readonly paint = new THREE.Color();
  constructor(
    readonly seed: number,
    readonly radius = 2,
  ) {
    if (!Number.isInteger(radius) || radius < 1 || radius > 4)
      throw new RangeError('Regional tile radius must be 1–4');
    // Layered irregular whorls retain visible gaps on the skyline of a flight tile.
    const pts: number[] = [],
      ix: number[] = [];
    for (let tier = 0; tier < 4; tier++)
      for (let row = 0; row < 2; row++)
        for (let j = 0; j < 9; j++) {
          const a = (j * Math.PI * 2) / 9 + tier * 0.36,
            h = tier * 0.2,
            r = (1 - h) * (row ? 0.09 : 0.39) * (1 + 0.14 * Math.sin(j * 4.3 + tier));
          pts.push(Math.cos(a) * r, 0.18 + h + row * 0.23, Math.sin(a) * r);
          if (row) {
            const i = tier * 18 + j,
              n = tier * 18 + ((j + 1) % 9);
            ix.push(i, i + 9, n, n, i + 9, n + 9);
          }
        }
    const wp = TSL.positionWorld,
      wind = TSL.sin(wp.x.mul(0.46).add(wp.z.mul(0.22)).sub(frame.time.mul(1.5))).mul(0.025);
    this.water.roughnessNode = TSL.float(0.19).add(wind);
    this.water.colorNode = TSL.mix(
      TSL.color('#507672'),
      frame.skyHorizon,
      TSL.float(1).sub(TSL.positionViewDirection.y.abs()).mul(0.25),
    );
    this.canopy = new THREE.BufferGeometry();
    this.canopy.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.canopy.setIndex(ix);
    this.canopy.computeVertexNormals();
  }
  height(east: number, north: number) {
    return watershedHeight(east, north, this.seed);
  }
  private make(gx: number, gz: number): Tile {
    const positions: number[] = [],
      normals: number[] = [],
      colors: number[] = [],
      indices: number[] = [],
      step = WIDTH / GRID;
    const sand = new THREE.Color('#a79b77'),
      grass = new THREE.Color('#718052'),
      rock = new THREE.Color('#77756b'),
      snow = new THREE.Color('#b7c1c1');
    for (let z = 0; z <= GRID; z++)
      for (let x = 0; x <= GRID; x++) {
        const dx = x * step,
          dz = z * step,
          wx = gx * WIDTH + dx,
          wz = gz * WIDTH + dz,
          h = this.height(wx, wz);
        const sx = (this.height(wx + 1, wz) - this.height(wx - 1, wz)) * 0.5,
          sz = (this.height(wx, wz + 1) - this.height(wx, wz - 1)) * 0.5,
          length = Math.hypot(sx, 1, sz);
        positions.push(dx, h, dz);
        normals.push(-sx / length, 1 / length, -sz / length);
        const moisture = watershedClimate(wx, wz, this.seed),
          channel = regionalChannel(wx, wz, this.seed);
        this.paint
          .copy(h < 4 ? sand : h > 105 ? snow : length > 1.12 ? rock : grass)
          .lerp(this.dryTint, Math.max(0, 0.53 - moisture) * 1.48)
          .lerp(this.riverTint, channel < 6 && h > 0 ? 0.87 : 0)
          .multiplyScalar(0.84 + 0.16 * Math.sin(wx * 0.012 + wz * 0.008));
        colors.push(this.paint.r, this.paint.g, this.paint.b);
        if (x < GRID && z < GRID) {
          const i = z * (GRID + 1) + x;
          indices.push(i, i + GRID + 1, i + 1, i + 1, i + GRID + 1, i + GRID + 2);
        }
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(indices);
    const mesh = new THREE.Mesh(g, this.rock),
      trees = new THREE.InstancedMesh(this.canopy, this.foliage, 96);
    const rnd = mulberry32(seedFor(this.seed, gx + ',' + gz));
    trees.count = 0;
    for (let i = 0; i < 96; i++) {
      const x = rnd() * WIDTH,
        z = rnd() * WIDTH,
        h = this.height(gx * WIDTH + x, gz * WIDTH + z);
      if (h < 3 || h > 94 || rnd() > 0.3 + watershedClimate(gx * WIDTH + x, gz * WIDTH + z, this.seed) * 0.8)
        continue;
      this.pose.position.set(x, h, z);
      this.pose.scale.setScalar(3 + rnd() * 7);
      this.pose.rotation.y = rnd() * 6.28;
      this.pose.updateMatrix();
      trees.setMatrixAt(trees.count++, this.pose.matrix);
    }
    mesh.add(trees);
    const banks: number[] = [],
      faces: number[] = [];
    for (let branch = 0; branch < 3; branch++)
      for (let i = 0; i < 16; i++) {
        const a = gx * WIDTH + i * 16,
          b = a + 16,
          m = (a + b) / 2;
        if (branch === 1 && m >= -210) continue;
        const middle = regionalRiver(m, this.seed, branch);
        if (Math.floor(middle / WIDTH) !== gz || regionalWaterLevel(m, middle, this.seed) <= 0) continue;
        const first = banks.length / 3;
        for (const east of [a, b]) {
          const z = regionalRiver(east, this.seed, branch),
            y = regionalWaterLevel(east, z, this.seed);
          const width = branch === 1 ? 5 : 8;
          banks.push(
            east - gx * WIDTH,
            y,
            z - gz * WIDTH - width,
            east - gx * WIDTH,
            y,
            z - gz * WIDTH + width,
          );
        }
        faces.push(first, first + 1, first + 2, first + 2, first + 1, first + 3);
      }
    let water: THREE.Mesh | undefined;
    if (faces.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(banks, 3));
      g.setIndex(faces);
      g.computeVertexNormals();
      water = new THREE.Mesh(g, this.water);
      mesh.add(water);
    }
    this.root.add(mesh);
    return { mesh, water, trees, gx, gz };
  }
  updateAt(east: number, north: number) {
    const gx = Math.floor(east / WIDTH),
      gz = Math.floor(north / WIDTH);
    if (!Number.isFinite(east) || !Number.isFinite(north))
      throw new RangeError('Expected finite regional coordinates');
    if (gx !== this.last.x || gz !== this.last.z) {
      this.last.x = gx;
      this.last.z = gz;
      this.pending.length = 0;
      this.origin.east = Math.floor(east / ORIGIN_STEP) * ORIGIN_STEP;
      this.origin.north = Math.floor(north / ORIGIN_STEP) * ORIGIN_STEP;
      for (const [id, t] of this.tiles) {
        if (Math.abs(t.gx - gx) > this.radius || Math.abs(t.gz - gz) > this.radius) {
          this.drop(t);
          this.tiles.delete(id);
        } else t.mesh.position.set(t.gx * WIDTH - this.origin.east, 0, t.gz * WIDTH - this.origin.north);
      }
      for (let z = gz - this.radius; z <= gz + this.radius; z++)
        for (let x = gx - this.radius; x <= gx + this.radius; x++)
          if (!this.tiles.has(x + ',' + z)) this.pending.push({ x, z });
      this.pending.sort((a, b) => (b.x - gx) ** 2 + (b.z - gz) ** 2 - (a.x - gx) ** 2 - (a.z - gz) ** 2);
    }
    for (let n = 0; n < 2 && this.pending.length; n++) {
      const { x, z } = this.pending.pop()!,
        t = this.make(x, z);
      this.tiles.set(x + ',' + z, t);
      t.mesh.position.set(x * WIDTH - this.origin.east, 0, z * WIDTH - this.origin.north);
    }
    return this.origin;
  }
  get residentTiles() {
    return this.tiles.size;
  }
  private drop(t: Tile) {
    t.mesh.removeFromParent();
    t.mesh.geometry.dispose();
    t.water?.geometry.dispose();
    t.trees.dispose();
  }
  dispose() {
    for (const t of this.tiles.values()) this.drop(t);
    this.tiles.clear();
    this.root.removeFromParent();
    this.rock.dispose();
    this.water.dispose();
    this.foliage.dispose();
    this.canopy.dispose();
  }
}
