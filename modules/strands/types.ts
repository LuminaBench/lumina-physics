/**
 * Shared data layout and types for the instanced Verlet strand solver (grass, kelp, hair).
 *
 * Every strand is a chain of `segments + 1` nodes (node 0 = anchored root). All fields in
 * a `StrandSystem` pack into one set of node & strand buffers so both the WebGPU compute
 * solver (`gpu.ts`, 1 thread per strand) and CPU fallback (`cpu.ts`) execute the exact same
 * inextensible Verlet physics and react to wind, blasts, rotor/jet downwash, and vehicles.
 */
import * as THREE from 'three/webgpu';

export const MAX_STRAND_FIELDS = 16;
export const MAX_DOWNWASH_SOURCES = 8;
export const MAX_STRAND_INTERACTORS = 16;
export const MAX_STRAND_BLASTS = 6;
export const MAX_STRAND_SEGMENTS = 12;

export type StrandKind = 'grass' | 'kelp' | 'hair';

export interface StrandTuning {
  /** Rest-pose spring recovery stiffness (1/s²-like scale). */
  stiffness: number;
  /** Velocity damping (1/s). */
  damping: number;
  /** Gravity multiplier (positive = down for grass/hair; negative = buoyant up for kelp). */
  gravity: number;
  /** Sensitivity to wind / underwater current (0..3). */
  windResponse: number;
  /** High-frequency flutter turbulence amplitude. */
  flutter: number;
  /** Drag coefficient in surrounding medium (air or water). */
  drag: number;
  /** Sensitivity to rotor/jet downwash (default 1). */
  downwashResponse: number;
  /** Sensitivity to vehicle / collider interactors (default 1). */
  vehicleResponse: number;
  /** Distance constraint sweep iterations per substep (default 3). */
  constraintIterations: number;
}

export const DEFAULT_STRAND_TUNING: Record<StrandKind, StrandTuning> = {
  grass: {
    stiffness: 26,
    damping: 3.4,
    gravity: 0.35,
    windResponse: 1.15,
    flutter: 0.85,
    drag: 2.2,
    downwashResponse: 1.25,
    vehicleResponse: 1.0,
    constraintIterations: 3,
  },
  kelp: {
    stiffness: 6.5,
    damping: 4.8,
    gravity: -0.75,
    windResponse: 0.7,
    flutter: 0.45,
    drag: 4.5,
    downwashResponse: 0.65,
    vehicleResponse: 1.0,
    constraintIterations: 3,
  },
  hair: {
    stiffness: 18,
    damping: 4.2,
    gravity: 1.0,
    windResponse: 1.05,
    flutter: 0.5,
    drag: 2.8,
    downwashResponse: 1.2,
    vehicleResponse: 1.0,
    constraintIterations: 4,
  },
};

export interface KajiyaKayLook {
  /** Root color (darker/anchored end). */
  rootColor: THREE.ColorRepresentation;
  /** Tip color (sun-bleached grass tip, golden kelp edge, hair highlight). */
  tipColor: THREE.ColorRepresentation;
  /** Secondary tint variation color blended per strand. */
  variationColor?: THREE.ColorRepresentation;
  /** Primary Kajiya-Kay anisotropic highlight color (default warm sun-white). */
  specularColor?: THREE.ColorRepresentation;
  /** Primary specular tangent shift along normal (-0.5..0.5). */
  primaryShift?: number;
  /** Secondary specular tangent shift along normal (-0.5..0.5). */
  secondaryShift?: number;
  /** Primary specular exponent (shininess, e.g. 64–180 for hair, 28–64 for grass/kelp). */
  primaryExponent?: number;
  /** Secondary specular exponent (broader tinted sheen, e.g. 16–48). */
  secondaryExponent?: number;
  /** Primary specular intensity. */
  primaryIntensity?: number;
  /** Secondary specular intensity. */
  secondaryIntensity?: number;
  /** Back-lit subsurface translucency (0..1.5). */
  translucency?: number;
  /** Ambient occlusion at root (0..1, 0.25 = deep shadow at base). */
  rootAO?: number;
  /** 0 = ribbon twisted freely, 1 = fully camera-facing billboard. */
  billboard?: number;
}

export interface StrandFieldSpec extends Partial<StrandTuning> {
  kind: StrandKind;
  /** Number of strands in this field. */
  strandCount: number;
  /** Segments per strand (nodesPerStrand = segments + 1, clamped 2..MAX_STRAND_SEGMENTS). */
  segments: number;
  /** Local root positions + length: `strandCount * 4` (`x, y, z, length`). */
  roots: Float32Array;
  /** Local rest unit direction + base ribbon half-width: `strandCount * 4` (`dx, dy, dz, halfWidth`). */
  dirs: Float32Array;
  /** Per-strand variation: `strandCount * 4` (`seed, stiffnessScale, arch, colorTint`). */
  meta: Float32Array;
  /** World transform (updated automatically if `follow` is set). */
  matrix?: THREE.Matrix4;
  /** Optional moving object to anchor the field (e.g., character head for hair, hull for kelp). */
  follow?: THREE.Object3D | null;
  /** Kajiya-Kay visual appearance. */
  look: KajiyaKayLook;
}

export interface DownwashSource {
  /** World position of the downwash origin (rotor hub, jet belly, or ground impact center). */
  position: THREE.Vector3;
  /** Downwash jet axis (unit vector, default (0, -1, 0)). */
  direction?: THREE.Vector3;
  /** Effective horizontal footprint radius in metres. */
  radius: number;
  /** Downwash wind speed / pressure strength (m/s equivalent, e.g. 15–55). */
  strength: number;
  /** Tangential vortex swirl ratio (0..1, default 0.35). */
  swirl?: number;
}

export interface StrandInteractor {
  /** World center of the collider or vehicle chassis. */
  position: THREE.Vector3;
  /** World linear velocity (m/s) — imparts wake push to strands. */
  velocity?: THREE.Vector3;
  /** Bounding sphere radius (used when `halfExtents` is omitted, or as broadphase). */
  radius: number;
  /** Optional oriented box half-extents (for vehicle hulls / chassis). */
  halfExtents?: THREE.Vector3;
  /** Optional world rotation for oriented box interactors. */
  quaternion?: THREE.Quaternion;
  /** Pushout & wake strength multiplier (default 1). */
  strength?: number;
}

export interface StrandBlast {
  position: THREE.Vector3;
  radius: number;
  strength: number;
  age: number;
  duration: number;
}

export interface StrandFieldRecord {
  id: number;
  spec: StrandFieldSpec;
  tuning: StrandTuning;
  strandOffset: number;
  strandCount: number;
  nodeOffset: number;
  nodesPerStrand: number;
  nodeCount: number;
  matrix: THREE.Matrix4;
  boundsCenter: THREE.Vector3;
  boundsRadius: number;
  enabled: boolean;
  activeThisFrame: boolean;
  lodStride: number;
}

export interface StrandContext {
  fields: StrandFieldRecord[];
  downwash: DownwashSource[];
  interactors: StrandInteractor[];
  blasts: StrandBlast[];
  /** Global underwater current vector (m/s) for kelp fields. */
  waterCurrent: THREE.Vector3;
  /** Water surface level (m) for kelp buoyancy clamp. */
  waterLevel: number;
  groundY: number;
  substeps: number;
}

export interface StrandBackend {
  readonly kind: 'gpu' | 'cpu';
  readonly strandCount: number;
  readonly nodeCount: number;
  step(dt: number, time: number): void;
  /** TSL node: current world position of node `index`. */
  node(index: any): any;
  /** TSL node: previous frame world position of node `index`. */
  previousNode(index: any): any;
  /** TSL node: strand metadata `vec4(seed, stiffnessScale, arch, colorTint)` for `strandIndex`. */
  strandMeta(strandIndex: any): any;
  /** TSL node: strand direction & half-width `vec4(dx, dy, dz, halfWidth)` for `strandIndex`. */
  strandDir(strandIndex: any): any;
  /** CPU read of a single node (exact on CPU backend; rest pose estimate on GPU). */
  readNode(nodeIndex: number, out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

export interface PackedStrandLayout {
  strandCount: number;
  nodeCount: number;
  /** nodeCount * 4: xyz world pos, w = segment length */
  position: Float32Array;
  /** nodeCount * 4: xyz prev pos, w = strand global index */
  previous: Float32Array;
  /** strandCount * 4: local root xyz, w = field id */
  roots: Float32Array;
  /** strandCount * 4: local rest dir xyz, w = halfWidth */
  dirs: Float32Array;
  /** strandCount * 4: seed, stiffnessScale, arch, colorTint */
  meta: Float32Array;
  /** strandCount * 4: nodeOffset, nodesPerStrand, segLength, fieldId */
  strandSpan: Float32Array;
}

/** Pack all strand fields into contiguous flat buffers for both CPU and GPU solvers. */
export function layoutStrandFields(fields: StrandFieldRecord[]): PackedStrandLayout {
  let strandCount = 0;
  let nodeCount = 0;
  for (let f = 0; f < fields.length; f++) {
    const rec = fields[f];
    rec.id = f;
    rec.strandOffset = strandCount;
    rec.strandCount = rec.spec.strandCount;
    rec.nodesPerStrand = Math.max(3, Math.min(MAX_STRAND_SEGMENTS + 1, rec.spec.segments + 1));
    rec.nodeOffset = nodeCount;
    rec.nodeCount = rec.strandCount * rec.nodesPerStrand;
    strandCount += rec.strandCount;
    nodeCount += rec.nodeCount;
  }

  const totalS = Math.max(strandCount, 1);
  const totalN = Math.max(nodeCount, 1);
  const position = new Float32Array(totalN * 4);
  const previous = new Float32Array(totalN * 4);
  const roots = new Float32Array(totalS * 4);
  const dirs = new Float32Array(totalS * 4);
  const meta = new Float32Array(totalS * 4);
  const strandSpan = new Float32Array(totalS * 4);

  const p0 = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  const rot = new THREE.Matrix3();

  for (const rec of fields) {
    const { spec } = rec;
    const nps = rec.nodesPerStrand;
    const segs = nps - 1;
    rot.setFromMatrix4(rec.matrix);
    min.set(Infinity, Infinity, Infinity);
    max.set(-Infinity, -Infinity, -Infinity);

    for (let s = 0; s < rec.strandCount; s++) {
      const gs = rec.strandOffset + s;
      const rx = spec.roots[s * 4], ry = spec.roots[s * 4 + 1], rz = spec.roots[s * 4 + 2];
      const len = Math.max(0.04, spec.roots[s * 4 + 3]);
      const segLen = len / segs;

      const dx = spec.dirs[s * 4], dy = spec.dirs[s * 4 + 1], dz = spec.dirs[s * 4 + 2];
      const halfWidth = Math.max(0.002, spec.dirs[s * 4 + 3]);

      roots[gs * 4] = rx; roots[gs * 4 + 1] = ry; roots[gs * 4 + 2] = rz; roots[gs * 4 + 3] = rec.id;
      dirs[gs * 4] = dx; dirs[gs * 4 + 1] = dy; dirs[gs * 4 + 2] = dz; dirs[gs * 4 + 3] = halfWidth;

      const seed = spec.meta[s * 4];
      const stiff = spec.meta[s * 4 + 1] || 1;
      const arch = spec.meta[s * 4 + 2];
      const tint = spec.meta[s * 4 + 3];
      meta[gs * 4] = seed; meta[gs * 4 + 1] = stiff; meta[gs * 4 + 2] = arch; meta[gs * 4 + 3] = tint;

      const nBase = rec.nodeOffset + s * nps;
      strandSpan[gs * 4] = nBase;
      strandSpan[gs * 4 + 1] = nps;
      strandSpan[gs * 4 + 2] = segLen;
      strandSpan[gs * 4 + 3] = rec.id;

      p0.set(rx, ry, rz);
      min.min(p0); max.max(p0);
      p0.applyMatrix4(rec.matrix);
      dir.set(dx, dy, dz).applyMatrix3(rot).normalize();

      for (let k = 0; k < nps; k++) {
        const gn = nBase + k;
        const t = k / segs;
        p.copy(p0).addScaledVector(dir, t * len);
        // Gentle initial arch droop along the strand's natural lean.
        p.y -= arch * t * t * len * 0.25;
        position[gn * 4] = previous[gn * 4] = p.x;
        position[gn * 4 + 1] = previous[gn * 4 + 1] = p.y;
        position[gn * 4 + 2] = previous[gn * 4 + 2] = p.z;
        position[gn * 4 + 3] = segLen;
        previous[gn * 4 + 3] = gs;
      }
    }

    if (rec.strandCount > 0) {
      rec.boundsCenter.addVectors(min, max).multiplyScalar(0.5);
      rec.boundsRadius = Math.max(2, min.distanceTo(max) * 0.5 + 3);
    } else {
      rec.boundsCenter.set(0, 0, 0);
      rec.boundsRadius = 1;
    }
  }

  return { strandCount: totalS, nodeCount: totalN, position, previous, roots, dirs, meta, strandSpan };
}
