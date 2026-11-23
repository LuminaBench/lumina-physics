/**
 * Shared data layout of the cloth / rope solver.
 *
 * Every piece (a flag, a sail, a rope …) is a `cols × rows` grid of particles; a rope is a
 * grid with one row. All pieces live in one set of arrays so the whole scene is solved by a
 * fixed number of passes, independent of how many pieces there are:
 *
 *   position  xyz world position, w = inverse mass (0 = pinned)
 *   previous  xyz position one substep ago (Verlet), w unused
 *   rest      xyz position in the piece's local frame (where a pinned particle sits), w = piece id
 *   tether    xyz anchor in the piece's local frame, w = maximum distance (< 0 = none)
 *   links     vec4(right, down, diagDR, diagDL) intact flags (1 = intact, 0 = torn/snapped)
 *
 * Neighbours are implicit in the grid (structural ±1, shear diagonals, bend ±2), so there
 * are no index buffers to upload and the GPU and CPU solvers run the same arithmetic.
 */
import * as THREE from 'three/webgpu';

export const MAX_PIECES = 32;
export const MAX_COLLIDERS = 16;
export const MAX_BOX_COLLIDERS = 8;

export interface PieceTuning {
  /** 0..1 fraction of a length error removed per solver iteration. */
  stiffness: number;
  /** 0..1 weight of the two-apart bending constraints (0 = silk, 1 = canvas / stiff cable). */
  bend: number;
  /** Pressure drag coefficient (1/s): how hard air pushes along the surface normal. */
  dragNormal: number;
  /** Skin drag coefficient (1/s) along the surface. */
  dragTangent: number;
  /** Multiplier on gravity. */
  gravity: number;
  /** Velocity damping (1/s). */
  damping: number;
  /** 0..1 strength of the travelling-wave turbulence that makes steady wind flutter. */
  flutter: number;
  /**
   * Ram-air inflation (1/s): air rising past the piece acts as internal pressure along the
   * surface normal, on the side facing away from the piece origin, so a canopy unfurls into a
   * cap on its lines instead of streaming. 0 = off.
   */
  inflate: number;
  /**
   * Stretch ratio above which structural links tear / ropes snap (e.g. 1.8 = tears at 180%
   * rest length). 0 disables automatic strain tearing (manual `tear`/`cut`/`snap` still work).
   */
  tearThreshold: number;
}

export interface PieceSpec extends Partial<PieceTuning> {
  cols: number;
  rows: number;
  /** Local rest position of grid point (ix, iy). */
  rest(ix: number, iy: number, out: THREE.Vector3): THREE.Vector3;
  /** Local start position (defaults to `rest`): e.g. a rope starts sagging, not taut. */
  start?(ix: number, iy: number, out: THREE.Vector3): THREE.Vector3;
  /** Pinned grid points follow the piece transform rigidly. */
  pinned?(ix: number, iy: number): boolean;
  /** Maximum-distance tether to a local anchor (parachute lines, sheet ropes). */
  tether?(ix: number, iy: number): { anchor: THREE.Vector3; length: number } | null;
  /** Rest spacing along the column / row direction in metres. */
  spacing: [number, number];
  /** 'rope' pieces render as camera-facing ribbons; `radius` is the half width in metres. */
  kind: 'cloth' | 'rope';
  radius?: number;
}

export const DEFAULT_TUNING: PieceTuning = {
  stiffness: 0.9,
  bend: 0.25,
  dragNormal: 5,
  dragTangent: 0.25,
  gravity: 1,
  damping: 0.35,
  flutter: 1,
  inflate: 0,
  tearThreshold: 0,
};

export type ClothLodLevel = 0 | 1 | 2 | 3;

export interface ClothLodOptions {
  /** Enable frustum + distance simulation LOD (default true). */
  enabled: boolean;
  /** Distance (m) within which in-frustum pieces simulate every frame. */
  fullDistance: number;
  /** Distance (m) within which in-frustum pieces simulate at reduced stride. */
  reducedDistance: number;
  /** Distance (m) beyond which pieces sleep until the camera approaches. */
  sleepDistance: number;
  /** Frame stride in the reduced distance band (default 2 = half-rate). */
  reducedStride: number;
  /** Frame stride when outside camera frustum within sleepDistance (default 3; 0 = sleep). */
  offscreenStride: number;
  /** Extra bounding sphere padding (m) for frustum tests so fluttering cloth never pops. */
  frustumMargin: number;
}

export const DEFAULT_CLOTH_LOD: ClothLodOptions = {
  enabled: true,
  fullDistance: 45,
  reducedDistance: 120,
  sleepDistance: 260,
  reducedStride: 2,
  offscreenStride: 3,
  frustumMargin: 2.5,
};

export interface PieceRecord {
  spec: PieceSpec;
  tuning: PieceTuning;
  offset: number;
  count: number;
  /** World transform of the piece's local frame (pins and tether anchors follow it). */
  matrix: THREE.Matrix4;
  enabled: boolean;
  /** Local-space bounding sphere center & radius for frustum/distance LOD. */
  boundsCenter: THREE.Vector3;
  boundsRadius: number;
  /** Current simulation LOD: 0 = full, 1 = reduced, 2 = offscreen, 3 = sleeping. */
  lodLevel: ClothLodLevel;
  /** Whether the solver advances this piece on the current frame. */
  activeThisFrame: boolean;
  /** Number of severed structural links tracked on this piece. */
  tornCount: number;
  /** True once a rope has snapped or a cloth has torn. */
  snapped: boolean;
}

export interface Collider { center: THREE.Vector3; radius: number }

export interface BoxCollider {
  center: THREE.Vector3;
  halfExtents: THREE.Vector3;
  /** Optional world orientation (identity = axis-aligned box). */
  quaternion?: THREE.Quaternion;
  /** Pushout margin in metres (default 0.02). */
  margin?: number;
}

export interface SolverContext {
  pieces: PieceRecord[];
  colliders: Collider[];
  boxColliders: BoxCollider[];
  /** Particles never sink below this height. */
  groundY: number;
  substeps: number;
  iterations: number;
}

export interface ClothBackend {
  readonly kind: 'gpu' | 'cpu';
  /** Advance by `dt` seconds. */
  step(dt: number, time: number): void;
  /** TSL node: world position of particle `index` (int node). */
  particle(index: any): any;
  /** TSL node: world position of particle `index` one frame ago. */
  previous(index: any): any;
  /** TSL node: vec4(right, down, diagDR, diagDL) intact flags (1 = intact, 0 = torn). */
  link(index: any): any;
  /** CPU read of one particle (CPU backend: exact; GPU backend: the pinned / initial pose). */
  read(index: number, out: THREE.Vector3): THREE.Vector3;
  /** Give every free particle of a piece an impulse (m/s). */
  kick(piece: PieceRecord, velocity: THREE.Vector3): void;
  /** Tear links intersecting a world-space sphere. Pass `null` to affect all pieces. */
  tearSphere(piece: PieceRecord | null, center: THREE.Vector3, radius: number): number;
  /** Cut links intersecting a world-space line segment. Pass `null` to affect all pieces. */
  cutSegment(piece: PieceRecord | null, from: THREE.Vector3, to: THREE.Vector3, thickness: number): number;
  /** Tear links around grid coordinate `(ix, iy)` on a specific piece. */
  tearGrid(piece: PieceRecord, ix: number, iy: number, radiusCells: number): number;
  /** Snap a rope at `index` (or tear a cloth vertically across column `index`). */
  snapPiece(piece: PieceRecord, index?: number): boolean;
  /** Restore all links and original tethers for a piece. */
  healPiece(piece: PieceRecord): void;
  /** Number of torn structural links on a piece. */
  tornCount(piece: PieceRecord): number;
  dispose(): void;
}

/** Fill the shared arrays for a set of pieces. */
export function layoutPieces(pieces: PieceRecord[]): {
  count: number;
  position: Float32Array;
  previous: Float32Array;
  rest: Float32Array;
  tether: Float32Array;
  links: Float32Array;
} {
  let count = 0;
  for (const p of pieces) { p.offset = count; p.count = p.spec.cols * p.spec.rows; count += p.count; }
  const total = Math.max(count, 1);
  const position = new Float32Array(total * 4);
  const previous = new Float32Array(total * 4);
  const rest = new Float32Array(total * 4);
  const tether = new Float32Array(total * 4);
  const links = new Float32Array(total * 4);
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  const min = new THREE.Vector3(), max = new THREE.Vector3();

  pieces.forEach((piece, id) => {
    const { spec } = piece;
    min.set(Infinity, Infinity, Infinity);
    max.set(-Infinity, -Infinity, -Infinity);
    for (let iy = 0; iy < spec.rows; iy++) for (let ix = 0; ix < spec.cols; ix++) {
      const i = (piece.offset + iy * spec.cols + ix) * 4;
      spec.rest(ix, iy, v);
      min.min(v); max.max(v);
      rest[i] = v.x; rest[i + 1] = v.y; rest[i + 2] = v.z; rest[i + 3] = id;
      const pinned = spec.pinned?.(ix, iy) ?? false;
      (pinned ? w.copy(v) : (spec.start ?? spec.rest)(ix, iy, w)).applyMatrix4(piece.matrix);
      position[i] = previous[i] = w.x; position[i + 1] = previous[i + 1] = w.y; position[i + 2] = previous[i + 2] = w.z;
      position[i + 3] = pinned ? 0 : 1;
      const t = spec.tether?.(ix, iy) ?? null;
      if (t) { tether[i] = t.anchor.x; tether[i + 1] = t.anchor.y; tether[i + 2] = t.anchor.z; tether[i + 3] = t.length; } else tether[i + 3] = -1;
      // Links: x = +X structural, y = +Y structural, z = (+1,+1) shear, w = (-1,+1) shear.
      links[i] = ix + 1 < spec.cols ? 1 : 0;
      links[i + 1] = iy + 1 < spec.rows ? 1 : 0;
      links[i + 2] = (ix + 1 < spec.cols && iy + 1 < spec.rows) ? 1 : 0;
      links[i + 3] = (ix > 0 && iy + 1 < spec.rows) ? 1 : 0;
    }
    piece.boundsCenter.addVectors(min, max).multiplyScalar(0.5);
    const span = min.distanceTo(max) * 0.5;
    // Account for cloth swinging freely around its pins / tether radius.
    piece.boundsRadius = Math.max(span * 1.4, spec.spacing[0] * spec.cols, spec.spacing[1] * spec.rows, 1);
    piece.tornCount = 0;
    piece.snapped = false;
  });
  return { count: total, position, previous, rest, tether, links };
}

/** Neighbour stencil shared by both solvers: [dx, dy, kind] with kind 0 structural, 1 shear, 2 bend. */
export const STENCIL: Array<[number, number, 0 | 1 | 2]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [2, 0, 2], [-2, 0, 2], [0, 2, 2], [0, -2, 2],
];
