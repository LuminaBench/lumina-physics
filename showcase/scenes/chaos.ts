/** Scene 5 – Full coupled storm chaos: hurricane ocean, lightning, jet, floatplane, geysers. */
import * as THREE from 'three/webgpu';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { Rain } from '../../modules/weather/rain';
import { Lightning } from '../../modules/weather/lightning';
import { Ocean } from '../../modules/water/ocean';
import { OCEAN_PRESETS } from '../../modules/water/spectrum';
import { TsunamiEffects } from '../../modules/water/tsunami-fx';
import { TSUNAMI_PRESETS } from '../../modules/water/tsunami';
import { Explosions } from '../../modules/fire/explosions';
import { BeaverActor } from '../actors/beaver';
import { JetActor } from '../actors/jet';
import { FollowOrbit } from '../camera';
import {
  SceneryRegistry,
  buildBuoy,
  buildHeadlands,
  buildLighthouse,
  buildRockClusters,
  createRockMaterial,
  createTerrainMaterial,
  type RockPlacement,
} from '../scenery';
import type { SceneContext, SceneHandle, ShowcaseScene } from './types';

export const chaosScene: ShowcaseScene = {
  id: 'chaos', label: 'Storm Chaos', title: 'Full coupled storm chaos', description: '',
  async create(ctx: SceneContext): Promise<SceneHandle> {
    const { engine, panel, canvas } = ctx;
    const { camera } = engine;
    camera.near = 0.4; camera.far = 60000; camera.fov = 52; camera.updateProjectionMatrix();

    const weather = engine.add(new Weather(engine));
    Object.assign(weather.params, WEATHER_PRESETS.hurricane);
    weather.groundColor.setRGB(0.012, 0.03, 0.04);
    const ocean = engine.add(new Ocean(engine, { weather }));
    ocean.setSeaStates(OCEAN_PRESETS.storm, OCEAN_PRESETS.hurricane);
    ocean.morph = 0.35;
    ocean.optics.clarity = 0.55;
    ocean.optics.foam = 0.85;
    const fx = engine.add(new EffectsKit(engine));
    const rain = engine.add(new Rain(engine, weather));
    rain.lensWetting = 0.21;
    const lightning = engine.add(new Lightning(engine, weather));
    lightning.rate = 14;
    lightning.range = [300, 2400];
    const explosions = engine.add(new Explosions(engine, fx, ocean));
    const tsunamiFx = engine.add(new TsunamiEffects(engine, fx, ocean));

    // ---- Brooding 360° storm headland ring, cliff lighthouse & pitching sea buoys ----
    // Kept strictly outside the Beaver's 110 m orbit and low-pass center (~7–8 draw calls total).
    const scenery = new SceneryRegistry('chaos-scenery', engine.world);
    engine.scene.add(scenery.group);
    const stormCoastMat = createTerrainMaterial(scenery, weather, {
      terrainShadows: true,
      palette: 'storm',
      rockiness: 0.65,
      wetness: 0.7,
      mistStart: 220,
      mistRange: 1350,
      mistMax: 0.78,
      mistHeight: 220,
    });
    const stormRockMat = createRockMaterial(scenery, weather, 'storm', { mistStart: 180, mistRange: 1200, mistMax: 0.72 });

    const stormCoasts = buildHeadlands(
      scenery,
      [
        // Rugged cliff promontory carrying the storm lighthouse
        { x: -640, z: -610, radiusX: 280, radiusZ: 210, height: 105, rotation: 0.42, segments: 40, cragginess: 0.82, seed: 1103 },
        // Surrounding distant storm headlands visible as the camera auto-orbits 360°
        { x: 820, z: -780, radiusX: 390, radiusZ: 270, height: 148, rotation: -0.35, segments: 36, cragginess: 0.78, seed: 1117 },
        { x: -940, z: 680, radiusX: 430, radiusZ: 290, height: 162, rotation: 0.25, segments: 36, cragginess: 0.8, seed: 1129 },
        { x: 780, z: 880, radiusX: 380, radiusZ: 260, height: 135, rotation: -0.48, segments: 36, cragginess: 0.75, seed: 1151 },
        // Far brooding mountain horizon
        { x: -1580, z: -1450, radiusX: 860, radiusZ: 520, height: 290, rotation: 0.18, segments: 32, cragginess: 0.78, seed: 1163 },
        { x: 1520, z: -1520, radiusX: 880, radiusZ: 520, height: 275, rotation: -0.22, segments: 32, cragginess: 0.76, seed: 1181 },
      ],
      stormCoastMat,
      { name: 'chaos-storm-headlands', woodland: 'evergreen', castShadow: false, receiveShadow: false },
    );

    const clhX = -515, clhZ = -495;
    buildLighthouse(scenery, weather, {
      x: clhX,
      y: Math.max(24, stormCoasts.heightAt(clhX, clhZ)),
      z: clhZ,
      scale: 1.5,
      beaconIntensity: 70,
    });

    const seaStacks: RockPlacement[] = [
      { x: -410, y: 12, z: -430, scaleX: 28, scaleY: 34, scaleZ: 24, rotY: 0.6, variant: 0 },
      { x: -355, y: 7, z: -395, scaleX: 16, scaleY: 20, scaleZ: 15, rotY: 2.1, variant: 1 },
      { x: 470, y: 14, z: -490, scaleX: 30, scaleY: 36, scaleZ: 26, rotY: 1.4, variant: 2 },
      { x: -530, y: 13, z: 420, scaleX: 26, scaleY: 32, scaleZ: 24, rotY: 0.9, variant: 0 },
      { x: 480, y: 11, z: 540, scaleX: 24, scaleY: 28, scaleZ: 22, rotY: 2.8, variant: 1 },
    ];
    buildRockClusters(scenery, seaStacks, stormRockMat, { name: 'chaos-sea-stacks', castShadow: false, receiveShadow: false, seed: 1193 });

    const stormBuoys = [
      buildBuoy(scenery, { x: 245, z: -225, kind: 'channel', color: 0xb62720, beacon: [46, 12, 4] }),
      buildBuoy(scenery, { x: -265, z: 215, kind: 'channel', color: 0x206842, beacon: [10, 38, 14] }),
    ];

    const beaver = new BeaverActor(engine, fx, ocean, new THREE.Vector3(0, 1.2, 0), 0.6);
    beaver.throttle = 0.4;
    beaver.circleRadius = 110;
    const jet = new JetActor(engine, fx, ocean, 'su57', { passAltitude: 26, machPeak: 1.12, heading: 0.5, straight: 4600 });
    jet.aero.params.humidity = 1;

    const orbit = new FollowOrbit(camera, canvas, beaver.position.clone().add(new THREE.Vector3(0, 2, 0)), new THREE.Vector3(-17, 6.5, 18));
    orbit.floor = (x, z) => ocean.heightAt(x, z) + 0.5;
    orbit.controls.maxDistance = 500;
    orbit.autoRotate = 0.05;
    const state = { geysers: true, timer: 6, jet: true };
    const geyserPos = new THREE.Vector3();
    const geyserOpts = { kind: 'water' as const, position: geyserPos, yield: 1 };

    engine.onUpdate = (dt) => {
      beaver.update(dt);
      // Keep the jet's racetrack centred on the floatplane so passes go right over it.
      jet.flight.plan.focus.set(beaver.position.x, 0, beaver.position.z);
      if (state.jet) jet.update(dt);
      tsunamiFx.focus.copy(beaver.position);
      ocean.updateField(dt, beaver.position);
      weather.shadowFocus.copy(beaver.position);
      for (const buoy of stormBuoys) buoy.followSurface(ocean,camera.position,dt,0.25);
      const rumble = engine.trauma.rumble * 0.9;
      engine.trauma.rumble = rumble > 0.25 ? rumble : 0.25;
      if (state.geysers) {
        state.timer -= dt;
        if (state.timer <= 0) {
          const a = Math.random() * Math.PI * 2, r = 28 + Math.random() * 40;
          geyserPos.set(beaver.position.x + Math.cos(a) * r, 0, beaver.position.z + Math.sin(a) * r);
          geyserOpts.yield = 1 + Math.random() * 0.8;
          explosions.detonate(geyserOpts);
          state.timer = 7 + Math.random() * 5;
        }
      }
    };

    const pivot = new THREE.Vector3();
    engine.onBeforeRender = (dt) => {
      orbit.follow(pivot.copy(beaver.rig.object.position).setY(beaver.rig.object.position.y + 2), 1);
      orbit.update(dt);
    };

    panel.header('Full coupled storm chaos', 'Hurricane sea, rain, branching lightning, a low supersonic pass, a floatplane fighting the swell and depth-charge geysers – every system reading and writing the same wind, water and physics fields.');
    panel.section('Storm');
    panel.slider('Sea state', 0, 1, 0.01, () => ocean.morph, (v) => { ocean.morph = v; });
    panel.slider('Rain', 0, 1, 0.01, () => weather.params.rain, (v) => { weather.params.rain = v; });
    panel.slider('Lightning / min', 0, 40, 1, () => lightning.rate, (v) => { lightning.rate = v; }, (v) => v.toFixed(0));
    panel.buttons([
      { label: '⚡ Strike', primary: true, onClick: () => lightning.strike() },
      { label: 'Geyser', primary: true, onClick: () => { state.timer = 0; state.geysers = true; } },
      { label: 'Rogue wave', primary: true, onClick: () => ocean.tsunami.launch({ x: beaver.position.x, z: beaver.position.z }, 330, { ...TSUNAMI_PRESETS.rogue, height: 17, direction: engine.wind.directionRadians, breaking: 0.55 }) },
    ]);
    panel.buttons([
      { label: 'Auto geysers', isOn: () => state.geysers, onClick: () => { state.geysers = !state.geysers; } },
      { label: 'Jet passes', isOn: () => state.jet, onClick: () => { state.jet = !state.jet; jet.rig.object.visible = state.jet; } },
      { label: 'Auto-orbit', isOn: () => orbit.autoRotate !== 0, onClick: () => { orbit.autoRotate = orbit.autoRotate ? 0 : 0.05; } },
    ]);
    panel.section('Floatplane');
    panel.slider('Throttle', 0, 1, 0.01, () => beaver.throttle, (v) => { beaver.throttle = v; });

    return {
      hud: () => [
        `sea   <b>Hs ${ocean.significantHeight.toFixed(1)} m</b>  wind ${engine.wind.speed.toFixed(0)} m/s`,
        `jet   Mach ${jet.aero.mach.toFixed(2)}  alt ${Math.max(0, jet.aero.altitude).toFixed(0)} m  booms ${jet.aero.booms}`,
        `storm ⚡ ${(lightning.intensity * 100).toFixed(0)} %  blasts ${explosions.count}`,
      ],
      debug: { weather, ocean, fx, rain, lightning, explosions, beaver, jet, scenery },
      dispose() { orbit.dispose(); beaver.dispose(); jet.dispose(); scenery.dispose(); },
    };
  },
};
