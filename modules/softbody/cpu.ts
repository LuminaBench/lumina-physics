/**
 * CPU spring + ideal-gas pressure soft-body solver (Gauss–Seidel Verlet).
 *
 * Reference implementation and WebGL 2 fallback. Handles:
 *   - Closed-volume ideal-gas pressure inflation (P = k · V₀ / V) along area-weighted normals,
 *   - Structural surface springs + internal cross-bracing struts,
 *   - Per-vertex water buoyancy & hydrodynamic drag (Ocean or flat water level) with wake splashes,
 *   - Sphere & oriented-box collider pushout with friction, bounce, and two-way Rapier impulse coupling.
 *
 * Publishes live positions, previous-frame positions, and smooth vertex normals into one
 * float DataTexture so the TSL rendering material is identical to the WebGPU path.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import type { WindField } from '../../engine/wind';
import {
  layoutSoftBodies,
  WATER_DENSITY,
  type PackedSoftBodyLayout,
  type SoftBodyBackend,
  type SoftBodyBoxCollider,
  type SoftBodyContext,
  type SoftBodyRecord,
} from './types';

const { textureLoad, ivec2, int } = TSL;

const TEX_WIDTH = 256;
const _wind = new THREE.Vector3();
const _flow = new THREE.Vector3();
const _p = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _n = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _pt = new THREE.Vector3();

export class CpuSoftBodySolver implements SoftBodyBackend {
  readonly kind = 'cpu' as const;
  readonly vertexCount: number;
  readonly pos: Float32Array;
  private prev: Float32Array;
  private rest: Float32Array;
  private normals: Float32Array;
  private frameStart: Float32Array;
  private triangles: Float32Array;
  private uniqueSprings: PackedSoftBodyLayout['uniqueSprings'];
  private texture: THREE.DataTexture;
  private data: Float32Array;
  private rows: number;
  private impactCooldown: Float32Array;
  private splashed: Uint8Array;

  constructor(private context: SoftBodyContext, private wind: WindField) {
    const layout = layoutSoftBodies(context.bodies);
    this.vertexCount = layout.vertexCount;
    this.pos = layout.position;
    this.prev = layout.previous;
    this.rest = layout.rest;
    this.normals = layout.normals;
    this.triangles = layout.triangles;
    this.uniqueSprings = layout.uniqueSprings;
    this.frameStart = new Float32Array(layout.position);
    this.impactCooldown = new Float32Array(Math.max(context.bodies.length, 1));
    this.splashed = new Uint8Array(Math.max(context.bodies.length, 1));

    // Band 0: pos, Band 1: frameStart (previous), Band 2: smooth world normals.
    this.rows = Math.ceil(this.vertexCount / TEX_WIDTH);
    this.data = new Float32Array(TEX_WIDTH * this.rows * 3 * 4);
    this.texture = new THREE.DataTexture(this.data, TEX_WIDTH, this.rows * 3, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;

    this.computeNormalsAndVolume();
    this.upload();
  }

  private upload(): void {
    const band = TEX_WIDTH * this.rows * 4;
    this.data.set(this.pos.subarray(0, this.vertexCount * 4), 0);
    this.data.set(this.frameStart.subarray(0, this.vertexCount * 4), band);
    this.data.set(this.normals.subarray(0, this.vertexCount * 4), band * 2);
    this.texture.needsUpdate = true;
  }

  vertex(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH))).xyz;
  }

  previous(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.rows))).xyz;
  }

  normal(index: N): N {
    const i = int(index);
    return textureLoad(this.texture, ivec2(i.mod(TEX_WIDTH), i.div(TEX_WIDTH).add(this.rows * 2))).xyz;
  }

  readVertex(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos[index * 4], this.pos[index * 4 + 1], this.pos[index * 4 + 2]);
  }

  kick(body: SoftBodyRecord, velocity: THREE.Vector3): void {
    const h = 1 / 60 / this.context.substeps;
    const end = body.vertexOffset + body.vertexCount;
    for (let v = body.vertexOffset; v < end; v++) {
      const i = v * 4;
      if (this.pos[i + 3] === 0) continue;
      this.prev[i] -= velocity.x * h;
      this.prev[i + 1] -= velocity.y * h;
      this.prev[i + 2] -= velocity.z * h;
    }
    body.velocity.add(velocity);
  }

  impulseAt(point: THREE.Vector3, velocity: THREE.Vector3, radius: number, target?: SoftBodyRecord | null): void {
    const h = 1 / 60 / this.context.substeps;
    const r2 = Math.max(radius, 0.1) ** 2;
    const list = target ? [target] : this.context.bodies;
    for (const body of list) {
      const end = body.vertexOffset + body.vertexCount;
      for (let v = body.vertexOffset; v < end; v++) {
        const i = v * 4;
        if (this.pos[i + 3] === 0) continue;
        const dx = this.pos[i] - point.x, dy = this.pos[i + 1] - point.y, dz = this.pos[i + 2] - point.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const w = 1 - Math.sqrt(d2 / r2);
        const s = w * w * h;
        this.prev[i] -= velocity.x * s;
        this.prev[i + 1] -= velocity.y * s;
        this.prev[i + 2] -= velocity.z * s;
      }
    }
  }

  resetBody(body: SoftBodyRecord, position: THREE.Vector3, quaternion = new THREE.Quaternion()): void {
    const end = body.vertexOffset + body.vertexCount;
    for (let v = body.vertexOffset; v < end; v++) {
      const i = v * 4;
      _p.set(this.rest[i], this.rest[i + 1], this.rest[i + 2]).applyQuaternion(quaternion).add(position);
      this.pos[i] = this.prev[i] = this.frameStart[i] = _p.x;
      this.pos[i + 1] = this.prev[i + 1] = this.frameStart[i + 1] = _p.y;
      this.pos[i + 2] = this.prev[i + 2] = this.frameStart[i + 2] = _p.z;
    }
    body.center.copy(position);
    body.velocity.set(0, 0, 0);
    body.volume = body.restVolume;
    this.computeNormalsAndVolume();
    this.upload();
  }

  /** Compute area-weighted vertex normals (stored in `normals.xyz` + area in `normals.w`) and exact signed volume per body. */
  private computeNormalsAndVolume(): void {
    const P = this.pos, N = this.normals, T = this.triangles;
    N.fill(0);

    for (const body of this.context.bodies) {
      let cx = 0, cy = 0, cz = 0;
      const start = body.vertexOffset;
      const count = body.vertexCount;
      for (let v = start; v < start + count; v++) {
        cx += P[v * 4]; cy += P[v * 4 + 1]; cz += P[v * 4 + 2];
      }
      if (count > 0) { cx /= count; cy /= count; cz /= count; }
      body.center.set(cx, cy, cz);

      let vol = 0;
      const tEnd = body.triOffset + body.triCount;
      for (let t = body.triOffset; t < tEnd; t++) {
        const ia = T[t * 4] * 4, ib = T[t * 4 + 1] * 4, ic = T[t * 4 + 2] * 4;
        const ax = P[ia] - cx, ay = P[ia + 1] - cy, az = P[ia + 2] - cz;
        const bx = P[ib] - cx, by = P[ib + 1] - cy, bz = P[ib + 2] - cz;
        const cx2 = P[ic] - cx, cy2 = P[ic + 1] - cy, cz2 = P[ic + 2] - cz;

        // Signed tetrahedron volume relative to centroid.
        vol += (ax * (by * cz2 - bz * cy2) + ay * (bz * cx2 - bx * cz2) + az * (bx * cy2 - by * cx2)) / 6;

        // Unnormalized face normal = (b - a) × (c - a); magnitude = 2 * triArea.
        const e1x = P[ib] - P[ia], e1y = P[ib + 1] - P[ia + 1], e1z = P[ib + 2] - P[ia + 2];
        const e2x = P[ic] - P[ia], e2y = P[ic + 1] - P[ia + 1], e2z = P[ic + 2] - P[ia + 2];
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;

        // Accumulate 1/6 of (e1 × e2) = (triArea / 3) * n̂ onto each vertex.
        const sx = nx / 6, sy = ny / 6, sz = nz / 6;
        N[ia] += sx; N[ia + 1] += sy; N[ia + 2] += sz;
        N[ib] += sx; N[ib + 1] += sy; N[ib + 2] += sz;
        N[ic] += sx; N[ic + 1] += sy; N[ic + 2] += sz;
      }
      body.volume = vol;

      // Normalize normals for shading while storing dual vertex area in w.
      for (let v = start; v < start + count; v++) {
        const i = v * 4;
        const len = Math.hypot(N[i], N[i + 1], N[i + 2]);
        if (len > 1e-8) {
          N[i] /= len; N[i + 1] /= len; N[i + 2] /= len;
          N[i + 3] = len;
        } else {
          N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; N[i + 3] = 0;
        }
      }
    }
  }

  private pushOutBox(
    i: number,
    h: number,
    body: SoftBodyRecord,
    box: SoftBodyBoxCollider,
  ): void {
    const P = this.pos, Q = this.prev;
    const margin = box.margin ?? 0.025;
    const hx = box.halfExtents.x + margin, hy = box.halfExtents.y + margin, hz = box.halfExtents.z + margin;
    _local.set(P[i] - box.center.x, P[i + 1] - box.center.y, P[i + 2] - box.center.z);
    const q = box.quaternion;
    if (q) { _qInv.copy(q).invert(); _local.applyQuaternion(_qInv); }
    const ax = Math.abs(_local.x), ay = Math.abs(_local.y), az = Math.abs(_local.z);
    if (ax >= hx || ay >= hy || az >= hz) return;

    const penX = hx - ax, penY = hy - ay, penZ = hz - az;
    _n.set(0, 0, 0);
    if (penX <= penY && penX <= penZ) { const s = _local.x >= 0 ? 1 : -1; _local.x = s * hx; _n.x = s; }
    else if (penY <= penZ) { const s = _local.y >= 0 ? 1 : -1; _local.y = s * hy; _n.y = s; }
    else { const s = _local.z >= 0 ? 1 : -1; _local.z = s * hz; _n.z = s; }
    if (q) { _local.applyQuaternion(q); _n.applyQuaternion(q); }

    const nx = _n.x, ny = _n.y, nz = _n.z;
    const vx = (P[i] - Q[i]) / h, vy = (P[i + 1] - Q[i + 1]) / h, vz = (P[i + 2] - Q[i + 2]) / h;
    const bvx = box.velocity?.x ?? 0, bvy = box.velocity?.y ?? 0, bvz = box.velocity?.z ?? 0;
    const rvx = vx - bvx, rvy = vy - bvy, rvz = vz - bvz;
    const vn = rvx * nx + rvy * ny + rvz * nz;

    P[i] = box.center.x + _local.x;
    P[i + 1] = box.center.y + _local.y;
    P[i + 2] = box.center.z + _local.z;

    if (vn < 0) {
      const rest = body.tuning.restitution;
      const fric = body.tuning.friction;
      const tvx = rvx - vn * nx, tvy = rvy - vn * ny, tvz = rvz - vn * nz;
      const nvx = bvx + tvx * (1 - fric) - vn * rest * nx;
      const nvy = bvy + tvy * (1 - fric) - vn * rest * ny;
      const nvz = bvz + tvz * (1 - fric) - vn * rest * nz;
      Q[i] = P[i] - nvx * h; Q[i + 1] = P[i + 1] - nvy * h; Q[i + 2] = P[i + 2] - nvz * h;

      // Two-way Rapier impulse coupling!
      if (box.rapierBody && box.rapierBody.isDynamic() && P[i + 3] > 0) {
        const vm = 1 / P[i + 3];
        const jMag = -(1 + rest) * vn * vm * 0.65;
        _imp.set(-nx * jMag, -ny * jMag, -nz * jMag);
        _pt.set(P[i], P[i + 1], P[i + 2]);
        box.rapierBody.applyImpulseAtPoint(_imp, _pt, true);
      }
      if (-vn > 1.8 && this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
        this.impactCooldown[body.id] = 0.14;
        this.context.onImpact({
          bodyId: body.id,
          point: new THREE.Vector3(P[i], P[i + 1], P[i + 2]),
          normal: _n.clone(),
          speed: -vn,
          otherBody: box.rapierBody ?? null,
        });
      }
    }
  }

  step(dt: number, time: number): void {
    const { bodies, spheres, boxes, groundY, water, waterLevel, substeps, iterations } = this.context;
    const P = this.pos, Q = this.prev, N = this.normals;
    this.frameStart.set(P);
    if (dt <= 0) { this.upload(); return; }
    const frameDt = Math.min(dt, 1 / 30);
    const h = frameDt / substeps;
    const wind = this.wind;

    for (let b = 0; b < bodies.length; b++) {
      if (this.impactCooldown[b] > 0) this.impactCooldown[b] = Math.max(0, this.impactCooldown[b] - frameDt);
    }

    for (let s = 0; s < substeps; s++) {
      this.computeNormalsAndVolume();

      // ---- 1. Integrate forces: gravity + ideal-gas pressure + wind + water buoyancy ----
      for (const body of bodies) {
        if (!body.enabled || !body.activeThisFrame) continue;
        const tune = body.tuning;
        if (tune.leakRate > 0 && tune.pressure > 0) {
          tune.pressure = Math.max(0, tune.pressure - tune.leakRate * h);
        }

        // Ideal-gas internal pressure: P = P_base * (V_target / max(V, 0.15 * V₀))
        const targetVol = body.restVolume * Math.max(0.2, tune.inflation);
        const curVol = Math.max(body.volume, body.restVolume * 0.15);
        // Scale pressure into physical N/m² proportional to body mass & radius so inflatables hold crisp shape.
        const pressureScale = tune.pressure * 45 * Math.max(0.5, body.tuning.mass / Math.max(body.restArea, 0.25));
        const gasPressure = tune.pressure > 0
          ? pressureScale * THREE.MathUtils.clamp(targetVol / curVol, 0.25, 3.8)
          : 0;

        const start = body.vertexOffset;
        const end = start + body.vertexCount;
        const displacedPerVert = (Math.max(body.volume, body.restVolume * 0.35) / Math.max(body.vertexCount, 1)) * tune.buoyancy;
        const draft = Math.max(0.12, body.restRadius * 0.45);

        let subCount = 0;
        let avgVx = 0, avgVy = 0, avgVz = 0;
        let maxSplashSpeed = 0;
        let splashX = 0, splashY = 0, splashZ = 0;

        for (let v = start; v < end; v++) {
          const i = v * 4;
          const invM = P[i + 3];
          if (invM === 0) continue;

          const px = P[i], py = P[i + 1], pz = P[i + 2];
          const vx = (px - Q[i]) / h, vy = (py - Q[i + 1]) / h, vz = (pz - Q[i + 2]) / h;
          avgVx += vx; avgVy += vy; avgVz += vz;

          // Pressure force along outward area-weighted normal (N.xyz = unit normal, N.w = dual area).
          const area = N[i + 3];
          let fx = N[i] * area * gasPressure;
          let fy = N[i + 1] * area * gasPressure - (9.81 * tune.gravity) / invM;
          let fz = N[i + 2] * area * gasPressure;

          // Aerodynamic drag from unified wind field (including blasts).
          if (tune.airDrag > 0) {
            wind.sample(_p.set(px, py, pz), time, _wind);
            const dragK = (tune.airDrag / invM);
            fx += (_wind.x - vx) * dragK;
            fy += (_wind.y - vy) * dragK;
            fz += (_wind.z - vz) * dragK;
          }

          // Water buoyancy + hydrodynamic drag.
          let eta = -1e6;
          if (water) eta = water.heightAt(px, pz);
          else if (waterLevel !== null) eta = waterLevel;

          if (eta > -1e5) {
            const depth = eta - py;
            const sub = THREE.MathUtils.clamp(depth / draft + 0.25, 0, 1);
            if (sub > 0) {
              subCount += sub;
              if (vy < -1.5 && -vy > maxSplashSpeed) {
                maxSplashSpeed = -vy; splashX = px; splashY = eta; splashZ = pz;
              }
              // Archimedes upward lift.
              fy += WATER_DENSITY * 9.81 * displacedPerVert * sub;
              // Relative water flow + quadratic/linear drag.
              if (water?.flowAt) water.flowAt(px, pz, _flow); else _flow.set(0, 0, 0);
              const rvx = vx - _flow.x, rvy = vy - _flow.y, rvz = vz - _flow.z;
              const spd = Math.hypot(rvx, rvy, rvz);
              const wDrag = (tune.waterDrag + 0.65 * spd) * sub / invM;
              fx -= rvx * wDrag;
              fy -= rvy * wDrag * 1.35;
              fz -= rvz * wDrag;
            }
          }

          const keep = Math.max(0, 1 - tune.damping * h);
          Q[i] = px; Q[i + 1] = py; Q[i + 2] = pz;
          P[i] = px + vx * h * keep + fx * invM * h * h;
          P[i + 1] = py + vy * h * keep + fy * invM * h * h;
          P[i + 2] = pz + vz * h * keep + fz * invM * h * h;
        }

        const invN = 1 / Math.max(body.vertexCount, 1);
        body.velocity.set(avgVx * invN, avgVy * invN, avgVz * invN);
        body.submersion = subCount * invN;

        // Water impact wake & splash callback.
        if (s === 0 && maxSplashSpeed > 1.8 && !this.splashed[body.id]) {
          this.splashed[body.id] = 1;
          water?.field?.addSource({
            x: splashX, z: splashZ,
            radius: Math.max(0.8, body.restRadius * 1.6),
            impulse: -Math.min(1.2, maxSplashSpeed * 0.14),
            foam: Math.min(2.5, maxSplashSpeed * 0.25),
          });
          this.context.onSplash?.(body.id, new THREE.Vector3(splashX, splashY, splashZ), maxSplashSpeed);
        } else if (body.submersion < 0.05) {
          this.splashed[body.id] = 0;
        }
      }

      // ---- 2. Gauss–Seidel spring constraints & collider pushout ----
      for (let it = 0; it < iterations; it++) {
        for (let si = 0; si < this.uniqueSprings.length; si++) {
          const sp = this.uniqueSprings[si];
          const body = bodies[sp.bodyId];
          if (!body.enabled || !body.activeThisFrame) continue;
          const ia = sp.a * 4, ib = sp.b * 4;
          const wa = P[ia + 3], wb = P[ib + 3];
          const wsum = wa + wb;
          if (wsum === 0) continue;
          const dx = P[ib] - P[ia], dy = P[ib + 1] - P[ia + 1], dz = P[ib + 2] - P[ia + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-8) continue;
          const weight = sp.kind === 0 ? body.tuning.stiffness : body.tuning.stiffness * body.tuning.strutWeight;
          const k = ((len - sp.rest) / len) * weight / wsum;
          P[ia] += dx * k * wa; P[ia + 1] += dy * k * wa; P[ia + 2] += dz * k * wa;
          P[ib] -= dx * k * wb; P[ib + 1] -= dy * k * wb; P[ib + 2] -= dz * k * wb;
        }

        // Collisions (ground, spheres, oriented boxes).
        for (const body of bodies) {
          if (!body.enabled || !body.activeThisFrame) continue;
          const start = body.vertexOffset;
          const end = start + body.vertexCount;
          const rest = body.tuning.restitution;
          const fric = body.tuning.friction;
          for (let v = start; v < end; v++) {
            const i = v * 4;
            if (P[i + 3] === 0) continue;

            // Ground plane with bounce + friction.
            if (P[i + 1] < groundY) {
              const vx = (P[i] - Q[i]) / h, vy = (P[i + 1] - Q[i + 1]) / h, vz = (P[i + 2] - Q[i + 2]) / h;
              P[i + 1] = groundY;
              if (vy < 0) {
                const nvy = -vy * rest;
                Q[i] = P[i] - vx * (1 - fric) * h;
                Q[i + 1] = P[i + 1] - nvy * h;
                Q[i + 2] = P[i + 2] - vz * (1 - fric) * h;
                if (-vy > 2.2 && this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
                  this.impactCooldown[body.id] = 0.14;
                  this.context.onImpact({
                    bodyId: body.id,
                    point: new THREE.Vector3(P[i], groundY, P[i + 2]),
                    normal: new THREE.Vector3(0, 1, 0),
                    speed: -vy,
                    otherBody: null,
                  });
                }
              }
            }

            // Sphere colliders + two-way Rapier impulse coupling.
            for (let ci = 0; ci < spheres.length; ci++) {
              const col = spheres[ci];
              const dx = P[i] - col.center.x, dy = P[i + 1] - col.center.y, dz = P[i + 2] - col.center.z;
              const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (len < col.radius) {
                const invLen = len > 1e-6 ? 1 / len : 0;
                const nx = invLen ? dx * invLen : 0;
                const ny = invLen ? dy * invLen : 1;
                const nz = invLen ? dz * invLen : 0;
                const vx = (P[i] - Q[i]) / h, vy = (P[i + 1] - Q[i + 1]) / h, vz = (P[i + 2] - Q[i + 2]) / h;
                const cvx = col.velocity?.x ?? 0, cvy = col.velocity?.y ?? 0, cvz = col.velocity?.z ?? 0;
                const rvx = vx - cvx, rvy = vy - cvy, rvz = vz - cvz;
                const vn = rvx * nx + rvy * ny + rvz * nz;

                P[i] = col.center.x + nx * col.radius;
                P[i + 1] = col.center.y + ny * col.radius;
                P[i + 2] = col.center.z + nz * col.radius;

                if (vn < 0) {
                  const tvx = rvx - vn * nx, tvy = rvy - vn * ny, tvz = rvz - vn * nz;
                  const nvx = cvx + tvx * (1 - fric) - vn * rest * nx;
                  const nvy = cvy + tvy * (1 - fric) - vn * rest * ny;
                  const nvz = cvz + tvz * (1 - fric) - vn * rest * nz;
                  Q[i] = P[i] - nvx * h; Q[i + 1] = P[i + 1] - nvy * h; Q[i + 2] = P[i + 2] - nvz * h;

                  if (col.rapierBody && col.rapierBody.isDynamic()) {
                    const vm = 1 / P[i + 3];
                    const jMag = -(1 + rest) * vn * vm * 0.65;
                    _imp.set(-nx * jMag, -ny * jMag, -nz * jMag);
                    _pt.set(P[i], P[i + 1], P[i + 2]);
                    col.rapierBody.applyImpulseAtPoint(_imp, _pt, true);
                  }
                  if (-vn > 1.8 && this.impactCooldown[body.id] <= 0 && this.context.onImpact) {
                    this.impactCooldown[body.id] = 0.14;
                    this.context.onImpact({
                      bodyId: body.id,
                      point: new THREE.Vector3(P[i], P[i + 1], P[i + 2]),
                      normal: new THREE.Vector3(nx, ny, nz),
                      speed: -vn,
                      otherBody: col.rapierBody ?? null,
                    });
                  }
                }
              }
            }

            // Oriented box colliders.
            for (let bi = 0; bi < boxes.length; bi++) {
              this.pushOutBox(i, h, body, boxes[bi]);
            }
          }
        }
      }
    }

    this.computeNormalsAndVolume();
    this.upload();
  }

  dispose(): void { this.texture.dispose(); }
}
