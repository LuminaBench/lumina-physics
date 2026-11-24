import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import type { WorldBus } from '../../engine/world-bus';
import { alpineStage, riverCenter } from './earth';
import { terrainReading } from '../terrain/surface';
import type { AuthoredLandscape } from './authored';

/** A finite meltwater channel. Its bed, visual surface and world-field sampler use the same stage. */
export function alpineStream(land: AuthoredLandscape, fields: WorldBus) {
  const surface = land.surface,
    seed = land.seeds.terrain,
    read = terrainReading(),
    half = surface.size / 2;
  const height = (z: number) => alpineStage(z) * land.region.relief;
  // Find the shoreline against the host surface. Dry sections may pinch completely shut.
  const bank = (centre: number, z: number, side: number) => {
    let wet = 0,
      dry = 11;
    if (surface.sample(centre, z, read).height >= height(z)) return centre;
    for (let k = 0; k < 7; k++) {
      const q = (wet + dry) * 0.5;
      if (surface.sample(centre + q * side, z, read).height < height(z)) wet = q;
      else dry = q;
    }
    return centre + side * wet;
  };
  const points: number[] = [],
    indices: number[] = [];
  for (let j = 0; j <= 224; j++) {
    const z = ((j / 224) * 2 - 1) * half,
      c = riverCenter(z, seed),
      y = height(z);
    points.push(bank(c, z, -1), y, z, bank(c, z, 1), y, z);
    if (j) {
      const i = j * 2;
      indices.push(i - 2, i, i - 1, i - 1, i, i + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ color: '#497b77', metalness: 0.16, roughness: 0.19 });
  const p = TSL.positionWorld,
    t = land.lighting.time;
  const riffle=p.z.mul(4.3).add(t.mul(3.1)).add(p.x.mul(2.8).add(p.z.mul(.84)).sin().mul(2.1));
  const crests=riffle.sin().mul(p.x.mul(1.2).sub(p.z.mul(.48)).add(t.mul(.77)).cos()).mul(.5).add(.5);
  material.colorNode=TSL.mix(TSL.color('#476768'),TSL.color('#92aaa4'),crests.pow(11).mul(.27));
  material.roughnessNode = crests.mul(0.14).add(0.16);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Glacier-fed stream';
  const unregister = fields.addWater({
    heightAt(x, z, velocity) {
      if (
        Math.abs(z) > half ||
        Math.abs(x - riverCenter(z, seed)) > 11 ||
        surface.sample(x, z, read).height >= height(z)
      )
        return NaN;
      if (velocity) velocity.set((riverCenter(z - 0.5, seed) - riverCenter(z + 0.5, seed)) * 1.5, 0, -1.5);
      return height(z);
    },
  });
  return {
    mesh,
    dispose() {
      unregister();
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
