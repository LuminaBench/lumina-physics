import * as T from 'three/webgpu';
import { TSL } from '../../engine/tsl';

const smooth = (a: number, b: number, v: number) => T.MathUtils.smoothstep(v, a, b);
const bump = (x: number) => Math.exp(-x * x);
export function saltCover(x: number, z: number) {
  const r = Math.hypot((x + 0.32 * Math.sin(z * 0.81)) / 15.25, (z + 0.55 * Math.sin(x * 1.1)) / 24.1);
  return 1 - smooth(0.79, 0.97, r);
}
function ridgeLine(a: number) {
  return 1 + 0.19 * Math.sin(3 * a + 0.4) + 0.11 * Math.cos(7 * a) + 0.028 * Math.cos(29 * a);
}
export function lakeBed(x: number, z: number) {
  const r = Math.hypot(x, z),
    a = Math.atan2(z, x);
  const near =
    0.022 +
    0.008 * Math.sin(x * 0.7 + z * 0.28) +
    0.01 * Math.cos(z * 0.64 - x * 0.34) -
    0.056 * Math.exp(-(((x - 1.45 + Math.sin(z * 0.36) * 0.4) / 0.78) ** 2 + (z / 5.4) ** 2));
  if (r <= 16) return near;
  const rim = 2.4 * smooth(16, 68, r) * (0.6 + 0.28 * Math.sin(3 * a) + 0.12 * Math.sin(z * 0.07));
  const wash = 2.8 * bump((x - 28 - 5 * Math.sin(z * 0.033)) / 3.8) * smooth(12, 48, r);
  // Nested escarpments have wide talus slopes, sharper cliffs and broken caprock.
  // Talus below a resistant cap slopes gradually until a narrower cliff band, with an eroded top.
  const mesa = (cx: number, cz: number, rx: number, rz: number, h: number) => {
    const xx = x - cx,
      zz = z - cz;
    const warp = 0.066 * Math.sin(xx * 0.012 + zz * 0.005) + 0.038 * Math.sin(zz * 0.028 - xx * 0.009);
    const d = Math.pow(Math.abs(xx / rx) ** 3.1 + Math.abs(zz / rz) ** 3.1, 1 / 3.1) + warp;
    const talus = (1 - smooth(0.76, 1.65, d)) * 0.44;
    const wall = (1 - smooth(0.71, 0.88, d)) * 0.46;
    const cap = (1 - smooth(0.64, 0.75, d)) * 0.1;
    return h * (talus + wall + cap) * (1 + 0.022 * Math.sin(xx * 0.026) + 0.014 * Math.cos(zz * 0.017));
  };
  const farRidge = ridgeLine(a);
  const oldRange =
    95 * bump((r - 1550 * farRidge) / 430) + 190 * bump((r - 2900 * (1.2 + 0.32 * Math.cos(4 * a))) / 600);
  const table =
    mesa(-470, 760, 420, 160, 95) +
    mesa(440, 620, 270, 140, 77) +
    mesa(60, 1280, 380, 245, 174) +
    mesa(-1000, -560, 420, 225, 127) +
    mesa(790, -250, 310, 240, 117);
  return near + rim + smooth(22, 180, r) * (table + oldRange) - wash;
}
export function basinTerrain(halfX: number, halfZ: number) {
  const points: number[] = [],
    indices: number[] = [],
    colour: number[] = [];
  const c = new T.Color(),
    plain = new T.Color('#a58668'),
    lower = new T.Color('#99745b'),
    cliff = new T.Color('#9f7062');
  const slices = 384,
    rings = 135;
  for (let j = 0; j <= rings; j++)
    for (let i = 0; i < slices; i++) {
      const a = (2 * Math.PI * i) / slices,
        ca = Math.cos(a),
        sa = Math.sin(a);
      const edge = Math.min(halfX / Math.max(1e-9, Math.abs(ca)), halfZ / Math.max(1e-9, Math.abs(sa)));
      const r = edge + Math.expm1((j / rings) * Math.log(5201));
      const x = r * ca,
        z = r * sa,
        y = lakeBed(x, z);
      points.push(x, y, z);
      const strata = Math.sin(y * 0.3 + 0.16 * Math.sin(x * 0.023) + z * 0.0014);
      c.copy(plain)
        .lerp(lower, smooth(20, 120, r))
        .lerp(cliff, smooth(25, 160, y));
      c.multiplyScalar(1 + smooth(18, 140, r) * (0.13 * strata + 0.055 * Math.sin(x * 0.13 + z * 0.055)));
      colour.push(c.r, c.g, c.b);
      if (j) {
        const k = (j - 1) * slices + i,
          next = (j - 1) * slices + ((i + 1) % slices);
        indices.push(k, next, k + slices, next, next + slices, k + slices);
      }
    }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(points, 3));
  g.setAttribute('color', new T.Float32BufferAttribute(colour, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  const mesh = new T.Mesh(
    g,
    new T.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.91, side: T.FrontSide }),
  );
  return mesh;
}
export function surveyCart() {
  const root = new T.Group(),
    cargo = new T.Group(),
    wheels: T.Group[] = [];
  const iron = new T.MeshStandardMaterial({ color: '#3f4946', roughness: 0.53, metalness: 0.69 });
  const tire = new T.MeshStandardMaterial({ color: '#393833', roughness: 0.86 });
  const skin = new T.MeshStandardMaterial({ color: '#bcaa7d', roughness: 0.64, metalness: 0.22 });
  const cases = new T.MeshStandardMaterial({ color: '#625e4c', roughness: 0.79 });
  const bolt = new T.MeshStandardMaterial({ color: '#a2a6a1', roughness: 0.42, metalness: 0.76 });
  function box(
    parent: T.Object3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    l: number,
    m: T.Material,
  ) {
    const obj = new T.Mesh(new T.BoxGeometry(w, h, l), m);
    obj.position.set(x, y, z);
    obj.castShadow = obj.receiveShadow = true;
    parent.add(obj);
  }
  function rod(a: T.Vector3, b: T.Vector3, r: number, mat: T.Material) {
    const d = b.clone().sub(a),
      m = new T.Mesh(new T.CylinderGeometry(r, r, d.length(), 10), mat);
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    m.castShadow = true;
    root.add(m);
  }
  box(root, 0, 0.31, 0, 0.82, 0.075, 1.38, skin);
  for (const side of [-1, 1]) {
    box(root, side * 0.395, 0.4, 0, 0.032, 0.14, 1.38, skin);
    rod(new T.Vector3(side * 0.32, 0.33, -0.57), new T.Vector3(side * 0.32, 0.81, -1.06), 0.021, iron);
  }
  rod(new T.Vector3(-0.33, 0.81, -1.06), new T.Vector3(0.33, 0.81, -1.06), 0.024, tire);
  for (const z of [0.47, -0.47]) {
    rod(new T.Vector3(-0.49, 0.19, z), new T.Vector3(0.49, 0.19, z), 0.027, iron);
    for (const x of [-0.46, 0.46]) {
      const group = new T.Group();
      group.position.set(x, 0.19, z);
      root.add(group);
      wheels.push(group);
      const rubber = new T.Mesh(new T.TorusGeometry(0.148, 0.042, 10, 30), tire);
      rubber.rotation.y = Math.PI / 2;
      rubber.castShadow = true;
      group.add(rubber);
      const hub = new T.Mesh(new T.CylinderGeometry(0.106, 0.115, 0.073, 24), iron);
      hub.rotation.z = Math.PI / 2;
      group.add(hub);
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 0.4;
        box(group, Math.sign(x) * 0.042, 0.07 * Math.sin(a), 0.07 * Math.cos(a), 0.012, 0.016, 0.016, bolt);
      }
    }
  }
  root.add(cargo);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.237;
    box(cargo, x, 0.53, 0.07, 0.219, 0.33, 0.82, cases);
    box(cargo, x, 0.71, 0.07, 0.225, 0.037, 0.83, skin);
    for (const z of [-0.2, 0.34]) box(cargo, x, 0.735, z, 0.22, 0.021, 0.038, iron);
  }
  return { root, cargo, wheels };
}
export function poolMaterial(env: any) {
  const mat = new T.MeshPhysicalNodeMaterial({
    color: '#665541',
    roughness: 0.12,
    metalness: 0,
    ior: 1.333,
    clearcoat: 1,
    clearcoatRoughness: 0.045,
  });
  mat.envNode = env;
  const p = TSL.positionWorld.xz;
  const nx = p.x.mul(6.4).add(p.y.mul(3.1)).add(TSL.time.mul(1.6)).cos().mul(0.022);
  const nz = p.x.mul(3.2).sub(p.y.mul(9.3)).add(TSL.time.mul(1.1)).sin().mul(0.017);
  mat.normalNode = TSL.vec3(nx, 1, nz).normalize().transformDirection(TSL.cameraViewMatrix);
  return mat;
}

/** A dry pump shelter with an open doorway and a practical light that can be switched off. */
export function pumpHouse() {
  const root = new T.Group();
  const plaster = new T.MeshStandardMaterial({ color: '#ae9e81', roughness: 0.92 });
  const inside = new T.MeshStandardMaterial({ color: '#75624d', roughness: 0.89 });
  const painted = new T.MeshStandardMaterial({ color: '#586a63', roughness: 0.73, metalness: 0.12 });
  const steel = new T.MeshStandardMaterial({ color: '#867b67', roughness: 0.72, metalness: 0.49 });
  const lamp = new T.MeshStandardMaterial({ color: '#f0deb4', emissive: '#ffcb87', emissiveIntensity: 2 });
  function block(x: number, y: number, z: number, w: number, h: number, d: number, mat: T.Material) {
    const mesh = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  }
  block(0, 0.1, 0, 2.36, 0.16, 1.86, inside);
  block(-1.07, 0.92, 0, 0.12, 1.63, 1.67, plaster);
  block(1.07, 0.92, 0, 0.12, 1.63, 1.67, plaster);
  block(0, 0.92, 0.78, 2.08, 1.62, 0.11, inside);
  block(-0.77, 0.92, -0.78, 0.55, 1.62, 0.11, plaster);
  block(0.77, 0.92, -0.78, 0.55, 1.62, 0.11, plaster);
  block(0, 1.65, -0.81, 2.22, 0.18, 0.16, painted);
  for (const x of [-0.53, 0.53]) block(x, 0.89, -0.83, 0.072, 1.5, 0.09, painted);
  // Folded sheet-metal roofing, with a drip edge and two purlins visible inside the overhang.
  const points: number[] = [],
    indices: number[] = [];
  for (let i = 0; i <= 108; i++) {
    const x = -1.34 + (2.68 * i) / 108,
      fold = 0.015 * Math.cos((i * Math.PI) / 2);
    points.push(x, 1.79 + fold, -1.13, x, 1.99 + fold, 1.02);
    if (i) {
      const k = 2 * (i - 1);
      indices.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(points, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  steel.side = T.DoubleSide;
  const roof = new T.Mesh(g, steel);
  roof.castShadow = roof.receiveShadow = true;
  root.add(roof);
  block(0, 1.76, -1.11, 2.67, 0.057, 0.033, steel);
  for (const z of [-0.76, 0.7]) block(0, 1.76 + (z + 0.76) * 0.09, z, 2.52, 0.087, 0.085, painted);
  block(0, 1.27, 0.64, 0.46, 0.35, 0.13, painted);
  const pipe = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 1.26, 14), steel);
  pipe.position.set(-0.63, 0.78, 0.24);
  pipe.castShadow = true;
  root.add(pipe);
  block(0.17, 1.48, 0.62, 0.29, 0.12, 0.135, lamp);
  const light = new T.PointLight('#ffc686', 16, 5.1, 2);
  light.position.set(0.16, 1.41, 0.39);
  root.add(light);
  return { root, light, lamp };
}
