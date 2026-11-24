import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TSL } from '../../engine/tsl';
import { mulberry32 } from '../../engine/noise';
import type { CoastalWorld } from '../../modules/coast/world';
import { WrackDrift } from '../../modules/water/wrack-drift';
import { channelCentre } from './tidal-pool';

/** Two surveyed staffs and three loose branches make the changing current readable from shore. */
export class InletMarkers {
  readonly pieces: WrackDrift[];
  readonly root = new THREE.Group();
  private readonly branchGeometry: THREE.BufferGeometry;
  private readonly bark = new THREE.MeshStandardMaterial({ color: '#5c4736', roughness: 0.86 });
  private readonly staffs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.09, 2.5, 0.11),
    new THREE.MeshStandardNodeMaterial({ roughness: 0.79 }),
    2,
  );
  private readonly pose = new THREE.Object3D();
  private readonly flow = new THREE.Vector3();
  private readonly branches: THREE.InstancedMesh;
  private readonly shingle: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.MeshStandardNodeMaterial>;
  private readonly starts = [
    [-15.2, 0.3],
    [-13.6, -1.8],
    [-17, 1.25],
  ] as const;
  sillCurrent = 0;
  constructor(private world: CoastalWorld) {
    const s = world.inlet!;
    const surface = {
      ground: world.ground,
      stage: (x: number, z: number) => world.ocean.meanLevelAt(x, z),
      current: (x: number, z: number, out: THREE.Vector3) => world.ocean.flowAt(x, z, out),
    };
    this.pieces = this.starts.map((_, i) => new WrackDrift(surface, 0.036 + i * 0.009));
    const stem = new THREE.CylinderGeometry(0.025, 0.049, 0.75, 7).rotateZ(1.37);
    const twig = new THREE.CylinderGeometry(0.011, 0.028, 0.29, 6)
      .rotateZ(-1.02)
      .rotateY(0.74)
      .translate(-0.13, 0.05, -0.08);
    this.branchGeometry = mergeGeometries([stem, twig]);
    stem.dispose();
    twig.dispose();
    this.branches = new THREE.InstancedMesh(this.branchGeometry, this.bark, this.pieces.length);
    this.branches.frustumCulled = false;
    this.branches.castShadow = this.branches.receiveShadow = true;
    const band = TSL.positionWorld.y.mul(5).fract().greaterThan(0.5);
    this.staffs.material.colorNode = TSL.mix(TSL.color('#813f34'), TSL.color('#d4c8aa'), band);
    this.staffs.castShadow = true;
    [-23, -4].forEach((x, i) => {
      const z = channelCentre(x) + 1.65;
      this.pose.position.set(x, s.options.bedAt(x, z) + 1.25, z);
      this.pose.updateMatrix();
      this.staffs.setMatrixAt(i, this.pose.matrix);
    });
    this.root.name = 'Tide staffs and floating wrack';
    // Dark flints and light clasts lie in short bands on the sill and the two sloping banks.
    const rand = mulberry32(world.coast.seed + 939);
    const pebble = new THREE.IcosahedronGeometry(1, 0),
      stone = new THREE.MeshStandardNodeMaterial();
    const local = s.stageNode(TSL.positionWorld.xz, world.bed.waterLevel).toVarying('shingleStage');
    const damp = TSL.smoothstep(-0.04, 0.14, TSL.positionWorld.y.sub(local)).oneMinus();
    stone.colorNode = TSL.vec3(damp.mul(-0.36).add(1));
    stone.roughnessNode = TSL.mix(0.83, 0.27, damp);
    const gravel = new THREE.InstancedMesh(pebble, stone, 1400);
    const lithology = ['#645d54', '#83786a', '#5d5a58', '#a79a84', '#443f38', '#9a7659', '#b2a594'].map(
      (c) => new THREE.Color(c),
    );
    const tint = new THREE.Color();
    let count = 0;
    for (let band = 0; band < 107; band++) {
      const bx = -30 + rand() * 36,
        side = rand() < 0.5 ? -1 : 1;
      const bz = channelCentre(bx) + side * (2.15 + rand() * 2.65);
      const onSill = band % 5 === 0;
      const cx = onSill ? -14.3 + (rand() - 0.5) * 2.4 : bx,
        cz = onSill ? channelCentre(cx) + (rand() - 0.5) * 4.4 : bz;
      const width = 0.24 + rand() * 0.83,
        length = 0.34 + rand() * 2.3;
      for (let j = 0; j < 13; j++) {
        const x = cx + (rand() + rand() - 1) * length,
          z = cz + (rand() + rand() - 1) * width;
        const y = world.ground(x, z);
        if (y < -0.65 || y > 1.12) continue;
        const r = 0.022 + 0.13 * rand() ** 3;
        this.pose.position.set(x, y + 0.08 * r, z);
        this.pose.rotation.set((rand() - 0.5) * 0.35, rand() * Math.PI, (rand() - 0.5) * 0.4);
        this.pose.scale.set(r * (1 + 0.7 * rand()), r * (0.38 + rand() * 0.36), r * (0.55 + rand() * 0.6));
        this.pose.updateMatrix();
        gravel.setMatrixAt(count, this.pose.matrix);
        gravel.setColorAt(
          count++,
          tint.copy(lithology[Math.floor(rand() * lithology.length)]).multiplyScalar(0.84 + rand() * 0.28),
        );
      }
    }
    gravel.count = count;
    gravel.receiveShadow = true;
    gravel.computeBoundingSphere();
    this.shingle = gravel;
    this.root.add(this.staffs, this.branches, gravel);
    world.engine.scene.add(this.root);
    this.reset();
  }
  reset() {
    this.starts.forEach(([x, dz], i) => this.pieces[i].reset(x, channelCentre(x) + dz));
    this.update(0);
  }
  update(dt: number) {
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.update(dt);
      const { x, y, z } = p.position;
      this.pose.position.set(x, y - 0.012, z);
      this.pose.rotation.set(0, 0.32 + i * 0.89, 0);
      this.pose.scale.setScalar(0.85 + i * 0.15);
      this.pose.updateMatrix();
      this.branches.setMatrixAt(i, this.pose.matrix);
    }
    this.branches.instanceMatrix.needsUpdate = true;
    this.sillCurrent = this.world.ocean.flowAt(-14.3, channelCentre(-14.3), this.flow).x;
  }
  dispose() {
    this.root.removeFromParent();
    this.branches.dispose();
    this.branchGeometry.dispose();
    this.bark.dispose();
    this.staffs.dispose();
    this.staffs.geometry.dispose();
    this.staffs.material.dispose();
    this.shingle.dispose();
    this.shingle.geometry.dispose();
    this.shingle.material.dispose();
  }
}
