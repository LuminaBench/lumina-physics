import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL } from '../../engine/tsl';
import type { CoastalWorld } from './world';
import { shoreSite } from './coastline';

export interface CoastalPlants {
  duneHeight: number;
  duneDensity: number;
  reedHeight: number;
  reedDensity: number;
  duneColor: string;
  reedColor: string;
  wrackDensity: number;
}
export const MARSH_EDGE: CoastalPlants = {
  duneHeight: 0.61,
  duneDensity: 1,
  reedHeight: 1.55,
  reedDensity: 1,
  duneColor: '#919451',
  reedColor: '#869755',
  wrackDensity: 0.8,
};
export class CoastalHabitat {
  readonly root = new THREE.Group();
  readonly counts = { marram: 0, reeds: 0, wrack: 0, shells: 0, roots: 0 };
  private readonly meshes: THREE.Mesh[] = [];
  constructor(world: CoastalWorld, options: Partial<CoastalPlants> = {}, seed = world.coast.seed + 7919) {
    const cfg = { ...MARSH_EDGE, ...options },
      rand = mulberry32(seed),
      c = world.coast,
      site = shoreSite();
    const pos: number[] = [],
      flex: number[] = [],
      colors: number[] = [],
      index: number[] = [];
    const green = new THREE.Color(cfg.duneColor),
      reed = new THREE.Color(cfg.reedColor),
      bleached = new THREE.Color('#c4ad73'),
      tint = new THREE.Color();
    const point = { x: 0, z: 0 },
      centre = c.project(0, 0, site).along;
    const tufts = (x: number, z: number, waterReed: boolean, scale: number) => {
      const y = world.ground(x, z),
        stemCount = waterReed ? 11 : 15,
        baseHeight = (waterReed ? cfg.reedHeight : cfg.duneHeight) * scale;
      for (let s = 0; s < stemCount; s++) {
        const a = rand() * 2 * Math.PI,
          dx = Math.cos(a),
          dz = Math.sin(a),
          rad = rand() * (waterReed ? 0.57 : 0.24);
        const bx = x + dx * rad,
          bz = z + dz * rad,
          by = world.ground(bx, bz),
          h = baseHeight * (0.49 + 0.64 * rand());
        if (Math.abs(by - y) > 0.45 || c.options.protectedAt?.(bx, bz)) continue;
        const lean = h * (waterReed ? 0.12 + 0.15 * rand() : 0.32 + 0.47 * rand()),
          width = h * (waterReed ? 0.015 : 0.023);
        const shade = 0.75 + rand() * 0.32,
          base = pos.length / 3;
        for (let k = 0; k < 4; k++) {
          const f = k / 3,
            w = width * (1 - f * 0.93),
            bend = f * f * lean;
          const px = bx + dx * bend + 0.13 * h * f * f,
            pz = bz + dz * bend;
          tint
            .copy(waterReed ? reed : green)
            .lerp(bleached, waterReed ? 0.18 * f : f * f * 0.65)
            .multiplyScalar(shade * (0.63 + 0.38 * f));
          for (const sign of [-1, 1]) {
            pos.push(px + dz * w * sign, by + h * (f - 0.1 * f * f), pz - dx * w * sign);
            flex.push(f * f * h);
            colors.push(tint.r, tint.g, tint.b);
          }
          if (k)
            index.push(
              base + 2 * k - 2,
              base + 2 * k,
              base + 2 * k - 1,
              base + 2 * k - 1,
              base + 2 * k,
              base + 2 * k + 1,
            );
        }
      }
      if (waterReed) this.counts.reeds++;
      else this.counts.marram++;
    };
    for (let k = 0; k < 700; k++) {
      const along = centre + (rand() - 0.5) * (k % 3 === 0 ? 340 : world.terrain.size * 0.94),
        cross = 10 + rand() * 89;
      c.point(along, cross, point);
      c.project(point.x, point.z, site);
      if (c.options.protectedAt?.(point.x, point.z)) continue;
      const isReed = site.brackish > 0.18 && site.bank > 5 && site.bank < 24;
      const band = Math.exp(-(((cross - 52) / 23) ** 2));
      if (isReed ? rand() > cfg.reedDensity : rand() > cfg.duneDensity * band * (0.46 + 0.54 * site.shelter))
        continue;
      for (let j = 0; j < 4; j++) {
        const x = point.x + (rand() - 0.5) * 4,
          z = point.z + (rand() - 0.5) * 4;
        if (world.ground(x, z) > -0.15 && !c.options.protectedAt?.(x, z))
          tufts(x, z, isReed, 0.65 + 0.61 * rand());
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('bend', new THREE.Float32BufferAttribute(flex, 1));
    geom.setIndex(index);
    geom.computeVertexNormals();
    const blades = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.92,
    });
    const p = TSL.positionGeometry,
      w = world.engine.wind.node(p);
    blades.colorNode = world.foliageTint;
    blades.positionNode = p.add(TSL.vec3(w.x, 0, w.z).mul(TSL.attribute('bend', 'float')).mul(0.019));
    const grass = new THREE.Mesh(geom, blades);
    grass.name = 'Coastal grass rooted in sand';
    grass.receiveShadow = true;
    this.root.add(grass);
    this.meshes.push(grass);
    const dummy = new THREE.Object3D(),
      col = new THREE.Color();
    const batches = [
      {
        id: 'shells' as const,
        n: 520,
        geo: new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.64),
        color: 0xd9c8ad,
      },
      { id: 'wrack' as const, n: 180, geo: new THREE.IcosahedronGeometry(1, 0), color: 0x625039 },
      { id: 'roots' as const, n: 120, geo: new THREE.CylinderGeometry(0.6, 1, 1, 6), color: 0x836849 },
    ];
    for (const b of batches) {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84 }),
        obj = new THREE.InstancedMesh(b.geo, m, b.n);
      for (let i = 0; i < b.n; i++) {
        const a = centre + (rand() - 0.5) * world.terrain.size * 0.82,
          cluster = 2.8 * Math.sin(a / 15) + 1.7 * Math.cos(a / 5.6);
        const cross =
          b.id === 'roots' ? 24 + rand() * 9 : 5.8 + cluster + rand() * (b.id === 'shells' ? 14 : 2.7);
        if (b.id === 'wrack' && rand() > cfg.wrackDensity) continue;
        c.point(a, cross, point);
        if (c.options.protectedAt?.(point.x, point.z)) continue;
        const y = world.ground(point.x, point.z),
          sz = 0.45 + rand();
        if (y < 0.12) continue;
        dummy.position.set(point.x, y + 0.009, point.z);
        dummy.rotation.set((rand() - 0.5) * 0.19, rand() * 6.28, (rand() - 0.5) * 0.21);
        if (b.id === 'shells') dummy.scale.set(0.033 * sz, 0.008 * sz, 0.023 * sz);
        else if (b.id === 'wrack') dummy.scale.set((0.1 + rand() * 0.57) * sz, 0.026 * sz, 0.064 * sz);
        else {
          dummy.rotation.z = 1.08 + rand() * 0.42;
          dummy.scale.set(0.035 * sz, 0.56 * sz, 0.056 * sz);
        }
        dummy.updateMatrix();
        const k = this.counts[b.id]++;
        obj.setMatrixAt(k, dummy.matrix);
        col.setHex(b.color).multiplyScalar(0.71 + rand() * 0.48);
        obj.setColorAt(k, col);
      }
      obj.count = this.counts[b.id];
      obj.receiveShadow = true;
      obj.computeBoundingSphere();
      this.root.add(obj);
      this.meshes.push(obj);
    }
    world.engine.scene.add(this.root);
  }
  dispose() {
    this.root.removeFromParent();
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      if (m instanceof THREE.InstancedMesh) m.dispose();
    }
  }
}
