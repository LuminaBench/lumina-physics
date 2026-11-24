import * as THREE from 'three/webgpu';
import { createLuminaWorld, QUALITY_TIERS, terrainReading, type QualityTier } from './physics';
import { project } from './garden/project';
import { flowerGeometry, colonies } from './garden/flowers';
import { Cart } from './garden/crossing';
import { buildCrossing } from './garden/view';
import { roadZ } from './garden/valley';
const $ = (id: string) => document.getElementById(id)!;
const url = new URL(location.href),
  revised = url.searchParams.get('flowers') === 'scalloped';
async function open() {
  const spec = project(revised);
  const tier = url.searchParams.get('tier') as QualityTier;
  if (QUALITY_TIERS.includes(tier)) spec.profile.quality = tier;
  const world = await createLuminaWorld(spec.profile, {
    ...spec.runtime,
    canvas: document.querySelector('canvas')!,
    forceWebGL: url.searchParams.get('backend') === 'webgl2',
    physics: false,
  });
  const { engine } = world,
    land = world.land!;
  const plants = colonies(land, spec.recipe),
    pose = new THREE.Object3D();
  if (!plants.length) throw new Error('No eligible Vesper-cup hollow');
  const geometry = flowerGeometry(spec.recipe);
  const flowers = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.88,
    }),
    plants.length,
  );
  for (const [i, f] of plants.entries()) {
    pose.position.set(f.x, f.y, f.z);
    pose.rotation.y = f.yaw;
    pose.scale.setScalar(f.scale);
    pose.updateMatrix();
    flowers.setMatrixAt(i, pose.matrix);
  }
  flowers.computeBoundingSphere();
  flowers.name = spec.bloomId;
  engine.scene.add(flowers);
  const cart = new Cart(land),
    bridge = buildCrossing(land, engine.scene),
    probe = new THREE.Vector3();
  let view = '',
    rolling = false,
    keySpeed = 0;
  const tree = world.foliage.grove.nearest(-27, 7, undefined, true)!;
  const flower = plants.reduce((a, b) => (a.x * a.x + a.z * a.z < b.x * b.x + b.z * b.z ? a : b));
  const read = terrainReading();
  const camera = engine.camera;
  camera.near = 0.06;
  camera.updateProjectionMatrix();
  function place() {
    if (view === 'bridge') {
      camera.position.set(cart.x - 4.8, Math.max(3.1, ...cart.contactHeights) + 2.75, roadZ(cart.x) + 1.68);
      camera.lookAt(cart.x - 1.15, cart.contactHeights[0] + 0.12, roadZ(cart.x) + 0.05);
    } else if (view === 'flowers') {
      const x = flower.x + 0.54,
        z = flower.z + 0.92;
      camera.position.set(x, Math.max(flower.y + 0.64, land.surface.sample(x, z, read).height + 0.37), z);
      camera.lookAt(flower.x, flower.y + 0.28, flower.z);
    } else if (view === 'tree') {
      const x = tree.x + 12.5,
        z = tree.z + 15;
      camera.position.set(x, Math.max(tree.y + 4.1, land.surface.sample(x, z, read).height + 1.6), z);
      camera.lookAt(tree.x, tree.y + 4.7 * tree.scale, tree.z);
    } else {
      camera.position.set(-32, 18.5, 39);
      camera.lookAt(-3, 1.8, -12);
    }
    camera.updateMatrixWorld(true);
  }
  function show(next: string) {
    view = ['tree', 'flowers', 'bridge', 'valley'].includes(next) ? next : 'valley';
    $('info').textContent =
      view === 'tree'
        ? 'Cindercomb · wind-pruned western limbs'
        : view === 'flowers'
          ? revised
            ? 'Scalloped Vesper cup · eight flutes'
            : 'Vesper cup · five flutes'
          : view === 'bridge'
            ? 'Cross the clay seam · hold → or ← to roll'
            : 'Chalk stream · October, 4:12 pm solar time';
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    $('status').textContent = engine.backend.toUpperCase();
    place();
  }
  function replay() {
    cart.reset();
    show('bridge');
    rolling = true;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    b.onclick = () => show(b.dataset.view!);
  $('pass').onclick = replay;
  $('revision').textContent = revised ? 'Original flowers' : 'Change flowers';
  $('revision').onclick = () => {
    url.searchParams.set('flowers', revised ? 'original' : 'scalloped');
    url.searchParams.set('view', view);
    location.assign(url);
  };
  addEventListener('keydown', (e) => {
    if (['ArrowRight', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      rolling = false;
      keySpeed = e.key === 'ArrowRight' ? 3.1 : -3.1;
      show('bridge');
    } else if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      replay();
    }
  });
  addEventListener('keyup', (e) => {
    if (['ArrowRight', 'ArrowLeft'].includes(e.key)) keySpeed = 0;
  });
  addEventListener('blur', () => {
    keySpeed = 0;
  });
  const prior = engine.onUpdate;
  let readoutTime = 0;
  show(url.searchParams.get('view') ?? 'valley');
  if (url.searchParams.has('roll')) replay();
  engine.onUpdate = (dt, t) => {
    prior?.(dt, t);
    cart.step(dt, rolling && cart.x < -11 ? 2.6 : keySpeed);
    bridge.update(cart);
    if (view === 'bridge') place();
    if (cart.x >= -11) rolling = false;
    if (t - readoutTime > 0.25) {
      readoutTime = t;
      $('status').textContent =
        view === 'bridge'
          ? 'Loaded tread ' +
            Math.round(cart.wheels[0].sediment * 100) +
            '% · deck film ' +
            Math.round(cart.baseFilm * 100) +
            '%'
          : engine.backend.toUpperCase();
    }
  };
  Object.assign(window, {
    reach: {
      world,
      cart,
      plants,
      spec,
      tree,
      show,
      replay,
      read: (x: number, z: number) => land.tracks.sampleAt(x, z, probe).toArray(),
    },
  });
  engine.start();
}
open().catch((error) => {
  $('info').textContent = String(error);
  console.error(error);
});
