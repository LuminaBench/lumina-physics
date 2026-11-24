import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { perturbNormalHeight } from '../../engine/shading';
import { mulberry32 } from '../../engine/noise';
import { MineralFacets } from '../materials/mineral-facets';
import type { Bathymetry } from '../water/seabed';
import type { MobileDune } from './mobile-dune';
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
  private readonly map = new Uint8Array(NPIX * NPIX * 8);
  private readonly moistureMap = this.map.subarray(NPIX * NPIX * 4);
  private readonly minerals: THREE.DataTexture;
  private submergedBed?: N;
  readonly facets?: MineralFacets;
  private readonly origin = TSL.uniform(new THREE.Vector2(-1e5, -1e5));
  private readonly on = TSL.uniform(0);
  private readonly strength = TSL.uniform(0.54);
  private readonly waterLevel = TSL.uniform(0);
  detail?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardNodeMaterial>;
  constructor(
    readonly sediment: CoastalSediment,
    private windHeading = 0.26,
    private swellHeading = -0.42,
    private dune?: MobileDune,
    private cloudShadow?: (p: N) => N,
    private terrainSun?: (p: N) => N,
    private reflectedRadiance?: (p: N, dir: N, lod: N) => N,
  ) {
    this.texture = new THREE.DataTexture(this.map, NPIX, NPIX * 2);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.minerals = grains(sediment.coast.seed + 2207, sediment.coast.sand);
    const recipe=sediment.coast.sand;
    if (recipe.facetFraction) this.facets=new MineralFacets({
      seed:(sediment.coast.seed+4411)>>>0,fraction:recipe.facetFraction,
      diameterMm:recipe.facetDiameterMm??recipe.grainMm,tilt:recipe.facetTilt??0.45,
    });
  }
  material() {
    return this.facets ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  }
  private coordinates(xz: N) {
    return xz.sub(this.origin).div(SPAN);
  }
  private sampleState(uv: N, moisture = false) {
    // Two stacked pages share one sampler on WebGL 2. Clamp to texel centres
    // before remapping, so bilinear filtering cannot bleed across the page seam.
    const local = uv.clamp(0.5 / NPIX, 1 - 0.5 / NPIX);
    return TSL.texture(this.texture, TSL.vec2(local.x, local.y.mul(0.5).add(moisture ? 0.5 : 0))).level(0);
  }
  private localMask(uv: N) {
    return uv.greaterThanEqual(0).all().and(uv.lessThan(1).all()).and(this.on.greaterThan(0.5));
  }
  private detailMask(xz: N) {
    const uv=this.coordinates(xz), active=this.localMask(uv);
    const inlet=this.sediment.surf.localWater;
    if (!inlet) return active;
    // The surveyed bed already carries film and turbidity. Replace its geometry only
    // where a contact moved grains, keeping the undisturbed angled bed continuous.
    const relief=this.sampleState(uv).r.mul(255).sub(128).abs();
    return active.and(inlet.weightNode(xz).lessThan(0.999).or(relief.greaterThan(0.3)));
  }
  readonly sedimentAt = (xz: N): N => {
    const uv = this.coordinates(xz),
      edge = TSL.min(uv, uv.oneMinus());
    return this.sampleState(uv)
      .a.mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)))
      .mul(this.on);
  };
  private paint(mat: THREE.MeshStandardNodeMaterial, under: N, shore: N, fine: boolean, macroNormal?: N, grainElevation?: N) {
    const { positionWorld: p, vec2, texture, clamp, float, mix, sin, cos, color, smoothstep } = TSL;
    const s = this.sediment.coast.sand,
      xz = p.xz,
      uv = this.coordinates(xz);
    const localStage = this.sediment.surf.localWater?.stageNode(xz, this.waterLevel) ?? this.waterLevel;
    if (this.sediment.surf.localWater) shore = p.y.sub(localStage);
    const edge = TSL.min(uv, uv.oneMinus()),
      weight = smoothstep(0, 0.13, TSL.min(edge.x, edge.y));
    const empty = TSL.vec4(128 / 255, 0, 0, 0),
      state =
        fine || this.sediment.surf.localWater ? mix(empty, this.sampleState(uv), weight.mul(this.on)) : empty;
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
    // Deposited streaks consist of many clasts. Keep the streak at driving distance
    // while the mip-filtered clast tap averages to the local mineral mixture.
    const streak = smoothstep(0.57, 0.86, sorting.mul(0.69).add(coarse.x.mul(0.31)));
    const heavy = streak.mul(0.42);
    const composition = this.dune?.compositionNode(xz).toVar();
    const lightClasts = mix(pigment, color(s.pale), grain.b.mul(0.54));
    const colorDry = mix(lightClasts, color(s.heavy), heavy.add(grain.a.mul(0.6)).min(1));
    const envelope = this.sediment.surf.node(xz, shore.negate(), frame.time, this.strength, localStage).x;
    const runup = fine ? envelope.toVarying('sandContactRunup') : envelope;
    const instantaneous = smoothstep(-0.008, 0.012, runup.sub(shore));
    const wet =
      fine || this.sediment.surf.localWater
        ? this.sampleState(uv, true).rgb.mul(weight.mul(this.on)).toVar()
        : TSL.vec3(0);
    const standing = smoothstep(0.0003, 0.0028, wet.z.mul(wet.z).mul(0.1275));
    // A retreating meniscus exposes the higher grains first. The pore contribution stays diffuse.
    const connected = smoothstep(grain.r.mul(0.38).add(0.08), grain.r.mul(0.38).add(0.57), wet.x);
    const film = instantaneous.max(connected.mul(0.67)).max(standing);
    const moisture = smoothstep(-0.32, 0.1, shore.negate()).mul(0.49).max(wet.y.sqrt()).max(film);
    const indentation = smoothstep(0.001, 0.033, float(128).sub(state.r.mul(255)).mul(0.001));
    const tint = colorDry
      .mul(indentation.mul(-0.24).add(1))
      .mul(moisture.mul(-0.37).add(1))
      .mul(film.mul(-0.14).add(1));
    const submerged = mix(tint, under, smoothstep(0.2, 1.7, shore.negate()).mul(0.84));
    let soil = mix(submerged, color(s.mineral).mul(0.8), state.a.mul(0.72).mul(standing));
    if (composition) {
      const fragments = smoothstep(0.38, 0.7, clast.r.mul(0.65).add(speck.g.mul(0.35)));
      const coarseGrains = mix(color(s.heavy), color(s.pale), fragments.mul(0.91));
      soil = mix(soil, coarseGrains.mul(moisture.mul(-0.42).add(1)), composition.g.mul(0.8));
      // Closely packed substrate and less-exposed fine seams in the wall of a cut.
      const layer = cos(p.y.mul(37).add(coarse.y.mul(3.5)).add(xz.x.mul(0.31)));
      const shellBed = mix(color(s.heavy), color(s.mineral), fragments.mul(0.64).add(0.08)).mul(
        layer.mul(0.08).add(0.92),
      );
      soil = mix(soil, shellBed.mul(moisture.mul(-0.38).add(1)), composition.r.mul(0.92));
    }
    const lens = this.dune?.strata;
    const section = lens?.sectionNode(xz, grainElevation ?? p.y).toVar(),
      marker = section?.x;
    if (lens && section) {
      // Fine laminae follow burial depth and disappear when the grains are reworked.
      const phase = section.y.mul(255).add(clast.g.mul(1.15)).add(speck.r.mul(0.35));
      const lamina = cos(phase)
        .mul(smoothstep(2.9, 0.6, TSL.fwidth(phase)))
        .mul(section.z);
      const fleck = smoothstep(0.52, 0.82, clast.g.mul(0.47).add(speck.g.mul(0.53)));
      const grains = clast.r
        .mul(0.14)
        .add(grain.b.mul(0.35))
        .add(fleck.mul(0.31))
        .add(lamina.mul(0.09))
        .clamp(0, 1);
      const exposed = mix(color(lens.lens.mineral), color(lens.lens.pale), grains);
      // At a graded contact, neighbouring clasts interleave across the seam.
      const mottling = speck.g.sub(0.5).mul(0.95).add(clast.r.sub(0.5).mul(0.55));
      const cover = marker.add(marker.mul(marker.oneMinus()).mul(mottling)).clamp(0, 1);
      soil = mix(soil, exposed.mul(moisture.mul(-0.4).add(1)), cover.mul(0.95));
    }
    const cloud = this.cloudShadow?.(p).toVar();
    mat.colorNode = cloud ? soil.mul(cloud.mul(0.36).add(0.64)) : soil;
    const drift = texture(this.minerals, xz.mul(0.0073)).rg.toVar();
    let windAxis = vec2(Math.cos(this.windHeading), Math.sin(this.windHeading));
    if (this.dune && composition) {
      const axis = this.dune.rippleAxis;
      const turn = TSL.atan(axis.y.mul(windAxis.x).sub(axis.x.mul(windAxis.y)), TSL.dot(axis, windAxis));
      const heading = turn.mul(composition.b).add(this.windHeading);
      windAxis = vec2(cos(heading), sin(heading));
    }
    const swellAxis = vec2(Math.cos(this.swellHeading), Math.sin(this.swellHeading));
    // Vary wavelength and crest direction in continuous patches. The wet and
    // dry beds keep their own orientation through a draining swash cycle.
    const acrossWind = vec2(windAxis.y.negate(), windAxis.x);
    const curved = TSL.dot(xz, acrossWind).mul(0.41).add(drift.y.mul(6));
    const phase = TSL.dot(xz, windAxis)
      .mul(17.7)
      .add(sin(curved).mul(2.9))
      .add(coarse.y.mul(23))
      .add(drift.x.mul(6))
      .add(sin(xz.y.mul(0.42)).mul(2.5));
    const wetRipple = sin(
      TSL.dot(xz, swellAxis)
        .mul(21.9)
        .add(coarse.x.mul(18))
        .add(sin(xz.x.mul(0.67).sub(xz.y.mul(0.39)).add(drift.x.mul(4))).mul(2.1)),
    );
    const ripple = mix(
      cos(phase)
        .mul(0.7)
        .add(cos(phase.mul(2).sub(0.7)).mul(0.3)),
      wetRipple,
      smoothstep(0.18, -0.3, shore),
    );
    const resolved = smoothstep(Math.PI, 0.5, TSL.fwidth(phase));
    const ridge = ripple
      .mul(resolved)
      .mul(0.0031 + 0.0024 * s.angularity)
      .mul(smoothstep(0.26, 0.68, drift.y))
      .mul(smoothstep(0.23, 0.63, clast.g.mul(0.32).add(drift.x.mul(0.68))))
      .mul(standing.oneMinus());
    const crestRelief = state.r.mul(255).sub(128).mul(0.00072).mul(standing.oneMinus());
    const grainsH = grain.g
      .mul(0.00045 * s.grainMm)
      .add(speck.g.mul(0.0013))
      .add(clast.g.mul(0.0019))
      .mul(standing.oneMinus());
    const mineralRelief = marker ? grainsH.mul(marker.mul(lens!.lens.coarseFraction * 0.85).add(1)) : grainsH;
    mat.normalNode = perturbNormalHeight(
      crestRelief.add(ridge).add(mineralRelief),
      1,
      macroNormal ?? TSL.normalView,
    );
    if (mat instanceof THREE.MeshPhysicalNodeMaterial) {
      // Standing water supplies a separate smooth interface. The polished, exposed
      // grain faces progressively disappear beneath that film and submerged sediment.
      let exposed = film
        .mul(0.82)
        .oneMinus()
        .mul(smoothstep(-0.035, 0.035, shore));
      const horizon = this.terrainSun?.(p);
      // The horizon survey varies over metres. Interpolate it on the 5.6 cm contact mesh
      // to leave a fragment sampler available for the same reflected stake on WebGL 2.
      const directSun = (cloud ?? float(1)).mul(
        (fine ? horizon?.toVarying('sandHorizon') : horizon) ?? float(1),
      );
      exposed = exposed.mul(directSun.mul(0.86).add(0.14));
      this.facets?.apply(mat, xz, mat.normalNode, exposed);
      // Water between grains reduces contrast at buried mineral interfaces. The smooth
      // free-surface reflection is evaluated separately in the near-field pass.
      mat.specularIntensityNode = wet.y.mul(-0.55).add(1);
    }
    const dryRough = float(0.78 + 0.12 * s.angularity)
      .sub(grain.b.mul(0.09))
      .add(resolved.oneMinus().mul(0.025));
    const granularRoughness = mix(
      composition ? dryRough.add(composition.g.mul(0.075)).sub(composition.r.mul(0.1)) : dryRough,
      dryRough.sub(0.055),
      moisture,
    );
    mat.roughnessNode =
      fine && this.reflectedRadiance
        ? granularRoughness
        : mix(granularRoughness, float(0.115), film.mul(film));
    if (this.reflectedRadiance && fine) {
      const radiance = this.reflectedRadiance;
      const cover = standing.max(connected.mul(0.64));
      mat.outputNode = TSL.Fn(() => {
        const base = TSL.output.rgb.toVar();
        TSL.If(cover.greaterThan(0.001), () => {
          const view = TSL.cameraPosition.sub(p).normalize();
          const smoothBed = TSL.cameraWorldMatrix
            .mul(TSL.vec4(macroNormal ?? TSL.normalView, 0))
            .xyz.normalize();
          const normal = mix(smoothBed, TSL.vec3(0, 1, 0), standing).normalize();
          const dir = TSL.reflect(view.negate(), normal);
          const fresnel = TSL.dot(normal, view).clamp(0, 1).oneMinus().pow(5).mul(0.98).add(0.02);
          const lod = standing.oneMinus().mul(2.4).add(0.16);
          base.assign(mix(base, radiance(p, dir, lod), fresnel.mul(cover)));
        });
        return TSL.vec4(base, TSL.output.a);
      })();
    }
  }
  readonly shadeTerrain = (mat: THREE.MeshStandardNodeMaterial, waterColor: N, shore: N) => {
    this.submergedBed = waterColor;
    this.paint(mat, waterColor, shore, false);
    mat.maskNode = this.detailMask(TSL.positionWorld.xz).not();
  };
  attachDune(dune: MobileDune, scene: THREE.Scene) {
    const sand = this.sediment.coast.sand;
    const mat = this.material();
    const xz=TSL.positionWorld.xz;
    this.paint(mat,TSL.color(sand.mineral),TSL.positionWorld.y.sub(this.waterLevel),false);
    mat.maskNode = this.detailMask(xz).not().and(dune.depthNode(xz).greaterThan(0.0005));
    const mesh=new THREE.Mesh(dune.geometry,mat);
    mesh.position.set(dune.options.centerX,0,dune.options.centerZ);
    mesh.name='Loose dune over compact sand';mesh.castShadow=mesh.receiveShadow=true;
    scene.add(mesh);
    return {dispose(){mesh.removeFromParent();mat.dispose();}};
  }
  attach(bed: Bathymetry, scene: THREE.Scene) {
    const geom = new THREE.PlaneGeometry(SPAN, SPAN, 160, 160);
    geom.rotateX(-Math.PI / 2);
    const mat = this.material();
    const xz = TSL.positionGeometry.xz.add(this.origin).add(SPAN / 2),
      uv = this.coordinates(xz);
    const state = this.sampleState(uv);
    const edge = TSL.min(uv, uv.oneMinus());
    const delta = state.r
      .mul(255)
      .sub(128)
      .mul(0.001)
      .mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)));
    const h = bed.heightNode(xz);
    const lip = this.sediment.surf.atlasNode(xz).w.max(h);
    const shallow = this.sampleState(uv, true).b;
    const depth = shallow.mul(shallow).mul(0.1275);
    let pond = depth
      .min(lip.sub(h).sub(delta).max(0))
      .mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)));
    // Above the open sea the transported sheet owns its surface elevation, including
    // the water running out of a rut. The ocean keeps the connected free surface.
    pond = TSL.mix(pond, depth.mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y))),
      TSL.smoothstep(0.02, 0.16, h.sub(this.waterLevel)));
    const inlet = this.sediment.surf.localWater;
    if (inlet) {
      // The inlet already draws its own free surface above the bed of a connected pool.
      const reached = TSL.smoothstep(-0.025, 0.025, inlet.stageNode(xz,this.waterLevel).sub(h));
      pond = pond.mul(inlet.weightNode(xz).mul(reached).oneMinus());
    }
    mat.positionNode = TSL.vec3(TSL.positionGeometry.x, h.add(delta).add(pond), TSL.positionGeometry.z);
    const recipe = this.sediment.coast.sand;
    // The moving patch has a flat source mesh. Reconstruct the displaced bed normal in
    // the vertex stage and interpolate it, so a cut does not show its triangulation.
    const step = Math.max(SPAN / 160, this.dune?.spacing ?? 0);
    const dx = TSL.vec2(step, 0), dz = TSL.vec2(0, step);
    const gx = bed.heightNode(xz.sub(dx)).sub(bed.heightNode(xz.add(dx)));
    const gz = bed.heightNode(xz.sub(dz)).sub(bed.heightNode(xz.add(dz)));
    const normal = TSL.cameraViewMatrix.mul(TSL.vec4(gx, 2 * step, gz, 0)).xyz
      .toVarying('coastalBedNormal').normalize();
    this.paint(
      mat,
      this.submergedBed ?? TSL.color(recipe.mineral).mul(0.75),
      TSL.positionWorld.y.sub(this.waterLevel),
      true,
      normal,
      h.toVarying('sandBeforeContactCompression'),
    );
    if (inlet) mat.maskNode=this.detailMask(TSL.positionWorld.xz);
    mat.receivedShadowNode = (bed.mesh.material as THREE.MeshStandardNodeMaterial).receivedShadowNode;
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
    this.sediment.raster(gx, gz, NPIX, this.map, this.moistureMap);
    this.origin.value.set(gx * SEDIMENT_SPACING, gz * SEDIMENT_SPACING);
    this.detail.position.set(this.origin.value.x + SPAN / 2, 0, this.origin.value.y + SPAN / 2);
    this.texture.needsUpdate = true;
  }
  dispose() {
    this.facets?.dispose();
    this.detail?.removeFromParent();
    this.detail?.geometry.dispose();
    this.detail?.material.dispose();
    this.minerals.dispose();
    this.texture.dispose();
  }
}
