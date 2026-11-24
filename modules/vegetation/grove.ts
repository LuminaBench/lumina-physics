import * as THREE from 'three/webgpu';
import { frame as sharedFrame } from '../../engine/frame';
import { mulberry32 } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';
import type { WorldBus } from '../../engine/world-bus';
import { canopyBendNode } from '../strands/canopy';
import { terrainReading, type TerrainSurface } from '../terrain/surface';
import type { AuthoredLandscape } from '../landscape/authored';
import { seedFor } from '../landscape/library';
import { streetDistance } from '../landscape/earth';
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
  key: string;
  id: string;
  shrub: boolean;
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
  readonly batches = new Map<string, Batch>();
  readonly nearDistance = uniform(1);
  private readonly chunks = new Map<number, { bounds: THREE.Box3; trees: Tree[] }>();
  private readonly leafStyles: { material: THREE.MeshStandardNodeMaterial; base: N }[] = [];
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
    private readonly art?: AuthoredLandscape,
  ) {
    const frame = art?.lighting ?? sharedFrame;
    const treeRandom = mulberry32(seed ^ 0x83c41),
      understoryRandom = mulberry32((art?.seeds.understory ?? seed) ^ 0xa7f105),
      read = terrainReading(),
      pose = new THREE.Object3D(),
      counts = new Map<string, number>();
    const types = new Map<string, { kind: Species; id: string; variant: number }>();
    const target = Math.max(32, Math.min(1650, Math.round(surface.size ** 2 / 174)));
    for (let i = 0; i < target * 3; i++) {
      const shrubPass = !!art && i % 3 === 2,
        rand = shrubPass ? understoryRandom : treeRandom;
      let x = (rand() - 0.5) * surface.size,
        z = (rand() - 0.5) * surface.size;
      if (art?.region.form === 'farm') {
        x = Math.round(x / 9) * 9 + (rand() - 0.5) * 0.85;
        z = Math.round(z / 8) * 8 + (rand() - 0.5) * 0.85;
      }
      if (art?.region.form === 'street' && streetDistance(x, z) < 5.7) continue;
      if (plantable && !plantable(x, z)) continue;
      const s = surface.sample(x, z, read);
      if (!['grass', 'reeds', 'scrub'].includes(s.surfaceId) || s.slope > 0.61) continue;
      const patch =
        0.5 + 0.25 * Math.sin(0.047 * x + 1.8 * Math.sin(0.029 * z)) + 0.25 * Math.cos(0.061 * z - 0.018 * x);
      const margin = surface.biome === 'temperate-river-valley' && s.surfaceId === 'reeds' ? 0.24 : 0;
      if (rand() > 0.11 + margin + 0.63 * patch * patch) continue;
      const choice = rand();
      const plantId = art?.choose(x, z, choice, shrubPass);
      if (art && !plantId) continue;
      const recipe = plantId ? art!.library.get('plant', plantId) : undefined;
      const species = recipe?.form ?? chooseSpecies(surface.biome, s.moisture > 0.69, choice);
      const variant = recipe
        ? Math.min(recipe.variants - 1, Math.floor(rand() * recipe.variants * (0.87 + 0.23 * patch)))
        : 0;
      const batchKey = plantId ? plantId + '/' + variant : species;
      types.set(batchKey, { id: plantId ?? species, kind: species, variant });
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
        key: batchKey,
        id: seed.toString(36) + '-' + i.toString(36),
        shrub: recipe?.shrub ?? false,
      });
      counts.set(batchKey, (counts.get(batchKey) ?? 0) + 1);
    }
    for (const chunk of this.chunks.values()) chunk.bounds.expandByScalar(16);
    const bark = barkAtlas();
    this.textures.push(bark);
    for (const [batchKey, { kind, id, variant }] of art
      ? types
      : [...types].sort((a, b) => SPECIES.indexOf(a[1].kind) - SPECIES.indexOf(b[1].kind))) {
      const recipe = art?.library.get('plant', id);
      const count = counts.get(batchKey) ?? 0;
      if (!count) continue;
      const salt = art
        ? seedFor(recipe?.shrub ? art.seeds.understory : seed, batchKey)
        : seed + SPECIES.indexOf(kind) * 373;
      const form = growPlant(kind, salt, recipe, variant),
        atlas = leafAtlas(kind, salt, recipe),
        far = crownImpostor(form, atlas.canvas, recipe?.bark);
      this.textures.push(atlas.leaf, atlas.detail, far.map);
      const range = Math.max(12, form.height * 4.5),
        margin = form.radius + form.height * 0.3 + 4;
      const levels: THREE.InstancedMesh[][] = [[], [], []];
      for (let level = 0; level < 3; level++) {
        const d = positionWorld.distance(cameraPosition).div(this.nearDistance.mul(range));
        const noise = TSL.fract(
          TSL.dot(TSL.screenCoordinate.xy.floor(), vec2(0.06711056, 0.00583715)).fract().mul(52.9829189),
        );
        const t1 = smoothstep(art ? 0.95 : 0.8, art ? 1.08 : 1.2, d),
          t2 = smoothstep(art ? 2.47 : 2.2, art ? 2.66 : 2.9, d);
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
          if (art?.cloudShadow && m.colorNode)
            m.colorNode = TSL.mul(m.colorNode, art.cloudShadow(positionWorld).mul(0.42).add(0.58));
          const foliageAlpha =
            art && recipe && !recipe.evergreen && name === 'sprays'
              ? alpha.mul(TSL.float(1).sub(art.winter.mul(level === 2 ? 0 : 0.94)))
              : alpha;
          m.opacityNode = TSL.select(mask, foliageAlpha, 0);
          m.alphaTest = 0.25;
          m.positionNode = canopyBendNode(
            world,
            form.height,
            recipe?.flex ?? (kind === 'fern' ? 0.085 : 0.034),
            frame.time,
          );
          if (name === 'sprays' && level < 2) {
            const loc = TSL.positionLocal;
            const phase = loc.x.mul(1.73).add(loc.z.mul(0.72)).add(frame.time.mul(6.2));
            const strength = world
              .node(TSL.modelWorldMatrix.mul(TSL.vec4(loc, 1)).xyz)
              .xz.length()
              .min(16)
              .mul(0.0021);
            const flutter = phase.sin().mul(strength).mul(uv().y.pow2());
            const snowLoad = art && recipe?.evergreen ? art.winter.mul(loc.xz.length()).mul(0.076) : 0;
            m.positionNode = TSL.add(
              m.positionNode,
              vec3(flutter, flutter.mul(0.37).sub(snowLoad), flutter.mul(-0.53)),
            );
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
          if (recipe) {
            const lenticel = TSL.sin(uv().y.mul(29).add(tile.r.mul(4))).smoothstep(0.88, 0.99);
            m.colorNode = TSL.color(recipe.bark)
              .mul(tile.r.mul(0.53).add(0.42))
              .mul(
                TSL.float(1).sub(
                  lenticel.mul(
                    recipe.barkPattern === 'lenticels' ? 0.67 : recipe.barkPattern === 'scales' ? 0.36 : 0.13,
                  ),
                ),
              );
          }
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
              (art
                ? TSL.mix(
                    vec3(0.015, 0.025, 0.037),
                    vec3(0.25, 0.33, 0.31),
                    smoothstep(-0.1, 0.2, frame.sunDirection.y),
                  )
                : vec3(0.19, 0.24, 0.22)
              ).add(frame.sunColor.mul(frame.sunVisibility).mul(light.mul(0.22).add(0.035))),
            );
          if (recipe && art) {
            const barkMask = TSL.smoothstep(-0.015, 0.07, leaf.r.sub(leaf.g));
            const crownLight = TSL.mix(vec3(0.5, 0.61, 0.66), vec3(1.05, 0.99, 0.77), light).mul(
              leaf.g.mul(0.94).add(0.31),
            );
            m.colorNode = TSL.mix(
              m
                .colorNode!.mul(TSL.mix(vec3(1), TSL.color(recipe.foliage), 0.52))
                .mul(crownLight)
                .mul(TSL.mix(vec3(1), vec3(1.26, 0.66, 0.27), recipe.evergreen ? 0 : art.autumn)),
              TSL.color(recipe.bark)
                .mul(leaf.r.mul(0.45).add(0.27))
                .mul(
                  frame.sunColor
                    .mul(0.17)
                    .add(
                      TSL.mix(
                        vec3(0.025, 0.037, 0.052),
                        vec3(0.31, 0.36, 0.4),
                        smoothstep(-0.1, 0.2, frame.sunDirection.y),
                      ),
                    ),
                ),
              barkMask,
            );
          }
          const farAlpha =
            art && recipe && !recipe.evergreen
              ? leaf.a.mul(TSL.mix(TSL.float(1), TSL.smoothstep(-0.02, 0.05, leaf.r.sub(leaf.g)), art.winter))
              : leaf.a;
          add(far.geometry, m, farAlpha.mul(glancing), 'sprays');
          continue;
        }
        const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
        const leaf = texture(atlas.leaf);
        const colour = mix(leaf.rgb, TSL.floor(leaf.rgb.mul(6)).div(6), this.bands.mul(0.8));
        m.colorNode = this.tint.mul(colour.mul(0.79).add(0.2)).mul(kind === 'cypress' ? 0.77 : 1.03);
        if (kind === 'sagebrush')
          m.colorNode = m.colorNode!.mul(vec3(0.86, 1, 1.31)).add(vec3(0.016, 0.022, 0.021));
        if (recipe && art) {
          m.colorNode = m
            .colorNode!.mul(TSL.color(recipe.foliage))
            .mul(TSL.mix(vec3(1), vec3(1.4, 0.63, 0.22), recipe.evergreen ? 0 : art.autumn));
          if (recipe.evergreen)
            m.colorNode = TSL.mix(
              m.colorNode,
              vec3(0.65, 0.74, 0.78),
              art.winter.mul(TSL.smoothstep(0.36, 0.88, TSL.normalWorld.y)).mul(0.74),
            );
          this.leafStyles.push({ material: m, base: m.colorNode });
          if (art.direction.leafShader) m.colorNode = art.direction.leafShader(m.colorNode, m);
        }
        const transmission = TSL.dot(positionWorld.sub(cameraPosition).normalize(), frame.sunDirection).max(
          0,
        );
        m.emissiveNode = this.tint
          .mul(frame.sunColor)
          .mul(frame.sunVisibility)
          .mul(transmission.mul(art?.transmission ?? 0.11).add(0.035))
          .mul(leaf.g);
        if (art && recipe)
          m.emissiveNode = TSL.add(
            m.emissiveNode,
            TSL.color(recipe!.foliage).mul(art.emission).mul(leaf.g.pow(4)),
          );
        if (level < 2) {
          const detail = texture(atlas.detail);
          m.roughnessNode = detail.b.mul(0.46).add(0.36);
          m.normalNode = TSL.normalMap(vec3(detail.rg, 1), vec2(0.34));
        }
        add(sprayGeometry(form, level === 1, kind), m, leaf.a, 'sprays');
      }
      this.batches.set(batchKey, { levels, range, margin });
    }
  }
  private included(t: Tree) {
    return (
      t.priority <= this.fraction * (this.art ? (t.shrub ? this.art.shrubDensity : this.art.treeDensity) : 1)
    );
  }
  nearest(x: number, z: number, camera?: THREE.Camera, treesOnly = false) {
    let best: Tree | undefined,
      min = Infinity;
    for (const ch of this.chunks.values())
      for (const t of ch.trees) {
        if (!this.included(t) || (treesOnly && t.shrub)) continue;
        const d = (t.x - x) ** 2 + (t.z - z) ** 2;
        if (d < min) {
          best = t;
          min = d;
        }
      }
    if (!best) return;
    const batch = this.batches.get(best.key)!;
    const distance = camera ? camera.position.distanceTo(this.lookup.set(best.x, best.y, best.z)) : 0;
    return {
      id: best.id,
      recipe: best.key.split('/')[0],
      variant: best.key,
      scale: best.matrix.elements[5],
      level:
        distance < batch.range * this.nearDistance.value
          ? 'near'
          : distance < batch.range * this.nearDistance.value * 2.5
            ? 'mid'
            : 'far',
      x: best.x,
      y: best.y,
      z: best.z,
    };
  }
  applyLeafStyle() {
    for (const { material, base } of this.leafStyles) {
      material.colorNode = this.art?.direction.leafShader?.(base, material) ?? base;
      material.needsUpdate = true;
    }
  }
  poseFor(id: string, out: THREE.Matrix4) {
    for (const ch of this.chunks.values())
      for (const t of ch.trees)
        if (t.id === id) {
          out.copy(t.matrix);
          return true;
        }
    return false;
  }
  refresh() {
    this.dirty = true;
  }
  private readonly lookup = new THREE.Vector3();
  private readonly fallenPose = new THREE.Matrix4();
  private readonly fall = new THREE.Matrix4().makeRotationZ(Math.PI * 0.45);
  bakeShade(texture: THREE.DataTexture, size: number) {
    const res = texture.image.width,
      pixels = texture.image.data as Uint8Array;
    pixels.fill(255);
    for (const chunk of this.chunks.values())
      for (const t of chunk.trees) {
        if (!this.included(t)) continue;
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
        if (!this.included(t)) continue;
        const b = this.batches.get(t.key)!,
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
            const fallen = this.art?.earth.fallenMatrices.get(t.id);
            mesh.setMatrixAt(
              mesh.count++,
              fallen
                ? this.fallenPose.fromArray(fallen)
                : this.art?.earth.fallen.has(t.id)
                  ? this.fallenPose.multiplyMatrices(t.matrix, this.fall)
                  : t.matrix,
            );
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
