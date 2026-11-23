/** Scene 2 – Fighter jet over ocean: downwash, vapour cone, Mach-1 boom. */
import * as THREE from 'three/webgpu';
import { CLIMATES } from '../../engine/climate';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS, CLOUD_LAYERS } from '../../modules/weather/weather';
import { Ocean } from '../../modules/water/ocean';
import { OCEAN_PRESETS } from '../../modules/water/spectrum';
import { JET_IDS, type JetId } from '../../test-rigs';
import { JetActor } from '../actors/jet';
import { FollowOrbit } from '../camera';
import {
  SceneryRegistry,
  buildBuoy,
  buildDistantVessels,
  buildHeadlands,
  buildRockClusters,
  createRockMaterial,
  createTerrainMaterial,
  type RockPlacement,
} from '../scenery';
import type { SceneContext, SceneHandle, ShowcaseScene } from './types';

type CameraMode = 'flyby' | 'chase' | 'wake' | 'orbit';

export const jetScene: ShowcaseScene = {
  id: 'jet', label: 'Jet Over Ocean', title: 'Fighter jet over ocean', description: '',
  async create(ctx: SceneContext): Promise<SceneHandle> {
    const { engine, panel, canvas } = ctx;
    const { camera } = engine;
    camera.near = 0.5; camera.far = 60000; camera.fov = 45; camera.updateProjectionMatrix();

    const weather = engine.add(new Weather(engine, { upperClouds: { ...CLOUD_LAYERS.highBank, coverage: 0 } }));
    Object.assign(weather.params, WEATHER_PRESETS.tropical, { sunElevation: 30, sunAzimuth: 62, coverage: 0.39, exposure: 0.48 });
    const ocean = engine.add(new Ocean(engine, { weather }));
    ocean.setSeaStates(OCEAN_PRESETS.breeze, OCEAN_PRESETS.swell);
    ocean.morph = 0.22;
    ocean.optics.clarity = 0.8;
    const fx = engine.add(new EffectsKit(engine));
    const jet = new JetActor(engine, fx, ocean, 'f22', { passAltitude: 14, machPeak: 1.16, heading: 0 });
    jet.aero.params.humidity = 0.85;

    // ---- Sweeping distant coastal range & naval test-range scale anchors -----------
    // Placed strictly north of the flight corridor (z < -750) and far east (+X > 4400)
    // so the Mach-1.16 pass and racetrack turn (+Z side) remain 100% unobstructed.
    const scenery = new SceneryRegistry('jet-scenery', engine.world);
    engine.scene.add(scenery.group);
    const rangeMat = createTerrainMaterial(scenery, weather, {
      terrainShadows: true,
      palette: 'temperate',
      rockiness: 0.35,
      mistStart: 600,
      mistRange: 3800,
      mistMax: 0.78,
      mistHeight: 340,
    });
    const stackMat = createRockMaterial(scenery, weather, 'temperate', { mistStart: 450, mistRange: 3200, mistMax: 0.72 });

    buildHeadlands(
      scenery,
      [
        // Mid-distance rugged coastal headlands along the northern & northeastern flyby panorama (-Z / +X)
        { x: -980, z: -1560, radiusX: 540, radiusZ: 320, height: 132, rotation: 0.14, segments: 44, cragginess: 0.74, seed: 701 },
        { x: 420, z: -1680, radiusX: 620, radiusZ: 340, height: 148, rotation: -0.18, segments: 48, cragginess: 0.76, seed: 719 },
        { x: 2150, z: -1650, radiusX: 740, radiusZ: 360, height: 165, rotation: 0.24, segments: 48, cragginess: 0.72, seed: 733 },
        // Sweeping far coastal mountain chain directly framing the long-lens flyby sightline (+0.79, -0.61)
        { x: -2200, z: -3450, radiusX: 1350, radiusZ: 680, height: 320, rotation: 0.08, segments: 40, cragginess: 0.76, seed: 751 },
        { x: -150, z: -3850, radiusX: 1550, radiusZ: 740, height: 375, rotation: -0.1, segments: 40, cragginess: 0.78, seed: 769 },
        { x: 2450, z: -3500, radiusX: 1580, radiusZ: 760, height: 365, rotation: 0.12, segments: 44, cragginess: 0.76, seed: 787 },
        { x: 4750, z: -3250, radiusX: 1680, radiusZ: 820, height: 390, rotation: 0.22, segments: 44, cragginess: 0.78, seed: 809 },
        { x: 6400, z: -2100, radiusX: 1380, radiusZ: 740, height: 310, rotation: 0.42, segments: 40, cragginess: 0.72, seed: 811 },
        // Far eastern archipelago visible in chase view
        { x: 5600, z: -550, radiusX: 840, radiusZ: 560, height: 225, rotation: -0.25, segments: 36, cragginess: 0.68, seed: 823 },
      ],
      rangeMat,
      { name: 'jet-coastal-range', woodland: 'evergreen', castShadow: false, receiveShadow: false },
    );

    // Basalt sea stacks off the mid-distance headlands
    const stacks: RockPlacement[] = [
      { x: -580, y: 12, z: -1240, scaleX: 34, scaleY: 38, scaleZ: 28, rotY: 0.4, variant: 0 },
      { x: -520, y: 7, z: -1190, scaleX: 22, scaleY: 22, scaleZ: 20, rotY: 1.9, variant: 1 },
      { x: 1420, y: 16, z: -1240, scaleX: 46, scaleY: 48, scaleZ: 36, rotY: 2.3, variant: 2 },
      { x: 1510, y: 9, z: -1180, scaleX: 26, scaleY: 26, scaleZ: 24, rotY: 0.9, variant: 0 },
      { x: 2680, y: 18, z: -1450, scaleX: 52, scaleY: 54, scaleZ: 42, rotY: 1.3, variant: 1 },
    ];
    buildRockClusters(scenery, stacks, stackMat, { name: 'jet-sea-stacks', castShadow: false, receiveShadow: false, seed: 839 });

    // Distant naval escort silhouettes + range marker buoys for military maritime scale
    buildDistantVessels(scenery, weather, [
      { x: 1240, z: -920, yaw: 0.22, kind: 'frigate', scale: 1.2 },
      { x: 520, z: -960, yaw: 0.16, kind: 'frigate', scale: 1.0 },
    ]);
    const buoys = [
      buildBuoy(scenery, { x: 210, z: -260, kind: 'channel', color: 0xc23522, beacon: [24, 12, 5] }),
      buildBuoy(scenery, { x: -240, z: -290, kind: 'channel', color: 0x266c45, beacon: [8, 22, 10] }),
    ];

    const state = { mode: 'flyby' as CameraMode, airframe: 'f22' as JetId };
    const orbit = new FollowOrbit(camera, canvas, new THREE.Vector3(0, 6, 0), new THREE.Vector3(-70, 22, 90));
    orbit.controls.enabled = false;
    orbit.floor = (x, z) => ocean.heightAt(x, z) + 0.8;
    // Keep the shore observer just below the pass. The horizon, pressure
    // footprint and distant range then give the aircraft a common scale.
    const eye = new THREE.Vector3(-88, 11, 172);
    const look = new THREE.Vector3();
    const tmp = new THREE.Vector3();

    let cloudRoute: 'low' | 'high' | null = null;
    engine.onUpdate = (dt) => {
      if (cloudRoute && weather.clouds.uniforms.base.value === weather.params.cloudBase &&
          (cloudRoute === 'low' || engine.world.upperCloudBase === weather.upperClouds?.base)) {
        const base = cloudRoute === 'high' ? engine.world.upperCloudBase : weather.params.cloudBase;
        const top = cloudRoute === 'high' ? engine.world.upperCloudTop : weather.params.cloudTop;
        cloudRoute = null;
        // Follow the broken edge of a bank so the wake has both a dark wall and an opening to sky.
        // A cloud layer can contain clear air at the nominal pass altitude.
        const plan = jet.flight.plan, layer = top - base;
        let best = -Infinity, altitude = base + layer * 0.2;
        for (let h = 0.12; h < 0.85; h += 0.035) {
          const y = base + layer*h;
          let sum = 0, occupied = 0, overhead = 0;
          for (let d = -830; d <= -50; d += 65) {
            tmp.set(plan.focus.x + d * Math.cos(plan.heading), y, plan.focus.z + d * Math.sin(plan.heading));
            const condensate = weather.sampleCloudDensity(tmp);
            sum += condensate;
            if (condensate > 0.12) occupied++;
            tmp.y += 65;
            overhead += weather.sampleCloudDensity(tmp);
          }
          const score = occupied / 13 - 2.3 * Math.abs(sum / 13 - 0.22) - overhead / 13;
          if (score > best) { best = score; altitude = y; }
        }
        plan.passAltitude = altitude - plan.focus.y;
        plan.cruiseAltitude = plan.passAltitude + 80;
        jet.flight.resetToRunIn(850);
        jet.aero.cloudTrail.reset();
      }
      jet.update(dt);
      const s = jet.flight.state;
      // The interaction field follows the jet while it is low, otherwise it stays on the focus.
      ocean.updateField(dt, s.onPass && Math.abs(s.along) < 2500 ? s.position : jet.flight.plan.focus);
      weather.shadowFocus.copy(s.position);
      for (const buoy of buoys) buoy.followSurface(ocean,camera.position,dt,0.15);
    };
    engine.onBeforeRender = (dt) => {
      const s = jet.flight.state;
      const p = s.position;
      if (state.mode === 'flyby') {
        // Tripod camera near the focus that tracks the aircraft with a long lens.
        // Frame the pressure wake and distant ridgeline from the rocky shore.
        camera.position.copy(eye);
        // Pan with the aircraft's angular velocity. Lagging its current position puts
        // the nose against the frame edge on a fast broadside pass.
        tmp.copy(p).addScaledVector(s.velocity, 0.055);
        const overWater = 1 - THREE.MathUtils.smoothstep(jet.aero.altitude, 28, 85);
        tmp.y -= 1.2 + Math.min(5.2, jet.aero.altitude * 0.28) * overWater;
        look.lerp(tmp, 1 - Math.exp(-dt * 22));
        if (look.distanceTo(p) > 900) look.copy(p);
        camera.lookAt(look);
        const d = camera.position.distanceTo(p);
        // Smooth the zoom: an abrupt focal-length change every frame reads as judder.
        const targetFov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((13 + 4.5 * overWater) / d)), 2.3, 47);
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
      } else if (state.mode === 'wake') {
        // Look aft from just off the nose. The full swept corridor is behind the
        // aircraft, with disturbed condensate between the observer and the distant sky.
        tmp.set(5.8,2.8,-17).applyQuaternion(s.quaternion);
        camera.position.copy(p).add(tmp);
        camera.position.y = Math.max(camera.position.y, ocean.heightAt(camera.position.x,camera.position.z)+2.5);
        camera.lookAt(tmp.set(0.4,0.2,10).applyQuaternion(s.quaternion).add(p));
        camera.fov = 58;
      } else if (state.mode === 'chase') {
        const inCloud=engine.world.inCloudLayer(p.y);
        if(inCloud)tmp.set(9.8,3.4,25);else tmp.set(7,5.5,42);
        tmp.applyQuaternion(s.quaternion);
        camera.position.copy(p).add(tmp);
        camera.position.y = Math.max(camera.position.y, ocean.heightAt(camera.position.x, camera.position.z) + 2.5);
        camera.lookAt(tmp.set(0, 1, inCloud?-9:-30).applyQuaternion(s.quaternion).add(p));
        camera.fov = 58 + Math.min(8, s.mach * 4);
      } else {
        camera.fov = 45;
        orbit.update(dt);
      }
      camera.updateProjectionMatrix();
      // Speed-reactive camera rumble: strongest when the jet is close.
      const proximity = 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(p), 60, 600);
      engine.trauma.rumble = proximity * Math.min(1, s.mach) * (state.mode === 'chase' ? 0.6 : 1);
    };

    const setMode = (mode: CameraMode) => {
      state.mode = mode;
      orbit.controls.enabled = mode === 'orbit';
      if (mode === 'orbit') { orbit.controls.target.set(0, 4, 0); camera.position.set(-70, 22, 90); }
    };

    panel.header('Fighter jet over ocean', 'A low supersonic pass: travelling pressure trough, radial shock ripples, spray rooster tail, Prandtl–Glauert cone and a Mach-1 boom.');
    panel.section('Flight');
    panel.select<JetId>('Airframe', JET_IDS.map((id) => [id, id.toUpperCase()] as [JetId, string]), () => state.airframe, (id) => { state.airframe = id; jet.setAirframe(id); });
    panel.slider('Engine power', 0, 1, 0.01, () => jet.throttle, v => { jet.throttle = v; });
    panel.select<'all' | 'cut'>('Engine feed', [['all', 'All engines'], ['cut', 'Engine 1 off']],
      () => jet.engineThrottles ? 'cut' : 'all', feed => { jet.engineThrottles = feed === 'cut' ? [0] : undefined; });
    panel.slider('Pass altitude', 6, 120, 1, () => jet.flight.plan.passAltitude, (v) => { jet.flight.plan.passAltitude = v; }, (v) => `${v.toFixed(0)} m`);
    panel.slider('Peak Mach', 0.6, 1.6, 0.01, () => jet.flight.plan.machPeak, (v) => { jet.flight.plan.machPeak = v; });
    panel.slider('Humidity', 0, 1, 0.01, () => jet.aero.params.humidity, (v) => { jet.aero.params.humidity = v; });
    panel.buttons([{ label: 'New pass', primary: true, onClick: () => jet.flight.resetToRunIn(1900) }]);
    const cloudPass=(deck: 'low' | 'high' = 'low')=>{
      weather.params.cloudBase=260;weather.params.cloudTop=690;weather.params.coverage=0.78;weather.params.cloudDensity=0.94;
      Object.assign(weather.upperClouds!, CLOUD_LAYERS.highBank, { base: 1200, top: 2300, coverage: 0.71 });
      cloudRoute = deck;
      setMode('wake');
    };
    panel.buttons([{label:'Fly through cloud',onClick:() => cloudPass()}, {label:'Fly through upper deck',onClick:() => cloudPass('high')}]);
    const cruise = (high: boolean) => {
      cloudRoute = null;
      Object.assign(jet.flight.plan, high ? { passAltitude: 8800, cruiseAltitude: 8850, machIn: 0.78, machPeak: 0.82 }
        : { passAltitude: 14, cruiseAltitude: 420, machIn: 0.82, machPeak: 1.16 });
      engine.world.setClimate(high ? CLIMATES.coldFront : undefined);
      Object.assign(weather.params, high ? WEATHER_PRESETS.blueHour : WEATHER_PRESETS.tropical, high
        ? { sunElevation: -1.5, sunAzimuth: 22, turbidity: 1.35, coverage: 0.52 }
        : { sunElevation: 30, sunAzimuth: 62, coverage: 0.39, exposure: 0.48 });
      Object.assign(weather.upperClouds!, CLOUD_LAYERS.highBank, high
        ? { base: 5200, top: 6700, coverage: 0.35 } : { coverage: 0 });
      jet.flight.resetToRunIn(1300);
      jet.aero.cloudTrail.reset();
      setMode(high ? 'wake' : 'flyby');
    };
    panel.buttons([{ label: 'Last light at altitude', onClick: () => cruise(true) },
      { label: 'Low ocean pass', onClick: () => cruise(false) }]);
    panel.section('Camera');
    panel.buttons((['flyby', 'chase', 'wake', 'orbit'] as CameraMode[]).map((mode) => ({ label: mode, isOn: () => state.mode === mode, onClick: () => setMode(mode) })));
    panel.section('Sea + sky');
    panel.slider('Moon illuminated', 0, 1, 0.01, () => typeof weather.params.moonIllumination === 'number' ? weather.params.moonIllumination : 1,
      v => { weather.params.moonIllumination = v; }, v => `${Math.round(v * 100)}%`);
    panel.slider('Cloud growth', -1, 1, 0.02, () => weather.params.convection ?? 0, v => { weather.params.convection = v; });
    panel.slider('Sea state', 0, 1, 0.01, () => ocean.morph, (v) => { ocean.morph = v; });
    panel.buttons([
      { label: 'Golden hour', onClick: () => Object.assign(weather.params, WEATHER_PRESETS.goldenHour) },
      { label: 'Blue hour', onClick: () => Object.assign(weather.params, WEATHER_PRESETS.blueHour) },
      { label: 'Night', onClick: () => Object.assign(weather.params, WEATHER_PRESETS.clearNight) },
    ]);
    panel.slider('Sun elevation', -20, 80, 0.5, () => weather.params.sunElevation, (v) => { weather.params.sunElevation = v; }, (v) => `${v.toFixed(0)}°`);

    return {
      hud: () => [
        `jet   <b>Mach ${jet.aero.mach.toFixed(2)}</b>  ${(jet.flight.state.speed * 1.944).toFixed(0)} kt`,
        `alt   <b>${jet.aero.altitude.toFixed(0)} m</b>  G ${jet.flight.state.gLoad.toFixed(1)}`,
        `cone  ${(jet.aero.coneIntensity * 100).toFixed(0)} %   booms <b>${jet.aero.booms}</b>`,
      ],
      debug: { weather, ocean, fx, jet, scenery, setMode, cloudPass },
      dispose() { orbit.dispose(); jet.dispose(); scenery.dispose(); },
    };
  },
};
