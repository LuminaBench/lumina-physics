import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';
import type { AuthoredLandscape } from '../landscape/authored';
import { soilSite } from '../landscape/earth';
import { frame as sharedFrame } from '../../engine/frame';
import { terrainReading, type TerrainSurface } from '../terrain/surface';
import type { MeadowWind } from './meadow-wind';

const BLADES = 384,
  STEPS = [384, 170, 64];
const PATCH = 2.15;
type Chunk = { box: THREE.Box3; patches: number[] };
function tuft(biome: string, reed: boolean, limit: number, art?: AuthoredLandscape) {
  const recipe = art?.cover;
  if (recipe?.geometry && !reed) return recipe.geometry(art!.seeds.flowers, limit);
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
    const h =
      (reed ? 0.79 : (recipe?.height ?? (dry ? 0.34 : coast ? 0.49 : 0.4))) *
      clump[2] *
      (0.57 + 0.72 * rand());
    const width = (reed ? 0.012 : (recipe?.width ?? 0.012)) * (1 + rand() * 0.68),
      bend = h * (reed ? 0.43 : (recipe?.bend ?? (coast ? 0.62 : 0.43))) * (0.6 + rand() * 0.76);
    const rank = (b + 0.5) / BLADES,
      kind = rand() < (recipe?.dry ?? (dry ? 0.6 : coast ? 0.26 : 0.1)) ? 1 : 0;
    const start = pos.length / 3;
    const rings = limit <= 64 && !reed ? [0, 0.6, 1] : [0, 0.47, 0.8, 1];
    for (const t of rings) {
      const cx = x + nx * bend * t * t + (coast ? h * 0.18 * t * t : 0),
        cz = z + nz * bend * t * t;
      const w =
          width *
          (!reed && recipe?.bladeForm === 'round' ? 0.12 + 0.87 * Math.sin(t * Math.PI) : 1 - t * 0.94),
        y = h * (t - 0.16 * t * t);
      for (const side of [-1, 1]) vertex(cx + side * wx * w, y, cz + side * wz * w, nx, nz, t, rank, kind);
    }
    for (let j = 0; j < rings.length - 1; j++) {
      const i = start + 2 * j;
      indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    if (!reed && recipe?.bladeForm === 'frond') {
      for (let i = 1; i <= 5; i++) {
        const t = i / 6,
          base = pos.length / 3,
          cx = x + nx * bend * t * t,
          cz = z + nz * bend * t * t,
          reach = h * (1 - t) * 0.46;
        for (const side of [-1, 1]) {
          vertex(cx, h * t * 0.81, cz, nx, nz, t, rank, kind);
          vertex(
            cx + wx * reach * side + nx * 0.025,
            h * t * 0.81 + 0.027,
            cz + wz * reach * side + nz * 0.025,
            nx,
            nz,
            t,
            rank,
            kind,
          );
          vertex(cx + nx * 0.036, h * t * 0.81 + 0.028, cz + nz * 0.036, nx, nz, t, rank, kind);
        }
        indices.push(base, base + 1, base + 2, base + 3, base + 4, base + 5);
      }
    }
    if (
      (reed && b % 8 === 3) ||
      (!reed && (b + (art ? art.seeds.flowers % 173 : 0)) % (recipe?.spacing ?? 17) === 2)
    ) {
      const tipX = x + nx * bend + (coast ? h * 0.18 : 0),
        tipZ = z + nz * bend,
        tipY = h * 0.84,
        base = pos.length / 3;
      if (reed) {
        // Rounded brown spike with a pointed terminal bristle and side-to-side light falloff.
        const radius = 0.011,
          length = 0.11;
        const rings = [
          [0, 0.33],
          [0.055, 0.89],
          [0.85, 1],
          [0.97, 0.69],
          [1, 0.17],
          [1.34, 0.03],
        ];
        for (let row = 0; row < rings.length; row++)
          for (let j = 0; j < 7; j++) {
            const [t, r] = rings[row],
              a = (j * 2 * Math.PI) / 7;
            vertex(
              tipX + nx * 0.014 * t + Math.cos(a) * radius * r,
              tipY + t * length,
              tipZ + nz * 0.014 * t + Math.sin(a) * radius * r,
              Math.cos(a),
              Math.sin(a),
              1,
              rank,
              4,
            );
            if (row) {
              const i = base + (row - 1) * 7 + j,
                k = base + (row - 1) * 7 + ((j + 1) % 7);
              indices.push(i, k, i + 7, k, k + 7, i + 7);
            }
          }
      } else if (recipe?.flowerHead) {
        recipe.flowerHead(
          {
            x: tipX,
            y: tipY,
            z: tipZ,
            radius: recipe.radius * clump[2],
            petals: recipe.petals,
            curve: recipe.bell,
            phase: a,
          },
          {
            vertex(px, py, pz, vx, vz) {
              const index = pos.length / 3;
              vertex(px, py, pz, vx, vz, 1, rank, 3);
              return index;
            },
            triangle(i, j, k) {
              indices.push(i, j, k);
            },
          },
        );
      } else {
        const flower = art ? 3 : coast ? 2 : dry ? 1 : 3,
          r = (recipe?.radius ?? 0.019) * clump[2],
          petals = recipe?.petals ?? (dry ? 4 : 7);
        for (let j = 0; j < petals; j++) {
          const a = (j * 2 * Math.PI) / petals,
            ax = Math.cos(a),
            az = Math.sin(a),
            i = pos.length / 3;
          for (const [len, side, up] of [
            [0.12, 0, 0],
            [0.55, -0.2, 0.09],
            [0.91, -0.19, 0.19],
            [1, 0.02, 0.22],
            [0.82, 0.23, 0.18],
            [0.48, 0.17, 0.08],
          ])
            vertex(
              tipX + (ax * len - az * side) * r,
              tipY + r * (up + (recipe?.bell ?? 0) * len * len),
              tipZ + (az * len + ax * side) * r,
              nx,
              nz,
              1,
              rank,
              flower,
            );
          indices.push(i, i + 1, i + 2, i, i + 2, i + 3, i, i + 3, i + 4, i, i + 4, i + 5);
        }
        const centre = pos.length / 3;
        vertex(tipX, tipY + r * 0.14, tipZ, nx, nz, 1, rank, 5);
        for (let j = 0; j < 6; j++) {
          const a = (j * Math.PI) / 3;
          vertex(tipX + Math.cos(a) * r * 0.28, tipY, tipZ + Math.sin(a) * r * 0.28, nx, nz, 1, rank, 5);
        }
        for (let j = 0; j < 6; j++) indices.push(centre, centre + 1 + j, centre + 1 + ((j + 1) % 6));
      }
    }
    // Basal clover leaflets fill gaps between the taller seed stalks.
    if (!reed && !dry && b % 11 === 3) {
      const stem = 0.06 + clump[2] * 0.055;
      for (let l = 0; l < 3; l++) {
        const angle = a + (l * Math.PI * 2) / 3,
          ax = Math.cos(angle),
          az = Math.sin(angle),
          r = 0.047;
        const first = pos.length / 3;
        for (const [len, side, lift] of [
          [0, 0, 0],
          [0.58, -0.46, 0.16],
          [1, -0.19, 0.38],
          [0.89, 0, 0.29],
          [1, 0.19, 0.38],
          [0.58, 0.46, 0.16],
        ]) {
          vertex(
            x + (len * ax - side * az) * r,
            stem + lift * r,
            z + (len * az + side * ax) * r,
            nx,
            nz,
            0.22,
            rank,
            0,
          );
        }
        indices.push(
          first,
          first + 1,
          first + 2,
          first,
          first + 2,
          first + 3,
          first,
          first + 3,
          first + 4,
          first,
          first + 4,
          first + 5,
        );
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
  readonly bands = TSL.uniform(0);
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
    shade?: THREE.DataTexture,
    art?: AuthoredLandscape,
  ) {
    const frame = art?.lighting ?? sharedFrame;
    const rand = mulberry32(seed ^ 0xa906),
      read = terrainReading();
    const spacing = Math.max(PATCH, surface.size / 310),
      n = Math.ceil(surface.size / spacing);
    const site = soilSite();
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
        if (art && art.earth.inspect(x, z, site).reason !== 'plantable') continue;
        const g = surface.sample(x, z, read);
        if (g.surfaceId !== 'grass' && g.surfaceId !== 'scrub' && g.surfaceId !== 'reeds') continue;
        if (
          art?.region.form === 'wash' &&
          (g.height < 1.9 || Math.sin(x * 0.042 + z * 0.081) * Math.cos(z * 0.035) > 0.22)
        )
          continue;
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
        if (
          g.surfaceId === 'reeds' ||
          (art?.region.form === 'mountain' && site.water > 0.02 && site.water < 0.42)
        ) {
          if (rand() < 0.53) reedData.push(m);
          if (g.height < surface.waterLevel + 0.23) continue;
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
      const shelter = art
        ? TSL.texture(art.earth.habitatMap, p.xz.div(surface.size).add(0.5)).level(0).b.mul(0.49).oneMinus()
        : TSL.float(1);
      const lean = air.xz
        .mul(shelter)
        .mul(reed ? 0.046 : 0.026)
        .mul(motion.mul(0.23).add(1))
        .div(air.xz.length().mul(0.037).add(1))
        .mul(t.mul(t));
      const offset = vec3(
        lean.x,
        lean
          .length()
          .mul(-0.25)
          .add(air.y.mul(0.012).clamp(-0.19, 0.09).mul(t.mul(t)))
          .sub(positionGeometry.y.mul(fade.oneMinus())),
        lean.y,
      );
      mat.positionNode = positionLocal.add(offset);
      let flowerAlpha = TSL.float(1);
      if (art) {
        const cell = TSL.texture(art.earth.map, p.xz.div(surface.size).add(0.5)).level(0);
        const wetMargin = TSL.smoothstep(1.3, -0.15, p.y);
        const current = reed
          ? TSL.sin(p.z.mul(0.3).sub(frame.time.mul(2.4)))
              .mul(0.075)
              .mul(wetMargin)
          : TSL.float(0);
        const flow = reed ? wind.currentNode(p).mul(0.085) : TSL.vec2(0);
        const headMask = info.z.greaterThan(1.5).and(info.z.lessThan(3.5)).or(info.z.greaterThan(4.5));
        const patchSize = art.cover.patchSize ?? 18;
        const colonies = TSL.sin(p.x.div(patchSize).add((art.seeds.flowers % 83) * 0.41))
          .mul(TSL.cos(p.z.mul(1.13 / patchSize)))
          .mul(0.5)
          .add(0.5);
        const blossoms = TSL.smoothstep(colonies.sub(0.025), colonies.add(0.025), art.bloom);
        mat.positionNode = TSL.add(
          mat.positionNode,
          vec3(
            cell.b.mul(0.16).add(current).add(flow.x).mul(t),
            positionGeometry.y.mul(cell.b).mul(-0.75),
            flow.y.mul(t),
          ),
        );
        if (!reed) {
          const shade = TSL.texture(art.earth.habitatMap, p.xz.div(surface.size).add(0.5)).level(0).b;
          flowerAlpha = TSL.varying(
            TSL.select(
              headMask,
              blossoms
                .mul(TSL.step(art.cover.minimumShade ?? 0, shade))
                .mul(
                  art.flowerMask
                    ? TSL.texture(art.flowerMask, p.xz.div(surface.size).add(0.5)).level(0).r
                    : 1,
                ),
              1,
            ),
          );
        }
      }
      if (!reed) {
        mat.opacityNode = smoothstep(0, 0.24, varying(fade)).mul(flowerAlpha);
        mat.alphaTest = 0.15;
      }
      const upper = varying(t),
        kind = varying(info.z),
        point = TSL.positionWorld;
      const patches = TSL.sin(point.x.mul(0.18).add(TSL.sin(point.z.mul(0.16))))
        .mul(TSL.sin(point.z.mul(0.053)))
        .mul(0.5)
        .add(0.5);
      const stem = art ? TSL.mix(this.tint, TSL.color(art.cover.stemColor), 0.35) : this.tint;
      const base = stem.mul(vec3(0.76, 0.84, 0.7)),
        fresh = stem.mul(vec3(1.15, 1.23, 0.89));
      const straw = vec3(0.32, 0.239, 0.103).mul(this.tint.mul(0.65).add(0.85));
      let color = mix(base, mix(fresh, straw, kind.clamp(0, 1).mul(0.63).add(patches.mul(0.2))), upper);
      color = mix(color, vec3(0.46, 0.27, 0.42), smoothstep(1.5, 2, kind));
      color = mix(color, vec3(0.73, 0.69, 0.46), smoothstep(2.5, 3, kind));
      color = mix(color, vec3(0.16, 0.085, 0.041), smoothstep(3.5, 4, kind));
      color = mix(color, vec3(0.48, 0.27, 0.035), smoothstep(4.5, 5, kind));
      const view = cameraPosition.sub(point).normalize(),
        back = view.dot(frame.sunDirection).negate().max(0);
      const glint = back.pow(4).mul(0.2).add(TSL.normalWorld.dot(frame.sunDirection).abs().mul(0.3));
      const skyFill = art
        ? TSL.mix(
            vec3(0.04, 0.056, 0.079),
            vec3(0.45, 0.53, 0.59),
            TSL.smoothstep(-0.12, 0.24, frame.sunDirection.y),
          )
        : vec3(0.43, 0.49, 0.53);
      const illumination = skyFill.add(
        frame.sunColor
          .mul(frame.sunVisibility)
          .mul(mix(glint, TSL.floor(glint.mul(7)).div(7), this.bands).add(0.26)),
      );
      mat.colorNode = color
        .mul(illumination)
        .mul(upper.mul(0.7).add(0.37))
        .add(this.tint.mul(upper).mul(back).mul(0.06).mul(frame.sunVisibility));
      if (art) {
        const head = smoothstep(1.5, 2, kind).mul(smoothstep(3.5, 3, kind));
        mat.colorNode = TSL.mix(
          mat.colorNode,
          TSL.color(art.cover.petalColor).mul(illumination.add(art.emission)),
          head,
        );
        mat.colorNode = TSL.mul(
          mat.colorNode,
          TSL.mix(vec3(0.8, 0.89, 0.94), vec3(1.04, 1.03, 0.95), patches),
        );
        mat.colorNode = TSL.mix(
          mat.colorNode,
          vec3(0.65, 0.71, 0.74).mul(illumination),
          art.winter.mul(0.58),
        ).mul(TSL.mix(vec3(1), vec3(1.1, 0.82, 0.55), art.autumn));
      }
      if (art?.cloudShadow)
        mat.colorNode = TSL.mul(mat.colorNode, art.cloudShadow(point).mul(0.39).add(0.61));
      if (shade)
        mat.colorNode = mat.colorNode!.mul(
          TSL.texture(shade, TSL.positionWorld.xz.div(surface.size).add(0.5)).r,
        );
      const mesh = new THREE.InstancedMesh(tuft(surface.biome, reed, blades, art), mat, Math.max(1, count));
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
    this.densityFactor = Math.min(1, amount / (this.surface.biome === 'dry-highlands' ? 0.22 : 0.66));
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
          (1 - (1 - this.scale) * 0.55 * THREE.MathUtils.smoothstep(d, 4, 27)) *
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
