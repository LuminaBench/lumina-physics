import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';

export const SPECIES = ['cypress', 'oak', 'palm', 'willow', 'gorse', 'fern', 'sagebrush', 'heather'] as const;
export type Species = (typeof SPECIES)[number];
type Point = THREE.Vector3;
export interface Limb {
  path: Point[];
  base: number;
  end: number;
}
export interface Spray {
  root: Point;
  tip: Point;
  span: number;
  angle: number;
}
export interface PlantForm {
  wood: Limb[];
  leaves: Spray[];
  height: number;
  radius: number;
}
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Absolute metres. Lateral shoots inherit the tangent and origin of the supporting limb. */
export function growPlant(species: Species, seed: number): PlantForm {
  const rand = mulberry32(seed);
  const config = {
    cypress: [8.4, 2.38, 34],
    oak: [7.3, 3.9, 13],
    palm: [8.4, 3.6, 15],
    willow: [7.5, 3.6, 18],
    gorse: [1.45, 1.15, 11],
    fern: [0.95, 1.05, 11],
    sagebrush: [0.93, 0.93, 12],
    heather: [0.58, 0.55, 17],
  }[species];
  const [h, width, arms] = config;
  const wood: Limb[] = [],
    leaves: Spray[] = [];
  const palm = species === 'palm',
    fern = species === 'fern',
    pine = species === 'cypress',
    willow = species === 'willow';
  const lean = palm ? 0.18 : pine ? 0.18 : 0.058;
  const trunk = (t: number) =>
    v(h * lean * t * t + h * 0.024 * Math.sin(Math.PI * t * 2), h * t, h * 0.045 * t * t);
  const trunkFraction = palm ? 0.85 : fern ? 0.08 : pine ? 0.99 : 0.72;
  if (!fern)
    wood.push({
      path: Array.from({ length: palm ? 17 : 9 }, (_, i) => trunk((trunkFraction * i) / (palm ? 16 : 8))),
      base: h * (palm ? 0.027 : 0.036),
      end: h * (palm ? 0.016 : 0.003),
    });
  if (pine || willow || species === 'oak') {
    for (let i = 0; i < 5; i++) {
      const a = i * 2.39996 + rand() * 0.46,
        reach = h * (0.068 + 0.048 * rand());
      wood.push({
        path: [
          trunk(0.095),
          v(Math.cos(a) * reach * 0.48, h * 0.037, Math.sin(a) * reach * 0.48),
          v(Math.cos(a) * reach, -h * 0.037, Math.sin(a) * reach),
        ],
        base: h * 0.023,
        end: h * 0.004,
      });
    }
  }
  function branch(root: Point, angle: number, length: number, rise: number, girth: number, depth: number) {
    const side = (rand() - 0.5) * length * 0.44,
      arch = length * (willow ? 0.29 : pine ? 0.05 : 0.15);
    const at = (t: number) =>
      root
        .clone()
        .add(
          v(
            Math.cos(angle) * length * t - Math.sin(angle) * side * t * t,
            rise * t + Math.sin(t * Math.PI) * arch,
            Math.sin(angle) * length * t + Math.cos(angle) * side * t * t,
          ),
        );
    wood.push({ path: [at(0), at(0.38), at(0.72), at(1)], base: girth, end: girth * 0.19 });
    if (depth > 0) {
      for (let i = 0; i < 3; i++) {
        const f = 0.36 + i * 0.23 + rand() * 0.12,
          a = angle + (i % 2 ? 1 : -1) * (0.38 + rand() * 0.83);
        const l = length * (0.39 + rand() * 0.22);
        branch(
          at(f),
          a,
          l,
          willow ? -l * (0.45 + rand() * 0.64) : l * (pine ? -0.12 + rand() * 0.35 : -0.3 + rand() * 1.32),
          girth * 0.37,
          depth - 1,
        );
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const a = angle + (i % 2 ? 1 : -1) * (0.34 + rand() * 1.14),
          l = (pine ? 0.79 : willow ? 0.95 : 0.93) * width * (0.21 + rand() * 0.19);
        const start = at(0.25 + i * 0.23);
        const end = start
          .clone()
          .add(v(Math.cos(a) * l, (willow ? -1.13 : -0.45 + rand() * 1.31) * l, Math.sin(a) * l));
        leaves.push({ root: start, tip: end, span: l * (pine ? 0.95 : 1.12), angle: a });
      }
    }
  }
  for (let j = 0; j < arms; j++) {
    const f = (j + 0.5) / arms,
      a = j * 2.39996 + rand() * 0.42;
    if (palm || fern) {
      const o = trunk(fern ? rand() * 0.08 : trunkFraction - rand() * 0.027);
      const length = width * (0.54 + 0.52 * Math.sqrt(1 - f)),
        rise = (palm ? 1.18 : 0.51) * (0.45 + f);
      const path = Array.from({ length: 9 }, (_, i) => {
        const t = i / 8;
        return o
          .clone()
          .add(
            v(
              Math.cos(a) * length * t,
              Math.sin(Math.PI * t) * rise + length * (f * 0.59 - (palm ? 0.48 : 0.04)) * t,
              Math.sin(a) * length * t,
            ),
          );
      });
      wood.push({ path, base: palm ? 0.047 : 0.012, end: 0.002 });
      for (let i = 0; i < 8; i++)
        leaves.push({
          root: path[i],
          tip: path[i + 1],
          span: length * (0.12 + 0.29 * Math.sin(((i + 0.65) / 8) * Math.PI)),
          angle: a,
        });
    } else {
      const level = pine
        ? 0.19 + 0.77 * f
        : species === 'gorse' || species === 'heather' || species === 'sagebrush'
          ? 0.06 + 0.38 * f
          : 0.21 + 0.53 * f;
      const reach =
        width * (pine ? 1 - 0.84 * f : 0.74 + 0.26 * Math.sin(f * Math.PI)) * (0.62 + 0.32 * rand());
      branch(
        trunk(level),
        a,
        reach,
        pine ? reach * (0.08 + 0.19 * f) : h * (0.03 + 0.16 * f + 0.1 * rand()),
        h * (pine ? 0.01 : 0.02) * (1 - 0.55 * f),
        species === 'oak' ? 2 : 1,
      );
    }
  }
  const points = [...wood.flatMap((b) => b.path), ...leaves.flatMap((l) => [l.root, l.tip])];
  return {
    wood,
    leaves,
    height: Math.max(...points.map((p) => p.y)) + 0.15 * width,
    radius: Math.max(...points.map((p) => Math.hypot(p.x, p.z))) + 0.4 * width,
  };
}

function finish(pos: number[], normal: number[], uv: number[], ids: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ids);
  g.computeBoundingSphere();
  return g;
}

export function woodyGeometry(form: PlantForm, mid: boolean) {
  const pos: number[] = [],
    norm: number[] = [],
    uv: number[] = [],
    ids: number[] = [];
  for (const b of form.wood) {
    if (mid && b.base < form.height * 0.004) continue;
    const segments = mid ? 4 : b.base > form.height * 0.025 ? 9 : 5;
    const path =
      mid && b.path.length > 4 ? b.path.filter((_, i) => i % 2 === 0 || i === b.path.length - 1) : b.path;
    const start = pos.length / 3;
    let dist = 0;
    for (let j = 0; j < path.length; j++) {
      const t = j / (path.length - 1),
        p = path[j],
        dir = path[Math.min(j + 1, path.length - 1)]
          .clone()
          .sub(path[Math.max(0, j - 1)])
          .normalize();
      const right = v(0, 0, 1).cross(dir).normalize(),
        front = dir.clone().cross(right);
      if (j) dist += p.distanceTo(path[j - 1]);
      const radius = THREE.MathUtils.lerp(b.base, b.end, t) * (1 + 0.28 * Math.exp(-t * 14));
      for (let k = 0; k <= segments; k++) {
        const a = (k * 2 * Math.PI) / segments,
          n = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(front, Math.sin(a));
        pos.push(p.x + n.x * radius, p.y + n.y * radius, p.z + n.z * radius);
        norm.push(n.x, n.y, n.z);
        uv.push((k / segments) * 2 * Math.PI * b.base, dist);
        if (j && k) {
          const z = start + j * (segments + 1) + k;
          ids.push(z - segments - 2, z - segments - 1, z, z - segments - 2, z, z - 1);
        }
      }
    }
  }
  return finish(pos, norm, uv, ids);
}

export function sprayGeometry(form: PlantForm, mid: boolean, species: Species) {
  const pos: number[] = [],
    norm: number[] = [],
    uv: number[] = [],
    ids: number[] = [];
  const pinnate = species === 'palm' || species === 'fern';
  for (let i = 0; i < form.leaves.length; i++) {
    if (mid && !pinnate && i % 3 === 1) continue;
    const s = form.leaves[i],
      cent = s.root.clone().lerp(s.tip, 0.5);
    const normal = v(cent.x, (cent.y / form.height - 0.45) * form.radius * 0.8, cent.z).normalize();
    const dir = s.tip.clone().sub(s.root),
      right = v(-Math.sin(s.angle), 0, Math.cos(s.angle)).multiplyScalar(s.span * (mid ? 1.13 : 1) * 0.62);
    if (!pinnate) {
      const tilt = Math.sin(i * 2.38) * 0.93;
      right.multiplyScalar(Math.cos(tilt));
      right.y = Math.sin(tilt) * s.span * 0.68;
    }
    const curve = dir.length() * (pinnate ? 0.09 : 0.16);
    const start = pos.length / 3;
    for (let j = 0; j <= 2; j++) {
      const t = j / 2,
        p = s.root.clone().addScaledVector(dir, t);
      p.y += Math.sin(Math.PI * t) * curve;
      for (const sign of [-1, 1]) {
        const out = p.clone().addScaledVector(right, sign);
        pos.push(out.x, out.y, out.z);
        norm.push(normal.x, normal.y + 0.25, normal.z);
        uv.push((sign + 1) / 2, t);
      }
    }
    ids.push(
      start,
      start + 1,
      start + 2,
      start + 1,
      start + 3,
      start + 2,
      start + 2,
      start + 3,
      start + 4,
      start + 3,
      start + 5,
      start + 4,
    );
  }
  return finish(pos, norm, uv, ids);
}
