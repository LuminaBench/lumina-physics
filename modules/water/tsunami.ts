/**
 * Adaptive tsunami / mega-wave system.
 *
 * A parametric solitary wave that rides on top of the FFT ocean: asymmetric sech² profile
 * (steep leading face, long elevated bore behind), a leading drawdown trough, bathymetry-
 * aware shoaling (Green's law) and a breaking parameter that rolls the crest forward into
 * an overhanging plunging lip. The identical profile is implemented for the GPU
 * (`deform`) and the CPU (`heightAt` / `flowAt`) so vessels are lifted and thrown by
 * exactly the wave you see.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

const { uniform, float, vec2, vec3, dot, sin, cosh, exp, mix, smoothstep, max, min, select, pow } = TSL;

export interface TsunamiProfile {
  /** Crest height above mean sea level in metres. */
  height: number;
  /** Characteristic half-width of the wave in metres. */
  width: number;
  /** Direction of travel in radians (0 = +X). */
  direction: number;
  /** Phase speed in m/s (deep-water tsunamis are fast; near shore √(g·d)). */
  speed: number;
  /** 0 = smooth swell-like hump, 1 = fully plunging breaker. */
  breaking: number;
}

export const TSUNAMI_PRESETS: Record<string, TsunamiProfile> = {
  rogue: { height: 14, width: 34, direction: 0, speed: 16, breaking: 0.35 },
  breakingWall: { height: 24, width: 46, direction: 0, speed: 19, breaking: 0.9 },
  megaTsunami: { height: 42, width: 80, direction: 0, speed: 24, breaking: 0.75 },
};

const sech2 = (x: number) => { const c = Math.cosh(Math.max(-20, Math.min(20, x))); return 1 / (c * c); };

export class Tsunami {
  readonly profile: TsunamiProfile = { ...TSUNAMI_PRESETS.breakingWall };
  /** Signed distance of the crest along the travel direction (metres from the origin). */
  front = -1e5;
  /** 0..1 master amplitude (ramps in/out so toggling never pops). */
  amplitude = 0;
  running = false;
  private targetAmplitude = 0;
  private sampledCrest = 0;

  readonly uniforms = {
    height: uniform(0),
    width: uniform(40),
    direction: uniform(new THREE.Vector2(1, 0)),
    front: uniform(-1e5),
    breaking: uniform(0.5),
  };

  /** Start a wave whose crest begins `distance` metres up-wave of `target`. */
  launch(target: { x: number; z: number }, distance: number, profile?: Partial<TsunamiProfile>): void {
    Object.assign(this.profile, profile);
    const dx = Math.cos(this.profile.direction), dz = Math.sin(this.profile.direction);
    this.uniforms.direction.value.set(dx, dz);
    this.front = target.x * dx + target.z * dz - distance;
    this.running = true;
    this.targetAmplitude = 1;
  }

  stop(): void { this.targetAmplitude = 0; }

  get active(): boolean { return this.amplitude > 0.002; }

  update(dt: number): void {
    if (!this.running && !this.amplitude) return;
    this.amplitude += (this.targetAmplitude - this.amplitude) * Math.min(1, dt * 1.6);
    if (this.targetAmplitude === 0 && this.amplitude < 0.002) { this.amplitude = 0; this.running = false; }
    if (this.running) this.front += this.profile.speed * dt;
    const u = this.uniforms;
    u.height.value = this.profile.height * this.amplitude;
    u.width.value = this.profile.width;
    (u.direction.value as THREE.Vector2).set(Math.cos(this.profile.direction), Math.sin(this.profile.direction));
    u.front.value = this.front;
    u.breaking.value = this.profile.breaking;
  }

  /** Coefficients shared by the rendered sheet and all queries at one lateral station. */
  private directionAngle = NaN;
  get direction(): THREE.Vector2 {
    if (this.directionAngle !== this.profile.direction) {
      this.directionAngle = this.profile.direction;
      this.uniforms.direction.value.set(Math.cos(this.directionAngle), Math.sin(this.directionAngle));
    }
    return this.uniforms.direction.value;
  }

  private sectionAmplitude = 0;
  private breaking = 0;
  private frontWidth = 1;
  private restStation(x: number, z: number, depth: number): number {
    const p = this.profile, dir = this.direction;
    const cross = -x * dir.y + z * dir.x;
    const shoal = Math.min(1.8, Math.max(1, (60 / Math.max(depth, 2)) ** 0.25));
    const H = this.sectionAmplitude = p.height * this.amplitude * shoal *
      (1 + 0.16 * Math.sin(cross * 0.017 + 0.5) + 0.06 * Math.sin(cross * 0.083 + 0.9));
    const fold = 0.73 + 0.27 * Math.sin(cross * 0.043 + 1.4) * Math.cos(cross * 0.013);
    this.breaking = fold * Math.max(p.breaking, THREE.MathUtils.smoothstep(H / Math.max(depth, 0.5), 0.45, 0.95));
    this.frontWidth = p.width * (0.6 - 0.36 * this.breaking);
    return x * dir.x + z * dir.y - this.front + p.width *
      (0.12 * Math.sin(cross * 0.011 + 1.3) + 0.06 * Math.sin(cross * 0.037 + 0.4));
  }

  private throwAt(s: number): number {
    const crest = sech2(s / (s > 0 ? this.frontWidth : this.profile.width * 1.6));
    return this.sectionAmplitude * this.breaking * THREE.MathUtils.smoothstep(crest, 0.42, 1) * (0.62 + 0.75 * crest);
  }

  private invertStation(s: number): number {
    const maxThrow = this.sectionAmplitude * this.breaking * 1.37;
    if (maxThrow < 1e-4 || s < -1.6 * this.profile.width * 1.1 || s > maxThrow + 1.1 * this.frontWidth) return s;
    // On the folded part the trailing branch is the exposed upper surface.
    // Bracket it at the crest, so successive queries cannot oscillate between
    // the underside and the top as a fixed-point iteration can.
    if (Math.abs(s - maxThrow) < 1e-5) return 0;
    let lo = s - maxThrow, hi = s <= maxThrow ? Math.min(0, s) : s;
    const extent = 0.5662 * this.frontWidth;
    const ratio = this.sectionAmplitude * this.breaking / this.frontWidth;
    // The forward-throw derivative is steepest at s/wf = 0.5662. If the
    // projection folds, locate its first turning point to keep the thin toe.
    if (s > maxThrow && s < maxThrow + extent && ratio * 2.595756 > 1) {
      let a = 0, z = extent;
      for (let i = 0; i < 9; i++) {
        const m = (a + z) * 0.5, t = Math.tanh(m / this.frontWidth), c = 1 - t * t;
        const u = (c - 0.42) / 0.58, blend = u * u * (3 - 2 * u);
        const gradient = 2 * c * t * ratio * (0.75 * blend + (0.62 + 0.75 * c) * 6 * u * (1 - u) / 0.58);
        if (gradient < 1) a = m; else z = m;
      }
      const peak = 0.5 * (a + z);
      if (s <= peak + this.throwAt(peak)) hi = peak; else lo = Math.max(lo, extent);
    }
    for (let i = 0; i < 10; i++) {
      const m = (lo + hi) * 0.5;
      if (m + this.throwAt(m) < s) lo = m; else hi = m;
    }
    return 0.5 * (hi + lo);
  }

  /** Signed horizontal correction to recover the mesh coordinate from a world point. */
  restOffset(x: number, z: number, depth: number): number {
    const s = this.restStation(x, z, depth);
    return this.invertStation(s) - s;
  }

  private elevation(s: number): number {
    const width = this.profile.width, wb = width * 1.6, wf = this.frontWidth;
    const crest = this.sampledCrest = sech2(s / (s > 0 ? wf : wb));
    const bore = s < 0 ? 0.3 * (1 - THREE.MathUtils.smoothstep(s, -2.5 * wb, 0.4 * wb)) * Math.exp(s / (12 * width)) : 0;
    const trough = -0.1 * Math.exp(-(((s - 2.4 * wf) / (1.6 * wf)) ** 2));
    const lip = this.breaking * THREE.MathUtils.smoothstep(crest, 0.42, 1);
    return this.sectionAmplitude * (Math.max(crest, bore) + trough - lip * lip * 0.2);
  }

  heightAtRest(x: number, z: number, depth: number): number {
    return this.elevation(this.restStation(x, z, depth));
  }

  /** Actual water surface elevation at world XZ, including the falling lip. */
  heightAt(x: number, z: number, depth = 200): number {
    return this.elevation(this.invertStation(this.restStation(x, z, depth)));
  }

  /**
   * Horizontal particle velocity of the water under the wave (m/s). Solitary-wave theory:
   * u ≈ c·η / (d + η); near the breaking crest water moves at the full phase speed.
   */
  flowAt(x: number, z: number, depth: number, out = new THREE.Vector3()): THREE.Vector3 {
    const eta = this.heightAt(x, z, depth);
    const crest = this.sampledCrest;
    const p = this.profile;
    const d = Math.max(Math.min(depth, 40), 2);
    const u = Math.min(p.speed, (p.speed * Math.max(eta, 0)) / (d + Math.max(eta, 0)) + p.speed * p.breaking * crest * crest * 0.8);
    return out.set(this.direction.x * u, 0, this.direction.y * u);
  }

  /** Undisplaced horizontal position used to locate the seabed beneath a crest station. */
  crestBase(cross: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.profile;
    const dx = Math.cos(p.direction), dz = Math.sin(p.direction);
    const wobble = 0.12 * p.width * Math.sin(cross * 0.011 + 1.3) + 0.06 * p.width * Math.sin(cross * 0.037 + 0.4);
    const s = this.front - wobble;
    return out.set(dx * s - dz * cross, 0, dz * s + dx * cross);
  }

  /** Position of the rendered, shoaled and overturned lip at a lateral station. */
  crestPoint(cross: number, out = new THREE.Vector3(), depth = 200): THREE.Vector3 {
    this.crestBase(cross, out);
    this.restStation(out.x, out.z, depth);
    const forward = this.throwAt(0), dir = this.direction;
    return out.set(out.x + dir.x * forward, this.elevation(0), out.z + dir.y * forward);
  }

  private sectionNode(p: N, depth: N) {
    const u = this.uniforms;
    const dir = u.direction;
    const cross = p.y.mul(dir.x).sub(p.x.mul(dir.y));
    const s = dot(p, dir).sub(u.front)
      .add(u.width.mul(0.12).mul(sin(cross.mul(0.011).add(1.3))))
      .add(u.width.mul(0.06).mul(sin(cross.mul(0.037).add(0.4))));
    const shoal = pow(float(60).div(max(depth, 2)), 0.25).clamp(1, 1.8);
    const H = u.height.mul(sin(cross.mul(0.017).add(0.5)).mul(0.16)
      .add(sin(cross.mul(0.083).add(0.9)).mul(0.06)).add(1)).mul(shoal);
    const fold = sin(cross.mul(0.043).add(1.4)).mul(TSL.cos(cross.mul(0.013))).mul(0.27).add(0.73);
    const b = fold.mul(max(u.breaking, smoothstep(0.45, 0.95, H.div(max(depth, 0.5)))));
    const wf = u.width.mul(mix(0.6, 0.24, b));
    const wb = u.width.mul(1.6);
    return { s, H, b, wf, wb };
  }

  /** Invert the same folded surface used by hull probes at a waterline pixel. */
  restOffsetNode(p: N, depth: N): N {
    return TSL.Fn(() => {
      const { s, H, b, wf, wb } = this.sectionNode(p, depth);
      const span = H.mul(b).mul(1.37);
      const result = float(0).toVar();
      TSL.If(span.greaterThan(1e-4).and(s.greaterThanEqual(wb.mul(-1.1))).and(s.lessThanEqual(span.add(wf.mul(1.1)))), () => {
        const lo = s.sub(span).toVar(), hi = select(s.lessThanEqual(span), min(s, 0), s).toVar();
        const extent = wf.mul(0.5662), ratio = H.mul(b).div(wf);
        TSL.If(s.greaterThan(span).and(s.lessThan(span.add(extent))).and(ratio.mul(2.595756).greaterThan(1)), () => {
          const a = float(0).toVar(), z = extent.toVar();
          TSL.Loop(9, () => {
            const m = a.add(z).mul(0.5).toVar(), t = TSL.tanh(m.div(wf)), c = float(1).sub(t.mul(t));
            const u = c.sub(0.42).div(0.58), blend = u.mul(u).mul(float(3).sub(u.mul(2)));
            const gradient = c.mul(t).mul(ratio).mul(2).mul(blend.mul(0.75).add(c.mul(0.75).add(0.62).mul(u).mul(u.oneMinus()).mul(6 / 0.58)));
            TSL.If(gradient.lessThan(1), () => { a.assign(m); }).Else(() => { z.assign(m); });
          });
          const peak = a.add(z).mul(0.5), ch = cosh(peak.div(wf)), c = float(1).div(ch.mul(ch));
          const limit = peak.add(H.mul(b).mul(smoothstep(0.42, 1, c)).mul(c.mul(0.75).add(0.62)));
          TSL.If(s.lessThanEqual(limit), () => { hi.assign(peak); }).Else(() => { lo.assign(max(lo, extent)); });
        });
        TSL.Loop(10, () => {
          const m = lo.add(hi).mul(0.5).toVar();
          const c = cosh(m.div(select(m.greaterThan(0), wf, wb)).clamp(-20, 20));
          const crest = float(1).div(c.mul(c));
          const travel = H.mul(b).mul(smoothstep(0.42, 1, crest)).mul(crest.mul(0.75).add(0.62));
          TSL.If(m.add(travel).lessThan(s), () => { lo.assign(m); }).Else(() => { hi.assign(m); });
        });
        result.assign(select(TSL.abs(s.sub(span)).lessThan(1e-5), s.negate(), lo.add(hi).mul(0.5).sub(s)));
      });
      return result;
    })();
  }

  /**
   * TSL deformation at undisplaced world XZ `p` with local water depth `depth`.
   * Returns nodes: `offset` (vec3 world displacement), `crest` (0..1 normalised crest
   * height), `lip` (0..1 overturning amount), `behind` (0..1 turbulent bore zone), `s` (signed
   * distance ahead of the crest in metres).
   */
  deform(p: N, depth: N): { offset: N; crest: N; lip: N; behind: N; s: N } {
    const { s, H, b, wf, wb } = this.sectionNode(p, depth);
    const u = this.uniforms, dir = u.direction;
    const ahead = s.greaterThan(0);
    const arg = s.div(select(ahead, wf, wb)).clamp(-20, 20);
    const ch = cosh(arg);
    const crest = float(1).div(ch.mul(ch));
    const bore = select(ahead, float(0), float(0.3).mul(float(1).sub(smoothstep(wb.mul(-2.5), wb.mul(0.4), s))).mul(exp(s.div(u.width.mul(12)))));
    const troughArg = s.sub(wf.mul(2.4)).div(wf.mul(1.6));
    const trough = exp(troughArg.mul(troughArg).negate()).mul(-0.1);
    const eta = H.mul(max(crest, bore).add(trough));
    // Plunging lip: the upper part of the crest is thrown forward and starts to fall.
    const lip = b.mul(smoothstep(0.42, 1.0, crest));
    const forward = lip.mul(H).mul(crest.mul(0.75).add(0.62));
    const drop = lip.mul(lip).mul(H).mul(0.2);
    const offset = vec3(dir.x.mul(forward), eta.sub(drop), dir.y.mul(forward));
    const behind = select(ahead, float(0), b.mul(exp(s.div(u.width.mul(5)))).mul(smoothstep(0.0, wb.mul(-0.6), s).mul(0.75).add(0.25)));
    return { offset, crest, lip, behind, s };
  }
}

export { vec2 as _v2, min as _min };
