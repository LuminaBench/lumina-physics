import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { bakeCloudNoise, temporalIGN } from '../../engine/noise';
import { visibleVolumeRay } from '../../engine/shaders/volume-ray';
import { WorldSource } from '../../engine/world-bus';
import type { LuminaEngine } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from '../water/ocean';

const spraySteps = { low: 7, medium: 9, high: 12, xhigh: 14, ultra: 16 };

export type RotorSurface = 'auto' | 'water' | 'soil' | 'sand' | 'snow';

/** Hovering rotors supply momentum even at zero forward speed. The core pushes
 * down while flow turns outward at the ground and rises around the spray skirt. */
export class RotorWash {
  readonly source = new WorldSource();
  readonly stats = { loading: 0, water: false, emitted: 0, surface: 'auto' as RotorSurface };
  private curtain?: THREE.Mesh;
  private readonly loading = TSL.uniform(0);
  private readonly tint = TSL.uniform(new THREE.Color());
  private readonly steps = TSL.uniform(12, 'int');
  private readonly wet = TSL.uniform(1);
  private readonly drift = TSL.uniform(new THREE.Vector2());
  private phase = 0;
  private readonly carry = new Float64Array(8);
  private readonly tuft = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 0,
    spread: 0,
    size: 0,
    sizeEnd: 0,
    life: 0,
    lifeJitter: 0.45,
  };
  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit
  ) {}

  /** Beer extinction through the annular roll of entrained spray or loose
   * ground cover. The low layer flows out over the surface, turns upward and
   * sheds intermittent wind-borne sheets. A core can stay clear at full power. */
  private makeCurtain(): THREE.Mesh {
    const t = TSL, noise = bakeCloudNoise();
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false,
    });
    material.colorNode = t.Fn(() => {
      const {eye, ray, near, end, viewRay} = visibleVolumeRay(this.engine.pipeline.sceneDepth.sample(t.screenUV).r,
        t.vec3(-1.9,-0.14,-1.9), t.vec3(1.9,1.22,1.9));
      const step = end.sub(near).div(t.float(this.steps)).toVar();
      const d = near.add(step.mul(temporalIGN(t.screenCoordinate.xy,frame.frameIndex))).toVar();
      const transmittance = t.float(1).toVar(), scatter = t.vec3(0).toVar();
      const time = frame.time, metres = t.length(viewRay).mul(step);
      const sunward = frame.sunDirection;
      const sky = t.mix(frame.skyZenith, frame.skyHorizon, 0.38);
      // Liquid drops forward-scatter more strongly than suspended soil or powder.
      const g = t.mix(0.34, 0.66, this.wet);
      const viewToSun = t.dot(ray, sunward);
      const phase = g.mul(g).oneMinus().div(t.pow(g.mul(g).add(1).sub(g.mul(2).mul(viewToSun)), 1.5));
      const sunlight = frame.sunColor.mul(frame.sunVisibility).mul(phase.mul(0.0796));
      t.Loop({start:t.int(0),end:this.steps,type:'int',condition:'<'}, () => {
        const p = eye.add(ray.mul(d)).toVar(), h = p.y.max(0);
        const axial = p.xz.sub(this.drift.mul(h.mul(h.add(0.5))).mul(1.4));
        const radius = t.length(axial).max(0.025), azimuth = axial.div(radius);
        const roll = time.mul(0.23).add(h.mul(2.4));
        const local = t.vec2(azimuth.x.mul(roll.cos()).sub(azimuth.y.mul(roll.sin())),
          azimuth.y.mul(roll.cos()).add(azimuth.x.mul(roll.sin())));
        const coord = t.vec3(local.x.mul(radius), h.mul(1.7).sub(time.mul(0.48)), local.y.mul(radius));
        const bulk = t.texture3D(noise.base,coord.mul(0.47).add(t.vec3(0.42,0.16,0.67)),0).toVar();
        const detail = t.texture3D(noise.detail,coord.mul(1.68).add(bulk.g.mul(0.26)),0).r;
        // Eroded gaps break up the lifting edge. The sheet still has a continuous
        // short skirt where it first sweeps out along the ground.
        const billow = bulk.r.mul(0.58).add(bulk.b.mul(0.22)).add(detail.mul(0.20));
        // Angular waves share the same value on both sides of the azimuth seam.
        // Stretch these patches along radius to resolve individual radial streamers.
        const sector = local.x.mul(10.3).add(local.y.mul(6.6)).add(roll).sin()
          .mul(local.y.mul(8.7).sub(local.x.mul(3.5)).sub(roll).cos());
        const streak = t.smoothstep(-0.42, 0.54, sector.add(detail.sub(0.5).mul(1.4)));
        const tuft = t.smoothstep(0.37, 0.69, billow).mul(t.mix(1, streak.mul(0.88).add(0.12), this.wet));
        const localTop = this.loading.mul(bulk.g.mul(0.76).add(tuft.mul(0.49)).add(0.13));
        const vertical = t.smoothstep(-0.12,0.065,p.y).mul(t.smoothstep(localTop,localTop.mul(0.27),h));
        const bend = t.smoothstep(0,localTop.max(0.05),h);
        const centre = bend.mul(0.46).add(0.93).add(streak.sub(0.5).mul(this.wet).mul(0.28)).add(bulk.g.sub(0.5).mul(0.58)).add(detail.sub(0.5).mul(0.12));
        const width = bend.mul(0.18).add(t.mix(0.24,0.14,this.wet)).add(tuft.mul(0.06));
        const falloff = radius.sub(centre).div(width);
        const outer = falloff.mul(falloff).mul(-1.65).exp().mul(vertical).mul(tuft);
        const skirt = t.smoothstep(0.54, 0.83, radius).mul(t.smoothstep(1.78, 1.14, radius))
          .mul(t.smoothstep(0.13, 0.015, h)).mul(t.smoothstep(-0.05, 0.025, p.y)).mul(billow).mul(t.mix(0.34, streak.mul(0.68), this.wet));
        const density = outer.add(skirt).mul(this.loading);
        const alpha = t.float(1).sub(density.mul(metres).mul(t.mix(-0.85,-0.68,this.wet)).exp());
        // Optical path back towards the sun is longest on the inner, lee side
        // of an upright billow. Its outer surface sees more of the sky.
        const lit = azimuth.dot(sunward.xz).mul(0.44).add(0.56);
        const shade = t.exp(outer.mul(lit.oneMinus()).mul(-2.6));
        const irradiance = sky.mul(tuft.mul(-0.30).add(0.83)).add(sunlight.mul(shade));
        scatter.addAssign(this.tint.mul(irradiance).mul(alpha).mul(transmittance));
        transmittance.mulAssign(alpha.oneMinus());
        d.addAssign(step);
        t.If(transmittance.lessThan(0.02), () => { t.Break(); });
      });
      const alpha = transmittance.oneMinus();
      return t.vec4(scatter.div(alpha.max(0.001)),alpha);
    })();
    const geometry = new THREE.BoxGeometry(3.8,1.36,3.8).translate(0,0.54,0);
    const mesh = new THREE.Mesh(geometry,material);
    mesh.renderOrder = 8;
    mesh.name = 'lumina-rotor-spray-rim';
    this.engine.pipeline.softScene.add(mesh);
    return mesh;
  }

  step(
    position: THREE.Vector3,
    radius: number,
    load: number,
    dt: number,
    surface: RotorSurface = 'auto',
    landY = 0
  ): void {
    if (!(dt > 0)) return;
    const waterline = this.engine.world.waterHeight(position.x, position.z);
    const wet = surface === 'water' || (surface === 'auto' && Number.isFinite(waterline) && waterline >= landY);
    const y = wet && Number.isFinite(waterline) ? waterline : landY;
    const height = Math.max(0, position.y - y),
      reach = Math.max(0.1, radius * 6);
    const loading = Math.max(0, Math.min(1, load)) * Math.pow(Math.max(0, 1 - height / reach), 1.4);
    this.stats.loading = loading;
    this.stats.water = wet;
    this.stats.surface = wet ? 'water' : surface === 'auto' ? 'soil' : surface;
    if (loading < 0.003) {
      this.stop();
      return;
    }
    const curtain = this.curtain ?? (this.curtain = this.makeCurtain());
    curtain.visible = true;
    curtain.position.set(position.x, y, position.z);
    curtain.scale.setScalar(radius);
    this.loading.value = loading;
    this.wet.value = wet ? 1 : 0;
    this.steps.value = spraySteps[this.engine.quality.tier];
    this.drift.value.copy(this.engine.wind.direction).multiplyScalar(Math.min(0.65,this.engine.wind.speed * 0.033));
    this.tint.value.setHex(
      wet ? 0xd4e6e4 : surface === 'snow' ? 0xe8efee : surface === 'sand' ? 0xbcab8b : 0x8a7a6d
    );
    const field = this.source.at(position.x, y, position.z);
    field.end.y = position.y;
    field.radius = radius * (2.1 + (0.06 * height) / Math.max(radius, 0.1));
    field.radial = 19 * loading;
    field.swirl = 8 * loading;
    field.lift = -9 * loading;
    field.rimLift = 22 * loading;
    field.pressure = 9 * loading;
    field.wetness = wet ? 0.45 * loading : 0;
    field.cloudCut = 0.5 * loading;
    this.engine.world.publish(field);
    // Phase-rotated sectors fill a complete annulus without bunching spray on one side.
    this.phase = (this.phase + dt * (2 + 3 * loading)) % (2 * Math.PI);
    const puff = this.tuft,
      powder = surface === 'snow';
    const pool = wet ? this.fx.spray : powder ? this.fx.mist : this.fx.dust;
    for (let i = 0; i < 8; i++) {
      const a = this.phase + (i * Math.PI) / 4 + 0.32 * Math.sin(this.phase * 4 + 2.4 * i),
        c = Math.cos(a),
        s = Math.sin(a);
      const gust = 0.55 + 0.45 * Math.sin(i * 2.23 + this.phase * 1.7);
      const r = radius * (1.16 + 0.14 * Math.sin(this.phase * 2.8 + i * 1.73));
      puff.position.set(position.x + r * c, y + 0.14 * radius, position.z + r * s);
      puff.velocity.set((c * 10 - s * 4) * loading, (wet ? 5.5 + 7 * gust : 4.2) * loading, (s * 10 + c * 4) * loading);
      puff.radius = radius * 0.23;
      puff.spread = 2.5 * loading;
      puff.life = wet ? 1.1 : powder ? 2.4 : 3.3;
      puff.size = Math.max(0.025, radius * (wet ? 0.012 : powder ? 0.048 : 0.078));
      puff.sizeEnd = radius * (wet ? 0.039 : powder ? 0.185 : 0.39);
      pool.emitRateAt(this.carry, i, Math.min(110, pool.burstBudget * 0.075) * loading * (wet ? 0.4 + gust * 1.1 : 1), dt, puff);
    }
    this.stats.emitted += dt * Math.min(880, pool.burstBudget * 0.6) * loading;
  }
  stop(): void {
    this.engine.world.removeSource(this.source);
    if (this.curtain) this.curtain.visible = false;
    this.stats.loading = 0;
  }
  dispose(): void {
    this.stop();
    if (this.curtain) {
      this.curtain.removeFromParent();
      this.curtain.geometry.dispose();
      (this.curtain.material as THREE.Material).dispose();
      this.curtain = undefined;
    }
  }
}

const legacyRotors = new WeakMap<EffectsKit, RotorWash>();
/** v2 convenience entry point. Independent machines should own one RotorWash each. */
export function applyRotorWash(
  engine: LuminaEngine,
  fx: EffectsKit,
  ocean: Ocean | null,
  position: THREE.Vector3,
  rotorRadius: number,
  thrust01: number,
  dt: number
): void {
  let rotor = legacyRotors.get(fx);
  if (!rotor) {
    rotor = new RotorWash(engine, fx);
    legacyRotors.set(fx, rotor);
  }
  rotor.step(
    position,
    rotorRadius,
    thrust01,
    dt,
    ocean ? 'auto' : 'soil',
    ocean ? ocean.waterLevel - ocean.depthAt(position.x, position.z) : 0
  );
}
