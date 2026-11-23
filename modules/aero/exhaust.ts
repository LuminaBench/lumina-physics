import * as THREE from 'three/webgpu';
import { TSL as t } from '../../engine/tsl';
import { auxPassthrough } from '../../engine/frame';
import { viewportDepthAt } from '../../engine/shading';
import { visibleVolumeRay } from '../../engine/shaders/volume-ray';

/** Read normalized combustion power in the rig's nozzle order. Sparse channels inherit the collective. */
export function nozzleThrottle(collective: number, channels: ArrayLike<number> | undefined, index: number): number {
  const command = channels?.[index];
  const value = command !== undefined && Number.isFinite(command) ? command : collective;
  return Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
}

/** A self-luminous exhaust volume. Place its origin at the nozzle exit, +Z pointing aft. */
export class JetExhaust extends THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicNodeMaterial> {
  private readonly exitRadius: number;
  private readonly exitAspect: number;
  private readonly power = t.uniform(0);
  private readonly throat: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicNodeMaterial>;
  private readonly clock = t.uniform(0);

  constructor(radius: number, private readonly lengthM: number,
    inner = new THREE.Color(1, 0.56, 0.30), outer = new THREE.Color(0.38, 0.12, 0.86), aspect = 1) {
    super(new THREE.BoxGeometry(2, 2, 1).translate(0, 0, 0.5),
      new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false,
        side: THREE.BackSide, fog: false }));
    this.exitRadius = radius;
    this.exitAspect = aspect;
    this.scale.set(radius, radius * aspect, lengthM);
    this.name = 'jet-exhaust';
    this.visible = false;
    this.renderOrder = 16;
    const hot = t.vec3(inner.r, inner.g, inner.b), cool = t.vec3(outer.r, outer.g, outer.b);
    // A rear view sees the luminous gas at the exit, even when the recessed
    // flameholder hardware is hidden by the nozzle petals.
    const face = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const radial = t.length(t.uv().sub(0.5)).mul(2);
    const center = t.exp(radial.mul(radial).mul(-3.1));
    const rim = t.smoothstep(1, 0.77, radial);
    face.colorNode = t.vec4(t.mix(hot, t.vec3(1, 0.84, 0.73), center.mul(0.82))
      .mul(center.mul(2.85).add(0.62)), rim.mul(t.smoothstep(0, 0.65, this.power)));
    face.mrtNode = auxPassthrough();
    this.throat = new THREE.Mesh(new THREE.CircleGeometry(0.88, 32), face);
    this.throat.position.z = 0.006;
    this.throat.renderOrder = 15;
    this.add(this.throat);
    this.material.colorNode = t.Fn(() => {
      const { eye, ray, near, end } = visibleVolumeRay(viewportDepthAt(t.screenUV), t.vec3(-1, -1, 0), t.vec3(1));
      const step = end.sub(near).div(8);
      const travel = near.add(step.mul(0.5)).toVar();
      const emission = t.vec3(0).toVar(), transmission = t.float(1).toVar();
      // Ray intervals are in the unit box. Measure optical distance in nozzle
      // radii so looking through the tail gives a longer column than a side view.
      const opticalStep = step.mul(t.length(t.modelWorldMatrix.mul(t.vec4(ray, 0)).xyz)).div(Math.max(0.001, radius)).mul(this.power).mul(1.25);
      t.Loop(8, () => {
        const p = eye.add(ray.mul(travel));
        const z = p.z.clamp(0, 1);
        const cell = z.mul(26).add(z.mul(z).mul(8)).cos();
        const tail = z.oneMinus();
        const width = tail.pow(0.54).mul(cell.mul(0.062).add(0.89)).max(0.012);
        const r = t.length(p.xy).div(width);
        const mist = t.smoothstep(1, 0.22, r);
        const shear = z.mul(27).sub(this.clock.mul(9)).add(p.x.mul(7)).add(p.y.mul(5)).sin();
        // A thin mixing layer radiates outside the tighter, hotter core.
        // It becomes irregular downstream while staying attached to the exit.
        const boundary = r.add(shear.mul(z).mul(0.12));
        const fringe = t.smoothstep(1.17, 0.65, boundary).mul(t.smoothstep(0.32, 0.74, r));
        const density = mist.add(fringe.mul(0.25)).mul(tail.pow(1.18)).mul(shear.mul(z).mul(0.11).add(0.89));
        const core = t.exp(r.mul(r).mul(-4)).mul(t.exp(z.mul(-6)));
        const cellWall = t.abs(r.sub(cell.mul(0.30).add(0.36)));
        const diamonds = t.smoothstep(0.30, 0.035, cellWall).mul(tail.pow(1.5)).mul(0.55);
        const hotFraction = t.exp(z.mul(-3.8)).mul(fringe.mul(0.58).oneMinus());
        const color = t.mix(cool, hot, hotFraction).mul(1.3)
          .add(t.vec3(1, 0.82, 0.61).mul(core.mul(3.1).add(diamonds)));
        const through = t.exp(density.mul(opticalStep).negate());
        emission.addAssign(color.mul(transmission).mul(through.oneMinus()));
        transmission.mulAssign(through);
        travel.addAssign(step);
      });
      // Straight-alpha composition transmits the recessed exit face and the
      // background through the cooler gas already integrated in front of them.
      const opacity = transmission.oneMinus();
      return t.vec4(emission.div(opacity.max(0.0001)), opacity);
    })();
    this.material.mrtNode = auxPassthrough();
  }

  setPower(intensity: number, seconds: number, aperture = 1): void {
    const power = THREE.MathUtils.clamp(intensity, 0, 1);
    this.power.value = power;
    this.clock.value = seconds;
    const opening = THREE.MathUtils.clamp(aperture, 0.5, 1.25);
    this.scale.set(this.exitRadius * (this.exitAspect === 1 ? opening : 1),
      this.exitRadius * this.exitAspect * opening, this.lengthM * (0.28 + power * 0.72));
    this.visible = power > 0.015;
  }

  dispose(): void {
    this.removeFromParent();
    this.throat.geometry.dispose();
    this.throat.material.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
