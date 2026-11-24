import * as THREE from 'three/webgpu';
import { createLuminaWorld } from '../modules/weather/outdoor-world';
import { BuoyantBody } from '../modules/water/buoyancy';
const canvas = document.querySelector('canvas')!;

async function drift(changeLook: boolean) {
  const w = await createLuminaWorld(
    {
      profileVersion: 1,
      time: 14,
      look: 'cold-overcast',
      quality: 'low',
      seed: 372,
      overrides: { grassDensity: 0.19 },
      locks: ['waterTint', 'grassDensity', 'seaState'],
    },
    { canvas, forceWebGL: true },
  );
  const { engine, ocean } = w;
  const p = engine.physics!,
    R = p.RAPIER;
  const body = p.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(85, 0.05, 70));
  p.world.createCollider(R.ColliderDesc.ball(0.6).setMass(280), body);
  const buoy = new BuoyantBody(p, ocean!, body, { points: [new THREE.Vector3(0, -0.3, 0)], volume: 0.8 });
  const trajectory: number[][] = [],
    wind = new THREE.Vector3();
  const before = w.profile.values;
  for (let step = 1; step <= 75; step++) {
    if (changeLook && step === 21) w.patch({ time: 17.8 });
    if (changeLook && step === 38) w.patch({ look: 'painterly' });
    engine.time = step / 60;
    ocean!.update(1 / 60, engine.time);
    p.step(1 / 60);
    engine.wind.ambientWind(engine.camera.position, engine.time, wind);
    if (step % 5 === 0)
      trajectory.push([body.translation().y, buoy.state.submersion, ocean!.heightAt(92, 68), wind.x, wind.z]);
  }
  const result = { before, after: w.profile.values, trajectory, foam: ocean!.optics.foam, time: w.profile.time };
  buoy.dispose();
  w.dispose();
  return result;
}

async function track() {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
  const controls = { target: new THREE.Vector3(0, 0, 3), updates: 0 };
  const track = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 30), new THREE.MeshBasicMaterial({ color: 0x263645 }));
  scene.add(track);
  camera.position.set(0, 3, 8);
  camera.lookAt(controls.target);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true });
  await renderer.init();
  const rotation = camera.quaternion.clone();
  const create = (json: string) =>
    createLuminaWorld(JSON.parse(json) as { profileVersion: 1; mode: 'attach' }, { scene, camera });
  const attached = await create(
    JSON.stringify({ profileVersion: 1, mode: 'attach', seed: 2, weather: 'squall', quality: 'low' }),
  );
  attached.update(1 / 60);
  controls.updates++;
  renderer.render(scene, camera);
  const count = attached.rain.mesh.count;
  const json = JSON.stringify(attached.profile),
    emitted = attached.rain.mesh.visible;
  attached.dispose();
  const detached = scene.children.length === 1 && scene.children[0] === track;
  const again = await create(json);
  again.update(1 / 60);
  controls.updates++;
  renderer.render(scene, camera);
  const replay = JSON.stringify(again.profile) === json && again.rain.mesh.count === count;
  again.dispose();
  renderer.dispose();
  track.geometry.dispose();
  track.material.dispose();
  return {
    detached,
    replay,
    emitted,
    count,
    controls: controls.updates,
    camera: rotation.equals(camera.quaternion),
  };
}

Object.assign(window, { profileChecks: { drift, track } });

async function terrainContacts(custom: boolean) {
  const { terrainReading } = await import('../modules/terrain/surface');
  const { AquaplaningVehicle } = await import('../modules/wet-road/vehicle');
  const { createTestCar } = await import('../test-rigs/test-car');
  const { ClothSystem } = await import('../modules/cloth/cloth');
  const heightmap = { size: 160, segments: 80, heights: new Float32Array(81 * 81) };
  for (let z = 0; z < 81; z++)
    for (let x = 0; x < 81; x++) {
      const bank = Math.abs(x - 40) * 2;
      heightmap.heights[x + z * 81] = Math.min(9, bank * 0.23 - 2.5) + Math.max(0, 7 - Math.abs(bank - 58)) * 1.65;
    }
  const world = await createLuminaWorld(
    { profileVersion: 1, quality: 'low', biome: 'temperate-river-valley', seed: 721 },
    { canvas, forceWebGL: true, heightmap: custom ? heightmap : undefined },
  );
  const { engine, terrain, bed, foliage } = world,
    read = terrainReading(),
    pose = new THREE.Matrix4();
  let validReeds = 0,
    maxBedError = 0,
    steep = 0,
    launchX = 0,
    launchZ = 0;
  for (let i = 0; i < foliage.reeds.count; i++) {
    foliage.reeds.getMatrixAt(i, pose);
    const s = terrain.sample(pose.elements[12], pose.elements[14], read);
    if (s.surfaceId === 'reeds' && s.moisture > 0.85) validReeds++;
  }
  for (let j = 0; j < 80; j++)
    for (let i = 0; i < 80; i++) {
      const x = (i / 80 - 0.5) * terrain.size,
        z = (j / 80 - 0.5) * terrain.size;
      const s = terrain.sample(x, z, read);
      if (s.slope > 0.65 && s.height > 0 && s.surfaceId === 'rock') steep++;
      maxBedError = Math.max(maxBedError, Math.abs(bed.heightAt(x, z) - s.height));
      if (i > 15 && i < 64 && j > 22 && j < 55 && s.slope < 0.23 && s.height > 3.2) {
        launchX = x;
        launchZ = z;
      }
    }
  const { TSL } = await import('../engine/tsl');
  const spot = TSL.uniform(new THREE.Vector2()),
    shading = new THREE.NodeMaterial();
  shading.fragmentNode = TSL.vec4(bed.heightNode(spot), 0, 0, 1);
  const quad = new THREE.QuadMesh(shading),
    depthTarget = new THREE.RenderTarget(1, 1, { type: THREE.FloatType });
  engine.renderer.setRenderTarget(depthTarget);
  let maxWaterlineError = 0;
  for (let i = 0; i <= 16; i++) {
    const x = i === 16 ? terrain.size / 2 + 30 : (0.013 + i * 0.021) * terrain.size,
      z = (0.19 - i * 0.012) * terrain.size;
    spot.value.set(x, z);
    quad.render(engine.renderer);
    const data = await engine.renderer.readRenderTargetPixelsAsync(depthTarget, 0, 0, 1, 1);
    const gpuHeight = new Float32Array(data.buffer, data.byteOffset, 1)[0];
    const expected = i === 16 ? -80 : terrain.sample(x, z, read).height;
    maxWaterlineError = Math.max(maxWaterlineError, Math.abs(gpuHeight - expected), Math.abs(bed.heightAt(x,z) - expected));
  }
  engine.renderer.setRenderTarget(null);
  depthTarget.dispose();
  shading.dispose();
  const start = new THREE.Vector3(launchX, terrain.sample(launchX, launchZ, read).height + 1.1, launchZ);
  const car = engine.add(new AquaplaningVehicle(engine, createTestCar(), terrain, { start, ground: false }));
  car.autopilot = false;
  for (let i = 0; i < 100; i++) engine.physics.step(1 / 60);
  const wheelErrors = car.wheels
    .filter((w) => w.contact)
    .map((w) => Math.abs(w.position.y - terrain.sample(w.position.x, w.position.z, read).height));
  // Read screen-space silhouettes of the actual plant vertex shaders in isolation.
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera(-4, 4, 6, -2, 0.1, 40);
  const size = 128,
    target = new THREE.RenderTarget(size, size);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);
  scene.background = new THREE.Color(0);
  const silhouettes = async (speed: number) => {
    engine.world.direction.set(1, 0);
    engine.world.speed = speed;
    engine.world.update(1 / 60);
    foliage.wind.update(1, 0, new THREE.Vector3());
    const readings: number[] = [];
    for (const source of [foliage.grass, foliage.crowns]) {
      const material = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      material.positionNode = (source.material as THREE.MeshStandardNodeMaterial).positionNode;
      const plant = new THREE.InstancedMesh(source.geometry, material, 1);
      plant.setMatrixAt(0, new THREE.Matrix4());
      scene.add(plant);
      plant.frustumCulled = false;
      if (source === foliage.grass) {
        camera.left = -1;
        camera.right = 1;
        camera.top = 1.5;
        camera.bottom = -0.5;
      } else {
        camera.left = -5;
        camera.right = 5;
        camera.top = 7;
        camera.bottom = -3;
      }
      camera.updateProjectionMatrix();
      engine.renderer.setRenderTarget(target);
      engine.renderer.render(scene, camera);
      const bytes = await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
      let sum = 0,
        count = 0;
      for (let i = 0; i < size * size; i++)
        if (bytes[i * 4] > 50) {
          sum += i % size;
          count++;
        }
      readings.push(sum / count);
      plant.removeFromParent();
      plant.dispose();
      material.dispose();
    }
    engine.renderer.setRenderTarget(null);
    const cloth = engine.add(new ClothSystem(engine, { forceCpu: true }));
    const flag = cloth.flag({ origin: new THREE.Vector3(0, 5, 0), yaw: Math.PI / 2, width: 2, height: 1 });
    engine.camera.position.set(1, 4, 8);
    engine.camera.lookAt(0, 4, 0);
    engine.camera.updateMatrixWorld();
    for (let step = 1; step <= 60; step++) cloth.update(1 / 60, step / 60);
    readings.push(flag.point(flag.record.spec.cols - 1, 1).x);
    engine.remove(cloth);
    return readings;
  };
  const calm = await silhouettes(0),
    gust = await silhouettes(13);
  const bends = gust.map((value, i) => value - calm[i]);
  target.dispose();
  const reeds = foliage.reeds.count;
  world.dispose();
  return { wheelErrors, validReeds, reeds, steep, maxBedError, maxWaterlineError, bends };
}
Object.assign((window as any).profileChecks, { terrainContacts });
