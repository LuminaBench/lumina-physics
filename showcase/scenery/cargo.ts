import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TSL as t } from '../../engine/tsl';
import { spriteNoise } from '../../engine/noise';
import { perturbNormalHeight } from '../../engine/shading';

/** Dock props are shaded in their own coordinates so the grain, scuffs and
 * pressed steel travel with a floating or tumbling Rapier body. */
export function makeDockCargo() {
  const crateGeometry = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const crate = new THREE.MeshStandardNodeMaterial({ color: 0xd1a378, roughness: 0.83 });
  const st = t.uv(),
    edge = t.min(st, t.vec2(1).sub(st));
  const perimeter = t.min(edge.x, edge.y);
  const brace = t.max(
    t.smoothstep(0.085, 0.073, perimeter),
    t.smoothstep(0.052, 0.043, t.abs(st.y.sub(st.x))).mul(t.smoothstep(0.07, 0.1, perimeter))
  );
  const grainUV = t.mix(st, t.vec2(st.x.add(st.y).mul(0.707), st.y.sub(st.x).mul(0.707)), brace);
  const growth = spriteNoise(grainUV.mul(t.vec2(2.8, 36)));
  const grain = spriteNoise(grainUV.mul(t.vec2(9, 115)).add(growth.mul(1.7)), 1);
  const board = st.y.mul(5),
    joint = t.min(t.fract(board), t.fract(board).oneMinus());
  const gap = t.smoothstep(0.012, 0.032, joint).mul(brace.oneMinus()).add(brace);
  const nail = t.smoothstep(
    0.009,
    0.005,
    t.length(t.vec2(edge.x.sub(0.047), t.fract(board.sub(0.09).add(0.5)).sub(0.5).mul(0.2)))
  );
  const wood = growth
    .mul(0.28)
    .add(grain.mul(0.19))
    .add(0.49)
    .mul(t.mix(0.28, 1, gap))
    .mul(t.mix(1, 1.14, brace));
  crate.colorNode = t.mix(t.materialColor.rgb.mul(wood), t.vec3(0.083, 0.072, 0.057), nail);
  crate.metalnessNode = nail.mul(0.78);
  crate.normalNode = perturbNormalHeight(grain.mul(0.0008).add(brace.mul(0.006)).add(gap.mul(0.0018)), 1);

  // Rolled lid and toe seams, two pressed hoops and a recessed sealed top.
  const profile = [
    [0, -0.446],
    [0.277, -0.446],
    [0.29, -0.45],
    [0.3, -0.444],
    [0.3, -0.432],
    [0.286, -0.423],
    [0.286, -0.181],
    [0.288, -0.174],
    [0.298, -0.167],
    [0.3, -0.155],
    [0.295, -0.147],
    [0.286, -0.14],
    [0.286, 0.14],
    [0.295, 0.147],
    [0.3, 0.155],
    [0.298, 0.167],
    [0.288, 0.174],
    [0.286, 0.181],
    [0.286, 0.421],
    [0.3, 0.432],
    [0.3, 0.444],
    [0.292, 0.45],
    [0.281, 0.449],
    [0.277, 0.433],
    [0, 0.433],
  ];
  const shell = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    40
  );
  const cap = new THREE.CylinderGeometry(0.032, 0.032, 0.009, 8).translate(0.13, 0.439, 0.12);
  const vent = new THREE.CylinderGeometry(0.017, 0.017, 0.007, 8).translate(-0.15, 0.438, -0.1);
  const drumGeometry = mergeGeometries([shell, cap, vent])!;
  shell.dispose();
  cap.dispose();
  vent.dispose();

  const drum = new THREE.MeshStandardNodeMaterial({ color: 0xa63923, roughness: 0.42 });
  const p = t.positionGeometry,
    radius = t.length(p.xz);
  const steel = t.max(t.smoothstep(0.289, 0.298, radius), t.smoothstep(0.435, 0.445, p.y));
  const wearUV = t.vec2(p.x.mul(2.3).add(p.z), p.y);
  const grit = spriteNoise(wearUV.mul(37));
  const flecks = t.smoothstep(0.65, 0.85, grit).mul(t.smoothstep(0.282, 0.297, radius));
  const worn = t.max(flecks, steel.mul(grit.mul(0.52).add(0.48)));
  const stripe = t.smoothstep(0.029, 0.024, t.abs(p.y.sub(0.24))).mul(t.smoothstep(0.28, 0.285, radius));
  const paint = t.mix(t.materialColor.rgb, t.vec3(0.55, 0.47, 0.32), stripe).mul(grit.mul(0.12).add(0.91));
  drum.colorNode = t.mix(paint, t.vec3(0.18, 0.155, 0.13), worn);
  drum.metalnessNode = t.mix(0.08, 0.87, worn);
  drum.roughnessNode = t.mix(grit.mul(0.17).add(0.34), 0.54, worn);
  return { crateGeometry, crate, drumGeometry, drum };
}
