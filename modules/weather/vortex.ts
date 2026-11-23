import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { visibleVolumeRay } from '../../engine/shaders/volume-ray';
import { frame } from '../../engine/frame';
import { bakeCloudNoise, temporalIGN, valueNoise2 } from '../../engine/noise';
import type { QualityPreset } from '../../engine/quality';
import { WorldSource } from '../../engine/world-bus';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';

export interface VortexOptions {
  radius?: number;
  height?: number;
  groundHeight?: (x: number, z: number) => number;
}

/** Translating vortex with a condensation funnel hanging from a rotating parent cloud base,
 * a spray vortex (or debris cloud) and a churned contact collar at the surface.
 * Existing particles, cloth, vegetation and dynamic bodies sample its velocity field. */
export class WeatherVortex implements EngineModule {
  readonly position = new THREE.Vector3();
  readonly travel = new THREE.Vector2();
  readonly source = new WorldSource();
  readonly mesh: THREE.Mesh;
  readonly stats = { active: false, overWater: false, seconds: 0 };
  readonly radius: number;
  readonly height: number;
  strength = 1;
  private elapsed = 0;
  private readonly marchSteps = TSL.uniform(12, 'int');
  private readonly baseSteps = TSL.uniform(8, 'int');
  /** Shader state: field top offset (radius units), funnel reach (0 → 1 as it lowers),
   * surface collar and cloud-base strength. */
  private readonly u = {
    top: TSL.uniform(new THREE.Vector2()),
    reach: TSL.uniform(0),
    collar: TSL.uniform(0),
    cloud: TSL.uniform(0),
  };
  private readonly cloudBase: THREE.Mesh;
  private readonly collar: THREE.Mesh;
  private readonly mistTint = TSL.uniform(new THREE.Color());
  private readonly carry = new Float64Array(6);
  private readonly droplets = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    radius: 0, spread: 0, size: 0.06, sizeEnd: 0.22, life: 1.4, lifeJitter: 0.35,
  };
  private readonly puff = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 0,
    spread: 0,
    size: 0,
    sizeEnd: 0,
    life: 3.4,
    lifeJitter: 0.4,
  };

  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit,
    private options: VortexOptions = {}
  ) {
    this.radius = Math.max(1, options.radius ?? 7);
    this.height = Math.max(3, options.height ?? 42);
    const t = TSL,
      noise = bakeCloudNoise();
    const R = this.radius, H = this.height, u = this.u;
    const sun = t.normalize(frame.sunDirection);
    const sunLight = frame.sunColor.mul(frame.sunVisibility);
    // Normalised Henyey–Greenstein phase (mean 1).
    const hg = (cosT: N, g: number): N => t.float(1 - g * g).div(t.pow(t.float(1 + g * g).sub(cosT.mul(2 * g)), 1.5));

    // ---- Condensation funnel ---------------------------------------------------------
    // The funnel is the isobar where the pressure deficit cools rising air to its dew
    // point: a fairly sharp, laminar boundary with helical striations, flaring into the
    // parent cloud and narrowing to a throat over the surface, where a separate spray
    // vortex (or debris cloud) churns. Its centreline follows the physical field's axis
    // (base → displaced top), with a rope bend that vanishes at both ends.
    const g = new THREE.BoxGeometry(2.8, 1, 2.8).translate(0, 0.5, 0);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false });
    m.colorNode = t.Fn(() => {
      const { eye, ray, near, end, viewRay } = visibleVolumeRay(this.engine.pipeline.sceneDepth.sample(t.screenUV).r,
        t.vec3(-1.4, 0, -1.4), t.vec3(1.4, 1, 1.4));
      const step = end.sub(near).div(t.float(this.marchSteps)).toVar();
      const distance = near.add(step.mul(temporalIGN(t.screenCoordinate.xy, frame.frameIndex))).toVar();
      const trans = t.float(1).toVar(), light = t.vec3(0).toVar();
      const metres = t.length(viewRay).mul(step);
      const time = frame.time;
      const worldRay = t.normalize(t.vec3(ray.x.mul(R), ray.y.mul(H), ray.z.mul(R)));
      const cosT = worldRay.dot(sun);
      // Cloud droplets scatter strongly forward: silver edges when backlit, matte when not.
      const phase = hg(cosT, 0.75).min(8).mul(0.55).add(0.45);
      const sunH = t.vec2(sun.x, sun.z), sunHLen = sunH.length().max(0.12), sunHDir = sunH.div(sunHLen);
      const sky = frame.skyHorizon.mul(0.72).add(frame.skyZenith.mul(0.3));
      t.Loop({ start: t.int(0), end: this.marchSteps, type: 'int', condition: '<' }, () => {
        const p = eye.add(ray.mul(distance)).toVar(), h = p.y.clamp(0, 1);
        const rope = t.vec2(h.mul(5.2).add(time.mul(0.5)).sin(), h.mul(4.3).sub(time.mul(0.4)).cos())
          .mul(h.mul(h.oneMinus()).mul(0.42));
        const axis = p.xz.sub(u.top.mul(h)).sub(rope), rho = t.length(axis);
        const angle = h.mul(6.1).sub(time.mul(1.28));
        const c = angle.cos(), s = angle.sin();
        const rot = t.vec2(c.mul(axis.x).sub(s.mul(axis.y)), s.mul(axis.x).add(c.mul(axis.y)));
        const coord = t.vec3(rot.x, h.mul(3.4).sub(time.mul(0.24)), rot.y);
        const shape = t.texture3D(noise.base, coord.mul(0.26).add(t.vec3(0.36, 0.19, 0.57)), 0).toVar();
        const fine = t.texture3D(noise.detail, coord.mul(0.74).add(t.vec3(0.27, 0, 0.43)), 0).r;
        // Throat ~0.55 R over the surface widening to ~1.05 R into the cloud base.
        const flare = h.mul(h).mul(h.mul(h));
        const rf = t.float(0.13).add(h.mul(0.16)).add(flare.mul(0.76));
        // Laminar aloft, ragged near the surface where the spray vortex shears it.
        const turbulence = t.mix(t.float(0.06), t.float(0.24), t.smoothstep(0.38, 0, h));
        const edge = rf.mul(t.float(1).add(shape.r.sub(0.5).mul(turbulence.mul(2))).add(fine.sub(0.5).mul(turbulence)));
        const q = rho.div(edge.max(0.02));
        const theta = t.atan(axis.y, axis.x);
        // Inclined helical striations (a few turns over the height), not stacked rings.
        const stria = theta.mul(3).add(h.mul(9)).sub(time.mul(2.4)).add(shape.g.mul(4)).sin().mul(0.5).add(0.5);
        // A visible funnel lowers from the cloud as the vortex spins up (reach 0 → hidden,
        // reach ≥ 1.06 → full length down to the spray vortex).
        const lowered = t.smoothstep(u.reach, u.reach.sub(0.06), h.oneMinus());
        const funnel = t.smoothstep(1, 0.86, q)
          .mul(q.sub(0.8).div(0.24).pow(2).negate().exp().mul(0.62).add(0.38))
          .mul(t.mix(t.float(0.82), t.float(1), t.smoothstep(0.25, 0.8, stria))).mul(lowered)
          // Merge into the parent cloud base, which overlaps the top ~7 % of the funnel.
          .mul(t.smoothstep(1, 0.95, h));
        // Spray vortex: a rotating sheath of entrained droplets (dust on land) that flares
        // outward and upward from the contact ring and is shredded by turbulence.
        const ring = t.float(0.32).add(h.mul(1.9));
        const sheath = rho.sub(ring).div(h.mul(0.7).add(0.14)).pow(2).negate().exp()
          .mul(h.div(0.085).negate().exp())
          .mul(t.smoothstep(0.32, 0.72, shape.r.add(fine.mul(0.45)).sub(0.15)))
          .mul(theta.mul(5).sub(time.mul(3.6)).add(fine.mul(6)).sin().mul(0.35).add(0.65));
        const sigma = funnel.mul(1.5).add(sheath.mul(u.collar).mul(1.6));
        const alpha = t.float(1).sub(sigma.mul(metres).negate().exp());
        // Light: analytic sun path through the tube (chord to its sunward wall), plus sky
        // light occluded by depth inside the funnel and by the parent cloud overhead.
        const a = axis.mul(R), wall = edge.mul(R);
        const b = a.dot(sunHDir), disc = b.mul(b).sub(a.dot(a)).add(wall.mul(wall));
        const chord = disc.max(0).sqrt().sub(b).max(0).div(sunHLen);
        const sunPath = chord.mul(funnel.mul(0.9).add(0.15));
        const sunT = sunPath.negate().exp().add(sunPath.mul(-0.25).exp().mul(0.22));
        const inside = wall.sub(rho.mul(R)).max(0);
        const skyVis = inside.mul(-0.55).exp().mul(t.mix(t.float(1), t.float(0.5), h));
        const lit = sky.mul(skyVis).add(sunLight.mul(sunT).mul(phase).mul(0.3));
        light.addAssign(this.mistTint.mul(lit).mul(trans).mul(alpha));
        trans.mulAssign(alpha.oneMinus());
        distance.addAssign(step);
        t.If(trans.lessThan(0.025), () => t.Break());
      });
      const coverage = trans.oneMinus();
      return t.vec4(light.div(coverage.max(0.001)), coverage);
    })();
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.scale.set(this.radius, this.height, this.radius);
    this.mesh.visible = false;
    this.mesh.renderOrder = 7;
    this.mesh.name = 'lumina-vortex';
    engine.pipeline.softScene.add(this.mesh);

    // ---- Parent cloud base ------------------------------------------------------------
    // A rotating, lowered wall cloud the funnel hangs from: dark, top-lit, spiral inflow
    // bands, bulging down where the funnel attaches and feathering out at its rim.
    const baseMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false });
    const BR = R * 6, BH = H * 0.2;
    baseMat.colorNode = t.Fn(() => {
      const { eye, ray, near, end, viewRay } = visibleVolumeRay(this.engine.pipeline.sceneDepth.sample(t.screenUV).r,
        t.vec3(-1, -0.5, -1), t.vec3(1, 0.5, 1));
      const step = end.sub(near).div(t.float(this.baseSteps)).toVar();
      const distance = near.add(step.mul(temporalIGN(t.screenCoordinate.xy.add(t.vec2(31, 7)), frame.frameIndex))).toVar();
      const trans = t.float(1).toVar(), light = t.vec3(0).toVar();
      const metres = t.length(viewRay).mul(step);
      const time = frame.time;
      t.Loop({ start: t.int(0), end: this.baseSteps, type: 'int', condition: '<' }, () => {
        const p = eye.add(ray.mul(distance)).toVar();
        const rho = t.length(p.xz), rho2 = rho.mul(rho);
        // Underside: wall-cloud bulge at the centre, rising toward the rim; flat-ish top.
        // The bulge (σ ≈ 0.17 of the base radius, ~4.5 m here) wraps the funnel's flared rim.
        const under = rho2.mul(0.5).sub(0.2).sub(rho2.div(0.03).negate().exp().mul(0.28));
        const over = t.float(0.42).sub(rho2.mul(0.2));
        const theta = t.atan(p.z, p.x);
        const spin = time.mul(0.35);
        const swirl = t.vec3(rho.mul(theta.add(spin).cos()), p.y, rho.mul(theta.add(spin).sin()));
        const n = t.texture3D(noise.base, swirl.mul(t.vec3(1.6, 0.9, 1.6)).add(t.vec3(0.13, time.mul(0.01), 0.71)), 0);
        const bands = theta.mul(2).add(rho.mul(9)).sub(time.mul(0.5)).add(n.g.mul(3)).sin().mul(0.22).add(0.78);
        const density = t.smoothstep(under, under.add(0.14), p.y).mul(t.smoothstep(over, over.sub(0.18), p.y))
          .mul(t.smoothstep(1, 0.62, rho.add(n.r.sub(0.5).mul(0.3)))).mul(bands)
          .mul(t.smoothstep(0.25, 0.6, n.r.add(0.2)));
        const alpha = t.float(1).sub(density.mul(u.cloud).mul(0.09).mul(metres).negate().exp());
        // Top-lit: light diffusing down through the remaining depth; dark underside.
        const depth = over.sub(p.y).max(0).mul(BH);
        const lit = frame.skyZenith.mul(0.45).add(frame.skyHorizon.mul(0.35)).add(sunLight.mul(0.05))
          .mul(depth.mul(-0.12).exp().mul(0.8).add(0.2));
        light.addAssign(lit.mul(0.82).mul(trans).mul(alpha));
        trans.mulAssign(alpha.oneMinus());
        distance.addAssign(step);
        t.If(trans.lessThan(0.03), () => t.Break());
      });
      const coverage = trans.oneMinus();
      return t.vec4(light.div(coverage.max(0.001)), coverage);
    })();
    this.cloudBase = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), baseMat);
    this.cloudBase.scale.set(BR, BH, BR);
    this.cloudBase.visible = false;
    this.cloudBase.renderOrder = 6;
    this.cloudBase.name = 'lumina-vortex-cloud-base';
    engine.pipeline.softScene.add(this.cloudBase);

    // ---- Surface contact collar ---------------------------------------------------------
    // Where the vortex meets the surface: a depressed dark eye, a ring of churned,
    // aerated water (or scoured dust on land) and spiral foam arms dragged inward.
    const collarMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    collarMat.colorNode = t.Fn(() => {
      const c = t.uv().mul(2).sub(1), r = t.length(c), theta = t.atan(c.y, c.x);
      const time = frame.time;
      const spin = theta.sub(time.mul(1.9)).add(r.mul(3.2));
      const churn = valueNoise2(t.vec2(spin.mul(2.5), r.mul(9).sub(time.mul(1.2))));
      const arms = spin.mul(4).add(churn.mul(2.6)).sin().mul(0.5).add(0.5);
      const ring = t.smoothstep(0.12, 0.24, r).mul(t.smoothstep(0.62, 0.36, r));
      const spiral = t.smoothstep(0.55, 0.85, arms).mul(t.smoothstep(1, 0.5, r)).mul(t.smoothstep(0.22, 0.4, r));
      const white = ring.mul(t.smoothstep(0.3, 0.7, churn).mul(0.6).add(0.4)).add(spiral.mul(0.6)).clamp(0, 1);
      const eye = t.smoothstep(0.16, 0.04, r);
      const ambient = frame.skyHorizon.mul(0.7).add(frame.skyZenith.mul(0.3));
      const foam = this.mistTint.mul(ambient.mul(1.05).add(sunLight.mul(sun.y.max(0.1)).mul(0.25)));
      const colour = t.mix(this.mistTint.mul(ambient).mul(0.18), foam, white.div(white.add(eye.mul(0.6)).max(0.001)));
      return t.vec4(colour, white.mul(0.82).add(eye.mul(0.45)).mul(u.collar).clamp(0, 0.92));
    })();
    this.collar = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), collarMat);
    this.collar.scale.setScalar(R * 2.6);
    this.collar.visible = false;
    this.collar.renderOrder = 4;
    this.collar.name = 'lumina-vortex-collar';
    engine.scene.add(this.collar);
    this.setQuality(engine.quality.preset);
  }
  setQuality(preset: QualityPreset): void {
    const steps = { low: 8, medium: 10, high: 14, xhigh: 17, ultra: 20 };
    const base = { low: 5, medium: 6, high: 8, xhigh: 9, ultra: 10 };
    this.marchSteps.value = steps[preset.tier];
    this.baseSteps.value = base[preset.tier];
  }
  start(x: number, z: number, dx = 0, dz = 0): void {
    this.position.set(x, 0, z);
    this.travel.set(dx, dz);
    this.elapsed = 0;
    this.stats.active = this.mesh.visible = this.cloudBase.visible = this.collar.visible = true;
  }
  stop(): void {
    this.stats.active = this.mesh.visible = this.cloudBase.visible = this.collar.visible = false;
    this.engine.world.removeSource(this.source);
  }
  update(dt: number): void {
    if (!this.stats.active || dt <= 0) return;
    this.elapsed += dt;
    this.stats.seconds += dt;
    const p = this.position;
    p.x += dt * this.travel.x;
    p.z += dt * this.travel.y;
    const ground = this.options.groundHeight?.(p.x, p.z) ?? 0;
    const water = this.engine.world.waterHeight(p.x, p.z);
    this.stats.overWater = Number.isFinite(water) && water >= ground;
    p.y = this.stats.overWater ? water : ground;
    this.mesh.position.copy(p);
    const s = this.source.at(p.x, p.y, p.z);
    s.end.set(p.x + Math.sin(this.elapsed * 0.45) * this.radius * 0.18, p.y + this.height, p.z);
    const k = Math.min(1, this.elapsed) * Math.max(0, this.strength);
    s.radius = this.radius * 2.15;
    s.swirl = 38 * k;
    s.radial = -9 * k;
    s.lift = 32 * k;
    s.rimLift = 2 * k;
    s.pressure = -5 * k;
    s.wetness = this.stats.overWater ? 0.38 * k : 0;
    s.cloudCut = 0.6 * k;
    this.engine.world.publish(s);
    // Visuals follow the field: the funnel's top tracks the source's displaced end, the
    // funnel lowers from the cloud within 0.6 s, and collar and cloud strengthen with k.
    const topX = s.end.x - p.x, topZ = s.end.z - p.z;
    (this.u.top.value as THREE.Vector2).set(topX / this.radius, topZ / this.radius);
    this.u.reach.value = Math.min(1, this.elapsed / 0.6) * 1.08 * Math.min(1, Math.max(0, this.strength));
    this.u.collar.value = k * (this.stats.overWater ? 1 : 0.8);
    this.u.cloud.value = Math.min(1, 0.35 + this.elapsed * 0.5) * Math.max(0.35, Math.min(1, this.strength));
    // Underside bulge reaches ~0.93 H on the axis and wraps the funnel's flared rim.
    this.cloudBase.position.set(p.x + topX, p.y + this.height * 1.03, p.z + topZ);
    this.collar.position.set(p.x, p.y + 0.035, p.z);
    this.mistTint.value.setRGB(
      this.stats.overWater ? 0.62 : 0.36,
      this.stats.overWater ? 0.69 : 0.29,
      this.stats.overWater ? 0.7 : 0.23
    );
    const pool = this.stats.overWater ? this.fx.mist : this.fx.dust;
    for (let i = 0; i < 4; i++) {
      const a = this.elapsed * 2.3 + (i * Math.PI) / 2 + 0.36 * Math.sin(i * 3.17 + this.elapsed * 3.2),
        c = Math.cos(a),
        z = Math.sin(a);
      const out = this.puff;
      out.position.set(p.x + c * this.radius * 0.49, p.y + 0.25, p.z + z * this.radius * 0.49);
      out.velocity.set((-z * 9 - c * 3) * k, 8 * k, (c * 9 - z * 3) * k);
      out.radius = this.radius * 0.185;
      out.size = this.radius * (this.stats.overWater ? 0.058 : 0.11);
      out.sizeEnd = this.radius * (this.stats.overWater ? 0.31 : 0.52);
      out.spread = 2.6 * k;
      pool.emitRateAt(this.carry, i, Math.min(pool.burstBudget * 0.08, 36) * k, dt, out);
    }
    // Droplet sheets flung outward and upward from the spray ring (water only; the pool
    // is optional so hosts that provide only dust/mist keep working).
    const spray = this.stats.overWater ? (this.fx as Partial<EffectsKit>).spray : undefined;
    if (spray) {
      for (let i = 0; i < 2; i++) {
        const a = -this.elapsed * 2.9 + i * Math.PI + 0.5 * Math.sin(this.elapsed * 2.1 + i);
        const c = Math.cos(a), z = Math.sin(a), out = this.droplets;
        out.position.set(p.x + c * this.radius * 0.42, p.y + 0.15, p.z + z * this.radius * 0.42);
        out.velocity.set((-z * 7 + c * 4.5) * k, 5.5 * k, (c * 7 + z * 4.5) * k);
        out.radius = this.radius * 0.12;
        out.spread = 2.2 * k;
        spray.emitRateAt(this.carry, 4 + i, Math.min(spray.burstBudget * 0.05, 45) * k, dt, out);
      }
    }
  }
  dispose(): void {
    this.stop();
    for (const mesh of [this.mesh, this.cloudBase, this.collar]) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
