import * as THREE from 'three/webgpu';
import { TSL } from '../engine/tsl';
import { ImmersionFilm, PAINT_FILM } from '../modules/coast/immersion';
import { createSportsCoupe } from '../test-rigs/sports-coupe';
import { createJetRig } from '../test-rigs/jets';
import { AquaplaningVehicle } from '../modules/wet-road/vehicle';
import { TireSpray } from '../modules/wet-road/spray';
import { JetAero } from '../modules/aero/aero';
import type { CoastalWorld } from '../modules/coast/world';
import type { Promenade } from '../examples/coast/promenade';

export class CoastVehicles {
  car?: AquaplaningVehicle;
  jet?: ReturnType<typeof createJetRig>;
  spray?: TireSpray;
  private passing?: ReturnType<typeof createSportsCoupe>;
  private readonly wetDoor = [
    new ImmersionFilm({ ...PAINT_FILM, bottom: 0.22, top: 0.76 }),
    new ImmersionFilm({ ...PAINT_FILM, bottom: 0.22, top: 0.76 }),
  ];
  private readonly dirt = TSL.uniform(new THREE.Vector2());
  private readonly opposing = new THREE.Vector3(0, 0, -1);
  private readonly tailLeft = new THREE.Vector3();
  private readonly tailRight = new THREE.Vector3();
  private driveTime = 0;
  private readonly dripCarry = new Float32Array(2);
  private readonly drip = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 0.038,
    life: 0.38,
    size: 0.011,
    sizeEnd: 0.005,
    spread: 0.1,
    count: 1,
  };
  private coupe?: ReturnType<typeof createSportsCoupe>;
  private aero?: JetAero;
  private readonly chase = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly flight = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    throttle: 0.81,
    gLoad: 1,
    relativeHumidity: 0.78,
  };
  private readonly orientation = new THREE.Object3D();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private flightHeading = -0.68;
  private climb = 0.17;
  private bank = 0;
  private lastPrints = Array.from({ length: 4 }, () => new THREE.Vector3(Infinity, Infinity, Infinity));
  constructor(
    private world: CoastalWorld,
    private road: Promenade,
  ) {}
  private get laneX() {
    // Align the coupe’s left tires with the surveyed depression on the boulevard.
    return this.road.road.x - (this.road.drainage ? 1.97 : 0.38);
  }
  reset(mode: string) {
    const w = this.world,
      road = this.road;
    if (mode === 'drive') {
      if (!this.car) {
        const rig = (this.coupe = createSportsCoupe('#e6e7de'));
        const body = rig.shell.material as THREE.MeshPhysicalNodeMaterial[],
          paint = body[0],
          pos = TSL.positionGeometry;
        const side = TSL.smoothstep(-0.06, 0.06, pos.x);
        const film = TSL.mix(this.wetDoor[0].node(pos.y), this.wetDoor[1].node(pos.y), side);
        const arch = TSL.smoothstep(0.88, 0.15, pos.z.abs().sub(1.35).abs()).mul(
          TSL.smoothstep(0.78, 0.28, pos.y),
        );
        paint.colorNode = TSL.mix(
          paint.colorNode ?? TSL.color(paint.color),
          TSL.color('#675442'),
          arch.mul(TSL.mix(this.dirt.x, this.dirt.y, side)).mul(0.57),
        );
        paint.roughnessNode = TSL.mix(
          paint.roughnessNode ?? TSL.float(paint.roughness),
          0.12,
          film.x.mul(0.72),
        );
        const surf = road.surface;
        this.car = w.engine.add(
          new AquaplaningVehicle(
            w.engine,
            rig,
            {
              get wetness() {
                return 0.26;
              },
              wetnessAt: surf.liquidWetnessAt,
              grip: (x, z) => (road.onRoad(x, z) ? 0.98 : 0.63),
              puddleDepth: surf.puddleDepth,
            },
            {
              ground: false,
              groundY: -28,
              start: this.target.set(
                road.road.x,
                road.heightAt(road.road.x, road.road.z - 27) + 0.69,
                road.road.z - 27,
              ),
            },
          ),
        );
        this.car.autopilot = false;
        this.spray = w.engine.add(new TireSpray(w.engine, w.fx, this.car, surf));
      }
      if (!this.passing) {
        this.passing = createSportsCoupe('#535f68');
        this.passing.object.rotation.y = 0;
        w.engine.scene.add(this.passing.object);
        this.passing.object.traverse((o) => o.layers.enable(12));
        this.car.root.traverse((o) => o.layers.enable(12));
      }
      this.passing.object.visible = true;
      this.driveTime = 0;
      const car = this.car,
        x = this.laneX,
        z = road.road.z - 29;
      this.spray?.grit?.forEach((wheel) => wheel.lift());
      car.setEnabled(true);
      car.chassis.setTranslation(this.target.set(x, road.heightAt(x, z) + 0.64, z), true);
      car.chassis.setRotation(this.orientation.quaternion.identity(), true);
      car.chassis.setLinvel(this.dir.set(0, 0, 11), true);
      car.chassis.setAngvel(this.dir.set(0, 0, 0), true);
      w.engine.physics!.snap(car.chassis);
      car.root.visible = true;
      this.lastPrints.forEach((p) => p.set(Infinity, Infinity, Infinity));
    } else if (this.car) {
      this.car.setEnabled(false);
      this.car.input.throttle = 0;
      this.car.input.brake = 1;
      this.car.root.visible = false;
      if (this.passing) this.passing.object.visible = false;
      w.beams.set(0, this.target, this.dir, 0);
      w.beams.set(1, this.target, this.dir, 0);
      w.beams.setRear(this.tailLeft,this.tailRight,this.opposing,0);
    }
    if (mode === 'fly') {
      if (!this.jet) {
        this.jet = createJetRig('f22');
        w.engine.scene.add(this.jet.object);
        this.aero = w.engine.add(new JetAero(w.engine, w.fx, this.jet, w.ocean));
      }
      this.jet.object.visible = true;
      this.flightHeading = -0.68;
      this.climb = 0.17;
      this.bank = 0;
      this.flight.position.set(265, Math.max(58, w.weather.params.cloudBase * 0.18), -830);
    } else if (this.jet) {
      this.jet.object.visible = false;
      this.aero?.clearState();
    }
  }
  drive(dt: number, keys: Set<string>, replay: boolean) {
    const w = this.world,
      car = this.car!,
      p = car.root.position,
      road = this.road;
    const steering =
      Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    if (!car.autopilot) {
      car.input.throttle = replay
        ? car.speed < 14
          ? 0.58
          : 0.07
        : Number(keys.has('KeyW') || keys.has('ArrowUp'));
      car.input.brake = replay ? 0 : Number(keys.has('KeyS') || keys.has('ArrowDown'));
      car.input.steer = replay
        ? THREE.MathUtils.clamp((this.laneX - p.x) * 0.15 - car.forward.x * 0.94, -0.35, 0.35)
        : steering * 0.85;
    }
    const night = 1 - THREE.MathUtils.smoothstep(w.weather.params.sunElevation, -1, 9);
    this.coupe!.setHeadlights(night > 0.02, 0.28 * night);
    this.driveTime += dt;
    const other = this.passing!,
      otherZ = road.road.z + 59 - ((this.driveTime * 11) % 163),
      otherX = road.road.x + 2.18;
    other.object.position.set(otherX, road.heightAt(otherX, otherZ) + 0.015, otherZ);
    other.setHeadlights(night > 0.02, 0.25 * night);
    w.beams.set(0, p, car.forward, 5 * night);
    w.beams.set(1, other.object.position, this.opposing, 5 * night);
    this.coupe!.rearLampCenters(this.tailLeft,this.tailRight);
    w.beams.setRear(this.tailLeft,this.tailRight,car.forward,0.09*night+1.85*this.coupe!.brakeGlow);
    for (let side = 0; side < 2; side++) {
      const depth = Math.max(car.wheels[side].depth, car.wheels[side + 2].depth);
      this.wetDoor[side].update(
        dt,
        Math.max(0, depth - 0.2) + Math.min(0.4, depth * Math.abs(car.speed) * 0.64),
      );
      this.dripCarry[side] += dt * this.wetDoor[side].shedding * 280;
      if (this.dripCarry[side] >= 1) {
        this.dripCarry[side] %= 1;
        this.drip.position
          .set(side === 0 ? -0.88 : 0.88, 0.16, -0.73)
          .applyQuaternion(car.root.quaternion)
          .add(p);
        this.drip.velocity.copy(car.forward).multiplyScalar(car.speed * 0.84);
        this.drip.velocity.y = -0.38;
        w.fx.spray.emit(this.drip);
      }
      const pickup = this.spray?.prints?.[side].soil ?? 0,
        old = this.dirt.value.getComponent(side);
      this.dirt.value.setComponent(side, Math.max(old * Math.exp(-dt * (0.002 + depth * 0.36)), pickup));
    }
    if (replay && !car.autopilot && p.z > road.road.z + 105) this.reset('drive');
    for (let i = 0; i < car.wheels.length; i++) {
      const wheel = car.wheels[i],
        prev = this.lastPrints[i];
      if (!wheel.contact || road.onRoad(wheel.position.x, wheel.position.z)) {
        prev.set(Infinity, Infinity, Infinity);
        continue;
      }
      if (prev.distanceToSquared(wheel.position) > 0.19 ** 2) {
        w.sediment.imprint(
          'wheel',
          wheel.position.x,
          wheel.position.z,
          Math.atan2(wheel.rollingDirection.x, wheel.rollingDirection.z),
          0.24,
          0.35,
          wheel.loadRatio,
          wheel.lateralSpeed * 0.16,
        );
        prev.copy(wheel.position);
      }
    }
    w.setFocus(p);
  }
  inspectWheel(index: number) {
    const wheel = this.car?.wheels[index],
      spray = this.spray;
    if (!wheel || !spray) return undefined;
    const speed = Math.hypot(wheel.rollingSpeed, wheel.lateralSpeed);
    return {
      contact: wheel.contact,
      load: wheel.loadRatio,
      waterMm: 1000 * wheel.depth,
      carryMm: 1000 * spray.treadFilm[index],
      soil: spray.prints?.[index].soil ?? 0,
      fineGrams: spray.grit?.[index].fine ?? 0,
      coarseGrams: spray.grit?.[index].coarse ?? 0,
      speed,
      source: !wheel.contact
        ? 'airborne'
        : speed < 0.15
          ? 'stationary'
          : wheel.depth > 0.001
            ? 'standing water'
            : spray.treadFilm[index] > 0.0002
              ? 'retained tread film'
              : 'surface film',
    };
  }
  placeDriveCamera() {
    const w = this.world,
      car = this.car!,
      p = car.root.position;
    this.chase.copy(p).addScaledVector(car.forward, -7.2);
    this.chase.y += 2.05;
    w.engine.camera.position.copy(this.chase);
    w.engine.camera.lookAt(
      this.target.copy(p).addScaledVector(car.forward, 3.9).addScaledVector(this.up, 0.55),
    );
  }
  fly(dt: number, t: number, keys: Set<string>, replay: boolean) {
    const w = this.world,
      f = this.flight,
      cam = w.engine.camera,
      rig = this.jet!;
    if (!replay) {
      const yaw =
        Number(keys.has('KeyD') || keys.has('ArrowRight')) -
        Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      const elevator =
        Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
      this.flightHeading += dt * yaw * 0.62;
      this.climb = THREE.MathUtils.clamp(this.climb + dt * elevator * 0.4, -0.5, 0.75);
      this.bank = THREE.MathUtils.lerp(this.bank, -yaw * 0.74, 1 - Math.exp(-dt * 3));
    } else {
      this.climb = 0.2 + 0.09 * Math.sin(t * 0.16);
      this.bank = Math.sin(t * 0.27) * 0.085;
    }
    const speed = keys.has('ShiftLeft') ? 273 : 164,
      level = Math.cos(this.climb);
    this.dir.set(
      Math.sin(this.flightHeading) * level,
      Math.sin(this.climb),
      Math.cos(this.flightHeading) * level,
    );
    f.velocity.copy(this.dir).multiplyScalar(speed);
    f.position.addScaledVector(f.velocity, dt);
    f.position.y = Math.max(24, f.position.y);
    this.orientation.position.copy(f.position);
    this.orientation.lookAt(this.target.copy(f.position).sub(this.dir));
    this.orientation.rotateZ(this.bank);
    f.quaternion.copy(this.orientation.quaternion);
    f.throttle = keys.has('ShiftLeft') ? 0.97 : 0.82;
    f.relativeHumidity = 0.52 + 0.43 * w.front.sample(f.position.x, f.position.z, w.engine.time).coverage;
    this.aero!.setState(f);
    rig.animate(dt, {
      throttle: f.throttle,
      afterburner: Math.max(0, (f.throttle - 0.85) / 0.15),
      roll: this.bank,
    });
    cam.position.copy(f.position).addScaledVector(this.dir, -22).addScaledVector(this.up, 6.1);
    cam.lookAt(this.target.copy(f.position).addScaledVector(this.dir, 6));
    w.setFocus(f.position);
  }
  dispose() {
    if (this.passing) {
      this.passing.object.removeFromParent();
      this.passing.object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        }
      });
    }
    this.jet?.dispose?.();
    this.jet?.object.removeFromParent();
  }
}
