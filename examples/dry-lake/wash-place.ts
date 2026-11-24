import * as T from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { perturbNormalHeight } from '../../engine/shading';
import { mulberry32 } from '../../engine/noise';
import { mergeStaticMeshes } from '../../engine/batching';
import type { RunoffCrossing } from '../../modules/water/runoff-crossing';
import { LandGeology } from '../../modules/terrain/geology';
import { basinTerrain } from './place';
import { rainVerge } from './rain-verge';
import {
  washBed,
  washTerrain,
  halfX,
  halfZ,
  roadCentre,
  channelCentre,
  pipeIn,
  pipeOut,
  washGauges,
} from './wash-recipe';

export function washPlace(c: RunoffCrossing, environment: N) {
  const root = new T.Group();
  const terrain = basinTerrain(halfX, halfZ, washTerrain),
    geology = new LandGeology('dry-highlands', 10400);
  terrain.material.vertexColors = false;
  terrain.geometry.setAttribute('terrainColor', terrain.geometry.getAttribute('color'));
  geology.terrain(
    terrain.material,
    TSL.color('#795f42'),
    TSL.float(2),
    TSL.float(0),
    TSL.float(0),
    TSL.float(0),
  );
  root.add(terrain);
  const verge = rainVerge(
    [
      { x: -17, z: -18 },
      { x: 22, z: 18 },
    ],
    (x, z) => (Math.abs(x) <= halfX && Math.abs(z) <= halfZ ? washBed(x, z) : terrain.heightAt(x, z)),
  );
  root.add(verge.root);
  const mesh = new T.PlaneGeometry(2 * halfX, 2 * halfZ, 192, 112);
  mesh.rotateX(-Math.PI / 2);
  const xyz = mesh.getAttribute('position');
  for (let i = 0; i < xyz.count; i++) xyz.setY(i, washBed(xyz.getX(i), xyz.getZ(i)));
  mesh.computeVertexNormals();
  const { positionWorld: p, positionGeometry: local, vec2, vec3, float, smoothstep, mix, abs } = TSL;
  const field = c.water.fieldNode(p.xz),
    wet = smoothstep(-0.006, 0.016, field.r.sub(p.y));
  const coverage = abs(p.x.sub(p.z.mul(p.z).mul(0.09).div(p.z.abs().add(15)).mul(p.z.mul(0.057).sin())));
  const road = float(1).sub(smoothstep(2.4, 2.49, coverage));
  const gravel = TSL.texture(geology.atlas, p.xz.mul(0.39)),
    micro = TSL.texture(geology.atlas, p.xz.mul(3.1));
  const grit = gravel.g.mul(0.41).add(micro.g.mul(0.43)).add(0.06);
  const aggregate = mix(TSL.color('#695444'), TSL.color('#c1a17c'), grit);
  const roadColor = mix(TSL.color('#43423e'), TSL.color('#81776a'), grit);
  const stripe = float(1)
    .sub(smoothstep(0.022, 0.052, coverage.sub(2.17).abs()))
    .mul(smoothstep(0.22, 0.77, grit));
  const shoulder = mix(aggregate, mix(roadColor, TSL.color('#d7c7a7'), stripe.mul(0.75)), road);
  const mat = new T.MeshStandardNodeMaterial();
  mat.colorNode = shoulder.mul(wet.mul(-0.43).add(1));
  mat.roughnessNode = mix(0.9, 0.48, wet);
  mat.normalNode = perturbNormalHeight(gravel.r.mul(0.0035).add(micro.r.mul(0.0006)), float(1));
  const portCut = abs(p.z.sub(pipeIn[2]))
    .lessThan(0.64)
    .and(abs(p.x).lessThan(3.68))
    .and(abs(p.x).greaterThan(2.3))
    .and(p.y.lessThan(mix(pipeIn[1], pipeOut[1], p.x.add(3.575).div(7.15)).add(0.39)));
  mat.maskNode = portCut.not();
  const ground = new T.Mesh(mesh, mat);
  ground.receiveShadow = true;
  root.add(ground);

  const time = TSL.uniform(0),
    pipeFlow = TSL.uniform(0);
  const water = new T.MeshPhysicalNodeMaterial({ ior: 1.333, clearcoat: 1, clearcoatRoughness: 0.095 });
  const bed = local.y.toVarying('washBedHeight');
  const level = c.water.fieldNode(local.xz).r;
  water.positionNode = vec3(local.x, level, local.z);
  const depth = field.r.sub(bed).max(0),
    speed = field.gb.length().min(3);
  water.maskNode = depth.greaterThan(0.00065);
  const phase = time.mul(0.4).fract(),
    alternate = phase.add(0.5).fract();
  const rippleAt = (age: N) => {
    const advected = p.xz.sub(field.gb.mul(age).mul(0.4));
    return TSL.sin(
      advected.x
        .mul(13.4)
        .add(TSL.sin(advected.y.mul(7.1)))
        .add(advected.y.mul(1.7))
        .sub(time.mul(5)),
    );
  };
  // Independent ripple trains break up the sunset reflection. Direction bends with the measured flow.
  const lightWave = TSL.sin(TSL.dot(p.xz, vec2(7.4, 12.1)).sub(time.mul(1.9))).mul(0.00043);
  const ripples = mix(rippleAt(phase), rippleAt(alternate), phase.mul(2).sub(1).abs()).mul(speed.mul(0.0018));
  const plume = p.x.sub(pipeOut[0]),
    cross = p.z.sub(pipeOut[2]).abs();
  const mouth = smoothstep(-0.02, 0.23, plume)
    .mul(float(1).sub(smoothstep(0.5, 4.1, plume)))
    .mul(float(1).sub(smoothstep(0.41, 0.87, cross.div(plume.max(0).mul(0.14).add(1)))));
  const foamNoise = TSL.mx_noise_float(vec3(p.x.mul(5).sub(time.mul(2.5)), p.z.mul(8), time.mul(0.22)));
  const froth = mouth
    .mul(smoothstep(0.055, 0.4, pipeFlow))
    .mul(smoothstep(0.15, 0.66, foamNoise))
    .mul(0.72);
  const optical = float(1).sub(TSL.exp(depth.mul(field.a.mul(8).add(4.8)).negate()));
  const sediment = mix(TSL.color('#425048'), TSL.color('#927457'), smoothstep(0, 0.5, field.a));
  water.colorNode = mix(mix(shoulder.mul(0.46), sediment, optical), TSL.color('#e4dfcf'), froth);
  water.roughnessNode = speed.mul(0.07).add(0.1).add(froth.mul(0.35));
  water.clearcoatNode = froth.oneMinus().mul(0.86);
  water.normalNode = perturbNormalHeight(
    lightWave.add(ripples),
    float(1),
    vec3(0, 1, 0).transformDirection(TSL.cameraViewMatrix),
  );
  water.envNode = environment;
  const sheet = new T.Mesh(mesh, water);
  sheet.receiveShadow = true;
  root.add(sheet);

  const structures = new T.Group();
  const concrete = new T.MeshStandardNodeMaterial(),
    steel = new T.MeshStandardMaterial({ color: '#574e43', metalness: 0.51, roughness: 0.62 });
  const faceTex = TSL.texture(geology.atlas, p.zy.mul(0.83));
  concrete.colorNode = mix(TSL.color('#817566'), TSL.color('#cbc2a8'), faceTex.g).mul(wet.mul(-0.3).add(1));
  concrete.roughness = 0.86;
  const postMat = new T.MeshStandardMaterial({ color: '#e1cc96', roughness: 0.68 });
  const red = new T.MeshStandardMaterial({ color: '#944c3a', roughness: 0.84 });
  function box(
    parent: T.Object3D,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
    m: T.Material,
  ) {
    const o = new T.Mesh(new T.BoxGeometry(sx, sy, sz), m);
    o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = true;
    parent.add(o);
    return o;
  }
  const bucket = c.water.options.culvert!,
    width = bucket.width,
    height = bucket.height;
  for (const [side, point] of [
    [-1, pipeIn],
    [1, pipeOut],
  ] as const) {
    const [x, y, z] = point;
    for (const sign of [-1, 1]) {
      box(structures, 0.47, height + 0.22, 0.17, x, y + height / 2, z + sign * (width / 2 + 0.085), concrete);
      const wing = box(
        structures,
        0.9,
        0.37,
        0.14,
        x + 0.53 * side,
        y + 0.13,
        z + sign * (width / 2 + 0.26),
        concrete,
      );
      wing.rotation.y = -side * sign * 0.37;
    }
    box(structures, 0.47, 0.14, width + 0.34, x, y + height + 0.07, z, concrete);
    box(structures, 0.82, 0.08, width + 0.32, x + side * 0.16, y - 0.045, z, concrete);
  }
  const mid = (pipeIn[1] + pipeOut[1]) / 2,
    span = pipeOut[0] - pipeIn[0],
    slope = Math.atan2(pipeOut[1] - pipeIn[1], span);
  for (const side of [-1, 1])
    box(
      structures,
      span,
      height,
      0.1,
      0,
      mid + height * 0.5,
      pipeIn[2] + side * (width / 2 + 0.05),
      steel,
    ).rotation.z = slope;
  for (const offset of [-0.035, height + 0.035])
    box(structures, span, 0.07, width, 0, mid + offset, pipeIn[2], steel).rotation.z = slope;
  const shutter = box(
    root,
    0.07,
    height,
    width,
    pipeIn[0] - 0.19,
    pipeIn[1] + height * 0.5,
    pipeIn[2],
    steel,
  );
  for (const [x, z] of washGauges) {
    const y = washBed(x, z);
    box(structures, 0.049, 0.85, 0.075, x, y + 0.425, z, postMat);
    for (let i = 0; i < 8; i++)
      box(structures, 0.051, 0.018, i % 2 ? 0.06 : 0.079, x, y + 0.1 * i + 0.05, z, red);
  }
  mergeStaticMeshes(structures);
  root.add(structures);
  // The service road continues over the actual triangulated ground beyond the instrumented crossing.
  for (const sign of [-1, 1]) {
    const verts: number[] = [],
      ind: number[] = [];
    for (let i = 0; i <= 65; i++) {
      const z = sign * (halfZ + i * 2),
        x = roadCentre(z);
      for (const side of [-1, 1]) {
        const wx = x + 2.44 * side;
        const y = i === 0 ? washBed(wx, z) : terrain.heightAt(wx, z) + 0.025;
        verts.push(wx, y, z);
      }
      if (i) {
        const k = (i - 1) * 2;
        ind.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    g.setIndex(ind);
    g.computeVertexNormals();
    const m = new T.MeshStandardNodeMaterial({ side: T.DoubleSide, roughness: 0.91 });
    m.colorNode = mix(roadColor, TSL.color('#d7c7a7'), stripe.mul(0.75));
    root.add(new T.Mesh(g, m));
  }
  // Deposited stones make the edge of the shallow sheet readable at wheel height.
  const rand = mulberry32(7126),
    pebbles = new T.InstancedMesh(
      new T.DodecahedronGeometry(1),
      new T.MeshStandardMaterial({ color: '#ae9470', roughness: 0.91 }),
      440,
    );
  const pose = new T.Object3D(),
    col = new T.Color();
  for (let i = 0; i < pebbles.count; i++) {
    const x = (rand() < 0.5 ? -1 : 1) * (3.9 + rand() * 10.5),
      z = channelCentre(x) + (rand() < 0.5 ? -1 : 1) * (0.9 + rand() ** 1.3 * 4.8);
    const size = 0.018 + rand() ** 3 * 0.14;
    pose.position.set(x, washBed(x, z) + size * 0.08, z);
    pose.scale.set(size * (1 + rand()), size * (0.3 + 0.15 * rand()), size);
    pose.rotation.set(rand() * 0.2, rand() * 6, rand() * 0.18);
    pose.updateMatrix();
    pebbles.setMatrixAt(i, pose.matrix);
    col.setScalar(0.53 + rand() * 0.47);
    pebbles.setColorAt(i, col);
  }
  root.add(pebbles);
  return {
    root,
    update(t: number) {
      time.value = t;
      pipeFlow.value = c.water.culvertDischargeM3s;
      shutter.position.z = pipeIn[2] + width * c.water.culvertOpening;
      shutter.visible = c.water.culvertOpening < 0.999;
    },
    dispose() {
      verge.dispose();
      geology.dispose();
      pebbles.dispose();
      const geoms = new Set<T.BufferGeometry>(),
        mats = new Set<T.Material>();
      root.traverse((obj) => {
        if (obj instanceof T.Mesh) {
          geoms.add(obj.geometry);
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) mats.add(m);
        }
      });
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      root.removeFromParent();
    },
  };
}
