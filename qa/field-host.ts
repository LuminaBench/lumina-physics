import * as THREE from 'three/webgpu';
import { WorldBus } from '../engine/world-bus';
import { attachLandscape } from '../modules/landscape/host';
import { AuthoredLandscape } from '../modules/landscape/authored';
import { RegionalFlight } from '../modules/landscape/regional-flight';
import { soilSite } from '../modules/landscape/earth';
import { chalkStreamGarden } from '../examples/landscape/chalk-stream';
import { growPlant } from '../modules/vegetation/botany';

async function exercise(webgl: boolean) {
  const canvas = document.querySelector('canvas')!;
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL: webgl, antialias: true });
  await renderer.init();
  renderer.setSize(640, 360, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cad8df');
  const camera = new THREE.PerspectiveCamera(52, 640 / 360, 0.1, 420),
    rig = new THREE.Group(),
    sun = new THREE.DirectionalLight('#fcd9aa', 2.1);
  camera.position.set(2, 6, 16);
  rig.position.set(5, 0, 2);
  rig.add(camera);
  scene.add(rig, sun, new THREE.HemisphereLight('#d6e4ed', '#6b6952', 1.5));
  camera.lookAt(0, 2, 0);
  sun.position.set(8, 13, -5);
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(94, 94),
    new THREE.MeshStandardNodeMaterial({ color: '#847962' }),
  );
  surface.rotation.x = -Math.PI / 2;
  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.4, 23),
    new THREE.MeshStandardNodeMaterial({ color: '#666967' }),
  );
  bridge.position.y = 2;
  const collider = { kind: 'host bridge', extent: 5 };
  bridge.userData.collider = collider;
  scene.add(surface, bridge);
  scene.updateMatrixWorld(true);
  const original = [...scene.children],
    cameraPose = camera.matrixWorld.toArray(),
    originalRendererSize = renderer.getSize(new THREE.Vector2()).toArray();
  const { library, landscape } = chalkStreamGarden(),
    fields = new WorldBus(),
    segments = 32;
  // A square host terrain with gentle crossfall drains east. Keep both road and bridge approach clear.
  const heightmap = {
    size: 94,
    segments,
    heights: Float32Array.from({ length: (segments + 1) ** 2 }, (_, i) => 2.3 - (i % (segments + 1)) * 0.05),
  };
  const host = {
    scene,
    camera,
    heightmap,
    fields,
    sun,
    library,
    seed: 319,
    tier: 'low' as const,
    gpu: webgl ? undefined : renderer,
    plantable: (x: number, z: number) => Math.abs(x) > 4 && !(z > 18 && z < 23),
    substrate: (x: number) => (Math.abs(x) < 3 ? ('asphalt' as const) : ('clay' as const)),
  };
  const attached = attachLandscape(landscape, host),
    land = attached.land,
    f = attached.foliage,
    site = soilSite();
  let excluded = 0;
  for (let x = -3; x <= 3; x++) for (let z = -30; z <= 30; z += 4) if (land.choose(x, z, 0.5)) excluded++;
  land.earth.discharge(-11, -7, 0.1, 2.8);
  const source = land.earth.inspect(-11, -7, site).water;
  const tread = land.contact(0.25),
    other = land.contact(0.25);
  for (let i = 0; i < 20; i++) tread.sample(-11 + i * 0.51, -7, 8, 1, 0.064);
  other.sample(1, 14, 0, 0, 0.1);
  const carried = tread.sediment,
    independent = other.sediment;
  const landmark = f.grove.nearest(-8, -10, camera, true),
    custom = library.describe('plant', 'game:silver-birch'),
    birch = library.get('plant', 'game:silver-birch'),
    parent = library.get('plant', 'lumina:birch'),
    form = growPlant(birch.form, 133, birch),
    baseline = growPlant(parent.form, 133, parent);
  for (let i = 0; i < 30; i++) {
    attached.update(0.1);
    renderer.render(scene, camera);
  }
  const state = land.earth.save(),
    drained = land.earth.inspect(-11, -7, site).water,
    road = land.inspect(0, 0),
    chosen = land.inspect(-13, 5);
  const proof = {
    excluded,
    carried,
    independent,
    source,
    drained,
    road: road.reason,
    plants: chosen.plants.length,
    stableBefore: landmark?.id,
    customHeight: form.height,
    parentHeight: baseline.height,
    rootWidth: form.radius,
    inherited: custom.inherited,
    overridden: custom.overridden,
    dependencies: land.dependencies,
    forkedOwnTime: land.lighting.time.value,
    materialNodes: f.grass.material instanceof THREE.MeshBasicNodeMaterial,
    stockFar: f.grove.batches.size,
    backend: (renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2',
    renderCalls: renderer.info.render.drawCalls,
    cells: state.cells.length,
  };
  attached.dispose();
  attached.dispose();
  const again = attachLandscape(
    { ...landscape, seeds: { flowers: 13568 } },
    { ...host, earthSave: JSON.parse(JSON.stringify(state)) },
  );
  const stableAfter = again.foliage.grove.nearest(-8, -10, camera, true)?.id;
  const restored = again.land.earth.save(),
    retained = JSON.stringify(restored.cells) === JSON.stringify(state.cells);
  again.dispose();
  const flight = new RegionalFlight(81, 1);
  let max = 0;
  for (const x of [0, 330, 1080, 2440, 0]) {
    for (let i = 0; i < 6; i++) flight.updateAt(x, 50);
    max = Math.max(max, flight.residentTiles);
  }
  const sampled = flight.height(0, 0),
    origin = flight.origin.east;
  flight.dispose();
  const ownership =
    original.length === scene.children.length &&
    original.every((o) => scene.children.includes(o)) &&
    cameraPose.every((v, i) => v === camera.matrixWorld.elements[i]) &&
    bridge.userData.collider === collider &&
    renderer.getSize(new THREE.Vector2()).toArray().join() === originalRendererSize.join();
  const missing = (() => {
    try {
      new AuthoredLandscape({ ...landscape, region: 'test:absent' }, 0, { library });
      return '';
    } catch (e) {
      return String(e);
    }
  })();
  renderer.dispose();
  fields.shelters.dispose();
  surface.geometry.dispose();
  surface.material.dispose();
  bridge.geometry.dispose();
  bridge.material.dispose();
  return {
    ...proof,
    stableAfter,
    retained,
    max,
    sampled,
    origin,
    ownership,
    missing,
    empty: flight.residentTiles === 0,
  };
}
Object.assign(window, { fieldHost: exercise });
