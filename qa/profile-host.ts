import * as THREE from 'three/webgpu';
import { createLuminaWorld } from '../modules/weather/outdoor-world';
import { BuoyantBody } from '../modules/water/buoyancy';
const canvas = document.querySelector('canvas')!;

async function drift(changeLook: boolean) {
  const w = await createLuminaWorld({ profileVersion: 1, time: 14, look: 'cold-overcast', quality: 'low', seed: 372,
    overrides: { grassDensity: 0.19 }, locks: ['waterTint', 'grassDensity', 'seaState'] }, { canvas, forceWebGL: true });
  const { engine, ocean } = w;
  const p = engine.physics!, R = p.RAPIER;
  const body = p.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(85, 0.05, 70));
  p.world.createCollider(R.ColliderDesc.ball(0.6).setMass(280), body);
  const buoy = new BuoyantBody(p, ocean!, body, { points: [new THREE.Vector3(0, -0.3, 0)], volume: 0.8 });
  const trajectory: number[][] = [], wind = new THREE.Vector3();
  const before = w.profile.values;
  for (let step = 1; step <= 75; step++) {
    if (changeLook && step === 21) w.patch({ time: 17.8 });
    if (changeLook && step === 38) w.patch({ look: 'painterly' });
    engine.time = step / 60;
    ocean!.update(1/60, engine.time);
    p.step(1/60);
    engine.wind.ambientWind(engine.camera.position, engine.time, wind);
    if (step % 5 === 0) trajectory.push([body.translation().y, buoy.state.submersion, ocean!.heightAt(92,68), wind.x, wind.z]);
  }
  const result = { before, after: w.profile.values, trajectory, foam: ocean!.optics.foam, time: w.profile.time };
  buoy.dispose();
  w.dispose();
  return result;
}

async function track() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
  const controls = { target: new THREE.Vector3(0, 0, 3), updates: 0 };
  const track = new THREE.Mesh(new THREE.BoxGeometry(8,1,30), new THREE.MeshBasicMaterial({ color: 0x263645 }));
  scene.add(track); camera.position.set(0, 3, 8); camera.lookAt(controls.target);
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: true }); await renderer.init();
  const rotation = camera.quaternion.clone();
  const create = (json: string) => createLuminaWorld(JSON.parse(json) as {profileVersion: 1; mode:'attach'}, { scene, camera });
  const attached = await create(JSON.stringify({ profileVersion: 1, mode: 'attach', seed: 2, weather: 'squall', quality: 'low' }));
  attached.update(1/60); controls.updates++;
  renderer.render(scene, camera);
  const count = attached.rain.mesh.count;
  const json = JSON.stringify(attached.profile), emitted = attached.rain.mesh.visible;
  attached.dispose();
  const detached = scene.children.length === 1 && scene.children[0] === track;
  const again = await create(json); again.update(1/60); controls.updates++;
  renderer.render(scene, camera);
  const replay = JSON.stringify(again.profile) === json && again.rain.mesh.count === count;
  again.dispose(); renderer.dispose(); track.geometry.dispose(); track.material.dispose();
  return { detached, replay, emitted, count, controls: controls.updates, camera: rotation.equals(camera.quaternion) };
}

Object.assign(window, { profileChecks: { drift, track } });
