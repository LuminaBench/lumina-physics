import * as THREE from 'three/webgpu';
import { TSL } from '../engine/tsl';
import { generateRegionMap, regionHeight, riverCenter } from '../modules/landscape/earth';
import type { RegionRecipe } from '../modules/landscape/library';
import { terrainReading } from '../modules/terrain/surface';
import type { ProfileWorld } from '../modules/weather/outdoor-world';

export const crossingZ = -40;
export const woodedRoad = (x: number) => crossingZ + 2 * Math.sin(x * 0.021);
export const roadClear = (x: number, z: number) => Math.abs(z - woodedRoad(x)) > 3.25;

/** Blend the two road approaches into a shallow embankment. The channel between
 * abutments stays open and is sampled separately by the bridge deck. */
export function crossingHeightmap(region: RegionRecipe, seed: number) {
  const ground = regionHeight(region, seed),
    centre = riverCenter(crossingZ, seed),
    z = woodedRoad(centre);
  const deckY = Math.max(ground(centre - 19, z), ground(centre + 19, z), 2.55);
  const ss = THREE.MathUtils.smoothstep;
  return generateRegionMap(
    {
      ...region,
      shape(x, z, base, seed) {
        const natural = region.shape?.(x, z, base, seed) ?? base;
        const bank = Math.abs(x - centre),
          offset = Math.abs(z - woodedRoad(x));
        const alpha = ss(bank, 12, 16.6) * (1 - ss(bank, 38, 72)) * (1 - ss(offset, 3.2, 9.5));
        const slope = Math.max(0, bank - 17) * 0.062;
        return THREE.MathUtils.lerp(natural, deckY + slope - 0.013 * Math.min(3, offset), alpha);
      },
    },
    seed,
  );
}

/** The bridge is a second contact surface above the channel. The riverbed remains
 * available for buoyancy, water optics and actors walking underneath it. */
export function fieldCrossing(world: ProfileWorld) {
  const land = world.land!,
    form = land.region.form,
    root = new THREE.Group(),
    read = terrainReading();
  const ground = (x: number, z: number) => world.terrain.sample(x, z, read).height;
  const centre = riverCenter(crossingZ, land.seeds.terrain);
  const hasDeck = form === 'wood';
  const z = woodedRoad(centre),
    left = centre - 17,
    right = centre + 17;
  const y0 = ground(left, z) + 0.02,
    y1 = ground(right, z) + 0.02,
    grade = (y1 - y0) / (right - left);
  const deckHeight = (x: number) => y0 + (x - left) * grade;
  const overDeck = (x: number, z0: number) => hasDeck && x >= left && x <= right && Math.abs(z0 - z) <= 2.65;
  const timber = new THREE.MeshStandardNodeMaterial({ color: '#736149', roughness: 0.86 });
  const iron = new THREE.MeshStandardNodeMaterial({ color: '#404947', roughness: 0.55, metalness: 0.46 });
  const asphalt = new THREE.MeshStandardNodeMaterial({ color: '#535751', roughness: 0.82 });
  const grain = TSL.fract(
    TSL.sin(TSL.dot(TSL.floor(TSL.positionWorld.xz.mul(67)), TSL.vec2(12.9898, 78.233))).mul(43758.5453),
  );
  const joints = TSL.smoothstep(0.016, 0.004, TSL.positionWorld.x.mul(0.2).fract());
  const trail = land.tracks.sampleNode(TSL.positionWorld.xz);
  asphalt.colorNode = TSL.mix(TSL.color('#535751'), TSL.color('#6b4e34'), trail.g)
    .mul(trail.r.mul(0.54).oneMinus())
    .mul(grain.mul(0.22).add(0.8))
    .mul(joints.mul(0.27).oneMinus());
  asphalt.roughnessNode = TSL.float(0.84).sub(trail.r.mul(0.57)).sub(land.rain.mul(0.12));
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const instances = new Map<THREE.Material, THREE.Matrix4[]>(),
    pose = new THREE.Object3D();
  function part(
    m: THREE.Material,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    tilt = 0,
  ) {
    pose.position.set(x, y, z);
    pose.rotation.set(0, 0, tilt);
    pose.scale.set(w, h, d);
    pose.updateMatrix();
    const rows = instances.get(m) ?? [];
    rows.push(pose.matrix.clone());
    instances.set(m, rows);
  }
  const R = world.engine.physics?.RAPIER,
    physics = world.engine.physics;
  const colliders: ReturnType<typeof physics.world.createCollider>[] = [];
  if (hasDeck) {
    const angle = Math.atan(grade);
    part(
      asphalt,
      centre,
      deckHeight(centre) - 0.12,
      z,
      (right - left) * Math.hypot(1, grade),
      0.24,
      5.3,
      angle,
    );
    for (const side of [-1, 1]) {
      part(iron, centre, deckHeight(centre) - 0.45, z + side * 2.17, 34, 0.52, 0.24, angle);
      part(timber, centre, deckHeight(centre) + 0.89, z + side * 2.57, 34, 0.13, 0.13, angle);
      for (let x = left + 0.3; x < right; x += 3.04)
        part(timber, x, deckHeight(x) + 0.46, z + side * 2.57, 0.12, 0.96, 0.12);
      for (let x = centre - 10; x <= centre + 10; x += 10) {
        const base = ground(x, z + side * 2);
        part(
          timber,
          x,
          (deckHeight(x) + base) / 2,
          z + side * 2,
          0.35,
          Math.max(0.2, deckHeight(x) - base),
          0.39,
        );
      }
    }
    if (R)
      colliders.push(
        physics.world.createCollider(
          R.ColliderDesc.cuboid(17 * Math.hypot(1, grade), 0.12, 2.65)
            .setTranslation(centre, deckHeight(centre) - 0.12, z)
            .setRotation({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) }),
        ),
      );
  }
  let runoffOutlet: { x: number; z: number } | undefined;
  if (form === 'street') {
    const brick = new THREE.MeshStandardNodeMaterial({ color: '#82654f', roughness: 0.86 });
    const sill = new THREE.MeshStandardNodeMaterial({ color: '#6c756e', roughness: 0.64 });
    const windowGlass = new THREE.MeshStandardNodeMaterial({
      color: '#414f52',
      metalness: 0.37,
      roughness: 0.23,
      emissive: '#bf874a',
      emissiveIntensity: 0.15,
    });
    const glow = new THREE.MeshStandardNodeMaterial({
      color: '#fae9bd',
      emissive: '#ffca92',
      emissiveIntensity: 3,
    });
    for (let i = -4; i <= 4; i++) {
      const z = i * 19,
        x = 8 * Math.sin(z * 0.015) + 5.4,
        y = ground(x, z);
      const side = i % 2 === 0 ? 1 : -1,
        bx = 8 * Math.sin(z * 0.015) + side * 13.2,
        bz = z + 2.2,
        by = ground(bx, bz),
        width = 7.3 + Math.abs(i % 3),
        height = 3.65 + (Math.abs(i) % 2) * 1.16;
      if (i === -3) runoffOutlet = { x: bx - side * (width * 0.5 + 0.12), z: bz - 4.3 };
      part(brick, bx, by + height / 2, bz, width, height, 9.7);
      part(sill, bx, by + height + 0.06, bz, width + 0.5, 0.17, 10.1);
      part(iron, bx - side * (width * 0.5 + 0.13), by + height, bz, 0.17, 0.19, 10.1);
      part(iron, bx - side * (width * 0.5 + 0.12), by + height * 0.48, bz - 4.3, 0.14, height, 0.14);
      for (let j = -1; j <= 1; j++) {
        part(sill, bx - side * (width * 0.5 + 0.01), by + 1.69, bz + j * 2.7, 0.16, 1.8, 1.54);
        part(windowGlass, bx - side * (width * 0.5 + 0.11), by + 1.73, bz + j * 2.7, 0.04, 1.56, 1.27);
      }
      part(iron, x, y + 2.55, z, 0.09, 5.1, 0.09);
      part(iron, x - 0.73, y + 5.1, z, 1.54, 0.1, 0.12);
      part(glow, x - 1.45, y + 5, z, 0.64, 0.07, 0.23);
      part(iron, x - 1.65, y - 0.01, z + 0.8, 0.43, 0.06, 0.78);
      for (let j = 0; j < 8; j++) part(asphalt, x - 1.65, y + 0.023, z + 0.48 + j * 0.09, 0.39, 0.025, 0.024);
      if (Math.abs(i) <= 1) {
        const light = new THREE.PointLight('#ffd5a1', 85, 16, 2);
        light.position.set(x - 1.45, y + 4.9, z);
        root.add(light);
      }
    }
  }
  for (const [m, rows] of instances) {
    const mesh = new THREE.InstancedMesh(cube, m, rows.length);
    rows.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
  world.engine.scene.add(root);
  return {
    root,
    centre,
    left,
    right,
    z,
    overDeck,
    runoffOutlet,
    height: (x: number, z: number) => (overDeck(x, z) ? deckHeight(x) : ground(x, z)),
    contact: (x: number, z: number) =>
      overDeck(x, z)
        ? { soil: 'asphalt' as const, water: 0, film: land.earth.rain * 0.6, moisture: 0 }
        : undefined,
    dispose() {
      for (const c of colliders) physics.world.removeCollider(c, true);
      root.removeFromParent();
      root.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
      for (const m of new Set([timber, iron, asphalt, ...instances.keys()])) m.dispose();
      cube.dispose();
    },
  };
}
