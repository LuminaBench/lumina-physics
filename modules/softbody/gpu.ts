/**
 * GPU spring + ideal-gas pressure inflatable soft-body solver (WebGPU compute, TSL).
 *
 * All soft bodies live in shared storage buffers and run in one compute sequence per frame:
 *   snapshot · [ bodyVolume · integrate · relax × iterations ] × substeps · computeNormals
 *
 * No float atomics required: `bodyVolume` runs one thread per body (≤ 32 threads) to compute
 * exact signed volume V = 1/6 Σ (p_a − c)·((p_b − c) × (p_c − c)) and ideal-gas pressure
 * P = k · V_target / V, which `integrate` applies along each vertex's exact area-weighted
 * outward normal. Supports water buoyancy (via per-body sampled ocean plane & flow), wind +
 * blasts, sphere & oriented box colliders (including dynamic Rapier bodies), and localized
 * impact impulses.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type { WindField } from '../../engine/wind';
import {
  layoutSoftBodies,
  MAX_SB_BOXES,
  MAX_SB_IMPACTS,
  MAX_SB_SPHERES,
  MAX_SOFT_BODIES,
  MAX_VALENCE,
  MAX_VERTEX_TRIS,
  WATER_DENSITY,
  type SoftBodyBackend,
  type SoftBodyContext,
  type SoftBodyRecord,
} from './types';

const { Fn, If, Loop, int, float, vec3, vec4, uniform, uniformArray, instancedArray, instanceIndex, cross, dot, length, max, min, clamp, abs, select } = TSL;

const JACOBI_SCALE = 1 / 4.2;

const _mat = new THREE.Matrix4();
const _invMat = new THREE.Matrix4();
const _unitScale = new THREE.Vector3(1, 1, 1);
const _idQuat = new THREE.Quaternion();
const _flow = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

interface QueuedImpact {
  point: THREE.Vector3;
  velocity: THREE.Vector3;
  radius: number;
  bodyId: number;
}

// Packed uniform buffer layouts (2 uniformArray bindings total, keeping every compute
// stage well within WebGPU's 12 uniform-buffer minimum / Apple hardware limit).
const OFF_BODY_INFO   = 0;                                 // vec4(vOffset, vCount, triOffset, triCount)
const OFF_BODY_TUNE_A = OFF_BODY_INFO + MAX_SOFT_BODIES;   // vec4(stiffness, strutWeight, pressureScale, targetVol)
const OFF_BODY_TUNE_B = OFF_BODY_TUNE_A + MAX_SOFT_BODIES; // vec4(gravity, damping, airDrag, active)
const OFF_BODY_TUNE_C = OFF_BODY_TUNE_B + MAX_SOFT_BODIES; // vec4(restitution, friction, displacedPerVert, draft)
const OFF_BODY_WATER  = OFF_BODY_TUNE_C + MAX_SOFT_BODIES; // vec4(nx, surfaceY, nz, waterDrag)
const OFF_BODY_FLOW   = OFF_BODY_WATER + MAX_SOFT_BODIES;  // vec4(flowX, flowY, flowZ, hasWater)
const OFF_BODY_KICK   = OFF_BODY_FLOW + MAX_SOFT_BODIES;   // vec4(kx, ky, kz, 0)
const OFF_SPHERE_POS  = OFF_BODY_KICK + MAX_SOFT_BODIES;   // vec4(cx, cy, cz, radius)
const OFF_SPHERE_VEL  = OFF_SPHERE_POS + MAX_SB_SPHERES;   // vec4(vx, vy, vz, 0)
const OFF_BOX_EXT     = OFF_SPHERE_VEL + MAX_SB_SPHERES;   // vec4(hx, hy, hz, 1)
const OFF_BOX_VEL     = OFF_BOX_EXT + MAX_SB_BOXES;        // vec4(vx, vy, vz, 0)
const OFF_IMP_POS     = OFF_BOX_VEL + MAX_SB_BOXES;        // vec4(x, y, z, radius)
const OFF_IMP_VEL     = OFF_IMP_POS + MAX_SB_IMPACTS;      // vec4(vx, vy, vz, bodyId)
const SB_VEC4_COUNT   = OFF_IMP_VEL + MAX_SB_IMPACTS;

const OFF_BOX_INV_MAT = 0;                                 // mat4[MAX_SB_BOXES]
const OFF_BOX_MAT     = OFF_BOX_INV_MAT + MAX_SB_BOXES;    // mat4[MAX_SB_BOXES]
const SB_MAT4_COUNT   = OFF_BOX_MAT + MAX_SB_BOXES;

export class GpuSoftBodySolver implements SoftBodyBackend {
  readonly kind = 'gpu' as const;
  readonly vertexCount: number;
  private A: N; private B: N; private prev: N; private frameStart: N;
  private normals: N;
  private springs: N;
  private vertexTris: N;
  private triangles: N;
  private bodyState: N; // per-body vec4(cx, cy, cz, gasPressure)
  private uVecs: N;
  private uMats: N;
  private uStep = uniform(1 / 120);
  private uGround = uniform(-1e5);
  private uSpheres = uniform(0);
  private uBoxes = uniform(0);
  private uImpacts = uniform(0);
  private passes: N[] = [];
  private restData: Float32Array;
  private kicked = false;
  private impacts: QueuedImpact[] = [];
  private splashed: Uint8Array;
  private impactCooldown: Float32Array;

  constructor(private renderer: THREE.WebGPURenderer, private context: SoftBodyContext, private wind: WindField) {
    const layout = layoutSoftBodies(context.bodies);
    const vCount = this.vertexCount = layout.vertexCount;
    const bodyCount = Math.max(context.bodies.length, 1);
    this.restData = layout.rest;
    this.splashed = new Uint8Array(bodyCount);
    this.impactCooldown = new Float32Array(bodyCount);

    const A = this.A = instancedArray(layout.position, 'vec4');
    const B = this.B = instancedArray(new Float32Array(layout.position), 'vec4');
    const prev = this.prev = instancedArray(layout.previous, 'vec4');
    const frameStart = this.frameStart = instancedArray(new Float32Array(layout.position), 'vec4');
    const normals = this.normals = instancedArray(layout.normals, 'vec4');
    const springs = this.springs = instancedArray(layout.springs, 'vec4');
    const vertexTris = this.vertexTris = instancedArray(layout.vertexTris, 'vec4');
    const triangles = this.triangles = instancedArray(layout.triangles, 'vec4');
    const bodyState = this.bodyState = instancedArray(MAX_SOFT_BODIES, 'vec4');

    const uVecs = this.uVecs = uniformArray(Array.from({ length: SB_VEC4_COUNT }, () => new THREE.Vector4()), 'vec4');
    const uMats = this.uMats = uniformArray(Array.from({ length: SB_MAT4_COUNT }, () => new THREE.Matrix4()), 'mat4');
    const vecAt = (offset: number, idx: number | N) =>
      typeof idx === 'number'
        ? uVecs.element(offset + idx)
        : (offset === 0 ? uVecs.element(idx) : uVecs.element(idx.add(int(offset))));
    const matAt = (offset: number, idx: number | N) =>
      typeof idx === 'number'
        ? uMats.element(offset + idx)
        : (offset === 0 ? uMats.element(idx) : uMats.element(idx.add(int(offset))));
    const h = this.uStep, ground = this.uGround, sphereCount = this.uSpheres, boxCount = this.uBoxes, impCount = this.uImpacts;

    const snapshot = Fn(() => {
      frameStart.element(instanceIndex).assign(A.element(instanceIndex));
    })().compute(vCount);

    // 1 thread per body: exact centroid, signed volume V, and ideal-gas pressure P.
    const bodyVolume = Fn(() => {
      const bid = int(instanceIndex);
      const info = vecAt(OFF_BODY_INFO, bid);
      const vStart = int(info.x), vLen = int(info.y);
      const tStart = int(info.z), tLen = int(info.w);
      const tuneA = vecAt(OFF_BODY_TUNE_A, bid);
      const tuneB = vecAt(OFF_BODY_TUNE_B, bid);
      const center = vec3(0).toVar();
      const vol = float(0).toVar();

      If(tuneB.w.greaterThan(0.5).and(vLen.greaterThan(int(0))), () => {
        Loop({ start: int(0), end: vLen, type: 'int', condition: '<', name: 'vi' }, ({ vi }: N) => {
          center.addAssign(A.element(vStart.add(vi)).xyz);
        });
        center.divAssign(max(float(vLen), 1));

        Loop({ start: int(0), end: tLen, type: 'int', condition: '<', name: 'ti' }, ({ ti }: N) => {
          const tri = triangles.element(tStart.add(ti));
          const pa = A.element(int(tri.x)).xyz.sub(center);
          const pb = A.element(int(tri.y)).xyz.sub(center);
          const pc = A.element(int(tri.z)).xyz.sub(center);
          vol.addAssign(dot(pa, cross(pb, pc)).div(6));
        });
      });

      const targetVol = max(tuneA.w, 1e-4);
      const curVol = max(vol, targetVol.mul(0.15));
      const gasP = select(tuneA.z.greaterThan(0), tuneA.z.mul(clamp(targetVol.div(curVol), 0.25, 3.8)), float(0));
      bodyState.element(bid).assign(vec4(center, gasP));
    })().compute(bodyCount);

    // Compute smooth area-weighted vertex normals (used for pressure & rendering).
    const computeNormals = Fn(() => {
      const i = int(instanceIndex);
      const p = A.element(i).xyz;
      const accum = vec3(0).toVar();
      const base = i.mul(MAX_VERTEX_TRIS);
      Loop({ start: int(0), end: int(MAX_VERTEX_TRIS), type: 'int', condition: '<', name: 'kt' }, ({ kt }: N) => {
        const tri = vertexTris.element(base.add(kt));
        If(tri.z.greaterThan(0.5), () => {
          const e1 = A.element(int(tri.x)).xyz.sub(p);
          const e2 = A.element(int(tri.y)).xyz.sub(p);
          accum.addAssign(cross(e1, e2).div(6));
        });
      });
      const area = length(accum);
      const nrm = select(area.greaterThan(1e-7), accum.div(area), vec3(0, 1, 0));
      normals.element(i).assign(vec4(nrm, area));
    })().compute(vCount);

    // Verlet integration: gravity + ideal-gas pressure + wind/blasts + water buoyancy + impacts.
    const integrate = Fn(() => {
      const i = int(instanceIndex);
      const p4 = A.element(i);
      const p = p4.xyz.toVar();
      const invM = p4.w;
      const pr4 = prev.element(i);
      const bid = int(pr4.w);
      const tuneB = vecAt(OFF_BODY_TUNE_B, bid);
      const tuneC = vecAt(OFF_BODY_TUNE_C, bid);
      const out = vec3(p).toVar();

      If(invM.greaterThan(0).and(tuneB.w.greaterThan(0.5)), () => {
        const vel = p.sub(pr4.xyz).div(h).toVar();
        const n4 = normals.element(i);
        const gasP = bodyState.element(bid).w;

        // Pressure force along outward normal * dual area, minus gravity.
        const force = n4.xyz.mul(n4.w).mul(gasP).add(vec3(0, tuneB.x.mul(-9.81).div(invM), 0)).toVar();

        // Wind + blast drag.
        If(tuneB.z.greaterThan(0), () => {
          const air = wind.node(p);
          force.addAssign(air.sub(vel).mul(tuneB.z.div(invM)));
        });

        // Water buoyancy + hydrodynamic drag using body's sampled local ocean plane & flow.
        const wFlow = vecAt(OFF_BODY_FLOW, bid);
        If(wFlow.w.greaterThan(0.5), () => {
          const wPlane = vecAt(OFF_BODY_WATER, bid); // (nx, surfaceY, nz, waterDrag)
          const bCenter = bodyState.element(bid).xyz;
          const eta = wPlane.y.add(wPlane.x.mul(p.x.sub(bCenter.x))).add(wPlane.z.mul(p.z.sub(bCenter.z)));
          const depth = eta.sub(p.y);
          const sub = clamp(depth.div(max(tuneC.w, 0.08)).add(0.25), 0, 1);
          If(sub.greaterThan(0), () => {
            force.y.addAssign(float(WATER_DENSITY * 9.81).mul(tuneC.z).mul(sub));
            const relW = vel.sub(wFlow.xyz);
            const spd = length(relW);
            const wDrag = wPlane.w.add(spd.mul(0.65)).mul(sub).div(invM);
            force.x.subAssign(relW.x.mul(wDrag));
            force.y.subAssign(relW.y.mul(wDrag).mul(1.35));
            force.z.subAssign(relW.z.mul(wDrag));
          });
        });

        // Uniform body kick impulse (distributed as acceleration over frame).
        force.addAssign(vecAt(OFF_BODY_KICK, bid).xyz.div(invM));

        // Localized impact impulses (e.g. from Rapier collisions / projectiles).
        for (let k = 0; k < MAX_SB_IMPACTS; k++) {
          If(impCount.greaterThan(k), () => {
            const ip = vecAt(OFF_IMP_POS, k);
            const iv = vecAt(OFF_IMP_VEL, k);
            const targetMatch = iv.w.lessThan(0).or(abs(float(bid).sub(iv.w)).lessThan(0.5));
            If(targetMatch, () => {
              const d = length(p.sub(ip.xyz));
              If(d.lessThan(ip.w), () => {
                const fall = float(1).sub(d.div(max(ip.w, 1e-4)));
                vel.addAssign(iv.xyz.mul(fall).mul(fall));
              });
            });
          });
        }

        const keep = max(float(1).sub(tuneB.y.mul(h)), 0);
        out.assign(p.add(vel.mul(h).mul(keep)).add(force.mul(invM).mul(h).mul(h)));
      });

      prev.element(i).assign(vec4(p, pr4.w));
      B.element(i).assign(vec4(out, invM));
    })().compute(vCount);

    // Jacobi spring constraints + ground, sphere, and oriented box collider pushout.
    const relax = (read: N, write: N): N => Fn(() => {
      const i = int(instanceIndex);
      const p4 = read.element(i);
      const p = p4.xyz.toVar();
      const invM = p4.w;
      const pr4 = prev.element(i);
      const bid = int(pr4.w);
      const tuneA = vecAt(OFF_BODY_TUNE_A, bid);
      const tuneB = vecAt(OFF_BODY_TUNE_B, bid);
      const tuneC = vecAt(OFF_BODY_TUNE_C, bid);

      If(invM.greaterThan(0).and(tuneB.w.greaterThan(0.5)), () => {
        const corr = vec3(0).toVar();
        const base = i.mul(MAX_VALENCE);
        Loop({ start: int(0), end: int(MAX_VALENCE), type: 'int', condition: '<', name: 'ks' }, ({ ks }: N) => {
          const sp = springs.element(base.add(ks));
          If(sp.w.greaterThan(0.5), () => {
            const q4 = read.element(int(sp.x));
            const delta = q4.xyz.sub(p);
            const len = max(length(delta), 1e-6);
            const weight = select(sp.z.lessThan(0.5), tuneA.x, tuneA.x.mul(tuneA.y));
            const wsum = max(invM.add(q4.w), 1e-6);
            const share = invM.div(wsum);
            corr.addAssign(delta.mul(len.sub(sp.y).div(len)).mul(weight).mul(share));
          });
        });
        p.addAssign(corr.mul(JACOBI_SCALE));

        const prPos = pr4.xyz.toVar();
        const restCoeff = tuneC.x;
        const fricCoeff = tuneC.y;

        // Ground plane bounce + friction.
        If(p.y.lessThan(ground), () => {
          const vel = p.sub(prPos).div(h);
          p.y.assign(ground);
          If(vel.y.lessThan(0), () => {
            const nv = vec3(vel.x.mul(float(1).sub(fricCoeff)), vel.y.negate().mul(restCoeff), vel.z.mul(float(1).sub(fricCoeff)));
            prPos.assign(p.sub(nv.mul(h)));
          });
        });

        // Sphere colliders.
        for (let c = 0; c < MAX_SB_SPHERES; c++) {
          If(sphereCount.greaterThan(c), () => {
            const sp = vecAt(OFF_SPHERE_POS, c);
            const d = p.sub(sp.xyz);
            const len = length(d);
            If(len.lessThan(sp.w), () => {
              const nrm = select(len.greaterThan(1e-6), d.div(len), vec3(0, 1, 0));
              const vel = p.sub(prPos).div(h);
              const cvel = vecAt(OFF_SPHERE_VEL, c).xyz;
              const rel = vel.sub(cvel);
              const vn = dot(rel, nrm);
              p.assign(sp.xyz.add(nrm.mul(sp.w)));
              If(vn.lessThan(0), () => {
                const tang = rel.sub(nrm.mul(vn));
                const nv = cvel.add(tang.mul(float(1).sub(fricCoeff))).sub(nrm.mul(vn.mul(restCoeff)));
                prPos.assign(p.sub(nv.mul(h)));
              });
            });
          });
        }

        // Oriented / axis-aligned box colliders.
        for (let b = 0; b < MAX_SB_BOXES; b++) {
          If(boxCount.greaterThan(b), () => {
            const ext = vecAt(OFF_BOX_EXT, b);
            const lp = matAt(OFF_BOX_INV_MAT, b).mul(vec4(p, 1)).xyz.toVar();
            const ax = abs(lp.x), ay = abs(lp.y), az = abs(lp.z);
            If(ax.lessThan(ext.x).and(ay.lessThan(ext.y)).and(az.lessThan(ext.z)), () => {
              const penX = ext.x.sub(ax), penY = ext.y.sub(ay), penZ = ext.z.sub(az);
              const ln = vec3(0).toVar();
              If(penX.lessThanEqual(penY).and(penX.lessThanEqual(penZ)), () => {
                const sgn = select(lp.x.greaterThanEqual(0), float(1), float(-1));
                lp.x.assign(sgn.mul(ext.x));
                ln.x.assign(sgn);
              }).ElseIf(penY.lessThanEqual(penZ), () => {
                const sgn = select(lp.y.greaterThanEqual(0), float(1), float(-1));
                lp.y.assign(sgn.mul(ext.y));
                ln.y.assign(sgn);
              }).Else(() => {
                const sgn = select(lp.z.greaterThanEqual(0), float(1), float(-1));
                lp.z.assign(sgn.mul(ext.z));
                ln.z.assign(sgn);
              });
              const wn = matAt(OFF_BOX_MAT, b).mul(vec4(ln, 0)).xyz;
              const vel = p.sub(prPos).div(h);
              const bvel = vecAt(OFF_BOX_VEL, b).xyz;
              const rel = vel.sub(bvel);
              const vn = dot(rel, wn);
              p.assign(matAt(OFF_BOX_MAT, b).mul(vec4(lp, 1)).xyz);
              If(vn.lessThan(0), () => {
                const tang = rel.sub(wn.mul(vn));
                const nv = bvel.add(tang.mul(float(1).sub(fricCoeff))).sub(wn.mul(vn.mul(restCoeff)));
                prPos.assign(p.sub(nv.mul(h)));
              });
            });
          });
        }

        prev.element(i).assign(vec4(prPos, pr4.w));
      });
      write.element(i).assign(vec4(p, invM));
    })().compute(vCount);

    const relaxBA = relax(B, A), relaxAB = relax(A, B);
    const iterations = Math.max(1, context.iterations) | 1;
    this.passes.push(snapshot);
    for (let s = 0; s < context.substeps; s++) {
      this.passes.push(computeNormals);
      this.passes.push(bodyVolume);
      this.passes.push(integrate);
      for (let k = 0; k < iterations; k++) this.passes.push(k % 2 === 0 ? relaxBA : relaxAB);
    }
    this.passes.push(computeNormals);
  }

  vertex(index: N): N { return this.A.element(int(index)).xyz; }
  previous(index: N): N { return this.frameStart.element(int(index)).xyz; }
  normal(index: N): N { return this.normals.element(int(index)).xyz; }

  readVertex(index: number, out: THREE.Vector3): THREE.Vector3 {
    // Non-blocking estimate on GPU: body centroid + rest local offset.
    const bid = (this.prev.value.array as Float32Array)[index * 4 + 3] | 0;
    const body = this.context.bodies[bid];
    out.set(this.restData[index * 4], this.restData[index * 4 + 1], this.restData[index * 4 + 2]);
    if (body) out.add(body.center);
    return out;
  }

  kick(body: SoftBodyRecord, velocity: THREE.Vector3): void {
    if (body.id < 0 || body.id >= MAX_SOFT_BODIES) return;
    const k = (this.uVecs.array as THREE.Vector4[])[OFF_BODY_KICK + body.id];
    k.x += velocity.x; k.y += velocity.y; k.z += velocity.z;
    body.velocity.add(velocity);
    this.kicked = true;
  }

  impulseAt(point: THREE.Vector3, velocity: THREE.Vector3, radius: number, body?: SoftBodyRecord | null): void {
    if (this.impacts.length >= MAX_SB_IMPACTS) this.impacts.shift();
    this.impacts.push({ point: point.clone(), velocity: velocity.clone(), radius: Math.max(radius, 0.1), bodyId: body ? body.id : -1 });
    if (body) {
      const dist = body.center.distanceTo(point);
      if (dist < radius + body.restRadius) {
        const w = Math.max(0.15, 1 - dist / (radius + body.restRadius));
        body.velocity.addScaledVector(velocity, w * 0.5);
      }
    }
  }

  resetBody(body: SoftBodyRecord, position: THREE.Vector3, quaternion = new THREE.Quaternion()): void {
    const arrA = this.A.value.array as Float32Array;
    const arrB = this.B.value.array as Float32Array;
    const arrP = this.prev.value.array as Float32Array;
    const arrF = this.frameStart.value.array as Float32Array;
    const end = body.vertexOffset + body.vertexCount;
    for (let v = body.vertexOffset; v < end; v++) {
      const i = v * 4;
      _v.set(this.restData[i], this.restData[i + 1], this.restData[i + 2]).applyQuaternion(quaternion).add(position);
      arrA[i] = arrB[i] = arrP[i] = arrF[i] = _v.x;
      arrA[i + 1] = arrB[i + 1] = arrP[i + 1] = arrF[i + 1] = _v.y;
      arrA[i + 2] = arrB[i + 2] = arrP[i + 2] = arrF[i + 2] = _v.z;
    }
    this.A.value.needsUpdate = true;
    this.B.value.needsUpdate = true;
    this.prev.value.needsUpdate = true;
    this.frameStart.value.needsUpdate = true;
    body.center.copy(position);
    body.velocity.set(0, 0, 0);
  }

  /**
   * Lightweight CPU center-of-mass & proxy tracker so GPU bodies get accurate local ocean
   * height/slope sampling, wake splashes, and two-way Rapier impulse coupling with zero GPU readback.
   */
  private advanceCpuProxy(body: SoftBodyRecord, dt: number, time: number): void {
    const tune = body.tuning;
    const { groundY, water, waterLevel, spheres, boxes } = this.context;
    const r = body.restRadius;

    // Gravity + wind.
    body.velocity.y -= 9.81 * tune.gravity * dt;
    if (tune.airDrag > 0) {
      this.wind.sample(body.center, time, _wind);
      body.velocity.addScaledVector(_wind.sub(body.velocity), Math.min(1, tune.airDrag * dt));
    }

    // Water plane sampling & proxy buoyancy.
    let hasWater = 0;
    let eta = -1e6, nx = 0, nz = 0;
    if (water) {
      hasWater = 1;
      eta = water.heightAt(body.center.x, body.center.z);
      const span = Math.max(0.5, r);
      nx = (water.heightAt(body.center.x + span, body.center.z) - eta) / span;
      nz = (water.heightAt(body.center.x, body.center.z + span) - eta) / span;
      if (water.flowAt) water.flowAt(body.center.x, body.center.z, _flow); else _flow.set(0, 0, 0);
    } else if (waterLevel !== null) {
      hasWater = 1;
      eta = waterLevel;
      _flow.set(0, 0, 0);
    }
    body.waterPlane.set(nx, eta, nz, tune.waterDrag);
    body.waterFlow.set(_flow.x, _flow.y, _flow.z, hasWater);

    if (hasWater) {
      const sub = THREE.MathUtils.clamp((eta - (body.center.y - r)) / (2 * r), 0, 1);
      body.submersion = sub;
      if (sub > 0) {
        if (body.velocity.y < -1.8 && !this.splashed[body.id]) {
          this.splashed[body.id] = 1;
          water?.field?.addSource({
            x: body.center.x, z: body.center.z,
            radius: Math.max(0.8, r * 1.6),
            impulse: -Math.min(1.2, -body.velocity.y * 0.14),
            foam: Math.min(2.5, -body.velocity.y * 0.25),
          });
          this.context.onSplash?.(body.id, new THREE.Vector3(body.center.x, eta, body.center.z), -body.velocity.y);
        }
        const archimedes = (WATER_DENSITY * 9.81 * body.restVolume * tune.buoyancy * sub) / Math.max(tune.mass, 0.2);
        body.velocity.y += archimedes * dt;
        const drag = Math.min(1, tune.waterDrag * sub * dt);
        body.velocity.x += (_flow.x - body.velocity.x) * drag;
        body.velocity.y += (_flow.y - body.velocity.y) * drag * 1.35;
        body.velocity.z += (_flow.z - body.velocity.z) * drag;
      } else {
        this.splashed[body.id] = 0;
      }
    } else {
      body.submersion = 0;
    }

    body.velocity.multiplyScalar(Math.max(0, 1 - tune.damping * dt));
    body.center.addScaledVector(body.velocity, dt);

    // Ground bounce for proxy.
    if (body.center.y - r < groundY) {
      body.center.y = groundY + r;
      if (body.velocity.y < 0) {
        const spd = -body.velocity.y;
        body.velocity.y = spd * tune.restitution;
        body.velocity.x *= 1 - tune.friction;
        body.velocity.z *= 1 - tune.friction;
        if (spd > 2.2 && this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
          this.impactCooldown[body.id] = 0.16;
          this.context.onImpact({
            bodyId: body.id,
            point: new THREE.Vector3(body.center.x, groundY, body.center.z),
            normal: new THREE.Vector3(0, 1, 0),
            speed: spd,
            otherBody: null,
          });
        }
      }
    }

    // Two-way Rapier sphere & box proxy interaction (feeds impulses back to Rapier + emits impact events).
    for (const col of spheres) {
      const dx = body.center.x - col.center.x, dy = body.center.y - col.center.y, dz = body.center.z - col.center.z;
      const dist = Math.hypot(dx, dy, dz);
      const minDist = r + col.radius;
      if (dist < minDist && dist > 1e-5) {
        _n.set(dx / dist, dy / dist, dz / dist);
        body.center.copy(col.center).addScaledVector(_n, minDist);
        const cvx = col.velocity?.x ?? 0, cvy = col.velocity?.y ?? 0, cvz = col.velocity?.z ?? 0;
        const vn = (body.velocity.x - cvx) * _n.x + (body.velocity.y - cvy) * _n.y + (body.velocity.z - cvz) * _n.z;
        if (vn < 0) {
          const j = -(1 + tune.restitution) * vn;
          body.velocity.addScaledVector(_n, j);
          if (col.rapierBody && col.rapierBody.isDynamic()) {
            const pImp = j * tune.mass * 0.5;
            col.rapierBody.applyImpulse({ x: -_n.x * pImp, y: -_n.y * pImp, z: -_n.z * pImp }, true);
          }
          if (-vn > 1.8 && this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
            this.impactCooldown[body.id] = 0.16;
            this.context.onImpact({
              bodyId: body.id,
              point: col.center.clone().addScaledVector(_n, col.radius),
              normal: _n.clone(),
              speed: -vn,
              otherBody: col.rapierBody ?? null,
            });
          }
        }
      }
    }
    for (const box of boxes) {
      const dist = body.center.distanceTo(box.center);
      const boxR = box.halfExtents.length();
      if (dist < r + boxR) {
        const bvx = box.velocity?.x ?? 0, bvy = box.velocity?.y ?? 0, bvz = box.velocity?.z ?? 0;
        _n.subVectors(body.center, box.center);
        const l = _n.length();
        if (l > 1e-5) _n.multiplyScalar(1 / l); else _n.set(0, 1, 0);
        const vn = (body.velocity.x - bvx) * _n.x + (body.velocity.y - bvy) * _n.y + (body.velocity.z - bvz) * _n.z;
        if (vn < -1.5 && colOverlap(body.center, r, box)) {
          const j = -(1 + tune.restitution) * vn;
          body.velocity.addScaledVector(_n, j * 0.7);
          if (box.rapierBody && box.rapierBody.isDynamic()) {
            const pImp = j * tune.mass * 0.45;
            box.rapierBody.applyImpulse({ x: -_n.x * pImp, y: -_n.y * pImp, z: -_n.z * pImp }, true);
          }
          if (this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
            this.impactCooldown[body.id] = 0.16;
            this.context.onImpact({
              bodyId: body.id,
              point: body.center.clone().addScaledVector(_n, -r),
              normal: _n.clone(),
              speed: -vn,
              otherBody: box.rapierBody ?? null,
            });
          }
        }
      }
    }
  }

  step(dt: number, time: number): void {
    const { bodies, spheres, boxes, groundY, substeps } = this.context;
    if (dt <= 0) return;
    const frameDt = Math.min(dt, 1 / 30);
    this.uStep.value = frameDt / substeps;
    this.uGround.value = groundY;

    const vecs = this.uVecs.array as THREE.Vector4[];
    const mats = this.uMats.array as THREE.Matrix4[];

    for (let id = 0; id < MAX_SOFT_BODIES; id++) {
      const body = bodies[id];
      const info = vecs[OFF_BODY_INFO + id];
      const tB = vecs[OFF_BODY_TUNE_B + id];
      if (!body) { info.set(0, 0, 0, 0); tB.set(1, 0.5, 0, 0); continue; }
      if (this.impactCooldown[id] > 0) this.impactCooldown[id] = Math.max(0, this.impactCooldown[id] - frameDt);

      const tune = body.tuning;
      if (tune.leakRate > 0 && tune.pressure > 0) {
        tune.pressure = Math.max(0, tune.pressure - tune.leakRate * frameDt);
      }

      const active = body.enabled && body.activeThisFrame ? 1 : 0;
      if (active) this.advanceCpuProxy(body, frameDt, time);

      const pressureScale = tune.pressure * 45 * Math.max(0.5, tune.mass / Math.max(body.restArea, 0.25));
      const targetVol = body.restVolume * Math.max(0.2, tune.inflation);
      const displacedPerVert = (body.restVolume / Math.max(body.vertexCount, 1)) * tune.buoyancy;
      const draft = Math.max(0.12, body.restRadius * 0.45);

      info.set(body.vertexOffset, body.vertexCount, body.triOffset, body.triCount);
      vecs[OFF_BODY_TUNE_A + id].set(tune.stiffness, tune.strutWeight, pressureScale, targetVol);
      tB.set(tune.gravity, tune.damping, tune.airDrag, active);
      vecs[OFF_BODY_TUNE_C + id].set(tune.restitution, tune.friction, displacedPerVert, draft);
      vecs[OFF_BODY_WATER + id].copy(body.waterPlane);
      vecs[OFF_BODY_FLOW + id].copy(body.waterFlow);

      const k = vecs[OFF_BODY_KICK + id];
      k.w = 0;
      if (this.kicked) k.multiplyScalar(1 / frameDt);
    }

    const sn = Math.min(spheres.length, MAX_SB_SPHERES);
    this.uSpheres.value = sn;
    for (let c = 0; c < sn; c++) {
      const s = spheres[c];
      vecs[OFF_SPHERE_POS + c].set(s.center.x, s.center.y, s.center.z, s.radius);
      vecs[OFF_SPHERE_VEL + c].set(s.velocity?.x ?? 0, s.velocity?.y ?? 0, s.velocity?.z ?? 0, 0);
    }

    const bn = Math.min(boxes.length, MAX_SB_BOXES);
    this.uBoxes.value = bn;
    for (let b = 0; b < bn; b++) {
      const box = boxes[b];
      const margin = box.margin ?? 0.025;
      _mat.compose(box.center, box.quaternion ?? _idQuat, _unitScale);
      _invMat.copy(_mat).invert();
      mats[OFF_BOX_MAT + b].copy(_mat);
      mats[OFF_BOX_INV_MAT + b].copy(_invMat);
      vecs[OFF_BOX_EXT + b].set(box.halfExtents.x + margin, box.halfExtents.y + margin, box.halfExtents.z + margin, 1);
      vecs[OFF_BOX_VEL + b].set(box.velocity?.x ?? 0, box.velocity?.y ?? 0, box.velocity?.z ?? 0, 0);
    }

    const imn = Math.min(this.impacts.length, MAX_SB_IMPACTS);
    this.uImpacts.value = imn;
    for (let k = 0; k < imn; k++) {
      const imp = this.impacts[k];
      vecs[OFF_IMP_POS + k].set(imp.point.x, imp.point.y, imp.point.z, imp.radius);
      vecs[OFF_IMP_VEL + k].set(imp.velocity.x, imp.velocity.y, imp.velocity.z, imp.bodyId);
    }

    this.renderer.compute(this.passes);

    if (imn > 0) { this.impacts.length = 0; this.uImpacts.value = 0; }
    if (this.kicked) {
      for (let id = 0; id < MAX_SOFT_BODIES; id++) vecs[OFF_BODY_KICK + id].set(0, 0, 0, 0);
      this.kicked = false;
    }
  }

  dispose(): void {
    for (const pass of new Set(this.passes)) pass.dispose?.();
  }
}

const _qTmp = new THREE.Quaternion();
const _lTmp = new THREE.Vector3();
function colOverlap(center: THREE.Vector3, radius: number, box: { center: THREE.Vector3; halfExtents: THREE.Vector3; quaternion?: THREE.Quaternion }): boolean {
  _lTmp.subVectors(center, box.center);
  if (box.quaternion) { _qTmp.copy(box.quaternion).invert(); _lTmp.applyQuaternion(_qTmp); }
  const dx = Math.max(0, Math.abs(_lTmp.x) - box.halfExtents.x);
  const dy = Math.max(0, Math.abs(_lTmp.y) - box.halfExtents.y);
  const dz = Math.max(0, Math.abs(_lTmp.z) - box.halfExtents.z);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}
