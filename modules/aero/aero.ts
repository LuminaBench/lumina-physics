/**
 * Extreme aerodynamics for a fast aircraft: jet-over-water downwash, Prandtl–Glauert
 * vapour cone, sonic boom, wingtip condensation vortices, contrails and exhaust haze.
 *
 * The module is driven by plain kinematic state (position / orientation / velocity /
 * G-load), so it works with a scripted path, a Rapier body or your own flight model.
 */
import { CloudTrail } from './cloud-trail';
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame, auxPassthrough } from '../../engine/frame';
import { bakeCloudNoise } from '../../engine/noise';
import { visibleVolumeRay } from '../../engine/shaders/volume-ray';
import { viewportDepthAt } from '../../engine/shading';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import { EMIT, createEmitRequest } from '../../engine/particles';
import type { Ocean } from '../water/ocean';
import { TrailRibbon } from './trails';
import { nozzleThrottle } from './exhaust';
import { SPEED_OF_SOUND_SEA_LEVEL } from './flight';

const t = TSL;

/**
 * What the aero module needs from an aircraft model (rig space: forward = -Z, +Y up).
 * The bundled jet test rigs satisfy this; so does any model you describe the same way.
 */
export interface AeroRig {
  object: THREE.Object3D;
  /** Wing-tip positions (vortex ribbon anchors). */
  wingTips: THREE.Vector3[];
  /** Nozzle exit positions (exhaust haze, contrails). */
  nozzles: THREE.Vector3[];
  wingSpan: number;
  /** 0..1 afterburner intensity; `time` animates shock diamonds. */
  setAfterburner(intensity: number, time: number, coreHeat?: number): void;
  /** Optional indexed exhaust callback. Collective-only rigs receive the mean instead. */
  setNozzlePower?(index: number, intensity: number, time: number, coreHeat: number): void;
}

export interface AeroParams {
  /** 0..1 relative humidity: scales vapour cone, vortices and contrail density. */
  humidity: number;
  /** Altitude above which engine contrails form (m). Real value ≈ 8000; lower it for demos. */
  contrailAltitude: number;
  /** Mean water / ground level (m). */
  surfaceLevel: number;
  /** Altitude (m) below which the aircraft disturbs the water. */
  downwashCeiling: number;
}

export interface AeroState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** World velocity of the aircraft in m/s. */
  velocity: THREE.Vector3;
  /** Load factor (1 = level flight). */
  gLoad: number;
  /** Local flight-level weather. Supply both to use cold/humid exhaust formation. */
  airTemperatureC?: number;
  /** Local relative humidity over liquid water (0..1) at the wing. */
  relativeHumidity?: number;
  /** Relative humidity over ice, as a ratio (1 = saturation). */
  iceHumidity?: number;
  /** Optional wind at the aircraft in world m/s, including vertical motion. */
  windVelocity?: THREE.Vector3;
  /** Visual sink speed in the negative lift direction, m/s. Defaults to a load-dependent estimate. */
  wakeDescentMps?: number;
  /** 0..1 throttle (≥ 0.85 lights the afterburner). */
  throttle: number;
  /** Optional 0..1 combustion commands in rig.nozzles order. Zero cuts that engine. */
  engineThrottles?: ArrayLike<number>;
}

/** Vapour-cone intensity as a function of Mach: forms 0.95 → 1.0, collapses by ~1.06. */
export function prandtlGlauertIntensity(mach: number, humidity: number): number {
  // Outside the transonic band one of the two ramps below is exactly zero, so there is no cone.
  if ((mach <= 0.93 || mach >= 1.065) && humidity === humidity) return 0;
  const rise = THREE.MathUtils.smoothstep(mach, 0.93, 0.992);
  const fall = 1 - THREE.MathUtils.smoothstep(mach, 1.015, 1.065);
  return rise * fall * THREE.MathUtils.clamp(humidity * 1.25, 0, 1);
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wakeVelocity = new THREE.Vector3();
const _down = new THREE.Vector3();
const _trailWind = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
// Downwash rooster tail and mist curtain, as packed particle requests: they emit every frame of
// a low pass, and a packed request reaches the particle queue as one block copy.
const _downwashSpray = createEmitRequest();
_downwashSpray[EMIT.SPEED_JITTER] = 0.6;
_downwashSpray[EMIT.LIFE] = 2.6;
_downwashSpray[EMIT.LIFE_JITTER] = 0.5;
_downwashSpray[EMIT.SIZE] = 0.28;
_downwashSpray[EMIT.SIZE_END] = 1.1;
const _downwashMist = createEmitRequest();
_downwashMist[EMIT.SPREAD] = 5;
_downwashMist[EMIT.LIFE] = 6.5;
_downwashMist[EMIT.LIFE_JITTER] = 0.4;
_downwashMist[EMIT.SIZE] = 3;
const _downwashMistPos = new THREE.Vector3();
const _boomMistOpts = {
  position: _p, radius: 1, velocity: { x: 0, y: 5, z: 0 },
  spread: 9, life: 4.5, size: 5, sizeEnd: 22, count: 0,
};
const _boomShockOpts = { speed: 300, maxRadius: 650, strength: 0.45, condensation: 0 };

export class JetAero implements EngineModule {
  readonly params: AeroParams = { humidity: 0.75, contrailAltitude: 8000, surfaceLevel: 0, downwashCeiling: 70 };
  mach = 0;
  altitude = 1e4;
  /** Number of sonic booms triggered (QA / HUD). */
  booms = 0;
  /** 0..1 current vapour-cone density. */
  coneIntensity = 0;
  private state: AeroState | null = null;
  private previousMach = 0;
  private boomArmed = true;
  private cone: THREE.Mesh;
  private wakeCurtain: THREE.Mesh;
  private uWake = t.uniform(0);
  private uCone = t.uniform(0);
  private vortices: TrailRibbon[];
  private contrails: TrailRibbon[];
  private hazes: THREE.Mesh[];
  readonly cloudTrail: CloudTrail;
  private flybyArmed = true;
  private downwashCueDelay = 0;
  private readonly nozzlePower: Float64Array;
  readonly nozzleCoreHeat: Float64Array;
  private readonly throttleCommands: Float64Array;
  private vortexActiveTimer = 0;

  constructor(private engine: LuminaEngine, private fx: EffectsKit, private rig: AeroRig, private ocean: Ocean | null = null) {
    const channels = Math.max(1, rig.nozzles.length);
    this.nozzlePower = new Float64Array(channels);
    this.nozzleCoreHeat = new Float64Array(channels);
    this.throttleCommands = new Float64Array(channels);
    this.cloudTrail = new CloudTrail(engine);
    const material = this.condensateMaterial(false);
    this.cone = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1).translate(0, 0, 0.5), material);
    this.cone.name = 'transonic-condensation';
    this.cone.position.set(0, 0.2, -0.14 * rig.wingSpan);
    this.cone.visible = false;
    this.cone.renderOrder = 17;
    rig.object.add(this.cone);

    this.wakeCurtain = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1).translate(0, 0.5, 0.5), this.condensateMaterial(true));
    this.wakeCurtain.name = 'jet-spray-curtain';
    this.wakeCurtain.visible = false;
    this.wakeCurtain.renderOrder = 8;
    engine.pipeline.softScene.add(this.wakeCurtain);
    engine.prewarm(new THREE.Mesh(this.wakeCurtain.geometry, this.wakeCurtain.material), 2, engine.pipeline.softScene);

    this.vortices = rig.wingTips.map(() => new TrailRibbon({ life: 1.6, width: 0.22, widthEnd: 1.5, spacing: 5, capacity: 80, opacity: 0.6 }));
    this.contrails = rig.nozzles.map(() => new TrailRibbon({ life: 22, formationSeconds: 0.20, width: 1.4, widthEnd: 16, spacing: 22, capacity: 120, opacity: 0.5 }));
    for (let i = 0; i < this.vortices.length; i++) { this.vortices[i].mesh.visible = false; engine.scene.add(this.vortices[i].mesh); }
    for (let i = 0; i < this.contrails.length; i++) { this.contrails[i].mesh.visible = false; engine.scene.add(this.contrails[i].mesh); }
    this.hazes = rig.nozzles.map(() => fx.attachHaze(2.6, 0));
    // A jet often approaches from outside the initial view. Warm its dormant
    // condensation materials against the actual scene-pass attachments.
    const warm = new THREE.Group();
    warm.add(new THREE.Mesh(this.cone.geometry, material));
    for (const trail of [...this.vortices, ...this.contrails]) {
      warm.add(new THREE.Mesh(trail.mesh.geometry, trail.mesh.material));
    }
    engine.prewarm(warm, 2);
  }

  /** Integrate optical depth through the visible portion of the spray or condensation.
   * The mesh bounds define the sharp rear shock plane, including at grazing angles. */
  private condensateMaterial(wake: boolean): THREE.NodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide, fog: false,
    });
    const noise = bakeCloudNoise().base;
    material.colorNode = t.Fn(() => {
      const depth = wake ? this.engine.pipeline.sceneDepth.sample(t.screenUV).r : viewportDepthAt(t.screenUV);
      const { eye, ray, near, end, viewRay } = visibleVolumeRay(depth, t.vec3(-1, wake ? 0 : -1, 0), t.vec3(1));
      const steps = wake ? 10 : 9;
      const step = end.sub(near).div(steps);
      const dist = near.add(step.mul(0.5)).toVar();
      const column = t.float(0).toVar();
      t.Loop(steps, () => {
        const p = eye.add(ray.mul(dist)).toVar();
        const noiseUV = p.mul(wake ? t.vec3(1.8, 1.1, 3.7) : t.vec3(1.3, 1.3, 0.7));
        const eddy = t.texture3D(noise, noiseUV.sub(t.vec3(0, 0, frame.time.mul(wake ? 0.34 : 0.95))), 0).toVar();
        if (wake) {
          const arch = p.z.mul(p.z.oneMinus()).mul(3.4);
          const top = arch.mul(eddy.g.mul(0.47).add(0.73));
          const skirt = p.z.mul(0.54).add(0.21).add(eddy.b.sub(0.5).mul(0.19));
          const width = t.abs(t.abs(p.x).sub(skirt));
          const sheet = t.smoothstep(0.23, 0.025, width);
          const crown = t.smoothstep(0.25, 0.035, p.y.sub(top).abs());
          const body = t.smoothstep(top.add(0.08), top.mul(0.32), p.y);
          const ends = t.smoothstep(0, 0.09, p.z).mul(t.smoothstep(1, 0.83, p.z));
          column.addAssign(sheet.mul(body.mul(0.38).add(crown)).mul(ends).mul(t.smoothstep(0.26, 0.69, eddy.r)));
        } else {
          const edge = t.pow(p.z.max(0), 0.69).mul(0.79).add(0.13);
          const radial = t.length(p.xy).div(edge);
          const wall = t.smoothstep(1.06, 0.81, radial);
          const core = t.smoothstep(0.20, 0.84, radial).mul(0.75).add(0.25);
          column.addAssign(wall.mul(core).mul(eddy.r.mul(0.75).add(0.57)).mul(t.smoothstep(0, 0.075, p.z)));
        }
        dist.addAssign(step);
      });
      const extinction = wake ? this.uWake.mul(0.23) : this.uCone.mul(0.31);
      const alpha = column.mul(step).mul(t.length(viewRay)).mul(extinction).negate().exp().oneMinus();
      const sky = t.mix(frame.skyHorizon, frame.skyZenith, 0.23);
      // Convert incident solar irradiance to scattered radiance with a bounded
      // droplet phase function. Direct irradiance here clips white at midday.
      const toSun = t.dot(t.normalize(frame.sunDirection), t.normalize(t.positionWorld.sub(t.cameraPosition)));
      const phase = t.float(0.075).add(t.pow(toSun.max(0), 5).mul(0.083));
      const light = sky.mul(0.59).add(frame.sunColor.mul(frame.sunVisibility).mul(phase));
      return t.vec4(light, alpha);
    })();
    if (!wake) material.mrtNode = auxPassthrough();
    return material;
  }

  /** Feed the aircraft's kinematic state for this frame (call before the engine updates modules). */
  setState(state: AeroState): void {
    this.state = state;
    this.rig.object.position.copy(state.position);
    this.rig.object.quaternion.copy(state.quaternion);
    this.rig.object.updateWorldMatrix(true, false);
  }

  /** Stop a despawned or parked aircraft from emitting at its last flight pose. */
  clearState(): void {
    if (!this.state) return;
    this.state = null;
    this.previousMach = 0;
    this.boomArmed = true;
    this.cone.visible = this.wakeCurtain.visible = false;
    for (const haze of this.hazes) haze.visible = false;
    for (const trail of this.vortices) trail.clear();
    for (const trail of this.contrails) trail.clear();
    this.cloudTrail.reset();
  }

  private sonicBoom(position: THREE.Vector3, humidity: number): void {
    const { wind, physics, trauma, camera, events } = this.engine;
    this.booms++;
    _boomShockOpts.condensation = 0.075 * THREE.MathUtils.smoothstep(humidity, 0.62, 1);
    this.fx.shockwave(position, _boomShockOpts);
    wind.addBlast(position, 55, 260, 1.4, this.rig.object.id);
    physics?.applyBlast(position, 260, 2400, 0.2);
    const distance = position.distanceTo(camera.position);
    trauma.blast(distance * 0.55, 1.4);
    events.emitAt('sonicBoom', position, 1);
    // The N-wave slaps the sea: a sharp depression that rebounds as an expanding ring.
    const altitude = this.altitude;
    if (this.ocean && altitude >= 0 && altitude < 220 && this.ocean.depthAt(position.x, position.z) > 0) {
      const reach = 18 + altitude * 0.7;
      const punch = 1.3 * (1 - altitude / 220);
      const field = this.ocean.field, sources = field.sources, o = field.reserveSource();
      if (o >= 0) {
        sources[o] = position.x; sources[o + 1] = position.z; sources[o + 2] = reach;
        sources[o + 3] = 0; sources[o + 4] = -punch; sources[o + 5] = 5 * punch; sources[o + 6] = 0;
      }
      const sea = position.y - altitude;
      _p.set(position.x, sea + 1.5, position.z);
      _boomMistOpts.radius = reach * 0.7;
      _boomMistOpts.count = Math.floor(this.fx.mist.capacity * 0.12);
      this.fx.mist.emit(_boomMistOpts);
    }
  }

  update(dt: number, time: number): void {
    const s = this.state;
    if (!s || dt <= 0) return;
    const { camera, events } = this.engine;
    const p = this.params, ocean = this.ocean;
    // Each coordinate is read from its vector once and reused below. This method runs once per
    // frame, so V8 keeps it in its unoptimised tiers for a long time, and there every repeated
    // read of a double field allocates another HeapNumber.
    const position = s.position, velocity = s.velocity;
    const px = position.x, py = position.y, pz = position.z;
    const speed = velocity.length();
    const world = this.engine.world;
    const temperature = s.airTemperatureC ?? (world.climate ? world.airTemperatureAt(py) : undefined);
    const wind = s.windVelocity ?? this.engine.wind.sample(position, time, _trailWind, this.rig.object.id);
    const airspeed = velocity.distanceTo(wind);
    const soundSpeed = temperature !== undefined && Number.isFinite(temperature) && temperature > -273.15
      ? Math.sqrt(1.4 * 287.05 * (temperature + 273.15)) : SPEED_OF_SOUND_SEA_LEVEL;
    const mach = this.mach = airspeed / soundSpeed;
    const dxCam = camera.position.x - px;
    const dyCam = camera.position.y - py;
    const dzCam = camera.position.z - pz;
    const camDistSq = dxCam * dxCam + dyCam * dyCam + dzCam * dzCam;

    // Spatial query LOD: only query choppy FFT waves when low enough to interact with the sea or near the camera.
    const surfaceLevel = ocean?.waterLevel ?? p.surfaceLevel, downwashCeiling = p.downwashCeiling;
    let sea = surfaceLevel;
    if (ocean) {
      const roughAlt = py - surfaceLevel;
      const queryCeiling = (downwashCeiling > 220 ? downwashCeiling : 220) + 35;
      if (roughAlt < queryCeiling || camDistSq < 600 * 600) {
        sea = ocean.heightAt(px, pz);
      }
    }
    const altitude = this.altitude = py - sea;

    this.cloudTrail.update(position);
    const humidity = s.relativeHumidity ?? p.humidity;
    this.updateCone(humidity);
    // ---- sonic boom ------------------------------------------------------------
    const previousMach = this.previousMach;
    if (mach <= 0.98) this.boomArmed = true;
    if (mach >= 1) {
      if (this.boomArmed && previousMach > 0 && previousMach < 1) this.sonicBoom(position, humidity);
      this.boomArmed = false;
    }
    this.previousMach = mach;

    this.updateExhaust(s, time, camDistSq, dt);
    this.updateTrails(s, airspeed, wind, temperature, dt);
    this.wakeCurtain.visible = false;
    if (ocean && speed > 10 && downwashCeiling > 0 && altitude < downwashCeiling && altitude > -2 && ocean.depthAt(px, pz) > 0) {
      const field = ocean.field, center = field.center, margin = field.extent * 0.5 + 180;
      const inField = Math.abs(px - center.x) <= margin && Math.abs(pz - center.y) <= margin;
      // A remote pass cannot reach this finite wave field. Its fine spray is also
      // subpixel beyond the visible plume range; gameplay listeners still get cues.
      if (inField || camDistSq < 1500 * 1500 || events.hasListeners('downwash')) {
        this.updateDownwash(ocean, s, speed, sea, dt, inField, camDistSq);
      }
    } else {
      this.downwashCueDelay = 0;
    }

    // ---- fly-by cue ------------------------------------------------------------
    // While the cue is armed and the jet is out of earshot, its heading cannot change anything.
    if (!this.flybyArmed || camDistSq < 900 * 900) {
      const closing = dxCam * velocity.x + dyCam * velocity.y + dzCam * velocity.z > 0;
      if (closing) this.flybyArmed = true;
      else if (this.flybyArmed && camDistSq < 900 * 900) {
        this.flybyArmed = false;
        events.emit('flyby', { position: [px, py, pz], intensity: mach < 1 ? mach : 1, params: { mach } });
      }
    }
  }

  private updateCone(humidity: number): void {
    const mach = this.mach;
    const intensity = this.coneIntensity = prandtlGlauertIntensity(mach, humidity);
    // A number uniform holds a tagged value: storing an unchanged number would box it again.
    if (this.uCone.value !== intensity) this.uCone.value = intensity;
    const showCone = intensity > 0.01;
    this.cone.visible = showCone;
    if (showCone) {
      // The wing shock widens while the aft plane remains just ahead of the tail.
      const growth = THREE.MathUtils.smoothstep(mach, 0.94, 1.03);
      const radius = this.rig.wingSpan * (0.47 + growth * 0.18);
      this.cone.scale.set(radius, radius, 0.45 * this.rig.wingSpan);
    }
  }

  private updateExhaust(s: AeroState, time: number, camDistSq: number, dt: number): void {
    const camera = this.engine.camera;
    const hazes = this.hazes;
    const nozzles = this.rig.nozzles;
    const rigMatrix = this.rig.object.matrixWorld;
    let totalPower = 0, totalHeat = 0;
    for (let i = 0; i < this.nozzlePower.length; i++) {
      const throttle = this.throttleCommands[i] = nozzleThrottle(s.throttle, s.engineThrottles, i);
      const demand = THREE.MathUtils.smoothstep(throttle, 0.80, 1);
      const power = this.nozzlePower[i], heat = this.nozzleCoreHeat[i];
      const burner = this.nozzlePower[i] = power + (demand - power) * -Math.expm1(-dt * (demand > power ? 7 : 12));
      const core = this.nozzleCoreHeat[i] = heat + (throttle - heat) * -Math.expm1(-dt * (throttle > heat ? 1.8 : 0.65));
      totalPower += burner;
      totalHeat += core;
      if (i < nozzles.length) this.rig.setNozzlePower?.(i, burner, time, core);
    }
    if (!this.rig.setNozzlePower || !nozzles.length)
      this.rig.setAfterburner(totalPower / this.nozzlePower.length, time, totalHeat / this.nozzlePower.length);

    // Only project the shared nozzle axis when an outlet is close and hot.
    if (camDistSq < 1200 * 1200 && (totalHeat > 0.02 || totalPower > 0.015)) {
      const jet = rigMatrix.elements, view = camera.matrixWorld.elements;
      const across = jet[8]*view[0]+jet[9]*view[1]+jet[10]*view[2];
      const up = jet[8]*view[4]+jet[9]*view[5]+jet[10]*view[6];
      const projected = Math.min(1,Math.sqrt(across*across+up*up));
      const angle = Math.atan2(-across,up);
      for (let i = 0; i < hazes.length; i++) {
        const haze = hazes[i];
        const burner = this.nozzlePower[i], heat = this.nozzleCoreHeat[i];
        haze.visible = heat > 0.02 || burner > 0.015;
        if (!haze.visible) continue;
        const hazeStrength = heat * 0.55 + burner * 0.9;
        const hazeScale = 4.5 + burner * 2;
        haze.position.copy(nozzles[i]).add(_v.set(0, 0, 5.5)).applyMatrix4(rigMatrix);
        haze.quaternion.copy(camera.quaternion);
        haze.rotateZ(angle);
        haze.userData.hazeStrength = hazeStrength;
        haze.scale.set(hazeScale*0.60, hazeScale*(0.60+projected*0.93), 1);
      }
    } else {
      for (let i = 0; i < hazes.length; i++) hazes[i].visible = false;
    }
  }

  private updateTrails(s: AeroState, speed: number, releaseWind: THREE.Vector3, temperature: number | undefined, dt: number): void {
    const p = this.params, humidity = p.humidity, contrailAltitude = p.contrailAltitude;
    const nozzles = this.rig.nozzles;
    const rigMatrix = this.rig.object.matrixWorld;
    const wetAir = THREE.MathUtils.clamp(s.relativeHumidity ?? humidity, 0, 1);
    const lift = THREE.MathUtils.smoothstep(Math.abs(s.gLoad), 0.55, 4.2);
    const vortex = THREE.MathUtils.smoothstep(wetAir + lift * 0.24, 0.71, 1.05)
      * THREE.MathUtils.smoothstep(speed, 45, 155) * (0.22 + lift * 0.78) * THREE.MathUtils.smoothstep(Math.abs(s.gLoad), 0, 0.45);
    const vortices = this.vortices;
    const wingTips = this.rig.wingTips;
    if (vortex > 0.04) {
      const span = Math.max(0.5, this.rig.wingSpan);
      const clearance = THREE.MathUtils.smoothstep(this.altitude / span, 0.12, 1);
      const sink = Math.max(0, s.wakeDescentMps ?? (0.65 + lift * 2.1));
      _down.set(0, -Math.sign(s.gLoad), 0).applyQuaternion(s.quaternion);
      _right.set(1, 0, 0).applyQuaternion(s.quaternion);
      _right.y = 0;
      _right.normalize();
      this.vortexActiveTimer = 1.8;
      for (let i = 0; i < vortices.length; i++) {
        const trail = vortices[i];
        trail.mesh.visible = true;
        // Carry the release bank, local wind and ground-induced lateral spread with this sample.
        _wakeVelocity.copy(releaseWind).addScaledVector(_down, sink * clearance)
          .addScaledVector(_right, Math.sign(wingTips[i].x) * sink * (1 - clearance));
        trail.setSeaLevel(p.surfaceLevel);
        trail.push(_p.copy(wingTips[i]).applyMatrix4(rigMatrix), vortex, _wakeVelocity, speed);
        trail.update(dt);
      }
    } else if (this.vortexActiveTimer > 0) {
      const remaining = this.vortexActiveTimer -= dt;
      for (let i = 0; i < vortices.length; i++) {
        const trail = vortices[i];
        if (remaining <= 0) {
          trail.clear();
          trail.mesh.visible = false;
        } else {
          trail.release();
          trail.update(dt);
        }
      }
    }

    // Local atmosphere overrides the authored altitude band when a game has flight-level weather.
    const world = this.engine.world;
    const iceHumidity = s.iceHumidity ?? world.iceHumidityAt(s.position.y);
    const contrail = temperature !== undefined && iceHumidity !== undefined
      ? THREE.MathUtils.smoothstep(-temperature, 38, 48) * THREE.MathUtils.smoothstep(iceHumidity, 0.78, 1.10)
      : THREE.MathUtils.smoothstep(s.position.y, contrailAltitude, contrailAltitude + 400) * humidity;
    for (let i = 0; i < this.contrails.length; i++) {
      const trail = this.contrails[i];
      const strength = contrail * THREE.MathUtils.smoothstep(this.throttleCommands[i], 0, 0.35);
      if (strength > 0.04) {
        trail.mesh.visible = true;
        trail.setSeaLevel(p.surfaceLevel);
        trail.push(_p.copy(nozzles[i]).applyMatrix4(rigMatrix), strength, releaseWind, speed);
      } else {
        if (!trail.mesh.visible) continue;
        trail.release();
      }
      trail.update(dt);
      if (!trail.hasSamples) trail.mesh.visible = false;
    }
  }

  private updateDownwash(ocean: Ocean, s: AeroState, speed: number, sea: number, dt: number, inField: boolean, distanceSq: number): void {
    _fwd.set(0, 0, -1).applyQuaternion(s.quaternion);
    _right.set(1, 0, 0).applyQuaternion(s.quaternion);
    // The physical inputs every term below shares, read once.
    const altitude = this.altitude;
    const px = s.position.x, pz = s.position.z;
    const fwdX = _fwd.x, fwdZ = _fwd.z;
    const proximity = Math.pow(1 - Math.max(0, altitude) / this.params.downwashCeiling, 1.6) * THREE.MathUtils.smoothstep(speed, 10, 65);
    const energy = proximity * THREE.MathUtils.clamp(speed / 140, 0.25, 2.4);
    const footprint = 6 + altitude * 0.45;
    // Travelling pressure trough under the fuselage + two trailing vortex furrows.
    // Push scales with speed so the imprint depth does not depend on how long the jet dwells over a texel.
    if (inField) {
      const field = ocean.field, sources = field.sources;
      const dwell = (speed > 40 ? speed : 40) * 0.01;
      let o = field.reserveSource();
      if (o >= 0) {
        sources[o] = px; sources[o + 1] = pz; sources[o + 2] = footprint;
        sources[o + 3] = -9 * proximity * dwell; sources[o + 4] = 0; sources[o + 5] = 2.2 * energy; sources[o + 6] = 0;
      }

      const behind = 14 + altitude * 0.3;
      const halfSpan = this.rig.wingSpan * 0.5;
      const bx = px - fwdX * behind, bz = pz - fwdZ * behind;
      const rightX = _right.x, rightZ = _right.z;
      const furrowRadius = footprint * 0.6, furrowPush = -4 * proximity * dwell, furrowFoam = 1.6 * energy;
      for (let side = -1; side <= 1; side += 2) {
        o = field.reserveSource();
        if (o < 0) continue;
        sources[o] = bx + rightX * side * halfSpan; sources[o + 1] = bz + rightZ * side * halfSpan; sources[o + 2] = furrowRadius;
        sources[o + 3] = furrowPush; sources[o + 4] = 0; sources[o + 5] = furrowFoam; sources[o + 6] = 0;
      }
      // Pool the nozzles into one scour source at the power-weighted lateral position.
      // The three aerodynamic sources above continue during unpowered flight.
      let power = this.throttleCommands[0], shift = 0;
      if (s.engineThrottles && this.rig.nozzles.length > 1) {
        const nozzles = this.rig.nozzles;
        let sum = 0, weighted = 0, center = 0;
        for (let i = 0; i < nozzles.length; i++) {
          const throttle = this.throttleCommands[i], x = nozzles[i].x;
          sum += throttle; weighted += throttle * x; center += x;
        }
        power = sum / nozzles.length;
        if (sum > 0) shift = weighted / sum - center / nozzles.length;
      }
      o = power > 0 ? field.reserveSource() : -1;
      if (o >= 0) {
        const shock = this.mach > 1 ? 1.8 : 1;
        const aft = behind + 18, active = THREE.MathUtils.smoothstep(power, 0, 0.18);
        sources[o] = px - fwdX * aft + rightX * shift; sources[o + 1] = pz - fwdZ * aft + rightZ * shift; sources[o + 2] = footprint * 1.4;
        sources[o + 3] = furrowPush * shock * (0.4 * active + power); sources[o + 4] = 0; sources[o + 5] = 3.5 * energy * power; sources[o + 6] = 0;
      }
    }

    // Ballistic rooster tail + dense trailing mist curtain torn off the surface.
    const spray = this.fx.spray, mist = this.fx.mist;
    const seaY = sea + 0.4;
    const clampedEnergy = Math.min(1, energy);
    this.downwashCueDelay -= dt;
    if (this.downwashCueDelay <= 0 && this.engine.events.hasListeners('downwash')) {
      this.downwashCueDelay = 0.25;
      this.engine.events.emitAt('downwash', _p.set(px, seaY, pz), clampedEnergy);
    }
    if (distanceSq >= 1500 * 1500) return;
    const visible = 1 - THREE.MathUtils.smoothstep(distanceSq, 700 * 700, 1500 * 1500);
    this.uWake.value = visible * clampedEnergy;
    this.wakeCurtain.visible = this.uWake.value > 0.025 && speed > 35;
    this.wakeCurtain.position.set(px - fwdX * 5, sea, pz - fwdZ * 5);
    this.wakeCurtain.rotation.y = Math.atan2(-fwdX, -fwdZ);
    this.wakeCurtain.scale.set(footprint + this.rig.wingSpan * 0.66, 4 + 14 * clampedEnergy, 35 + Math.min(speed, 330) * 0.34);
    const back = 10 + Math.random() * 16;
    const flank = (Math.random() < 0.5 ? -1 : 1) * this.rig.wingSpan * 0.49;
    const vx = s.velocity.x, vz = s.velocity.z;
    const tail = _downwashSpray;
    tail[EMIT.X] = px - fwdX * back + _right.x * flank; tail[EMIT.Y] = seaY; tail[EMIT.Z] = pz - fwdZ * back + _right.z * flank;
    tail[EMIT.RADIUS] = footprint * 0.75;
    tail[EMIT.VELOCITY_X] = vx * 0.16 + _right.x * flank;
    tail[EMIT.VELOCITY_Y] = 9 + 13 * energy;
    tail[EMIT.VELOCITY_Z] = vz * 0.16 + _right.z * flank;
    tail[EMIT.SPREAD] = 7 + 9 * energy;
    spray.emitRatePacked('downwash', (spray.burstBudget / 2.6) * 0.8 * clampedEnergy * visible, dt, tail);

    const mistBack = back + 12;
    const curtain = _downwashMist;
    // The lens is splashed from the same point the curtain is born at.
    const mistX = px - fwdX * mistBack, mistY = seaY + 2, mistZ = pz - fwdZ * mistBack;
    _downwashMistPos.x = mistX; _downwashMistPos.y = mistY; _downwashMistPos.z = mistZ;
    curtain[EMIT.X] = mistX; curtain[EMIT.Y] = mistY; curtain[EMIT.Z] = mistZ;
    curtain[EMIT.RADIUS] = footprint * 1.1;
    curtain[EMIT.VELOCITY_X] = vx * 0.07;
    curtain[EMIT.VELOCITY_Y] = 3 + 5 * energy;
    curtain[EMIT.VELOCITY_Z] = vz * 0.07;
    curtain[EMIT.SIZE_END] = 13 + 8 * energy;
    mist.emitRatePacked('downwash', (mist.burstBudget / 6.5) * 0.5 * clampedEnergy * visible, dt, curtain);

    this.engine.lens.splashAt(_downwashMistPos, footprint * 1.3, clampedEnergy * 0.9);
  }

  dispose(): void {
    this.cloudTrail.reset();
    for (let i = 0; i < this.vortices.length; i++) this.vortices[i].dispose();
    for (let i = 0; i < this.contrails.length; i++) this.contrails[i].dispose();
    for (let i = 0; i < this.hazes.length; i++) this.hazes[i].removeFromParent();
    this.cone.removeFromParent();
    this.wakeCurtain.removeFromParent();
    this.wakeCurtain.geometry.dispose();
    (this.wakeCurtain.material as THREE.Material).dispose();
    this.cone.geometry.dispose();
    (this.cone.material as THREE.Material).dispose();
  }
}

export { applyRotorWash, RotorWash } from './rotor-wash';
export { CloudTrail } from './cloud-trail';
