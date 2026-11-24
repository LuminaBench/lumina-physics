import * as THREE from 'three/webgpu';
import { TSL, type AuthoredLandscape } from '../physics';
import { roadGeometry, Cart, axle } from './crossing';
import { roadZ, deckHeight, bridgeHalf, roadHalf } from './valley';
export function buildCrossing(land: AuthoredLandscape, scene: THREE.Scene) {
  const road = new THREE.MeshStandardNodeMaterial({ roughness: 0.89 });
  const p = TSL.positionWorld,
    marks = land.tracks.sampleNode(p.xz);
  const q = p.x.add(20.9).div(4.25).pow2().add(p.z.sub(0.77).div(0.61).pow2());
  const clay = TSL.smoothstep(1.0, 0.84, q);
  const grit = p.x.mul(12).sin().mul(p.z.mul(16).cos()).mul(0.034).add(0.97);
  const film = TSL.uniform(0.19);
  const deck = TSL.step(p.x.abs(), bridgeHalf);
  const wet = TSL.max(film.mul(deck).mul(marks.b.oneMinus()), marks.r);
  const substrate = TSL.mix(TSL.color('#746a68'), TSL.color('#995c40'), clay);
  road.colorNode = TSL.mix(substrate, TSL.color('#a85d39'), marks.g.mul(0.91))
    .mul(grit)
    .mul(wet.mul(-0.4).add(1));
  road.roughnessNode = TSL.mix(0.89, 0.37, wet);
  const lane = new THREE.Mesh(roadGeometry(land), road);
  lane.name = 'Chalk crossing, surfaced carriageway';
  scene.add(lane);
  const stone = new THREE.MeshStandardMaterial({ color: '#aca48d', roughness: 0.96 });
  const iron = new THREE.MeshStandardMaterial({ color: '#554b42', roughness: 0.81 });
  const wood = new THREE.MeshStandardMaterial({ color: '#85553d', roughness: 0.84 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#373435', roughness: 0.93 });
  const cart = new THREE.Group();
  const cargo = new THREE.MeshStandardMaterial({ color: '#477068', roughness: 0.77 });
  function box(
    parent: THREE.Object3D,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  box(scene, stone, 0, deckHeight - 0.35, 0, bridgeHalf * 2, 0.65, roadHalf * 2 + 0.22);
  for (const x of [-15, -5, 5, 15])
    for (const z of [-1.78, 1.78]) box(scene, stone, x, -0.3, z, 1.4, 6.1, 0.73);
  for (const z of [-2.2, 2.2]) {
    for (let x = -16; x <= 16; x += 4) box(scene, stone, x, deckHeight + 0.45, z, 0.25, 0.97, 0.24);
    box(scene, iron, 0, deckHeight + 0.82, z, 32, 0.1, 0.09);
  }
  box(cart, wood, 0, 0.53, 0, 2.77, 0.19, 1.4);
  for (const z of [-0.64, 0.64]) box(cart, cargo, 0, 0.82, z, 2.6, 0.46, 0.09);
  for (const x of [-1.25, 1.25]) box(cart, cargo, x, 0.82, 0, 0.09, 0.46, 1.24);
  const wheels = axle.map(() => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18), rubber);
    w.rotation.x = Math.PI / 2;
    scene.add(w);
    return w;
  });
  scene.add(cart);
  return {
    update(driver: Cart) {
      film.value = driver.baseFilm;
      cart.position.set(driver.x, driver.contactHeights.reduce((a, b) => a + b, 0) / 4, roadZ(driver.x));
      cart.rotation.z = Math.atan2(driver.contactHeights[0] - driver.contactHeights[2], 1.88);
      for (const [i, w] of wheels.entries()) {
        w.position.set(driver.x + axle[i].dx, driver.contactHeights[i] + 0.34, roadZ(driver.x) + axle[i].dz);
        w.rotation.y = -driver.x / 0.34;
      }
    },
  };
}
