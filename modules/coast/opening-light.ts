import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame } from '../../engine/frame';

export interface OpenShade {
  center: THREE.Vector3;
  halfSize: THREE.Vector3;
  towardsOpenSky: THREE.Vector3;
  groundColor: THREE.ColorRepresentation;
  edgeMetres?: number;
}
/** Two low-order irradiance lobes for a bounded open-sided roof.
 * Black opposing hemispheres leave the existing environment in control outside the footprint. */
export function addOpenShade(scene: THREE.Scene, opts: OpenShade) {
  const p = TSL.positionWorld.sub(TSL.uniform(opts.center.clone())).abs();
  const d = p.sub(TSL.uniform(opts.halfSize.clone())),
    edge = opts.edgeMetres ?? 1.6;
  const weight = TSL.smoothstep(edge, 0, TSL.max(d.y, TSL.max(d.x, d.z)));
  const sky = new THREE.HemisphereLight(0xffffff, 0, 1),
    ground = new THREE.HemisphereLight(0xffffff, 0, 1);
  sky.position.copy(opts.towardsOpenSky).normalize();
  ground.position.set(0.12, -0.97, 0.12);
  (sky as any).colorNode = frame.skyHorizon.mul(0.74).add(frame.skyZenith.mul(0.35)).mul(weight);
  (ground as any).colorNode = TSL.color(opts.groundColor)
    .mul(
      frame.sunColor
        .mul(frame.sunDirection.y.max(0))
        .mul(frame.sunVisibility)
        .mul(0.18)
        .add(frame.skyHorizon.mul(0.29)),
    )
    .mul(weight);
  scene.add(sky, ground);
  return {
    dispose() {
      sky.removeFromParent();
      ground.removeFromParent();
      sky.dispose();
      ground.dispose();
    },
  };
}
