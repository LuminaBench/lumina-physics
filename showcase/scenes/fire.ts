/** Scene 4 – Adaptive explosions & fire lab. */
import * as THREE from 'three/webgpu';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { Ocean } from '../../modules/water/ocean';
import { OCEAN_PRESETS } from '../../modules/water/spectrum';
import { BuoyantBody } from '../../modules/water/buoyancy';
import { Explosions, EXPLOSION_KINDS, type ExplosionKind } from '../../modules/fire/explosions';
import { ThermoField, type ThermalBody } from '../../modules/thermo';
import { DestructionSystem, type Destructible } from '../../modules/destruction';
import { TSL } from '../../engine/tsl';
import { createConcreteMaterial, createTimberMaterial } from '../../modules/materials';
import { mulberry32 } from '../../engine/noise';
import { FollowOrbit } from '../camera';
import { makeDockCargo } from '../scenery/cargo';
import {
  SceneryRegistry,
  buildBuoy,
  buildCoastalCanopy,
  buildDistantVessels,
  buildHeadlands,
  buildLighthouse,
  buildRockClusters,
  createRockMaterial,
  createTerrainMaterial,
  dressPier,
  scatterOnTerrain,
  type RockPlacement,
} from '../scenery';
import type { SceneContext, SceneHandle, ShowcaseScene } from './types';

const PIER_TOP = 1.0;

export const fireScene: ShowcaseScene = {
  id: 'fire', label: 'Explosions Lab', title: 'Adaptive explosions & fire lab', description: '',
  async create(ctx: SceneContext): Promise<SceneHandle> {
    const { engine, panel, canvas } = ctx;
    const { camera, scene, physics } = engine;
    camera.near = 0.3; camera.far = 60000; camera.fov = 51; camera.updateProjectionMatrix();

    // Capture the pier from open water. Only opaque waterfront geometry enters the probe.
    const weather = engine.add(new Weather(engine, { localProbe: {
      center: new THREE.Vector3(0, 1.4, 14), halfSize: new THREE.Vector3(36, 14, 32),
      layer: 24, resolution: 64, refreshSeconds: 0.8,
    } }));
    Object.assign(weather.params, WEATHER_PRESETS.goldenHour, { sunElevation: 7, sunAzimuth: 205, coverage: 0.52, exposure: 1.15 });
    const ocean = engine.add(new Ocean(engine, { weather }));
    ocean.setSeaStates(OCEAN_PRESETS.breeze, OCEAN_PRESETS.swell);
    ocean.morph = 0.05;
    ocean.optics.clarity = 0.7;
    engine.wind.set(0.5, 4.5, 0.3);
    const fx = engine.add(new EffectsKit(engine));
    fx.sparks.uniforms.floorY.value = PIER_TOP;
    const explosions = engine.add(new Explosions(engine, fx, ocean));
    explosions.groundY = PIER_TOP;

    // Heat field over the pier: petrol leaves a burning film, crates catch fire, drums glow,
    // geysers put it all out in a cloud of steam; every blast scorches the concrete.
    const thermo = engine.add(new ThermoField(engine, fx, { center: new THREE.Vector2(0, 0), size: 46, resolution: 96, surfaceY: PIER_TOP + 0.02, weather, ocean }));
    const destruction = engine.add(new DestructionSystem(engine, fx, { ocean }));

    // Concrete pier.
    const R = physics.RAPIER;
    const pierSize = new THREE.Vector3(44, 3.2, 24);
    const pierMaterial = createConcreteMaterial({ thermo, wetness: 0.24, roughness: 0.84 });
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierSize.x, pierSize.y, pierSize.z), pierMaterial);
    pier.position.set(0, PIER_TOP - pierSize.y / 2, 0);
    pier.receiveShadow = true; pier.castShadow = true;
    pier.layers.enable(24);
    scene.add(pier);
    const pierBody = physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, PIER_TOP - pierSize.y / 2, 0));
    physics.world.createCollider(R.ColliderDesc.cuboid(pierSize.x / 2, pierSize.y / 2, pierSize.z / 2).setFriction(0.9), pierBody);

    // ---- Seaside port pier dressing & golden-hour harbor backdrop -------------------
    const scenery = new SceneryRegistry('fire-scenery', engine.world);
    scene.add(scenery.group);
    const dressing = dressPier(scenery, weather, {
      centerX: 0,
      centerZ: 0,
      width: pierSize.x,
      length: pierSize.z,
      deckY: PIER_TOP,
      slabThickness: pierSize.y,
      openPilings: false,
      baySpacing: 5.5,
      waterEdges: ['north', 'south', 'east', 'west'],
      // Keep foreground +Z and east water-blast side open; frame back edges with restrained port railings.
      railings: [
        { x0: -21.4, z0: -11.55, x1: -11.0, z1: -11.55 },
        { x0: 11.0, z0: -11.55, x1: 21.4, z1: -11.55 },
        { x0: -21.55, z0: -11.4, x1: -21.55, z1: 4.5 },
      ],
      bollardExclusions: [
        { x: -1.5, z: -5.5, radius: 4.5 },
        { x: 8.5, z: 5.2, radius: 4.0 },
        { x: -19.5, z: -9.8, radius: 3.5 },
        { x: 20.2, z: -10.4, radius: 2.5 },
      ],
      lampPosts: [
        { x: -20.2, z: -10.6, yaw: 0.45 },
        { x: 20.2, z: -10.6, yaw: -0.45 },
      ],
      davit: { x: -18.8, z: -9.2, yaw: 0.65 },
      lifeRings: [
        { x: 20.5, z: 10.6, yaw: Math.PI * 0.75 },
      ],
    });

    dressing.traverse(object => { if (object instanceof THREE.Mesh) object.layers.enable(24); });

    // Golden-hour coastal harbor bay headlands, rocky breakwater lighthouse & anchored freighter
    const coastMat = createTerrainMaterial(scenery, weather, {
      terrainShadows: true,
      palette: 'golden',
      rockiness: 0.28,
      mistStart: 280,
      mistRange: 2500,
      mistMax: 0.72,
      mistHeight: 240,
    });
    const rockMat = createRockMaterial(scenery, weather, 'golden', { mistStart: 220, mistRange: 2200, mistMax: 0.64 });

    const harborCoast = buildHeadlands(
      scenery,
      [
        // Mid-ground breakwater headland framing the harbor mouth to the left of the blast plume
        { x: -175, z: -195, radiusX: 115, radiusZ: 82, height: 24, rotation: 0.45, segments: 48, cragginess: 0.62, seed: 911 },
        { x: 355, z: -520, radiusX: 330, radiusZ: 210, height: 82, rotation: -0.22, segments: 52, cragginess: 0.66, seed: 929 },
        { x: -390, z: -580, radiusX: 340, radiusZ: 220, height: 96, rotation: 0.3, segments: 52, cragginess: 0.70, seed: 947 },
        // Sweeping far golden-hour coastal ridges fading into warm evening mist
        { x: 1100, z: -1350, radiusX: 880, radiusZ: 440, height: 210, rotation: 0.14, segments: 42, cragginess: 0.72, seed: 967 },
        { x: -680, z: -1620, radiusX: 980, radiusZ: 460, height: 250, rotation: -0.16, segments: 42, cragginess: 0.74, seed: 983 },
        { x: 140, z: -1860, radiusX: 900, radiusZ: 440, height: 225, rotation: 0.05, segments: 40, cragginess: 0.70, seed: 997 },
      ],
      coastMat,
      { name: 'fire-harbor-headlands', woodland: 'evergreen', castShadow: false, receiveShadow: true },
    );

    // Harbor entrance lighthouse perched cleanly on the breakwater headland point (visible left of plume)
    const lhX = -112, lhZ = -152;
    buildLighthouse(scenery, weather, { x: lhX, y: Math.max(5.5, harborCoast.heightAt(lhX, lhZ)), z: lhZ, scale: 0.95, beaconIntensity: 52 });

    // Dense overlapping coastal cypress copses & dark hillside scrub crowning the mid-ground harbor hills
    const harborPines = [
      ...scatterOnTerrain({
        bounds: { minX: 90, maxX: 600, minZ: -680, maxZ: -340 },
        count: 95,
        heightAt: harborCoast.heightAt,
        slopeAt: harborCoast.slopeAt,
        minHeight: 4.5,
        maxHeight: 68,
        minSlope: 0.56,
        minSpacing: 11,
        scaleRange: [1.6, 3.1],
        clusterFreq: 0.018,
        clusterThreshold: -0.16,
        seed: 1009,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -660, maxX: -120, minZ: -760, maxZ: -380 },
        count: 85,
        heightAt: harborCoast.heightAt,
        slopeAt: harborCoast.slopeAt,
        minHeight: 4.5,
        maxHeight: 80,
        minSlope: 0.56,
        minSpacing: 12,
        scaleRange: [1.7, 3.3],
        clusterFreq: 0.018,
        clusterThreshold: -0.16,
        seed: 1021,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -270, maxX: -125, minZ: -265, maxZ: -135 },
        count: 26,
        heightAt: harborCoast.heightAt,
        slopeAt: harborCoast.slopeAt,
        minHeight: 4.5,
        maxHeight: 24,
        minSlope: 0.58,
        minSpacing: 8,
        scaleRange: [1.0, 1.85],
        exclude: (x, z) => Math.hypot(x - lhX, z - lhZ) < 18,
        clusterFreq: 0.03,
        clusterThreshold: -0.18,
        seed: 1033,
      }),
    ];
    buildCoastalCanopy(scenery, harborPines, 'pine', { name: 'fire-harbor-pines', castShadow: false, seed: 1031 });

    // Riprap breakwater boulders extending from the lighthouse spit
    const rRand = mulberry32(1049);
    const breakwaterRocks: RockPlacement[] = [];
    for (let i = 0; i < 32; i++) {
      const t = i / 31;
      const rx = THREE.MathUtils.lerp(-185, -78, t) + (rRand() - 0.5) * 14;
      const rz = THREE.MathUtils.lerp(-190, -108, t) + (rRand() - 0.5) * 12;
      breakwaterRocks.push({
        x: rx, y: -0.6 + rRand() * 2.4, z: rz,
        scaleX: 2.2 + rRand() * 4.2,
        scaleY: 1.4 + rRand() * 2.8,
        scaleZ: 2.2 + rRand() * 4.0,
        rotY: rRand() * Math.PI * 2,
        variant: i % 3,
      });
    }
    buildRockClusters(scenery, breakwaterRocks, rockMat, { name: 'fire-breakwater-rocks', castShadow: false, receiveShadow: true, seed: 1061 });

    // Anchored freighter in the outer channel (far clear of water-geyser zone at x=30..36) + harbor buoy
    buildDistantVessels(scenery, weather, [
      { x: 255, z: -295, yaw: 0.28, kind: 'freighter', scale: 0.92 },
    ]);
    const channelBuoy = buildBuoy(scenery, { x: 64, z: -48, kind: 'channel', color: 0xb92c22, beacon: [34, 14, 4] });

    // Timber cladding rises from the pier. Its char and emissive cracks use the same vertical heat grid as the flames.
    const wallPosition = new THREE.Vector3(-7, PIER_TOP + 1.55, -2);
    const wallHeat = thermo.addWall({ position: wallPosition, width: 3.5, height: 3.1, fuel: 2.5, resolution: 20 });
    const siding = createTimberMaterial({ thermalSurface: wallHeat });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3.5, 3.1, 0.22), siding);
    wall.position.copy(wallPosition);
    wall.castShadow = wall.receiveShadow = true;
    scene.add(wall);
    const wallFoot = wallPosition.clone().setY(PIER_TOP + 0.18);
    // Physics props: crates and fuel drums.
    const { crateGeometry: crateGeo, drumGeometry: drumGeo, crate: crateMat, drum: drumMat } = makeDockCargo();
    type Prop = { mesh: THREE.Mesh; body: import('@dimforge/rapier3d-compat').RigidBody; float: BuoyantBody; heat: ThermalBody };
    let props: Prop[] = [];
    let barriers: Destructible[] = [];
    const spawnProps = () => {
      for (const p of props) { p.float.dispose(); physics.removeBody(p.body); p.mesh.removeFromParent(); thermo.removeBody(p.heat); (p.mesh.material as THREE.Material).dispose(); }
      props = [];
      thermo.reset();
      // Blast walls: a concrete barrier and a brick stub to break.
      for (const b of barriers) destruction.remove(b);
      barriers = [
        destruction.add({ material: 'concrete', size: new THREE.Vector3(3.6, 1.5, 0.4), position: new THREE.Vector3(-1.5, PIER_TOP + 0.75, -5.5), pieces: 26, seed: 4 }),
        destruction.add({ material: 'brick', size: new THREE.Vector3(2.64, 1.4, 0.22), position: new THREE.Vector3(8.5, PIER_TOP + 0.7, 5.2), seed: 8 }),
      ];
      const add = (mesh: THREE.Mesh, x: number, y: number, z: number, drum: boolean) => {
        mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
        const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.05).setAngularDamping(0.3));
        physics.world.createCollider((drum ? R.ColliderDesc.cylinder(0.45, 0.3) : R.ColliderDesc.cuboid(0.45, 0.45, 0.45)).setMass(drum ? 55 : 28).setFriction(0.7).setRestitution(0.15), body);
        physics.bind(body, mesh);
        const float = new BuoyantBody(physics, ocean, body, { points: [new THREE.Vector3()], volume: drum ? 0.2 : 0.55, draft: 0.8, linearDrag: 140, quadraticDrag: 60, heaveDamping: 1, keel: 1 });
        // Each prop owns its material so it can char or glow on its own.
        const material = (mesh.material as THREE.MeshStandardMaterial).clone();
        mesh.material = material;
        const heat = thermo.addBody({ object: mesh, kind: drum ? 'metal' : 'wood', radius: drum ? 0.4 : 0.6, height: 0.9, material, burnTime: 20 });
        props.push({ mesh, body, float, heat });
      };
      for (let level = 0; level < 3; level++) for (let i = 0; i < 4 - level; i++) for (let j = 0; j < 3 - Math.min(level, 2); j++) {
        add(new THREE.Mesh(crateGeo, crateMat), 4.5 + i * 0.95 + level * 0.45, PIER_TOP + 0.46 + level * 0.92, -1.2 + j * 0.95 + level * 0.3, false);
      }
      for (let i = 0; i < 8; i++) add(new THREE.Mesh(drumGeo, drumMat), -5 + (i % 4) * 0.72, PIER_TOP + 0.46, 2.6 + Math.floor(i / 4) * 0.72, true);
    };
    spawnProps();

    const orbit = new FollowOrbit(camera, canvas, new THREE.Vector3(2, 6.3, 1), new THREE.Vector3(-25, 6.4, 36));
    orbit.controls.minDistance = 8;
    orbit.controls.maxDistance = 260;
    orbit.floor = (x, z) => (Math.abs(x) < 22 && Math.abs(z) < 12 ? PIER_TOP : ocean.heightAt(x, z));

    const state = { yield: 1, overWater: false, auto: false, timer: 2.5, cycle: 0, fire: 0, slowMo: false };
    const kinds = EXPLOSION_KINDS;
    const detonate = (kind: ExplosionKind) => {
      const onWater = kind === 'water' || state.overWater;
      const position = onWater ? new THREE.Vector3(30 + Math.random() * 6, 0.5, 2 + Math.random() * 10) : new THREE.Vector3(Math.random() * 3 - 0.5, PIER_TOP + 0.1, Math.random() * 3 - 0.5);
      explosions.detonate({ kind, position, yield: state.yield, surface: onWater ? 'water' : 'ground' });
    };

    let sprayWetness = 0;
    const stopSplash = engine.events.on('splash', ({ position, intensity }) => {
      if (position && Math.abs(position[0]) < 24 && Math.abs(position[2]) < 15) sprayWetness = Math.min(1, sprayWetness + intensity * 0.3);
    });
    engine.onUpdate = (dt) => {
      sprayWetness = Math.max(0, sprayWetness - dt * 0.032);
      pierMaterial.uniforms.rain.value = weather.params.rain;
      pierMaterial.uniforms.wetness.value = Math.max(0.24, weather.params.rain, sprayWetness);
      ocean.updateField(dt, { x: 18, z: 4 });
      weather.shadowFocus.set(0, 1, 0);
      channelBuoy.followSurface(ocean,camera.position,dt,0.1);
      if (state.auto) {
        state.timer -= dt;
        if (state.timer <= 0) { detonate(kinds[state.cycle++ % kinds.length]); state.timer = 6.5; }
      }
    };

    engine.onBeforeRender = (dt) => orbit.update(dt);

    panel.header('Explosions & fire lab', 'Trigger each effect over the pier or water. Slow motion reveals the ignition, spray, debris and smoke stages.');
    panel.section('Detonate');
    panel.buttons([
      { label: 'Petrol fireball', primary: true, onClick: () => detonate('petrol') },
      { label: 'C4 shockwave', primary: true, onClick: () => detonate('c4') },
      { label: 'Water geyser', primary: true, onClick: () => detonate('water') },
      { label: 'Electrical arc', primary: true, onClick: () => detonate('electrical') },
      { label: 'Vapour ignition', onClick: () => detonate('thermobaric') },
      { label: 'Incendiary trails', onClick: () => detonate('incendiary') },
      { label: 'Airburst', onClick: () => detonate('airburst') },
      { label: 'Volcanic burst', onClick: () => detonate('magma') },
    ]);
    panel.slider('Yield', 0.4, 2.5, 0.05, () => state.yield, (v) => { state.yield = v; }, (v) => `×${v.toFixed(2)}`);
    panel.buttons([
      { label: 'Over water', isOn: () => state.overWater, onClick: () => { state.overWater = !state.overWater; } },
      { label: 'Auto demo', isOn: () => state.auto, onClick: () => { state.auto = !state.auto; state.timer = 0.4; } },
      { label: 'Slow-mo', isOn: () => state.slowMo, onClick: () => { state.slowMo = !state.slowMo; engine.timeScale = state.slowMo ? 0.2 : 1; } },
    ]);
    panel.section('Sustained fire');
    panel.buttons([
      { label: 'Fuel fire', isOn: () => state.fire !== 0, onClick: () => { if (state.fire) { explosions.extinguish(state.fire); state.fire = 0; } else state.fire = explosions.ignite(new THREE.Vector3(-4, PIER_TOP, 3), 1.3, 600); } },
      { label: 'Ignite cladding', onClick: () => thermo.ignite3D(wallFoot, 0.75) },
      { label: 'Reset props', onClick: spawnProps },
    ]);
    panel.section('Environment');
    panel.slider('Wind', 0, 22, 0.5, () => engine.wind.speed, (v) => { ocean.params.windSpeed = v; ocean.targetParams.windSpeed = v; }, (v) => `${v.toFixed(0)} m/s`);
    panel.slider('Sun elevation', 2, 60, 1, () => weather.params.sunElevation, (v) => { weather.params.sunElevation = v; weather.params.exposure = THREE.MathUtils.lerp(1.2, 0.66, THREE.MathUtils.smoothstep(v, 4, 40)); }, (v) => `${v.toFixed(0)}°`);

    return {
      hud: () => [
        `blasts <b>${explosions.count}</b>   debris ${explosions.debris.mesh.count}   chunks ${destruction.liveChunks}`,
        `heat   ${thermo.stats.burningCells} cells burning  ${props.filter((p) => p.heat.burning).length} props alight`,
        `props  ${props.length}   time ×${engine.timeScale.toFixed(2)}`,
      ],
      debug: { weather, ocean, fx, explosions, wallHeat, detonate, state, thermo, destruction, scenery, get props() { return props; } },
      dispose() { stopSplash(); pierMaterial.dispose(); orbit.dispose(); for (const p of props) { p.float.dispose(); (p.mesh.material as THREE.Material).dispose(); } wall.geometry.dispose(); siding.dispose(); crateGeo.dispose(); drumGeo.dispose(); crateMat.dispose(); drumMat.dispose(); pier.geometry.dispose(); scenery.dispose(); },
    };
  },
};
