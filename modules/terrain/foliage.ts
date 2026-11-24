import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL } from '../../engine/tsl';
import type { WorldBus } from '../../engine/world-bus';
import { QUALITY_TIERS, type QualityPreset } from '../../engine/quality';
import { canopyBendNode } from '../strands/canopy';
import { terrainReading, type TerrainSurface } from './surface';

function clump(reed: boolean) {
  const points: number[] = [],
    rand = mulberry32(reed ? 65 : 71);
  for (let i = 0; i < 11; i++) {
    const angle = rand() * Math.PI * 2,
      x = (rand() - 0.5) * 0.9,
      z = (rand() - 0.5) * 0.9;
    const h = (reed ? 1.1 : 0.37) * (0.58 + rand()),
      w = (reed ? 0.033 : 0.056) * (1 + rand());
    const wx = Math.cos(angle) * w,
      wz = Math.sin(angle) * w,
      lean = reed ? 1.2 : 2.2;
    const a = [x - wx, 0, z - wz],
      b = [x + wx, 0, z + wz];
    const c = [x - wx * 0.47 - wz * 0.45, h * 0.53, z - wz * 0.47 + wx * 0.45];
    const d = [x + wx * 0.47 - wz * 0.45, h * 0.53, z + wz * 0.47 + wx * 0.45];
    points.push(...a, ...b, ...c, ...b, ...d, ...c, ...c, ...d, x - wz * lean, h, z + wx * lean);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.computeVertexNormals();
  return g;
}

export class BiomeFoliage {
  readonly root = new THREE.Group();
  readonly grass: THREE.InstancedMesh;
  readonly reeds: THREE.InstancedMesh;
  readonly crowns: THREE.InstancedMesh;
  private readonly trunks: THREE.InstancedMesh;
  private density = 1;
  private tierFactor = 1;
  private readonly bladesColor = TSL.uniform(new THREE.Color());
  constructor(
    surface: TerrainSurface,
    world: WorldBus,
    seed: number,
    plantable?: (x: number, z: number) => boolean,
  ) {
    const place = (
      geometry: THREE.BufferGeometry,
      height: number,
      flex: number,
      max: number,
      name: string,
      bark = false,
    ) => {
      const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.95 });
      m.positionNode = canopyBendNode(world, height, flex);
      const tip = TSL.positionGeometry.y.div(height).saturate();
      m.colorNode = bark ? TSL.vec3(0.12, 0.074, 0.04) : this.bladesColor.mul(tip.mul(0.64).add(0.52));
      const mesh = new THREE.InstancedMesh(geometry, m, max);
      mesh.name = name;
      mesh.count = 0;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };
    this.grass = place(clump(false), 0.65, 0.11, 15000, 'Meadow grass');
    this.reeds = place(clump(true), 1.7, 0.095, 4000, 'Bank reeds');
    const crown = new THREE.IcosahedronGeometry(1.6, 1);
    const cp = crown.getAttribute('position');
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i),
        y = cp.getY(i),
        z = cp.getZ(i);
      const r = 1 + 0.16 * Math.sin(x * 3.1 + z * 2.7 + y);
      cp.setXYZ(i, x * r, 3.05 + y * 1.22, z * r);
    }
    crown.computeVertexNormals();
    this.crowns = place(crown, 5, 0.052, 512, 'Wind-bent crowns');
    this.trunks = place(
      new THREE.CylinderGeometry(0.095, 0.19, 3.2, 6).translate(0, 1.6, 0),
      5,
      0.052,
      512,
      'Tapered trunks',
      true,
    );
    const reading = terrainReading(),
      pose = new THREE.Object3D();
    const rand = mulberry32(seed ^ 0x614991);
    for (let i = 0; i < 48000; i++) {
      const x = (rand() - 0.5) * surface.size,
        z = (rand() - 0.5) * surface.size;
      if (plantable && !plantable(x, z)) continue;
      const { height, surfaceId } = surface.sample(x, z, reading);
      if (!['grass', 'reeds', 'scrub'].includes(surfaceId)) continue;
      const tree = surfaceId === 'grass' && rand() < 0.014;
      const mesh = tree ? this.crowns : surfaceId === 'reeds' ? this.reeds : this.grass;
      if (mesh.count >= mesh.instanceMatrix.count) continue;
      pose.position.set(x, height - 0.015, z);
      pose.rotation.y = rand() * Math.PI * 2;
      pose.scale.setScalar((0.65 + rand() * 0.9) * (surfaceId === 'scrub' ? 0.68 : 1));
      pose.updateMatrix();
      mesh.setMatrixAt(mesh.count++, pose.matrix);
      if (tree) this.trunks.setMatrixAt(this.trunks.count++, pose.matrix);
    }
    for (const mesh of this.meshes()) {
      mesh.userData.placed = mesh.count;
      mesh.computeBoundingSphere();
    }
  }
  private meshes() {
    return [this.grass, this.reeds, this.crowns, this.trunks];
  }
  setStyle(tint: string, density: number) {
    this.bladesColor.value.set(tint);
    this.density = density;
    this.resize();
  }
  setQuality(p: QualityPreset) {
    this.tierFactor = [0.3, 0.48, 0.72, 0.86, 1][QUALITY_TIERS.indexOf(p.tier)];
    this.resize();
  }
  private resize() {
    for (const mesh of this.meshes())
      mesh.count = Math.floor(mesh.userData.placed * this.density * this.tierFactor);
  }
  dispose() {
    this.root.removeFromParent();
    for (const mesh of this.meshes()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
