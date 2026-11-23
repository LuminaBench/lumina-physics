/**
 * GPU cloth / rope solver (WebGPU compute, authored in TSL).
 *
 * Same model as `cpu.ts`, solved with Jacobi iterations so every particle can be updated in
 * parallel: two position buffers are ping-ponged (read A → write B, read B → write A) and a
 * frame's work is one compute pass of
 *
 *     snapshot · [ integrate · relax × iterations · tearPass ] × substeps
 *
 * regardless of how many pieces exist. Supports dynamic tearing & rope snapping (updating
 * both constraints and visible topology with zero CPU readback), sphere + oriented box
 * collider pushout, and per-piece frustum/distance LOD gating.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import type { WindField } from '../../engine/wind';
import { layoutPieces, MAX_BOX_COLLIDERS, MAX_COLLIDERS, MAX_PIECES, STENCIL, type ClothBackend, type PieceRecord, type SolverContext } from './types';

const { Fn, If, int, float, vec3, vec4, uniform, uniformArray, instancedArray, instanceIndex, cross, dot, length, max, sin, clamp, sqrt, abs, select } = TSL;

/** Sum of constraint weights a particle can receive at once; dividing by it keeps Jacobi stable. */
const JACOBI_RELAXATION = 1 / 3.4;
const MAX_TEAR_CMDS = 4;
// One uniform-buffer binding holds the contiguous vec4 tables for every
// piece. The integration pass also reads the wind and world-field buffers.
const REST = MAX_PIECES, AERO = 2 * MAX_PIECES, MISC = 3 * MAX_PIECES, KICK = 4 * MAX_PIECES;

const _mat = new THREE.Matrix4();
const _invMat = new THREE.Matrix4();
const _unitScale = new THREE.Vector3(1, 1, 1);
const _idQuat = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Queued GPU tear / cut / snap / heal command (executed inside the compute pass). */
interface TearCmd {
  /** 1 = sphere, 2 = line segment, 3 = grid cell, 4 = snap col, 5 = heal piece. */
  mode: number;
  /** Target piece id, or -1 for all pieces. */
  pieceId: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

export class GpuClothSolver implements ClothBackend {
  readonly kind = 'gpu' as const;
  readonly count: number;
  private A: N; private B: N; private prev: N; private frameStart: N; private rest: N; private tether: N;
  private initialTether: N;
  private links: N;
  private initialLinks: N;
  private pieceData: N; private pieceMatrix: N;
  private colliderData: N;
  private boxInvMatrix: N;
  private boxMatrix: N;
  private boxExtents: N;
  private cmdA: N;
  private cmdB: N;
  private cmdC: N;
  private uStep = uniform(1 / 120);
  private uGround = uniform(-1e5);
  private uColliders = uniform(0);
  private uBoxColliders = uniform(0);
  private uTearCmds = uniform(0);
  private passes: N[] = [];
  private initial: Float32Array;
  private restData: Float32Array;
  private kicked = false;
  private pendingCmds: TearCmd[] = [];

  constructor(private renderer: THREE.WebGPURenderer, private context: SolverContext, wind: WindField) {
    const layout = layoutPieces(context.pieces);
    const count = this.count = layout.count;
    this.initial = layout.position;
    this.restData = layout.rest;
    const A = this.A = instancedArray(layout.position, 'vec4');
    const B = this.B = instancedArray(new Float32Array(layout.position), 'vec4');
    const prev = this.prev = instancedArray(layout.previous, 'vec4');
    const frameStart = this.frameStart = instancedArray(new Float32Array(layout.position), 'vec4');
    const rest = this.rest = instancedArray(layout.rest, 'vec4');
    const tether = this.tether = instancedArray(layout.tether, 'vec4');
    const initialTether = this.initialTether = instancedArray(new Float32Array(layout.tether), 'vec4');
    const links = this.links = instancedArray(layout.links, 'vec4');
    const initialLinks = this.initialLinks = instancedArray(new Float32Array(layout.links), 'vec4');

    const vec4s = (n: number) => uniformArray(Array.from({ length: n }, () => new THREE.Vector4()), 'vec4');
    const mat4s = (n: number) => uniformArray(Array.from({ length: n }, () => new THREE.Matrix4()), 'mat4');
    const pieceData = this.pieceData = vec4s(5 * MAX_PIECES);
    const pieceMatrix = this.pieceMatrix = mat4s(MAX_PIECES);
    const colliders = this.colliderData = uniformArray(Array.from({ length: MAX_COLLIDERS }, () => new THREE.Vector4(0, -1e6, 0, 0)), 'vec4');
    const boxInvMatrix = this.boxInvMatrix = mat4s(MAX_BOX_COLLIDERS);
    const boxMatrix = this.boxMatrix = mat4s(MAX_BOX_COLLIDERS);
    const boxExtents = this.boxExtents = vec4s(MAX_BOX_COLLIDERS);
    const cmdA = this.cmdA = vec4s(MAX_TEAR_CMDS);
    const cmdB = this.cmdB = vec4s(MAX_TEAR_CMDS);
    const cmdC = this.cmdC = vec4s(MAX_TEAR_CMDS);
    const h = this.uStep, ground = this.uGround, colliderCount = this.uColliders, boxCount = this.uBoxColliders, tearCmdCount = this.uTearCmds;

    const snapshot = Fn(() => { frameStart.element(instanceIndex).assign(A.element(instanceIndex)); })().compute(count);

    const integrate = Fn(() => {
      const i = int(instanceIndex);
      const p4 = A.element(i);
      const p = p4.xyz.toVar();
      const r4 = rest.element(i);
      const pid = int(r4.w);
      const info = pieceData.element(pid);
      const offset = int(info.x), cols = int(info.y), rows = int(info.z);
      const out = vec3(p).toVar();
      If(p4.w.lessThan(0.5), () => {
        out.assign(pieceMatrix.element(pid).mul(vec4(r4.xyz, 1)).xyz);
      }).ElseIf(info.w.greaterThan(0.5), () => {
        const local = i.sub(offset);
        const ix = local.mod(cols), iy = local.div(cols);
        const myLink = links.element(i);
        const idxL = offset.add(iy.mul(cols)).add(max(ix.sub(1), int(0)));
        const idxR = offset.add(iy.mul(cols)).add(clamp(ix.add(1), int(0), cols.sub(1)));
        const idxU = offset.add(max(iy.sub(1), int(0)).mul(cols)).add(ix);
        const idxD = offset.add(clamp(iy.add(1), int(0), rows.sub(1)).mul(cols)).add(ix);
        // Only span intact neighbours when computing the surface normal.
        const hasL = ix.greaterThan(0).and(links.element(idxL).x.greaterThan(0.5));
        const hasR = ix.add(1).lessThan(cols).and(myLink.x.greaterThan(0.5));
        const hasU = iy.greaterThan(0).and(links.element(idxU).y.greaterThan(0.5));
        const hasD = iy.add(1).lessThan(rows).and(myLink.y.greaterThan(0.5));
        const pL = select(hasL, A.element(idxL).xyz, p);
        const pR = select(hasR, A.element(idxR).xyz, p);
        const pU = select(hasU, A.element(idxU).xyz, p);
        const pD = select(hasD, A.element(idxD).xyz, p);
        const a = pR.sub(pL).toVar();
        const b = pD.sub(pU);
        const n = cross(a, b).toVar();
        const aero = pieceData.element(pid.add(AERO));
        const misc = pieceData.element(pid.add(MISC));
        const velocity = p.sub(prev.element(i).xyz).div(h).toVar();
        const air = wind.node(p).toVar();
        const speed = length(air.xz);
        If(speed.greaterThan(0.01), () => {
          const along = dot(p.xz, air.xz).div(speed);
          const t = frame.time;
          const wave = sin(along.mul(3.1).sub(t.mul(speed).mul(1.3)).add(p.y.mul(1.7))).mul(0.34)
            .add(sin(along.mul(7.3).sub(t.mul(speed).mul(2.9)).sub(p.y.mul(2.3))).mul(0.2)).mul(speed).mul(misc.x);
          air.addAssign(vec3(air.z.negate().div(speed).mul(wave), wave.mul(0.35), air.x.div(speed).mul(wave)));
        });
        const rel = air.sub(velocity);
        const force = rel.mul(aero.y).toVar();
        If(misc.y.lessThan(0.5), () => {
          force.addAssign(n.mul(dot(n, rel).div(max(dot(n, n), 1e-8))).mul(aero.x));
        }).Else(() => {
          force.addAssign(rel.sub(a.mul(dot(a, rel).div(max(dot(a, a), 1e-8)))).mul(aero.x));
        });
        If(misc.z.greaterThan(0).and(rel.y.greaterThan(0)), () => {
          const outward = p.sub(pieceMatrix.element(pid).mul(vec4(0, 0, 0, 1)).xyz);
          const side = dot(n, outward).greaterThanEqual(0).select(float(1), float(-1));
          force.addAssign(n.div(max(length(n), 1e-6)).mul(side).mul(rel.y).mul(misc.z));
        });
        force.addAssign(vec3(0, aero.z.mul(-9.81), 0));
        force.addAssign(pieceData.element(pid.add(KICK)).xyz);
        const keep = max(float(1).sub(aero.w.mul(h)), 0);
        out.assign(p.add(velocity.mul(h).mul(keep)).add(force.mul(h).mul(h)));
      });
      prev.element(i).assign(vec4(p, 0));
      B.element(i).assign(vec4(out, p4.w));
    })().compute(count);

    const relax = (read: N, write: N): N => Fn(() => {
      const i = int(instanceIndex);
      const p4 = read.element(i);
      const p = p4.xyz.toVar();
      const r4 = rest.element(i);
      const pid = int(r4.w);
      const info = pieceData.element(pid);
      If(p4.w.greaterThan(0.5).and(info.w.greaterThan(0.5)), () => {
        const offset = int(info.x), cols = int(info.y), rows = int(info.z);
        const spacing = pieceData.element(pid.add(REST));
        const local = i.sub(offset);
        const ix = local.mod(cols), iy = local.div(cols);
        const diagonal = sqrt(spacing.x.mul(spacing.x).add(spacing.y.mul(spacing.y)));
        const myLink = links.element(i);
        const correction = vec3(0).toVar();

        for (const [dx, dy, kind] of STENCIL) {
          const nx = ix.add(dx), ny = iy.add(dy);
          If(nx.greaterThanEqual(0).and(nx.lessThan(cols)).and(ny.greaterThanEqual(0)).and(ny.lessThan(rows)), () => {
            const nbIdx = offset.add(ny.mul(cols)).add(nx);
            // Determine whether this stencil edge is intact.
            let intact: N = float(1);
            if (dx === 1 && dy === 0) intact = myLink.x;
            else if (dx === -1 && dy === 0) intact = links.element(nbIdx).x;
            else if (dx === 0 && dy === 1) intact = myLink.y;
            else if (dx === 0 && dy === -1) intact = links.element(nbIdx).y;
            else if (dx === 1 && dy === 1) intact = myLink.z;
            else if (dx === -1 && dy === -1) intact = links.element(nbIdx).z;
            else if (dx === -1 && dy === 1) intact = myLink.w;
            else if (dx === 1 && dy === -1) intact = links.element(nbIdx).w;
            else if (dx === 2 && dy === 0) intact = myLink.x.mul(links.element(offset.add(iy.mul(cols)).add(ix.add(1))).x);
            else if (dx === -2 && dy === 0) intact = links.element(offset.add(iy.mul(cols)).add(ix.sub(1))).x.mul(links.element(nbIdx).x);
            else if (dx === 0 && dy === 2) intact = myLink.y.mul(links.element(offset.add(iy.add(1).mul(cols)).add(ix)).y);
            else if (dx === 0 && dy === -2) intact = links.element(offset.add(iy.sub(1).mul(cols)).add(ix)).y.mul(links.element(nbIdx).y);

            If(intact.greaterThan(0.5), () => {
              const q = read.element(nbIdx);
              const delta = q.xyz.sub(p);
              const len = max(length(delta), 1e-6);
              const restLength = kind === 1 ? diagonal : spacing.x.mul(Math.abs(dx)).add(spacing.y.mul(Math.abs(dy)));
              const weight = kind === 0 ? spacing.z : kind === 1 ? spacing.z.mul(0.6) : spacing.z.mul(spacing.w);
              const share = float(1).div(float(1).add(q.w));
              correction.addAssign(delta.mul(len.sub(restLength).div(len)).mul(weight).mul(share));
            });
          });
        }
        p.addAssign(correction.mul(JACOBI_RELAXATION));

        // Tether: a maximum distance to an anchor in the piece's frame.
        const t4 = tether.element(i);
        If(t4.w.greaterThanEqual(0), () => {
          const anchor = pieceMatrix.element(pid).mul(vec4(t4.xyz, 1)).xyz;
          const d = p.sub(anchor);
          const len = length(d);
          If(len.greaterThan(t4.w), () => { p.assign(anchor.add(d.mul(t4.w.div(len)))); });
        });

        // Sphere colliders.
        for (let c = 0; c < MAX_COLLIDERS; c++) {
          If(colliderCount.greaterThan(c), () => {
            const sphere = colliders.element(c);
            const d = p.sub(sphere.xyz);
            const len = length(d);
            If(len.lessThan(sphere.w), () => {
              If(len.greaterThan(1e-6), () => {
                p.assign(sphere.xyz.add(d.mul(sphere.w.div(len))));
              }).Else(() => {
                p.assign(sphere.xyz.add(vec3(0, sphere.w, 0)));
              });
            });
          });
        }

        // Oriented / axis-aligned box colliders.
        for (let b = 0; b < MAX_BOX_COLLIDERS; b++) {
          If(boxCount.greaterThan(b), () => {
            const ext = boxExtents.element(b);
            const lp = boxInvMatrix.element(b).mul(vec4(p, 1)).xyz.toVar();
            const ax = abs(lp.x), ay = abs(lp.y), az = abs(lp.z);
            If(ax.lessThan(ext.x).and(ay.lessThan(ext.y)).and(az.lessThan(ext.z)), () => {
              const penX = ext.x.sub(ax), penY = ext.y.sub(ay), penZ = ext.z.sub(az);
              If(penX.lessThanEqual(penY).and(penX.lessThanEqual(penZ)), () => {
                lp.x.assign(select(lp.x.greaterThanEqual(0), ext.x, ext.x.negate()));
              }).ElseIf(penY.lessThanEqual(penZ), () => {
                lp.y.assign(select(lp.y.greaterThanEqual(0), ext.y, ext.y.negate()));
              }).Else(() => {
                lp.z.assign(select(lp.z.greaterThanEqual(0), ext.z, ext.z.negate()));
              });
              p.assign(boxMatrix.element(b).mul(vec4(lp, 1)).xyz);
            });
          });
        }

        p.y.assign(max(p.y, ground));
      });
      write.element(i).assign(vec4(p, p4.w));
    })().compute(count);

    // Tear & snap compute pass: strain auto-tearing + queued CPU tear/cut/snap/heal commands.
    const tearPass = Fn(() => {
      const i = int(instanceIndex);
      const r4 = rest.element(i);
      const pid = int(r4.w);
      const info = pieceData.element(pid);
      const offset = int(info.x), cols = int(info.y), rows = int(info.z);
      const local = i.sub(offset);
      const ix = local.mod(cols), iy = local.div(cols);
      const spacing = pieceData.element(pid.add(REST));
      const tearRatio = pieceData.element(pid.add(MISC)).w;
      const p = A.element(i).xyz;
      const l = links.element(i).toVar();
      const t4 = tether.element(i).toVar();
      const changed = float(0).toVar();

      // 1. Automatic strain tearing when tearThreshold > 0.
      If(info.w.greaterThan(0.5).and(tearRatio.greaterThan(0.01)), () => {
        If(l.x.greaterThan(0.5).and(ix.add(1).lessThan(cols)), () => {
          const q = A.element(i.add(1)).xyz;
          If(length(q.sub(p)).greaterThan(spacing.x.mul(tearRatio)), () => {
            l.x.assign(0);
            l.z.assign(0);
            changed.assign(1);
          });
        });
        If(l.y.greaterThan(0.5).and(iy.add(1).lessThan(rows)), () => {
          const q = A.element(i.add(cols)).xyz;
          If(length(q.sub(p)).greaterThan(spacing.y.mul(tearRatio)), () => {
            l.y.assign(0);
            l.z.assign(0);
            l.w.assign(0);
            changed.assign(1);
          });
        });
        // Release overstretched tethers when adjacent structural edges have torn.
        If(t4.w.greaterThanEqual(0), () => {
          const anchor = pieceMatrix.element(pid).mul(vec4(t4.xyz, 1)).xyz;
          If(length(p.sub(anchor)).greaterThan(t4.w.mul(tearRatio)), () => {
            t4.w.assign(-1);
            changed.assign(1);
          });
        });
      });

      // 2. Queued CPU tear / cut / snap / heal commands.
      for (let c = 0; c < MAX_TEAR_CMDS; c++) {
        If(tearCmdCount.greaterThan(c), () => {
          const ca = cmdA.element(c); // xyz = a, w = mode
          const cb = cmdB.element(c); // xyz = b, w = radius
          const cc = cmdC.element(c); // x = targetPid (-1 = all)
          const matches = cc.x.lessThan(0).or(abs(float(pid).sub(cc.x)).lessThan(0.5));
          If(matches, () => {
            // Mode 5: heal piece back to initial links & tethers.
            If(ca.w.greaterThan(4.5), () => {
              l.assign(initialLinks.element(i));
              t4.assign(initialTether.element(i));
              changed.assign(1);
            }).ElseIf(ca.w.greaterThan(3.5), () => {
              // Mode 4: snap column (ca.x = target col).
              If(abs(float(ix).sub(ca.x)).lessThan(0.5), () => {
                l.x.assign(0); l.z.assign(0);
                changed.assign(1);
              });
              If(abs(float(ix).sub(ca.x.add(1))).lessThan(0.5), () => {
                l.w.assign(0);
                changed.assign(1);
              });
              // Release tethers to the right of the vertical cut on flags/banners.
              If(float(ix).greaterThan(ca.x).and(rows.greaterThan(1)), () => {
                t4.w.assign(-1);
                changed.assign(1);
              });
            }).ElseIf(ca.w.greaterThan(2.5), () => {
              // Mode 3: grid cell tear (ca.x = ix0, ca.y = iy0, cb.w = radiusCells).
              const gx = float(ix).sub(ca.x), gy = float(iy).sub(ca.y);
              If(gx.mul(gx).add(gy.mul(gy)).lessThanEqual(cb.w.mul(cb.w)), () => {
                l.assign(vec4(0, 0, 0, 0));
                t4.w.assign(-1);
                changed.assign(1);
              });
            }).ElseIf(ca.w.greaterThan(1.5), () => {
              // Mode 2: 3D line segment cut from ca.xyz to cb.xyz with thickness cb.w.
              const ab = cb.xyz.sub(ca.xyz);
              const abLenSq = max(dot(ab, ab), 1e-8);
              const r2 = cb.w.mul(cb.w);
              If(l.x.greaterThan(0.5).and(ix.add(1).lessThan(cols)), () => {
                const mid = p.add(A.element(i.add(1)).xyz).mul(0.5);
                const tt = clamp(dot(mid.sub(ca.xyz), ab).div(abLenSq), 0, 1);
                const diff = mid.sub(ca.xyz.add(ab.mul(tt)));
                If(dot(diff, diff).lessThanEqual(r2), () => {
                  l.x.assign(0); l.z.assign(0); t4.w.assign(-1); changed.assign(1);
                });
              });
              If(l.y.greaterThan(0.5).and(iy.add(1).lessThan(rows)), () => {
                const mid = p.add(A.element(i.add(cols)).xyz).mul(0.5);
                const tt = clamp(dot(mid.sub(ca.xyz), ab).div(abLenSq), 0, 1);
                const diff = mid.sub(ca.xyz.add(ab.mul(tt)));
                If(dot(diff, diff).lessThanEqual(r2), () => {
                  l.y.assign(0); l.z.assign(0); l.w.assign(0); t4.w.assign(-1); changed.assign(1);
                });
              });
            }).ElseIf(ca.w.greaterThan(0.5), () => {
              // Mode 1: world-space sphere tear at ca.xyz with radius cb.w.
              const r2 = cb.w.mul(cb.w);
              If(l.x.greaterThan(0.5).and(ix.add(1).lessThan(cols)), () => {
                const mid = p.add(A.element(i.add(1)).xyz).mul(0.5).sub(ca.xyz);
                If(dot(mid, mid).lessThanEqual(r2), () => {
                  l.x.assign(0); l.z.assign(0); t4.w.assign(-1); changed.assign(1);
                });
              });
              If(l.y.greaterThan(0.5).and(iy.add(1).lessThan(rows)), () => {
                const mid = p.add(A.element(i.add(cols)).xyz).mul(0.5).sub(ca.xyz);
                If(dot(mid, mid).lessThanEqual(r2), () => {
                  l.y.assign(0); l.z.assign(0); l.w.assign(0); t4.w.assign(-1); changed.assign(1);
                });
              });
            });
          });
        });
      }

      If(changed.greaterThan(0.5), () => {
        links.element(i).assign(l);
        tether.element(i).assign(t4);
      });
    })().compute(count);

    const relaxBA = relax(B, A), relaxAB = relax(A, B);
    // An odd number of relaxations leaves the result in A, where the next integrate reads it.
    const iterations = Math.max(1, context.iterations) | 1;
    this.passes.push(snapshot);
    for (let s = 0; s < context.substeps; s++) {
      this.passes.push(integrate);
      for (let k = 0; k < iterations; k++) this.passes.push(k % 2 === 0 ? relaxBA : relaxAB);
      if (s === 0) this.passes.push(tearPass);
    }
  }

  particle(index: N): N { return this.A.element(int(index)).xyz; }
  previous(index: N): N { return this.frameStart.element(int(index)).xyz; }
  link(index: N): N { return this.links.element(int(index)); }

  read(index: number, out: THREE.Vector3): THREE.Vector3 {
    // No readback: pinned particles are exact (transform × rest), free ones report their start pose.
    const id = this.restData[index * 4 + 3];
    const piece = this.context.pieces[id];
    if (piece && this.initial[index * 4 + 3] === 0) return out.set(this.restData[index * 4], this.restData[index * 4 + 1], this.restData[index * 4 + 2]).applyMatrix4(piece.matrix);
    return out.set(this.initial[index * 4], this.initial[index * 4 + 1], this.initial[index * 4 + 2]);
  }

  kick(piece: PieceRecord, velocity: THREE.Vector3): void {
    const id = this.context.pieces.indexOf(piece);
    if (id < 0) return;
    const k = this.pieceData.array[KICK + id] as THREE.Vector4;
    k.x += velocity.x; k.y += velocity.y; k.z += velocity.z;
    this.kicked = true;
  }

  private queueCmd(cmd: TearCmd): void {
    if (this.pendingCmds.length >= MAX_TEAR_CMDS) this.pendingCmds.shift();
    this.pendingCmds.push(cmd);
  }

  tearSphere(piece: PieceRecord | null, center: THREE.Vector3, radius: number): number {
    const pid = piece ? this.context.pieces.indexOf(piece) : -1;
    if (piece && pid < 0) return 0;
    this.queueCmd({ mode: 1, pieceId: pid, a: center.clone(), b: new THREE.Vector3(), radius });
    // Estimate affected pieces for synchronous metadata bookkeeping.
    let hits = 0;
    const list = piece ? [piece] : this.context.pieces;
    for (const p of list) {
      _v.copy(p.boundsCenter).applyMatrix4(p.matrix);
      if (_v.distanceTo(center) <= p.boundsRadius + radius) {
        p.tornCount += Math.max(1, Math.round(radius / Math.max(p.spec.spacing[0], 0.05)));
        p.snapped = true;
        hits++;
      }
    }
    return hits;
  }

  cutSegment(piece: PieceRecord | null, from: THREE.Vector3, to: THREE.Vector3, thickness: number): number {
    const pid = piece ? this.context.pieces.indexOf(piece) : -1;
    if (piece && pid < 0) return 0;
    this.queueCmd({ mode: 2, pieceId: pid, a: from.clone(), b: to.clone(), radius: Math.max(thickness, 0.05) });
    let hits = 0;
    const list = piece ? [piece] : this.context.pieces;
    for (const p of list) {
      p.tornCount += Math.max(1, p.spec.rows);
      p.snapped = true;
      hits++;
    }
    return hits;
  }

  tearGrid(piece: PieceRecord, ix: number, iy: number, radiusCells = 1): number {
    const pid = this.context.pieces.indexOf(piece);
    if (pid < 0) return 0;
    this.queueCmd({ mode: 3, pieceId: pid, a: new THREE.Vector3(ix, iy, 0), b: new THREE.Vector3(), radius: Math.max(0.5, radiusCells) });
    const count = Math.max(1, Math.round(Math.PI * radiusCells * radiusCells));
    piece.tornCount += count;
    piece.snapped = true;
    return count;
  }

  snapPiece(piece: PieceRecord, index?: number): boolean {
    const pid = this.context.pieces.indexOf(piece);
    if (pid < 0) return false;
    const col = Math.max(0, Math.min(piece.spec.cols - 2, index ?? Math.floor((piece.spec.cols - 1) * 0.5)));
    this.queueCmd({ mode: 4, pieceId: pid, a: new THREE.Vector3(col, 0, 0), b: new THREE.Vector3(), radius: 1 });
    piece.tornCount += piece.spec.rows;
    piece.snapped = true;
    return true;
  }

  healPiece(piece: PieceRecord): void {
    const pid = this.context.pieces.indexOf(piece);
    if (pid < 0) return;
    this.queueCmd({ mode: 5, pieceId: pid, a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0 });
    piece.tornCount = 0;
    piece.snapped = false;
  }

  tornCount(piece: PieceRecord): number {
    return piece.tornCount;
  }

  step(dt: number): void {
    const { pieces, colliders, boxColliders, groundY, substeps } = this.context;
    if (dt <= 0) return;
    const frameDt = Math.min(dt, 1 / 30);
    this.uStep.value = frameDt / substeps;
    this.uGround.value = groundY;
    for (let id = 0; id < MAX_PIECES; id++) {
      const piece = pieces[id];
      const info = this.pieceData.array[id] as THREE.Vector4;
      if (!piece) { info.set(0, 1, 1, 0); continue; }
      const t = piece.tuning;
      const active = piece.enabled && piece.activeThisFrame ? 1 : 0;
      info.set(piece.offset, piece.spec.cols, piece.spec.rows, active);
      (this.pieceData.array[REST + id] as THREE.Vector4).set(piece.spec.spacing[0], piece.spec.spacing[1], t.stiffness, t.bend);
      (this.pieceData.array[AERO + id] as THREE.Vector4).set(t.dragNormal, t.dragTangent, t.gravity, t.damping);
      (this.pieceData.array[MISC + id] as THREE.Vector4).set(t.flutter, piece.spec.rows === 1 ? 1 : 0, t.inflate, t.tearThreshold);
      (this.pieceMatrix.array[id] as THREE.Matrix4).copy(piece.matrix);
      const k = this.pieceData.array[KICK + id] as THREE.Vector4;
      k.w = 1; if (this.kicked) k.multiplyScalar(1 / frameDt);
    }
    const n = Math.min(colliders.length, MAX_COLLIDERS);
    this.uColliders.value = n;
    for (let c = 0; c < n; c++) {
      (this.colliderData.array[c] as THREE.Vector4).set(colliders[c].center.x, colliders[c].center.y, colliders[c].center.z, colliders[c].radius);
    }
    const bn = Math.min(boxColliders.length, MAX_BOX_COLLIDERS);
    this.uBoxColliders.value = bn;
    for (let b = 0; b < bn; b++) {
      const box = boxColliders[b];
      const margin = box.margin ?? 0.02;
      _mat.compose(box.center, box.quaternion ?? _idQuat, _unitScale);
      _invMat.copy(_mat).invert();
      (this.boxMatrix.array[b] as THREE.Matrix4).copy(_mat);
      (this.boxInvMatrix.array[b] as THREE.Matrix4).copy(_invMat);
      (this.boxExtents.array[b] as THREE.Vector4).set(box.halfExtents.x + margin, box.halfExtents.y + margin, box.halfExtents.z + margin, 1);
    }
    const cn = Math.min(this.pendingCmds.length, MAX_TEAR_CMDS);
    this.uTearCmds.value = cn;
    for (let c = 0; c < cn; c++) {
      const cmd = this.pendingCmds[c];
      (this.cmdA.array[c] as THREE.Vector4).set(cmd.a.x, cmd.a.y, cmd.a.z, cmd.mode);
      (this.cmdB.array[c] as THREE.Vector4).set(cmd.b.x, cmd.b.y, cmd.b.z, cmd.radius);
      (this.cmdC.array[c] as THREE.Vector4).set(cmd.pieceId, 0, 0, 0);
    }
    this.renderer.compute(this.passes);
    if (cn > 0) { this.pendingCmds.length = 0; this.uTearCmds.value = 0; }
    if (this.kicked) { for (let id = 0; id < MAX_PIECES; id++) (this.pieceData.array[KICK + id] as THREE.Vector4).set(0, 0, 0, 0); this.kicked = false; }
  }

  dispose(): void {
    for (const pass of new Set(this.passes)) pass.dispose?.();
  }
}
