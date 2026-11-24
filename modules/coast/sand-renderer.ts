import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { perturbNormalHeight } from '../../engine/shading';
import { mulberry32 } from '../../engine/noise';
import type { Bathymetry } from '../water/seabed';
import type { SandRecipe } from './coastline';
import { CoastalSediment, SEDIMENT_SPACING } from './sediment';

const NPIX = 224,
  SPAN = NPIX * SEDIMENT_SPACING;
function grains(seed: number, sand: SandRecipe) {
  const n = 128,
    data = new Uint8Array(4 * n * n),
    rand = mulberry32(seed);
  for (let i = 0; i < data.length; i += 4) {
    const mineral = rand();
    data[i] = 255 * mineral;
    data[i + 1] = 255 * rand();
    data[i + 2] = mineral < (sand.paleFraction ?? 0.12) ? 255 : 0;
    data[i + 3] = mineral > 1 - (sand.heavyFraction ?? 0.06) ? 255 : 0;
  }
  const texture = new THREE.DataTexture(data, n, n);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
/** A single detailed moving patch replaces the coarse bed triangles around a contact.
 * The rest of the world retains the same sand material and filtered mineral distribution. */
export class CoastalSandRenderer {
  readonly texture: THREE.DataTexture;
  private readonly map = new Uint8Array(NPIX * NPIX * 4);
  private readonly minerals: THREE.DataTexture;
  private readonly origin = TSL.uniform(new THREE.Vector2(-1e5, -1e5));
  private readonly on = TSL.uniform(0);
  private readonly strength = TSL.uniform(0.54);
  private readonly waterLevel = TSL.uniform(0);
  detail?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardNodeMaterial>;
  constructor(
    readonly sediment: CoastalSediment,
    private windHeading = 0.26,
    private swellHeading = -0.42,
  ) {
    this.texture = new THREE.DataTexture(this.map, NPIX, NPIX);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.minerals = grains(sediment.coast.seed + 2207, sediment.coast.sand);
  }
  private coordinates(xz: N) {
    return xz.sub(this.origin).div(SPAN);
  }
  private localMask(uv: N) {
    return uv.greaterThanEqual(0).all().and(uv.lessThan(1).all()).and(this.on.greaterThan(0.5));
  }
  readonly sedimentAt = (xz: N): N => {
    const uv = this.coordinates(xz),
      edge = TSL.min(uv, uv.oneMinus());
    return TSL.texture(this.texture, uv)
      .level(0)
      .a.mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)))
      .mul(this.on);
  };
  private paint(mat: THREE.MeshStandardNodeMaterial, under: N, shore: N, fine: boolean) {
    const { positionWorld: p, vec2, texture, clamp, float, mix, sin, cos, color, smoothstep } = TSL;
    const s = this.sediment.coast.sand,
      xz = p.xz,
      uv = this.coordinates(xz);
    const edge = TSL.min(uv, uv.oneMinus()),
      weight = smoothstep(0, 0.13, TSL.min(edge.x, edge.y));
    const empty = TSL.vec4(128 / 255, 0, 0, 0),
      state = fine ? mix(empty, texture(this.texture, uv), weight) : empty;
    const coarse = texture(this.minerals, xz.mul(0.00067)).rg.toVar();
    const clast = texture(this.minerals, xz.mul(0.105)).rg.toVar();
    const speck = texture(this.minerals, xz.mul(0.81)).rg.toVar();
    const sorting = sin(xz.y.mul(0.17).add(coarse.x.mul(7)).add(xz.x.mul(0.38)))
      .mul(0.5)
      .add(0.5);
    const macro = smoothstep(0.29, 0.73, coarse.y.mul(0.65).add(sorting.mul(0.35)));
    const grain = texture(this.minerals, xz.div(0.128 * s.grainMm + 0.006)).toVar();
    const pigment = mix(
      color(s.mineral),
      color(s.pale),
      clamp(
        grain.r.mul(0.2).add(clast.r.mul(0.24)).add(speck.g.mul(0.17)).add(macro.mul(0.34)).add(0.05),
        0,
        1,
      ),
    );
    const heavy = smoothstep(0.7, 0.95, sorting.mul(0.62).add(coarse.x.mul(0.38))).mul(0.36);
    const lightClasts = mix(pigment, color(s.pale), grain.b.mul(0.54));
    const colorDry = mix(lightClasts, color(s.heavy), heavy.add(grain.a.mul(0.6)).min(1));
    const envelope = this.sediment.surf.node(
      xz,
      shore.negate(),
      frame.time,
      this.strength,
      this.waterLevel,
    ).x;
    const instantaneous = smoothstep(-0.008, 0.012, envelope.sub(shore));
    const moisture = smoothstep(-0.32, 0.1, shore.negate()).mul(0.49).max(state.g).max(instantaneous);
    const standing = smoothstep(0.006, 0.038, state.b.mul(0.1275)),
      film = instantaneous.max(state.g.mul(0.72)).max(standing);
    const indentation = smoothstep(0.001, 0.033, float(128).sub(state.r.mul(255)).mul(0.001));
    const tint = colorDry
      .mul(indentation.mul(-0.24).add(1))
      .mul(moisture.mul(-0.37).add(1))
      .mul(film.mul(-0.14).add(1));
    const submerged = mix(tint, under, smoothstep(0.2, 1.7, shore.negate()).mul(0.84));
    mat.colorNode = mix(submerged, color(s.mineral).mul(0.8), state.a.mul(0.72).mul(standing));
    const drift = texture(this.minerals, xz.mul(0.0073)).rg.toVar();
    const windAxis = vec2(Math.cos(this.windHeading), Math.sin(this.windHeading));
    const swellAxis = vec2(Math.cos(this.swellHeading), Math.sin(this.swellHeading));
    const phase = TSL.dot(xz, windAxis)
      .mul(17.7)
      .add(coarse.y.mul(23))
      .add(drift.x.mul(6))
      .add(sin(xz.y.mul(0.42)).mul(2.5));
    const wetRipple = sin(TSL.dot(xz, swellAxis).mul(21.9).add(coarse.x.mul(18)));
    const ripple = mix(
      cos(phase)
        .mul(0.7)
        .add(cos(phase.mul(2).sub(0.7)).mul(0.3)),
      wetRipple,
      smoothstep(0.18, -0.3, shore),
    );
    const ridge = ripple
      .mul(0.0018 + 0.0018 * s.angularity)
      .mul(smoothstep(0.25, 0.72, drift.y))
      .mul(standing.oneMinus());
    const crestRelief = state.r.mul(255).sub(128).mul(0.00072).mul(standing.oneMinus());
    const grainsH = grain.g
      .mul(0.00045 * s.grainMm)
      .add(speck.g.mul(0.0013))
      .add(clast.g.mul(0.0019))
      .mul(standing.oneMinus());
    mat.normalNode = perturbNormalHeight(crestRelief.add(ridge).add(grainsH), 1);
    mat.roughnessNode = mix(
      mix(float(0.81 + 0.11 * s.angularity).sub(grain.b.mul(0.085)), float(0.46), moisture),
      float(0.115),
      film.mul(film),
    );
  }
  readonly shadeTerrain = (mat: THREE.MeshStandardNodeMaterial, waterColor: N, shore: N) => {
    this.paint(mat, waterColor, shore, false);
    mat.maskNode = this.localMask(this.coordinates(TSL.positionWorld.xz)).not();
  };
  attach(bed: Bathymetry, scene: THREE.Scene) {
    const geom = new THREE.PlaneGeometry(SPAN, SPAN, 160, 160);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.flatShading = true;
    const xz = TSL.positionGeometry.xz.add(this.origin).add(SPAN / 2),
      uv = this.coordinates(xz);
    const state = TSL.texture(this.texture, uv).level(0);
    const edge = TSL.min(uv, uv.oneMinus());
    const delta = state.r
      .mul(255)
      .sub(128)
      .mul(0.001)
      .mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)));
    const h = bed.heightNode(xz);
    const lip = this.sediment.surf.atlasNode(xz).w.max(h);
    const pond = state.b
      .mul(0.1275)
      .min(lip.sub(h).sub(delta).max(0))
      .mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)));
    mat.positionNode = TSL.vec3(TSL.positionGeometry.x, h.add(delta).add(pond), TSL.positionGeometry.z);
    const recipe = this.sediment.coast.sand;
    this.paint(mat, TSL.color(recipe.mineral).mul(0.75), TSL.positionWorld.y.sub(this.waterLevel), true);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'Coastal sand contact surface';
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.detail = mesh;
  }
  update(x: number, z: number, visible: boolean) {
    if (!this.detail) return;
    this.strength.value = this.sediment.strength;
    this.waterLevel.value = this.sediment.level;
    this.on.value = Number(visible);
    this.detail.visible = visible;
    if (!visible) return;
    const gx = Math.floor(x / SEDIMENT_SPACING) - NPIX / 2,
      gz = Math.floor(z / SEDIMENT_SPACING) - NPIX / 2;
    this.sediment.raster(gx, gz, NPIX, this.map);
    this.origin.value.set(gx * SEDIMENT_SPACING, gz * SEDIMENT_SPACING);
    this.detail.position.set(this.origin.value.x + SPAN / 2, 0, this.origin.value.y + SPAN / 2);
    this.texture.needsUpdate = true;
  }
  dispose() {
    this.detail?.removeFromParent();
    this.detail?.geometry.dispose();
    this.detail?.material.dispose();
    this.minerals.dispose();
    this.texture.dispose();
  }
}
