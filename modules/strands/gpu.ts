/**
 * GPU instanced Verlet strand solver (WebGPU compute, authored in TSL).
 *
 * Dispatches 1 GPU thread per strand (`compute(strandCount)`). Each thread integrates its
 * short chain of nodes (typically 4–8 segments) and immediately runs inextensible
 * root-to-tip distance constraint sweeps with zero cross-strand race conditions and zero
 * ping-pong buffers. Reacts directly to `WindField.node`, blasts, rotor/jet downwash, and
 * vehicle/collider sphere + oriented-box interactors.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import type { WindField } from '../../engine/wind';
import {
  layoutStrandFields,
  MAX_DOWNWASH_SOURCES,
  MAX_STRAND_BLASTS,
  MAX_STRAND_FIELDS,
  MAX_STRAND_INTERACTORS,
  type StrandBackend,
  type StrandContext,
} from './types';

const {
  Fn, If, Loop, int, float, vec3, vec4, uniform, uniformArray, instancedArray, instanceIndex,
  dot, length, max, sin, cos, abs, select, normalize,
} = TSL;

const _mat = new THREE.Matrix4();
const _invMat = new THREE.Matrix4();
const _unitScale = new THREE.Vector3(1, 1, 1);
const _idQuat = new THREE.Quaternion();
const _v = new THREE.Vector3();

// Packed uniform buffer layouts (2 uniformArray bindings total, keeping compute stage
// well within WebGPU's 12 uniform-buffer minimum / Apple hardware limit).
const OFF_FIELD_TUNE_A  = 0;                                         // vec4(stiffness, damping, gravity, windResponse)
const OFF_FIELD_TUNE_B  = OFF_FIELD_TUNE_A + MAX_STRAND_FIELDS;      // vec4(flutter, drag, downwashResp, vehicleResp)
const OFF_FIELD_MISC    = OFF_FIELD_TUNE_B + MAX_STRAND_FIELDS;      // vec4(isKelp, active, constraintIters, isHair)
const OFF_DW_POS_RAD    = OFF_FIELD_MISC + MAX_STRAND_FIELDS;        // vec4(x, y, z, radius)
const OFF_DW_STR_SWIRL  = OFF_DW_POS_RAD + MAX_DOWNWASH_SOURCES;     // vec4(strength, swirl, 0, 0)
const OFF_INT_POS_RAD   = OFF_DW_STR_SWIRL + MAX_DOWNWASH_SOURCES;   // vec4(x, y, z, radius)
const OFF_INT_VEL_STR   = OFF_INT_POS_RAD + MAX_STRAND_INTERACTORS;  // vec4(vx, vy, vz, strength)
const OFF_INT_EXT_KIND  = OFF_INT_VEL_STR + MAX_STRAND_INTERACTORS;  // vec4(hx, hy, hz, isBox)
const OFF_BLAST_POS_RAD = OFF_INT_EXT_KIND + MAX_STRAND_INTERACTORS; // vec4(x, y, z, radius)
const OFF_BLAST_STR     = OFF_BLAST_POS_RAD + MAX_STRAND_BLASTS;     // vec4(strength, 0, 0, 0)
const STRAND_VEC4_COUNT = OFF_BLAST_STR + MAX_STRAND_BLASTS;

const OFF_FIELD_MAT     = 0;                                         // mat4[MAX_STRAND_FIELDS]
const OFF_INT_INV_MAT   = OFF_FIELD_MAT + MAX_STRAND_FIELDS;         // mat4[MAX_STRAND_INTERACTORS]
const OFF_INT_MAT       = OFF_INT_INV_MAT + MAX_STRAND_INTERACTORS;  // mat4[MAX_STRAND_INTERACTORS]
const STRAND_MAT4_COUNT = OFF_INT_MAT + MAX_STRAND_INTERACTORS;

export class GpuStrandSolver implements StrandBackend {
  readonly kind = 'gpu' as const;
  readonly strandCount: number;
  readonly nodeCount: number;
  private pos: N;
  private prev: N;
  private frameStart: N;
  private roots: N;
  private dirs: N;
  private meta: N;
  private strandSpan: N;
  private uVecs: N;
  private uMats: N;
  private uStep = uniform(1 / 60);
  private uGround = uniform(-1e5);
  private uWaterLevel = uniform(0);
  private uWaterCurrent = uniform(new THREE.Vector3());
  private uDownwashCount = uniform(0);
  private uInteractorCount = uniform(0);
  private uBlastCount = uniform(0);
  private passes: N[] = [];
  private initialPos: Float32Array;

  constructor(private renderer: THREE.WebGPURenderer, private context: StrandContext, wind: WindField) {
    const layout = layoutStrandFields(context.fields);
    const sCount = this.strandCount = layout.strandCount;
    const nCount = this.nodeCount = layout.nodeCount;
    this.initialPos = layout.position;

    const pos = this.pos = instancedArray(layout.position, 'vec4');
    const prev = this.prev = instancedArray(layout.previous, 'vec4');
    const frameStart = this.frameStart = instancedArray(new Float32Array(layout.position), 'vec4');
    const roots = this.roots = instancedArray(layout.roots, 'vec4');
    const dirs = this.dirs = instancedArray(layout.dirs, 'vec4');
    const meta = this.meta = instancedArray(layout.meta, 'vec4');
    const strandSpan = this.strandSpan = instancedArray(layout.strandSpan, 'vec4');

    const uVecs = this.uVecs = uniformArray(Array.from({ length: STRAND_VEC4_COUNT }, () => new THREE.Vector4()), 'vec4');
    const uMats = this.uMats = uniformArray(Array.from({ length: STRAND_MAT4_COUNT }, () => new THREE.Matrix4()), 'mat4');
    const vecAt = (offset: number, idx: N) => (offset === 0 ? uVecs.element(idx) : uVecs.element(idx.add(int(offset))));
    const matAt = (offset: number, idx: N) => (offset === 0 ? uMats.element(idx) : uMats.element(idx.add(int(offset))));

    const h = this.uStep, ground = this.uGround, waterLevel = this.uWaterLevel, waterCurrent = this.uWaterCurrent;
    const dwCount = this.uDownwashCount, intCount = this.uInteractorCount, blastCount = this.uBlastCount;

    const snapshot = Fn(() => {
      frameStart.element(instanceIndex).assign(pos.element(instanceIndex));
    })().compute(nCount);

    // 1 GPU thread per strand: root update + Verlet integrate + downwash/vehicles + root-to-tip constraints.
    const solveStrands = Fn(() => {
      const s = int(instanceIndex);
      const span = strandSpan.element(s);
      const nBase = int(span.x);
      const nps = int(span.y);
      const segLen = span.z;
      const fid = int(span.w);
      const misc = vecAt(OFF_FIELD_MISC, fid);

      If(misc.y.greaterThan(0.5).and(nps.greaterThan(int(1))), () => {
        const tuneA = vecAt(OFF_FIELD_TUNE_A, fid);
        const tuneB = vecAt(OFF_FIELD_TUNE_B, fid);
        const isKelp = misc.x.greaterThan(0.5);
        const fMat = matAt(OFF_FIELD_MAT, fid);
        const rLocal = roots.element(s).xyz;
        const rootWorld = fMat.mul(vec4(rLocal, 1)).xyz.toVar();
        const restDir = normalize(fMat.mul(vec4(dirs.element(s).xyz, 0)).xyz).toVar();
        const m4 = meta.element(s);
        const seed = m4.x, stiffScale = m4.y, arch = m4.z;
        const segsF = max(float(nps.sub(1)), 1);
        const totalLen = segLen.mul(segsF);
        const keep = max(float(1).sub(tuneA.y.mul(h)), 0);

        // Anchor root node 0.
        const oldRoot = pos.element(nBase).xyz.toVar();
        const rootStep = vec3(0).toVar();
        If(misc.w.greaterThan(0.5), () => {
          rootStep.assign(rootWorld.sub(frameStart.element(nBase).xyz).div(context.substeps));
          rootWorld.assign(oldRoot.add(rootStep));
        });
        prev.element(nBase).assign(vec4(oldRoot, float(s)));
        pos.element(nBase).assign(vec4(rootWorld, segLen));

        // Integrate nodes 1..nps-1.
        Loop({ start: int(1), end: nps, type: 'int', condition: '<', name: 'k' }, ({ k }: N) => {
          const idx = nBase.add(k);
          const p = pos.element(idx).xyz.toVar();
          const pr = prev.element(idx).xyz.toVar();
          const vel = p.sub(pr).div(h).toVar();
          const t = float(k).div(segsF);

          // Rest-pose spring recovery + gravity / kelp buoyancy.
          const target = rootWorld.add(restDir.mul(t.mul(totalLen))).sub(vec3(0, arch.mul(t).mul(t).mul(totalLen).mul(0.25), 0));
          const kStiff = tuneA.x.mul(stiffScale).mul(float(1.25).sub(t.mul(0.65)));
          const acc = target.sub(p).mul(kStiff).add(vec3(0, tuneA.z.mul(-9.81), 0)).toVar();

          // Wind / flutter (air) or underwater swell surge (kelp).
          If(isKelp, () => {
            const phase = p.x.mul(0.28).add(p.z.mul(0.21)).add(frame.time.mul(1.45)).add(seed.mul(6.2831));
            const surge = vec3(
              waterCurrent.x.add(sin(phase).mul(1.8)).add(cos(phase.mul(1.7).add(p.y.mul(0.8))).mul(0.7).mul(tuneB.x)),
              sin(phase.mul(1.15)).mul(0.45),
              waterCurrent.z.add(cos(phase.mul(0.87).add(seed.mul(3.1))).mul(1.4)),
            );
            acc.addAssign(surge.sub(vel).mul(tuneB.y.mul(tuneA.w)));
          }).Else(() => {
            const air = wind.node(p).toVar();
            const relativeAir = air.xz.sub(rootStep.xz.div(h)).toVar();
            const spd = length(relativeAir);
            If(spd.greaterThan(0.05).and(tuneB.x.greaterThan(0)), () => {
              const along = dot(p.xz, relativeAir).div(spd);
              const wave = sin(along.mul(1.45).sub(frame.time.mul(float(2.6).add(spd.mul(0.55)))).add(seed.mul(6.2831))).mul(0.55)
                .add(sin(along.mul(3.7).sub(frame.time.mul(float(5.2).add(spd.mul(0.9)))).sub(seed.mul(11.3))).mul(0.3))
                .mul(spd).mul(0.35).mul(tuneB.x);
              const nx = relativeAir.x.div(spd), nz = relativeAir.y.div(spd);
              air.x.addAssign(nz.negate().mul(wave).add(nx.mul(wave).mul(0.45)));
              air.z.addAssign(nx.mul(wave).add(nz.mul(wave).mul(0.45)));
              air.y.subAssign(abs(wave).mul(0.2));
            });
            const dragK = tuneB.y.mul(tuneA.w).mul(float(0.35).add(t.mul(0.85)));
            acc.addAssign(air.sub(vel).mul(dragK));
          });

          // Explicit strand blasts (explosions / shockwaves / depth charges).
          Loop({ start: int(0), end: int(MAX_STRAND_BLASTS), type: 'int', condition: '<', name: 'bi' }, ({ bi }: N) => {
            If(bi.lessThan(int(blastCount)), () => {
              const bpr = vecAt(OFF_BLAST_POS_RAD, bi);
              const delta = p.sub(bpr.xyz);
              const dist = length(delta).add(1e-3);
              If(dist.lessThan(bpr.w), () => {
                const fall = float(1).sub(dist.div(bpr.w));
                const push = vecAt(OFF_BLAST_STR, bi).x.mul(fall).mul(fall).mul(tuneA.w).mul(4.5);
                const dirB = delta.div(dist);
                acc.x.addAssign(dirB.x.mul(push));
                acc.y.addAssign(dirB.y.mul(push).mul(0.4).sub(push.mul(0.25)));
                acc.z.addAssign(dirB.z.mul(push));
              });
            });
          });

          // Rotor / jet downwash sources (radial outward + vortex swirl + downward flatten).
          If(tuneB.z.greaterThan(0), () => {
            Loop({ start: int(0), end: int(MAX_DOWNWASH_SOURCES), type: 'int', condition: '<', name: 'di' }, ({ di }: N) => {
              If(di.lessThan(int(dwCount)), () => {
                const dpr = vecAt(OFF_DW_POS_RAD, di);
                const dss = vecAt(OFF_DW_STR_SWIRL, di);
                const d = p.sub(dpr.xyz);
                const horiz = length(d.xz);
                If(horiz.lessThan(dpr.w).and(d.y.lessThan(4)).and(d.y.greaterThan(dpr.w.mul(-2.5))), () => {
                  const radFall = float(1).sub(horiz.div(dpr.w));
                  const vertFall = select(d.y.lessThanEqual(0), max(float(0), float(1).add(d.y.div(dpr.w.mul(2.5)))), max(float(0), float(1).sub(d.y.div(4))));
                  const env = radFall.mul(radFall).mul(vertFall).mul(dss.x).mul(tuneB.z).mul(3.8);
                  const rxDir = select(horiz.greaterThan(1e-3), d.x.div(horiz), cos(seed.mul(6.2831)));
                  const rzDir = select(horiz.greaterThan(1e-3), d.z.div(horiz), sin(seed.mul(6.2831)));
                  const swirl = dss.y;
                  acc.x.addAssign(rxDir.sub(rzDir.mul(swirl)).mul(env));
                  acc.z.addAssign(rzDir.add(rxDir.mul(swirl)).mul(env));
                  acc.y.subAssign(env.mul(float(0.55).add(radFall.mul(0.45))));
                });
              });
            });
          });

          const nextPr = p.toVar();
          const nextP = p.add(vel.mul(h).mul(keep)).add(rootStep.mul(keep.oneMinus())).add(acc.mul(h).mul(h)).toVar();

          // Vehicle / collider interactors (sphere & oriented box pushout + wake).
          If(tuneB.w.greaterThan(0), () => {
            Loop({ start: int(0), end: int(MAX_STRAND_INTERACTORS), type: 'int', condition: '<', name: 'ii' }, ({ ii }: N) => {
              If(ii.lessThan(int(intCount)), () => {
                const ext = vecAt(OFF_INT_EXT_KIND, ii);
                const ivs = vecAt(OFF_INT_VEL_STR, ii);
                const str = ivs.w.mul(tuneB.w);
                If(ext.w.greaterThan(0.5), () => {
                  // Oriented box vehicle chassis.
                  const lp = matAt(OFF_INT_INV_MAT, ii).mul(vec4(nextP, 1)).xyz.toVar();
                  const ax = abs(lp.x), ay = abs(lp.y), az = abs(lp.z);
                  If(ax.lessThan(ext.x).and(ay.lessThan(ext.y)).and(az.lessThan(ext.z)), () => {
                    const penX = ext.x.sub(ax), penY = ext.y.sub(ay), penZ = ext.z.sub(az);
                    If(penX.lessThanEqual(penY).and(penX.lessThanEqual(penZ)), () => {
                      lp.x.assign(select(lp.x.greaterThanEqual(0), ext.x, ext.x.negate()));
                    }).ElseIf(penZ.lessThanEqual(penY), () => {
                      lp.z.assign(select(lp.z.greaterThanEqual(0), ext.z, ext.z.negate()));
                    }).Else(() => {
                      lp.y.assign(select(lp.y.greaterThanEqual(0), ext.y, ext.y.negate()));
                    });
                    nextP.assign(matAt(OFF_INT_MAT, ii).mul(vec4(lp, 1)).xyz);
                    nextPr.subAssign(vec3(ivs.x.mul(0.45), ivs.y.mul(0.25), ivs.z.mul(0.45)).mul(str).mul(h));
                  });
                }).Else(() => {
                  // Sphere interactor.
                  const ipr = vecAt(OFF_INT_POS_RAD, ii);
                  const d = nextP.sub(ipr.xyz);
                  const dist = length(d);
                  If(dist.lessThan(ipr.w), () => {
                    const nrm = select(dist.greaterThan(1e-5), d.div(dist), vec3(0, 1, 0));
                    nextP.assign(ipr.xyz.add(nrm.mul(ipr.w)));
                    nextPr.subAssign(vec3(ivs.x.mul(0.4), ivs.y.mul(0.2), ivs.z.mul(0.4)).mul(str).mul(h));
                  });
                });
              });
            });
          });

          const floorY = select(misc.w.greaterThan(0.5), ground, max(ground, select(isKelp, rootWorld.y.sub(0.1), rootWorld.y.add(0.01))));
          nextP.y.assign(max(nextP.y, floorY));
          If(isKelp, () => {
            nextP.y.assign(nextP.y.min(waterLevel.sub(0.05)));
          });

          prev.element(idx).assign(vec4(nextPr, float(s)));
          pos.element(idx).assign(vec4(nextP, segLen));
        });

        // Root-to-tip inextensible distance constraint sweeps.
        const iters = int(max(misc.z, 1));
        Loop({ start: int(0), end: iters, type: 'int', condition: '<', name: 'it' }, () => {
          Loop({ start: int(1), end: nps, type: 'int', condition: '<', name: 'kc' }, ({ kc }: N) => {
            const ia = nBase.add(kc.sub(int(1)));
            const ib = nBase.add(kc);
            const pa = pos.element(ia).xyz.toVar();
            const pb = pos.element(ib).xyz.toVar();
            const delta = pb.sub(pa);
            const len = max(length(delta), 1e-6);
            const diff = delta.mul(len.sub(segLen).div(len));
            If(kc.equal(int(1)), () => {
              pos.element(ib).assign(vec4(pb.sub(diff), segLen));
            }).Else(() => {
              pos.element(ia).assign(vec4(pa.add(diff.mul(0.2)), segLen));
              pos.element(ib).assign(vec4(pb.sub(diff.mul(0.8)), segLen));
            });
          });
        });
      });
    })().compute(sCount);

    this.passes.push(snapshot);
    for (let sub = 0; sub < context.substeps; sub++) this.passes.push(solveStrands);
  }

  node(index: N): N { return this.pos.element(int(index)).xyz; }
  previousNode(index: N): N { return this.frameStart.element(int(index)).xyz; }
  strandMeta(strandIndex: N): N { return this.meta.element(int(strandIndex)); }
  strandDir(strandIndex: N): N { return this.dirs.element(int(strandIndex)); }

  readNode(nodeIndex: number, out: THREE.Vector3): THREE.Vector3 {
    const i = nodeIndex * 4;
    return out.set(this.initialPos[i], this.initialPos[i + 1], this.initialPos[i + 2]);
  }

  step(dt: number): void {
    const { fields, downwash, interactors, blasts, waterCurrent, waterLevel, groundY, substeps } = this.context;
    if (dt <= 0) return;
    const frameDt = Math.min(dt, 1 / 30);
    this.uStep.value = frameDt / substeps;
    this.uGround.value = groundY;
    this.uWaterLevel.value = waterLevel;
    (this.uWaterCurrent.value as THREE.Vector3).copy(waterCurrent);

    const vecs = this.uVecs.array as THREE.Vector4[];
    const mats = this.uMats.array as THREE.Matrix4[];

    for (let id = 0; id < MAX_STRAND_FIELDS; id++) {
      const f = fields[id];
      const misc = vecs[OFF_FIELD_MISC + id];
      if (!f) { misc.set(0, 0, 1, 0); continue; }
      const t = f.tuning;
      mats[OFF_FIELD_MAT + id].copy(f.matrix);
      vecs[OFF_FIELD_TUNE_A + id].set(t.stiffness, t.damping, t.gravity, t.windResponse);
      vecs[OFF_FIELD_TUNE_B + id].set(t.flutter, t.drag, t.downwashResponse, t.vehicleResponse);
      misc.set(f.spec.kind === 'kelp' ? 1 : 0, f.enabled && f.activeThisFrame ? 1 : 0, t.constraintIterations, f.spec.kind === 'hair' ? 1 : 0);
    }

    const dn = Math.min(downwash.length, MAX_DOWNWASH_SOURCES);
    this.uDownwashCount.value = dn;
    for (let i = 0; i < dn; i++) {
      const d = downwash[i];
      vecs[OFF_DW_POS_RAD + i].set(d.position.x, d.position.y, d.position.z, Math.max(d.radius, 0.25));
      vecs[OFF_DW_STR_SWIRL + i].set(d.strength, d.swirl ?? 0.35, 0, 0);
    }

    const inN = Math.min(interactors.length, MAX_STRAND_INTERACTORS);
    this.uInteractorCount.value = inN;
    for (let i = 0; i < inN; i++) {
      const inter = interactors[i];
      vecs[OFF_INT_POS_RAD + i].set(inter.position.x, inter.position.y, inter.position.z, inter.radius);
      vecs[OFF_INT_VEL_STR + i].set(inter.velocity?.x ?? 0, inter.velocity?.y ?? 0, inter.velocity?.z ?? 0, inter.strength ?? 1);
      if (inter.halfExtents) {
        vecs[OFF_INT_EXT_KIND + i].set(inter.halfExtents.x + 0.05, inter.halfExtents.y + 0.05, inter.halfExtents.z + 0.05, 1);
        _mat.compose(inter.position, inter.quaternion ?? _idQuat, _unitScale);
        _invMat.copy(_mat).invert();
        mats[OFF_INT_MAT + i].copy(_mat);
        mats[OFF_INT_INV_MAT + i].copy(_invMat);
      } else {
        vecs[OFF_INT_EXT_KIND + i].set(0, 0, 0, 0);
      }
    }

    const bn = Math.min(blasts.length, MAX_STRAND_BLASTS);
    this.uBlastCount.value = bn;
    for (let i = 0; i < bn; i++) {
      const b = blasts[i];
      const prog = b.age / b.duration;
      const rad = b.radius * (0.3 + 0.7 * prog);
      vecs[OFF_BLAST_POS_RAD + i].set(b.position.x, b.position.y, b.position.z, Math.max(rad, 0.2));
      vecs[OFF_BLAST_STR + i].set(b.strength * (1 - prog) ** 1.5, 0, 0, 0);
    }

    this.renderer.compute(this.passes);
  }

  dispose(): void {
    for (const pass of new Set(this.passes)) pass.dispose?.();
  }
}

export { _v };
