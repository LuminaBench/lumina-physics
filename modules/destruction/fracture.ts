/**
 * Pure-code convex fracture.
 *
 * A solid is a convex polyhedron stored as planar faces. Voronoi fracture intersects it
 * with the bisector half-spaces between a site and its neighbours, so every cell is convex
 * by construction (which is exactly what a rigid-body engine wants for a collider) and
 * knows which neighbour produced each of its cut faces (which gives the connectivity graph
 * used for structural collapse). Material character comes only from where the sites go:
 *
 *   concrete   scattered in the volume, denser near the impact (rubble)
 *   glass      rings and spokes in the pane, through its full thickness (radial shards)
 *   wood       scattered in a space squashed along the grain (long splinters)
 *   brick      no Voronoi at all: a running-bond grid of blocks
 */
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';

export interface Face {
  points: THREE.Vector3[];
  normal: THREE.Vector3;
  /** Index of the neighbouring cell that cut this face, or -1 for the original surface. */
  neighbour: number;
}

export interface Cell {
  faces: Face[];
  centroid: THREE.Vector3;
  /** m³ */
  volume: number;
  /** Cells sharing a cut face with this one. */
  neighbours: number[];
  /** Bounding radius about the centroid. */
  radius: number;
}

const EPS = 1e-7;

/** An axis-aligned box centred on the origin as six faces. */
export function boxFaces(size: THREE.Vector3): Face[] {
  const x = size.x / 2, y = size.y / 2, z = size.z / 2;
  const v = (a: number, b: number, c: number) => new THREE.Vector3(a, b, c);
  const quad = (n: THREE.Vector3, p: THREE.Vector3[]): Face => ({ points: p, normal: n, neighbour: -1 });
  return [
    quad(v(1, 0, 0), [v(x, -y, -z), v(x, y, -z), v(x, y, z), v(x, -y, z)]),
    quad(v(-1, 0, 0), [v(-x, -y, z), v(-x, y, z), v(-x, y, -z), v(-x, -y, -z)]),
    quad(v(0, 1, 0), [v(-x, y, -z), v(-x, y, z), v(x, y, z), v(x, y, -z)]),
    quad(v(0, -1, 0), [v(-x, -y, z), v(-x, -y, -z), v(x, -y, -z), v(x, -y, z)]),
    quad(v(0, 0, 1), [v(-x, -y, z), v(x, -y, z), v(x, y, z), v(-x, y, z)]),
    quad(v(0, 0, -1), [v(x, -y, -z), v(-x, -y, -z), v(-x, y, -z), v(x, y, -z)]),
  ];
}

/**
 * Keep the part of a convex polyhedron on the negative side of the plane `n·x = d`. The cut
 * is closed with a new face tagged `tag`.
 */
export function clipFaces(faces: Face[], n: THREE.Vector3, d: number, tag: number): Face[] {
  const out: Face[] = [];
  const rim: THREE.Vector3[] = [];
  for (const face of faces) {
    const pts = face.points;
    const kept: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const da = n.dot(a) - d, db = n.dot(b) - d;
      if (da <= EPS) kept.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const p = a.clone().lerp(b, da / (da - db));
        kept.push(p);
        rim.push(p.clone());
      }
    }
    if (kept.length >= 3) out.push({ points: kept, normal: face.normal, neighbour: face.neighbour });
  }
  if (rim.length >= 3) {
    // The cut of a convex solid is a convex polygon: order its points by angle about their centre.
    const centre = rim.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / rim.length);
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const sorted = rim
      .map((p) => ({ p, angle: Math.atan2(p.clone().sub(centre).dot(w), p.clone().sub(centre).dot(u)) }))
      .sort((a, b) => a.angle - b.angle);
    const loop: THREE.Vector3[] = [];
    for (const { p } of sorted) if (!loop.length || loop[loop.length - 1].distanceToSquared(p) > 1e-10) loop.push(p);
    if (loop.length >= 3) out.push({ points: loop, normal: n.clone(), neighbour: tag });
  }
  return out;
}

function measure(faces: Face[]): { centroid: THREE.Vector3; volume: number; radius: number } {
  // Reference point inside the solid, then signed tetrahedra to each face triangle.
  const ref = new THREE.Vector3();
  let count = 0;
  for (const f of faces) for (const p of f.points) { ref.add(p); count++; }
  ref.multiplyScalar(1 / Math.max(count, 1));
  const centroid = new THREE.Vector3();
  let volume = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t = new THREE.Vector3();
  for (const f of faces) {
    for (let i = 1; i + 1 < f.points.length; i++) {
      a.subVectors(f.points[0], ref); b.subVectors(f.points[i], ref); c.subVectors(f.points[i + 1], ref);
      const v = Math.abs(a.dot(t.crossVectors(b, c))) / 6;
      volume += v;
      centroid.addScaledVector(t.copy(f.points[0]).add(f.points[i]).add(f.points[i + 1]).add(ref), v / 4);
    }
  }
  if (volume > 1e-12) centroid.multiplyScalar(1 / volume); else centroid.copy(ref);
  let radius = 0;
  for (const f of faces) for (const p of f.points) radius = Math.max(radius, p.distanceTo(centroid));
  return { centroid, volume, radius };
}

/** Voronoi cells of `sites` inside a convex solid. Sites outside the solid still cut it. */
export function voronoiCells(solid: Face[], sites: THREE.Vector3[]): Cell[] {
  const cells: Cell[] = [];
  const n = new THREE.Vector3();
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    let faces = solid.map((f) => ({ points: f.points.map((p) => p.clone()), normal: f.normal.clone(), neighbour: -1 }));
    const order = sites.map((s, j) => ({ j, d: s.distanceTo(site) })).filter((o) => o.j !== i).sort((a, b) => a.d - b.d);
    let reach = 0;
    for (const f of faces) for (const p of f.points) reach = Math.max(reach, p.distanceTo(site));
    for (const { j, d } of order) {
      // No further site can cut the cell once its bisector lies beyond the farthest vertex.
      if (d * 0.5 > reach) break;
      if (d < 1e-6) continue;
      n.subVectors(sites[j], site).multiplyScalar(1 / d);
      faces = clipFaces(faces, n, n.dot(site) + d * 0.5, j);
      if (faces.length < 4) break;
      reach = 0;
      for (const f of faces) for (const p of f.points) reach = Math.max(reach, p.distanceTo(site));
    }
    if (faces.length < 4) { cells.push({ faces: [], centroid: site.clone(), volume: 0, neighbours: [], radius: 0 }); continue; }
    const m = measure(faces);
    cells.push({ faces, ...m, neighbours: [...new Set(faces.map((f) => f.neighbour).filter((k) => k >= 0))] });
  }
  // Drop empty cells and re-index the neighbour links.
  const remap = new Map<number, number>();
  const kept = cells.filter((c, i) => { if (c.volume > 1e-9) { remap.set(i, remap.size); return true; } return false; });
  for (const cell of kept) {
    cell.neighbours = cell.neighbours.filter((k) => remap.has(k)).map((k) => remap.get(k)!);
    for (const f of cell.faces) f.neighbour = f.neighbour >= 0 ? remap.get(f.neighbour) ?? -2 : -1;
  }
  return kept;
}

/** Width of the bedding joint between the physical brick hulls, in metres. */
export const BRICK_JOINT_M = 0.006;

export type FractureMaterial = 'concrete' | 'glass' | 'wood' | 'brick';

export interface FractureOptions {
  /** Box dimensions in metres (local X, Y, Z). */
  size: THREE.Vector3;
  material: FractureMaterial;
  /** Approximate number of pieces. */
  pieces?: number;
  /** Local point the pattern is centred on (glass: where the cracks radiate from). */
  focus?: THREE.Vector3;
  seed?: number;
  /** Local axis of the wood grain (0 = X, 1 = Y, 2 = Z). Defaults to the longest side. */
  grain?: 0 | 1 | 2;
}

/** kg/m³ */
export const DENSITY: Record<FractureMaterial, number> = { concrete: 2400, glass: 2500, wood: 620, brick: 1900 };

/** Pre-fracture a box into convex cells whose character matches the material. */
export function fractureBox(o: FractureOptions): Cell[] {
  const { size } = o;
  const random = mulberry32(o.seed ?? 7);
  const count = Math.max(2, o.pieces ?? 24);
  const focus = o.focus ?? new THREE.Vector3();
  const half = size.clone().multiplyScalar(0.5);
  const inside = () => new THREE.Vector3((random() * 2 - 1) * half.x, (random() * 2 - 1) * half.y, (random() * 2 - 1) * half.z);

  if (o.material === 'brick') {
    // Running bond: courses of blocks, every other course offset by half a brick.
    const brick = new THREE.Vector3(0.44, 0.2, Math.min(size.z, size.x));
    const thin = size.z <= size.x ? 2 : 0;       // axis of the wall thickness
    const lengthAxis = thin === 2 ? 0 : 2;
    const courses = Math.max(1, Math.round(size.y / brick.y));
    const per = Math.max(1, Math.round(size.getComponent(lengthAxis) / brick.x));
    const h = size.y / courses, l = size.getComponent(lengthAxis) / per;
    const cells: Cell[] = [];
    const index = new Map<string, number>();
    for (let c = 0; c < courses; c++) {
      const offset = c % 2 ? 0.5 : 0;
      for (let b = -1; b <= per; b++) {
        const from = Math.max(0, (b + offset) * l), to = Math.min(size.getComponent(lengthAxis), (b + 1 + offset) * l);
        if (to - from < 0.02) continue;
        const dims = new THREE.Vector3();
        dims.setComponent(lengthAxis, to - from - BRICK_JOINT_M); dims.y = h - BRICK_JOINT_M; dims.setComponent(thin, size.getComponent(thin));
        const centre = new THREE.Vector3();
        centre.setComponent(lengthAxis, (from + to) / 2 - half.getComponent(lengthAxis)); centre.y = (c + 0.5) * h - half.y;
        const faces = boxFaces(dims);
        for (const f of faces) for (const p of f.points) p.add(centre);
        index.set(`${c}:${b}`, cells.length);
        cells.push({ faces, ...measure(faces), neighbours: [] });
      }
    }
    // Mortar joints: same course left / right, and the two bricks each one rests on.
    for (const [key, i] of index) {
      const [c, b] = key.split(':').map(Number);
      const shift = c % 2 ? 0 : -1;
      for (const k of [`${c}:${b - 1}`, `${c}:${b + 1}`, `${c - 1}:${b + shift}`, `${c - 1}:${b + shift + 1}`, `${c + 1}:${b + shift}`, `${c + 1}:${b + shift + 1}`]) {
        const j = index.get(k);
        if (j !== undefined && !cells[i].neighbours.includes(j)) cells[i].neighbours.push(j);
      }
    }
    return cells;
  }

  let sites: THREE.Vector3[] = [];
  let stretch = new THREE.Vector3(1, 1, 1);
  if (o.material === 'glass') {
    // The pane's thin axis; sites sit on its mid-plane so every crack runs through the glass.
    const thin = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
    const u = (thin + 1) % 3, w = (thin + 2) % 3;
    const reach = Math.hypot(size.getComponent(u), size.getComponent(w));
    const rings = Math.max(2, Math.round(Math.sqrt(count / 5)));
    let radius = reach * 0.045;
    sites.push(focus.clone().setComponent(thin, 0));
    for (let r = 0; r < rings; r++) {
      const spokes = Math.round(5 + r * (count / rings / 2.2));
      const phase = random() * Math.PI * 2;
      for (let s = 0; s < spokes; s++) {
        const angle = phase + ((s + (random() - 0.5) * 0.55) / spokes) * Math.PI * 2;
        const rr = radius * (0.8 + random() * 0.45);
        const p = focus.clone();
        p.setComponent(u, p.getComponent(u) + Math.cos(angle) * rr);
        p.setComponent(w, p.getComponent(w) + Math.sin(angle) * rr);
        p.setComponent(thin, 0);
        sites.push(p);
      }
      radius *= 2.1;
    }
    // Keep only sites that can own part of the pane.
    sites = sites.filter((p) => Math.abs(p.getComponent(u)) < half.getComponent(u) * 1.6 && Math.abs(p.getComponent(w)) < half.getComponent(w) * 1.6);
  } else if (o.material === 'wood') {
    const grain = o.grain ?? (size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2);
    // Fracture in a space squashed along the grain: cells come out as long splinters.
    stretch.setComponent(grain, 0.16);
    for (let i = 0; i < count; i++) sites.push(inside());
  } else {
    // Concrete: half the sites cluster around the focus (small rubble), the rest are large blocks.
    const spread = Math.max(size.x, size.y, size.z) * 0.22;
    for (let i = 0; i < count; i++) {
      if (i % 2 === 0 && o.focus) {
        const p = focus.clone().add(new THREE.Vector3((random() * 2 - 1) * spread, (random() * 2 - 1) * spread, (random() * 2 - 1) * spread));
        sites.push(p.clamp(half.clone().negate(), half));
      } else sites.push(inside());
    }
  }

  const scaledSize = size.clone().multiply(stretch);
  const scaledSites = sites.map((s) => s.clone().multiply(stretch));
  const cells = voronoiCells(boxFaces(scaledSize), scaledSites);
  if (stretch.x !== 1 || stretch.y !== 1 || stretch.z !== 1) {
    const inverse = new THREE.Vector3(1 / stretch.x, 1 / stretch.y, 1 / stretch.z);
    for (const cell of cells) {
      for (const f of cell.faces) {
        for (const p of f.points) p.multiply(inverse);
        f.normal.multiply(stretch).normalize();
      }
      Object.assign(cell, measure(cell.faces));
    }
  }
  return cells;
}
