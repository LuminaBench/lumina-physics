/**
 * CPU cloth / rope solver (position-based Verlet, Gauss–Seidel).
 *
 * The reference implementation of the model, and the solver used on the WebGL 2 backend
 * (which has no compute stage that can read neighbouring particles). Positions, previous
 * positions and per-particle link masks are published through a small float texture so the
 * render shaders are identical to the GPU path.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type { WindField } from '../../engine/wind';
import { layoutPieces, MAX_BOX_COLLIDERS, MAX_COLLIDERS, type BoxCollider, type ClothBackend, type PieceRecord, type SolverContext } from './types';

const { textureLoad, ivec2, int } = TSL;

const _wind = new THREE.Vector3();
const _base = new THREE.Vector3();
const _p = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _mid = new THREE.Vector3();
const TEX_WIDTH = 256;

/** Closest distance squared from point `p` to line segment `(a, b)`. */
function pointSegmentDistSq(px: number, py: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (abLenSq > 1e-10) {
    t = ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / abLenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (a.x + abx * t), dy = py - (a.y + aby * t), dz = pz - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

/** Push a world-space point out of an oriented or axis-aligned box collider. */
function pushOutBox(P: Float32Array, i: number, box: BoxCollider): void {
  const margin = box.margin ?? 0.02;
  const hx = box.halfExtents.x + margin, hy = box.halfExtents.y + margin, hz = box.halfExtents.z + margin;
  _local.set(P[i] - box.center.x, P[i + 1] - box.center.y, P[i + 2] - box.center.z);
  const q = box.quaternion;
  if (q) { _qInv.copy(q).invert(); _local.applyQuaternion(_qInv); }
  const ax = Math.abs(_local.x), ay = Math.abs(_local.y), az = Math.abs(_local.z);
  if (ax >= hx || ay >= hy || az >= hz) return;
  const penX = hx - ax, penY = hy - ay, penZ = hz - az;
  if (penX <= penY && penX <= penZ) _local.x = _local.x >= 0 ? hx : -hx;
  else if (penY <= penZ) _local.y = _local.y >= 0 ? hy : -hy;
  else _local.z = _local.z >= 0 ? hz : -hz;
  if (q) _local.applyQuaternion(q);
  P[i] = box.center.x + _local.x;
  P[i + 1] = box.center.y + _local.y;
  P[i + 2] = box.center.z + _local.z;
}

function solveLink(P: Float32Array, i: number, j: number, restLength: number, weight: number): number {
  const wi = P[i + 3], wj = P[j + 3];
  const wsum = wi + wj;
  if (wsum === 0) return restLength;
  const dx = P[j] - P[i], dy = P[j + 1] - P[i + 1], dz = P[j + 2] - P[i + 2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-9) return len;
  const k = ((len - restLength) / len) * weight / wsum;
  P[i] += dx * k * wi; P[i + 1] += dy * k * wi; P[i + 2] += dz * k * wi;
  P[j] -= dx * k * wj; P[j + 1] -= dy * k * wj; P[j + 2] -= dz * k * wj;
  return len;
}

export class CpuClothSolver implements ClothBackend {
  readonly kind = 'cpu' as const;
  /** xyz + inverse mass per particle (live simulation state). */
  readonly pos: Float32Array;
  private prev: Float32Array;
  private rest: Float32Array;
  private tether: Float32Array;
  private initialTether: Float32Array;
  private tetherWorld: Float32Array;
  /** vec4(right, down, diagDR, diagDL) intact flags (1 = intact, 0 = torn). */
  readonly links: Float32Array;
  private initialLinks: Float32Array;
  private frameStart: Float32Array;
  private texture: THREE.DataTexture;
  private data: Float32Array;
  private rows: number;
  readonly count: number;
  private visited: Uint8Array;
  private queue: Int32Array;
  private boxBounds = new Float64Array(MAX_BOX_COLLIDERS * 6);
  private boxRotation = new THREE.Matrix4();

  constructor(private context: SolverContext, private wind: WindField) {
    const layout = layoutPieces(context.pieces);
    this.count = layout.count;
    this.pos = layout.position;
    this.prev = layout.previous;
    this.rest = layout.rest;
    this.tether = layout.tether;
    this.initialTether = new Float32Array(layout.tether);
    this.tetherWorld = new Float32Array(layout.tether.length);
    this.links = layout.links;
    this.initialLinks = new Float32Array(layout.links);
    this.frameStart = new Float32Array(layout.position);
    this.visited = new Uint8Array(this.count);
    this.queue = new Int32Array(this.count);
    // Band 0 [0, rows): current pos; Band 1 [rows, 2*rows): prev frame pos; Band 2 [2*rows, 3*rows): links.
    this.rows = Math.ceil(this.count / TEX_WIDTH);
    this.data = new Float32Array(TEX_WIDTH * this.rows * 3 * 4);
    this.texture = new THREE.DataTexture(this.data, TEX_WIDTH, this.rows * 3, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.upload();
  }

  private upload(): void {
    const band = TEX_WIDTH * this.rows * 4;
    this.data.set(this.pos, 0);
    this.data.set(this.frameStart, band);
    this.data.set(this.links, band * 2);
    this.texture.needsUpdate = true;
  }

  particle(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH))).xyz;
  }

  previous(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.rows))).xyz;
  }

  link(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.rows * 2)));
  }

  read(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos[index * 4], this.pos[index * 4 + 1], this.pos[index * 4 + 2]);
  }

  kick(piece: PieceRecord, velocity: THREE.Vector3): void {
    const h = 1 / 60 / this.context.substeps;
    for (let i = piece.offset; i < piece.offset + piece.count; i++) {
      if (this.pos[i * 4 + 3] === 0) continue;
      this.prev[i * 4] -= velocity.x * h; this.prev[i * 4 + 1] -= velocity.y * h; this.prev[i * 4 + 2] -= velocity.z * h;
    }
  }

  /**
   * Release long-range tethers on any particles no longer connected to a pinned node, so
   * torn-off cloth scraps fly away cleanly instead of hanging in mid-air.
   */
  private updateDisconnectedTethers(piece: PieceRecord): void {
    const { cols, rows } = piece.spec;
    const base = piece.offset;
    const P = this.pos, L = this.links, T = this.tether;
    let hasPinned = false;
    let head = 0, tail = 0;
    for (let n = 0; n < piece.count; n++) {
      const idx = base + n;
      this.visited[idx] = 0;
      if (P[idx * 4 + 3] === 0) {
        hasPinned = true;
        this.visited[idx] = 1;
        this.queue[tail++] = n;
      }
    }
    if (!hasPinned) return;
    while (head < tail) {
      const cur = this.queue[head++];
      const ix = cur % cols, iy = (cur / cols) | 0;
      const idx = base + cur;
      // +X
      if (ix + 1 < cols && L[idx * 4] > 0.5 && !this.visited[idx + 1]) {
        this.visited[idx + 1] = 1; this.queue[tail++] = cur + 1;
      }
      // -X
      if (ix > 0 && L[(idx - 1) * 4] > 0.5 && !this.visited[idx - 1]) {
        this.visited[idx - 1] = 1; this.queue[tail++] = cur - 1;
      }
      // +Y
      if (iy + 1 < rows && L[idx * 4 + 1] > 0.5 && !this.visited[idx + cols]) {
        this.visited[idx + cols] = 1; this.queue[tail++] = cur + cols;
      }
      // -Y
      if (iy > 0 && L[(idx - cols) * 4 + 1] > 0.5 && !this.visited[idx - cols]) {
        this.visited[idx - cols] = 1; this.queue[tail++] = cur - cols;
      }
    }
    for (let n = 0; n < piece.count; n++) {
      const idx = base + n;
      if (!this.visited[idx]) T[idx * 4 + 3] = -1;
    }
  }

  /** Sever structural edge +X from `(ix, iy)` and adjacent shear links spanning it. */
  private severRight(piece: PieceRecord, ix: number, iy: number): boolean {
    const { cols, rows } = piece.spec;
    if (ix < 0 || ix + 1 >= cols || iy < 0 || iy >= rows) return false;
    const i = (piece.offset + iy * cols + ix) * 4;
    if (this.links[i] < 0.5) return false;
    this.links[i] = 0;
    if (iy + 1 < rows) {
      this.links[i + 2] = 0; // (ix, iy) -> (ix+1, iy+1)
      this.links[i + 4 + 3] = 0; // (ix+1, iy) -> (ix, iy+1)
    }
    if (iy > 0) {
      const up = i - cols * 4;
      this.links[up + 2] = 0;
      this.links[up + 4 + 3] = 0;
    }
    piece.tornCount++;
    piece.snapped = true;
    return true;
  }

  /** Sever structural edge +Y from `(ix, iy)` and adjacent shear links spanning it. */
  private severDown(piece: PieceRecord, ix: number, iy: number): boolean {
    const { cols, rows } = piece.spec;
    if (ix < 0 || ix >= cols || iy < 0 || iy + 1 >= rows) return false;
    const i = (piece.offset + iy * cols + ix) * 4;
    if (this.links[i + 1] < 0.5) return false;
    this.links[i + 1] = 0;
    if (ix + 1 < cols) {
      this.links[i + 2] = 0;
      this.links[i + 4 + 3] = 0;
    }
    if (ix > 0) {
      this.links[i - 4 + 2] = 0;
      this.links[i + 3] = 0;
    }
    piece.tornCount++;
    piece.snapped = true;
    return true;
  }

  tearSphere(target: PieceRecord | null, center: THREE.Vector3, radius: number): number {
    const r2 = radius * radius;
    const P = this.pos;
    let total = 0;
    const list = target ? [target] : this.context.pieces;
    for (const piece of list) {
      const { cols, rows } = piece.spec;
      const base = piece.offset;
      let broken = 0;
      for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
        const i = (base + iy * cols + ix) * 4;
        if (ix + 1 < cols && this.links[i] > 0.5) {
          const j = i + 4;
          const mx = (P[i] + P[j]) * 0.5 - center.x, my = (P[i + 1] + P[j + 1]) * 0.5 - center.y, mz = (P[i + 2] + P[j + 2]) * 0.5 - center.z;
          if (mx * mx + my * my + mz * mz <= r2 && this.severRight(piece, ix, iy)) broken++;
        }
        if (iy + 1 < rows && this.links[i + 1] > 0.5) {
          const j = i + cols * 4;
          const mx = (P[i] + P[j]) * 0.5 - center.x, my = (P[i + 1] + P[j + 1]) * 0.5 - center.y, mz = (P[i + 2] + P[j + 2]) * 0.5 - center.z;
          if (mx * mx + my * my + mz * mz <= r2 && this.severDown(piece, ix, iy)) broken++;
        }
      }
      if (broken > 0) {
        this.updateDisconnectedTethers(piece);
        total += broken;
      }
    }
    if (total > 0) this.upload();
    return total;
  }

  cutSegment(target: PieceRecord | null, from: THREE.Vector3, to: THREE.Vector3, thickness: number): number {
    const r2 = Math.max(thickness, 0.05) ** 2;
    const P = this.pos;
    let total = 0;
    const list = target ? [target] : this.context.pieces;
    for (const piece of list) {
      const { cols, rows } = piece.spec;
      const base = piece.offset;
      let broken = 0;
      for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
        const i = (base + iy * cols + ix) * 4;
        if (ix + 1 < cols && this.links[i] > 0.5) {
          const j = i + 4;
          const d2 = pointSegmentDistSq((P[i] + P[j]) * 0.5, (P[i + 1] + P[j + 1]) * 0.5, (P[i + 2] + P[j + 2]) * 0.5, from, to);
          if (d2 <= r2 && this.severRight(piece, ix, iy)) broken++;
        }
        if (iy + 1 < rows && this.links[i + 1] > 0.5) {
          const j = i + cols * 4;
          const d2 = pointSegmentDistSq((P[i] + P[j]) * 0.5, (P[i + 1] + P[j + 1]) * 0.5, (P[i + 2] + P[j + 2]) * 0.5, from, to);
          if (d2 <= r2 && this.severDown(piece, ix, iy)) broken++;
        }
      }
      if (broken > 0) {
        this.updateDisconnectedTethers(piece);
        total += broken;
      }
    }
    if (total > 0) this.upload();
    return total;
  }

  tearGrid(piece: PieceRecord, ix0: number, iy0: number, radiusCells = 1): number {
    const { cols, rows } = piece.spec;
    const r2 = Math.max(0.5, radiusCells) ** 2;
    let broken = 0;
    for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
      const dx = ix - ix0, dy = iy - iy0;
      if (dx * dx + dy * dy > r2) continue;
      if (this.severRight(piece, ix, iy)) broken++;
      if (this.severDown(piece, ix, iy)) broken++;
    }
    if (broken > 0) {
      this.updateDisconnectedTethers(piece);
      this.upload();
    }
    return broken;
  }

  snapPiece(piece: PieceRecord, index?: number): boolean {
    const { cols, rows } = piece.spec;
    const col = Math.max(0, Math.min(cols - 2, index ?? Math.floor((cols - 1) * 0.5)));
    let broken = 0;
    for (let iy = 0; iy < rows; iy++) {
      if (this.severRight(piece, col, iy)) broken++;
    }
    if (broken > 0) {
      // Small elastic recoil away from the snap seam so snapped ropes whip apart naturally.
      const base = piece.offset;
      const h = 1 / 60 / this.context.substeps;
      for (let iy = 0; iy < rows; iy++) {
        const a = (base + iy * cols + col) * 4;
        const b = a + 4;
        _seg.set(this.pos[b] - this.pos[a], this.pos[b + 1] - this.pos[a + 1], this.pos[b + 2] - this.pos[a + 2]);
        const len = _seg.length();
        if (len > 1e-5) {
          _seg.multiplyScalar((0.8 * h) / len);
          if (this.pos[a + 3] > 0) { this.prev[a] += _seg.x; this.prev[a + 1] += _seg.y; this.prev[a + 2] += _seg.z; }
          if (this.pos[b + 3] > 0) { this.prev[b] -= _seg.x; this.prev[b + 1] -= _seg.y; this.prev[b + 2] -= _seg.z; }
        }
      }
      this.updateDisconnectedTethers(piece);
      this.upload();
      return true;
    }
    return false;
  }

  healPiece(piece: PieceRecord): void {
    const start = piece.offset * 4;
    const end = (piece.offset + piece.count) * 4;
    this.links.set(this.initialLinks.subarray(start, end), start);
    this.tether.set(this.initialTether.subarray(start, end), start);
    piece.tornCount = 0;
    piece.snapped = false;
    this.upload();
  }

  tornCount(piece: PieceRecord): number {
    return piece.tornCount;
  }

  step(dt: number, time: number): void {
    const { pieces, colliders, boxColliders, groundY, substeps, iterations } = this.context;
    const P = this.pos, Q = this.prev, R = this.rest, T = this.tether, L = this.links;
    this.frameStart.set(P);
    if (dt <= 0) { this.upload(); return; }
    const h = Math.min(dt, 1 / 30) / substeps;
    const wind = this.wind;
    const sphereCount = Math.min(colliders.length, MAX_COLLIDERS);
    const boxCount = Math.min(boxColliders.length, MAX_BOX_COLLIDERS);
    // Project each oriented box onto the world axes once. Most fabric vertices
    // never enter the broad phase, especially for remote and moving colliders.
    const bounds = this.boxBounds;
    for (let bi = 0; bi < boxCount; bi++) {
      const box = boxColliders[bi], margin = box.margin ?? 0.02;
      const x = box.halfExtents.x + margin, y = box.halfExtents.y + margin, z = box.halfExtents.z + margin;
      let ex = x, ey = y, ez = z;
      if (box.quaternion) {
        const m = this.boxRotation.makeRotationFromQuaternion(box.quaternion).elements;
        ex = Math.abs(m[0])*x + Math.abs(m[4])*y + Math.abs(m[8])*z;
        ey = Math.abs(m[1])*x + Math.abs(m[5])*y + Math.abs(m[9])*z;
        ez = Math.abs(m[2])*x + Math.abs(m[6])*y + Math.abs(m[10])*z;
      }
      const b = bi * 6;
      bounds[b] = box.center.x - ex; bounds[b+1] = box.center.x + ex;
      bounds[b+2] = box.center.y - ey; bounds[b+3] = box.center.y + ey;
      bounds[b+4] = box.center.z - ez; bounds[b+5] = box.center.z + ez;
    }

    for (let s = 0; s < substeps; s++) {
      for (const piece of pieces) {
        if (!piece.enabled || !piece.activeThisFrame) continue;
        const { cols, rows } = piece.spec;
        const tune = piece.tuning;
        const m = piece.matrix.elements;
        const base = piece.offset;
        const [restX, restY] = piece.spec.spacing;
        const tetherWorld=this.tetherWorld;
        // The anchor transform stays fixed throughout a solver step.
        for(let n=0;n<piece.count;n++){
          const i=(base+n)*4;
          if(T[i+3]<0)continue;
          const x=T[i],y=T[i+1],z=T[i+2];
          tetherWorld[i]=m[0]*x+m[4]*y+m[8]*z+m[12];
          tetherWorld[i+1]=m[1]*x+m[5]*y+m[9]*z+m[13];
          tetherWorld[i+2]=m[2]*x+m[6]*y+m[10]*z+m[14];
        }
        const blasts = wind.blastCount > 0;
        const c = (base + ((rows >> 1) * cols) + (cols >> 1)) * 4;
        wind.sample(_p.set(P[c], P[c + 1], P[c + 2]), time, _base);

        const baseSpeed = Math.sqrt(_base.x * _base.x + _base.z * _base.z);
        const keep = Math.max(0, 1 - tune.damping * h);
        // ---- integrate: gravity + aerodynamic load from the shared wind field ---------
        for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
          const i = (base + iy * cols + ix) * 4;
          if (P[i + 3] === 0) {
            const x = R[i], y = R[i + 1], z = R[i + 2];
            Q[i] = P[i]; Q[i + 1] = P[i + 1]; Q[i + 2] = P[i + 2];
            P[i] = m[0] * x + m[4] * y + m[8] * z + m[12]; P[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; P[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            continue;
          }
          // Surface normal from intact grid neighbours (do not span across torn edges).
          const li = ix > 0 && L[i - 4] > 0.5 ? i - 4 : i;
          const ri = ix + 1 < cols && L[i] > 0.5 ? i + 4 : i;
          const ui = iy > 0 && L[i - cols * 4 + 1] > 0.5 ? i - cols * 4 : i;
          const di = iy + 1 < rows && L[i + 1] > 0.5 ? i + cols * 4 : i;
          const ax = P[ri] - P[li], ay = P[ri + 1] - P[li + 1], az = P[ri + 2] - P[li + 2];
          let nx: number, ny: number, nz: number;
          if (rows > 1) {
            const bx = P[di] - P[ui], by = P[di + 1] - P[ui + 1], bz = P[di + 2] - P[ui + 2];
            nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
          } else { nx = 0; ny = 0; nz = 0; }
          const normalSq = nx * nx + ny * ny + nz * nz;
          const px = P[i], py = P[i + 1], pz = P[i + 2];
          const vx = (px - Q[i]) / h, vy = (py - Q[i + 1]) / h, vz = (pz - Q[i + 2]) / h;
          if (blasts) wind.sample(_p.set(px, py, pz), time, _wind); else _wind.copy(_base);
          const speed = blasts ? Math.sqrt(_wind.x * _wind.x + _wind.z * _wind.z) : baseSpeed;
          if (speed > 0.01 && tune.flutter > 0) {
            const along = (px * _wind.x + pz * _wind.z) / speed;
            const wave = (Math.sin(along * 3.1 - time * speed * 1.3 + py * 1.7) * 0.34 + Math.sin(along * 7.3 - time * speed * 2.9 - py * 2.3) * 0.2) * speed * tune.flutter;
            const crossX = -_wind.z / speed, crossZ = _wind.x / speed;
            _wind.x += crossX * wave; _wind.z += crossZ * wave; _wind.y += wave * 0.35;
          }
          const rx = _wind.x - vx, ry = _wind.y - vy, rz = _wind.z - vz;
          let fx = rx * tune.dragTangent, fy = ry * tune.dragTangent, fz = rz * tune.dragTangent;
          if (normalSq > 1e-16) {
            const k = ((nx * rx + ny * ry + nz * rz) / normalSq) * tune.dragNormal;
            fx += nx * k; fy += ny * k; fz += nz * k;
          } else {
            const tangentSq = Math.max(1e-16, ax * ax + ay * ay + az * az);
            const along = (ax * rx + ay * ry + az * rz) / tangentSq;
            fx += (rx - ax * along) * tune.dragNormal; fy += (ry - ay * along) * tune.dragNormal; fz += (rz - az * along) * tune.dragNormal;
          }
          if (tune.inflate > 0 && ry > 0 && normalSq > 1e-16) {
            const ox = px - m[12], oy = py - m[13], oz = pz - m[14];
            const side = nx * ox + ny * oy + nz * oz >= 0 ? 1 : -1;
            const k = (ry * tune.inflate * side) / Math.sqrt(normalSq);
            fx += nx * k; fy += ny * k; fz += nz * k;
          }
          Q[i] = px; Q[i + 1] = py; Q[i + 2] = pz;
          P[i] = px + vx * h * keep + fx * h * h;
          P[i + 1] = py + vy * h * keep + (fy - 9.81 * tune.gravity) * h * h;
          P[i + 2] = pz + vz * h * keep + fz * h * h;
        }

        // ---- constraints: each intact neighbouring pair once per iteration -------------
        const diagonal = Math.hypot(restX, restY);
        const tearRatio = tune.tearThreshold;
        let toreThisStep = false;


        // Distant and off-screen meshes already advance at reduced cadence. Their
        // projected constraint errors permit fewer relaxation sweeps.
        const sweeps=piece.lodLevel===0?iterations:Math.max(1,Math.ceil(iterations*(piece.lodLevel===1?0.65:0.4)));
        for (let it = 0; it < sweeps; it++) {
          const checkTear = tearRatio > 0 && it === 0;
          for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
            const i = (base + iy * cols + ix) * 4;
            if (ix + 1 < cols && L[i] > 0.5) {
              const len = solveLink(P, i, i + 4, restX, tune.stiffness);
              if (checkTear && len > restX * tearRatio && this.severRight(piece, ix, iy)) toreThisStep = true;
            }
            if (iy + 1 < rows && L[i + 1] > 0.5) {
              const len = solveLink(P, i, i + cols * 4, restY, tune.stiffness);
              if (checkTear && len > restY * tearRatio && this.severDown(piece, ix, iy)) toreThisStep = true;
            }
            if (ix + 1 < cols && iy + 1 < rows) {
              if (L[i + 2] > 0.5) solveLink(P, i, i + cols * 4 + 4, diagonal, tune.stiffness * 0.6);
              if (L[i + 4 + 3] > 0.5) solveLink(P, i + 4, i + cols * 4, diagonal, tune.stiffness * 0.6);
            }
            if (tune.bend > 0) {
              if (ix + 2 < cols && L[i] > 0.5 && L[i + 4] > 0.5) solveLink(P, i, i + 8, restX * 2, tune.stiffness * tune.bend);
              if (iy + 2 < rows && L[i + 1] > 0.5 && L[i + cols * 4 + 1] > 0.5) solveLink(P, i, i + cols * 8, restY * 2, tune.stiffness * tune.bend);
            }
          }
          // Tethers (maximum distance), sphere & box colliders, ground.
          for (let n = 0; n < piece.count; n++) {
            const i = (base + n) * 4;
            if (P[i + 3] === 0) continue;
            const length = T[i + 3];
            if (length >= 0) {
              const x=tetherWorld[i],y=tetherWorld[i+1],z=tetherWorld[i+2];
              const dx=P[i]-x,dy=P[i+1]-y,dz=P[i+2]-z, ls=dx*dx+dy*dy+dz*dz;
              if(ls>length*length){const k=length/Math.sqrt(ls);P[i]=x+dx*k;P[i+1]=y+dy*k;P[i+2]=z+dz*k;}
            }
            for (let ci = 0; ci < sphereCount; ci++) {
              const col = colliders[ci];
              const dx = P[i] - col.center.x, dy = P[i + 1] - col.center.y, dz = P[i + 2] - col.center.z;
              const squared = dx * dx + dy * dy + dz * dz;
              if (squared < col.radius * col.radius) {
                const len = Math.sqrt(squared);
                if (len > 1e-6) { const k = col.radius / len; P[i] = col.center.x + dx * k; P[i + 1] = col.center.y + dy * k; P[i + 2] = col.center.z + dz * k; }
                else { P[i + 1] = col.center.y + col.radius; }
              }
            }
            for (let bi = 0; bi < boxCount; bi++) {
              const b = bi * 6;
              if (P[i] < bounds[b] || P[i] > bounds[b+1] || P[i+1] < bounds[b+2] ||
                  P[i+1] > bounds[b+3] || P[i+2] < bounds[b+4] || P[i+2] > bounds[b+5]) continue;
              pushOutBox(P, i, boxColliders[bi]);
            }
            if (P[i + 1] < groundY) P[i + 1] = groundY;
          }
        }
        if (toreThisStep) this.updateDisconnectedTethers(piece);
      }
    }
    this.upload();
  }

  dispose(): void { this.texture.dispose(); }
}

export { _mid };
