import * as THREE from 'three/webgpu';
import { TSL as t } from '../../engine/tsl';
import { auxPassthrough, frame } from '../../engine/frame';
import { spriteNoise } from '../../engine/noise';

const HZ = 30, ROWS = 40, LANES = 5, GRAVITY = 9.81;
const MAX_AGE = (ROWS - 2) / HZ;

class Launch {
  readonly point = new THREE.Vector3();
  readonly inner = new THREE.Vector3();
  readonly outer = new THREE.Vector3();
  birth = -Infinity;
  strength = 0;
  run = 0;
  landed = false;

  interpolate(a: Launch, b: Launch, fraction: number, birth: number): void {
    this.point.lerpVectors(a.point, b.point, fraction);
    this.inner.lerpVectors(a.inner, b.inner, fraction);
    this.outer.lerpVectors(a.outer, b.outer, fraction);
    this.strength = THREE.MathUtils.lerp(a.strength, b.strength, fraction);
    this.birth = birth;
    this.run = b.run;
    this.landed = false;
  }
}

interface Outlet {
  history: Launch[];
  last: Launch;
  input: Launch;
  head: number;
  next: number;
  emitting: boolean;
}

/** A world-space strip of water ejected through one or more tire contact patches.
 * Supply each active outlet once per frame, then update. Velocities are in world m/s.
 * Fixed-time launch samples remain in the world when the wheel turns, stops or teleports. */
export class WheelSpraySheets {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  readonly stats = { triangles: 0, landings: 0 };
  private outlets: Outlet[];
  private readonly positions: THREE.BufferAttribute;
  private readonly weights: THREE.BufferAttribute;
  private readonly indices: THREE.BufferAttribute;
  private time = 0;
  private vertex = 0;
  private index = 0;

  constructor(outletCount: number, private readonly onLanding?: (x: number, z: number, strength: number) => void) {
    if (!Number.isInteger(outletCount) || outletCount < 1 || outletCount > 64) throw new RangeError('Use 1–64 wheel spray outlets');
    this.outlets = Array.from({ length: outletCount }, () => ({
      history: Array.from({ length: ROWS }, () => new Launch()), last: new Launch(), input: new Launch(),
      head: 0, next: 0, emitting: false,
    }));
    const vertices = outletCount * (ROWS + 1) * LANES;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.weights = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.indices = new THREE.BufferAttribute(new Uint16Array(vertices * 6), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('sheetState', this.weights);
    geometry.setIndex(this.indices);
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    material.forceSinglePass = true;
    const state = t.attribute('sheetState', 'vec3').toVarying('wheelSheetState');
    const p = t.positionWorld;
    const eye = t.normalize(t.cameraPosition.sub(p));
    const uv = p.xz.add(t.vec2(p.y.mul(0.7), p.y.mul(-1.4)));
    const billow = spriteNoise(uv.mul(4.3).add(t.vec2(0, frame.time.mul(-0.8))), 1);
    const grain = spriteNoise(uv.mul(26).add(t.vec2(p.y.mul(9), frame.time.mul(-1.6))), 0);
    const normal = t.normalize(t.cross(t.dFdx(p), t.dFdy(p)));
    const grazing = t.abs(t.dot(normal, eye)).oneMinus().pow(4);
    // The fringe atomizes before the ballistic envelope ends. Taper both strip
    // boundaries or the indexed outer lane reads as a hard white polygon.
    const fringe = state.y.add(billow.sub(0.5).mul(0.30));
    const profile = t.smoothstep(0, 0.27, fringe).mul(t.smoothstep(0.47, 0.96, fringe).oneMinus());
    const breakup = billow.mul(0.58).add(grain.mul(0.42));
    const threshold = state.z.mul(0.24).add(0.30);
    const lace = t.smoothstep(threshold, threshold.add(0.22), breakup);
    const forwardScatter = t.dot(eye.negate(), frame.sunDirection).max(0).pow(5);
    const ambient = t.mix(frame.skyHorizon, frame.skyZenith, 0.46);
    const direct = frame.sunColor.mul(frame.sunVisibility).mul(forwardScatter.mul(0.36).add(0.09));
    material.colorNode = ambient.mul(0.95).add(direct);
    material.opacityNode = state.x.mul(profile).mul(lace).mul(grazing.mul(0.18).add(0.24));
    material.mrtNode = auxPassthrough();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'wheel-water-sheets';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }

  /** Inner velocity follows the climbing sheet, outer velocity describes the lower lateral fan. */
  submit(outlet: number, point: THREE.Vector3, innerVelocity: THREE.Vector3, outerVelocity: THREE.Vector3, strength: number): void {
    const slot = this.outlets[outlet].input;
    slot.point.copy(point); slot.inner.copy(innerVelocity); slot.outer.copy(outerVelocity);
    slot.strength = THREE.MathUtils.clamp(strength, 0, 1);
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    this.vertex = this.index = 0;
    for (const outlet of this.outlets) {
      const { input, last, history } = outlet;
      const emitting = input.strength > 0.015;
      if (!emitting && this.time - last.birth > MAX_AGE) { outlet.emitting = false; continue; }
      if (emitting) {
        const jumped = last.point.distanceToSquared(input.point) > Math.max(1.5, dt * (12 + input.outer.length()) * 4) ** 2;
        if (!outlet.emitting || jumped || dt > 0.18) {
          input.run++;
          last.interpolate(input, input, 0, this.time);
          outlet.next = this.time;
        }
        while (outlet.next <= this.time + 1e-8) {
          const f = THREE.MathUtils.clamp((outlet.next - last.birth) / Math.max(this.time - last.birth, 1e-6), 0, 1);
          history[outlet.head].interpolate(last, input, f, outlet.next);
          outlet.head = (outlet.head + 1) % ROWS;
          outlet.next += 1 / HZ;
        }
        last.interpolate(input, input, 0, this.time);
      }
      outlet.emitting = emitting;
      let previous = -1, run = -1, newestAge = Infinity;
      for (let i = 0; i < ROWS; i++) {
        const row = history[(outlet.head + i) % ROWS];
        const age = Math.max(0, this.time - row.birth);
        if (age > MAX_AGE || row.birth === -Infinity) continue;
        const lift = (row.inner.y + row.outer.y) * 0.5;
        const impactAge = Math.max(0, 2 * lift / GRAVITY);
        if (!row.landed && age >= impactAge) {
          row.landed = true;
          this.stats.landings++;
          this.onLanding?.(row.point.x + (row.inner.x + row.outer.x) * 0.5 * impactAge,
            row.point.z + (row.inner.z + row.outer.z) * 0.5 * impactAge, row.strength);
        }
        if (age > 2 * Math.max(row.inner.y, row.outer.y) / GRAVITY) { previous = -1; continue; }
        const start = this.writeRow(row, age);
        if (run === row.run && previous >= 0) this.join(previous, start);
        previous = start; run = row.run; newestAge = age;
      }
      if (emitting && previous >= 0 && run === input.run && newestAge > 1e-6) this.join(previous, this.writeRow(input, 0));
      input.strength = 0;
    }
    this.stats.triangles = this.index / 3;
    this.mesh.visible = this.index > 0;
    this.mesh.geometry.setDrawRange(0, this.index);
    if (!this.index) return;
    this.positions.needsUpdate = this.weights.needsUpdate = this.indices.needsUpdate = true;
  }

  private writeRow(row: Launch, age: number): number {
    const start = this.vertex;
    for (let k = 0; k < LANES; k++) {
      const side = k / (LANES - 1);
      const ySpeed = THREE.MathUtils.lerp(row.inner.y, row.outer.y, side);
      const lift = age * (ySpeed - 0.5 * GRAVITY * age);
      const life = age * GRAVITY / Math.max(0.1, 2 * ySpeed);
      const opacity = row.strength * (1 - THREE.MathUtils.smoothstep(life, 0.20, 0.92));
      this.positions.setXYZ(this.vertex, row.point.x + THREE.MathUtils.lerp(row.inner.x, row.outer.x, side) * age,
        row.point.y + Math.max(0, lift), row.point.z + THREE.MathUtils.lerp(row.inner.z, row.outer.z, side) * age);
      this.weights.setXYZ(this.vertex++, opacity, side, Math.min(1, life));
    }
    return start;
  }

  private join(a: number, b: number): void {
    const indices = this.indices.array;
    for (let k = 0; k < LANES - 1; k++) {
      indices[this.index++] = a + k; indices[this.index++] = b + k; indices[this.index++] = b + k + 1;
      indices[this.index++] = a + k; indices[this.index++] = b + k + 1; indices[this.index++] = a + k + 1;
    }
  }

  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
