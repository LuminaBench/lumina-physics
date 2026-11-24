import * as T from 'three/webgpu';
import { growPlant, sprayGeometry, woodyGeometry } from '../../modules/vegetation/botany';
import { leafAtlas } from '../../modules/vegetation/atlas';
import { mulberry32 } from '../../engine/noise';

/** Clumps of silver sage grow off the two abandoned wheel paths. */
export function rainVerge(
  sites: ReadonlyArray<{ x: number; z: number }>,
  bed: (x: number, z: number) => number,
) {
  const form = growPlant('sagebrush', 91831);
  const atlas = leafAtlas('sagebrush', 91831);
  const leaves = new T.MeshStandardMaterial({
    map: atlas.leaf,
    color: '#acaa83',
    roughness: 0.87,
    alphaTest: 0.39,
    side: T.DoubleSide,
  });
  const stems = new T.MeshStandardMaterial({ color: '#6d5948', roughness: 0.95 });
  const count = 74 * sites.length;
  const crown = new T.InstancedMesh(sprayGeometry(form, true, 'sagebrush'), leaves, count);
  const wood = new T.InstancedMesh(woodyGeometry(form, true), stems, count);
  const stones = new T.InstancedMesh(
    new T.DodecahedronGeometry(1),
    new T.MeshStandardMaterial({ color: '#b29a7e', roughness: 0.95 }),
    count * 2,
  );
  const rand = mulberry32(922),
    pose = new T.Object3D(),
    tint = new T.Color();
  let i = 0,
    k = 0;
  for (const site of sites)
    for (let j = 0; j < 74; j++) {
      const side = rand() < 0.5 ? -1 : 1,
        dx = side * (4.5 + rand() ** 1.3 * 51),
        dz = (rand() - 0.46) * 115;
      const x = site.x + dx,
        z = site.z + dz,
        size = 0.42 + rand() ** 1.5 * 1.05;
      pose.position.set(x, bed(x, z) - 0.025, z);
      pose.rotation.set(0, rand() * 6.28, 0);
      pose.scale.set(size, size * (0.69 + rand() * 0.28), size);
      pose.updateMatrix();
      wood.setMatrixAt(i, pose.matrix);
      crown.setMatrixAt(i, pose.matrix);
      tint.setHSL(0.17 + rand() * 0.04, 0.08 + rand() * 0.17, 0.65 + rand() * 0.24);
      crown.setColorAt(i, tint);
      i++;
      for (let n = 0; n < 2; n++) {
        const a = site.x + side * (4.2 + rand() * 45),
          b = site.z + (rand() - 0.48) * 95;
        const s = 0.05 + rand() ** 3 * 0.81;
        pose.position.set(a, bed(a, b) + s * 0.14, b);
        pose.rotation.set(0.15 * rand(), rand() * 6, rand() * 0.16);
        pose.scale.set(s * (1 + rand()), s * (0.29 + rand() * 0.36), s);
        pose.updateMatrix();
        stones.setMatrixAt(k, pose.matrix);
        tint.setScalar(0.52 + 0.43 * rand());
        stones.setColorAt(k++, tint);
      }
    }
  const root = new T.Group();
  root.add(wood, crown, stones);
  wood.receiveShadow = crown.receiveShadow = stones.receiveShadow = true;
  return {
    root,
    dispose() {
      for (const m of [wood, crown, stones]) {
        m.dispose();
        m.geometry.dispose();
        m.material.dispose();
      }
      atlas.leaf.dispose();
      atlas.detail.dispose();
      root.removeFromParent();
    },
  };
}
