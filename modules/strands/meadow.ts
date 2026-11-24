import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { terrainReading, type TerrainSurface } from '../terrain/surface';
import type { MeadowWind } from './meadow-wind';

const BLADES = 384,
  STEPS = [384, 170, 48];
const PATCH = 2.15;
type Chunk = { box: THREE.Box3; patches: number[] };
function tuft(biome: string, reed: boolean, limit: number) {
  const rand = mulberry32(reed ? 471 : 9127),
    pos: number[] = [],
    norm: number[] = [],
    data: number[] = [],
    indices: number[] = [];
  const dry = biome === 'dry-highlands',
    coast = biome === 'coastal-cliffs';
  const clumps = Array.from({ length: 49 }, () => [
    (rand() - 0.5) * PATCH * 1.07,
    (rand() - 0.5) * PATCH * 1.07,
    0.7 + 0.58 * rand(),
  ]);
  function vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    nz: number,
    t: number,
    rank: number,
    kind: number,
  ) {
    pos.push(x, y, z);
    norm.push(nx, 0.74, nz);
    data.push(t, rank, kind);
  }
  for (let b = 0; b < limit; b++) {
    const clump = clumps[b % clumps.length],
      a = rand() * Math.PI * 2,
      spread = 0.23 * Math.sqrt(rand());
    const x = b % 4 === 0 ? (rand() - 0.5) * PATCH : clump[0] + Math.cos(a) * spread,
      z = b % 4 === 0 ? (rand() - 0.5) * PATCH : clump[1] + Math.sin(a) * spread,
      angle = a + rand() * 1.8;
    const nx = Math.cos(angle),
      nz = Math.sin(angle),
      wx = -nz,
      wz = nx;
    const h = (reed ? 1.16 : dry ? 0.34 : coast ? 0.49 : 0.4) * clump[2] * (0.57 + 0.72 * rand());
    const width = (reed ? 0.019 : 0.012) * (1 + rand() * 0.68),
      bend = h * (reed ? 0.17 : coast ? 0.62 : 0.43) * (0.6 + rand() * 0.76);
    const rank = (b + 0.5) / BLADES,
      kind = rand() < (dry ? 0.6 : coast ? 0.26 : 0.1) ? 1 : 0;
    const start = pos.length / 3;
    const rings = limit <= 48 && !reed ? [0, 0.6, 1] : [0, 0.47, 0.8, 1];
    for (const t of rings) {
      const cx = x + nx * bend * t * t + (coast ? h * 0.18 * t * t : 0),
        cz = z + nz * bend * t * t;
      const w = width * (1 - t * 0.94),
        y = h * (t - 0.16 * t * t);
      for (const side of [-1, 1]) vertex(cx + side * wx * w, y, cz + side * wz * w, nx, nz, t, rank, kind);
    }
    for (let j = 0; j < rings.length - 1; j++) {
      const i = start + 2 * j;
      indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    if ((reed && b % 8 === 3) || (!reed && b % 17 === 2)) {
      const tipX = x + nx * bend + (coast ? h * 0.18 : 0),
        tipZ = z + nz * bend,
        tipY = h * 0.84,
        base = pos.length / 3;
      if (reed) {
        // Furled seed head on the end of the rush.
        for (let j = 0; j < 6; j++) {
          const a = (j * Math.PI) / 3;
          for (const t of [0, 1])
            vertex(
              tipX + Math.cos(a) * 0.018,
              tipY + t * 0.13,
              tipZ + Math.sin(a) * 0.018,
              nx,
              nz,
              1,
              rank,
              4,
            );
        }
        for (let j = 0; j < 6; j++) {
          const a = base + j * 2,
            c = base + ((j + 1) % 6) * 2;
          indices.push(a, c, a + 1, c, c + 1, a + 1);
        }
      } else {
        const flower = coast ? 2 : dry ? 1 : 3;
        for (let j = 0; j < 5; j++) {
          const a = j * 1.2566,
            r = 0.034 * clump[2];
          vertex(tipX, tipY - 0.008, tipZ, nx, nz, 1, rank, flower);
          vertex(
            tipX + Math.cos(a - 0.42) * r,
            tipY + 0.009,
            tipZ + Math.sin(a - 0.42) * r,
            nx,
            nz,
            1,
            rank,
            flower,
          );
          vertex(
            tipX + Math.cos(a + 0.42) * r,
            tipY + 0.009,
            tipZ + Math.sin(a + 0.42) * r,
            nx,
            nz,
            1,
            rank,
            flower,
          );
          indices.push(base + j * 3, base + j * 3 + 1, base + j * 3 + 2);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  for (const [name, arr] of [
    ['position', pos],
    ['normal', norm],
    ['blade', data],
  ] as const)
    g.setAttribute(name, new THREE.Float32BufferAttribute(arr, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

export class GroundMeadow {
  readonly root = new THREE.Group();
  readonly grass: THREE.InstancedMesh;
  readonly reeds: THREE.InstancedMesh;
  readonly tint = TSL.uniform(new THREE.Color('#73804e'));
  private readonly density = TSL.uniform(1);
  private readonly reach = TSL.uniform(1);
  private readonly chunks = new Map<number, Chunk>();
  private readonly patches: THREE.Matrix4[] = [];
  private readonly samples: number[] = [];
  private readonly grassLods: THREE.InstancedMesh[] = [];
  private readonly projector = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly cameraDir = new THREE.Vector3();
  private readonly prevDir = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 2.6);
  private reedTotal = 0;
  private densityFactor = 1;
  private scale = 1;
  private dirty = true;
  submittedBlades = 0;
  /** Expected surviving blade count after continuous per-blade distance and density masks. */
  visibleBlades = 0;
  constructor(
    private readonly surface: TerrainSurface,
    private readonly wind: MeadowWind,
    seed: number,
    plantable?: (x: number, z: number) => boolean,
  ) {
    const rand = mulberry32(seed ^ 0xa906),
      read = terrainReading();
    const spacing = Math.max(PATCH, surface.size / 310),
      n = Math.ceil(surface.size / spacing);
    const reedData: THREE.Matrix4[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (i + 0.31 + rand() * 0.38) * spacing - surface.size / 2,
          z = (j + 0.31 + rand() * 0.38) * spacing - surface.size / 2;
        if (
          Math.abs(x) > surface.size / 2 ||
          Math.abs(z) > surface.size / 2 ||
          (plantable && !plantable(x, z))
        )
          continue;
        const g = surface.sample(x, z, read);
        if (g.surfaceId !== 'grass' && g.surfaceId !== 'scrub' && g.surfaceId !== 'reeds') continue;
        const a = rand() * Math.PI * 2,
          c = Math.cos(a),
          s = Math.sin(a);
        const dx = -g.normal.x / g.normal.y,
          dz = -g.normal.z / g.normal.y;
        const patch =
          0.5 + 0.25 * Math.cos(x * 0.19 + Math.sin(z * 0.043) * 2) + 0.25 * Math.sin(z * 0.16 + x * 0.087);
        const tall = (0.58 + patch * 0.68 + rand() * 0.24) * (g.surfaceId === 'reeds' ? 1.1 : 1);
        const m = new THREE.Matrix4().set(
          c,
          0,
          -s,
          x,
          dx * c + dz * s,
          tall,
          -dx * s + dz * c,
          g.height - 0.008,
          s,
          0,
          c,
          z,
          0,
          0,
          0,
          1,
        );
        if (g.surfaceId === 'reeds') {
          if (rand() < 0.53) reedData.push(m);
          continue;
        }
        const k = this.patches.length;
        this.patches.push(m);
        this.samples.push(rand());
        const cell = (j >> 3) * 1024 + (i >> 3);
        let ch = this.chunks.get(cell);
        if (!ch) {
          ch = { box: new THREE.Box3(), patches: [] };
          this.chunks.set(cell, ch);
        }
        ch.patches.push(k);
        ch.box.expandByPoint(this.sphere.center.set(x, g.height, z));
      }
    for (const c of this.chunks.values()) c.box.expandByScalar(2.7);
    const make = (reed: boolean, blades: number, count: number) => {
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
      const {
        vec3,
        vec2,
        mix,
        smoothstep,
        positionLocal,
        positionGeometry,
        cameraPosition,
        attribute,
        varying,
      } = TSL;
      const info = attribute('blade', 'vec3'),
        t = info.x;
      const p = TSL.modelWorldMatrix.mul(TSL.vec4(positionLocal, 1)).xyz;
      const distance = p.distance(cameraPosition).div(this.reach);
      const cap = this.density.mul(
        TSL.float(1)
          .sub(smoothstep(13, 35, distance).mul(0.56))
          .sub(smoothstep(36, 95, distance).mul(0.28))
          .sub(smoothstep(96, 210, distance).mul(0.11)),
      );
      const fade = reed ? TSL.float(1) : smoothstep(-0.022, 0.022, cap.sub(info.y));
      const air = this.wind.node(p),
        motion = TSL.sin(p.x.mul(0.43).add(p.z.mul(0.26)).sub(frame.time.mul(2.7)));
      const lean = air.xz
        .mul(reed ? 0.046 : 0.026)
        .mul(motion.mul(0.23).add(1))
        .div(air.xz.length().mul(0.037).add(1))
        .mul(t.mul(t));
      const offset = vec3(
        lean.x,
        lean.length().mul(-0.25).sub(positionGeometry.y.mul(fade.oneMinus())),
        lean.y,
      );
      mat.positionNode = positionLocal.add(offset);
      const upper = varying(t),
        kind = varying(info.z),
        point = TSL.positionWorld;
      const patches = TSL.sin(point.x.mul(0.18).add(TSL.sin(point.z.mul(0.16))))
        .mul(TSL.sin(point.z.mul(0.053)))
        .mul(0.5)
        .add(0.5);
      const base = this.tint.mul(vec3(0.76, 0.84, 0.7)),
        fresh = this.tint.mul(vec3(1.15, 1.23, 0.89));
      const straw = vec3(0.32, 0.239, 0.103).mul(this.tint.mul(0.65).add(0.85));
      let color = mix(base, mix(fresh, straw, kind.clamp(0, 1).mul(0.63).add(patches.mul(0.2))), upper);
      color = mix(color, vec3(0.46, 0.27, 0.42), smoothstep(1.5, 2, kind));
      color = mix(color, vec3(0.73, 0.69, 0.46), smoothstep(2.5, 3, kind));
      color = mix(color, vec3(0.16, 0.085, 0.041), smoothstep(3.5, 4, kind));
      const view = cameraPosition.sub(point).normalize(),
        back = view.dot(frame.sunDirection).negate().max(0);
      const glint = back.pow(4).mul(0.2).add(TSL.normalWorld.dot(frame.sunDirection).abs().mul(0.3));
      const illumination = vec3(0.43, 0.49, 0.53).add(
        frame.sunColor.mul(frame.sunVisibility).mul(glint.add(0.26)),
      );
      mat.colorNode = color
        .mul(illumination)
        .mul(upper.mul(0.7).add(0.37))
        .add(this.tint.mul(upper).mul(back).mul(0.06).mul(frame.sunVisibility));
      const mesh = new THREE.InstancedMesh(tuft(surface.biome, reed, blades), mat, Math.max(1, count));
      mesh.name = reed ? 'Riparian cattails' : 'Grass patch ' + blades;
      this.root.add(mesh);
      return mesh;
    };
    for (const count of STEPS) {
      const m = make(false, count, this.patches.length);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.grassLods.push(m);
    }
    this.grass = this.grassLods[0];
    this.reeds = make(true, 24, reedData.length);
    this.reedTotal = reedData.length;
    this.reeds.count = reedData.length;
    reedData.forEach((m, i) => this.reeds.setMatrixAt(i, m));
    this.reeds.computeBoundingSphere();
  }
  setDensity(amount: number, tier: number) {
    this.scale = tier;
    this.densityFactor = Math.min(1, amount / 0.66);
    this.density.value = 0.81 + 0.19 * tier;
    this.reach.value = 0.56 + 0.59 * tier;
    this.reeds.count = Math.floor(this.reedTotal * Math.min(1, this.densityFactor) * (0.42 + 0.58 * tier));
    this.dirty = true;
  }
  updateView(camera: THREE.Camera) {
    camera.getWorldDirection(this.cameraDir);
    if (
      !this.dirty &&
      this.prevPos.distanceToSquared(camera.position) < 1.1 &&
      this.prevDir.dot(this.cameraDir) > 0.9995
    )
      return;
    this.dirty = false;
    this.prevPos.copy(camera.position);
    this.prevDir.copy(this.cameraDir);
    this.projector.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projector, camera.coordinateSystem);
    this.submittedBlades = this.visibleBlades = 0;
    for (const mesh of this.grassLods) mesh.count = 0;
    const reach = this.reach.value;
    for (const ch of this.chunks.values()) {
      if (!this.frustum.intersectsBox(ch.box)) continue;
      for (const i of ch.patches) {
        const m = this.patches[i],
          e = m.elements,
          p = this.sphere.center.set(e[12], e[13], e[14]);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        const d = p.distanceTo(camera.position) / reach;
        const keep =
          this.densityFactor *
          (0.48 + 0.52 * this.scale) *
          (1 - 0.86 * THREE.MathUtils.smoothstep(d, 52, 201));
        if (this.samples[i] > keep) continue;
        const level = d < 38 ? 0 : d < 99 ? 1 : 2,
          mesh = this.grassLods[level];
        mesh.setMatrixAt(mesh.count++, m);
        this.submittedBlades += STEPS[level];
        const smooth = THREE.MathUtils.smoothstep;
        const cap = 1 - 0.56 * smooth(d, 13, 35) - 0.28 * smooth(d, 36, 95) - 0.11 * smooth(d, 96, 210);
        this.visibleBlades += Math.min(STEPS[level], Math.round(BLADES * cap * this.density.value));
      }
    }
    for (const m of this.grassLods) {
      m.visible = m.count > 0;
      if (m.visible) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, m.count * 16);
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }
  dispose() {
    for (const m of [...this.grassLods, this.reeds]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.root.removeFromParent();
  }
}
