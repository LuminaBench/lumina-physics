/**
 * Scene 1 – Tranquil turquoise lagoon → deep-ocean swell → massive tsunami.
 * Scene 6 – Tsunami landfall (same world, wave launched at the island).
 */
import { yieldToBrowser } from '../../engine/loading';
import { addCanopyHorizons } from '../scenery/terrain';
import { CoastRescue } from '../actors/coast-rescue';
import * as THREE from 'three/webgpu';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { Ocean } from '../../modules/water/ocean';
import { OCEAN_PRESETS } from '../../modules/water/spectrum';
import { Bathymetry, lagoonIsland } from '../../modules/water/seabed';
import { TsunamiEffects } from '../../modules/water/tsunami-fx';
import { Underwater } from '../../modules/water/underwater';
import { TSUNAMI_PRESETS } from '../../modules/water/tsunami';
import { BeaverActor } from '../actors/beaver';
import { FollowOrbit } from '../camera';
import { mulberry32 } from '../../engine/noise';
import {
  SceneryRegistry,
  buildCoastalCanopy,
  buildHeadlands,
  buildPalmGrove,
  buildRockClusters,
  createRockMaterial,
  createTerrainMaterial,
  scatterOnTerrain,
  type RockPlacement,
} from '../scenery';
import type { SceneContext, SceneHandle, ShowcaseScene } from './types';

async function createCoast(ctx: SceneContext, landfall: boolean): Promise<SceneHandle> {
  const { engine, panel, canvas } = ctx;
  const { scene, camera } = engine;
  camera.near = 0.3; camera.far = 60000; camera.fov = 50; camera.updateProjectionMatrix();

  const weather = engine.add(new Weather(engine));
  Object.assign(weather.params, WEATHER_PRESETS.tropical, landfall
    ? { sunElevation: 20, sunAzimuth: 93, exposure: 0.62 }
    : { sunElevation: 35, sunAzimuth: 54, exposure: 0.58 });
  const bathymetry = new Bathymetry({ size: 1500, center: new THREE.Vector2(200, 40), height: lagoonIsland() }, { cloudShadow: (p) => weather.cloudShadow(p) });
  scene.add(bathymetry.mesh);
  await yieldToBrowser();
  const ocean = engine.add(new Ocean(engine, { weather, bathymetry }));
  ocean.setSeaStates(OCEAN_PRESETS.lagoon, OCEAN_PRESETS.swell);
  ocean.optics.clarity = 0.95;
  ocean.optics.foam = 0.45;
  const fx = engine.add(new EffectsKit(engine));
  const tsunamiFx = engine.add(new TsunamiEffects(engine, fx, ocean));
  weather.groundColor.setRGB(0.03, 0.12, 0.14);

  // ---- Tropical archipelago, lush lagoon island dressing & outer bay headlands -----
  const scenery = new SceneryRegistry('coast-scenery', engine.world);
  scene.add(scenery.group);
  const headlandMat = createTerrainMaterial(scenery, weather, {
    terrainShadows: true,
    palette: 'tropical',
    mistStart: 360,
    mistRange: 3000,
    mistMax: 0.72,
    mistHeight: 260,
  });
  const rockMat = createRockMaterial(scenery, weather, 'tropical', { mistStart: 320, mistRange: 2600, mistMax: 0.62 });

  // Outer volcanic archipelago framing both the lagoon view (+X/-Z) and landfall wave bay (-X/+Z),
  // leaving the entire inner lagoon circle and the tsunami propagation corridor open.
  await yieldToBrowser();
  const headlands = buildHeadlands(
    scenery,
    [
      // Mid-ground lush coastal headlands framing the lagoon horizon
      { x: 420, z: -470, radiusX: 255, radiusZ: 185, height: 84, rotation: 0.35, segments: 52, cragginess: 0.62, seed: 101 },
      { x: -250, z: -560, radiusX: 290, radiusZ: 195, height: 98, rotation: -0.28, segments: 52, cragginess: 0.68, seed: 127 },
      { x: 740, z: -90, radiusX: 220, radiusZ: 160, height: 64, rotation: 0.85, segments: 44, cragginess: 0.52, seed: 149 },
      // Bay headland flanking the south/southwest edge for tsunami landfall scale
      { x: -160, z: 430, radiusX: 270, radiusZ: 190, height: 92, rotation: 0.42, segments: 52, cragginess: 0.64, seed: 173 },
      { x: 260, z: 640, radiusX: 320, radiusZ: 210, height: 112, rotation: -0.35, segments: 44, cragginess: 0.58, seed: 197 },
      // Distant volcanic caldera ridges dissolving into coastal mist
      { x: 860, z: -1520, radiusX: 780, radiusZ: 390, height: 225, rotation: 0.18, segments: 42, cragginess: 0.72, seed: 211 },
      { x: -860, z: -1680, radiusX: 840, radiusZ: 420, height: 255, rotation: -0.14, segments: 42, cragginess: 0.74, seed: 229 },
      { x: -780, z: 1240, radiusX: 740, radiusZ: 380, height: 215, rotation: 0.22, segments: 40, cragginess: 0.68, seed: 251 },
    ],
    headlandMat,
    { name: 'coast-archipelago', woodland: 'broadleaf', castShadow: false, receiveShadow: true },
  );

  await yieldToBrowser();
  bathymetry.addCoast(headlands.mesh);

  // Combined height/slope sampler covering both the inner bathymetry islet and outer headlands.
  const landHeight = (x: number, z: number) => Math.max(bathymetry.baseHeightAt(x, z), headlands.heightAt(x, z));
  const landSlope = (x: number, z: number) => {
    const e = 2.0;
    const hx = (landHeight(x + e, z) - landHeight(x - e, z)) / (2 * e);
    const hz = (landHeight(x, z + e) - landHeight(x, z - e)) / (2 * e);
    return 1 / Math.sqrt(1 + hx * hx + hz * hz);
  };

  // Organic tropical palms on the inner lagoon island + mid-distance bay headlands.
  const islandPalms = scatterOnTerrain({
    bounds: { minX: 160, maxX: 360, minZ: -60, maxZ: 140 },
    count: 64,
    heightAt: landHeight,
    slopeAt: landSlope,
    minHeight: 1.8,
    maxHeight: 13.5,
    minSlope: 0.72,
    minSpacing: 6.5,
    scaleRange: [0.85, 1.45],
    leanMax: 0.18,
    clusterFreq: 0.045,
    clusterThreshold: -0.12,
    seed: 307,
  });
  const headlandPalms = [
    ...scatterOnTerrain({
      bounds: { minX: 200, maxX: 620, minZ: -640, maxZ: -300 },
      count: 42,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 2.2,
      maxHeight: 28,
      minSlope: 0.66,
      minSpacing: 14,
      scaleRange: [1.1, 1.85],
      leanMax: 0.16,
      clusterFreq: 0.025,
      clusterThreshold: -0.05,
      seed: 331,
    }),
    ...scatterOnTerrain({
      bounds: { minX: -480, maxX: -40, minZ: -740, maxZ: -370 },
      count: 38,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 2.2,
      maxHeight: 30,
      minSlope: 0.66,
      minSpacing: 15,
      scaleRange: [1.1, 1.9],
      leanMax: 0.16,
      clusterFreq: 0.025,
      clusterThreshold: -0.05,
      seed: 353,
    }),
    ...scatterOnTerrain({
      bounds: { minX: -390, maxX: 80, minZ: 240, maxZ: 600 },
      count: 40,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 2.2,
      maxHeight: 28,
      minSlope: 0.66,
      minSpacing: 15,
      scaleRange: [1.1, 1.85],
      leanMax: 0.16,
      clusterFreq: 0.025,
      clusterThreshold: -0.05,
      seed: 379,
    }),
  ];
  buildPalmGrove(scenery, [...islandPalms, ...headlandPalms], { name: 'coast-palms', castShadow: false });

  // Lush multi-tone broadleaf canopy & coastal dune scrub crowning the island and mid-headlands.
  await yieldToBrowser();
  const islandCanopy = scatterOnTerrain({
    bounds: { minX: 170, maxX: 350, minZ: -50, maxZ: 130 },
    count: 52,
    heightAt: landHeight,
    slopeAt: landSlope,
    minHeight: 3.4,
    maxHeight: 16,
    minSlope: 0.68,
    minSpacing: 7.5,
    scaleRange: [1.2, 2.3],
    clusterFreq: 0.038,
    clusterThreshold: -0.15,
    seed: 401,
  });
  const headlandCanopy = [
    ...scatterOnTerrain({
      bounds: { minX: 190, maxX: 640, minZ: -650, maxZ: -290 },
      count: 48,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 5,
      maxHeight: 72,
      minSlope: 0.62,
      minSpacing: 18,
      scaleRange: [2.2, 4.4],
      clusterFreq: 0.02,
      clusterThreshold: -0.1,
      seed: 419,
    }),
    ...scatterOnTerrain({
      bounds: { minX: -510, maxX: -20, minZ: -740, maxZ: -360 },
      count: 48,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 5,
      maxHeight: 82,
      minSlope: 0.62,
      minSpacing: 19,
      scaleRange: [2.4, 4.6],
      clusterFreq: 0.02,
      clusterThreshold: -0.1,
      seed: 443,
    }),
    ...scatterOnTerrain({
      bounds: { minX: -410, maxX: 90, minZ: 240, maxZ: 610 },
      count: 46,
      heightAt: headlands.heightAt,
      slopeAt: headlands.slopeAt,
      minHeight: 5,
      maxHeight: 76,
      minSlope: 0.62,
      minSpacing: 18,
      scaleRange: [2.3, 4.5],
      clusterFreq: 0.02,
      clusterThreshold: -0.1,
      seed: 467,
    }),
  ];
  // Scatter smaller understory crowns around mature stands. Mixing age and
  // canopy height breaks the evenly spaced, isolated tree silhouettes.
  const forest = [...islandCanopy, ...headlandCanopy];
  const matureCount = forest.length;
  const forestRandom = mulberry32(482);
  for (let i = 0; i < matureCount; i++) {
    const tree = forest[i];
    const youngCount = 2 + Math.floor(forestRandom() * 5);
    for (let j = 0; j < youngCount; j++) {
      const angle = forestRandom() * Math.PI * 2, r = (2.5 + forestRandom() * 4.2) * tree.scale;
      const x = tree.x + Math.cos(angle) * r, z = tree.z + Math.sin(angle) * r;
      const y = landHeight(x,z);
      if (y < 1.5 || Math.abs(y - tree.y) > 0.9 * r) continue;
      forest.push({ x, y, z, scale: tree.scale * (0.29 + forestRandom() * 0.46),
        rotY: forestRandom() * Math.PI * 2, tint: [0.66 + forestRandom() * 0.32, 0.72 + forestRandom() * 0.24, 0.67 + forestRandom() * 0.22] });
    }
  }
  addCanopyHorizons(headlands.mesh, forest, 4.35, 3.8, 1.85);
  buildCoastalCanopy(scenery, forest, 'tropical', { name: 'coast-canopy', castShadow: false, seed: 503 });

  const islandScrub = scatterOnTerrain({
    bounds: { minX: 155, maxX: 365, minZ: -65, maxZ: 145 },
    count: 48,
    heightAt: landHeight,
    slopeAt: landSlope,
    minHeight: 1.5,
    maxHeight: 7.5,
    minSlope: 0.7,
    minSpacing: 5.5,
    scaleRange: [0.9, 1.9],
    clusterFreq: 0.05,
    clusterThreshold: -0.1,
    seed: 521,
  });
  buildCoastalCanopy(scenery, islandScrub, 'scrub', { name: 'coast-scrub', castShadow: false, seed: 547 });

  // Sculpted shoreline basalt/limestone boulders along rocky spits & sea stacks.
  const randRock = mulberry32(613);
  const rocks: RockPlacement[] = [];
  for (let i = 0; i < 42; i++) {
    const a = randRock() * Math.PI * 2;
    const r = 74 + randRock() * 28;
    const rx = 260 + Math.cos(a) * r, rz = 40 + Math.sin(a) * r;
    const ry = bathymetry.heightAt(rx, rz);
    if (ry < -1.2 || ry > 4.2) continue;
    rocks.push({
      x: rx, y: ry - 0.3, z: rz,
      scaleX: 1.4 + randRock() * 3.4,
      scaleY: 0.9 + randRock() * 2.1,
      scaleZ: 1.4 + randRock() * 3.2,
      rotY: randRock() * Math.PI * 2,
      variant: i % 3,
    });
  }
  // Dramatic sea-stack clusters off the mid-ground headland tips
  for (const [cx, cz, n, baseS] of [[250, -370, 7, 6.5], [-120, -420, 8, 7.5], [-30, 310, 8, 7.0], [560, -180, 6, 5.5]] as const) {
    for (let i = 0; i < n; i++) {
      const a = randRock() * Math.PI * 2;
      const dist = randRock() * 48;
      const s = baseS * (0.45 + randRock() * 1.15);
      rocks.push({
        x: cx + Math.cos(a) * dist,
        y: -1.5 + s * 0.28,
        z: cz + Math.sin(a) * dist,
        scaleX: s * (0.85 + randRock() * 0.5),
        scaleY: s * (0.7 + randRock() * 0.95),
        scaleZ: s * (0.85 + randRock() * 0.5),
        rotY: randRock() * Math.PI * 2,
        variant: i % 3,
      });
    }
  }
  buildRockClusters(scenery, rocks, rockMat, { name: 'coast-rocks', castShadow: false, receiveShadow: true, seed: 617 });

  await yieldToBrowser();
  const beaver = new BeaverActor(engine, fx, ocean, new THREE.Vector3(landfall ? 60 : -30, 0.7, landfall ? -30 : -40), landfall ? -1.2 : 0.4);
  beaver.throttle = landfall ? 0 : 0.55;
  beaver.circleRadius = 90;
  const orbit = new FollowOrbit(camera, canvas, beaver.position.clone().add(new THREE.Vector3(0, 1.6, 0)), landfall ? new THREE.Vector3(27, 8, -26) : new THREE.Vector3(-17, 5.5, 15));
  orbit.floor = (x, z) => ocean.heightAt(x, z);
  orbit.controls.minDistance = 6;
  orbit.controls.maxDistance = 600;

  const underwater = engine.add(new Underwater(engine, ocean));
  const surfaceFloor = (x: number, z: number) => ocean.heightAt(x, z);
  /** Take the camera below the surface (or back up): the orbit pivot stays on the floatplane. */
  const dive = (on: boolean) => {
    state.diving = on;
    orbit.floor = on ? (x, z) => bathymetry.heightAt(x, z) - 0.1 : surfaceFloor;
    orbit.controls.maxPolarAngle = on ? Math.PI * 0.93 : Math.PI * 0.497;
    const t = orbit.controls.target;
    const offset = camera.position.clone().sub(t);
    const reach = Math.max(9, Math.min(16, Math.hypot(offset.x, offset.z)));
    const heading = Math.atan2(offset.z, offset.x);
    const y = on ? Math.max(bathymetry.heightAt(t.x, t.z) + 1.2, ocean.waterLevel - 3.4) - t.y : 5.5;
    camera.position.set(t.x + Math.cos(heading) * reach, t.y + y, t.z + Math.sin(heading) * reach);
  };

  const state = { sea: 0, tsunamiHeight: landfall ? 20 : 24, tsunamiBreaking: 0.85, relaunch: landfall ? 3 : -1, diving: false };
  const applySea = (v: number) => {
    state.sea = v;
    ocean.morph = v;
    // The seabed (and island + coastal archipelago) sink away: the lagoon opens into deep ocean.
    const sink = Math.pow(v, 1.6) * 700;
    bathymetry.setSink(sink);
    scenery.group.position.y = -sink;
    scenery.group.visible = sink < 380;
    ocean.optics.clarity = THREE.MathUtils.lerp(0.95, 0.82, v);
    ocean.optics.breakerHeight = THREE.MathUtils.lerp(0.4, 0, Math.min(1, v * 4));
    weather.params.coverage = THREE.MathUtils.lerp(0.42, 0.6, v);
    weather.params.turbidity = THREE.MathUtils.lerp(2.2, 3.4, v);
    weather.groundColor.setRGB(THREE.MathUtils.lerp(0.03, 0.01, v), THREE.MathUtils.lerp(0.12, 0.04, v), THREE.MathUtils.lerp(0.14, 0.09, v));
  };
  applySea(0);

  const launch = () => {
    const direction = landfall ? 0 : Math.atan2(beaver.position.z - camera.position.z, beaver.position.x - camera.position.x) + Math.PI * 0.65;
    ocean.tsunami.launch({ x: beaver.position.x, z: beaver.position.z }, landfall ? 420 : 360, {
      ...TSUNAMI_PRESETS.breakingWall, height: state.tsunamiHeight, breaking: state.tsunamiBreaking, direction,
      width: 22 + state.tsunamiHeight * 1.05, speed: 13 + state.tsunamiHeight * 0.26,
    });
  };

  let rescue: CoastRescue;
  const pivot = new THREE.Vector3();
  engine.onUpdate = (dt) => {
    beaver.update(dt);
    tsunamiFx.focus.copy(beaver.position);
    ocean.updateField(dt, rescue?.focus ?? beaver.position);
    weather.shadowFocus.copy(rescue?.focus ?? beaver.position);
    if (state.relaunch >= 0) {
      state.relaunch -= dt;
      if (state.relaunch <= 0) { launch(); state.relaunch = 55; }
    }
    // Once the wave is far past, let it fade so the sea settles.
    const t = ocean.tsunami;
    if (t.running && t.front - (beaver.position.x * Math.cos(t.profile.direction) + beaver.position.z * Math.sin(t.profile.direction)) > 900) t.stop();
  };
  // Camera after physics: it follows the plane's interpolated pose of *this* frame.
  let lastRescueFocus:THREE.Vector3|null=null;
  const floatplaneView=new THREE.Vector3();
  engine.onBeforeRender = (dt) => {
    const focus=rescue?.focus ?? null,boat=rescue?.followingBoat;
    if(focus && !lastRescueFocus)floatplaneView.copy(camera.position).sub(orbit.controls.target);
    pivot.copy(focus ?? beaver.rig.object.position);
    pivot.y+=boat?0.48:focus?2.2:1.6;
    orbit.follow(pivot,1);
    if(lastRescueFocus!==focus){
      if(focus){
        if(boat) camera.position.set(-6.8,2.1,-5.9);
        else camera.position.set(-15.2,5.7,13.0);
        camera.position.add(pivot);
      } else camera.position.copy(pivot).add(floatplaneView);
      lastRescueFocus=focus;
    }
    orbit.update(dt);
  };

  panel.header(landfall ? 'Tsunami landfall' : 'Lagoon → ocean → tsunami', landfall
    ? 'A breaking wall shoals over the reef (Green’s law) and throws the moored Beaver.'
    : 'One physical ocean: morph the sea state, then launch a breaking mega-wave under the DHC-2 Beaver.');
  panel.section('Sea state');
  panel.slider('Lagoon → swell', 0, 1, 0.01, () => state.sea, applySea);
  let tideAmplitude = 0;
  panel.slider('Tide amplitude', 0, 2.5, 0.05, () => tideAmplitude, (v) => {
    tideAmplitude = v;
    ocean.setTide({ amplitude: v, periodSeconds: 120, phase: (engine.time / 120) % 1 });
  }, (v) => v.toFixed(2) + ' m');
  panel.slider('Water clarity', 0, 1, 0.01, () => ocean.optics.clarity, (v) => { ocean.optics.clarity = v; });
  panel.slider('Whitecaps', 0, 1, 0.01, () => ocean.optics.foam, (v) => { ocean.optics.foam = v; });
  panel.slider('Sun elevation', 2, 80, 1, () => weather.params.sunElevation, (v) => { weather.params.sunElevation = v; weather.params.exposure = THREE.MathUtils.lerp(1.05, 0.62, THREE.MathUtils.smoothstep(v, 4, 40)); }, (v) => `${v.toFixed(0)}°`);
  panel.slider('Cloud cover', 0, 1, 0.01, () => weather.params.coverage, (v) => { weather.params.coverage = v; });
  panel.section('Tsunami');
  panel.slider('Crest height', 6, 45, 1, () => state.tsunamiHeight, (v) => { state.tsunamiHeight = v; }, (v) => `${v.toFixed(0)} m`);
  panel.slider('Breaking', 0, 1, 0.01, () => state.tsunamiBreaking, (v) => { state.tsunamiBreaking = v; ocean.tsunami.profile.breaking = v; });
  panel.buttons([{ label: 'Launch tsunami', primary: true, onClick: launch }, { label: 'Calm', onClick: () => ocean.tsunami.stop() }]);
  panel.section('DHC-2 Beaver');
  panel.slider('Throttle', 0, 1, 0.01, () => beaver.throttle, (v) => { beaver.throttle = v; });
  panel.buttons([
    { label: 'Circle', isOn: () => beaver.circleRadius !== null, onClick: () => { beaver.circleRadius = beaver.circleRadius === null ? 90 : null; } },
    { label: 'Auto-orbit', isOn: () => orbit.autoRotate !== 0, onClick: () => { orbit.autoRotate = orbit.autoRotate ? 0 : 0.12; } },
  ]);
  panel.section('Camera');
  panel.buttons([
    { label: 'Dive', primary: true, isOn: () => state.diving, onClick: () => dive(!state.diving) },
    { label: 'Wet lens', isOn: () => engine.lens.enabled, onClick: () => { engine.lens.enabled = !engine.lens.enabled; } },
  ]);
  panel.slider('God rays', 0, 2, 0.01, () => underwater.params.rays, (v) => { underwater.params.rays = v; });
  panel.note('Drag to orbit · scroll to zoom. Dive, then drag down to look up at Snell’s window.');

  rescue = engine.add(new CoastRescue(engine,fx,ocean,(x,z)=>bathymetry.heightAt(x,z),panel,beaver.position));
  return {
    hud: () => [
      `sea   <b>Hs ${ocean.significantHeight.toFixed(2)} m</b>  depth ${Math.min(999, ocean.depthAt(beaver.position.x, beaver.position.z)).toFixed(1)} m`,
      `plane <b>${(beaver.speed * 1.944).toFixed(0)} kt</b>  afloat ${(beaver.buoyancy.state.submersion * 100).toFixed(0)} %`,
      ocean.tsunami.active ? `wave  <b>${(ocean.tsunami.profile.height * ocean.tsunami.amplitude).toFixed(0)} m</b> @ ${ocean.tsunami.profile.speed.toFixed(0)} m/s` : 'wave  –',
      underwater.depth > -0.75 ? `eye   <b>${underwater.depth > 0 ? `${underwater.depth.toFixed(1)} m under` : 'at the waterline'}</b>` : 'eye   above water',
    ],
    debug: { weather, ocean, beaver, rescue, fx, bathymetry, scenery, launch, applySea, orbit, underwater, dive },
    dispose() { orbit.dispose(); beaver.dispose(); bathymetry.dispose(); scenery.dispose(); },
  };
}

export const lagoonScene: ShowcaseScene = {
  id: 'lagoon', label: 'Lagoon → Tsunami', title: 'Lagoon → ocean → tsunami', description: '',
  create: (ctx) => createCoast(ctx, false),
};

export const landfallScene: ShowcaseScene = {
  id: 'landfall', label: 'Tsunami Landfall', title: 'Tsunami landfall', description: '',
  create: (ctx) => createCoast(ctx, true),
};
