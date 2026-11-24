import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import { TSL, type N } from '../../engine/tsl';

export interface MineralFacetOptions {
  /** Area fraction of exposed, flat dielectric mineral faces. */
  fraction: number;
  /** Typical projected width of an exposed face in millimetres. */
  diameterMm: number;
  /** Width of the distribution of face slopes; dimensionless rise over run. */
  tilt: number;
  roughness?: number;
  seed: number;
}

/** A sampled mineral population for ground viewed from walking, driving or flight height.
 *  RGBA stores area-weighted tangent slopes, coverage and the second slope moment. Filtering
 *  gives mean slope conditional on a facet actually being present, even at an edge.
 */
export class MineralFacets {
  readonly texture: THREE.DataTexture;
  readonly strength = TSL.uniform(1);
  private readonly tileMetres: number;
  private readonly size = 128;
  readonly options: Readonly<MineralFacetOptions>;
  constructor(options: MineralFacetOptions) {
    this.options = Object.freeze({ ...options });
    const { fraction, diameterMm, tilt, roughness = 0.115, seed } = options;
    if (
      !Number.isFinite(fraction) ||
      fraction < 0 ||
      fraction > 1 ||
      !Number.isFinite(diameterMm) ||
      diameterMm <= 0 ||
      !Number.isFinite(tilt) ||
      tilt < 0 ||
      tilt > 1 ||
      !Number.isFinite(roughness) ||
      roughness <= 0 ||
      roughness > 1 ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff
    )
      throw new RangeError('Invalid mineral face coverage, diameter, tilt, roughness or seed');
    const pixels = new Uint8Array(4 * this.size * this.size),
      random = mulberry32(seed);
    for (let k = 0; k < pixels.length; k += 4) {
      const covered = random() < fraction,
        angle = random() * 2 * Math.PI,
        r = Math.sqrt(random());
      if (covered) {
        pixels[k] = Math.round(127.5 * (1 + r * Math.cos(angle)));
        pixels[k + 1] = Math.round(127.5 * (1 + r * Math.sin(angle)));
        pixels[k + 2] = 255;
        pixels[k + 3] = Math.round(255 * r * r);
      }
    }
    this.texture = new THREE.DataTexture(pixels, this.size, this.size);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.texture.needsUpdate = true;
    this.tileMetres = (this.size * diameterMm) / 1000;
  }
  /** Supply coordinates in metres and the same view-space surface normal as the base material.
   *  The optional tangent axis is a view-space direction along increasing U on the host's surface.
   */
  apply(
    material: THREE.MeshPhysicalNodeMaterial,
    metres: N,
    normal: N,
    exposed: N = TSL.float(1),
    tangent?: N,
  ) {
    const { vec4, dFdx, dFdy, texture, length, max, mix, normalize, dot, cross } = TSL;
    const footprint = max(length(dFdx(metres)), length(dFdy(metres)));
    const averaged = TSL.smoothstep(0.8, 4.0, footprint.mul(1000 / this.options.diameterMm));
    const sample = texture(this.texture, metres.div(this.tileMetres)).toVar();
    const coverage = mix(sample.b, this.options.fraction, averaged);
    const safeCoverage = coverage.max(1 / 255);
    const meanSlope = sample.rg.mul(2).sub(sample.b).mul(averaged.oneMinus()).div(safeCoverage);
    // The sampled disk has E[r²] = 1/2. Variance widens the lobe while
    // differently oriented faces progressively collapse into a single pixel.
    const meanSquared = mix(sample.a, this.options.fraction * 0.5, averaged).div(safeCoverage);
    const variance = meanSquared
      .sub(dot(meanSlope, meanSlope))
      .max(0)
      .mul(this.options.tilt ** 2);
    const localSlope = meanSlope.mul(this.options.tilt);
    const n = normalize(normal);
    const worldX = TSL.cameraViewMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const x = tangent ? normalize(tangent) : worldX;
    const z = TSL.cameraViewMatrix.mul(vec4(0, 0, 1, 0)).xyz;
    const fallback = TSL.select(dot(n, z).abs().lessThan(0.95), z, worldX);
    const axis = TSL.select(dot(n, x).abs().lessThan(0.95), x, fallback);
    const u = normalize(axis.sub(n.mul(dot(axis, n))));
    const v = normalize(cross(u, n));
    const rough = this.options.roughness ?? 0.115;
    material.clearcoatNode = coverage.mul(exposed.clamp(0, 1)).mul(this.strength.clamp(0, 1));
    material.clearcoatNormalNode = normalize(n.add(u.mul(localSlope.x)).add(v.mul(localSlope.y)));
    material.clearcoatRoughnessNode = variance
      .mul(2)
      .add(rough ** 4)
      .pow(0.25)
      .clamp(rough, 1);
  }
  dispose() {
    this.texture.dispose();
  }
}
