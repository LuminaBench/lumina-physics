/**
 * Ready-made cloth and rope pieces. Each builder returns a solver spec plus a default
 * transform and look; `ClothSystem` exposes them as `flag()`, `banner()`, `sail()`,
 * `parachute()`, `rope()` and `powerLines()`.
 *
 * Local frames: flags fly along +X from a hoist on the Y axis; banners and sails hang in
 * the XY plane from their top edge; a parachute's payload is the local origin; ropes are
 * authored directly in world space unless they follow an object.
 */
import * as THREE from 'three/webgpu';
import type { PieceSpec } from './types';
import type { PieceLook } from './cloth';
import type { ClothPattern } from './patterns';

export interface Built { spec: PieceSpec; matrix: THREE.Matrix4; look: PieceLook }

/** Grid resolution scaled by the system's detail (the CPU solver runs coarser grids). */
const grid = (n: number, detail: number): number => Math.max(4, Math.round(n * detail));

const yawMatrix = (origin: THREE.Vector3, yaw: number): THREE.Matrix4 => new THREE.Matrix4().makeRotationY(yaw).setPosition(origin);

export interface FlagOptions {
  /** Top of the hoist (where the flag meets the pole), world space. */
  origin: THREE.Vector3;
  width?: number;
  height?: number;
  /** Heading of the fly at rest (radians about Y). The wind decides where it really points. */
  yaw?: number;
  cols?: number;
  rows?: number;
  pattern?: ClothPattern;
  colors?: THREE.ColorRepresentation[];
  follow?: THREE.Object3D;
  /** Optional stretch ratio above which the cloth tears automatically (0 = off). */
  tearThreshold?: number;
}

export function flagSpec(o: FlagOptions, detail = 1): Built {
  const width = o.width ?? 2.4, height = o.height ?? 1.5;
  const cols = grid(o.cols ?? 28, detail), rows = grid(o.rows ?? 18, detail);
  const dx = width / (cols - 1), dy = height / (rows - 1);
  return {
    spec: {
      kind: 'cloth', cols, rows, spacing: [dx, dy],
      rest: (ix, iy, out) => out.set(ix * dx, -iy * dy, 0),
      // Start hanging so the wind picks it up instead of it dropping from a flat sheet.
      start: (ix, iy, out) => out.set(ix * dx * 0.25, -iy * dy - ix * dx * 0.9, Math.sin(ix * 0.7) * 0.02),
      pinned: (ix) => ix === 0,
      // Long-range attachment: no point can be further from the hoist than the cloth allows.
      tether: (ix, iy) => ix === 0 ? null : { anchor: new THREE.Vector3(0, -iy * dy, 0), length: ix * dx * 1.03 },
      stiffness: 0.92, bend: 0.12, dragNormal: 6.5, dragTangent: 0.35, gravity: 0.55, damping: 0.25, flutter: 1,
      tearThreshold: o.tearThreshold ?? 0,
    },
    matrix: yawMatrix(o.origin, o.yaw ?? 0),
    look: { pattern: o.pattern ?? 'stripes', colors: o.colors ?? [0xb8141f, 0xf2efe6], translucency: 0.4 },
  };
}

export interface BannerOptions {
  /** Centre of the top edge, world space. */
  origin: THREE.Vector3;
  width?: number;
  height?: number;
  yaw?: number;
  cols?: number;
  rows?: number;
  /** 'edge' hangs from a rod; 'corners' is strung from its two top corners and sags. */
  hang?: 'edge' | 'corners';
  pattern?: ClothPattern;
  colors?: THREE.ColorRepresentation[];
  follow?: THREE.Object3D;
  /** Optional stretch ratio above which the banner tears automatically (0 = off). */
  tearThreshold?: number;
}

export function bannerSpec(o: BannerOptions, detail = 1): Built {
  const width = o.width ?? 3, height = o.height ?? 1.2;
  const cols = grid(o.cols ?? 30, detail), rows = grid(o.rows ?? 14, detail);
  const dx = width / (cols - 1), dy = height / (rows - 1);
  const corners = o.hang === 'corners';
  return {
    spec: {
      kind: 'cloth', cols, rows, spacing: [dx, dy],
      rest: (ix, iy, out) => out.set(ix * dx - width / 2, -iy * dy, 0),
      pinned: (ix, iy) => iy === 0 && (!corners || ix === 0 || ix === cols - 1),
      tether: (ix, iy) => iy === 0 ? null : { anchor: new THREE.Vector3(ix * dx - width / 2, 0, 0), length: iy * dy * 1.03 + (corners ? width * 0.06 : 0) },
      stiffness: 0.92, bend: 0.2, dragNormal: 5.5, dragTangent: 0.3, gravity: 0.8, damping: 0.4, flutter: 0.8,
      tearThreshold: o.tearThreshold ?? 0,
    },
    matrix: yawMatrix(o.origin, o.yaw ?? 0),
    look: { pattern: o.pattern ?? 'hazard', colors: o.colors ?? [0xf2b705, 0x16161a], translucency: 0.25 },
  };
}

export interface SailOptions {
  /** Centre of the yard (top edge), world space. */
  origin: THREE.Vector3;
  width?: number;
  height?: number;
  yaw?: number;
  cols?: number;
  rows?: number;
  /** Sheet length as a fraction of the sail height (< 1 hauls the clews in and flattens it). */
  sheet?: number;
  /** Pin the left edge to a mast as well (fore-and-aft rig). */
  mast?: boolean;
  colors?: THREE.ColorRepresentation[];
  follow?: THREE.Object3D;
  /** Optional stretch ratio above which the sail rips automatically (0 = off). */
  tearThreshold?: number;
}

export function sailSpec(o: SailOptions, detail = 1): Built {
  const width = o.width ?? 5, height = o.height ?? 6.5;
  const cols = grid(o.cols ?? 26, detail), rows = grid(o.rows ?? 30, detail);
  const dx = width / (cols - 1), dy = height / (rows - 1);
  const sheet = (o.sheet ?? 0.25) * height;
  return {
    spec: {
      kind: 'cloth', cols, rows, spacing: [dx, dy],
      rest: (ix, iy, out) => out.set(ix * dx - width / 2, -iy * dy, 0),
      pinned: (ix, iy) => iy === 0 || (o.mast === true && ix === 0),
      tether: (ix, iy) => {
        if (iy === 0) return null;
        // The clews are sheeted to points below the foot; everything else only has the anti-stretch limit.
        if (iy === rows - 1 && (ix === 0 || ix === cols - 1)) return { anchor: new THREE.Vector3((ix === 0 ? -1 : 1) * width * 0.5, -height - sheet * 0.15, 0), length: sheet };
        return { anchor: new THREE.Vector3(ix * dx - width / 2, 0, 0), length: iy * dy * 1.025 };
      },
      stiffness: 0.95, bend: 0.5, dragNormal: 9, dragTangent: 0.2, gravity: 0.7, damping: 0.6, flutter: 0.35,
      tearThreshold: o.tearThreshold ?? 0,
    },
    matrix: yawMatrix(o.origin, o.yaw ?? 0),
    look: { pattern: 'sailcloth', colors: o.colors ?? [0xe9e3d2, 0x9a2a1c], translucency: 0.5, roughness: 0.7 },
  };
}

export interface ParachuteOptions {
  /** The load hanging under the canopy; the canopy's lines converge on its origin. */
  follow?: THREE.Object3D;
  /** Payload position when no object is followed (move `piece.matrix` yourself). */
  origin?: THREE.Vector3;
  /** Canopy span in metres. */
  span?: number;
  /** Suspension line length in metres. */
  lines?: number;
  cells?: number;
  colors?: THREE.ColorRepresentation[];
  tearThreshold?: number;
}

export function parachuteSpec(o: ParachuteOptions, detail = 1): Built {
  const span = o.span ?? 6.5, lines = o.lines ?? 6;
  const n = grid(o.cells ?? 18, detail);
  const d = span / (n - 1);
  const rise = lines * 0.82;
  return {
    spec: {
      kind: 'cloth', cols: n, rows: n, spacing: [d, d],
      // Packed flat above the load; the airflow of the descent opens it into a dome.
      rest: (ix, iy, out) => out.set(ix * d - span / 2, rise, iy * d - span / 2),
      tether: (ix, iy) => {
        const rim = ix === 0 || iy === 0 || ix === n - 1 || iy === n - 1;
        // Rim lines are shorter than the flat radius allows, which gathers the skirt.
        return { anchor: new THREE.Vector3(0, 0, 0), length: rim ? lines : lines * 1.22 };
      },
      stiffness: 0.9, bend: 0.1, dragNormal: 9, dragTangent: 0.6, gravity: 0.3, damping: 0.9, flutter: 0.25, inflate: 5,
      tearThreshold: o.tearThreshold ?? 0,
    },
    matrix: new THREE.Matrix4().setPosition(o.origin ?? new THREE.Vector3()),
    look: { pattern: 'canopy', colors: o.colors ?? [0xe8641c, 0xf4efe2], translucency: 0.6, lines: 12 },
  };
}

export interface RopeOptions {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Rope length ÷ straight-line distance (1.03 = taut cable, 1.3 = slack mooring line). */
  slack?: number;
  segments?: number;
  /** Half thickness in metres. */
  radius?: number;
  /** Leave the far end free (a hanging rope). */
  freeEnd?: boolean;
  /** Mass-like tuning: heavy cables barely notice wind. */
  heavy?: boolean;
  follow?: THREE.Object3D;
  /** Optional stretch ratio above which the rope snaps under tension (0 = off). */
  tearThreshold?: number;
}

export function ropeSpec(o: RopeOptions, detail = 1): Built {
  const n = Math.max(3, grid(o.segments ?? 20, detail) + 1);
  const slack = o.slack ?? 1.04;
  const span = o.from.distanceTo(o.to);
  const segment = (span * slack) / (n - 1);
  // Parabola with the same arc length as the slack rope (first-order catenary).
  const sag = span * Math.sqrt(Math.max(0, (3 * (slack - 1)) / 8));
  const from = o.from.clone(), to = o.to.clone();
  return {
    spec: {
      kind: 'rope', cols: n, rows: 1, spacing: [segment, segment], radius: o.radius ?? 0.02,
      rest: (ix, _iy, out) => out.lerpVectors(from, to, ix / (n - 1)),
      start: (ix, _iy, out) => { const t = ix / (n - 1); out.lerpVectors(from, to, t); out.y -= sag * 4 * t * (1 - t); return out; },
      pinned: (ix) => ix === 0 || (ix === n - 1 && !o.freeEnd),
      stiffness: 0.95, bend: o.heavy ? 0.7 : 0.35, dragNormal: o.heavy ? 0.35 : 1.1, dragTangent: 0.02, gravity: 1, damping: o.heavy ? 0.7 : 0.45, flutter: o.heavy ? 0.3 : 0.6,
      tearThreshold: o.tearThreshold ?? 0,
    },
    matrix: new THREE.Matrix4(),
    look: {},
  };
}

export interface PowerLineOptions {
  /** Cross-arm centres at the top of each pole, in order along the line. */
  poles: THREE.Vector3[];
  /** Conductors per span. */
  wires?: number;
  /** Distance between adjacent conductors on the cross-arm (m). */
  spread?: number;
  slack?: number;
  segments?: number;
  radius?: number;
  tearThreshold?: number;
}

/** One rope spec per conductor per span. */
export function powerLineSpecs(o: PowerLineOptions, detail = 1): Built[] {
  const wires = o.wires ?? 3, spread = o.spread ?? 0.7;
  const built: Built[] = [];
  for (let i = 0; i + 1 < o.poles.length; i++) {
    const a = o.poles[i], b = o.poles[i + 1];
    const across = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x)).normalize();
    for (let w = 0; w < wires; w++) {
      const offset = across.clone().multiplyScalar((w - (wires - 1) / 2) * spread);
      built.push(ropeSpec({
        from: a.clone().add(offset),
        to: b.clone().add(offset),
        slack: o.slack ?? 1.018,
        segments: o.segments ?? 18,
        radius: o.radius ?? 0.014,
        heavy: true,
        tearThreshold: o.tearThreshold ?? 0,
      }, detail));
    }
  }
  return built;
}
