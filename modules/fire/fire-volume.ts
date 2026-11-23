import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { bakeCloudNoise, blackbody, temporalIGN } from '../../engine/noise';
import { frame } from '../../engine/frame';
import { FieldReading } from '../../engine/world-bus';
import type { LuminaEngine } from '../../engine/engine';

/** Front-to-back emission and absorption inside a moving, expanding thermal: a shrinking
 * HDR combustion kernel inside a self-shadowed soot shell whose fringe is sheared into
 * rolling filaments by a vortex-ring circulation. */
export class FireVolume {
  private readonly age = TSL.uniform(0);
  private readonly seed = TSL.uniform(0);
  private readonly heat = TSL.uniform(1);
  private readonly shear = TSL.uniform(new THREE.Vector2());
  private readonly gases = new FieldReading();
  private readonly probe = new THREE.Vector3();
  private readonly drift = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private evaporated = 0;
  private readonly steps = TSL.uniform(12, 'int');
  private readonly lightTaps = TSL.uniform(2, 'int');
  private readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicNodeMaterial>;
  private origin = new THREE.Vector3();
  private size = 1;
  private delay = 0;
  private elapsed = 0;
  private active = false;

  constructor(private engine: LuminaEngine) {
    const t = TSL;
    const noise = bakeCloudNoise();
    const material = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, fog: false,
    });
    material.colorNode = t.Fn(() => {
      const eye = t.modelWorldMatrixInverse.mul(t.vec4(t.cameraPosition, 1)).xyz;
      const ray = t.normalize(t.positionLocal.sub(eye));
      // March the unit bounding sphere, not the box: the step length no longer jumps
      // where rays cross box faces (visible seams), and fewer steps land in empty corners.
      const bq = t.dot(eye, ray), cq = t.dot(eye, eye).sub(1);
      const disc = bq.mul(bq).sub(cq);
      t.If(disc.lessThanEqual(0), () => t.Discard());
      const root = t.sqrt(t.max(disc, 0));
      const near = t.max(bq.negate().sub(root), 0);
      const far = bq.negate().add(root);
      const opaqueZ = t.perspectiveDepthToViewZ(this.engine.pipeline.sceneDepth.sample(t.screenUV).r, t.cameraNear, t.cameraFar).negate();
      const viewRay = t.modelViewMatrix.mul(t.vec4(ray, 0)).xyz;
      const exit = t.min(far, opaqueZ.div(t.max(viewRay.z.negate(), 1e-5)));
      t.If(exit.lessThanEqual(near), () => t.Discard());
      const step = exit.sub(near).div(t.float(this.steps));
      const dist = near.add(step.mul(temporalIGN(t.screenCoordinate.xy, frame.frameIndex))).toVar();
      const light = t.vec3(0).toVar(), transmit = t.float(1).toVar();

      // Per-pixel constants. The box is unrotated and near-uniformly scaled, so the
      // world sun direction is the local one.
      const sun = t.normalize(frame.sunDirection);
      const sunRadiance = frame.sunColor.mul(frame.sunVisibility);
      const skyFill = t.mix(frame.skyHorizon, frame.skyZenith, 0.45);
      // Dual-lobe Henyey–Greenstein (mean 1): soot aggregates scatter forward with a weak
      // back lobe, so the plume brightens at its rim when looking toward the sun.
      const cosT = t.dot(ray, sun);
      const hg = (g: number): N => t.float(1 - g * g).div(t.pow(t.float(1 + g * g).sub(cosT.mul(2 * g)), 1.5));
      const phase = hg(0.55).mul(0.7).add(hg(-0.2).mul(0.3));
      const drift = t.vec3(this.seed.mul(7.3), this.age.mul(-0.22), this.seed.mul(3.1));
      // The burning kernel fills most of the young fireball, then rises and shrinks as fuel
      // is consumed; flame is visible first, soot takes over from the outside in.
      const kernel = t.vec3(0, this.age.mul(0.12).sub(0.1), 0);
      const fuelFalloff = this.age.mul(3.2).add(1.4);
      // Petrol fireballs stop flaming after ~2 s; the cap then cools to smoke.
      const burn = t.exp(this.age.mul(-0.5));
      // Bounded roll: an unbounded angle sheared late lobes into crescent "petals".
      const swirlAmount = t.float(1).sub(t.exp(this.age.mul(-0.9))).mul(1.5);
      const ringR = 0.26, ringY = 0.12;
      // Soot single-scattering albedo: fresh carbon is very dark, aged smoke greys with
      // entrained air and condensate.
      const sootAlbedo = t.mix(t.float(0.16), t.float(0.32), t.smoothstep(0.4, 2.6, this.age));
      // The cap flattens into a mushroom as it rises.
      const flatten = t.smoothstep(0.5, 2.5, this.age).mul(0.3).add(1.08);
      // Cauliflower lobes from the Worley octaves already packed in the shape texel (no
      // extra fetch); they bulge further as the cap entrains air. A single low-frequency
      // octave left the envelope a smooth, dense ball.
      const billow = t.smoothstep(0.3, 2.0, this.age).mul(0.5).add(1);
      const lobes = (n: N): N => n.r.sub(0.5).mul(0.6).add(n.g.sub(0.55).mul(0.95).add(n.b.sub(0.55).mul(0.6)).mul(billow));
      const envelope = (q: N): N => {
        const radial = t.length(q.xz);
        const crown = t.length(t.vec2(radial.sub(0.24), q.y.sub(0.12).mul(flatten))).sub(0.46);
        const stem = t.length(t.vec2(radial.mul(1.8), q.y.add(0.34))).sub(0.4);
        return t.min(crown, stem).negate();
      };
      // Coarse density only (no detail), for the light march toward the sun.
      const coarseAt = (q: N, shapeP: N): N =>
        t.smoothstep(0.0, 0.14, envelope(q).mul(2.2).add(lobes(t.texture3D(noise.base, shapeP, 0))));

      t.Loop({ start: t.int(0), end: this.steps, type: 'int', condition: '<' }, () => {
        const local = eye.add(ray.mul(dist)).toVar();
        // Differential entrainment leans the free crown away from the stem.
        const bend = t.smoothstep(-0.58, 0.53, local.y).sub(0.4);
        const p = local.sub(t.vec3(this.shear.x, 0, this.shear.y).mul(bend)).toVar();
        const radial = t.length(p.xz);
        // Vortex-ring circulation: up the axis, out over the crown and down the outside.
        // The rotation decays away from the ring core, so the noise is sheared rather
        // than turned rigidly; the shear draws billows out into rolling filaments.
        const q = t.vec2(radial.sub(ringR), p.y.sub(ringY));
        const swirl = swirlAmount.mul(t.exp(t.dot(q, q).mul(-3.2))).mul(t.smoothstep(0.0, 0.18, radial));
        const cs = t.cos(swirl), sn = t.sin(swirl);
        const qr = t.vec2(q.x.mul(cs).sub(q.y.mul(sn)), q.x.mul(sn).add(q.y.mul(cs)));
        const axis = p.xz.div(t.max(radial, 1e-4));
        const rolled = t.vec3(axis.x.mul(qr.x.add(ringR)), qr.y.add(ringY), axis.y.mul(qr.x.add(ringR)));

        const shapeP = rolled.mul(0.46).add(drift);
        const shape = t.texture3D(noise.base, shapeP, 0);
        const detail = t.texture3D(noise.detail, rolled.mul(1.35).add(shape.gba.sub(0.5).mul(0.35)).add(drift.mul(1.6)), 0);
        // Billows must thin out before they reach the bounding sphere. Noise alone could carry
        // soot all the way to it, where the fade below clipped it along the sphere: a dark
        // circular rim that showed behind the stem. Pull the surface inward over the outer third
        // instead, so nothing dense is left for the final fade to cut.
        const reach = t.length(local);
        const rim = t.smoothstep(0.66, 1.0, reach);
        const coarse = envelope(p).mul(2.2).add(lobes(shape)).sub(rim.mul(rim).mul(1.6));
        // Erode Worley cell interiors only at the fringe: the thin webs that survive,
        // sheared by the roll, read as sharp soot filaments; the core stays continuous.
        const cells = detail.r.mul(0.55).add(detail.g.mul(0.3)).add(detail.b.mul(0.15));
        const fringe = t.float(1).sub(coarse.clamp(0, 1));
        const sphereFade = t.smoothstep(1.0, 0.8, reach);
        const density = t.smoothstep(0.0, 0.14, coarse.sub(cells.mul(fringe).mul(0.55))).mul(sphereFade);

        // Combustion sits on the fuel/air interface (mid-iso sheets of the coarse noise)
        // inside the shrinking kernel. Emission is gated, so cool soot never leaks a dull
        // red glow, and capped below white so the interior keeps an HDR gradient.
        const coreDistance = t.length(p.sub(kernel).mul(t.vec3(1, 1.2, 1)));
        const fuel = t.exp(coreDistance.mul(coreDistance).mul(fuelFalloff).negate());
        const mixture = shape.g.mul(0.45).add(shape.b.mul(0.25)).add(detail.r.mul(0.30));
        const sheet = t.float(1).sub(t.smoothstep(0.035, 0.24, mixture.sub(0.51).abs()));
        const temperature = this.heat.mul(burn).mul(fuel).mul(sheet.mul(0.71).add(0.42))
          .mul(detail.b.mul(0.22).add(0.89)).max(0);
        const emission = blackbody(temperature.min(1.05)).mul(t.smoothstep(0.17, 0.32, temperature));
        const sootiness = t.float(1).sub(t.smoothstep(0.12, 0.38, temperature));
        // Luminous gas is less absorbing than soot.
        const sigma = t.mix(t.float(4.8), t.float(11.5), sootiness);
        const alpha = t.float(1).sub(t.exp(density.mul(step).mul(sigma).negate()));

        t.If(alpha.greaterThan(0.002), () => {
          // Self-shadow: optical depth toward the sun through the coarse field. High
          // tiers take two taps; low tiers extrapolate one.
          const tau = coarseAt(p.add(sun.mul(0.12)), shapeP.add(sun.mul(0.055))).mul(0.16).toVar();
          t.If(this.lightTaps.greaterThan(1), () => {
            tau.addAssign(coarseAt(p.add(sun.mul(0.34)), shapeP.add(sun.mul(0.156))).mul(0.3));
          }).Else(() => {
            tau.mulAssign(2.9);
          });
          const sunT = t.exp(tau.mul(-10)).add(t.exp(tau.mul(-2.5)).mul(0.22));
          // Sky dome: full ambient radiance on the open upper shell, occluded in the
          // crevices between lobes and underneath, where a faint sea/deck bounce lifts it.
          // The previous 0.35 weight left shadowed soot a flat dark brown.
          const open = t.exp(coarse.max(0).mul(-1.6));
          const upward = t.smoothstep(-0.9, 0.6, p.y);
          const ambient = skyFill.mul(open).mul(upward.mul(0.65).add(0.35)).mul(0.9)
            .add(sunRadiance.mul(open).mul(upward.oneMinus()).mul(0.012));
          const warm = t.vec3(0.95, 0.32, 0.07).mul(this.heat).mul(t.exp(coreDistance.mul(-3.6)))
            .mul(t.exp(this.age.mul(-0.85))).mul(1.2);
          const scatter = sunRadiance.mul(sunT).mul(phase).mul(0.12).add(ambient).mul(sootAlbedo).add(warm.mul(sootAlbedo));
          light.addAssign(transmit.mul(alpha).mul(emission.add(scatter)));
          transmit.mulAssign(alpha.oneMinus());
        });
        dist.addAssign(step);
        t.If(transmit.lessThan(0.025), () => { t.Break(); });
      });
      const coverage = t.float(1).sub(transmit);
      return t.vec4(light.div(t.max(coverage, 0.001)), coverage);
    })() as N;
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    this.mesh.name = 'rolling combustion volume';
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    engine.pipeline.softScene.add(this.mesh);
    // Compile against the same half-resolution target that will receive the burst.
    const warm = new THREE.Mesh(this.mesh.geometry, material);
    warm.scale.setScalar(1e-5);
    engine.prewarm(warm, 3, engine.pipeline.softScene);
  }

  start(position: THREE.Vector3, size: number, delay: number, seed: number): void {
    this.origin.copy(position);
    this.size = size;
    this.delay = delay;
    this.seed.value = (seed * 0.61803) % 1;
    this.elapsed = 0;
    this.active = true;
    this.drift.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.shear.value.set(0, 0);
    this.evaporated = 0;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.active) return;
    const age = (this.elapsed += dt) - this.delay;
    this.mesh.visible = age >= 0 && age < 3.4;
    if (age >= 3.4) this.active = false;
    if (!this.mesh.visible) return;
    this.age.value = age;
    const low = this.engine.quality.tier === 'low';
    this.steps.value = low ? 7 : 12;
    this.lightTaps.value = low ? 1 : 2;
    const radius = this.size * (1.3 + 5.0 * (1 - Math.exp(-age * 3.1)) + age * 0.7);
    this.mesh.scale.set(radius, radius * 0.94, radius);
    const dtActive = Math.min(dt, age);
    const world = this.engine.world;
    this.probe.copy(this.origin).add(this.drift);
    this.probe.y += radius * 0.54 + this.size * age * 2.4;
    const air = world.read(this.probe, this.engine.time, this.gases);
    const entrainment = 1 - Math.exp(-dtActive * 1.15);
    this.velocity.lerp(air.wind, entrainment);
    this.drift.addScaledVector(this.velocity, dtActive);
    const point = this.probe;
    const rain = world.rainfall * world.shelters.exposureAt(point.x,point.y,point.z);
    const quench = Math.max(rain * 0.32, air.wetness - world.rainFilmAt(point.x,point.y,point.z));
    this.evaporated = Math.min(0.55, this.evaporated + quench * dtActive * 0.55);
    this.heat.value = (1.03 - 0.08 * age) * (1 - this.evaporated);
    this.mesh.position.copy(this.origin).add(this.drift);
    this.mesh.position.y += radius * 0.54 + this.size * age * 2.4;
    // The crown sees wind above the rising core. A passing rotor or pressure
    // field changes its direction without resetting the transport accumulated so far.
    this.probe.copy(this.mesh.position); this.probe.y += radius * 0.48;
    const upper = world.sample(this.probe, this.engine.time, this.gases.wind);
    const scale = Math.min(age, 0.75) / Math.max(radius, 0.1);
    const sx = (upper.x - this.velocity.x) * scale, sz = (upper.z - this.velocity.z) * scale;
    const limit = 0.32 / Math.max(0.32, Math.hypot(sx, sz));
    this.shear.value.set(sx * limit, sz * limit);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
