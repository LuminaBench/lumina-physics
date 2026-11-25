import { createConcreteMaterial } from '../../modules/materials/concrete';
import { RescueHelicopter } from '../actors/rescue-helicopter';
import { RotorWash } from '../../modules/aero/rotor-wash';
/**
 * Scene 7 – Physics playground: destruction, cloth, thermo, deformable ground, diving.
 *
 * A concrete pier runs from a sand yard out over a shallow bay. Everything on it shares the
 * same wind, water, heat and rigid-body state as the rest of the engine.
 */
import * as THREE from 'three/webgpu';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { Rain } from '../../modules/weather/rain';
import { Ocean } from '../../modules/water/ocean';
import { OCEAN_PRESETS } from '../../modules/water/spectrum';
import { Bathymetry } from '../../modules/water/seabed';
import { Underwater } from '../../modules/water/underwater';
import { Explosions } from '../../modules/fire/explosions';
import { ClothSystem } from '../../modules/cloth';
import { DestructionSystem, type Destructible } from '../../modules/destruction';
import { ThermoField } from '../../modules/thermo';
import { DeformableGround, type GroundKind } from '../../modules/surface-deform';
import { AquaplaningVehicle } from '../../modules/wet-road/vehicle';
import { ChassisAnimator } from '../../modules/animation';
import { createSportsCoupe } from '../../test-rigs';
import { TSL } from '../../engine/tsl';
import { valueNoise2, mulberry32 } from '../../engine/noise';
import { FollowOrbit } from '../camera';
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

/** Top of the pier deck and of the yard (m above mean sea level). */
export const DECK = 1.4;
/** The yard (deformable ground) is the land side: z > YARD_Z. */
const YARD_Z = 16;

/** Sand shelf: a yard above water on +Z, a bay 3–7 m deep under and beyond the pier. */
function bayFloor(x: number, z: number): number {
  const ss = THREE.MathUtils.smoothstep;
  const ripples = 0.12 * Math.sin(x * 0.9 + Math.sin(z * 0.4) * 1.3) + 0.08 * Math.sin(z * 1.3 + x * 0.21);
  // The yard itself is a deformable layer; the terrain under it sits lower so ruts never poke through.
  const shore = THREE.MathUtils.lerp(DECK - 0.4, -3.2, ss(-z, -YARD_Z + 1, -YARD_Z + 22));
  const deep = -3.2 - 4.2 * ss(-z, 6, 70) - 30 * ss(Math.hypot(x, z), 150, 420);
  return (z > YARD_Z - 21 ? shore : deep) + ripples * ss(-z, -YARD_Z + 4, -YARD_Z + 14);
}

export const playgroundScene: ShowcaseScene = {
  id: 'playground', label: 'Physics Playground', title: 'Physics playground', description: '',
  async create(ctx: SceneContext): Promise<SceneHandle> {
    const { engine, panel, canvas } = ctx;
    const { camera, scene, physics } = engine;
    camera.near = 0.25; camera.far = 40000; camera.fov = 50; camera.updateProjectionMatrix();

    const weather = engine.add(new Weather(engine));
    Object.assign(weather.params, WEATHER_PRESETS.tropical, { sunElevation: 34, sunAzimuth: 215, coverage: 0.5, turbidity: 2.8, exposure: 0.62, shafts: 0.5 });
    weather.shadowExtent = 46;
    const bathymetry = new Bathymetry({ size: 900, center: new THREE.Vector2(0, -40), height: bayFloor, segments: 220 }, { cloudShadow: (p) => weather.cloudShadow(p) });
    scene.add(bathymetry.mesh);
    const ocean = engine.add(new Ocean(engine, { weather, bathymetry }));
    ocean.setSeaStates(OCEAN_PRESETS.breeze, OCEAN_PRESETS.swell);
    ocean.morph = 0.08;
    ocean.optics.clarity = 0.86;
    ocean.optics.breakerHeight = 0.2;
    weather.groundColor.setRGB(0.05, 0.12, 0.13);
    const state = { wind: 9, windDirection: 0.35, rain: 0, diving: false };
    const windAt = new THREE.Vector3();
    ocean.params.windSpeed = ocean.targetParams.windSpeed = state.wind;
    ocean.params.windDirection = ocean.targetParams.windDirection = state.windDirection;
    engine.wind.set(state.windDirection, state.wind, 0.5);
    const fx = engine.add(new EffectsKit(engine));
    fx.setFloor(DECK);
    const rain = engine.add(new Rain(engine, weather));
    const explosions = engine.add(new Explosions(engine, fx, ocean));
    explosions.groundY = DECK;
    const underwater = engine.add(new Underwater(engine, ocean));

    // ---- pier ---------------------------------------------------------------------
    const R = physics.RAPIER;
    const concrete = createConcreteMaterial({color:0xa49f90, wetness:0, roughness:0.86, slabSize:3.65, bumpScale:0.015});
    const uDeckWet=concrete.uniforms.wetness;
    const p=TSL.positionWorld;
    const tide=TSL.float(1).sub(TSL.smoothstep(-0.22,0.46,p.y.add(valueNoise2(p.xz.mul(1.7)).mul(0.23))));
    const aggregateColor=concrete.colorNode!;
    concrete.colorNode=TSL.mix(aggregateColor,aggregateColor.mul(TSL.vec3(0.39,0.46,0.34)),tide);
    const pierSize = new THREE.Vector3(15, 0.9, 62);
    const pierCentre = new THREE.Vector3(0, DECK - pierSize.y / 2, YARD_Z - pierSize.z / 2 + 6);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierSize.x, pierSize.y, pierSize.z), concrete);
    pier.position.copy(pierCentre);
    pier.castShadow = pier.receiveShadow = true;
    scene.add(pier);
    physics.world.createCollider(R.ColliderDesc.cuboid(pierSize.x / 2, pierSize.y / 2, pierSize.z / 2).setFriction(0.9),
      physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pierCentre.x, pierCentre.y, pierCentre.z)));
    // Piles under the deck (one instanced mesh).
    const pileGeometry = new THREE.CylinderGeometry(0.42, 0.46, 9, 12).translate(0, -4.5, 0);
    const piles = new THREE.InstancedMesh(pileGeometry, concrete, 18);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 18; i++) piles.setMatrixAt(i, m.makeTranslation((i % 2 ? 1 : -1) * 6.2, DECK - pierSize.y, YARD_Z + 2 - Math.floor(i / 2) * 7));
    piles.castShadow = true;
    scene.add(piles);
    // The yard: a physics floor under the sand (the visible ground is the bathymetry mesh).
    physics.world.createCollider(R.ColliderDesc.cuboid(120, 1, 60).setFriction(1),
      physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, DECK - 1, YARD_Z + 60)));

    // ---- Working harbor pier dressing, armored shoreline & embracing coastal bay -----
    const scenery = new SceneryRegistry('playground-scenery', engine.world);
    scene.add(scenery.group);

    // Dress the bare concrete slab with coping curbs, pile caps, stringers, tidal collars,
    // diagonal cross-bracing, timber/rubber marine fenders, bollards and restrained railings.
    dressPier(scenery, weather, {
      centerX: pierCentre.x,
      centerZ: pierCentre.z,
      width: pierSize.x,
      length: pierSize.z,
      deckY: DECK,
      slabThickness: pierSize.y,
      openPilings: true,
      baySpacing: 7.0,
      waterEdges: ['north', 'east', 'west'],
      // Restrained railings at shore approach & seaward tip (middle & foreground west edge stay open).
      railings: [
        { x0: 7.22, z0: 13.5, x1: 7.22, z1: 21.4 },
        { x0: -7.22, z0: -39.65, x1: -2.2, z1: -39.65 },
        { x0: 2.2, z0: -39.65, x1: 7.22, z1: -39.65 },
      ],
      bollardExclusions: [
        { x: -6.6, z: 8, radius: 2.0 },
        { x: -6.6, z: -4, radius: 2.0 },
        { x: -6.6, z: -16, radius: 2.0 },
        { x: 6.6, z: -28, radius: 2.0 },
        { x: 7.1, z: -20, radius: 2.0 },
      ],
      // Exact bollard anchor for the sagging mooring rope at (7.2, DECK+0.6, -20)
      extraBollards: [{ x: 6.95, z: -20.0 }],
      lampPosts: [
        { x: -6.65, z: 16.2, yaw: Math.PI / 2 },
        { x: 6.65, z: 16.2, yaw: -Math.PI / 2 },
      ],
      lifeRings: [
        { x: 6.85, z: -11.5, yaw: -Math.PI / 2 },
      ],
    });

    // Real steel mooring buoy at (15, 0.4, -24) anchoring the sagging mooring rope + bay channel buoy
    const mooringBuoy = buildBuoy(scenery, { x: 15, z: -24, kind: 'mooring', color: 0xc23824 });
    const bayBuoy = buildBuoy(scenery, { x: 46, z: -96, kind: 'channel', color: 0xbd2c22, beacon: [26, 11, 4] });

    // Temperate bay headlands, lighthouse point & distant coastal mountain silhouettes
    const bayCoastMat = createTerrainMaterial(scenery, weather, {
      terrainShadows: true,
      palette: 'temperate',
      mistStart: 320,
      mistRange: 2700,
      mistMax: 0.72,
      mistHeight: 240,
    });
    const bayRockMat = createRockMaterial(scenery, weather, 'temperate', { mistStart: 240, mistRange: 2400, mistMax: 0.62 });

    const bayHeadlands = buildHeadlands(
      scenery,
      [
        // Lush bay headland arms embracing the harbor mouth (visible straight ahead & right of the pier)
        { x: 285, z: -215, radiusX: 175, radiusZ: 125, height: 58, rotation: -0.38, segments: 48, cragginess: 0.58, seed: 1213 },
        { x: -320, z: -275, radiusX: 205, radiusZ: 145, height: 72, rotation: 0.34, segments: 48, cragginess: 0.62, seed: 1231 },
        // Coastal hills behind the shore flanks (outside the driving yard)
        { x: 225, z: 115, radiusX: 145, radiusZ: 115, height: 42, rotation: 0.22, segments: 40, cragginess: 0.48, seed: 1249 },
        { x: -235, z: 125, radiusX: 150, radiusZ: 118, height: 46, rotation: -0.26, segments: 40, cragginess: 0.48, seed: 1277 },
        // Distant misty coastal mountain silhouettes across the northern horizon
        { x: -680, z: -1260, radiusX: 680, radiusZ: 340, height: 195, rotation: 0.14, segments: 40, cragginess: 0.7, seed: 1291 },
        { x: 210, z: -1420, radiusX: 740, radiusZ: 360, height: 215, rotation: -0.1, segments: 40, cragginess: 0.72, seed: 1303 },
        { x: 1040, z: -1180, radiusX: 640, radiusZ: 320, height: 175, rotation: 0.22, segments: 38, cragginess: 0.68, seed: 1319 },
      ],
      bayCoastMat,
      { name: 'playground-bay-headlands', woodland: 'evergreen', castShadow: false, receiveShadow: true },
    );

    // Picturesque harbor lighthouse on the eastern bay promontory
    const plhX = 186, plhZ = -178;
    buildLighthouse(scenery, weather, { x: plhX, y: Math.max(5.5, bayHeadlands.heightAt(plhX, plhZ)), z: plhZ, scale: 0.85, beaconIntensity: 30 });

    // Sculpted shoreline riprap armor boulders on both sides of the pier root (replaces bare flat beach edge)
    const pRand = mulberry32(1327);
    const shoreRocks: RockPlacement[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 24; i++) {
        const t = i / 23;
        const rx = side * (9.5 + t * 72 + (pRand() - 0.5) * 3.5);
        const rz = YARD_Z - 3.5 + Math.sin(t * 4.2) * 3.2 + (pRand() - 0.5) * 4.2;
        const ry = Math.max(-0.4, bayFloor(rx, rz));
        shoreRocks.push({
          x: rx, y: ry - 0.15, z: rz,
          scaleX: 1.2 + pRand() * 2.5,
          scaleY: 0.7 + pRand() * 1.4,
          scaleZ: 1.1 + pRand() * 2.3,
          rotY: pRand() * Math.PI * 2,
          tiltX: (pRand() - 0.5) * 0.2,
          tiltZ: (pRand() - 0.5) * 0.2,
          variant: i % 3,
        });
      }
    }
    // Sea-stack rocks off the lighthouse promontory
    for (let i = 0; i < 10; i++) {
      const a = pRand() * Math.PI * 2;
      const dist = 12 + pRand() * 44;
      const s = 2.8 + pRand() * 5.2;
      shoreRocks.push({
        x: 158 + Math.cos(a) * dist,
        y: -0.8 + s * 0.28,
        z: -158 + Math.sin(a) * dist,
        scaleX: s * (0.85 + pRand() * 0.45),
        scaleY: s * (0.6 + pRand() * 0.75),
        scaleZ: s * (0.85 + pRand() * 0.45),
        rotY: pRand() * Math.PI * 2,
        variant: i % 3,
      });
    }
    buildRockClusters(scenery, shoreRocks, bayRockMat, { name: 'playground-shore-rocks', castShadow: false, receiveShadow: true, seed: 1361 });

    // Shore pines and dune scrub grow outside the driving yard and across the bay headlands.
    const yardAndBayHeight = (x: number, z: number) => Math.max(z > YARD_Z + 1 ? DECK : bayFloor(x, z), bayHeadlands.heightAt(x, z));
    const excludeYard = (x: number, z: number) => Math.abs(x) < 25 && z > YARD_Z - 6 && z < YARD_Z + 76;

    const shorePines = [
      ...scatterOnTerrain({
        bounds: { minX: 25, maxX: 118, minZ: YARD_Z + 1, maxZ: YARD_Z + 78 },
        count: 26,
        heightAt: yardAndBayHeight,
        minHeight: 1.0,
        maxHeight: 28,
        minSpacing: 7.5,
        scaleRange: [0.85, 1.35],
        leanMax: 0.16,
        exclude: excludeYard,
        clusterFreq: 0.045,
        clusterThreshold: -0.14,
        seed: 1373,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -118, maxX: -25, minZ: YARD_Z + 1, maxZ: YARD_Z + 78 },
        count: 24,
        heightAt: yardAndBayHeight,
        minHeight: 1.0,
        maxHeight: 28,
        minSpacing: 7.5,
        scaleRange: [0.85, 1.35],
        leanMax: 0.16,
        exclude: excludeYard,
        clusterFreq: 0.045,
        clusterThreshold: -0.14,
        seed: 1381,
      }),
      ...scatterOnTerrain({
        bounds: { minX: 140, maxX: 430, minZ: -330, maxZ: -105 },
        count: 30,
        heightAt: bayHeadlands.heightAt,
        slopeAt: bayHeadlands.slopeAt,
        minHeight: 2.5,
        maxHeight: 28,
        minSlope: 0.65,
        minSpacing: 13,
        scaleRange: [1.0, 1.65],
        leanMax: 0.16,
        exclude: (x, z) => Math.hypot(x - plhX, z - plhZ) < 22,
        clusterFreq: 0.028,
        clusterThreshold: -0.06,
        seed: 1399,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -480, maxX: -145, minZ: -400, maxZ: -145 },
        count: 28,
        heightAt: bayHeadlands.heightAt,
        slopeAt: bayHeadlands.slopeAt,
        minHeight: 2.5,
        maxHeight: 32,
        minSlope: 0.65,
        minSpacing: 14,
        scaleRange: [1.0, 1.7],
        leanMax: 0.16,
        clusterFreq: 0.028,
        clusterThreshold: -0.06,
        seed: 1409,
      }),
    ];

    const bayCanopy = [
      ...scatterOnTerrain({
        bounds: { minX: 145, maxX: 430, minZ: -330, maxZ: -105 },
        count: 34,
        heightAt: bayHeadlands.heightAt,
        slopeAt: bayHeadlands.slopeAt,
        minHeight: 5,
        maxHeight: 54,
        minSlope: 0.62,
        minSpacing: 15,
        scaleRange: [1.9, 3.6],
        exclude: (x, z) => Math.hypot(x - plhX, z - plhZ) < 24,
        clusterFreq: 0.024,
        clusterThreshold: -0.1,
        seed: 1423,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -490, maxX: -150, minZ: -400, maxZ: -145 },
        count: 34,
        heightAt: bayHeadlands.heightAt,
        slopeAt: bayHeadlands.slopeAt,
        minHeight: 5,
        maxHeight: 68,
        minSlope: 0.62,
        minSpacing: 16,
        scaleRange: [2.0, 3.8],
        clusterFreq: 0.024,
        clusterThreshold: -0.1,
        seed: 1433,
      }),
    ];
    const pines = buildCoastalCanopy(scenery, shorePines.concat(bayCanopy), 'pine', { name: 'playground-shore-pines', castShadow: false, seed: 1447 });

    const duneScrub = [
      ...scatterOnTerrain({
        bounds: { minX: 24, maxX: 98, minZ: YARD_Z - 1, maxZ: YARD_Z + 48 },
        count: 34,
        heightAt: yardAndBayHeight,
        minHeight: 0.8,
        maxHeight: 16,
        minSpacing: 4.5,
        scaleRange: [0.85, 1.7],
        exclude: excludeYard,
        clusterFreq: 0.055,
        clusterThreshold: -0.14,
        seed: 1459,
      }),
      ...scatterOnTerrain({
        bounds: { minX: -98, maxX: -24, minZ: YARD_Z - 1, maxZ: YARD_Z + 48 },
        count: 26,
        heightAt: yardAndBayHeight,
        minHeight: 0.8,
        maxHeight: 16,
        minSpacing: 4.8,
        scaleRange: [0.85, 1.7],
        exclude: excludeYard,
        clusterFreq: 0.055,
        clusterThreshold: -0.14,
        seed: 1471,
      }),
    ];
    const scrub = buildCoastalCanopy(scenery, duneScrub, 'scrub', { name: 'playground-dune-scrub', castShadow: false, seed: 1483 });

    const snowfall = TSL.uniform(0);
    // Catch snow on exposed branch tips and upward-facing rock. The tide keeps
    // the beach line clear, and coverage thins beyond the local winter yard.
    const snowHeight = TSL.smoothstep(0.32, 1.75, TSL.positionWorld.y);
    const shoulder = TSL.smoothstep(0.24, 0.85, TSL.normalWorldGeometry.y);
    const snowRange = TSL.smoothstep(400, 140, TSL.positionWorld.xz.length());
    const snowLoad = snowfall.mul(snowHeight).mul(shoulder).mul(snowRange);
    for (const material of [bayCoastMat, bayRockMat]) {
      const previous = material.colorNode;
      material.colorNode = TSL.mix(previous, TSL.vec3(0.67, 0.73, 0.79), snowLoad.mul(0.88));
    }
    for (const canopy of [pines, scrub]) {
      if (!canopy) continue;
      const material = canopy.material as THREE.MeshPhysicalNodeMaterial;
      const pigment = TSL.materialColor;
      const needles = TSL.smoothstep(0.003, 0.037, pigment.g.sub(pigment.r));
      material.colorNode = TSL.vec4(TSL.mix(pigment.rgb, TSL.vec3(0.57, 0.65, 0.73), snowLoad.mul(needles)), pigment.a);
    }

    // Quiet moored sailboats out in the sheltered bay
    buildDistantVessels(scenery, weather, [
      { x: 92, z: -125, yaw: 0.55, kind: 'sailboat', scale: 1.05 },
      { x: -84, z: -158, yaw: -0.42, kind: 'sailboat', scale: 0.95 },
    ]);

    // ---- cloth: flags, banner, sail, power lines -----------------------------------
    // The fallback shares its CPU frame with the ocean FFT and the car. Size the
    // pier's fabric grids for the gameplay camera and retain all constraint sweeps.
    const cloth = engine.add(new ClothSystem(engine, engine.backend === 'webgl2' ? { detail: 0.48 } : {}));
    cloth.groundY = DECK;
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9cdd0, roughness: 0.35, metalness: 0.9 });
    const timber = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.85 });
    const poleSpecs: Array<{ x: number; z: number; height: number; radius: number; material: THREE.Material }> = [];
    const pole = (x: number, z: number, height: number, radius = 0.06, material: THREE.Material = steel) => { poleSpecs.push({ x, z, height, radius, material }); return new THREE.Vector3(x, DECK + height, z); };

    const flags = [
      cloth.flag({ origin: pole(-6.6, 8, 7), width: 2.6, height: 1.6, pattern: 'stripes', colors: [0xb8141f, 0xf2efe6] }),
      cloth.flag({ origin: pole(-6.6, -4, 7), width: 2.6, height: 1.6, pattern: 'cross', colors: [0x12356b, 0xf2c800, 0xf2efe6] }),
      cloth.flag({ origin: pole(-6.6, -16, 7), width: 2.6, height: 1.6, pattern: 'tricolor', colors: [0x1c7a3c, 0xf2efe6, 0xd0521b] }),
      cloth.flag({ origin: pole(6.6, -28, 5.2), width: 1.9, height: 1.0, pattern: 'checker', colors: [0x121214, 0xf4f4f0] }),
    ];
    const bannerLeft = pole(-4.2, 12.5, 4.2), bannerRight = pole(4.2, 12.5, 4.2);
    const banner = cloth.banner({ origin: bannerLeft.clone().lerp(bannerRight, 0.5), width: 8.2, height: 1.3, hang: 'corners', pattern: 'hazard', colors: [0xf2b705, 0x16161a] });
    // A square sail on a mast at the seaward end, sheeted loosely so it bellies.
    const mastTop = pole(0, -36, 9.5, 0.11, timber);
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5.4, 10).rotateZ(Math.PI / 2), timber);
    yard.position.copy(mastTop).setY(mastTop.y - 0.6);
    yard.castShadow = true;
    scene.add(yard);
    const sail = cloth.sail({ origin: yard.position.clone(), width: 5, height: 6.2, sheet: 0.3 });
    // Power lines along the shore road.
    const pylons = [-42, -14, 14, 42].map((x) => pole(x, YARD_Z + 50, 8.5, 0.14, timber));
    for (const top of pylons) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 2.1), timber);
      arm.position.copy(top).setY(top.y - 0.05);
      arm.castShadow = true;
      scene.add(arm);
    }
    cloth.powerLines({ poles: pylons, wires: 3, spread: 0.8, slack: 1.02, segments: 20 });
    // A mooring line sagging from the deck to a buoy.
    cloth.rope({ from: new THREE.Vector3(7.2, DECK + 0.6, -20), to: new THREE.Vector3(15, 0.4, -24), slack: 1.18, segments: 18, radius: 0.035 });
    // All poles share one instanced mesh per material.
    for (const material of [steel, timber]) {
      const list = poleSpecs.filter((p) => p.material === material);
      const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.15, 1, 10).translate(0, 0.5, 0), material, list.length);
      list.forEach((p, i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, DECK, p.z), new THREE.Quaternion(), new THREE.Vector3(p.radius, p.height, p.radius))));
      mesh.castShadow = true;
      scene.add(mesh);
      for (const p of list) cloth.colliders.length < 8 && p.radius > 0.1 && cloth.colliders.push({ center: new THREE.Vector3(p.x, DECK + p.height - 3, p.z), radius: p.radius + 0.05 });
    }

    // ---- destructible targets -------------------------------------------------------
    const destruction = engine.add(new DestructionSystem(engine, fx, { ocean }));
    let targets: Destructible[] = [];
    let chipIndex = 0;
    const buildTargets = () => {
      chipIndex = 0;
      for (const t of targets) destruction.remove(t);
      const at = (x: number, height: number, z: number) => new THREE.Vector3(x, DECK + height / 2, z);
      const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      targets = [
        destruction.add({ material: 'concrete', size: new THREE.Vector3(4.4, 2.6, 0.36), position: at(3.2, 2.6, -8), pieces: 34, seed: 5 }),
        destruction.add({ material: 'brick', size: new THREE.Vector3(3.96, 2.2, 0.22), position: at(-2.4, 2.2, -13) , seed: 9 }),
        destruction.add({ material: 'glass', size: new THREE.Vector3(2.2, 2.4, 0.014), position: at(-3.3, 2.4, -1.5), seed: 3 }),
        destruction.add({ material: 'glass', size: new THREE.Vector3(2.2, 2.4, 0.014), position: at(-1.0, 2.4, -1.5), seed: 4 }),
        destruction.add({ material: 'glass', size: new THREE.Vector3(2.2, 2.4, 0.014), position: at(1.3, 2.4, -1.5), seed: 6 }),
        // A timber fence: planks on edge, grain along their length.
        ...[0, 1, 2, 3, 4].map((i) => destruction.add({ material: 'wood', size: new THREE.Vector3(1.9, 0.26, 0.045), position: new THREE.Vector3(5.2, DECK + 0.16 + i * 0.3, -20.5), quaternion: quarter, pieces: 9, anchor: 'none', seed: 20 + i })),
      ];
    };
    buildTargets();
    // Fence posts hold the planks up until something breaks them.
    const fencePosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1.7, 0.12), timber, 2);
    [-21.55, -19.45].forEach((z, i) => fencePosts.setMatrixAt(i, m.makeTranslation(5.2, DECK + 0.85, z)));
    fencePosts.castShadow = true;
    scene.add(fencePosts);
    for (const z of [-21.55, -19.45]) physics.world.createCollider(R.ColliderDesc.cuboid(0.06, 0.85, 0.06), physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(5.2, DECK + 0.85, z)));

    /** Fire a heavy slug from the camera through the centre of the view. */
    const shoot = (energy = 9000) => {
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const hit = destruction.shoot(camera.position, direction, energy);
      engine.trauma.add(0.12);
      return hit;
    };
    const blastAt = (kind: 'c4' | 'petrol' | 'water', x: number, z: number, yieldScale = 0.7) => {
      const overWater = Math.abs(x) > 7.5 || z < YARD_Z - 56;
      explosions.detonate({ kind, position: new THREE.Vector3(x, overWater ? 0 : DECK + 0.4, z), yield: yieldScale, surface: overWater ? 'water' : 'ground' });
    };

    // ---- thermo: a timber boardwalk that burns, steel that glows, ice that melts ---------
    const { positionWorld, vec3: v3, float: f1, mix: mixN, smoothstep: ssN, fract: fractN, floor: floorN } = TSL;
    const thermo = engine.add(new ThermoField(engine, fx, { center: new THREE.Vector2(0, -27.5), size: 26, resolution: 80, surfaceY: DECK + 0.1, weather, ocean }));
    const boards = new THREE.MeshStandardNodeMaterial();
    {
      const p = positionWorld;
      const plank = floorN(p.x.div(0.24));
      const tone = valueNoise2(TSL.vec2(plank.mul(7.3), 1.7)).mul(0.5).add(0.6);
      const grain = valueNoise2(TSL.vec2(p.x.mul(34), p.z.mul(1.6))).mul(0.6).add(valueNoise2(TSL.vec2(p.x.mul(90), p.z.mul(4))).mul(0.4));
      const gap = ssN(0.0, 0.035, fractN(p.x.div(0.24)).sub(0.5).abs().oneMinus().sub(0.5));
      const wood = v3(0.42, 0.29, 0.17).mul(tone).mul(mixN(f1(0.72), f1(1.08), grain)).mul(mixN(f1(0.25), f1(1), gap));
      const burnt = thermo.surface(wood, p);
      boards.colorNode = burnt.color;
      boards.emissiveNode = burnt.emissive;
      boards.roughnessNode = mixN(f1(0.84), f1(0.32), burnt.wetness);
      boards.metalness = 0;
    }
    const boardwalk = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.1, 11.4), boards);
    boardwalk.position.set(0, DECK + 0.05, -27.5);
    boardwalk.castShadow = boardwalk.receiveShadow = true;
    scene.add(boardwalk);
    thermo.addFuelRect(-4.9, -33.2, 4.9, -21.8, 3.2);
    // Props with rigid bodies, so blasts throw them and the heat follows wherever they land.
    type Prop = { mesh: THREE.Mesh; body: import('@dimforge/rapier3d-compat').RigidBody; home: THREE.Vector3 };
    const props: Prop[] = [];
    const addProp = (mesh: THREE.Mesh, x: number, y: number, z: number, collider: import('@dimforge/rapier3d-compat').ColliderDesc, mass: number): Prop => {
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.05).setAngularDamping(0.4));
      physics.world.createCollider(collider.setMass(mass).setFriction(0.8).setRestitution(0.1), body);
      physics.bind(body, mesh);
      const prop = { mesh, body, home: new THREE.Vector3(x, y, z) };
      props.push(prop);
      return prop;
    };
    const top = DECK + 0.1;
    for (const [x, z] of [[-2.6, -29.4], [-1.5, -29.6], [-2.1, -28.4]] as const) {
      const material = new THREE.MeshStandardMaterial({ color: 0x8a6a3c, roughness: 0.82 });
      const crate = addProp(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), material), x, top + 0.48, z, R.ColliderDesc.cuboid(0.475, 0.475, 0.475), 30);
      thermo.addBody({ object: crate.mesh, kind: 'wood', radius: 0.7, height: 0.95, material, burnTime: 22 });
    }
    for (const [x, z] of [[2.3, -26.4], [3.1, -27.1]] as const) {
      const material = new THREE.MeshStandardMaterial({ color: 0x5d6a72, roughness: 0.4, metalness: 0.9 });
      const drum = addProp(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 20), material), x, top + 0.46, z, R.ColliderDesc.cylinder(0.45, 0.3), 60);
      thermo.addBody({ object: drum.mesh, kind: 'metal', radius: 0.45, height: 0.9, material });
    }
    {
      const material = new THREE.MeshStandardMaterial({ color: 0x4f5a60, roughness: 0.45, metalness: 0.95 });
      const beam = addProp(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.22, 0.2), material), 0.6, top + 0.12, -31.6, R.ColliderDesc.cuboid(1.6, 0.11, 0.1), 140);
      thermo.addBody({ object: beam.mesh, kind: 'metal', radius: 1.5, height: 0.22, material });
    }
    const iceMaterial = new THREE.MeshStandardMaterial({ color: 0xd6eef7, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.86 });
    const ice = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.2).translate(0, 0.55, 0), iceMaterial);
    ice.position.set(3.3, top, -31);
    ice.castShadow = true;
    scene.add(ice);
    const iceBody = thermo.addBody({ object: ice, kind: 'ice', radius: 0.7, height: 1.1 });
    /** Light the boardwalk at its upwind edge so the fire has the whole deck to run across. */
    const ignite = () => {
      const d = engine.wind.direction;
      thermo.ignite(THREE.MathUtils.clamp(-d.x * 4.2, -4.2, 4.2), -27.5 + THREE.MathUtils.clamp(-d.y * 5, -5, 5), 1.0);
    };
    const hose = () => {
      thermo.quench(0, -27.5, 6.5, 1);
      fx.spray.emit({ position: new THREE.Vector3(0, top + 3, -27.5), radius: 4.5, velocity: { x: 0, y: -4, z: 0 }, spread: 3, life: 1.1, size: 0.08, sizeEnd: 0.25, count: 600 });
    };
    const resetFire = () => {
      thermo.reset();
      for (const p of props) {
        p.body.setTranslation(p.home, true); p.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        physics.snap(p.body);
      }
    };

    // ---- deformable yard + the coupe --------------------------------------------------
    const yardCentre = new THREE.Vector2(0, YARD_Z + 26);
    const ground = engine.add(new DeformableGround(engine, fx, { center: yardCentre, size: 42, surfaceY: DECK, kind: 'sand', extent: [-260, YARD_Z + 0.4, 260, YARD_Z + 300] }));
    const coupe = createSportsCoupe(0x1d5fbf);
    const car = engine.add(new AquaplaningVehicle(engine, coupe, ground, {
      ground: false, groundY: DECK, start: new THREE.Vector3(15.5, DECK + 0.75, YARD_Z + 26), heading: 0,
      path: { type: 'circle', center: yardCentre, radius: 15.5 },
    }));
    car.targetSpeed = 11;
    Object.assign(car.tuning, { dryGrip: 1.9, wetGrip: 1.5 });
    const body = new ChassisAnimator(coupe.body);
    const setGround = (kind: GroundKind) => {
      ground.setKind(kind);
      snowfall.value = kind === 'snow' ? 1 : 0;
      car.targetSpeed = kind === 'snow' ? 9.5 : kind === 'mud' ? 8.5 : 11;
    };
    // Blasts on the yard leave craters.
    const offBlast = physics.onBlast((center, radius) => { if (ground.contains(center.x, center.z)) ground.crater(center.x, center.z, Math.min(3.2, radius * 0.11)); });

    // ---- air drop: a supply crate under a canopy that the descent inflates ----------------
    const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x4d5a38, roughness: 0.8 });
    const supply = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.0, 1.3), crateMaterial);
    supply.castShadow = true;
    supply.visible = false;
    scene.add(supply);
    const chute = cloth.parachute({ follow: supply, span: 7, lines: 6.5 });
    chute.enabled = false;
    const drop = { active: false, landed: 0 };
    const airDrop = () => {
      supply.position.set(-11 + Math.random() * 4, 46, YARD_Z + 6 + Math.random() * 5);
      supply.rotation.set(0, Math.random() * 6, 0);
      supply.visible = true;
      chute.enabled = true;
      drop.active = true;
      drop.landed = 0;
      engine.events.emit('canopyOpen', { position: [supply.position.x, supply.position.y, supply.position.z], intensity: 0.9 });
    };

    // ---- camera ---------------------------------------------------------------------
    const orbit = new FollowOrbit(camera, canvas, new THREE.Vector3(0, DECK + 2.4, -4), new THREE.Vector3(-17, 5.2, 21));
    orbit.controls.minDistance = 3;
    orbit.controls.maxDistance = 220;
    const groundFloor = (x: number, z: number) => Math.max(bathymetry.heightAt(x, z), ocean.heightAt(x, z), (Math.abs(x) < 7.5 && z < YARD_Z + 6 && z > YARD_Z - 56) || z > YARD_Z ? DECK : -1e3);
    orbit.floor = groundFloor;
    const dive = (on: boolean) => {
      state.diving = on;
      orbit.floor = on ? (x, z) => bathymetry.heightAt(x, z) - 0.1 : groundFloor;
      orbit.controls.maxPolarAngle = on ? Math.PI * 0.93 : Math.PI * 0.497;
      if (on) { orbit.controls.target.set(11, -1.6, -22); camera.position.set(19, -2.4, -13); }
      else { orbit.controls.target.set(0, DECK + 2.4, -4); camera.position.set(-17, DECK + 6.6, 17); }
    };

    const yardWash = new RotorWash(engine, fx);
    let hoverRig: RescueHelicopter | undefined;
    const toggleHover = () => {
      if(!hoverRig){ hoverRig=new RescueHelicopter();scene.add(hoverRig.group);hoverRig.group.visible=false; }
      hoverRig.group.visible=!hoverRig.group.visible;
      if(hoverRig.group.visible){
        dive(false);
        orbit.controls.target.set(yardCentre.x, DECK+2.5, yardCentre.y);
        camera.position.set(yardCentre.x-14.8, DECK+4.2, yardCentre.y+10.6);
        orbit.controls.update();
      }else{yardWash.stop();dive(false);}
    };
    const wheelTracks = ['w0', 'w1', 'w2', 'w3'];
    engine.onUpdate = (dt) => {
      if(hoverRig?.group.visible){
        const position=hoverRig.group.position.set(yardCentre.x,DECK+4.5+0.12*Math.sin(engine.time*1.37),yardCentre.y);
        hoverRig.update(dt,engine.time);
        yardWash.step(position,4.65,0.94,dt,ground.kind==='mud'||ground.kind==='gravel'?'soil':ground.kind,DECK);
      }
      // Wheels press ruts into the yard and throw loose material at speed.
      body.update(dt, car.acceleration);
      car.wheels.forEach((w, i) => {
        if (w.contact) ground.track(wheelTracks[i], w.position.x, w.position.z, i < 2 ? 0.19 : 0.21, Math.min(1, w.loadRatio) * 0.95, w.rollingSpeed, w.rollingDirection, w.lateralSpeed);
        else ground.lift(wheelTracks[i]);
      });
      if (drop.active) {
        // Terminal velocity under the canopy, drifting and swinging with the wind.
        engine.wind.sample(supply.position, engine.time, windAt);
        supply.position.x += windAt.x * 0.2 * dt; supply.position.z += windAt.z * 0.2 * dt;
        supply.position.y -= 5.4 * dt;
        supply.rotation.z = Math.sin(engine.time * 1.3) * 0.12; supply.rotation.x = Math.cos(engine.time * 1.1) * 0.1;
        const floor = Math.max(supply.position.z > YARD_Z ? DECK : -1e3, ocean.heightAt(supply.position.x, supply.position.z) - 0.3) + 0.5;
        if (supply.position.y <= floor) {
          supply.position.y = floor; supply.rotation.set(0, supply.rotation.y, 0);
          drop.active = false; drop.landed = engine.time;
          if (supply.position.z > YARD_Z) ground.crater(supply.position.x, supply.position.z, 1.1);
          engine.events.emit('impact', { position: [supply.position.x, supply.position.y, supply.position.z], intensity: 0.8 });
          engine.trauma.blast(supply.position.distanceTo(camera.position), 0.3);
        }
      }
      uDeckWet.value += (Math.min(1, state.rain * 1.6) - uDeckWet.value) * Math.min(1, dt * (state.rain > uDeckWet.value ? 0.5 : 0.08));
      concrete.uniforms.puddle.value=uDeckWet.value*0.64;concrete.uniforms.rain.value=state.rain;
      // The ocean keeps the shared wind field consistent with its sea state, so the sliders
      // drive the sea-state wind (the field itself is written by `Ocean.update`).
      ocean.params.windSpeed = ocean.targetParams.windSpeed = state.wind;
      ocean.params.windDirection = ocean.targetParams.windDirection = state.windDirection;
      engine.wind.gustiness = 0.5;
      if (hoverRig?.group.visible) weather.shadowFocus.copy(hoverRig.group.position);
      else weather.shadowFocus.set(0, DECK, -6);
      weather.params.rain = state.rain;
      ocean.updateField(dt, orbit.controls.target);
      mooringBuoy.followSurface(ocean,camera.position,dt,0.05);
      bayBuoy.followSurface(ocean,camera.position,dt,0.1);
    };
    engine.onBeforeRender = (dt) => orbit.update(dt);

    panel.header('Physics playground', 'Cloth, destruction, heat and deformable ground on one pier, all driven by the same wind, water and rigid-body state.');
    panel.section('Weather');
    panel.slider('Wind', 0, 34, 0.5, () => state.wind, (v) => { state.wind = v; }, (v) => `${v.toFixed(0)} m/s`);
    panel.slider('Wind direction', -3.14, 3.14, 0.01, () => state.windDirection, (v) => { state.windDirection = v; }, (v) => `${Math.round((v * 180) / Math.PI)}°`);
    panel.slider('Rain', 0, 1, 0.01, () => state.rain, (v) => { state.rain = v; });
    panel.section('Cloth');
    panel.buttons([{ label: 'Air drop', primary: true, onClick: airDrop }, { label: 'Gust', onClick: () => engine.wind.addBlast(new THREE.Vector3(-14, DECK + 5, -6), 34, 60, 1.6) }]);
    panel.section('Destruction');
    panel.buttons([
      { label: 'Chip wall', onClick: () => {
        const wall = targets[0], index = chipIndex++;
        const point = new THREE.Vector3(Math.sin(index * 2.1) * 0.34, Math.cos(index * 1.8) * 0.23, wall.size.z * 0.5);
        const hit = point.applyQuaternion(wall.quaternion).add(wall.position);
        if (wall.markSurface(hit, 0.055)) {
          orbit.controls.target.copy(hit);
          camera.position.set(1.1, 0.45, 2.85).applyQuaternion(wall.quaternion).add(hit);
          orbit.controls.update();
        }
      } },
      { label: 'Shoot', primary: true, onClick: () => shoot() },
      { label: 'C4 at wall', primary: true, onClick: () => blastAt('c4', 2.5, -6.2) },
      { label: 'Blast glass', onClick: () => blastAt('c4', -1, 1.5, 0.35) },
    ]);
    panel.buttons([
      { label: 'Depth charge', onClick: () => blastAt('water', 13, -18, 1) },
      { label: 'Clear chips', onClick: () => { for (const target of targets) target.clearSurfaceMarks(); } },
      { label: 'Rebuild', onClick: buildTargets },
    ]);
    panel.section('Heat');
    panel.buttons([
      { label: 'Ignite', primary: true, onClick: ignite },
      { label: 'Hose', onClick: hose },
      { label: 'Reset', onClick: resetFire },
    ]);
    panel.section('Ground');
    panel.buttons((['sand', 'gravel', 'snow', 'mud'] as GroundKind[]).map((kind) => ({ label: kind, isOn: () => ground.kind === kind, onClick: () => setGround(kind) })));
    panel.slider('Soil moisture', 0, 1, 0.01, () => ground.wetness, v => { ground.wetness = v; });
    panel.slider('Car speed', 0, 22, 0.5, () => car.targetSpeed, (v) => { car.targetSpeed = v; }, (v) => `${(v * 3.6).toFixed(0)} km/h`);
    panel.buttons([{ label: 'Hover over yard', isOn: () => hoverRig?.group.visible ?? false, onClick: toggleHover },{ label: 'Smooth ground', onClick: () => ground.reset() }]);
    panel.section('Camera');
    panel.buttons([
      { label: 'Dive', primary: true, isOn: () => state.diving, onClick: () => dive(!state.diving) },
      { label: 'Wet lens', isOn: () => engine.lens.enabled, onClick: () => { engine.lens.enabled = !engine.lens.enabled; } },
    ]);
    panel.note('Drag to orbit · scroll to zoom.');

    return {
      hud: () => [
        `wind  <b>${state.wind.toFixed(0)} m/s</b>  cloth ${cloth.particleCount} particles (${cloth.backend?.kind ?? '–'})`,
        `wreck <b>${destruction.breaks}</b> chunks broken  ${destruction.liveChunks} simulated`,
        `heat  <b>${thermo.stats.burningCells}</b> cells burning  ${thermo.stats.charredCells} charred  ice ${(100 - iceBody.progress * 100).toFixed(0)} %`,
        `yard  ${ground.kind}  ${ground.stamps} stamps  car ${(Math.abs(car.speed) * 3.6).toFixed(0)} km/h`,
        underwater.depth > -0.75 ? `eye   <b>${underwater.depth > 0 ? `${underwater.depth.toFixed(1)} m under` : 'at the waterline'}</b>` : 'eye   above water',
      ],
      debug: { yardWash, weather, ocean, fx, rain, explosions, underwater, cloth, flags, banner, sail, orbit, dive, state, bathymetry, destruction, get targets() { return targets; }, shoot, blastAt, buildTargets, thermo, ignite, hose, resetFire, iceBody, ground, car, coupe, setGround, props, airDrop, supply, chute, drop, scenery },
      dispose() { yardWash.dispose(); hoverRig?.dispose(); offBlast(); orbit.dispose(); bathymetry.dispose(); scenery.dispose(); },
    };
  },
};
