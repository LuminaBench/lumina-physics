/**
 * Restrained streaming coastal storm-highway environment.
 *
 * Rides seamlessly with the vehicle along +Z with zero per-frame allocations:
 *   - Periodic sculpted wet coastal cut-embankment (-X) and low coastal verge (+X)
 *   - Concrete shoulder curbs, continuous galvanized W-beam guardrails & subtle reflective
 *     roadside delineators
 *   - Architectural curved cantilever arms & hooded luminaire caps aligned to WetRoad's 42 m poles
 *   - Sparse wind-sculpted coastal pine/cypress clusters on the bluff crest (leaving wide sky gaps)
 *   - Distant rain-veiled coastal mountain silhouettes fading into the storm haze
 */
import { createConcreteMaterial } from '../../modules/materials/concrete';
import { mergeStaticMeshes } from '../../engine/batching';
import type { LuminaEngine } from '../../engine/engine';
import { yieldToBrowser } from '../../engine/loading';
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import type { Weather } from '../../modules/weather/weather';
import {
  createBeaconMaterial,
  createMarineConcreteMaterial,
  createMarineMetalMaterial,
  createRockMaterial,
  createTerrainMaterial,
  type SceneryRegistry,
} from './materials';
import { buildHeadlands, buildRockClusters, type RockPlacement } from './terrain';
import { buildCoastalCanopy, type TreePlacement } from './vegetation';

const ROAD_HALF = 7.5;
const TILE_LEN = 320;
const LAMP_SPACING = 42;
const LAMP_COUNT = 16;

/** Periodic height profile (period = TILE_LEN) so snapping Z by TILE_LEN is mathematically seamless. */
function embankmentHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  if (ax < ROAD_HALF + 1.8) return -0.08;
  const k = (Math.PI * 2) / TILE_LEN;
  const w1 = Math.sin(z * k + 0.4) * 0.5 + Math.cos(z * k * 2 - 1.1) * 0.32 + Math.sin(z * k * 3 + 2.3) * 0.18;
  const w2 = Math.cos(z * k * 2 + 1.7) * 0.55 + Math.sin(z * k * 5 - 0.6) * 0.25 + Math.cos(z * k * 7 + 0.9) * 0.2;

  if (x < 0) {
    // -X side (behind the car in side camera & left of chase camera): dramatic coastal bluff / cut-slope.
    const d = -x - (ROAD_HALF + 1.8);
    const ditch = -0.35 * Math.exp(-(((d - 1.4) / 1.3) ** 2));
    const cutSlope = THREE.MathUtils.smoothstep(d, 2.2, 26) * (10.5 + 4.8 * w1);
    const crest = THREE.MathUtils.smoothstep(d, 18, 95) * (12.0 + 7.5 * w2) * (0.65 + 0.35 * Math.sin(d * 0.045 + w1));
    const micro = (Math.sin(d * 0.28 + z * k * 4) * 0.5 + Math.cos(d * 0.14 - z * k * 6) * 0.5) * THREE.MathUtils.smoothstep(d, 4, 24) * 1.1;
    // Gently dip beyond the ridge toward distant coastal hills.
    const backSlope = THREE.MathUtils.smoothstep(d, 95, 190) * -9.0;
    return -0.08 + ditch + cutSlope + crest + micro + backSlope;
  } else {
    // +X side: low coastal drainage shoulder, rocky dune shelf dropping gently away from the highway.
    const d = x - (ROAD_HALF + 1.8);
    const berm = THREE.MathUtils.smoothstep(d, 2.5, 14) * (1.2 + 0.8 * w1) * (1 - THREE.MathUtils.smoothstep(d, 24, 55));
    const coastalSlope = -THREE.MathUtils.smoothstep(d, 14, 75) * 4.5 + THREE.MathUtils.smoothstep(d, 55, 160) * (7.5 + 4.5 * w2);
    return -0.08 + berm + coastalSlope;
  }
}

/** Crosses the sag in the highway, where water can flow in from the open lane. */
export const OVERPASS_Z = 260;
export function buildHighwayOverpass(reg: SceneryRegistry, engine: LuminaEngine, probeLayer: number): () => void {
  const group = new THREE.Group(), yaw = 0.10, clearance = 5.2, width = 100, depth = 12;
  group.position.set(12, 0, OVERPASS_Z);
  group.rotation.y = yaw;
  group.name = 'coastal-overpass';
  const concrete = reg.trackMaterial(createConcreteMaterial({color:0x93918b, roughness:0.90,
    slabSize:0, wetness:0, bumpScale:0.0022, fireLighting:false}));
  concrete.name = 'overpass-concrete';
  const girders = createMarineMetalMaterial(reg, { name: 'bridge-girders', color: 0x474d49, roughness: 0.74, metalness: 0.54 });
  const unit = reg.trackGeometry(new THREE.BoxGeometry(1, 1, 1));
  const part = (mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const mesh = new THREE.Mesh(unit, mat);
    mesh.position.set(x,y,z); mesh.scale.set(sx,sy,sz);
    mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  };
  const R = engine.physics.RAPIER, sim = engine.physics.world;
  const body = sim.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(group.position.x,0,OVERPASS_Z).setRotation(group.quaternion));
  const slabY = clearance+0.42;
  part(concrete,0,slabY,0,width,0.84,depth);
  sim.createCollider(R.ColliderDesc.cuboid(width/2,0.42,depth/2).setTranslation(0,slabY,0),body);
  for (const side of [-1,1]) {
    part(concrete,0,clearance+1.19,side*(depth/2-0.20),width,0.70,0.40);
    part(girders,0,clearance+1.93,side*(depth/2-0.22),width,0.08,0.09);
    for(let x=-width/2+1; x<width/2; x+=3.6) part(girders,x,clearance+1.73,side*(depth/2-0.22),0.075,0.42,0.075);
  }
  for(let z=-4.35;z<5;z+=2.9) {
    part(girders,0,clearance-0.25,z,width,0.5,0.12);
    part(girders,0,clearance-0.49,z,width,0.10,0.46);
  }
  for(const x of [-25,0,25,48]){
    part(concrete,x,clearance-0.92,0,1.74,0.83,depth-1.0);
    for(const z of [-3.2,3.2]){
      part(concrete,x,-0.5,z,1.28,8.75,1.60);
      sim.createCollider(R.ColliderDesc.cuboid(0.64,4.375,0.80).setTranslation(x,-0.5,z),body);
    }
  }
  mergeStaticMeshes(group);
  group.traverse(object => object.layers.enable(probeLayer));
  reg.group.add(group);
  const release=engine.world.shelters.add({center:new THREE.Vector3(group.position.x,clearance,OVERPASS_Z),
    width,depth,yaw,groundY:0,underside:0x62605b});
  return () => { release(); if (sim.getRigidBody(body.handle)) sim.removeRigidBody(body); };
}

export interface HighwayEnvironmentHandle {
  update(carZ: number): void;
}

export async function buildHighwayEnvironment(reg: SceneryRegistry, weather: Weather): Promise<HighwayEnvironmentHandle> {
  const tileGroup = new THREE.Group();
  tileGroup.name = 'highway-streaming-tile';
  reg.group.add(tileGroup);

  const terrainMat = createTerrainMaterial(reg, weather, {
    palette: 'storm',
    rockiness: 0.32,
    wetness: 0.34,
    mistStart: 120,
    mistRange: 1400,
    mistMax: 0.65,
    mistHeight: 140,
  });
  const rockMat = createRockMaterial(reg, weather, 'storm', { mistStart: 90, mistRange: 1200, mistMax: 0.62 });
  const curbMat = createMarineConcreteMaterial(reg, weather, { tone: [0.24, 0.245, 0.25], wetLine: 0.35 });
  const railSteel = createMarineMetalMaterial(reg, { name: 'guardrail-steel', color: 0x676f76, roughness: 0.42, metalness: 0.78 });
  const darkIron = createMarineMetalMaterial(reg, { name: 'highway-iron', color: 0x1d2126, roughness: 0.48, metalness: 0.82 });
  const amberReflector = createBeaconMaterial(reg, [14, 7.5, 1.4], 'delineator-amber');
  const whiteReflector = createBeaconMaterial(reg, [12, 13, 14], 'delineator-white');
  const lampRimGlow = createBeaconMaterial(reg, [34, 23, 11], 'highway-lamp-core');

  // ---- 1. Seamless sculpted coastal embankment tiles (-X bluff, +X coastal dunes) --------
  const buildSideStrip = (side: -1 | 1): THREE.Mesh => {
    const width = 185;
    const len = TILE_LEN * 3; // covers [z - 480, z + 480]
    const segX = 50, segZ = 168;
    const g = new THREE.PlaneGeometry(width, len, segX, segZ);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    // Concentrate samples under the shoulder, ditch and exposed rock footings.
    for (let i = 0; i < pos.count; i++) {
      const across = 0.5 + side * pos.getX(i) / width;
      const wx = side * (ROAD_HALF + 1.4 + width * Math.pow(across, 1.65));
      const wz = pos.getZ(i);
      pos.setXYZ(i, wx, embankmentHeight(wx, wz), wz);
    }
    g.computeVertexNormals();
    reg.trackGeometry(g);
    const mesh = new THREE.Mesh(g, terrainMat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  };
  tileGroup.add(buildSideStrip(-1), buildSideStrip(1));

  // ---- 2. Concrete shoulder curbs & continuous W-beam guardrails (both sides) ------------
  const totalLen = TILE_LEN * 3;
  const curbGeo = reg.trackGeometry(new THREE.BoxGeometry(1.15, 0.16, totalLen));
  // Folded steel section with two continuous raised flutes. Each fold has a
  // distinct normal, so the wet highlights move naturally past the camera.
  const railProfile = new THREE.Shape();
  const fold = [[0, -0.155], [-0.034, -0.135], [-0.082, -0.082], [-0.076, -0.058],
    [-0.018, 0], [-0.076, 0.058], [-0.082, 0.082], [-0.034, 0.135], [0, 0.155]];
  railProfile.moveTo(fold[0][0], fold[0][1]);
  for (let i=1;i<fold.length;i++) railProfile.lineTo(fold[i][0], fold[i][1]);
  for (let i=fold.length-1;i>=0;i--) railProfile.lineTo(fold[i][0]+0.005, fold[i][1]);
  railProfile.closePath();
  const railBeamGeo = reg.trackGeometry(new THREE.ExtrudeGeometry(railProfile, {depth:totalLen,bevelEnabled:false}).translate(0,0,-totalLen/2));
  for (const side of [-1, 1]) {
    const curb = new THREE.Mesh(curbGeo, curbMat);
    curb.position.set(side * (ROAD_HALF + 0.62), 0.01, 0);
    curb.receiveShadow = true;
    curb.frustumCulled = false;
    tileGroup.add(curb);

    // W-beam guardrail at x = ±8.55 (well clear of road width 7.5 and side camera at +4.6)
    const rail = new THREE.Mesh(railBeamGeo, railSteel);
    rail.position.set(side * (ROAD_HALF + 1.05), 0.68, 0);
    rail.rotation.y = side < 0 ? Math.PI : 0;
    rail.castShadow = true;
    rail.receiveShadow = true;
    rail.frustumCulled = false;
    tileGroup.add(rail);
  }

  // Guardrail I-posts + reflective delineators along both edges (instanced inside tileGroup)
  const postStep = 4.0;
  const postsPerSide = Math.floor(totalLen / postStep);
  const postGeo = reg.trackGeometry(new THREE.BoxGeometry(0.11, 0.92, 0.11));
  const posts = new THREE.InstancedMesh(postGeo, darkIron, postsPerSide * 2);
  posts.frustumCulled = false;
  const m = new THREE.Matrix4();
  let pIdx = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < postsPerSide; i++) {
      const pz = -totalLen / 2 + i * postStep;
      m.makeTranslation(side * (ROAD_HALF + 1.15), 0.42, pz);
      posts.setMatrixAt(pIdx++, m);
    }
  }
  posts.instanceMatrix.needsUpdate = true;
  tileGroup.add(posts);

  // Restrained reflective roadside delineator studs every 24m (amber on -X, crisp white on +X)
  const delinStep = 24;
  const delinCount = Math.floor(totalLen / delinStep);
  const delinGeo = reg.trackGeometry(new THREE.BoxGeometry(0.05, 0.16, 0.08));
  const amberDelins = new THREE.InstancedMesh(delinGeo, amberReflector, delinCount);
  const whiteDelins = new THREE.InstancedMesh(delinGeo, whiteReflector, delinCount);
  amberDelins.frustumCulled = whiteDelins.frustumCulled = false;
  for (let i = 0; i < delinCount; i++) {
    const dz = -totalLen / 2 + i * delinStep + 6;
    m.makeTranslation(-(ROAD_HALF + 0.96), 0.72, dz);
    amberDelins.setMatrixAt(i, m);
    m.makeTranslation(ROAD_HALF + 0.96, 0.72, dz);
    whiteDelins.setMatrixAt(i, m);
  }
  amberDelins.instanceMatrix.needsUpdate = true;
  whiteDelins.instanceMatrix.needsUpdate = true;
  tileGroup.add(amberDelins, whiteDelins);

  // ---- 3. Wet rocky cut-slope boulders & wind-sculpted coastal pines (3-tile periodic) ---
  const rand = mulberry32(907);
  const baseRocks: RockPlacement[] = [];
  const basePines: TreePlacement[] = [];
  const baseScrub: TreePlacement[] = [];

  for (let i = 0; i < 34; i++) {
    const side = i < 24 ? -1 : 1;
    const d = side === -1 ? (4 + rand() * 24) : (6 + rand() * 18);
    const x = side * (ROAD_HALF + d);
    const z = (rand() - 0.5) * TILE_LEN;
    const scaleX = 1.1 + rand()*2.4, scaleY = 0.7 + rand()*1.4, scaleZ = 1.2 + rand()*2.5;
    const footprint = Math.max(scaleX,scaleZ)*0.52;
    const foot = Math.min(embankmentHeight(x-footprint,z),embankmentHeight(x+footprint,z),
      embankmentHeight(x,z-footprint),embankmentHeight(x,z+footprint));
    baseRocks.push({
      x, y: foot - scaleY*0.18, z, scaleX, scaleY, scaleZ,
      rotY: rand() * Math.PI * 2,
      tiltX: (rand() - 0.5) * 0.22,
      tiltZ: (rand() - 0.5) * 0.22,
      variant: i % 3,
    });
  }

  // Sparse clustered coastal conifers along the -X bluff crest + distant +X dunes
  // (intentionally clustered with open sky gaps so the storm atmosphere breathes!).
  for (let cluster = 0; cluster < 6; cluster++) {
    const cz = -TILE_LEN / 2 + ((cluster + 0.5) / 6) * TILE_LEN + (rand() - 0.5) * 26;
    const cx = -(ROAD_HALF + 16 + rand() * 26);
    const treesInCluster = 4 + Math.floor(rand() * 4);
    for (let k = 0; k < treesInCluster; k++) {
      const tx = cx + (rand() - 0.5) * 18;
      const tz = cz + (rand() - 0.5) * 22;
      if (tx > -(ROAD_HALF + 11.5)) continue;
      const ty = embankmentHeight(tx, tz);
      const tone = 0.62 + rand() * 0.28;
      basePines.push({
        x: tx, y: ty, z: tz,
        scale: 0.85 + rand() * 0.85,
        rotY: rand() * Math.PI * 2,
        leanX: 0.04 + rand() * 0.08, // subtle lean away from coastal wind
        leanZ: (rand() - 0.5) * 0.06,
        tint: [tone * 0.88, tone * 0.96, tone * 0.92],
      });
    }
  }
  // A few scattered windswept pines on far +X rise (never near road/side camera).
  for (let i = 0; i < 10; i++) {
    const tx = ROAD_HALF + 32 + rand() * 42;
    const tz = (rand() - 0.5) * TILE_LEN;
    const ty = embankmentHeight(tx, tz);
    const tone = 0.6 + rand() * 0.25;
    basePines.push({
      x: tx, y: ty, z: tz,
      scale: 0.75 + rand() * 0.75,
      rotY: rand() * Math.PI * 2,
      leanX: 0.06,
      tint: [tone * 0.85, tone * 0.92, tone * 0.9],
    });
  }
  // Low damp coastal scrub along the bluff mid-slope.
  for (let i = 0; i < 28; i++) {
    const tx = -(ROAD_HALF + 5.5 + rand() * 20);
    const tz = (rand() - 0.5) * TILE_LEN;
    const ty = embankmentHeight(tx, tz);
    const tone = 0.42 + rand() * 0.22;
    baseScrub.push({
      x: tx, y: ty, z: tz,
      scale: 0.65 + rand() * 0.75,
      rotY: rand() * Math.PI * 2,
      tint: [tone * 0.82, tone * 0.95, tone * 0.8],
    });
  }

  // Replicate each periodic list across 3 contiguous tiles (-TILE_LEN, 0, +TILE_LEN).
  const tileShifts = [-TILE_LEN, 0, TILE_LEN];
  const allRocks: RockPlacement[] = [];
  const allPines: TreePlacement[] = [];
  const allScrub: TreePlacement[] = [];
  for (const dz of tileShifts) {
    for (const r of baseRocks) allRocks.push({ ...r, z: r.z + dz });
    for (const p of basePines) allPines.push({ ...p, z: p.z + dz });
    for (const s of baseScrub) allScrub.push({ ...s, z: s.z + dz });
  }

  const rocks = buildRockClusters(reg, allRocks, rockMat, { name: 'highway-rocks', castShadow: false, receiveShadow: true, seed: 83 });
  rocks.forEach((im) => tileGroup.add(im));
  await yieldToBrowser();
  const pines = buildCoastalCanopy(reg, allPines, 'pine', { name: 'highway-pines', castShadow: false, seed: 113 });
  if (pines) tileGroup.add(pines);
  await yieldToBrowser();
  const scrub = buildCoastalCanopy(reg, allScrub, 'scrub', { name: 'highway-scrub', castShadow: false, seed: 127 });
  if (scrub) tileGroup.add(scrub);

  // ---- 4. Architectural streetlamp upgrades aligned to WetRoad's exact 42m poles ---------
  const plinthGeo = reg.trackGeometry(new THREE.CylinderGeometry(0.24, 0.30, 0.52, 8).translate(0, 0.26, 0));
  const armGeo = reg.trackGeometry(new THREE.BoxGeometry(0.95, 0.08, 0.09));
  const hoodGeo = reg.trackGeometry(new THREE.BoxGeometry(1.06, 0.14, 0.44));
  const bulbGeo = reg.trackGeometry(new THREE.BoxGeometry(0.84, 0.04, 0.26));

  const lampPlinths = new THREE.InstancedMesh(plinthGeo, curbMat, LAMP_COUNT);
  const lampArms = new THREE.InstancedMesh(armGeo, darkIron, LAMP_COUNT);
  const lampHoods = new THREE.InstancedMesh(hoodGeo, darkIron, LAMP_COUNT);
  const lampBulbs = new THREE.InstancedMesh(bulbGeo, lampRimGlow, LAMP_COUNT);
  lampPlinths.frustumCulled = lampArms.frustumCulled = lampHoods.frustumCulled = lampBulbs.frustumCulled = false;
  reg.group.add(lampPlinths, lampArms, lampHoods, lampBulbs);

  // ---- 5. Distant storm-veiled coastal mountain silhouettes (tracks carZ) ----------------
  const distantGroup = new THREE.Group();
  distantGroup.name = 'highway-distant-ridges';
  reg.group.add(distantGroup);

  const farTerrainMat = createTerrainMaterial(reg, weather, {
    terrainShadows: true,
    palette: 'storm',
    rockiness: 0.45,
    wetness: 0.25,
    mistStart: 350,
    mistRange: 1350,
    mistMax: 0.78,
    mistHeight: 240,
  });
  await yieldToBrowser();
  const ridges = buildHeadlands(
    reg,
    [
      { x: -780, z: -260, radiusX: 520, radiusZ: 780, height: 220, rotation: 0.12, segments: 40, cragginess: 0.65, seed: 401 },
      { x: -940, z: 620, radiusX: 600, radiusZ: 880, height: 270, rotation: -0.18, segments: 40, cragginess: 0.7, seed: 419 },
      { x: -1350, z: 1650, radiusX: 780, radiusZ: 960, height: 340, rotation: 0.25, segments: 36, cragginess: 0.68, seed: 433 },
      { x: 960, z: 540, radiusX: 540, radiusZ: 820, height: 195, rotation: 0.15, segments: 36, cragginess: 0.58, seed: 449 },
      { x: 1120, z: 1750, radiusX: 680, radiusZ: 860, height: 260, rotation: -0.22, segments: 36, cragginess: 0.64, seed: 461 },
      { x: -120, z: 2350, radiusX: 1100, radiusZ: 560, height: 240, rotation: 0.06, segments: 36, cragginess: 0.6, seed: 479 },
    ],
    farTerrainMat,
    { name: 'highway-distant-mountains', castShadow: false, receiveShadow: false },
  );
  distantGroup.add(ridges.mesh);

  // Reusable scratch objects (zero per-frame allocations)
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  let lastLampBase = NaN;

  return {
    update(carZ: number): void {
      tileGroup.position.z = Math.round(carZ / TILE_LEN) * TILE_LEN;
      // Distant peaks glide slowly with subtle depth parallax rather than feeling pasted to the camera.
      distantGroup.position.z = carZ;

      const base = Math.floor(carZ / LAMP_SPACING) * LAMP_SPACING;
      if (base !== lastLampBase) {
        lastLampBase = base;
        for (let i = 0; i < LAMP_COUNT; i++) {
          const lz = base + (i - 3) * LAMP_SPACING;
          const side = Math.round(lz / LAMP_SPACING) % 2 === 0 ? 1 : -1;
          const poleX = side * (ROAD_HALF + 1.4);

          mat4.makeTranslation(poleX, 0, lz);
          lampPlinths.setMatrixAt(i, mat4);

          // Gently angled cantilever arm reaching out to WetRoad's luminaire head at side * 8.2
          euler.set(0, 0, side * 0.14);
          quat.setFromEuler(euler);
          pos.set(poleX - side * 0.42, 8.38, lz);
          mat4.compose(pos, quat, scl);
          lampArms.setMatrixAt(i, mat4);

          mat4.makeTranslation(poleX - side * 0.72, 8.43, lz);
          lampHoods.setMatrixAt(i, mat4);

          mat4.makeTranslation(poleX - side * 0.72, 8.32, lz);
          lampBulbs.setMatrixAt(i, mat4);
        }
        lampPlinths.instanceMatrix.needsUpdate = true;
        lampArms.instanceMatrix.needsUpdate = true;
        lampHoods.instanceMatrix.needsUpdate = true;
        lampBulbs.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
