/**
 * CPU Verlet strand solver (reference implementation + WebGL 2 fallback).
 *
 * Solves grass, kelp, and hair chains with:
 *   - Rest-pose stiffness springs + gravity (or positive buoyancy for kelp),
 *   - Unified wind field + travelling flutter waves + blasts (or underwater swell surge for kelp),
 *   - Rotor / jet downwash (radial outward + downward pressure + vortex swirl),
 *   - Sphere and oriented-box vehicle/collider pushout + velocity wake transfer,
 *   - Root-to-tip inextensible distance constraint sweeps.
 *
 * Publishes live node positions and previous-frame positions into a float DataTexture so
 * the Kajiya–Kay instanced shader is identical to the WebGPU path.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type { WindField } from '../../engine/wind';
import {
  layoutStrandFields,
  MAX_DOWNWASH_SOURCES,
  MAX_STRAND_INTERACTORS,
  type StrandBackend,
  type StrandContext,
  type StrandInteractor,
} from './types';

const { textureLoad, ivec2, int } = TSL;

const TEX_WIDTH = 512;
const _wind = new THREE.Vector3();
const _p = new THREE.Vector3();
const _rootWorld = new THREE.Vector3();
const _restDir = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _nrm = new THREE.Vector3();

function pushOutInteractor(
  P: Float32Array,
  Q: Float32Array,
  idx: number,
  h: number,
  inter: StrandInteractor,
  response: number,
): void {
  const px = P[idx], py = P[idx + 1], pz = P[idx + 2];
  const str = (inter.strength ?? 1) * response;
  if (str <= 0) return;

  if (inter.halfExtents) {
    // Oriented or axis-aligned vehicle/chassis box.
    const hx = inter.halfExtents.x + 0.05, hy = inter.halfExtents.y + 0.05, hz = inter.halfExtents.z + 0.05;
    _local.set(px - inter.position.x, py - inter.position.y, pz - inter.position.z);
    const q = inter.quaternion;
    if (q) { _qInv.copy(q).invert(); _local.applyQuaternion(_qInv); }
    const ax = Math.abs(_local.x), ay = Math.abs(_local.y), az = Math.abs(_local.z);
    if (ax >= hx || ay >= hy || az >= hz) return;

    const penX = hx - ax, penY = hy - ay, penZ = hz - az;
    _nrm.set(0, 0, 0);
    if (penX <= penY && penX <= penZ) { const s = _local.x >= 0 ? 1 : -1; _local.x = s * hx; _nrm.x = s; }
    else if (penZ <= penY) { const s = _local.z >= 0 ? 1 : -1; _local.z = s * hz; _nrm.z = s; }
    else { const s = _local.y >= 0 ? 1 : -1; _local.y = s * hy; _nrm.y = s; }
    if (q) { _local.applyQuaternion(q); _nrm.applyQuaternion(q); }

    P[idx] = inter.position.x + _local.x;
    P[idx + 1] = inter.position.y + _local.y;
    P[idx + 2] = inter.position.z + _local.z;
    if (inter.velocity) {
      Q[idx] -= inter.velocity.x * 0.45 * str * h;
      Q[idx + 1] -= inter.velocity.y * 0.25 * str * h;
      Q[idx + 2] -= inter.velocity.z * 0.45 * str * h;
    }
    return;
  }

  // Sphere interactor.
  const dx = px - inter.position.x, dy = py - inter.position.y, dz = pz - inter.position.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const r = inter.radius;
  if (distSq >= r * r) return;
  const dist = Math.sqrt(distSq);
  const inv = dist > 1e-5 ? 1 / dist : 0;
  const nx = inv ? dx * inv : 0, ny = inv ? dy * inv : 1, nz = inv ? dz * inv : 0;
  P[idx] = inter.position.x + nx * r;
  P[idx + 1] = inter.position.y + ny * r;
  P[idx + 2] = inter.position.z + nz * r;
  if (inter.velocity) {
    Q[idx] -= inter.velocity.x * 0.4 * str * h;
    Q[idx + 1] -= inter.velocity.y * 0.2 * str * h;
    Q[idx + 2] -= inter.velocity.z * 0.4 * str * h;
  }
}

export class CpuStrandSolver implements StrandBackend {
  readonly kind = 'cpu' as const;
  readonly strandCount: number;
  readonly nodeCount: number;
  readonly pos: Float32Array;
  private prev: Float32Array;
  private frameStart: Float32Array;
  private roots: Float32Array;
  private dirs: Float32Array;
  private meta: Float32Array;
  private nodeTexture: THREE.DataTexture;
  private nodeData: Float32Array;
  private nodeRows: number;
  private strandTexture: THREE.DataTexture;
  private strandData: Float32Array;
  private strandRows: number;

  constructor(private context: StrandContext, private wind: WindField) {
    const layout = layoutStrandFields(context.fields);
    this.strandCount = layout.strandCount;
    this.nodeCount = layout.nodeCount;
    this.pos = layout.position;
    this.prev = layout.previous;
    this.frameStart = new Float32Array(layout.position);
    this.roots = layout.roots;
    this.dirs = layout.dirs;
    this.meta = layout.meta;

    // Node texture: Band 0 [0, nodeRows) current pos; Band 1 [nodeRows, 2*nodeRows) previous frame pos.
    this.nodeRows = Math.ceil(this.nodeCount / TEX_WIDTH);
    this.nodeData = new Float32Array(TEX_WIDTH * this.nodeRows * 2 * 4);
    this.nodeTexture = new THREE.DataTexture(this.nodeData, TEX_WIDTH, this.nodeRows * 2, THREE.RGBAFormat, THREE.FloatType);
    this.nodeTexture.minFilter = this.nodeTexture.magFilter = THREE.NearestFilter;
    this.nodeTexture.generateMipmaps = false;

    // Static strand texture: Band 0 meta, Band 1 dirs (halfWidth in w).
    this.strandRows = Math.ceil(this.strandCount / TEX_WIDTH);
    this.strandData = new Float32Array(TEX_WIDTH * this.strandRows * 2 * 4);
    this.strandData.set(this.meta.subarray(0, this.strandCount * 4), 0);
    this.strandData.set(this.dirs.subarray(0, this.strandCount * 4), TEX_WIDTH * this.strandRows * 4);
    this.strandTexture = new THREE.DataTexture(this.strandData, TEX_WIDTH, this.strandRows * 2, THREE.RGBAFormat, THREE.FloatType);
    this.strandTexture.minFilter = this.strandTexture.magFilter = THREE.NearestFilter;
    this.strandTexture.generateMipmaps = false;
    this.strandTexture.needsUpdate = true;

    this.upload();
  }

  private upload(): void {
    const band = TEX_WIDTH * this.nodeRows * 4;
    this.nodeData.set(this.pos.subarray(0, this.nodeCount * 4), 0);
    this.nodeData.set(this.frameStart.subarray(0, this.nodeCount * 4), band);
    this.nodeTexture.needsUpdate = true;
  }

  node(index: N): N {
    const i = int(index);
    return textureLoad(this.nodeTexture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH))).xyz;
  }

  previousNode(index: N): N {
    const i = int(index);
    return textureLoad(this.nodeTexture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.nodeRows))).xyz;
  }

  strandMeta(strandIndex: N): N {
    const i = int(strandIndex);
    return textureLoad(this.strandTexture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH)));
  }

  strandDir(strandIndex: N): N {
    const i = int(strandIndex);
    return textureLoad(this.strandTexture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.strandRows)));
  }

  readNode(nodeIndex: number, out: THREE.Vector3): THREE.Vector3 {
    const i = nodeIndex * 4;
    return out.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]);
  }

  step(dt: number, time: number): void {
    const { fields, downwash, interactors, blasts, waterCurrent, waterLevel, groundY, substeps } = this.context;
    const P = this.pos, Q = this.prev, R = this.roots, D = this.dirs, M = this.meta;
    this.frameStart.set(P);
    if (dt <= 0) { this.upload(); return; }
    const frameDt = Math.min(dt, 1 / 30);
    const h = frameDt / substeps;
    const wind = this.wind;
    const dwCount = Math.min(downwash.length, MAX_DOWNWASH_SOURCES);
    const inCount = Math.min(interactors.length, MAX_STRAND_INTERACTORS);

    for (let sub = 0; sub < substeps; sub++) {
      for (const field of fields) {
        if (!field.enabled || !field.activeThisFrame) continue;
        const tune = field.tuning;
        const nps = field.nodesPerStrand;
        const segs = nps - 1;
        const isKelp = field.spec.kind === 'kelp';
        const isHair = field.spec.kind === 'hair';
        const m = field.matrix.elements;
        const keep = Math.max(0, 1 - tune.damping * h);

        for (let s = 0; s < field.strandCount; s++) {
          const gs = field.strandOffset + s;
          const nBase = field.nodeOffset + s * nps;
          const rx = R[gs * 4], ry = R[gs * 4 + 1], rz = R[gs * 4 + 2];
          // Root world position follows field matrix rigidly.
          let rwx = m[0] * rx + m[4] * ry + m[8] * rz + m[12];
          let rwy = m[1] * rx + m[5] * ry + m[9] * rz + m[13];
          let rwz = m[2] * rx + m[6] * ry + m[10] * rz + m[14];
          const i0 = nBase * 4;
          let stepX = 0, stepY = 0, stepZ = 0;
          if (isHair) {
            stepX = (rwx - this.frameStart[i0]) / substeps;
            stepY = (rwy - this.frameStart[i0 + 1]) / substeps;
            stepZ = (rwz - this.frameStart[i0 + 2]) / substeps;
            rwx = this.frameStart[i0] + stepX * (sub + 1);
            rwy = this.frameStart[i0 + 1] + stepY * (sub + 1);
            rwz = this.frameStart[i0 + 2] + stepZ * (sub + 1);
          }
          _rootWorld.set(rwx, rwy, rwz);

          const dx0 = D[gs * 4], dy0 = D[gs * 4 + 1], dz0 = D[gs * 4 + 2];
          _restDir.set(
            m[0] * dx0 + m[4] * dy0 + m[8] * dz0,
            m[1] * dx0 + m[5] * dy0 + m[9] * dz0,
            m[2] * dx0 + m[6] * dy0 + m[10] * dz0,
          ).normalize();

          const seed = M[gs * 4];
          const stiffScale = M[gs * 4 + 1];
          const arch = M[gs * 4 + 2];
          const segLen = P[nBase * 4 + 3];
          const totalLen = segLen * segs;

          // Anchor node 0.
          Q[i0] = P[i0]; Q[i0 + 1] = P[i0 + 1]; Q[i0 + 2] = P[i0 + 2];
          P[i0] = rwx; P[i0 + 1] = rwy; P[i0 + 2] = rwz;

          // Sample wind once at the strand root (or per-node when blasts are active).
          const hasBlasts = wind.blastCount > 0 || blasts.length > 0;
          if (!isKelp) wind.sample(_rootWorld, time, _wind);

          // Integrate nodes 1..segs.
          for (let k = 1; k < nps; k++) {
            const idx = (nBase + k) * 4;
            const px = P[idx], py = P[idx + 1], pz = P[idx + 2];
            const vx = (px - Q[idx]) / h, vy = (py - Q[idx + 1]) / h, vz = (pz - Q[idx + 2]) / h;
            const t = k / segs;

            // Target rest curve position for elastic spring recovery.
            const tx = rwx + _restDir.x * (t * totalLen);
            const ty = rwy + _restDir.y * (t * totalLen) - arch * t * t * totalLen * 0.25;
            const tz = rwz + _restDir.z * (t * totalLen);
            const kStiff = tune.stiffness * stiffScale * (1.25 - 0.65 * t);
            let ax = (tx - px) * kStiff;
            let ay = (ty - py) * kStiff - 9.81 * tune.gravity;
            let az = (tz - pz) * kStiff;

            // Ambient fluid / wind force.
            if (isKelp) {
              // Underwater swell orbital surge + gentle ocean current + flutter.
              const phase = px * 0.28 + pz * 0.21 + time * 1.45 + seed * 6.2831;
              const surgeX = waterCurrent.x + Math.sin(phase) * 1.8 + Math.cos(phase * 1.7 + py * 0.8) * 0.7 * tune.flutter;
              const surgeZ = waterCurrent.z + Math.cos(phase * 0.87 + seed * 3.1) * 1.4;
              const surgeY = Math.sin(phase * 1.15) * 0.45;
              const dragK = tune.drag * tune.windResponse;
              ax += (surgeX - vx) * dragK;
              ay += (surgeY - vy) * dragK;
              az += (surgeZ - vz) * dragK;
            } else {
              if (hasBlasts) wind.sample(_p.set(px, py, pz), time, _wind);
              const airX = _wind.x - stepX / h, airZ = _wind.z - stepZ / h;
              const spd = Math.hypot(airX, airZ);
              let wx = _wind.x, wy = _wind.y, wz = _wind.z;
              if (spd > 0.05 && tune.flutter > 0) {
                const along = (px * airX + pz * airZ) / spd;
                const wave = (Math.sin(along * 1.45 - time * (2.6 + spd * 0.55) + seed * 6.2831) * 0.55
                  + Math.sin(along * 3.7 - time * (5.2 + spd * 0.9) - seed * 11.3) * 0.3) * spd * 0.35 * tune.flutter;
                wx += (-airZ + airX * 0.45) * wave / spd;
                wz += (airX + airZ * 0.45) * wave / spd;
                wy -= Math.abs(wave) * 0.2;
              }
              const dragK = tune.drag * tune.windResponse * (0.35 + 0.85 * t);
              ax += (wx - vx) * dragK;
              ay += (wy - vy) * dragK;
              az += (wz - vz) * dragK;
            }

            // Explicit strand blasts (explosions / shockwaves / depth charges).
            for (let bi = 0; bi < blasts.length; bi++) {
              const b = blasts[bi];
              const prog = b.age / b.duration;
              const rad = b.radius * (0.3 + 0.7 * prog);
              const bx = px - b.position.x, by = py - b.position.y, bz = pz - b.position.z;
              const dist = Math.hypot(bx, by, bz) + 1e-3;
              if (dist < rad) {
                const fall = (1 - dist / rad) ** 2 * (1 - prog) ** 1.5;
                const push = b.strength * fall * tune.windResponse * 4.5;
                ax += (bx / dist) * push;
                ay += (by / dist) * push * 0.4 - push * 0.25;
                az += (bz / dist) * push;
              }
            }

            // Rotor / jet downwash: radially pushes strands outward and presses them flat with swirl.
            if (tune.downwashResponse > 0) {
              for (let di = 0; di < dwCount; di++) {
                const dw = downwash[di];
                const dx = px - dw.position.x, dy = py - dw.position.y, dz = pz - dw.position.z;
                const horiz = Math.hypot(dx, dz);
                if (horiz < dw.radius && dy < 4 && dy > -dw.radius * 2.5) {
                  const radFall = 1 - horiz / dw.radius;
                  const vertFall = dy <= 0 ? Math.max(0, 1 + dy / (dw.radius * 2.5)) : Math.max(0, 1 - dy / 4);
                  const env = radFall * radFall * vertFall * dw.strength * tune.downwashResponse * 3.8;
                  const invH = horiz > 1e-3 ? 1 / horiz : 0;
                  const rxDir = invH ? dx * invH : Math.cos(seed * 6.2831);
                  const rzDir = invH ? dz * invH : Math.sin(seed * 6.2831);
                  const swirl = dw.swirl ?? 0.35;
                  // Outward radial blast + tangential vortex swirl + strong downward flatten.
                  ax += (rxDir - rzDir * swirl) * env;
                  az += (rzDir + rxDir * swirl) * env;
                  ay -= env * (0.55 + 0.45 * radFall);
                }
              }
            }

            Q[idx] = px; Q[idx + 1] = py; Q[idx + 2] = pz;
            P[idx] = px + vx * h * keep + stepX * (1 - keep) + ax * h * h;
            P[idx + 1] = py + vy * h * keep + stepY * (1 - keep) + ay * h * h;
            P[idx + 2] = pz + vz * h * keep + stepZ * (1 - keep) + az * h * h;

            // Vehicle & sphere/box interactors.
            for (let ii = 0; ii < inCount; ii++) {
              pushOutInteractor(P, Q, idx, h, interactors[ii], tune.vehicleResponse);
            }

            // Keep grass above its root floor and kelp beneath the water surface.
            const floor = isHair ? groundY : Math.max(groundY, isKelp ? rwy - 0.1 : rwy + 0.01);
            if (P[idx + 1] < floor) P[idx + 1] = floor;
            if (isKelp && P[idx + 1] > waterLevel - 0.05) P[idx + 1] = waterLevel - 0.05;
          }

          // Root-to-tip inextensible distance constraint sweeps.
          const iters = Math.max(1, tune.constraintIterations);
          for (let it = 0; it < iters; it++) {
            for (let k = 1; k < nps; k++) {
              const ia = (nBase + k - 1) * 4;
              const ib = (nBase + k) * 4;
              const dx = P[ib] - P[ia], dy = P[ib + 1] - P[ia + 1], dz = P[ib + 2] - P[ia + 2];
              const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (len < 1e-7) continue;
              const diff = (len - segLen) / len;
              if (k === 1) {
                P[ib] -= dx * diff; P[ib + 1] -= dy * diff; P[ib + 2] -= dz * diff;
              } else {
                // Bias correction toward the child so tension flows smoothly from root to tip.
                P[ia] += dx * diff * 0.2; P[ia + 1] += dy * diff * 0.2; P[ia + 2] += dz * diff * 0.2;
                P[ib] -= dx * diff * 0.8; P[ib + 1] -= dy * diff * 0.8; P[ib + 2] -= dz * diff * 0.8;
              }
            }
          }
        }
      }
    }

    this.upload();
  }

  dispose(): void {
    this.nodeTexture.dispose();
    this.strandTexture.dispose();
  }
}
