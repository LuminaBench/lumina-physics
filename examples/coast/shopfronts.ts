import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import type { Weather } from '../../modules/weather/weather';

type PlaceBox = (
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
) => THREE.Mesh;

/** Recessed openings face the sea (-X). Each room has an independent dimmer.
 * Local cubemap captures see the same frame, walls and lit interior as the player. */
export function addShopfronts(
  x0: number,
  z0: number,
  ground: (x: number, z: number) => number,
  weather: Weather,
  wall: THREE.Material,
  trim: THREE.Material,
  metal: THREE.Material,
  roof: THREE.Material,
  box: PlaceBox,
) {
  const count = 30,
    centers: THREE.Vector3[] = [];
  const power = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  power.setUsage(THREE.DynamicDrawUsage);
  const interior = new THREE.MeshStandardNodeMaterial({ color: 0x655e50, roughness: 0.88 });
  const dusk = TSL.uniform(0);
  const uv = TSL.uv();
  // A shaded pendant and the broad pool it casts on the back wall.
  const offset = uv.sub(TSL.vec2(0.39, 0.68));
  const lamp = TSL.smoothstep(1, 0.68, offset.mul(TSL.vec2(8.4, 18)).length());
  const wash = offset.mul(TSL.vec2(2.1, 1.4)).length().mul(-2.5).exp();
  interior.emissiveNode = TSL.color(0xffbb80)
    .mul(wash.mul(2.5).add(lamp.mul(5)))
    .mul(TSL.attribute('roomPower', 'float'))
    .mul(dusk);
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('roomPower', power);
  const rooms = new THREE.InstancedMesh(geometry, interior, count);
  rooms.name = 'Independent lamps behind recessed shop windows';
  rooms.receiveShadow = true;
  const pane = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const v = TSL.cameraPosition.sub(TSL.positionWorld).normalize();
  const normal = TSL.vec3(-1, 0, 0);
  const incidence = TSL.dot(v, normal).clamp(0, 1);
  pane.colorNode = weather.reflection(TSL.reflect(v.negate(), normal), 1.4);
  pane.opacityNode = incidence.oneMinus().pow(5).mul(0.89).add(0.055);
  pane.name = 'Coastal window glazing';
  const pose = new THREE.Object3D();
  pose.rotation.y = -Math.PI / 2;
  for (let row = 0; row < 10; row++) {
    const j = row - 4,
      z = z0 + j * 13,
      x = x0 + 14 + (j & 1) * 2;
    const h = 3.2 + ((0.9 * (j + 8)) % 2.4),
      y = ground(x, z),
      front = x - 3;
    const sill = 0.88,
      opening = 1.68,
      head = sill + opening,
      depth = 1.08;
    const foot =
      Math.min(
        y,
        ground(front, z),
        ground(front, z - 4.5),
        ground(front, z + 4.5),
        ground(x + 3, z - 4.5),
        ground(x + 3, z + 4.5),
      ) - 0.28;
    box(wall, x, (foot + y) / 2, z, 6.03, y - foot, 9.03);
    box(wall, x + depth / 2, y + h / 2, z, 6 - depth, h, 9);
    const spacing = 2.68,
      width = 2.1,
      edge = (9 - 2 * spacing - width) / 2;
    const doorBay = row % 3 === 0 ? 0 : 2,
      doorZ = z + (doorBay - 1) * spacing;
    const left = doorZ - width / 2,
      right = doorZ + width / 2;
    box(wall, front + depth / 2, y + sill / 2, (z - 4.5 + left) / 2, depth, sill, left - (z - 4.5));
    box(wall, front + depth / 2, y + sill / 2, (z + 4.5 + right) / 2, depth, sill, z + 4.5 - right);
    box(wall, front + depth / 2, y + (h + head) / 2, z, depth, h - head, 9);
    box(roof, x, y + h + 0.09, z, 6.3, 0.21, 9.3);
    box(trim, front - 0.41, y + head + 0.21, z, 1.15, 0.14, 8.7);
    for (const sign of [-1, 1]) {
      box(wall, front + depth / 2, y + sill + opening / 2, z + sign * (4.5 - edge / 2), depth, opening, edge);
      box(
        wall,
        front + depth / 2,
        y + sill + opening / 2,
        z + (sign * spacing) / 2,
        depth,
        opening,
        spacing - width,
      );
    }
    for (let bay = 0; bay < 3; bay++) {
      const door = bay === doorBay,
        bottom = door ? 0.16 : sill,
        height = head - bottom;
      const i = row * 3 + bay,
        bz = z + (bay - 1) * spacing,
        by = y + bottom + height / 2;
      pose.position.set(front + depth - 0.025, by, bz);
      pose.scale.set(width, height, 1);
      pose.updateMatrix();
      rooms.setMatrixAt(i, pose.matrix);
      centers.push(pose.position.clone());
      power.setX(i, (row + bay) % 4 === 0 ? 0 : 0.64 + 0.17 * (i % 3));
      box(trim, front - 0.065, y + bottom, bz, door ? 0.74 : 0.32, 0.085, width + 0.16);
      box(metal, front + 0.16, by, bz + 0.31, 0.075, height, 0.049);
      if (door) box(metal, front + 0.1, y + 1.03, bz + 0.48, 0.09, 0.36, 0.038);
      box(metal, front + 0.16, by + 0.49, bz, 0.077, 0.05, width);
      // A partial blind casts a shadow inside the recess and gives each bay its own depth.
      const blind = ((i * 7) % 9) * 0.055 + 0.08;
      box(trim, front + 0.37, y + head - blind / 2, bz, 0.035, blind, width - 0.035);
      const glass = box(pane, front + 0.19, by, bz, 0.009, height - 0.018, width - 0.018);
      glass.castShadow = false;
    }
  }
  rooms.computeBoundingSphere();
  return {
    rooms,
    centers,
    pane,
    setSunElevation(degrees: number) {
      dusk.value = 1 - THREE.MathUtils.smoothstep(degrees, -4, 3);
    },
    setPower(index: number, value: number) {
      if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(value))
        throw new RangeError('A room needs a valid window index and finite brightness.');
      power.setX(index, THREE.MathUtils.clamp(value, 0, 1));
      power.needsUpdate = true;
    },
  };
}
