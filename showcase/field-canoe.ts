import * as THREE from 'three/webgpu';
import { TSL } from '../engine/tsl';

/** An open displacement hull with a curved keel, flared sides and two thwarts. */
export function fieldCanoe() {
  const pos: number[] = [],
    colors: number[] = [],
    ix: number[] = [];
  const paint = new THREE.Color('#924d32'),
    inside = new THREE.Color('#a68961'),
    rim = new THREE.Color('#524332');
  for (let i = 0; i <= 24; i++) {
    const q = i / 12 - 1,
      half = Math.pow(Math.max(0, 1 - q * q), 0.77) * 0.52,
      rocker = q * q * 0.24;
    for (const [side, level, c] of [
      [-1, 0.27, rim],
      [-0.93, 0.22, inside],
      [-0.54, -0.07, inside],
      [0, -0.13, inside],
      [0.54, -0.07, inside],
      [0.93, 0.22, inside],
      [1, 0.27, rim],
      [0.8, -0.03, paint],
      [0, -0.2, paint],
      [-0.8, -0.03, paint],
      [-1, 0.27, rim],
    ] as const) {
      pos.push(side * half, level + rocker, q * 2.05);
      colors.push(c.r, c.g, c.b);
    }
    if (i)
      for (let j = 0; j < 10; j++) {
        const a = (i - 1) * 11 + j;
        ix.push(a, a + 11, a + 1, a + 1, a + 11, a + 12);
      }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(ix);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.59,
    side: THREE.DoubleSide,
  });
  const root = new THREE.Mesh(geo, mat),
    seat = new THREE.BoxGeometry(0.77, 0.07, 0.24),
    wood = new THREE.MeshStandardNodeMaterial({ color: '#795f45', roughness: 0.72 });
  for (const z of [-0.87, 0.72]) {
    const bench = new THREE.Mesh(seat, wood);
    bench.position.set(0, 0.18, z);
    root.add(bench);
  }
  root.name = 'Marsh canoe';
  root.visible = false;
  const cloud = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    mud = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      color: '#968567',
    });
  const q = TSL.uv().sub(0.5),
    edge = q
      .length()
      .mul(2)
      .add(q.x.mul(19).sin().mul(q.y.mul(23).cos()).mul(0.09));
  mud.opacityNode = TSL.smoothstep(1, 0.22, edge).mul(0.43).mul(TSL.attribute('density', 'float'));
  const density = new THREE.InstancedBufferAttribute(new Float32Array(16), 1);
  cloud.setAttribute('density', density);
  const silt = new THREE.InstancedMesh(cloud, mud, 16);
  silt.name = 'Suspended channel silt';
  silt.frustumCulled = false;
  silt.count = 0;
  const points = Array.from({ length: 16 }, () => ({ x: 0, z: 0, life: 0 })),
    pose = new THREE.Object3D();
  let slot = 0;
  return {
    root,
    silt,
    stir(x: number, z: number) {
      const p = points[slot];
      p.x = x;
      p.z = z;
      p.life = 1;
      slot = (slot + 1) % points.length;
    },
    update(dt: number, height: number, velocity: THREE.Vector3) {
      let n = 0;
      for (const p of points) {
        if (p.life <= 0) continue;
        p.life -= dt * 0.24;
        if (p.life <= 0) continue;
        p.x += velocity.x * dt;
        p.z += velocity.z * dt;
        pose.position.set(p.x, height + 0.025, p.z);
        pose.scale.set(1.9 - p.life, 1, 2.8 - 1.6 * p.life);
        pose.updateMatrix();
        silt.setMatrixAt(n, pose.matrix);
        density.setX(n++, p.life);
      }
      silt.count = n;
      if (n) {
        silt.instanceMatrix.needsUpdate = true;
        density.needsUpdate = true;
      }
    },
    dispose() {
      root.removeFromParent();
      silt.removeFromParent();
      silt.dispose();
      cloud.dispose();
      mud.dispose();
      geo.dispose();
      mat.dispose();
      seat.dispose();
      wood.dispose();
    },
  };
}
