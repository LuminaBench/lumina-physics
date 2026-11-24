import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
/** Two independently moving dipped beams. The same world-space volume can illuminate rain or dust. */
export class CoastalHeadlamps {
  private readonly rear = [TSL.uniform(new THREE.Vector3()), TSL.uniform(new THREE.Vector3())];
  private readonly aft = TSL.uniform(new THREE.Vector3(0,0,-1));
  private readonly brakeGain = TSL.uniform(0);
  private readonly lamp = [0, 1].map(() => ({
    p: TSL.uniform(new THREE.Vector3()),
    d: TSL.uniform(new THREE.Vector3(0, 0, 1)),
    gain: TSL.uniform(0),
  }));
  set(index: 0 | 1, position: THREE.Vector3, direction: THREE.Vector3, strength: number) {
    const l = this.lamp[index];
    l.p.value.copy(position).addScaledVector(direction, 1.64);
    l.p.value.y += 0.42;
    l.d.value.copy(direction);
    l.d.value.y -= 0.038;
    l.d.value.normalize();
    l.gain.value = Math.max(0, strength);
  }
  /** World-space centres of the two tail lights, forward unit direction and relative lamp power. */
  setRear(left: THREE.Vector3, right: THREE.Vector3, forward: THREE.Vector3, power: number) {
    this.rear[0].value.copy(left); this.rear[1].value.copy(right);
    this.aft.value.copy(forward).negate().normalize();
    this.brakeGain.value = Math.max(0,power);
  }
  readonly rearRadiance = (position: N): N => {
    let sum=TSL.float(0);
    for(const lens of this.rear){
      const delta=position.sub(lens), r2=delta.dot(delta);
      const facing=delta.dot(this.aft).div(r2.max(0.001).sqrt());
      sum=sum.add(TSL.smoothstep(-0.08,0.58,facing).mul(TSL.smoothstep(36,16,r2)).div(r2.add(0.20)));
    }
    return TSL.vec3(1,0.028,0.009).mul(sum).mul(this.brakeGain);
  };
  readonly radiance = (world: N): N => {
    const { vec3, smoothstep, dot } = TSL;
    let sum = TSL.float(0);
    for (const l of this.lamp) {
      const local = world.sub(l.p),
        axis = dot(local, l.d),
        radial = local.sub(l.d.mul(axis)).length();
      const width = axis.max(0).mul(0.27).add(0.53);
      const amount = smoothstep(width, width.mul(0.21), radial)
        .mul(smoothstep(0, 1.3, axis))
        .mul(smoothstep(37, 17, axis))
        .div(axis.max(0).mul(0.14).add(1).pow2())
        .mul(l.gain);
      sum = sum.add(amount);
    }
    return vec3(0.93, 0.97, 1).mul(sum).add(this.rearRadiance(world));
  };
}
