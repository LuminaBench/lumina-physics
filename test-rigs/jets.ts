/** Fighter-jet rig wrapper (engine convention: forward = -Z, right = +X, up = +Y, metres). */
import * as THREE from 'three/webgpu';
import { buildFighterJet, JET_CATALOG } from './jets-model';
import { Actuator, NozzleAnimator } from '../modules/animation/actuators';
import { nozzleThrottle } from '../modules/aero/exhaust';
import { mergeStaticMeshes } from '../engine/batching';


export type JetId = 'f15e' | 'f16c' | 'f22' | 'fa18' | 'su57';
export const JET_IDS: JetId[] = ['f15e', 'f16c', 'f22', 'fa18', 'su57'];

export interface JetRig {
  id: JetId;
  name: string;
  object: THREE.Group;
  /** Wing-tip positions in rig space (vortex / condensation ribbon anchors). */
  wingTips: THREE.Vector3[];
  /** Nozzle exit positions in rig space (exhaust, heat haze, downwash). */
  nozzles: THREE.Vector3[];
  /** Fuselage length in metres (used to scale the vapour cone and shock ring). */
  length: number;
  wingSpan: number;
  /** 0..1 afterburner intensity. */
  setAfterburner(intensity: number, time: number, coreHeat?: number): void;
  setNozzlePower(index: number, intensity: number, time: number, coreHeat: number): void;
  /** Deflect control surfaces (-1..1). */
  setControls(pitch: number, roll: number, yaw: number): void;
  /**
   * Per-frame mechanical animation: control surfaces follow their commands through
   * rate-limited actuators and the nozzle petals dilate with power (open at idle, closed at
   * military power, wide open in afterburner).
   */
  animate(dt: number, state: { throttle: number; afterburner: number; engineThrottles?: ArrayLike<number>; pitch?: number; roll?: number; yaw?: number }): void;
  /** 0..1 current nozzle throat opening. */
  readonly nozzleArea: number;
  /** Release per-airframe geometry and materials. Procedural skin textures are shared. */
  dispose?(): void;
}

export function createJetRig(id: JetId = 'f22'): JetRig {
  const config = (JET_CATALOG as any[]).find((j) => j.id === id) ?? (JET_CATALOG as any[])[0];
  const built = buildFighterJet(config, false, false) as any;
  const object = new THREE.Group();
  object.name = `rig:${id}`;
  object.add(built.root);
  built.gearGroup && (built.gearGroup.visible = false);
  if (built.muzzleFlash) built.muzzleFlash.visible = false;
  for (const visual of built.missileVisuals ?? []) if (visual?.isObject3D) visual.visible = true;
  object.traverse((o) => { if ((o as THREE.Mesh).isMesh && !(o as any).material?.transparent) { o.castShadow = true; } });
  // ~100 meshes share a dozen materials: bake everything that never moves into one mesh per
  // material. Control surfaces, nozzles, plumes, strobes and anything switched on / off stay live.
  const live: THREE.Object3D[] = [
    ...(built.ailerons ?? []).map((a: any) => a.pivot), ...(built.elevators ?? []).map((e: any) => e.pivot), ...(built.rudders ?? []),
    ...(built.nozzleCones ?? []), ...(built.burnerMeshes ?? []), ...(built.strobes ?? []).map((s: any) => s?.mesh ?? s),
    built.gearGroup, built.muzzleFlash, built.burnerLight, ...(built.missileVisuals ?? []),
  ].filter((o: any) => o?.isObject3D);
  object.traverse((o) => { if ((o as any).material?.uniforms || (o as any).material?.transparent) live.push(o); });
  mergeStaticMeshes(object, live);
  const twin = config.nozzles === 2;
  const offset = twin ? (config.style === 'su57' ? 1.06 : 0.76) : 0;
  const nozzles = twin ? [new THREE.Vector3(-offset, 0.04, 8.30), new THREE.Vector3(offset, 0.04, 8.30)] : [new THREE.Vector3(0, 0.04, 8.30)];
  const wingTips: THREE.Vector3[] = (built.wingTips as THREE.Vector3[]).map((v) => v.clone());
  const actuators = nozzles.map((_, i) => new NozzleAnimator([built.nozzleCones[i]], {
    axis: 'z', apertureAxis: config.nozzleShape === 'rect' ? 'y' : undefined, closed: 0.78, open: 1.1,
  }));
  const nozzleAreas = new Float64Array(nozzles.length).fill(0.75);
  const stick = { pitch: new Actuator(3.2, 5, 0.8), roll: new Actuator(4.5, 7, 0.75), yaw: new Actuator(2.6, 4.5, 0.85) };
  const elevators = built.elevators ?? [];
  const ailerons = built.ailerons ?? [];
  const rudders = built.rudders ?? [];
  const burners = built.burnerMeshes ?? [];
  const strobes = built.strobes ?? [];
  let lastPitch = NaN, lastRoll = NaN, lastYaw = NaN;
  const setControls = (pitch: number, roll: number, yaw: number) => {
    if (pitch !== lastPitch) {
      for (let i = 0; i < elevators.length; i++) elevators[i].pivot.rotation.x = pitch * 0.32;
      lastPitch = pitch;
    }
    if (roll !== lastRoll) {
      for (let i = 0; i < ailerons.length; i++) ailerons[i].pivot.rotation.x = roll * 0.3 * ailerons[i].side;
      lastRoll = roll;
    }
    if (yaw !== lastYaw) {
      for (let i = 0; i < rudders.length; i++) rudders[i].rotation.y = yaw * 0.3;
      lastYaw = yaw;
    }
  };
  let nozzleArea = 0.75;
  const setNozzlePower = (index: number, intensity: number, time: number, coreHeat: number) => {
    const core = built.coreMaterials[index];
    core.emissive.setRGB(1, 0.085 + intensity * 0.42, 0.012 + intensity * 0.18);
    core.emissiveIntensity = coreHeat * coreHeat * 0.42 + intensity * 1.45;
    burners[index].setPower(intensity, time, 0.78 + 0.32 * nozzleAreas[index]);
    if (index === 0) {
      // Update the anti-collision lights once per aircraft.
      for (let i = 0; i < strobes.length; i++) {
        const phase = (time + i * 0.34) % 1.12;
        const pulse = 1 - THREE.MathUtils.smoothstep(phase, 0.026, 0.085);
        strobes[i].material.emissiveIntensity = 0.02 + 2.8 * pulse;
        strobes[i].children[0].visible = pulse > 0.01;
        strobes[i].children[0].material.opacity = pulse;
      }
    }
  };
  return {
    id,
    name: config.name,
    object,
    wingTips,
    nozzles,
    length: 19,
    wingSpan: Math.abs(wingTips[0].x) * 2,
    setAfterburner(intensity, time, coreHeat = intensity) {
      for (let i = 0; i < burners.length; i++) setNozzlePower(i, intensity, time, coreHeat);
    },
    setNozzlePower,
    setControls,
    animate(dt, state) {
      setControls(stick.pitch.step(state.pitch ?? 0, dt), stick.roll.step(state.roll ?? 0, dt), stick.yaw.step(state.yaw ?? 0, dt));
      let sum = 0;
      for (let i = 0; i < actuators.length; i++) {
        const throttle = nozzleThrottle(state.throttle, state.engineThrottles, i);
        const override = state.engineThrottles?.[i];
        const burner = Number.isFinite(override) ? THREE.MathUtils.smoothstep(throttle, 0.8, 1) : state.afterburner;
        sum += nozzleAreas[i] = actuators[i].update(dt, throttle, burner);
      }
      nozzleArea = sum / actuators.length;
    },
    dispose() {
      object.removeFromParent();
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      object.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (Array.isArray(mesh.material)) for (const material of mesh.material) materials.add(material);
        else if (mesh.material) materials.add(mesh.material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
    get nozzleArea() { return nozzleArea; },
  };
}
