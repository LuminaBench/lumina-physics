/**
 * Interactive 2D wave + foam field.
 *
 * A scrolling GPU heightfield (damped wave equation) centred on the action. Moving hulls,
 * jet downwash, tire slams and explosions inject pressure / impulse / foam "sources";
 * the field answers with propagating ripples, V-wakes (half-angle asin(c / U): `waveSpeed`
 * is steered to U·sin 19.47° so the wake matches the Kelvin angle of the tracked vessel),
 * depressed pressure troughs and persistent, slowly diffusing aerated foam.
 *
 * Implemented as render-target ping-pong so it runs identically on WebGPU and WebGL 2.
 */
import * as THREE from 'three/webgpu';
import { WaveProbeGrid } from './wave-probe';
import { TSL, type N } from '../../engine/tsl';

const { Fn, Loop, int, float, vec2, vec4, uniform, uniformArray, texture, uv, exp, min, max, dot, smoothstep, abs, select } = TSL;

const MAX_SOURCES = 16;
/** Floats per queued source in `InteractionField.sources`: [x, z, radius, push, impulse, foam, annular fraction]. */
export const SOURCE_STRIDE = 7;
export const KELVIN_SIN = Math.sin(THREE.MathUtils.degToRad(19.47));

export interface FieldSource {
  x: number; z: number;
  radius: number;
  /** Continuous vertical acceleration of the surface in m/s² (negative = pressure trough). */
  push?: number;
  /** One-frame height impulse in metres (splashes, blast rings). */
  impulse?: number;
  /** Foam injected per second (0..~8). */
  foam?: number;
  /** A radial outflow returns displaced water and white spray around its rim. */
  annular?: number;
}

export class InteractionField {
  readonly center = new THREE.Vector2();
  /** Ripple phase speed in m/s. */
  waveSpeed = 5;
  damping = 0.22;
  foamDecay = 0.16;
  private targets: [THREE.RenderTarget, THREE.RenderTarget];
  private index = 0;
  private quad: THREE.QuadMesh;
  /**
   * Pooled flat source buffer: [x, z, radius, push, impulse, foam, annular fraction] × MAX_SOURCES.
   * Write only into a slot handed out by `reserveSource` for the current frame.
   */
  readonly sources = new Float32Array(MAX_SOURCES * SOURCE_STRIDE);
  /** Views of each slot's [x, z, radius, push] and [impulse, foam, annular] for block copies to the GPU buffers. */
  private readonly sourceHeads: Float32Array[] = [];
  private readonly sourceTails: Float32Array[] = [];
  private pendingCount = 0;
  private readonly priority = new Uint8Array(MAX_SOURCES);
  /** Resolved only for externally disturbed water. Purely visual wakes retain their cheap path. */
  private probes?: WaveProbeGrid;
  addProbeHeights(xz:Float64Array,heights:Float64Array):void { this.probes?.addHeights(xz,heights); }
  sampleHeight(x:number,z:number):number { return this.probes?.sample(x,z) ?? 0; }
  sampleVerticalSpeed(x:number,z:number):number { return this.probes?.sample(x,z,1) ?? 0; }
  private clearFrames = 2;
  private activeTimer = 0;
  private readonly cell: number;
  private readonly invExtent: number;
  private readonly halfExtent: number;
  private readonly minRadius: number;
  private previousNode: N;
  private stateNode: N;
  private u = {
    shift: uniform(new THREE.Vector2()),
    center: uniform(new THREE.Vector2()),
    dt: uniform(1 / 60),
    c2: uniform(25),
    damping: uniform(0.22),
    foamDecay: uniform(0.16),
    count: uniform(0),
    srcA: TSL.buffer(new Float32Array(MAX_SOURCES*4),'vec4',MAX_SOURCES),
    srcB: TSL.buffer(new Float32Array(MAX_SOURCES*4),'vec4',MAX_SOURCES),
  };
  /** Uniforms for sampling from other materials. */
  readonly uCenter = uniform(new THREE.Vector2());
  readonly uExtent: N;

  constructor(private renderer: THREE.WebGPURenderer, readonly resolution: number, readonly extent: number) {
    this.cell = extent / resolution;
    this.invExtent = 1 / extent;
    this.halfExtent = extent * 0.5;
    // Sources are stored as float32, so the floor is compared in float32 too: flooring the stored
    // radius against this value gives the same result as flooring the double before storing it.
    this.minRadius = Math.fround(this.cell * 1.5);
    for (let o = 0; o < this.sources.length; o += SOURCE_STRIDE) {
      this.sourceHeads.push(this.sources.subarray(o, o + 4));
      this.sourceTails.push(this.sources.subarray(o + 4, o + SOURCE_STRIDE));
    }
    const make = () => {
      const rt = new THREE.RenderTarget(resolution, resolution, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.targets = [make(), make()];
    this.uExtent = uniform(extent);
    this.previousNode = texture(this.targets[0].texture);
    this.stateNode = texture(this.targets[0].texture);

    const u = this.u;
    const texel = 1 / resolution;
    const cell = this.cell;
    const prev = this.previousNode;
    const material = new THREE.NodeMaterial();
    material.fragmentNode = Fn(() => {
      const st = uv();
      const p = st.add(u.shift);
      const inside = select(p.x.greaterThan(0).and(p.x.lessThan(1)).and(p.y.greaterThan(0)).and(p.y.lessThan(1)), float(1), float(0));
      const s = prev.sample(p);
      const l = prev.sample(p.add(vec2(-texel, 0)));
      const r = prev.sample(p.add(vec2(texel, 0)));
      const d = prev.sample(p.add(vec2(0, -texel)));
      const t = prev.sample(p.add(vec2(0, texel)));
      const h = s.r.toVar();
      const v = s.g.toVar();
      const lap = l.r.add(r.r).add(d.r).add(t.r).sub(h.mul(4));
      v.addAssign(lap.mul(u.c2).mul(u.dt).div(cell * cell));
      v.mulAssign(exp(u.damping.mul(u.dt).negate()));
      h.addAssign(v.mul(u.dt));
      // Foam: decay, gentle diffusion (wakes widen and merge), plus steep-ripple breaking.
      const foam = mix4(s.b, l.b, r.b, d.b, t.b).mul(exp(u.foamDecay.mul(u.dt).negate())).toVar();
      foam.addAssign(max(abs(lap).mul(9).sub(0.55), 0).mul(u.dt).mul(2.5));
      const calm = s.a.mul(exp(u.dt.mul(-1.45))).toVar();
      const world = u.center.add(st.sub(0.5).mul(extent));
      Loop({ start: int(0), end: int(u.count), type: 'int', condition: '<', name: 'si' }, ({ si }: N) => {
        const a = u.srcA.element(si);
        const b = u.srcB.element(si);
        const delta = world.sub(a.xy);
        const q = dot(delta, delta).div(a.z.mul(a.z));
        const g = exp(q.mul(-2.5));
        const rimDistance=q.sub(1);
        const annulus = exp(rimDistance.mul(rimDistance).mul(-6)).mul(b.z);
        calm.assign(max(calm,g.mul(b.z).mul(abs(a.w).mul(0.18).clamp(0,1))));
        // Integral of the return flow balances the core; quiet water remains in the centre.
        const force = g.sub(annulus.mul(0.555));
        v.addAssign(a.w.mul(force).mul(u.dt));
        h.addAssign(b.x.mul(g));
        foam.addAssign(b.y.mul(g.mul(float(1).sub(b.z)).add(annulus)).mul(u.dt));
      });
      // Absorbing border so reflections never bounce back into view.
      const edge = smoothstep(0.0, 0.05, min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y))));
      return vec4(h.mul(edge).mul(inside), v.mul(edge).mul(inside), foam.min(4).mul(inside), calm.mul(inside));
    })();
    this.quad = new THREE.QuadMesh(material);
  }

  /** Queue a source for this frame (copied into the internal pool; callers may reuse `source`). */
  addSource(source: FieldSource, worldPressure = false): void {
    const o = this.reserveSource(worldPressure);
    if (o < 0) return;
    const buf = this.sources;
    buf[o] = source.x;
    buf[o + 1] = source.z;
    buf[o + 2] = source.radius;
    buf[o + 3] = source.push ?? 0;
    buf[o + 4] = source.impulse ?? 0;
    buf[o + 5] = source.foam ?? 0;
    buf[o + 6] = source.annular ?? 0;
  }

  /**
   * Reserve a slot for one source this frame and return its offset into `sources`, or -1 when
   * the pool is full. The caller writes all `SOURCE_STRIDE` floats itself, so an emitter that
   * runs every frame hands its numbers over without routing them through object fields (each
   * field read boxes a number in unoptimised code, and in optimised code too once `addSource`
   * has seen more object shapes than an inline cache holds). Radii below the field's resolvable
   * minimum are raised in `update`.
   */
  reserveSource(worldPressure = false): number {
    let idx = this.pendingCount;
    if (idx >= MAX_SOURCES) {
      if (!worldPressure) return -1;
      // A busy vessel can fill all ordinary wake slots. Keep the world pressure
      // forcing by replacing the last secondary wake before dropping a field emitter.
      idx = this.priority.lastIndexOf(0);
      if (idx < 0) return -1;
    } else {
      this.pendingCount = idx + 1;
    }
    if (worldPressure) this.probes ??= new WaveProbeGrid(this.extent);
    this.priority[idx] = worldPressure ? 1 : 0;
    return idx * SOURCE_STRIDE;
  }

  /** Steer ripple speed so a vessel moving at `speed` leaves a Kelvin-angle wake. */
  matchKelvin(speed: number): void {
    this.waveSpeed = THREE.MathUtils.clamp(speed * KELVIN_SIN, 2.2, 9);
  }

  update(dt: number, focus: { x: number; z: number }): void {
    const cell = this.cell, invExtent = this.invExtent, center = this.center;
    // Snap the window to whole texels so the scrolled copy is exact (no blur creep).
    const cx = Math.round(focus.x / cell) * cell;
    const cz = Math.round(focus.z / cell) * cell;
    const shiftX = (cx - center.x) * invExtent;
    const shiftZ = (cz - center.y) * invExtent;
    center.x = cx; center.y = cz;

    // Filter queued sources against the active field window (cull far out-of-bounds sources).
    const u = this.u;
    const buf = this.sources, a: Float32Array = u.srcA.value, b: Float32Array = u.srcB.value;
    const heads = this.sourceHeads, tails = this.sourceTails;
    const halfExtent = this.halfExtent, minRadius = this.minRadius;
    const pending = this.pendingCount;
    let count = 0;
    for (let i = 0; i < pending; i++) {
      const o = i * SOURCE_STRIDE;
      let sr = buf[o + 2];
      if (!(sr > minRadius)) buf[o + 2] = sr = minRadius;
      const reach = halfExtent + sr * 3, far = -reach;
      const dx = buf[o] - cx, dz = buf[o + 1] - cz;
      if (dx > reach || dx < far || dz > reach || dz < far) continue;
      // Block copies: reading the seven floats back one by one would box each of them.
      a.set(heads[i], count * 4);
      b.set(tails[i], count * 4);
      count++;
    }
    this.pendingCount = 0;

    // Each double field is read once per frame; a repeated read is a repeated boxing.
    let activeTimer = this.activeTimer;
    let damping = 0, foamDecay = 0;
    if (count > 0) {
      damping = this.damping;
      foamDecay = this.foamDecay;
      // Math.min(Math.max(damping, 0.05), Math.max(foamDecay, 0.05)) as selects (NaN included):
      // a select hands back one of its operands, while each Math call boxes a fresh result.
      const slow = damping > 0.05 || damping !== damping ? damping : 0.05;
      const fade = foamDecay > 0.05 || foamDecay !== foamDecay ? foamDecay : 0.05;
      const settle = 5.5 / (slow < fade || slow !== slow ? slow : fade);
      if (settle > activeTimer) this.activeTimer = activeTimer = settle;
    }

    // Skip the GPU pass when both ping-pong buffers are already zeroed and quiescent,
    // or when nothing can change (dt === 0 with no sources and no scroll).
    if (this.clearFrames === 0 && count === 0 && (activeTimer <= 0 || (dt <= 0 && shiftX === 0 && shiftZ === 0))) {
      (this.uCenter.value as THREE.Vector2).copy(center);
      return;
    }
    if (count === 0) {
      damping = this.damping;
      foamDecay = this.foamDecay;
    }

    const shift = u.shift.value as THREE.Vector2;
    shift.x = shiftX; shift.y = shiftZ;
    (u.center.value as THREE.Vector2).copy(center);
    // CFL limit for the explicit scheme.
    const step = dt > 1 / 30 ? 1 / 30 : dt;
    const cMax = (0.68 * cell) / (step > 1e-4 ? step : 1e-4);
    const waveSpeed = this.waveSpeed;
    const c = waveSpeed < cMax ? waveSpeed : cMax;
    const c2 = c * c;
    this.probes?.step(step,cx,cz,c,damping,buf,pending);
    // Number uniforms hold tagged values, so storing an unchanged number would still box it.
    if (u.dt.value !== step) u.dt.value = step;
    if (u.c2.value !== c2) u.c2.value = c2;
    if (u.damping.value !== damping) u.damping.value = damping;
    if (u.foamDecay.value !== foamDecay) u.foamDecay.value = foamDecay;
    if (u.count.value !== count) u.count.value = count;

    const read = this.targets[this.index], write = this.targets[1 - this.index];
    this.previousNode.value = read.texture;
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(write);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(previous);
    this.index = 1 - this.index;
    this.stateNode.value = write.texture;
    (this.uCenter.value as THREE.Vector2).copy(center);

    if (this.clearFrames > 0) this.clearFrames--;
    if (activeTimer > 0 && step > 0) {
      activeTimer -= step;
      this.activeTimer = activeTimer < 0 ? 0 : activeTimer;
    }
  }

  /** TSL: field state (height, velocity, foam, insideMask) at a world XZ position. */
  sample(worldXZ: N, includeCalmness = false): N {
    const st = worldXZ.sub(this.uCenter).div(this.uExtent).add(0.5);
    const inside = smoothstep(0.0, 0.03, min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y))));
    const s = this.stateNode.sample(st);
    return vec4(s.r.mul(inside), s.g.mul(inside), s.b.mul(inside), includeCalmness?s.a.mul(inside):inside);
  }

  /** TSL: height sampled in the vertex stage (explicit LOD). */
  heightVertex(worldXZ: N): N {
    const st = worldXZ.sub(this.uCenter).div(this.uExtent).add(0.5);
    const inside = smoothstep(0.0, 0.03, min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y))));
    return this.stateNode.sample(st).level(0).r.mul(inside);
  }

  /** TSL: surface slope (dh/dx, dh/dz) from central differences. */
  slope(worldXZ: N): N {
    const st = worldXZ.sub(this.uCenter).div(this.uExtent).add(0.5);
    const texel = 1 / this.resolution;
    const cell = this.extent / this.resolution;
    const inside = smoothstep(0.0, 0.03, min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y))));
    const hx = this.stateNode.sample(st.add(vec2(texel, 0))).r.sub(this.stateNode.sample(st.sub(vec2(texel, 0))).r);
    const hz = this.stateNode.sample(st.add(vec2(0, texel))).r.sub(this.stateNode.sample(st.sub(vec2(0, texel))).r);
    return vec2(hx, hz).div(cell * 2).mul(inside);
  }

  dispose(): void {
    this.targets[0].dispose();
    this.targets[1].dispose();
    (this.quad.material as THREE.Material).dispose();
  }
}

function mix4(c: N, l: N, r: N, d: N, t: N): N {
  return c.mul(0.82).add(l.add(r).add(d).add(t).mul(0.045));
}
