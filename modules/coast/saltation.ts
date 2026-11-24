import * as THREE from 'three/webgpu';
import type { LuminaEngine } from '../../engine/engine';
import type { Coastline } from './coastline';
import type { CoastalSediment } from './sediment';
interface SaltationWorld {
  engine: LuminaEngine;
  coast: Coastline;
  sediment: CoastalSediment;
  ground(x: number, z: number): number;
}
import { mulberry32 } from '../../engine/noise';
import { shoreSite } from './coastline';

/** Short ballistic hops from dry, exposed sand. Grains lose momentum on each impact. */
export class Saltation {
  readonly mesh: THREE.InstancedMesh;
  private readonly grains: Float32Array;
  private readonly wind = new THREE.Vector3();
  private readonly pose = new THREE.Object3D();
  private readonly site = shoreSite();
  private readonly rand: () => number;
  active = 0;
  private carry = 0;
  constructor(
    private world: SaltationWorld,
    capacity = 96,
  ) {
    this.rand = mulberry32(world.coast.seed + 1850);
    this.grains = new Float32Array(capacity * 8);
    this.mesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: world.coast.sand.pale, roughness: 0.91 }),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    world.engine.scene.add(this.mesh);
  }
  update(dt: number, focus: THREE.Vector3) {
    const w = this.world,
      r = this.rand;
    w.engine.wind.sample(focus, w.engine.time, this.wind);
    const speed = Math.hypot(this.wind.x, this.wind.z);
    this.carry += Math.max(0, speed - 3.3) * 4 * dt;
    const supply = Math.min(10, Math.floor(this.carry));
    this.carry -= Math.floor(this.carry);
    const n = this.grains.length / 8,
      a = this.grains;
    if (focus.y - w.ground(focus.x, focus.z) < 5)
      for (let i = 0; i < supply && this.active < n; i++) {
        const x = focus.x + (r() - 0.5) * 6,
          z = focus.z + (r() - 0.5) * 6;
        const site = w.coast.project(x, z, this.site),
          soil = w.sediment.inspect(x, z);
        if (
          site.cross < 0 ||
          site.cross > 90 ||
          site.brackish > 0.25 ||
          soil.film > 0.24 ||
          soil.water > 0.0003 ||
          site.shelter > 0.68 ||
          w.coast.options.protectedAt?.(x, z)
        )
          continue;
        const k = this.active++ * 8,
          launch = 0.18 + 0.18 * r();
        a[k] = x;
        a[k + 1] = soil.height + 0.012;
        a[k + 2] = z;
        a[k + 3] = this.wind.x * launch;
        a[k + 4] = 0.3 + r() * 0.8;
        a[k + 5] = this.wind.z * launch;
        a[k + 6] = 2;
        a[k + 7] = 0.002 + w.coast.sand.grainMm * 0.0013 + r() * 0.0025;
      }
    for (let i = 0; i < this.active; ) {
      const k = i * 8;
      a[k + 4] -= 9.81 * dt;
      a[k] += a[k + 3] * dt;
      a[k + 1] += a[k + 4] * dt;
      a[k + 2] += a[k + 5] * dt;
      const ground = w.ground(a[k], a[k + 2]);
      if (a[k + 1] <= ground) {
        if (a[k + 6]-- <= 0 || w.sediment.inspect(a[k], a[k + 2]).water > 0.0005) {
          this.active--;
          a.copyWithin(k, this.active * 8, this.active * 8 + 8);
          continue;
        }
        a[k + 1] = ground + 0.003;
        a[k + 4] = Math.abs(a[k + 4]) * 0.48;
        a[k + 3] *= 0.76;
        a[k + 5] *= 0.76;
      }
      this.pose.position.set(a[k], a[k + 1], a[k + 2]);
      this.pose.scale.set(a[k + 7] * 1.7, a[k + 7], a[k + 7]);
      this.pose.updateMatrix();
      this.mesh.setMatrixAt(i, this.pose.matrix);
      i++;
    }
    this.mesh.count = this.active;
    this.mesh.visible = this.active > 0;
    if (this.active) this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
