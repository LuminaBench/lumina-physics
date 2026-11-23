/**
 * Tsunami crest effects: roaring spray curtains torn off the breaking lip, a rolling
 * mist bank behind the bore, foam injected into the interaction field.
 */
import * as THREE from 'three/webgpu';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from './ocean';

const _crest = new THREE.Vector3();
const SPRAY_KEYS = ['ts0', 'ts1', 'ts2'];
const MIST_KEYS = ['tm0', 'tm1', 'tm2'];

export class TsunamiEffects implements EngineModule {
  /** World point effects are concentrated around (usually the camera target). */
  readonly focus = new THREE.Vector3();
  /** Half-length (m) of the crest segment that spawns spray. */
  reach = 190;
  private broke = false;
  private spray = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), radius: 0, spread: 0,
    speedJitter: 0.45, life: 3, lifeJitter: 0.4, size: 0.4, sizeEnd: 2,
  };
  private mist = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), radius: 0, spread: 4,
    life: 5, lifeJitter: 0.4, size: 6, sizeEnd: 22,
  };

  constructor(private engine: LuminaEngine, private fx: EffectsKit, private ocean: Ocean) {}

  update(dt: number): void {
    const tsunami = this.ocean.tsunami;
    if (!tsunami.active || dt <= 0) {
      this.broke = false;
      return;
    }
    const { fx, engine } = this;
    const p = tsunami.profile;
    const dirX = Math.cos(p.direction), dirZ = Math.sin(p.direction);
    const focusX = this.focus.x, focusZ = this.focus.z;
    const focusCross = -focusX * dirZ + focusZ * dirX;
    const focusAlong = focusX * dirX + focusZ * dirZ;
    const distance = focusAlong - tsunami.front; // > 0: wave has not reached the focus yet
    const amp = tsunami.amplitude;
    const H = p.height * amp;
    const near = 1 - THREE.MathUtils.smoothstep(Math.abs(distance), 250, 900);
    if (near < 0.02) return;

    const breaking = p.breaking * amp;
    // Everything the three emitters share is derived once per frame, not once per emitter.
    const { spray, mist } = this;
    const sprayPosition = spray.position, sprayVelocity = spray.velocity;
    const mistPosition = mist.position, mistVelocity = mist.velocity;
    const field = this.ocean.field, sources = field.sources;
    const base = this.ocean.waterLevel;
    const reach = this.reach;
    const runX = dirX * p.speed, runZ = dirZ * p.speed;
    const sprayRate = fx.spray.burstBudget * 0.067 * breaking * near;
    const mistRate = fx.mist.burstBudget * 0.035 * (0.3 + breaking) * near;
    sprayVelocity.x = runX * 0.95; sprayVelocity.z = runZ * 0.95;
    mistVelocity.x = runX * 0.55; mistVelocity.z = runZ * 0.55;
    const mistBackX = dirX * 0.9, mistBackZ = dirZ * 0.9;
    const foamAheadX = runX * 0.4, foamAheadZ = runZ * 0.4;
    const foamImpulse = -0.03 * breaking, foamGain = 7 * breaking;
    // Several emitters per frame spread randomly along the visible crest.
    for (let i = 0; i < 3; i++) {
      const cross = focusCross + (Math.random() * 2 - 1) * reach;
      tsunami.crestBase(cross, _crest);
      const bedDepth = this.ocean.depthAt(_crest.x, _crest.z);
      tsunami.crestPoint(cross, _crest, bedDepth);
      const crestX = _crest.x, lipHeight = _crest.y, crestZ = _crest.z;
      const lipY = base + lipHeight;
      sprayPosition.x = crestX; sprayPosition.y = lipY + 0.08; sprayPosition.z = crestZ;
      spray.radius = 0.6 + lipHeight * 0.045;
      sprayVelocity.y = 3 + lipHeight * 0.22;
      spray.spread = 4 + lipHeight * 0.16;
      spray.sizeEnd = 2 + lipHeight * 0.06;
      fx.spray.emitRate(SPRAY_KEYS[i], sprayRate, dt, spray);

      mistPosition.x = crestX - mistBackX; mistPosition.y = lipY + 0.35; mistPosition.z = crestZ - mistBackZ;
      mist.radius = 0.9 + lipHeight * 0.065;
      mistVelocity.y = 2.5 + lipHeight * 0.1;
      mist.size = 3 + lipHeight * 0.14;
      mist.sizeEnd = 12 + lipHeight * 0.42;
      fx.mist.emitRate(MIST_KEYS[i], mistRate, dt, mist);

      // Foam is laid just ahead of the lip, straight into a slot of the interaction field.
      const o = field.reserveSource();
      if (o >= 0) {
        sources[o] = crestX + foamAheadX; sources[o + 1] = crestZ + foamAheadZ; sources[o + 2] = 6 + lipHeight * 0.25;
        sources[o + 3] = 0; sources[o + 4] = foamImpulse; sources[o + 5] = foamGain; sources[o + 6] = 0;
      }
    }
    // First arrival: one-off "wave-break" cue + camera rumble that builds as it approaches.
    engine.trauma.rumble = Math.max(engine.trauma.rumble, near * amp * 0.9);
    if (!this.broke && distance < H * 2.5) {
      this.broke = true;
      engine.events.emit('waveBreak', { position: [this.focus.x, 0, this.focus.z], intensity: Math.min(1, H / 25) });
      engine.trauma.add(0.45 * Math.min(1, H / 20));
      engine.lens.splashAt(this.focus, H * 2.2, 1);
    }
    if (distance < -400) this.broke = false;
  }

}
