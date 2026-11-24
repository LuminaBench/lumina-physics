/**
 * Rain streaks.
 *
 * A camera-centred wrapping volume of velocity-aligned streaks. The whole simulation is a
 * closed-form function of (instance id, time, wind) evaluated in the vertex shader – no
 * buffers, no compute – so it is free on every backend and never needs warm-up. Streaks
 * slant with the unified wind field and are lit by the sky ambient (and lightning).
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxPassthrough } from '../../engine/frame';
import { hash33 } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
type RainContext = Pick<LuminaEngine, 'world' | 'scene' | 'wind' | 'time'> & {
  camera: Pick<THREE.Camera, 'position'>;
  quality: { preset: QualityPreset };
  stats: { frameMs: number };
  lens: { rain: number };
};

const { Fn, float, vec3, vec4, uniform, instanceIndex, positionGeometry, cameraPosition, normalize, cross, length, mix, smoothstep, max, select, uv, abs } = TSL;

const _rainWind = new THREE.Vector3();
/** Extent (m) of the box of streaks that rides with the camera. */
const BOX_X = 70, BOX_Y = 40, BOX_Z = 70;
/** The CPU-integrated drift wraps every 64 boxes, which keeps it small without a visible seam. */
const DRIFT_WRAP_X = BOX_X * 64, DRIFT_WRAP_Z = BOX_Z * 64;

export class Rain implements EngineModule {
  mesh!: THREE.InstancedMesh;
  /** Overrides the weather's rain intensity when ≥ 0. */
  intensityOverride = -1;
  private uIntensity = uniform(0);
  private uWind = uniform(new THREE.Vector3());
  private uDrift = uniform(new THREE.Vector3());
  private box = new THREE.Vector3(BOX_X, BOX_Y, BOX_Z);

  constructor(private engine: RainContext, private weather: { params: { rain: number } }, private clock: N = frame.time, private seedOffset = 0) {
    this.build(engine.quality.preset);
  }

  private build(preset: QualityPreset): void {
    if (this.mesh) { this.mesh.removeFromParent(); (this.mesh.material as THREE.Material).dispose(); this.mesh.geometry.dispose(); this.mesh.dispose(); }
    const count = Math.round(THREE.MathUtils.clamp(preset.particles.budget * 0.45, 1500, 22000));
    const box = this.box;
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fog = false;

    const id = float(instanceIndex).add(this.seedOffset);
    const seed = hash33(vec3(id.mul(0.1371), id.mul(0.0731).add(3.1), id.mul(0.0419).add(7.7)));
    const fall = mix(7.5, 11.5, seed.y);
    const boxN = vec3(box.x, box.y, box.z);
    // Horizontal drift is integrated on the CPU (gust-safe); fall speed is per streak.
    const raw = seed.mul(boxN).add(vec3(this.uDrift.x, fall.negate().mul(this.clock), this.uDrift.z));
    // Wrap into a box that rides with the camera.
    const local = raw.sub(cameraPosition).add(boxN.mul(0.5)).mod(boxN).sub(boxN.mul(0.5));
    const anchor = cameraPosition.add(local);
    const localAir = this.engine.world.localWindNode(anchor);
    const center = anchor.add(localAir.mul(seed.z.mul(0.26)));
    const velocity = vec3(this.uWind.x,fall.negate(),this.uWind.z).add(localAir);
    const speed = length(velocity);
    const dir = velocity.div(speed);
    const toCamera = cameraPosition.sub(center);
    const dist = length(toCamera);
    const side = normalize(cross(dir, toCamera.div(max(dist, 0.01))).add(vec3(1e-5, 0, 0)));
    const visible = select(seed.x.lessThan(this.uIntensity), float(1), float(0));
    const streakLength = speed.mul(0.03).mul(mix(0.7, 1.3, seed.z));
    const skyward = vec3(velocity.x.negate(), velocity.y.negate(), velocity.z.negate());
    const exposure = this.engine.world.shelters.rainNode(center, skyward);
    const width = float(0.0055).add(dist.mul(0.00085)).mul(visible).mul(exposure);
    material.positionNode = center.add(dir.mul(positionGeometry.y.mul(streakLength))).add(side.mul(positionGeometry.x.mul(width)));

    const vFade = smoothstep(box.x * 0.5, box.x * 0.3, dist).mul(smoothstep(0.6, 3.0, dist)).toVarying('rainFade');
    material.colorNode = Fn(() => {
      const st = uv();
      const profile = smoothstep(0.5, 0.1, abs(st.x.sub(0.5))).mul(smoothstep(0.0, 0.25, st.y)).mul(smoothstep(1.0, 0.6, st.y));
      const light = mix(frame.skyHorizon, frame.skyZenith, 0.5).mul(2.6).add(frame.sunColor.mul(frame.sunVisibility).mul(0.05));
      return vec4(light, profile.mul(vFade).mul(0.34));
    })();
    if (this.clock === frame.time) material.mrtNode = auxPassthrough();

    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 16;
    this.mesh.name = 'lumina-rain';
    this.engine.scene.add(this.mesh);
  }

  /** How strongly rain wets the camera lens (0 = a sheltered camera). */
  lensWetting = 0.45;

  setQuality(preset: QualityPreset): void { this.build(preset); }

  update(dt = this.engine.stats.frameMs / 1000): void {
    const { wind, camera, time } = this.engine;
    const override = this.intensityOverride;
    const intensity = override >= 0 ? override : this.weather.params.rain;
    // A number uniform holds a tagged value, so storing an unchanged number would box it again.
    if (this.uIntensity.value !== intensity) this.uIntensity.value = intensity;
    this.mesh.visible = intensity > 0.01;
    // Rain reaches the lens too (a camera under water is already as wet as it gets).
    const w = wind.ambientWind(camera.position, time, _rainWind);
    const vx = w.x * 0.85, vz = w.z * 0.85;
    (this.uWind.value as THREE.Vector3).set(vx, 0, vz);
    const { x, y, z } = camera.position;
    this.engine.lens.rain = intensity * this.lensWetting * this.engine.world.shelters.exposureAt(x, y, z, -vx, 9.5, -vz);
    const drift = this.uDrift.value as THREE.Vector3;
    drift.x = (drift.x + vx * dt) % DRIFT_WRAP_X;
    drift.z = (drift.z + vz * dt) % DRIFT_WRAP_Z;
  }

  dispose(): void {
    this.engine.lens.rain = 0;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export type { N as _N };
