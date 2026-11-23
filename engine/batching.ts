/**
 * Draw-call batching for procedural models.
 *
 * Code-built models tend to be hundreds of small meshes that share a handful of materials.
 * `mergeStaticMeshes` bakes every mesh that never moves relative to the model root into
 * one geometry per material, leaving animated sub-trees (control surfaces, wheels,
 * propellers, anything whose visibility is toggled) untouched. A 100-mesh aircraft becomes
 * 10–20 draw calls (twice that with a shadow pass) with no change in appearance.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface MergeReport {
  /** Meshes under the root before and after. */
  before: number;
  after: number;
  /** Number of merged batches created. */
  batches: number;
}

const KEEP = ['position', 'normal', 'uv', 'color'];

/**
 * @param root     model root; merged meshes are added directly under it
 * @param dynamic  nodes that are animated (or shown / hidden) at run time: they and their
 *                 descendants are left alone
 */
export function mergeStaticMeshes(root: THREE.Object3D, dynamic: Array<THREE.Object3D | null | undefined> = []): MergeReport {
  root.updateWorldMatrix(true, true);
  const moving = new Set(dynamic.filter((o): o is THREE.Object3D => !!o));
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, THREE.Mesh[]>();
  let before = 0;

  const visit = (object: THREE.Object3D, visible: boolean, frozen: boolean): void => {
    const shown = visible && object.visible;
    const still = frozen && !moving.has(object);
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      before++;
      const instanced = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh;
      const material = mesh.material as THREE.Material;
      // Meshes with per-object uniforms in `userData` stay separate.
      const plain = shown && still && !instanced && !Array.isArray(mesh.material) && !!mesh.geometry?.attributes.position
        && !mesh.geometry.morphAttributes?.position && Object.keys(mesh.userData ?? {}).length === 0;
      if (plain) {
        const key = `${material.uuid}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|${mesh.frustumCulled ? 1 : 0}`;
        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));
        list.push(mesh);
      }
    }
    for (const child of object.children) visit(child, shown, still);
  };
  visit(root, true, true);

  let batches = 0, removed = 0;
  const matrix = new THREE.Matrix4();
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    // Only attributes every member has can survive the merge.
    const shared = KEEP.filter((name) => meshes.every((m) => m.geometry.attributes[name] !== undefined));
    const baked: THREE.BufferGeometry[] = [];
    for (const mesh of meshes) {
      let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (!shared.includes(name)) g.deleteAttribute(name);
      g.morphAttributes = {};
      matrix.multiplyMatrices(inverse, mesh.matrixWorld);
      g.applyMatrix4(matrix);
      // A mirrored part (negative scale) comes out with reversed winding: swap two corners.
      if (matrix.determinant() < 0) {
        for (const name of Object.keys(g.attributes)) {
          const a = g.attributes[name] as THREE.BufferAttribute, n = a.itemSize, arr = a.array as Float32Array;
          for (let i = 0; i < a.count; i += 3) for (let k = 0; k < n; k++) { const t = arr[(i + 1) * n + k]; arr[(i + 1) * n + k] = arr[(i + 2) * n + k]; arr[(i + 2) * n + k] = t; }
        }
      }
      g.clearGroups();
      baked.push(g);
    }
    const merged = mergeGeometries(baked, false);
    for (const g of baked) g.dispose();
    if (!merged) continue;
    const first = meshes[0];
    const batch = new THREE.Mesh(merged, first.material);
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.renderOrder = first.renderOrder;
    batch.frustumCulled = first.frustumCulled;
    batch.name = `batch:${(first.material as THREE.Material).name || 'material'}`;
    root.add(batch);
    for (const mesh of meshes) { mesh.removeFromParent(); removed++; }
    batches++;
  }
  return { before, after: before - removed + batches, batches };
}
