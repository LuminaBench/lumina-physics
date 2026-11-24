import type { LandLibrary, PlantForm } from '../physics';
import { Vector3 } from 'three/webgpu';

export const treeId = 'reach:cindercomb';
export function flagCrown(form: PlantForm, seed: number) {
  // Short west-facing branches survive as hooks; the long leeward fan climbs in three shelves.
  const phase = (seed % 37) / 37;
  const seen = new Set<Vector3>();
  function warp(point: Vector3) {
    if (seen.has(point)) return;
    seen.add(point);
    const y = Math.max(0, point.y),
      t = y / form.height,
      west = Math.min(0, point.x);
    point.x += 0.64 * y * t - 0.55 * west;
    point.z *= 1 - 0.28 * t;
    point.y += 0.38 * Math.sin(t * 5 * Math.PI + phase) * Math.min(1, t * 2);
  }
  for (const limb of form.wood) for (const point of limb.path) warp(point);
  for (const spray of form.leaves) {
    warp(spray.root);
    warp(spray.tip);
    spray.tip.x += 0.46 * spray.span;
    spray.tip.y -= 0.26 * spray.span;
  }
  const trunk = form.wood[0];
  for (const i of [3, 4, 6]) {
    const start = trunk.path[i].clone();
    form.wood.push({
      base: trunk.base * 0.46,
      end: 0.035,
      path: [
        start,
        start.clone().add(new Vector3(-0.48, 0.31, 0.1)),
        start.clone().add(new Vector3(-0.65, 0.75, -0.09)),
      ],
    });
  }
  return form;
}
export function registerTree(lib: LandLibrary) {
  lib.define(
    'plant',
    treeId,
    {
      height: 8.9,
      breadth: 3.15,
      lean: 0.07,
      crownBase: 0.34,
      limbs: 14,
      depth: 1,
      variants: 3,
      leafWidth: 0.89,
      bark: '#68514d',
      foliage: '#ca9158',
      barkPattern: 'grooves',
      flex: 0.065,
      evergreen: false,
      grow: flagCrown,
    },
    'lumina:oak',
  );
}
