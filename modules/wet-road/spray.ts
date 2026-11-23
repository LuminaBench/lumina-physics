/**
 * Aerodynamic tire spray.
 *
 *   rooster tails     water flung tangentially off the rear tread, curving up and back
 *                     into the low-pressure wake
 *   wake convergence  fine mist entrained by the two shear layers, curling inward and
 *                     meeting on the centreline behind the rear bumper
 *   splash sheets     lateral sheets thrown outward when a tire slams into standing water
 *
 * Everything scales with speed, surface wetness and the puddle depth under each wheel, and
 * feeds ripples / aerated wash back into the road's interaction field.
 */
import * as THREE from 'three/webgpu';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { EmitOptions } from '../../engine/particles';
import type { AquaplaningVehicle } from './vehicle';
import type { WetRoad } from './road';
import { WheelSpraySheets } from './wheel-sheets';
import { retainedTreadFilm, type TreadContact } from './tread-transfer';
import type { PuddleContact } from './puddle-contacts';

const _p = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _bumper = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _outward = new THREE.Vector3();
const _interface = new THREE.Vector3();
const _innerJet = new THREE.Vector3();
const _outerJet = new THREE.Vector3();
const _wind = new THREE.Vector3();

export class TireSpray implements EngineModule {
  /** Global multiplier (0 disables). */
  amount = 1;
  private readonly slowWheelContacts: PuddleContact[];
  readonly prints?: TreadContact[];
  readonly sheets: WheelSpraySheets;
  /** Liquid carried by the grooves on each wheel, as an equivalent film depth in metres. */
  readonly treadFilm = new Float64Array(4);
  private previousDepth = new Float64Array(4);
  private readonly carry = new Float64Array(10);
  private readonly plume = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 0,
    spread: 0,
    speedJitter: 0.35,
    mistMaterial: 'aerosol',
    life: 1,
    lifeJitter: 0.4,
    size: 0.04,
    sizeEnd: 0.18,
    count: 0,
  } satisfies EmitOptions;
  private readonly surface = { x: 0, z: 0, radius: 0, impulse: 0, push: 0, foam: 0 };
  private wasHydroplaning = false;
  private readonly aerosol = new Float64Array(2);
  private readonly pickup = new Float64Array(2);
  private readonly trailingPatch = [new THREE.Vector3(), new THREE.Vector3()];
  private contactMask = 0;

  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit,
    private vehicle: AquaplaningVehicle,
    private road: WetRoad
  ) {
    this.sheets = new WheelSpraySheets(vehicle.wheels.length, (x, z, strength) => {
      if (road.puddleDepth(x, z) < 0.001) return;
      if (road.streetFluid?.returnSpray(x, z, strength)) return;
      const source = this.surface;
      source.x = x; source.z = z; source.radius = 0.13 + 0.14 * strength;
      source.push = 0; source.impulse = -0.003 * strength; source.foam = 0.42 * strength;
      road.field.addSource(source);
    });
    engine.scene.add(this.sheets.mesh);
    if (road.tread) this.prints = vehicle.wheels.map((_, i) => road.tread!.contact(i < 2 ? 0.23 : 0.27));
    this.slowWheelContacts = vehicle.wheels.map(() => road.contacts.contact('wheel', 0.19));
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const { vehicle, road, fx } = this;
    const { events } = this.engine;
    vehicle.chassis.linvel(_vel);
    const plume = this.plume,
      surface = this.surface;
    const speed = Math.hypot(_vel.x, _vel.z);
    const fwd = vehicle.forward;
    _right.set(fwd.z, 0, -fwd.x);
    const speedN = THREE.MathUtils.smoothstep(speed, 5, 38);
    const spray = fx.spray,
      mist = fx.mist;
    vehicle.rearBumper(_bumper);
    this.pickup.fill(0);
    let trailingMask = 0;
    const reverse = vehicle.speed < 0;
    const travelSign = reverse ? -1 : 1;

    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      // Supply the small ripples visible in a slow crossing before a spray plume forms.
      this.slowWheelContacts[i].sample(w.position, w.velocity, dt, w.contact && w.depth > 0.0004 && speed < 8);
      const rim = w.angularSpeed * vehicle.rig.wheelRadius;
      const rimSpeed = Math.abs(rim);
      const wetness = w.contact ? road.liquidWetnessAt(w.position.x, w.position.z) : 0;
      const grooves = Math.max(0.0002, vehicle.tuning.treadDepth);
      this.treadFilm[i] = retainedTreadFilm(this.treadFilm[i], w.depth, wetness, grooves, vehicle.rig.wheelRadius, rimSpeed, dt);
      if (this.prints) {
        const { x, z } = w.position;
        this.prints[i].sample(x, z, this.treadFilm[i], w.depth, road.rainFilmAt(x, z),
          road.transfer?.soil?.amountAt(x, z) ?? 0, w.contact ? w.loadRatio * (1 - w.hydro) : 0,
          Math.max(0.45, speed * dt * 2.5));
      }
      if (!w.contact || Math.max(speed, rimSpeed) < 1 || this.amount <= 0) {
        this.previousDepth[i] = 0;
        this.contactMask &= ~(1 << i);
        continue;
      }
      const standing = THREE.MathUtils.smoothstep(w.depth, 0.0005, 0.02);
      const water = (wetness * 0.12 + standing * 0.96) * this.amount;
      const carried = this.treadFilm[i] / grooves;
      const throwSpeed = THREE.MathUtils.smoothstep(rimSpeed, 2, 31);
      const load = Math.sqrt(Math.min(1.8, w.loadRatio));
      const patchSpeed = Math.hypot(w.rollingSpeed, w.lateralSpeed);
      const sweep = THREE.MathUtils.smoothstep(patchSpeed, 1.5, 34);
      _tangent.copy(w.rollingDirection).multiplyScalar(w.rollingSpeed < 0 ? -1 : 1);
      const side = Math.sign((w.position.x - _bumper.x) * _right.x + (w.position.z - _bumper.z) * _right.z);
      const rear = reverse ? i < 2 : i >= 2;
      const sideIndex = side < 0 ? 0 : 1;
      _outward.crossVectors(w.normal, w.rollingDirection).multiplyScalar(side);
      _interface.copy(w.position);
      _interface.y = road.heightAt(w.position.x, w.position.z) + w.depth;
      this.pickup[sideIndex] += (water * sweep + carried * throwSpeed * 0.14 * this.amount) * load * (rear ? 0.65 : 0.35);
      if (rear || !(trailingMask & (1 << sideIndex))) this.trailingPatch[sideIndex].copy(_interface);
      if (rear) trailingMask |= 1 << sideIndex;

      // The tread lifts a thin fan of droplets just behind the contact patch.
      const tail = (water + carried * 0.23 * this.amount) * throwSpeed * load * (rear ? 1 : 0.52);
      surface.x = w.position.x;
      surface.z = w.position.z;
      if (tail > 0.01) {
        const rotationSign = rim < 0 ? -1 : 1;
        plume.position.copy(_interface).addScaledVector(w.rollingDirection, -0.16 * rotationSign).y += 0.07;
        plume.velocity
          .copy(w.velocity).multiplyScalar(0.52)
          .addScaledVector(w.rollingDirection, -rim * (0.26 + 0.15 * standing))
          .addScaledVector(_outward, 0.35 + patchSpeed * 0.047 + Math.abs(w.lateralSpeed) * 0.24)
          .addScaledVector(w.normal, 0.55 + Math.min(60, rimSpeed) * (rear ? 0.115 : 0.075) * load);
        plume.radius = 0.07;
        plume.spread = 0.45 + speed * 0.019;
        plume.life = 0.72;
        plume.size = 0.024;
        plume.sizeEnd = 0.045 + standing * 0.043;
        spray.emitRateAt(this.carry, i, (spray.capacity / 0.9) * 0.21 * tail, dt, plume);
      }
      if (w.depth > 0.006 && speed > 7) {
        const sheet = THREE.MathUtils.smoothstep(w.depth, 0.006, 0.03) * sweep * load * this.amount;
        plume.position.copy(_interface).addScaledVector(_outward, 0.105).y += 0.012;
        // The squeezed patch throws lateral water even when the tread locks. The
        // climbing inner lip and flatter outer edge land at different distances.
        const jetSpeed = Math.min(38, patchSpeed);
        _innerJet.copy(w.velocity).multiplyScalar(0.32).addScaledVector(_tangent, -0.19 * jetSpeed)
          .addScaledVector(_outward, 0.55 + jetSpeed * 0.07)
          .addScaledVector(w.normal, Math.min(4.9, 0.65 + jetSpeed * 0.105 * load));
        _outerJet.copy(w.velocity).multiplyScalar(0.41).addScaledVector(_outward, 1.0 + jetSpeed * 0.18)
          .addScaledVector(w.normal, 0.34 + jetSpeed * 0.046);
        this.sheets.submit(i, plume.position, _innerJet, _outerJet, Math.min(1, sheet * 1.8));
        plume.velocity
          .copy(w.velocity).multiplyScalar(0.39)
          .addScaledVector(_outward, 2.0 + patchSpeed * 0.16 + Math.abs(w.lateralSpeed) * 0.3)
          .addScaledVector(w.normal, 0.6 + patchSpeed * 0.065);
        plume.radius = 0.1;
        plume.spread = 0.9;
        plume.life = 0.58;
        plume.size = 0.027;
        plume.sizeEnd = 0.15;
        spray.emitRateAt(this.carry, 4 + i, (spray.capacity / 0.9) * 0.15 * sheet, dt, plume);
      }
      if (this.amount > 0 && w.depth > 0.009 && this.previousDepth[i] < 0.004 && (this.contactMask & (1 << i)) !== 0 && speed > 6) {
        plume.position.copy(_interface).y += 0.035;
        plume.velocity
          .copy(_vel)
          .multiplyScalar(0.33)
          .addScaledVector(_right, side * 5);
        plume.velocity.y = 2.3 + speed * 0.09;
        plume.spread = 2 + speed * 0.06;
        plume.radius = 0.18;
        plume.life = 0.78;
        plume.size = 0.035;
        plume.sizeEnd = 0.22;
        plume.count = Math.floor(spray.burstBudget * 0.07 * (0.5 + speedN) * this.amount);
        spray.emit(plume);
        surface.radius = 0.55;
        surface.push = 0;
        surface.impulse = -0.02;
        surface.foam = 6;
        road.field.addSource(surface);
        events.emitAt('splash', w.position, speedN);
      }
      this.previousDepth[i] = w.depth;
      this.contactMask |= 1 << i;
      if (w.depth > 0.001) {
        surface.radius = 0.34;
        surface.push = -14 * speedN;
        surface.impulse = 0;
        surface.foam = 3.5 * speedN;
        road.field.addSource(surface);
      }
    }

    this.sheets.update(dt);

    // Aerosol builds separately on each side as suspended droplets entrain air.
    // Its release time leaves a short, fading wake after the wheel clears a puddle.
    this.engine.wind.sample(_bumper, this.engine.time, _wind);
    let wake = 0;
    for (let i = 0; i < 2; i++) {
      const target = this.pickup[i];
      const previous = this.aerosol[i];
      const response = 1 - Math.exp(-dt * (target > previous ? 5.5 : 3.6));
      const strength = this.aerosol[i] = previous + (target - previous) * response;
      wake += strength * 0.5;
      if (strength <= 0.008 || this.amount <= 0) continue;
      const side = i === 0 ? -1 : 1;
      plume.position.copy(this.trailingPatch[i]).addScaledVector(fwd, -travelSign * (0.25 + speed * 0.014));
      plume.position.y += 0.2;
      plume.velocity.copy(_vel).multiplyScalar(0.43).addScaledVector(_wind, 0.38)
        .addScaledVector(_right, -side * (0.35 + speed * 0.03));
      plume.velocity.y += 0.42 + speed * 0.023;
      plume.radius = 0.19;
      plume.spread = 0.52;
      plume.life = 1.28;
      plume.size = 0.14;
      plume.sizeEnd = 0.4 + Math.min(strength, 1) * 0.92;
      mist.emitRateAt(this.carry, 8 + i, mist.capacity * 0.092 * strength, dt, plume);
    }
    if (wake > 0.05 && this.amount > 0) {
      const sideBias = (this.aerosol[1] - this.aerosol[0]) / (2 * wake);
      _p.copy(this.trailingPatch[0]).lerp(this.trailingPatch[1], 0.5 + 0.5 * sideBias)
        .addScaledVector(fwd, -travelSign * 4);
      this.engine.lens.splashAt(_p, 3.2, Math.min(1, wake * 1.4));
    }
    const hydro = vehicle.hydroplaning > 0.4;
    if (hydro && !this.wasHydroplaning)
      events.emit('aquaplane', { intensity: vehicle.hydroplaning, params: { speed } });
    this.wasHydroplaning = hydro;
  }

  dispose(): void { this.sheets.dispose(); }
}
