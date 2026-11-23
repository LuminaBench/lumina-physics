/**
 * Shared data layout and types for the inflatable spring / pressure soft-body solver.
 *
 * Every soft body is a closed manifold triangle mesh with structural surface springs,
 * internal cross-bracing struts, and ideal-gas internal pressure proportional to V₀ / V.
 * All bodies in a `SoftBodySystem` are packed into shared arrays so both the WebGPU
 * compute solver (`gpu.ts`) and CPU reference/WebGL 2 fallback (`cpu.ts`) execute the
 * same physics with a fixed number of passes.
 */
import * as THREE from 'three/webgpu';
import type { RigidBody } from '../../engine/physics';

export const MAX_SOFT_BODIES = 32;
export const MAX_VALENCE = 14;
export const MAX_VERTEX_TRIS = 8;
export const MAX_SB_SPHERES = 16;
export const MAX_SB_BOXES = 12;
export const MAX_SB_IMPACTS = 8;
export const WATER_DENSITY = 1025;

export interface WaterSurfaceLike {
  waterLevel?: number;
  heightAt(x: number, z: number): number;
  flowAt?(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  field?: {
    addSource(source: { x: number; z: number; radius: number; push?: number; impulse?: number; foam?: number }): void;
  };
}

export interface SoftBodyTuning {
  /** Spring constraint stiffness (0..1 fraction of error removed per iteration). */
  stiffness: number;
  /** Weight of internal cross-struts / bend springs (0..1). */
  strutWeight: number;
  /** Ideal-gas internal pressure coefficient (kPa-like scale, 0 = deflated, 1..4 = firm inflatable). */
  pressure: number;
  /** Gas volume ratio target (1 = rest volume, > 1 = over-inflated, < 1 = soft/under-inflated). */
  inflation: number;
  /** Total mass of the soft body in kg. */
  mass: number;
  /** Multiplier on gravity (default 1). */
  gravity: number;
  /** Velocity damping (1/s). */
  damping: number;
  /** Aerodynamic drag coefficient against the shared wind field (1/s). */
  airDrag: number;
  /** Surface bounce restitution (0..1). */
  restitution: number;
  /** Tangential contact friction (0..1). */
  friction: number;
  /** Water buoyancy multiplier (1 = physical Archimedes on displaced gas volume, 0 = none). */
  buoyancy: number;
  /** Hydrodynamic linear drag in water (1/s). */
  waterDrag: number;
  /** Punctured deflation rate (pressure units per second, 0 = sealed). */
  leakRate: number;
}

export const DEFAULT_SOFTBODY_TUNING: SoftBodyTuning = {
  stiffness: 0.88,
  strutWeight: 0.45,
  pressure: 1.8,
  inflation: 1.0,
  mass: 8,
  gravity: 1,
  damping: 0.45,
  airDrag: 0.6,
  restitution: 0.45,
  friction: 0.35,
  buoyancy: 1.0,
  waterDrag: 3.2,
  leakRate: 0,
};

export interface SoftBodyTopology {
  /** Local-space vertex positions (flat xyz, length = vertexCount * 3). */
  positions: Float32Array;
  /** Texture coordinates (flat uv, length = vertexCount * 2). */
  uvs: Float32Array;
  /** Closed manifold triangle indices (length = triCount * 3, CCW outward winding). */
  triangles: Uint32Array;
  /** Optional pinned vertex predicate. */
  pinned?: (vertexIndex: number, localPos: THREE.Vector3) => boolean;
  /** Precomputed rest signed volume (m³). */
  restVolume: number;
  /** Precomputed rest bounding radius (m). */
  restRadius: number;
  /** Precomputed surface area (m²). */
  restArea: number;
  /** Structural + internal strut springs: pairs of vertex indices + rest length + weight kind (0 = edge, 1 = strut). */
  springs: Array<{ a: number; b: number; rest: number; kind: 0 | 1 }>;
}

export interface SoftBodySpec extends Partial<SoftBodyTuning> {
  topology: SoftBodyTopology;
  /** Initial world position. */
  position?: THREE.Vector3;
  /** Initial world rotation. */
  quaternion?: THREE.Quaternion;
  /** Initial linear velocity (m/s). */
  velocity?: THREE.Vector3;
  /** Enable automatic Rapier rigid-body proxy coupling (default false; collisions with Rapier world are always active). */
  rapierProxy?: boolean;
}

export interface SoftBodySphereCollider {
  center: THREE.Vector3;
  radius: number;
  velocity?: THREE.Vector3;
  /** Optional Rapier body for two-way impulse transfer. */
  rapierBody?: RigidBody;
  /** Inverse mass of collider (0 = static/kinematic). */
  invMass?: number;
}

export interface SoftBodyBoxCollider {
  center: THREE.Vector3;
  halfExtents: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  margin?: number;
  rapierBody?: RigidBody;
  invMass?: number;
}

export interface SoftBodyImpactEvent {
  bodyId: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  speed: number;
  otherBody: RigidBody | null;
}

export interface SoftBodyRecord {
  id: number;
  spec: SoftBodySpec;
  tuning: SoftBodyTuning;
  vertexOffset: number;
  vertexCount: number;
  triOffset: number;
  triCount: number;
  restVolume: number;
  restRadius: number;
  restArea: number;
  enabled: boolean;
  activeThisFrame: boolean;
  /** Estimated / exact live world centroid. */
  center: THREE.Vector3;
  /** Estimated / exact live linear velocity (m/s). */
  velocity: THREE.Vector3;
  /** Estimated / exact live volume (m³). */
  volume: number;
  /** 0..1 fraction of vertices submerged in water. */
  submersion: number;
  /** Optional local water plane (nx, surfaceY, nz, valid) sampled per frame. */
  waterPlane: THREE.Vector4;
  /** Local water flow (vx, vy, vz, drag). */
  waterFlow: THREE.Vector4;
  /** Optional attached Rapier proxy rigid body. */
  proxyBody: RigidBody | null;
}

export interface SoftBodyContext {
  bodies: SoftBodyRecord[];
  spheres: SoftBodySphereCollider[];
  boxes: SoftBodyBoxCollider[];
  groundY: number;
  water: WaterSurfaceLike | null;
  waterLevel: number | null;
  substeps: number;
  iterations: number;
  onImpact?: (event: SoftBodyImpactEvent) => void;
  onSplash?: (bodyId: number, point: THREE.Vector3, speed: number) => void;
}

export interface SoftBodyBackend {
  readonly kind: 'gpu' | 'cpu';
  readonly vertexCount: number;
  step(dt: number, time: number): void;
  /** TSL node: world position of vertex `index`. */
  vertex(index: any): any;
  /** TSL node: previous frame world position of vertex `index`. */
  previous(index: any): any;
  /** TSL node: smooth world normal of vertex `index`. */
  normal(index: any): any;
  /** Read a vertex position on CPU (exact on CPU backend; proxy-offset estimate on GPU). */
  readVertex(index: number, out: THREE.Vector3): THREE.Vector3;
  /** Apply uniform velocity impulse (m/s) to a body. */
  kick(body: SoftBodyRecord, velocity: THREE.Vector3): void;
  /** Apply a localized impact impulse (m/s) within `radius` around `point`. */
  impulseAt(point: THREE.Vector3, velocity: THREE.Vector3, radius: number, body?: SoftBodyRecord | null): void;
  /** Reset a body back to a world transform. */
  resetBody(body: SoftBodyRecord, position: THREE.Vector3, quaternion?: THREE.Quaternion): void;
  dispose(): void;
}

export interface PackedSoftBodyLayout {
  vertexCount: number;
  triCount: number;
  /** vec4(x, y, z, invMass) */
  position: Float32Array;
  /** vec4(x, y, z, bodyId) */
  previous: Float32Array;
  /** vec4(lx, ly, lz, invVertexMass) */
  rest: Float32Array;
  /** vec4(nx, ny, nz, area) */
  normals: Float32Array;
  /** Per-vertex spring table: vertexCount * MAX_VALENCE vec4(neighborIdx, restLen, weightKind, active) */
  springs: Float32Array;
  /** Per-vertex incident triangles: vertexCount * MAX_VERTEX_TRIS vec4(nbA, nbB, active, 0) */
  vertexTris: Float32Array;
  /** Flat global triangle index buffer: triCount * 4 (a, b, c, bodyId) */
  triangles: Float32Array;
  /** Unique spring pairs for Gauss–Seidel CPU solver. */
  uniqueSprings: Array<{ bodyId: number; a: number; b: number; rest: number; kind: 0 | 1 }>;
}

/** Pack all soft bodies into shared flat buffers for both CPU and GPU solvers. */
export function layoutSoftBodies(bodies: SoftBodyRecord[]): PackedSoftBodyLayout {
  let vertexCount = 0;
  let triCount = 0;
  for (let b = 0; b < bodies.length; b++) {
    const rec = bodies[b];
    rec.id = b;
    rec.vertexOffset = vertexCount;
    rec.vertexCount = rec.spec.topology.positions.length / 3;
    rec.triOffset = triCount;
    rec.triCount = rec.spec.topology.triangles.length / 3;
    rec.restVolume = rec.spec.topology.restVolume;
    rec.restRadius = rec.spec.topology.restRadius;
    rec.restArea = rec.spec.topology.restArea;
    vertexCount += rec.vertexCount;
    triCount += rec.triCount;
  }

  const totalV = Math.max(vertexCount, 1);
  const totalT = Math.max(triCount, 1);
  const position = new Float32Array(totalV * 4);
  const previous = new Float32Array(totalV * 4);
  const rest = new Float32Array(totalV * 4);
  const normals = new Float32Array(totalV * 4);
  const springs = new Float32Array(totalV * MAX_VALENCE * 4);
  const vertexTris = new Float32Array(totalV * MAX_VERTEX_TRIS * 4);
  const triangles = new Float32Array(totalT * 4);
  const uniqueSprings: PackedSoftBodyLayout['uniqueSprings'] = [];

  const q = new THREE.Quaternion();
  const p0 = new THREE.Vector3();
  const local = new THREE.Vector3();
  const world = new THREE.Vector3();
  const vel = new THREE.Vector3();

  for (const rec of bodies) {
    const { topology } = rec.spec;
    p0.copy(rec.spec.position ?? new THREE.Vector3());
    q.copy(rec.spec.quaternion ?? new THREE.Quaternion());
    vel.copy(rec.spec.velocity ?? new THREE.Vector3());
    rec.center.copy(p0);
    rec.velocity.copy(vel);
    rec.volume = rec.restVolume;

    const perVertexMass = Math.max(0.01, rec.tuning.mass / Math.max(rec.vertexCount, 1));
    const invM = 1 / perVertexMass;
    const initH = 1 / 120;

    for (let v = 0; v < rec.vertexCount; v++) {
      const gi = rec.vertexOffset + v;
      local.set(topology.positions[v * 3], topology.positions[v * 3 + 1], topology.positions[v * 3 + 2]);
      const pinned = topology.pinned?.(v, local) ?? false;
      world.copy(local).applyQuaternion(q).add(p0);

      position[gi * 4] = world.x;
      position[gi * 4 + 1] = world.y;
      position[gi * 4 + 2] = world.z;
      position[gi * 4 + 3] = pinned ? 0 : invM;

      previous[gi * 4] = world.x - vel.x * initH;
      previous[gi * 4 + 1] = world.y - vel.y * initH;
      previous[gi * 4 + 2] = world.z - vel.z * initH;
      previous[gi * 4 + 3] = rec.id;

      rest[gi * 4] = local.x;
      rest[gi * 4 + 1] = local.y;
      rest[gi * 4 + 2] = local.z;
      rest[gi * 4 + 3] = pinned ? 0 : invM;

      normals[gi * 4 + 1] = 1;
    }

    // Per-vertex spring adjacency (capped at MAX_VALENCE).
    const springCounts = new Uint8Array(rec.vertexCount);
    const addAdj = (from: number, to: number, restLen: number, kind: 0 | 1) => {
      const c = springCounts[from];
      if (c >= MAX_VALENCE) return;
      springCounts[from] = c + 1;
      const slot = ((rec.vertexOffset + from) * MAX_VALENCE + c) * 4;
      springs[slot] = rec.vertexOffset + to;
      springs[slot + 1] = restLen;
      springs[slot + 2] = kind;
      springs[slot + 3] = 1;
    };

    for (const sp of topology.springs) {
      addAdj(sp.a, sp.b, sp.rest, sp.kind);
      addAdj(sp.b, sp.a, sp.rest, sp.kind);
      uniqueSprings.push({
        bodyId: rec.id,
        a: rec.vertexOffset + sp.a,
        b: rec.vertexOffset + sp.b,
        rest: sp.rest,
        kind: sp.kind,
      });
    }

    // Incident triangles per vertex + flat global triangle buffer.
    const triCounts = new Uint8Array(rec.vertexCount);
    const addVertTri = (v: number, nbA: number, nbB: number) => {
      const c = triCounts[v];
      if (c >= MAX_VERTEX_TRIS) return;
      triCounts[v] = c + 1;
      const slot = ((rec.vertexOffset + v) * MAX_VERTEX_TRIS + c) * 4;
      vertexTris[slot] = rec.vertexOffset + nbA;
      vertexTris[slot + 1] = rec.vertexOffset + nbB;
      vertexTris[slot + 2] = 1;
      vertexTris[slot + 3] = 0;
    };

    for (let t = 0; t < rec.triCount; t++) {
      const a = topology.triangles[t * 3];
      const b = topology.triangles[t * 3 + 1];
      const c = topology.triangles[t * 3 + 2];
      const gt = (rec.triOffset + t) * 4;
      triangles[gt] = rec.vertexOffset + a;
      triangles[gt + 1] = rec.vertexOffset + b;
      triangles[gt + 2] = rec.vertexOffset + c;
      triangles[gt + 3] = rec.id;

      addVertTri(a, b, c);
      addVertTri(b, c, a);
      addVertTri(c, a, b);
    }
  }

  return { vertexCount: totalV, triCount: totalT, position, previous, rest, normals, springs, vertexTris, triangles, uniqueSprings };
}
