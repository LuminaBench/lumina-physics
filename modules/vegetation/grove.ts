import * as THREE from 'three/webgpu';
import { frame } from '../../engine/frame';
import { mulberry32 } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';
import type { WorldBus } from '../../engine/world-bus';
import { canopyBendNode } from '../strands/canopy';
import { terrainReading, type TerrainSurface } from '../terrain/surface';
import { SPECIES, growPlant, woodyGeometry, sprayGeometry, type Species } from './botany';
import { barkAtlas, crownImpostor, leafAtlas } from './atlas';

type Tree = {
  matrix: THREE.Matrix4;
  x: number;
  y: number;
  z: number;
  priority: number;
  tint: THREE.Color;
  species: Species;
};
type Batch = { levels: THREE.InstancedMesh[][]; range: number; margin: number };
const { mix, vec2, vec3, vec4, uniform, texture, positionWorld, cameraPosition, uv, smoothstep, normalView } =
  TSL;
function chooseSpecies(biome: string, wet: boolean, choice: number): Species {
  if (biome === 'dry-highlands')
    return choice < 0.64 ? 'sagebrush' : choice < 0.78 ? 'gorse' : choice < 0.93 ? 'cypress' : 'oak';
  if (biome === 'temperate-river-valley')
    return wet
      ? choice < 0.75
        ? 'willow'
        : 'fern'
      : choice < 0.43
        ? 'oak'
        : choice < 0.59
          ? 'willow'
          : choice < 0.88
            ? 'fern'
            : 'gorse';
  return choice < 0.38
    ? 'cypress'
    : choice < 0.57
      ? 'oak'
      : choice < 0.7
        ? 'palm'
        : choice < 0.83
          ? 'gorse'
          : choice < 0.94
            ? 'heather'
            : 'fern';
}
export class BotanicalGrove {
  readonly root = new THREE.Group();
  readonly bands = uniform(0);
  readonly tint = uniform(new THREE.Color('#73804e'));
  readonly batches = new Map<Species, Batch>();
  readonly nearDistance = uniform(1);
  private readonly chunks = new Map<number, { bounds: THREE.Box3; trees: Tree[] }>();
  private readonly textures: THREE.Texture[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly clip = new THREE.Matrix4();
  private readonly lastView = new THREE.Matrix4();
  private fraction = 1;
  private dirty = true;
  visiblePlants = 0;
  constructor(
    surface: TerrainSurface,
    world: WorldBus,
    seed: number,
    plantable?: (x: number, z: number) => boolean,
  ) {
    const rand = mulberry32(seed ^ 0x83c41),
      read = terrainReading(),
      pose = new THREE.Object3D(),
      counts = new Map<Species, number>();
    const target = Math.max(32, Math.min(1650, Math.round(surface.size ** 2 / 174)));
    for (let i = 0; i < target * 3; i++) {
      const x = (rand() - 0.5) * surface.size,
        z = (rand() - 0.5) * surface.size;
      if (plantable && !plantable(x, z)) continue;
      const s = surface.sample(x, z, read);
      if (!['grass', 'reeds', 'scrub'].includes(s.surfaceId) || s.slope > 0.61) continue;
      const patch =
        0.5 + 0.25 * Math.sin(0.047 * x + 1.8 * Math.sin(0.029 * z)) + 0.25 * Math.cos(0.061 * z - 0.018 * x);
      const margin = surface.biome === 'temperate-river-valley' && s.surfaceId === 'reeds' ? 0.24 : 0;
      if (rand() > 0.11 + margin + 0.63 * patch * patch) continue;
      const species = chooseSpecies(surface.biome, s.moisture > 0.69, rand());
      const scale = 0.53 + rand() * 0.91;
      pose.position.set(x, s.height - 0.018, z);
      pose.rotation.set(
        species === 'willow' ? s.normal.z * 0.26 : 0,
        rand() * 6.283,
        species === 'willow' ? -s.normal.x * 0.26 : 0,
      );
      pose.scale.set(scale * (0.84 + rand() * 0.25), scale * (0.85 + rand() * 0.3), scale);
      pose.updateMatrix();
      const key = Math.floor((x + surface.size / 2) / 50) + 65536 * Math.floor((z + surface.size / 2) / 50);
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = { bounds: new THREE.Box3(), trees: [] };
        this.chunks.set(key, chunk);
      }
      chunk.bounds.expandByPoint(pose.position);
      chunk.trees.push({
        matrix: pose.matrix.clone(),
        x,
        y: s.height,
        z,
        priority: rand(),
        tint: new THREE.Color().setRGB(
          0.83 + 0.15 * Math.sin(x * 0.17),
          0.89 + 0.11 * Math.cos(z * 0.21),
          0.8 + 0.19 * Math.sin(x * 0.11 + z * 0.08),
        ),
        species,
      });
      counts.set(species, (counts.get(species) ?? 0) + 1);
    }
    for (const chunk of this.chunks.values()) chunk.bounds.expandByScalar(16);
    const bark = barkAtlas();
    this.textures.push(bark);
    for (const kind of SPECIES) {
      const count = counts.get(kind) ?? 0;
      if (!count) continue;
      const salt = seed + SPECIES.indexOf(kind) * 373;
      const form = growPlant(kind, salt),
        atlas = leafAtlas(kind, salt),
        far = crownImpostor(form, atlas.canvas);
      this.textures.push(atlas.leaf, atlas.detail, far.map);
      const range = Math.max(12, form.height * 4.5),
        margin = form.radius + form.height * 0.3 + 4;
      const levels: THREE.InstancedMesh[][] = [[], [], []];
      for (let level = 0; level < 3; level++) {
        const d = positionWorld.distance(cameraPosition).div(this.nearDistance.mul(range));
        const noise = TSL.fract(
          TSL.dot(TSL.screenCoordinate.xy.floor(), vec2(0.06711056, 0.00583715)).fract().mul(52.9829189),
        );
        const t1 = smoothstep(0.8, 1.2, d),
          t2 = smoothstep(2.2, 2.9, d);
        const mask =
          level === 0
            ? noise.greaterThanEqual(t1)
            : level === 1
              ? noise.lessThan(t1).and(noise.greaterThanEqual(t2))
              : noise.lessThan(t2);
        const add = (
          geo: THREE.BufferGeometry,
          m: THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial,
          alpha: N,
          name: string,
        ) => {
          m.opacityNode = TSL.select(mask, alpha, 0);
          m.alphaTest = 0.25;
          m.positionNode = canopyBendNode(world, form.height, kind === 'fern' ? 0.085 : 0.034);
          if (name === 'sprays' && level < 2) {
            const loc = TSL.positionLocal;
            const phase = loc.x.mul(1.73).add(loc.z.mul(0.72)).add(frame.time.mul(6.2));
            const strength = world
              .node(TSL.modelWorldMatrix.mul(TSL.vec4(loc, 1)).xyz)
              .xz.length()
              .min(16)
              .mul(0.0021);
            const flutter = phase.sin().mul(strength).mul(uv().y.pow2());
            m.positionNode = TSL.add(m.positionNode, vec3(flutter, flutter.mul(0.37), flutter.mul(-0.53)));
          }
          const mesh = new THREE.InstancedMesh(geo, m, count);
          mesh.name = kind + ' ' + name + ' ' + level;
          mesh.count = 0;
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.root.add(mesh);
          levels[level].push(mesh);
        };
        if (level < 2) {
          const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
          const tile = texture(bark, uv().mul(vec2(1.4, 0.9))),
            rings = TSL.sin(uv().y.mul(32)).smoothstep(0.56, 0.96);
          m.colorNode = vec3(0.135, 0.082, 0.044)
            .mul(tile.r.mul(0.93).add(0.6))
            .mul(kind === 'palm' ? rings.mul(0.32).add(0.79) : 1);
          m.roughnessNode = tile.b.mul(0.4).add(0.57);
          m.normalNode = TSL.normalMap(vec3(tile.g, 0.5, 1), vec2(0.65));
          add(woodyGeometry(form, level === 1), m, TSL.float(1), 'wood');
        }
        if (level === 2) {
          const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
          const leaf = texture(far.map),
            view = cameraPosition.sub(positionWorld).xz.normalize();
          const facing = TSL.normalWorld.xz.normalize().dot(view).abs();
          const glancing = smoothstep(0.8, 0.9, facing);
          const lateral = uv().x.mul(3).fract().mul(2).sub(1),
            up = uv().y.sub(0.5).mul(1.5);
          const forward = TSL.sqrt(TSL.float(1).sub(lateral.mul(lateral)).max(0.04));
          const side = vec2(view.y.negate(), view.x);
          const radial = view.mul(forward).add(side.mul(lateral));
          const light = vec3(radial.x, up, radial.y).normalize().dot(frame.sunDirection).mul(0.5).add(0.5);
          m.colorNode = this.tint
            .mul(leaf.rgb.mul(0.94).add(0.045))
            .mul(
              vec3(0.19, 0.24, 0.22).add(
                frame.sunColor.mul(frame.sunVisibility).mul(light.mul(0.22).add(0.035)),
              ),
            );
          add(far.geometry, m, leaf.a.mul(glancing), 'sprays');
          continue;
        }
        const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
        const leaf = texture(atlas.leaf);
        const colour = mix(leaf.rgb, TSL.floor(leaf.rgb.mul(6)).div(6), this.bands.mul(0.8));
        m.colorNode = this.tint.mul(colour.mul(0.79).add(0.2)).mul(kind === 'cypress' ? 0.77 : 1.03);
        if (kind === 'sagebrush')
          m.colorNode = m.colorNode!.mul(vec3(0.86, 1, 1.31)).add(vec3(0.016, 0.022, 0.021));
        const transmission = TSL.dot(positionWorld.sub(cameraPosition).normalize(), frame.sunDirection).max(
          0,
        );
        m.emissiveNode = this.tint
          .mul(frame.sunColor)
          .mul(frame.sunVisibility)
          .mul(transmission.mul(0.11).add(0.035))
          .mul(leaf.g);
        if (level < 2) {
          const detail = texture(atlas.detail);
          m.roughnessNode = detail.b.mul(0.46).add(0.36);
          m.normalNode = TSL.normalMap(vec3(detail.rg, 1), vec2(0.34));
        }
        add(sprayGeometry(form, level === 1, kind), m, leaf.a, 'sprays');
      }
      this.batches.set(kind, { levels, range, margin });
    }
  }
  bakeShade(texture: THREE.DataTexture, size: number) {
    const res = texture.image.width,
      pixels = texture.image.data as Uint8Array;
    pixels.fill(255);
    for (const chunk of this.chunks.values())
      for (const t of chunk.trees) {
        if (t.priority > this.fraction) continue;
        const scale = t.matrix.elements[5],
          radius =
            ((t.species === 'fern'
              ? 0.85
              : t.species === 'gorse'
                ? 1.2
                : t.species === 'cypress'
                  ? 2.3
                  : 3.5) *
              scale *
              res) /
            size;
        const cx = (t.x / size + 0.5) * res,
          cz = (t.z / size + 0.5) * res;
        for (let z = Math.max(0, Math.floor(cz - radius)); z <= Math.min(res - 1, cz + radius); z++)
          for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(res - 1, cx + radius); x++) {
            const r = ((x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2) / (radius * radius);
            if (r < 1)
              pixels[z * res + x] = Math.min(
                pixels[z * res + x],
                Math.round(255 * (1 - 0.43 * (1 - r) ** 2)),
              );
          }
      }
    texture.needsUpdate = true;
  }
  setDensity(amount: number, tier: number) {
    this.fraction = Math.min(1, amount * (0.75 + 0.25 * tier));
    this.nearDistance.value = 0.7 + tier * 0.4;
    this.dirty = true;
  }
  updateView(camera: THREE.Camera) {
    this.clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.dirty && this.lastView.equals(this.clip)) return;
    this.dirty = false;
    this.lastView.copy(this.clip);
    this.frustum.setFromProjectionMatrix(this.clip, camera.coordinateSystem);
    for (const b of this.batches.values()) for (const level of b.levels) for (const m of level) m.count = 0;
    this.visiblePlants = 0;
    for (const chunk of this.chunks.values()) {
      if (!this.frustum.intersectsBox(chunk.bounds)) continue;
      for (const t of chunk.trees) {
        if (t.priority > this.fraction) continue;
        const b = this.batches.get(t.species)!,
          r = b.range * this.nearDistance.value;
        const d = Math.hypot(t.x - camera.position.x, t.y - camera.position.y, t.z - camera.position.z);
        this.visiblePlants++;
        for (let l = 0; l < 3; l++) {
          if (
            (l === 0 && d > r * 1.2 + b.margin) ||
            (l === 1 && (d < r * 0.8 - b.margin || d > r * 2.9 + b.margin)) ||
            (l === 2 && d < r * 2.2 - b.margin)
          )
            continue;
          for (const mesh of b.levels[l]) {
            mesh.setColorAt(mesh.count, t.tint);
            mesh.setMatrixAt(mesh.count++, t.matrix);
          }
        }
      }
    }
    for (const b of this.batches.values())
      for (const level of b.levels)
        for (const mesh of level) {
          mesh.visible = mesh.count > 0;
          if (mesh.visible) {
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          }
        }
  }
  dispose() {
    this.root.removeFromParent();
    for (const b of this.batches.values())
      for (const level of b.levels)
        for (const mesh of level) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
          mesh.dispose();
        }
    for (const tex of this.textures) tex.dispose();
  }
}
