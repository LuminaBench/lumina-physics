import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { WorldBus } from '../../engine/world-bus';
import { QUALITY_PRESETS } from '../../engine/quality';
import { Rain } from './rain';
import { WEATHER_PRESETS } from './weather';
import {
  resolveWorldProfile,
  patchWorldProfile,
  SKY_STATES,
  type WorldProfile,
  type ResolvedWorldProfile,
  type ProfilePatch,
} from './world-profile';

export interface ProfileControls {
  readonly profile: ResolvedWorldProfile;
  patch(change: ProfilePatch, transitionSeconds?: number): ResolvedWorldProfile;
  dispose(): void;
}
export interface RainHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  fields?: WorldBus;
}
export interface RainAttachment extends ProfileControls {
  update(dt: number): void;
  rain: Rain;
}

/** A host owns its renderer, scene graph, camera and clock. Only the rain mesh is attached. */
export function attachWorldRain(input: WorldProfile, host: RainHost): RainAttachment {
  if (input.mode && input.mode !== 'attach') throw new Error('A host rain profile requires attach mode');
  let profile = resolveWorldProfile({ ...input, mode: 'attach' });
  const fields = host.fields ?? new WorldBus();
  const clock = TSL.uniform(0);
  const local = {
    scene: host.scene,
    camera: { position: host.camera.getWorldPosition(new THREE.Vector3()) },
    world: fields,
    wind: fields,
    time: 0,
    quality: { preset: QUALITY_PRESETS[profile.quality === 'auto' ? 'high' : profile.quality] },
    stats: { frameMs: 16.67 },
    lens: { rain: 0 },
  };
  const sky = { params: { rain: WEATHER_PRESETS[SKY_STATES[profile.weather]].rain } };
  const rain = new Rain(local, sky, clock, profile.seed % 8191);
  rain.update(0);
  let disposed = false;
  return {
    rain,
    get profile() {
      return profile;
    },
    update(dt) {
      if (disposed) return;
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Expected nonnegative seconds');
      host.camera.getWorldPosition(local.camera.position);
      local.time += dt;
      clock.value = local.time;
      rain.update(dt);
    },
    patch(change) {
      if (disposed) throw new Error('Rain attachment is disposed');
      const next = patchWorldProfile(profile, change);
      sky.params.rain = WEATHER_PRESETS[SKY_STATES[next.weather]].rain;
      if (next.quality !== profile.quality)
        rain.setQuality(QUALITY_PRESETS[next.quality === 'auto' ? 'high' : next.quality]);
      rain.update(0);
      return (profile = next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rain.dispose();
      if (!host.fields) fields.shelters.dispose();
    },
  };
}
