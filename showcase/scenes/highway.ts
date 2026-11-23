/** Scene 3 – Storm highway & aquaplaning. */
import { yieldToBrowser } from '../../engine/loading';
import { FloodedStreet } from '../../modules/wet-road/street-fluid';
import { VehicleDamage } from '../../modules/destruction/vehicle-damage';
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { CLIMATES } from '../../engine/climate';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { Rain } from '../../modules/weather/rain';
import { Lightning } from '../../modules/weather/lightning';
import { WetRoad } from '../../modules/wet-road/road';
import { AquaplaningVehicle, hydroplaningSpeed } from '../../modules/wet-road/vehicle';
import { TireSpray } from '../../modules/wet-road/spray';
import { createSportsCoupe } from '../../test-rigs';
import { ChassisAnimator } from '../../modules/animation';
import { CameraFeel } from '../../engine/camera-feel';
import { FollowOrbit } from '../camera';
import { OVERPASS_Z, buildHighwayOverpass } from '../scenery/highway';
import { SceneryRegistry, buildHighwayEnvironment } from '../scenery';
import type { SceneContext, SceneHandle, ShowcaseScene } from './types';

type CameraMode = 'chase' | 'side' | 'orbit' | 'detail' | 'curb';

export const highwayScene: ShowcaseScene = {
  id: 'highway', label: 'Storm Highway', title: 'Storm highway & aquaplaning', description: '',
  async create(ctx: SceneContext): Promise<SceneHandle> {
    const { engine, panel, canvas } = ctx;
    const { camera } = engine;
    camera.near = 0.2; camera.far = 30000; camera.fov = 52; camera.updateProjectionMatrix();

    const bridgeLayer = 7;
    const weather = engine.add(new Weather(engine,{ localProbe:{center:new THREE.Vector3(-1,1.8,OVERPASS_Z),
      halfSize:new THREE.Vector3(15,3.4,6.5), layer:bridgeLayer, resolution:64, refreshSeconds:0.9} }));
    const bridgeProbe = weather.localProbe!;
    bridgeProbe.enabled = false;
    Object.assign(weather.params, WEATHER_PRESETS.storm, { sunElevation: 16, exposure: 1.15 });
    weather.groundColor.setRGB(0.02, 0.022, 0.02);
    weather.shadowExtent = 30;
    // Gusty crosswind (blowing toward +X across the carriageway).
    engine.wind.set(0.35, 15, 0.6);
    const fx = engine.add(new EffectsKit(engine));
    // Spaced deposits of soil dragged onto the edge of one lane. Use the same world-space patch at the contact and pixel.
    const shoulder = TSL.uniform(0);
    const road = engine.add(new WetRoad(engine, weather, { soil: {
      amountAt(x, z) {
        const dx = (x + 2.78 + 0.16 * Math.sin(z * 1.3)) / 0.76;
        const cycle = (z - 69) / 32, dz = (cycle - Math.floor(cycle + 0.5)) * (32 / 3.8);
        return shoulder.value * (1 - THREE.MathUtils.smoothstep(dx * dx + dz * dz, 0.52, 1));
      },
      amountNode(xz) {
        const dx = xz.x.add(2.78).add(TSL.sin(xz.y.mul(1.3)).mul(0.16)).div(0.76);
        const cycle = xz.y.sub(69).div(32);
        const dz = cycle.sub(TSL.floor(cycle.add(0.5))).mul(32 / 3.8);
        return shoulder.mul(TSL.smoothstep(0.52, 1, dx.mul(dx).add(dz.mul(dz))).oneMinus());
      },
    } }));
    const scenery = new SceneryRegistry('highway-scenery', engine.world);
    engine.scene.add(scenery.group);
    await yieldToBrowser();
    const highwayEnv = await buildHighwayEnvironment(scenery, weather);
    highwayEnv.update(0);
    const releaseBridge = buildHighwayOverpass(scenery, engine, bridgeLayer);
    await yieldToBrowser();
    const rain = engine.add(new Rain(engine, weather));
    const lightning = engine.add(new Lightning(engine, weather));
    lightning.range = [260, 1500];
    lightning.rate = 11;

    const rig = createSportsCoupe();
    rig.setHeadlights(true);
    const vehicle = engine.add(new AquaplaningVehicle(engine, rig, road));
    vehicle.targetSpeed = 118 / 3.6;
    const fluid = engine.add(new FloodedStreet(engine,fx,weather,road,vehicle));
    const damage = engine.add(new VehicleDamage(engine,fx,vehicle.chassis,rig.shell));
    for (const piece of rig.crumpleAttachments) damage.attachTrim(piece);
    const impactPoint=new THREE.Vector3();
    let burnoutTime=0;
    const spray = engine.add(new TireSpray(engine, fx, vehicle, road));
    // Body motion on the springs, squeegeed tire tracks, and an operator-style chase camera.
    const chassis = new ChassisAnimator(rig.body);
    const tracks = road.tread!;
    const feel = new CameraFeel(engine, { distance: 8.4, height: 2.5, stiffness: 1.6, lookAhead: 0.16, aimHeight: 0.9, baseFov: 52, fovGain: 13, fovSpeed: 58, bank: 0.5 });
    feel.follow(vehicle.root);
    const carVelocity = new THREE.Vector3();
    let wasBraking = false;

    const state = { mode: 'chase' as CameraMode };
    const carPos = new THREE.Vector3();
    const orbit = new FollowOrbit(camera, canvas, new THREE.Vector3(-1.9, 0.8, 0), new THREE.Vector3(7, 2.6, -9));
    orbit.controls.enabled = false;
    orbit.controls.minDistance = 3;
    orbit.controls.maxDistance = 60;
    const look = new THREE.Vector3(), side = new THREE.Vector3();
    const keys = new Set<string>();
    const onKey = (e: KeyboardEvent) => { if (e.type === 'keydown') keys.add(e.code); else keys.delete(e.code); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    engine.onUpdate = (dt) => {
      weather.shadowFocus.copy(vehicle.root.position);
      if (burnoutTime>0) {
        burnoutTime=Math.max(0,burnoutTime-dt);vehicle.burnout=burnoutTime>0?1:0;
      }
      for (let i = 0; i < vehicle.wheels.length; i++) {
        const w = vehicle.wheels[i];
        const slip = Math.hypot(w.angularSpeed * rig.wheelRadius - w.rollingSpeed, w.lateralSpeed);
        const water = Math.max(road.liquidWetnessAt(w.position.x, w.position.z), THREE.MathUtils.smoothstep(w.depth, 0.0004, 0.004));
        damage.tireContact(i, w.position, w.contact ? w.load * (1 - w.hydro) : 0, slip, w.contact ? water : 0, dt, w.velocity);
      }
      highwayEnv.update(vehicle.root.position.z);
      bridgeProbe.enabled = Math.abs(camera.position.z - OVERPASS_Z) < 55;
      road.params.rain = weather.params.rain;
      if (!vehicle.autopilot) {
        const steer = (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0) - (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
        vehicle.input.steer += (steer - vehicle.input.steer) * Math.min(1, dt * 6);
        vehicle.input.throttle = keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0;
        vehicle.input.brake = keys.has('ArrowDown') || keys.has('KeyS') || keys.has('Space') ? 1 : 0;
      }
      engine.trauma.rumble = THREE.MathUtils.smoothstep(Math.abs(vehicle.speed), 15, 55) * 0.45 + vehicle.hydroplaning * 0.4;
      chassis.update(dt, vehicle.acceleration);
      const braking = vehicle.brakeLight;
      road.brake = braking;
      if (braking > 0.5 && !wasBraking && Math.abs(vehicle.speed) > 20) feel.impact(0.12);
      wasBraking = braking > 0.5;
    };
    // Camera after physics, from the chassis' render-interpolated pose.
    const fwd = new THREE.Vector3();
    engine.onBeforeRender = (dt) => {
      carPos.copy(vehicle.root.position);
      fwd.set(0, 0, 1).applyQuaternion(vehicle.root.quaternion).setY(0).normalize();
      side.set(fwd.z, 0, -fwd.x);
      if (state.mode === 'chase') {
        // Spring-damper chase: the car surges ahead under power, swings wide in a slide,
        // the lens opens with speed and the horizon leans into the lateral load.
        vehicle.chassis.linvel(carVelocity);
        feel.update(dt,carVelocity,vehicle.acceleration.y);
      } else if (state.mode === 'detail') {
        camera.position.copy(carPos).addScaledVector(side,2.8).addScaledVector(fwd,3.8);
        camera.position.y+=1.55;
        look.copy(carPos).addScaledVector(fwd,0.48);look.y+=0.3;camera.lookAt(look);
      } else if (state.mode === 'curb') {
        camera.position.copy(carPos).addScaledVector(side, -4.8).addScaledVector(fwd, -4.3);
        camera.position.y = carPos.y + 0.38;
        camera.lookAt(look.copy(carPos).addScaledVector(fwd, -0.45).setY(carPos.y + 0.06));
      } else if (state.mode === 'side') {
        camera.position.copy(carPos).addScaledVector(side, 5.9).addScaledVector(fwd, 4.7);
        camera.position.y=carPos.y+(fluid.flooded?1.4:0.83);
        camera.lookAt(look.copy(carPos).addScaledVector(fwd, -0.18).setY(carPos.y+0.22));
      } else {
        orbit.follow(carPos, 1);
        orbit.update(dt);
      }
      if (state.mode !== 'chase') { camera.fov = state.mode==='detail'?43:51 + Math.min(7, Math.abs(vehicle.speed) * 0.14) + engine.trauma.fovOffset; camera.updateProjectionMatrix(); }
    };

    const setMode = (mode: CameraMode) => { state.mode = mode; orbit.controls.enabled = mode === 'orbit'; if (mode === 'chase') feel.follow(vehicle.root); };

    panel.header('Storm highway & aquaplaning', 'Rapier raycast suspension samples puddle depth under each tire. Above the hydroplaning speed in deep water the contact patch lifts: the car floats, yaws, then recovers as the driver lifts.');
    panel.section('Car');
    panel.slider('Target speed', 30, 220, 1, () => vehicle.targetSpeed * 3.6, (v) => { vehicle.targetSpeed = v / 3.6; }, (v) => `${v.toFixed(0)} km/h`);
    panel.slider('Tire pressure', 120, 320, 5, () => vehicle.tuning.tirePressure, (v) => { vehicle.tuning.tirePressure = v; }, (v) => `${v.toFixed(0)} kPa`);
    panel.buttons([
      { label: 'Autopilot', isOn: () => vehicle.autopilot, onClick: () => { vehicle.autopilot = !vehicle.autopilot; } },
      { label: 'Reset car', onClick: () => vehicle.reset() },
    ]);
    panel.note('Autopilot off: W/S or ↑/↓ throttle & brake, A/D or ←/→ steer.');
    panel.section('Road + weather');
    panel.buttons([
      { label: 'Cold front', isOn: () => engine.world.climate?.baseTemperatureC === CLIMATES.coldFront.baseTemperatureC, onClick: () => engine.world.setClimate(CLIMATES.coldFront) },
      { label: 'Warm coast', isOn: () => engine.world.climate?.baseTemperatureC === CLIMATES.humidCoast.baseTemperatureC, onClick: () => engine.world.setClimate(CLIMATES.humidCoast) },
    ]);
    panel.slider('Standing water', 0, 1, 0.01, () => road.params.flood, (v) => { road.params.flood = v; });
    panel.slider('Wetness', 0, 1, 0.01, () => road.params.wetness, (v) => { road.params.wetness = v; });
    panel.slider('Rain', 0, 1, 0.01, () => weather.params.rain, (v) => { weather.params.rain = v; });
    panel.slider('Tire spray', 0, 2, 0.01, () => spray.amount, (v) => { spray.amount = v; });
    panel.buttons([{ label: '⚡ Strike', primary: true, onClick: () => lightning.strike(new THREE.Vector3(vehicle.root.position.x + (Math.random() - 0.5) * 300, 0, vehicle.root.position.z + 320 + Math.random() * 400)) }]);
    panel.section('Street physics');
    const burnout=()=>{
      weather.params.rain=road.params.rain=road.params.wetness=road.params.flood=0;
      engine.world.surfaceWetness=0; fluid.setFlood(false);
      vehicle.reset();vehicle.chassis.setLinvel({x:0,y:0,z:0},true);burnoutTime=4;vehicle.burnout=1;
    };
    const dent=()=>{setMode('detail');rig.shell.updateWorldMatrix(true,false);damage.impact(rig.shell.localToWorld(impactPoint.set(-0.77,0.53,-1.64)),0.83);};
    const scrapeNormal = new THREE.Vector3(), slideVelocity = new THREE.Vector3();
    const sideswipe = () => {
      setMode('detail');
      rig.shell.updateWorldMatrix(true, false);
      scrapeNormal.set(-1, 0, 0).transformDirection(rig.shell.matrixWorld);
      slideVelocity.set(0, 0, -1).transformDirection(rig.shell.matrixWorld).multiplyScalar(12);
      damage.impact(rig.shell.localToWorld(impactPoint.set(-0.91, 0.53, -0.63)), 0.74, scrapeNormal, slideVelocity);
    };
    const crack=()=>{setMode('detail');rig.shell.updateWorldMatrix(true,false);damage.impact(rig.shell.localToWorld(impactPoint.set(-0.27,1.02,-0.56)),0.48);};
    const waterPass = (reverse: boolean) => {
      shoulder.value = 0;
      burnoutTime = vehicle.burnout = 0;
      vehicle.laneX = -1.9;
      vehicle.autopilot = !reverse;
      vehicle.reset();
      vehicle.chassis.setTranslation({ x: vehicle.laneX, y: 0.64, z: reverse ? 99 : 57 }, true);
      vehicle.chassis.setLinvel({ x: 0, y: 0, z: reverse ? -12 : 23 }, true);
      vehicle.input.steer = vehicle.input.throttle = vehicle.input.brake = 0;
      engine.physics.snap(vehicle.chassis);
      road.params.flood = 0.17;
      road.params.wetness = 0.27;
      weather.params.rain = 0;
      if (reverse || fluid.flooded) fluid.setFlood(reverse);
      setMode('curb');
    };
    const muddyShoulder = () => {
      waterPass(false);
      shoulder.value = 1;
      tracks.clear();
      spray.prints?.forEach(wheel => wheel.reset());
      spray.treadFilm.fill(0);
      road.params.flood = road.params.wetness = 0;
      vehicle.targetSpeed = 10;
      vehicle.chassis.setLinvel({x: 0, y: 0, z: 10}, true);
      Object.assign(weather.params, {sunElevation: 16, sunAzimuth: 75, coverage: 0.34, storm: 0, rain: 0, exposure: 0.85});
      lightning.rate = 0;
      setMode('chase');
    };
    const underpass = () => {
      burnoutTime = vehicle.burnout = 0;
      vehicle.autopilot = false; vehicle.laneX = -1.9; vehicle.reset();
      vehicle.chassis.setTranslation({x:-1.9,y:0.64,z:OVERPASS_Z-0.5},true);
      vehicle.chassis.setLinvel({x:0,y:0,z:0},true); engine.physics.snap(vehicle.chassis);
      road.params.flood = 0.28; road.params.wetness = 0.93;
      Object.assign(weather.params,{sunElevation:7,sunAzimuth:49,coverage:0.45,storm:0.13,rain:0.46,exposure:0.76});
      engine.wind.set(0.18,3,0.2); lightning.rate=0;
      setMode('curb');
    };
    panel.buttons([{label:'Rain under the overpass',onClick:underpass}, {label:'Cross muddy shoulder',onClick:muddyShoulder}]);
    panel.buttons([{label:'Curbside puddle',onClick:()=>waterPass(false)},{label:'Reverse through flood',onClick:()=>waterPass(true)}]);
    panel.buttons([{label:'Flood the street',isOn:()=>fluid.flooded,onClick:()=>{fluid.setFlood(!fluid.flooded);if(fluid.flooded)setMode('side');}},
      {label:'Leak fuel',isOn:()=>fluid.leaking,onClick:()=>fluid.setLeak(!fluid.leaking)},{label:'Light fuel trail',onClick:()=>fluid.ignite()}]);
    panel.buttons([{label:'Dent front wing',onClick:dent},{label:'Sideswipe',onClick:sideswipe},{label:'Crack windscreen',onClick:crack},
      {label:'Repair bodywork',onClick:()=>damage.repair()},{label:'Dry burnout',onClick:burnout}]);
    panel.section('Camera');
    panel.buttons((['chase', 'side', 'curb', 'detail', 'orbit'] as CameraMode[]).map((mode) => ({ label: mode, isOn: () => state.mode === mode, onClick: () => setMode(mode) })));

    return {
      hud: () => [
        `car   <b>${(Math.abs(vehicle.speed) * 3.6).toFixed(0)} km/h</b>  V_p ${(hydroplaningSpeed(vehicle.tuning.tirePressure) * 3.6).toFixed(0)} km/h`,
        `hydro <b>${(vehicle.hydroplaning * 100).toFixed(0)} %</b>  slip ${(THREE.MathUtils.radToDeg(vehicle.slipAngle)).toFixed(1)}°`,
        `water ${vehicle.wheels.map((w) => (w.depth * 1000).toFixed(0).padStart(2)).join(' ')} mm`,
      ],
      debug: { weather, road, vehicle, spray, lightning, rain, fx, scenery, setMode, orbit, rig, tracks, feel, chassis, fluid, damage },
      dispose() {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        feel.dispose();
        orbit.dispose();
        releaseBridge(); scenery.dispose();
      },
    };
  },
};
