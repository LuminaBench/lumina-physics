/**
 * Camera-facing ribbon trails: wingtip condensation vortices and contrails.
 * A fixed ring of points is aged on the CPU; the ribbon is expanded in the vertex shader.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { valueNoise3 } from '../../engine/noise';
import { frame, auxPassthrough, sunlightAtHeight } from '../../engine/frame';

const { Fn, float, vec3, vec4, uniform, attribute, cameraPosition, normalize, cross, mix, smoothstep, abs, pow } = TSL;

export interface TrailOptions {
  capacity?: number;
  /** Seconds a ribbon point lives. */
  life: number;
  /** Delay in seconds from release until condensate begins to appear. */
  formationSeconds?: number;
  /** Start / end width in metres. */
  width: number;
  widthEnd: number;
  /** Minimum distance between recorded points (m). */
  spacing?: number;
  opacity?: number;
}

export class TrailRibbon {
  readonly mesh: THREE.Mesh;
  /** 0..1 – multiplies opacity (fade vortices in with G-load / humidity). */
  intensity = 1;
  private capacity: number;
  /** Packed x, y, z, normalized age and strength, newest point at head. */
  private points: Float32Array;
  private runs: Uint32Array;
  private releasePositions: Float32Array;
  private rest: Float32Array;
  private releaseWind: Float32Array;
  private run = 0;
  private emitting = false;
  get hasSamples(): boolean { return this.count > 0; }
  /** Current outlet strength. Released points keep their individual strengths. */
  get emissionStrength(): number { return this.emitting ? this.points[this.head * 5 + 4] : 0; }
  private head = 0;
  private count = 0;
  private center: Float32Array;
  private tangent: Float32Array;
  private side: Float32Array;
  private age: Float32Array;
  private strength: Float32Array;
  private geometry: THREE.BufferGeometry;
  private uIntensity = uniform(1);
  private readonly datum = uniform(0);
  /** Set the world-space height of sea level for illumination during twilight. */
  setSeaLevel(y: number): void { if (this.datum.value !== y) this.datum.value = y; }
  private options: Required<TrailOptions>;

  constructor(options: TrailOptions) {
    const o = this.options = { capacity: 96, spacing: 4, opacity: 0.55, formationSeconds: 0, ...options };
    const n = this.capacity = Math.max(2, Math.floor(o.capacity));
    this.points = new Float32Array(n * 5);
    this.runs = new Uint32Array(n);
    this.releasePositions = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 6);
    this.releaseWind = new Float32Array(n * 3).fill(NaN);
    this.center = new Float32Array(n * 6);
    this.tangent = new Float32Array(n * 6);
    this.side = new Float32Array(n * 2);
    this.strength = new Float32Array(n * 2);
    this.age = new Float32Array(n * 2).fill(1);
    const index = new Uint16Array((n - 1) * 6);
    for (let i = 0; i < n; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
    for (let i = 0; i < n - 1; i++) index.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    const g = this.geometry = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rest, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('center', new THREE.BufferAttribute(this.center, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tangent3', new THREE.BufferAttribute(this.tangent, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('strength', new THREE.BufferAttribute(this.strength, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('side', new THREE.BufferAttribute(this.side, 1));
    g.setAttribute('age', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.forceSinglePass = true;
    material.side = THREE.DoubleSide;
    material.fog = false;
    const center = attribute('center', 'vec3'), tangent = attribute('tangent3', 'vec3');
    const side = attribute('side', 'float'), age = attribute('age', 'float');
    const toCamera = normalize(cameraPosition.sub(center));
    const perp = normalize(cross(tangent, toCamera).add(vec3(1e-5, 0, 0)));
    const width = mix(float(o.width), float(o.widthEnd), pow(age.clamp(0, 1), 0.6));
    material.positionNode = center.add(perp.mul(side).mul(width.mul(0.5)));
    const emitted = attribute('strength', 'float').toVarying('trailStrength');
    const sunlight = sunlightAtHeight(center.y.sub(this.datum)).toVarying('trailSunlight');
    const vCenter = center.toVarying('trailCenter');
    const vRelease = attribute('position', 'vec3').toVarying('trailReleasePosition');
    const vAge = age.toVarying('trailAge');
    const vSide = side.toVarying('trailSide');
    const uI = this.uIntensity;
    material.colorNode = Fn(() => {
      const eddy = valueNoise3(vRelease.mul(0.093).add(vec3(0.3, 0.5, 0.2).mul(vSide))).sub(0.5);
      const distance = abs(vSide.add(eddy.mul(vAge).mul(0.66)));
      const edge = smoothstep(0.96, 0.13, distance).mul(mix(1, eddy.add(0.68), vAge));
      const filament = smoothstep(0.39, 0.02, distance).mul(0.28).add(0.72);
      const onset = Math.max(0, o.formationSeconds) / o.life;
      const fade = smoothstep(onset, onset + 0.03, vAge).mul(pow(float(1).sub(vAge.clamp(0, 1)), 1.4));
      const toTrail = normalize(vCenter.sub(cameraPosition));
      const forward = TSL.dot(toTrail, frame.sunDirection).clamp(0, 1).pow(6);
      const lit = mix(frame.skyHorizon, frame.skyZenith, 0.5).mul(1.2)
        .add(sunlight.mul(frame.sunVisibility).mul(forward.mul(0.66).add(0.21)));
      return vec4(lit, edge.mul(filament).mul(fade).mul(emitted).mul(uI).mul(o.opacity));
    })();
    material.mrtNode = auxPassthrough();
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
  }

  /** Record the emitter position for this frame. `strength` 0 leaves a gap in the ribbon. */
  push(position: THREE.Vector3, strength = 1, wind?: THREE.Vector3, speedMps = 0): void {
    if (strength <= 0) { this.release(); return; }
    const P = this.points, n = this.capacity;
    // Budget distance per sample so a fast continuous trail reaches its authored lifetime.
    const spacing = Math.max(this.options.spacing, speedMps * this.options.life / Math.max(1, n - 2));
    // The front point moves between samples. Measure spacing from the *fixed* point
    // behind it; comparing with its previous frame would never advance a slow trail.
    if (this.count) {
      const o = this.head * 5;
      const dx = position.x - P[o], dy = position.y - P[o + 1], dz = position.z - P[o + 2];
      if (dx * dx + dy * dy + dz * dz > Math.max(96, this.options.spacing * 12) ** 2) this.release();
    }
    const starting = !this.emitting;
    if (starting) this.run++;
    this.emitting = true;
    let advance = starting || this.count < 2 || this.runs[(this.head + 1) % n] !== this.run;
    if (!advance) {
      const fixed = ((this.head + 1) % n) * 5;
      const oldHead = this.head * 5;
      const x = P[oldHead] - P[fixed], y = P[oldHead + 1] - P[fixed + 1], z = P[oldHead + 2] - P[fixed + 2];
      advance = x * x + y * y + z * z >= spacing ** 2;
    }
    if (advance) {
      this.head = (this.head + n - 1) % n;
      this.count = Math.min(n, this.count + 1);
    }
    const o = this.head * 5;
    P[o] = position.x; P[o + 1] = position.y; P[o + 2] = position.z;
    P[o + 3] = 0; P[o + 4] = strength;
    this.runs[this.head] = this.run;
    const w = this.head * 3;
    this.releasePositions[w] = position.x; this.releasePositions[w + 1] = position.y; this.releasePositions[w + 2] = position.z;
    this.releaseWind[w] = wind?.x ?? NaN;
    this.releaseWind[w + 1] = wind?.y ?? 0;
    this.releaseWind[w + 2] = wind?.z ?? 0;
  }

  /** Detach the last sample. A later emission starts a separate strip. */
  release(): void { this.emitting = false; }

  update(dt: number, driftX = 0, driftZ = 0, driftY = 0): void {
    this.uIntensity.value = this.intensity;
    const P = this.points, n = this.capacity;
    const aging = dt / this.options.life;
    for (let i = this.emitting ? 1 : 0; i < this.count; i++) {
      const slot = (this.head + i) % n, offset = slot * 5, w = slot * 3;
      const sampled = Number.isFinite(this.releaseWind[w]);
      P[offset] += (sampled ? this.releaseWind[w] : driftX) * dt;
      P[offset + 1] += ((sampled ? this.releaseWind[w + 1] : 0) + driftY) * dt;
      P[offset + 2] += (sampled ? this.releaseWind[w + 2] : driftZ) * dt;
      P[offset + 3] += aging;
    }
    while (this.count > 0 && P[((this.head + this.count - 1) % n) * 5 + 3] >= 1) this.count--;
    const indices = this.geometry.index!;
    let changed = false, used = 0;
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head + i) % n, o = slot * 5;
      const a = ((this.head + Math.max(i - 1, 0)) % n) * 5;
      const b = ((this.head + Math.min(i + 1, this.count - 1)) % n) * 5;
      const before = this.runs[a / 5] === this.runs[slot] ? a : o;
      const after = this.runs[b / 5] === this.runs[slot] ? b : o;
      if (after !== o) {
        const v = i * 2;
        if (indices.array[used] !== v) {
          indices.array[used] = v; indices.array[used + 1] = v + 1; indices.array[used + 2] = v + 2;
          indices.array[used + 3] = v + 1; indices.array[used + 4] = v + 3; indices.array[used + 5] = v + 2;
          changed = true;
        }
        used += 6;
      }
      const dx = P[before] - P[after], dy = P[before + 1] - P[after + 1], dz = P[before + 2] - P[after + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const inv = length > 1e-7 ? 1 / length : 0;
      const age = P[o + 3];
      for (let side = 0; side < 2; side++) {
        const vertex = i * 2 + side, offset = vertex * 3;
        const birth = slot * 3;
        this.rest[offset] = this.releasePositions[birth]; this.rest[offset + 1] = this.releasePositions[birth + 1]; this.rest[offset + 2] = this.releasePositions[birth + 2];
        this.center[offset] = P[o]; this.center[offset + 1] = P[o + 1]; this.center[offset + 2] = P[o + 2];
        this.tangent[offset] = dx * inv; this.tangent[offset + 1] = dy * inv; this.tangent[offset + 2] = inv ? dz * inv : 1;
        this.age[vertex] = age;
        this.strength[vertex] = P[o + 4];
      }
    }
    if (changed) indices.needsUpdate = true;
    this.geometry.setDrawRange(0, used);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.center.needsUpdate = true;
    this.geometry.attributes.tangent3.needsUpdate = true;
    this.geometry.attributes.age.needsUpdate = true;
    this.geometry.attributes.strength.needsUpdate = true;
  }

  clear(): void { this.emitting = false; this.count = 0; this.geometry.setDrawRange(0, 0); }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export type { N as _N };
