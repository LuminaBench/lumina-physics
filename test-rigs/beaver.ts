/** DHC-2 Beaver floatplane rig wrapper (engine convention: forward = -Z, right = +X, up = +Y, metres). */
import * as THREE from 'three/webgpu';
import { buildBeaverModel } from './beaver-model';
import { RotorBlur } from '../modules/animation/rotor';
import { mergeStaticMeshes } from '../engine/batching';


export interface BeaverRig {
  /** Add this to the scene / bind it to a rigid body. Origin sits at the float waterline. */
  object: THREE.Group;
  /** Hull sample points in rig space (4 per float, bow → stern) for buoyancy + wake sources. */
  floatPoints: THREE.Vector3[];
  /** Bow and stern of each float (rig space) for spray / wake emitters. */
  bows: THREE.Vector3[];
  sterns: THREE.Vector3[];
  /** Propeller hub in rig space (prop-wash source). */
  propHub: THREE.Vector3;
  /** Approximate collision half extents (wings excluded). */
  halfExtents: THREE.Vector3;
  mass: number;
  /** Spin the propeller; `rpmFraction` 0..1 also swaps blades for the motion-blur disc. */
  update(dt: number, rpmFraction: number): void;
}

export function createBeaverRig(): BeaverRig {
  const model = buildBeaverModel();
  // Source model: nose -X. Rotate so the nose points -Z.
  model.air.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  const object = new THREE.Group();
  object.name = 'rig:dhc2-beaver';
  object.add(model.air);
  object.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // Everything but the propeller is rigid: one mesh per material.
  const transparent: THREE.Object3D[] = [];
  object.traverse((o) => { if ((o as any).material?.transparent) transparent.push(o); });
  mergeStaticMeshes(object, [model.prop, model.blur, ...transparent]);
  // The shutter-integrated rotor represents the complete exposed blade area.
  // Keep the model's standalone illustration disc out of this camera exposure.
  model.blur.visible = false;
  const rotor = new RotorBlur({
    radius: 1.293,
    hubRadius: 0.18,
    blades: 2,
    chord: [0.18, 0.085],
    color: 0x262f32,
    tipColor: 0xf46822,
    tipBand: 0.13,
    shutter: 1 / 95,
    density: 1.65,
  });
  rotor.mesh.position.copy(model.prop.position);
  rotor.mesh.rotation.y = Math.PI / 2;
  model.prop.parent!.add(rotor.mesh);

  let previousBladeFade = NaN;
  const floatPoints: THREE.Vector3[] = [];
  for (const side of [-1.225, 1.225]) for (const z of [-3.7, -1.7, 0.4, 2.6]) floatPoints.push(new THREE.Vector3(side, 0.1, z));
  return {
    object,
    floatPoints,
    bows: [new THREE.Vector3(-1.225, 0.2, -4.2), new THREE.Vector3(1.225, 0.2, -4.2)],
    sterns: [new THREE.Vector3(-1.225, 0.0, 3.0), new THREE.Vector3(1.225, 0.0, 3.0)],
    propHub: new THREE.Vector3(0, 2.59, -3.86),
    halfExtents: new THREE.Vector3(1.6, 1.3, 4.4),
    mass: 2300,
    update(dt, rpmFraction) {
      const rpm = THREE.MathUtils.clamp(rpmFraction, 0, 1);
      // 2300 rpm at full power.
      const angle = rotor.update(dt, rpm * 2300 * (Math.PI * 2) / 60);
      model.prop.rotation.x = angle;
      // Smooth RPM-aware hand-over: crisp 3D blades at idle, blended strobe sweep in taxi,
      // and shutter blur + sunlit tip ring at cruise / full power.
      const bladeFade = rotor.blurred ? (1 - THREE.MathUtils.smoothstep(rpm, 0.14, 0.42)) : 1;
      if (bladeFade !== previousBladeFade) {
        previousBladeFade = bladeFade;
        for (const m of model.movingBlades) {
          m.transparent = bladeFade < 0.99;
          m.depthWrite = bladeFade > 0.65;
          m.opacity = bladeFade;
        }
      }
    },
  };
}
