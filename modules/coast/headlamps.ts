import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
/** Two independently moving dipped beams. The same world-space volume can illuminate rain or dust. */
export class CoastalHeadlamps {
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
    return vec3(0.93, 0.97, 1).mul(sum);
  };
}
