/** Fighter-jet actor: extracted rig + scripted racetrack flight + the aero module. */
import * as THREE from 'three/webgpu';
import type { LuminaEngine } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from '../../modules/water/ocean';
import { JetAero, type AeroState } from '../../modules/aero/aero';
import { RacetrackFlight, DEFAULT_FLIGHT_PLAN, type FlightPlan } from '../../modules/aero/flight';
import { createJetRig, type JetId, type JetRig } from '../../test-rigs';

export class JetActor {
  rig: JetRig;
  aero: JetAero;
  readonly flight: RacetrackFlight;
  throttle = 1;
  engineThrottles?: ArrayLike<number>;
  private readonly aeroState: AeroState;
  private readonly animState = { throttle: 1, afterburner: 0, engineThrottles: undefined as ArrayLike<number> | undefined, roll: 0, pitch: 0 };

  constructor(private engine: LuminaEngine, private fx: EffectsKit, private ocean: Ocean | null, id: JetId = 'f22', plan: Partial<FlightPlan> = {}) {
    this.flight = new RacetrackFlight({ ...DEFAULT_FLIGHT_PLAN, focus: new THREE.Vector3(), ...plan });
    this.rig = createJetRig(id);
    engine.scene.add(this.rig.object);
    this.aero = engine.add(new JetAero(engine, fx, this.rig, ocean));
    const s = this.flight.state;
    this.aeroState = { position: s.position, quaternion: s.quaternion, velocity: s.velocity, gLoad: s.gLoad, throttle: this.throttle };
  }

  /** Swap the airframe (F-15E / F-16C / F-22A / F/A-18E / Su-57) without touching the flight. */
  setAirframe(id: JetId): void {
    const params = { ...this.aero.params };
    this.engine.remove(this.aero);
    this.rig.dispose?.();
    this.rig.object.removeFromParent();
    this.rig = createJetRig(id);
    this.engine.scene.add(this.rig.object);
    this.aero = this.engine.add(new JetAero(this.engine, this.fx, this.rig, this.ocean));
    Object.assign(this.aero.params, params);
  }

  /** Advance the flight and hand the new state to the aero module. Call from `engine.onUpdate`. */
  update(dt: number): void {
    const s = this.flight.update(dt);
    const aeroState = this.aeroState;
    aeroState.position = s.position;
    aeroState.quaternion = s.quaternion;
    aeroState.velocity = s.velocity;
    aeroState.gLoad = s.gLoad;
    aeroState.throttle = this.throttle;
    aeroState.engineThrottles = this.engineThrottles;
    this.aero.setState(aeroState);
    // Stick follows the manoeuvre: roll into the bank, pull with the g-load; nozzles follow power.
    const anim = this.animState;
    anim.throttle = this.throttle;
    anim.engineThrottles = this.engineThrottles;
    const ab = (this.throttle - 0.85) / 0.15;
    anim.afterburner = ab > 0 ? ab : 0;
    anim.roll = s.bank * 0.5;
    const pitch = (s.gLoad - 1) * 0.25;
    anim.pitch = pitch < -1 ? -1 : pitch > 1 ? 1 : pitch;
    this.rig.animate(dt, anim);
  }

  dispose(): void {
    this.engine.remove(this.aero);
    this.rig.dispose?.();
    this.rig.object.removeFromParent();
  }
}
