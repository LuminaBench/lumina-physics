/**
 * Wet-lens effects: screen-space water on the camera glass.
 *
 *   beads     static droplets that swell, sit and evaporate; each one is a tiny fisheye that
 *             shows the scene inverted (refraction offset toward the droplet centre)
 *   runners   heavier drops that slide down in stick-slip motion and leave a thin trail
 *   sheet     the film of water that pours off the lens after surfacing or a direct splash
 *
 * Everything is procedural (hashed cells, no textures) and is inlined into the pipeline's
 * final pass through the `distort` / `lens` hooks, so it costs no render target; a dry lens
 * costs one uniform branch. Density follows `wetness`, which eases toward `rain` and jumps
 * on `splash()`. The tier decides how many layers exist: none on Low, beads on Medium,
 * beads + runners from High.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';
import { frame } from './frame';
import { hash22 } from './noise';
import type { LuminaPipeline } from './pipeline';
import type { QualityPreset } from './quality';

const { Fn, If, float, vec2, uniform, floor, fract, length, smoothstep, sin, mix, abs } = TSL;

const _v = new THREE.Vector3();

export class LensFx {
  /** Master switch. Off removes the effect from the pipeline entirely. */
  private _enabled = true;
  /** 0..1 continuous wetting (rain falling on the lens, sustained spray). Set every frame or once. */
  rain = 0;
  /** Current wetness 0..1 (eases toward `rain`, jumps on `splash`). */
  wetness = 0;
  /** Seconds for a soaked lens to dry once nothing wets it. */
  dryTime = 5;
  /** Overall refraction strength. */
  strength = 1;

  private sheet = 0;
  private layers = 2;
  private uWet = uniform(0);
  private uSheet = uniform(0);
  private uAspect = uniform(16 / 9);
  private uStrength = uniform(1);
  private field: N = null;

  constructor(private pipeline: LuminaPipeline, private camera: THREE.PerspectiveCamera) {}

  get enabled(): boolean { return this._enabled; }
  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this.attach();
  }

  /** Wet the lens at once (0..1): a wave over the bow, a geyser, tire spray in the face. */
  splash(amount = 1): void {
    this.wetness = Math.max(this.wetness, Math.min(1, amount));
    if (amount > 0.6) this.sheet = Math.max(this.sheet, (amount - 0.6) * 2.5);
  }

  /** Splash scaled by distance: full inside `radius`, nothing beyond three radii. */
  splashAt(position: THREE.Vector3 | { x: number; y: number; z: number }, radius: number, amount = 1): void {
    const d = _v.set(position.x, position.y, position.z).distanceTo(this.camera.position);
    const k = 1 - THREE.MathUtils.smoothstep(d, radius, radius * 3);
    if (k > 0.02) this.splash(amount * k);
  }

  /** The lens just came out of the water: a sheet pours off and beads are left behind. */
  drench(): void { this.wetness = 1; this.sheet = 1; }

  /** Dry instantly (scene changes). */
  clear(): void { this.wetness = 0; this.sheet = 0; this.rain = 0; }

  setQuality(preset: QualityPreset): void {
    const layers = preset.tier === 'low' ? 0 : preset.tier === 'medium' ? 1 : preset.tier === 'high' ? 2 : 3;
    if (layers !== this.layers) { this.layers = layers; this.attach(); }
  }

  /** (Re)register with the pipeline. The engine calls this after it clears effects. */
  attach(): void {
    if (!this._enabled || this.layers === 0) { this.pipeline.removeEffect('lens-fx'); return; }
    const layers = this.layers;
    this.pipeline.addEffect({
      id: 'lens-fx',
      order: 100,
      distort: (_st: N, ndc: N) => {
        // xy: refraction offset in UV, z: droplet rim (darkening), w: highlight.
        this.field = Fn(() => {
          const out = TSL.vec4(0).toVar();
          If(this.uWet.add(this.uSheet).greaterThan(0.004), () => {
            // Screen position with y up, so gravity is −y on every backend.
            const p = ndc.mul(0.5).add(0.5).mul(vec2(this.uAspect, 1));
            const t = frame.time;
            // The hood sheds most rain near the optical axis. Direct splashes can still cover it.
            const edge = smoothstep(0.18, 1.08, length(ndc.mul(vec2(0.86, 1))));
            const glassLoad = this.uWet.mul(mix(0.26, 0.84, edge)).add(this.uSheet.mul(0.35));
            const offset = vec2(0).toVar();
            const rim = float(0).toVar();
            const spark = float(0).toVar();

            // ---- beads: one candidate droplet per hashed cell ---------------------
            const bead = (cells: number, seed: number, sizeScale: number) => {
              const g = p.mul(cells).add(seed);
              const id = floor(g);
              const h = hash22(id.add(seed * 7.13));
              const present = smoothstep(0.0, 0.12, glassLoad.sub(h.x));
              // Life cycle: swell quickly, sit, evaporate; each droplet on its own clock.
              const phase = fract(h.y.mul(17.0).add(t.mul(h.x.mul(0.05).add(0.03))));
              const life = smoothstep(0.0, 0.05, phase).mul(smoothstep(1.0, 0.55, phase));
              const centre = h.sub(0.5).mul(0.55);
              const radius = h.y.mul(0.2).add(0.14).mul(sizeScale).mul(life).mul(present).add(1e-4);
              const d = fract(g).sub(0.5).sub(centre);
              const elongation = h.x.mul(0.36).add(0.66);
              const r = length(vec2(d.x.add(d.y.mul(h.x.sub(0.5)).mul(0.23)), d.y.mul(elongation))).div(radius);
              const inside = smoothstep(1.12, 0.56, r);
              // Spherical-cap refraction: steepest at the edge, flat in the middle.
              const bend = r.mul(r).mul(0.75).add(0.25);
              offset.addAssign(d.negate().mul(inside).mul(bend).mul(1.15 / cells));
              rim.addAssign(smoothstep(0.62, 0.98, r).mul(inside));
              spark.addAssign(smoothstep(0.34, 0.0, length(d.div(radius).sub(vec2(-0.32, 0.38)))).mul(inside));
            };
            bead(13, 0, 1);
            if (layers >= 2) bead(27, 3.7, 0.85);

            // ---- runners: drops sliding down their column in stick-slip motion ------
            if (layers >= 2) {
              const columns = layers >= 3 ? 11 : 8;
              const gx = p.x.mul(columns);
              const col = floor(gx);
              const h = hash22(vec2(col, 5.0));
              const active = smoothstep(0.25, 0.5, glassLoad.sub(h.x.mul(0.68)));
              const speed = h.y.mul(0.22).add(0.12);
              const run = t.mul(speed).add(h.x.mul(9.0));
              // Stick-slip: the drop hesitates, then lets go.
              const y = float(1.15).sub(fract(run.add(sin(run.mul(6.2831)).mul(0.11))).mul(1.4));
              const wiggle = sin(p.y.mul(23.0).add(h.x.mul(40.0))).mul(0.09);
              const dx = fract(gx).sub(0.5).sub(h.x.sub(0.5).mul(0.5)).sub(wiggle);
              const dy = p.y.sub(y);
              const head = smoothstep(0.17, 0.11, length(vec2(dx, dy.mul(columns * 0.72))));
              // The trail thins and breaks into beads as it dries above the head.
              const above = smoothstep(0.0, 0.02, dy).mul(smoothstep(0.42, 0.0, dy));
              const trail = smoothstep(0.075, 0.02, abs(dx)).mul(above).mul(mix(0.45, 1.0, smoothstep(0.35, 0.6, fract(p.y.mul(31.0).add(h.y.mul(11.0))))));
              offset.addAssign(vec2(dx.negate().mul(head.mul(1.6).add(trail.mul(0.9))).div(columns), dy.negate().mul(head).mul(0.9)).mul(active));
              rim.addAssign(head.mul(smoothstep(0.1, 0.16, length(vec2(dx, dy.mul(columns * 0.72))))).mul(active));
              spark.addAssign(head.mul(0.3).mul(active));
            }

            // ---- sheet: water pouring off the glass ----------------------------------
            const flow = sin(p.x.mul(19.0).add(sin(p.y.mul(3.1).add(t.mul(5.0))).mul(1.7))).mul(sin(p.y.mul(5.3).add(t.mul(7.5)).add(p.x.mul(2.0))));
            offset.addAssign(vec2(flow.mul(0.012), flow.mul(0.02).add(0.006)).mul(this.uSheet));
            out.assign(TSL.vec4(offset.div(vec2(this.uAspect, 1)).mul(this.uStrength), rim.min(1), spark.min(1)));
          });
          return out;
        })().toVar();
        return this.field.xy;
      },
      lens: (color: N) => {
        if (!this.field) return color;
        // Droplet rims are slightly darker (light is bent away); a pinpoint of sky sits on top.
        const sky = mix(frame.skyHorizon, frame.skyZenith, 0.5).add(frame.sunColor.mul(frame.sunVisibility).mul(0.08));
        return color.mul(float(1).sub(this.field.z.mul(0.13))).add(sky.mul(this.field.w.mul(0.19)));
      },
    });
  }

  update(dt: number): void {
    if (!this._enabled || this.layers === 0) return;
    const target = THREE.MathUtils.clamp(this.rain, 0, 1);
    if (target > this.wetness) this.wetness = Math.min(target, this.wetness + dt * 0.55);
    else this.wetness = Math.max(target, this.wetness - dt / Math.max(this.dryTime, 0.1));
    this.sheet = Math.max(0, this.sheet - dt * 0.85);
    this.uWet.value = this.wetness;
    this.uSheet.value = this.sheet * this.sheet;
    this.uAspect.value = this.camera.aspect;
    this.uStrength.value = this.strength;
  }
}
