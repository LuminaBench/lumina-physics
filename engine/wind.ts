/**
 * Unified 3D wind vector field.
 *
 * One field drives ocean chop direction, rain streak slant, fire / smoke drift, spray and
 * cloud advection. The gust model is an analytic sum of travelling sines so the exact same
 * function runs on the CPU (`sample`) and inside any shader (`node`). Transient radial
 * "blast" sources let explosions and sonic booms shove nearby particles.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';
import { frame } from './frame';

const { uniform, uniformArray, Fn, vec3, vec2, sin, float, max, smoothstep, length, exp, Loop, int } = TSL;

const MAX_BLASTS = 4;

interface Blast {
  sourceId?: number;
  position: THREE.Vector3;
  radius: number;
  strength: number;
  age: number;
  duration: number;
  curRadius: number;
  invCurRadius: number;
  curRadiusSq: number;
  curStrength: number;
}

export class WindField {
  /** Unit direction the wind blows *toward* in the XZ plane. */
  readonly direction = new THREE.Vector2(1, 0);
  /** Mean speed at 10 m (m/s). */
  speed = 6;
  /** 0..1 gust depth. */
  gustiness = 0.35;

  /** Pre-allocated pool of blast slots (active blasts occupy [0, activeBlasts)). */
  private blastPool: Blast[] = Array.from({ length: MAX_BLASTS }, () => ({
    position: new THREE.Vector3(), radius: 1, strength: 0, age: 0, duration: 1,
    curRadius: 1, invCurRadius: 1, curRadiusSq: 1, curStrength: 0,
  }));
  private activeBlasts = 0;
  private uploadedBlasts = 0;
  /** Set when a blast was added or slots were cleared: uniform rows must take positions again. */
  private blastsMoved = false;
  private uDirection = uniform(new THREE.Vector2(1, 0));
  private uSpeed = uniform(6);
  private uGust = uniform(0.35);
  private uBlastCount = uniform(0,'int');
  private uBlastPosRadius = uniformArray(Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4()), 'vec4');
  private uBlastStrength = uniformArray(new Array(MAX_BLASTS).fill(0), 'float');

  set(directionRadians: number, speed: number, gustiness = this.gustiness): void {
    this.direction.set(Math.cos(directionRadians), Math.sin(directionRadians));
    this.speed = speed;
    this.gustiness = gustiness;
  }

  get directionRadians(): number { return Math.atan2(this.direction.y, this.direction.x); }

  /** Number of transient blasts currently travelling through the field. */
  get blastCount(): number { return this.activeBlasts; }

  /** Inject a transient radial blast (explosion pressure wave, sonic boom, rotor wash). */
  addBlast(position: THREE.Vector3, strength: number, radius: number, duration = 1.2, sourceId?: number): void {
    let b: Blast;
    if (this.activeBlasts >= MAX_BLASTS) {
      // Rotate oldest slot to the back without allocating.
      b = this.blastPool[0];
      for (let i = 0; i < MAX_BLASTS - 1; i++) this.blastPool[i] = this.blastPool[i + 1];
      this.blastPool[MAX_BLASTS - 1] = b;
    } else {
      b = this.blastPool[this.activeBlasts++];
    }
    b.sourceId = sourceId;
    b.position.copy(position);
    b.radius = radius;
    b.strength = strength;
    b.age = 0;
    b.duration = duration;
    const curRadius = radius * 0.35;
    b.curRadius = curRadius;
    b.invCurRadius = 1 / (curRadius > 1e-4 ? curRadius : 1e-4);
    b.curRadiusSq = curRadius * curRadius;
    b.curStrength = strength;
    this.blastsMoved = true;
  }

  clearBlasts(): void { this.activeBlasts = 0; this.update(0); }

  update(dt: number): void {
    this.uDirection.value.copy(this.direction);
    // Number uniforms hold tagged values, so storing an unchanged number would box it again.
    const speed = this.speed, gustiness = this.gustiness;
    if (this.uSpeed.value !== speed) this.uSpeed.value = speed;
    if (this.uGust.value !== gustiness) this.uGust.value = gustiness;
    // Age, compact in place (every pooled Blast object stays alive) and refresh each survivor's
    // expanding front in the same pass, so its age and duration are read once.
    const pool = this.blastPool, rows = this.uBlastPosRadius.array, strengths = this.uBlastStrength.array;
    const active = this.activeBlasts;
    let moved = this.blastsMoved;
    let alive = 0;
    for (let i = 0; i < active; i++) {
      const b = pool[i];
      const age = (b.age += dt), duration = b.duration;
      if (!(age < duration)) {
        moved = true;
        continue;
      }
      if (alive !== i) {
        pool[i] = pool[alive];
        pool[alive] = b;
      }
      // The pressure front expands while its strength decays.
      const k = age / duration;
      const curRadius = b.radius * (0.35 + 0.65 * k);
      const oneMinusK = 1 - k;
      const curStrength = b.strength * oneMinusK * oneMinusK;
      b.curRadius = curRadius;
      b.invCurRadius = 1 / (curRadius > 1e-4 ? curRadius : 1e-4);
      b.curRadiusSq = curRadius * curRadius;
      b.curStrength = curStrength;
      const row = rows[alive] as THREE.Vector4;
      // A blast never moves: its row only needs the position again after the slots changed.
      if (moved) row.set(b.position.x, b.position.y, b.position.z, curRadius);
      else row.w = curRadius;
      strengths[alive] = curStrength;
      alive++;
    }
    this.blastsMoved = false;
    this.activeBlasts = alive;
    this.uBlastCount.value=alive;
    for (let i = alive; i < this.uploadedBlasts; i++) {
      (rows[i] as THREE.Vector4).set(0, -1e6, 0, 1);
      strengths[i] = 0;
    }
    this.uploadedBlasts = alive;
  }

  /** CPU wind (m/s). A moving emitter may exclude its own pressure front when measuring incoming air. */
  sample(position: THREE.Vector3, time: number, out = new THREE.Vector3(), excludeSourceId?: number): THREE.Vector3 {
    const d = this.direction;
    const dxDir = d.x, dzDir = d.y;
    const px = position.x, py = position.y, pz = position.z;
    const gustiness = this.gustiness;
    let gust = 1;
    let veer = 0;
    if (gustiness !== 0) {
      // The four phase products stay local. Caching them on the instance cost a compare, four
      // stores and four double-field reads per call, which is more than the four multiplies it
      // saved, and a client that samples once per frame missed the cache every time.
      const along = px * dxDir + pz * dzDir;
      // -px * dzDir + pz * dxDir: the same sum without a separate negation.
      const across = pz * dxDir - px * dzDir;
      gust = 1 + gustiness * (
        0.5 * Math.sin(0.31 * time - 0.013 * along) +
        0.3 * Math.sin(0.73 * time - 0.031 * along + 0.027 * across) +
        0.2 * Math.sin(1.9 * time - 0.11 * along + 0.07 * across));
      veer = gustiness * 0.35 * Math.sin(0.23 * time + 0.011 * across - 0.008 * along);
    }
    let yNorm = py * (1 / 30);
    if (yNorm < 0) yNorm = 0;
    else if (yNorm > 1) yNorm = 1;
    const s = this.speed * gust * (0.55 + 0.45 * yNorm);
    let ox = (dxDir - dzDir * veer) * s;
    let oy = 0;
    let oz = (dzDir + dxDir * veer) * s;

    const count = this.activeBlasts;
    if (count > 0) {
      const pool = this.blastPool;
      for (let i = 0; i < count; i++) {
        const b = pool[i];
        if (excludeSourceId !== undefined && b.sourceId === excludeSourceId) continue;
        const dx = px - b.position.x, dy = py - b.position.y, dz = pz - b.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= b.curRadiusSq) continue;
        const dist = Math.sqrt(distSq) + 1e-3;
        const fall = 1 - dist * b.invCurRadius;
        if (fall <= 0) continue;
        const pushOverDist = (b.curStrength * fall * fall) / dist;
        ox += dx * pushOverDist;
        oy += dy * pushOverDist;
        oz += dz * pushOverDist;
      }
    }
    out.x = ox; out.y = oy; out.z = oz;
    return out;
  }

  /** TSL wind velocity (vec3, m/s) at a world position node. */
  node(position: N): N {
    const self = this;
    return Fn(() => {
      const d = self.uDirection;
      const along = position.x.mul(d.x).add(position.z.mul(d.y));
      const across = position.z.mul(d.x).sub(position.x.mul(d.y));
      const t = frame.time;
      const gust = float(1).add(self.uGust.mul(
        sin(t.mul(0.31).sub(along.mul(0.013))).mul(0.5)
          .add(sin(t.mul(0.73).sub(along.mul(0.031)).add(across.mul(0.027))).mul(0.3))
          .add(sin(t.mul(1.9).sub(along.mul(0.11)).add(across.mul(0.07))).mul(0.2))));
      const veer = self.uGust.mul(0.35).mul(sin(t.mul(0.23).add(across.mul(0.011)).sub(along.mul(0.008))));
      const shear = position.y.div(30).clamp(0, 1).mul(0.45).add(0.55);
      const s = self.uSpeed.mul(gust).mul(shear);
      const wind = vec3(d.x.sub(d.y.mul(veer)).mul(s), 0, d.y.add(d.x.mul(veer)).mul(s)).toVar();
      Loop({ start: int(0), end: self.uBlastCount, type: 'int', condition: '<', name: 'bi' }, ({ bi }: N) => {
        const pr = self.uBlastPosRadius.element(bi);
        const delta = position.sub(pr.xyz);
        const dist = length(delta).add(1e-3);
        const fall = float(1).sub(dist.div(pr.w).min(1));
        wind.addAssign(delta.div(dist).mul(self.uBlastStrength.element(bi)).mul(fall).mul(fall));
      });
      return wind;
    })();
  }

  /** Horizontal wind direction uniform (vec2) for shaders that only need the mean flow. */
  get directionNode(): N { return this.uDirection; }
  get speedNode(): N { return this.uSpeed; }
}

export { vec2 as _v2, max as _max, smoothstep as _ss, exp as _exp };
