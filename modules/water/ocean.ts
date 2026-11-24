/**
 * Universal adaptive ocean.
 *
 * Multi-cascade JONSWAP/Tessendorf FFT displacement (WebGPU compute, CPU twin on WebGL 2)
 * rendered on a camera-centred polar grid with physically based optics:
 *
 *   - Schlick Fresnel between the cloud-bearing sky reflection (+ in-material SSR) and the
 *     refracted water body,
 *   - depth-buffer Beer–Lambert absorption: sand → turquoise → abyssal navy from one set of
 *     coefficients,
 *   - GGX sun glitter whose roughness grows with the wave detail that falls below a pixel,
 *   - back-lit subsurface scattering through thin crests and the tsunami lip,
 *   - Jacobian whitecaps with persistence, wake / blast foam from the interaction field,
 *     shoreline breakers and swash foam driven by the bathymetry.
 *
 * `sample()` returns the same surface on the CPU for buoyancy and hydrodynamics.
 */
import * as THREE from 'three/webgpu';
import { fireLights } from '../../engine/particles';
import { TSL, type N } from '../../engine/tsl';
import { dielectricSunGlint, specularAA, refractedScreenUV, viewportDepthAt } from '../../engine/shading';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import { valueNoise2, fbm2, voronoi2 } from '../../engine/noise';
import { traceReflection, localLightVisibility } from '../../engine/ssr';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import type { Weather } from '../weather/weather';
import { buildInitialSpectrum, cascadeLayout, significantHeight, OCEAN_LOOP_SECONDS, OCEAN_PRESETS, type CascadeLayout, type OceanParams } from './spectrum';
import { CpuCascade } from './fft-cpu';
import { GpuCascade, type OceanSimUniforms } from './fft-gpu';
import { Tsunami } from './tsunami';
import { InteractionField } from './interaction';
import type { Bathymetry } from './seabed';
import { breakerAt, breakerNode, swashAmplitude } from './shore-breaker';

const {
  Fn, If, float, vec2, vec3, vec4, uniform, texture, positionGeometry, positionWorld, positionView, cameraPosition, cameraViewMatrix,
  cameraNear, cameraFar, screenUV, viewportSharedTexture, perspectiveDepthToViewZ, normalize, cross, dot, length,
  reflect, mix, smoothstep, exp, pow, max, min, fract, sin, fwidth, dFdx, dFdy, select, abs, Discard, sqrt,
} = TSL;

export interface OceanOptics {
  /** 0 = murky green harbour water, 1 = crystal-clear tropical water. */
  clarity: number;
  /** 0..1 whitecap amount (maps to the Jacobian foam threshold). */
  foam: number;
  /** Subsurface-scattering glow strength through crests. */
  sss: number;
  /** Screen-space refraction strength. */
  refraction: number;
  /** Shoreline breaker amplitude in metres (bathymetry scenes). */
  breakerHeight: number;
}

/** One periodic tide. Phase is in cycles: 0 at mean level rising, 0.25 at high water. */
export interface TideOptions {
  amplitude: number;
  periodSeconds: number;
  phase?: number;
}

export interface OceanOptions {
  weather: Weather;
  bathymetry?: Bathymetry;
  /** Mean sea level (world Y). */
  waterLevel?: number;
  tide?: TideOptions;
}

export interface OceanSample {
  height: number;
  normal: THREE.Vector3;
}

interface Cascade {
  layout: CascadeLayout;
  resolution: number;
  gpu: GpuCascade | null;
  cpu: CpuCascade;
  keyInterval: number;
  displacement: THREE.Texture;
  derivatives: THREE.Texture;
  slopeVariance: N;
  delta: N;
  elapsed: number;
  cpuDisplacementHalf?: Uint16Array;
  cpuDerivativeHalf?: Uint16Array;
}

const OCEAN_GRID_RADIUS = 42000;

function polarGrid(segments: number, rings: number, inner: number, outer: number): THREE.BufferGeometry {
  const q = Math.pow(outer / inner, 1 / (rings - 1));
  const positions = new Float32Array((rings * segments + 1) * 3);
  let o = 3;
  for (let i = 0; i < rings; i++) {
    const r = inner * Math.pow(q, i);
    // Offset alternate rings by half a segment: equilateral-ish triangles, no radial seams.
    const phase = (i % 2) * 0.5;
    for (let j = 0; j < segments; j++) {
      const a = ((j + phase) / segments) * Math.PI * 2;
      positions[o++] = Math.cos(a) * r; positions[o++] = 0; positions[o++] = Math.sin(a) * r;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < segments; j++) indices.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segments, b0 = a0 + segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      if (i % 2 === 0) indices.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
      else indices.push(a0 + j, b0 + j1, b0 + j, a0 + j, a0 + j1, b0 + j1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(positions.length / 3 > 65535 ? new THREE.BufferAttribute(new Uint32Array(indices), 1) : new THREE.BufferAttribute(new Uint16Array(indices), 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outer * 1.1);
  return geometry;
}

/** Cascades sampled by `heightAt` (swell + wind sea): a smooth surface for hull physics. */
const PHYSICS_CASCADES = 2;
const _flow = new THREE.Vector3();

/** Reusable FFT query storage. Each output index corresponds to the supplied world point. */
export class OceanHeightBatch {
  readonly coordinates: Float64Array;
  readonly displacement: Float64Array;
  readonly shoal: Float64Array;
  readonly heights: Float64Array;
  constructor(count: number) {
    this.coordinates = new Float64Array(count * 2);
    this.displacement = new Float64Array(count * 3);
    this.shoal = new Float64Array(count);
    this.heights = new Float64Array(count);
  }
}

export class Ocean implements EngineModule {
  private lastClarity = NaN;
  private lastWindDir = NaN;
  private lastFoam = NaN;
  /** Blend and chop the blended sea statistics were last derived for (NaN after a spectrum rebuild). */
  private lastBlend = NaN;
  private lastChop = NaN;
  /** Bit i is set while cascade i carries simulation time from frames it sat out. */
  private carriedCascades = 0;
  private readonly singleProbe = new OceanHeightBatch(1);
  private readonly singlePoint = [new THREE.Vector3()];
  /** Sea state A (active when `morph` = 0). */
  readonly params: OceanParams = { ...OCEAN_PRESETS.breeze };
  /** Sea state B (active when `morph` = 1). */
  readonly targetParams: OceanParams = { ...OCEAN_PRESETS.swell };
  /** 0..1 live blend between sea state A and B (no rebuild, no hitch). */
  morph = 0;
  readonly optics: OceanOptics = { clarity: 0.85, foam: 0.5, sss: 1, refraction: 1, breakerHeight: 0.4 };
  readonly tsunami = new Tsunami();
  field!: InteractionField;
  mesh!: THREE.Mesh;
  /** Dense ribbon that rides the tsunami crest (visible only while a wave is active). */
  crestStrip!: THREE.Mesh;
  readonly meanWaterLevel: number;
  private tideAmplitude = 0;
  private tidePeriod = 1;
  private tideVelocity = 0;
  /** Optional project current in m/s, added to the measured wave and tide velocities. */
  surfaceCurrent?: (x:number,z:number,tideRate:number,out:THREE.Vector3)=>void;
  private readonly ambientFlow=new THREE.Vector3();
  private tidePhase = 0;
  private tideEpoch = 0;
  /** Instantaneous still-water level, in world metres. */
  get waterLevel(): number { return this.u.level.value; }

  /** Set a tide relative to the current simulation time. Omit to return to mean level. */
  setTide(tide?: TideOptions): void {
    if (tide && (!Number.isFinite(tide.amplitude) || tide.amplitude < 0 ||
        !Number.isFinite(tide.periodSeconds) || tide.periodSeconds <= 0 || !Number.isFinite(tide.phase ?? 0))) {
      throw new RangeError('Tides require a finite nonnegative amplitude, positive period and finite phase.');
    }
    this.tideAmplitude = tide?.amplitude ?? 0;
    this.tidePeriod = tide?.periodSeconds ?? 1;
    this.tidePhase = (tide?.phase ?? 0) % 1;
    this.tideEpoch = this.engine.time;
    this.updateTide(this.tideEpoch);
  }

  private updateTide(time: number): void {
    const cycles = ((time - this.tideEpoch) % this.tidePeriod) / this.tidePeriod + this.tidePhase;
    const angle = cycles * 2 * Math.PI;
    const level = this.meanWaterLevel + this.tideAmplitude * Math.sin(angle);
    this.tideVelocity = this.tideAmplitude * (2 * Math.PI / this.tidePeriod) * Math.cos(angle);
    this.u.level.value = level;
    if (this.bathymetry) this.bathymetry.waterLevel.value = level;
  }
  /** Significant wave height (m) of the current blend – for HUDs and tuning. */
  significantHeight = 0;
  /** Monotonic counter bumped whenever cascade textures are rebuilt (watched by `Underwater`). */
  rebuildVersion = 0;

  private weather: Weather;
  private bathymetry: Bathymetry | null;
  private cascades: Cascade[] = [];
  private hsA = 0;
  private hsB = 0;
  private sim: OceanSimUniforms = {
    time: uniform(0), delta: frame.delta, chop: uniform(1), foamBias: uniform(0.8), foamDecay: uniform(0.35), blend: uniform(0),
  };
  private u = {
    level: uniform(0),
    origin: uniform(new THREE.Vector2()),
    absorption: uniform(new THREE.Vector3(0.42, 0.063, 0.019)),
    scatter: uniform(new THREE.Color(0.004, 0.022, 0.05)),
    sss: uniform(1),
    refraction: uniform(1),
    foamGain: uniform(1),
    foamBands: uniform(0),
    breaker: uniform(0.4),
    rain: uniform(0),
    ssrSteps: uniform(24),
    hs: uniform(1),
    gridGrowth: uniform(0.02),
    tsunamiOn: uniform(0),
    stripOn: uniform(0),
    stripCenter: uniform(new THREE.Vector2()),
    /** Half extent (m) of the crest ribbon across the wave. */
    stripHalf: uniform(120),
    stripLength: uniform(1800),
    /** 1 while the crest ribbon is only being drawn to pre-compile its pipeline (sunk out of sight). */
    stripWarm: uniform(0),
    /** 1 while the camera is at or below the surface: back faces shade as the underside. */
    underView: uniform(0),
    /** Water surface at the camera as seen by the lens: x = height, yz = slope (set by `Underwater`). */
    lensSurface: uniform(new THREE.Vector3(0, 0, 0)),
    /** xyz = camera forward, w = distance of the lens plane. */
    lensFrame: uniform(new THREE.Vector4(0, 0, -1, 0.3)),
    /** Unit horizontal wind direction (xz) for foam stretching & capillary trains. */
    windDir: uniform(new THREE.Vector2(1, 0)),
    /** Wind speed (m/s) for capillary roughness & aerated wind streaks. */
    windSpeed: uniform(6),
  };
  private useGpu: boolean;
  private computeMasks: N[][] = [];
  private fftFrame = 0;
  private stripWarmFrames = 0;

  /** Optical uniforms shared with the underwater module (absorption per metre, scatter colour …). */
  get uniforms(): Readonly<Record<string, N>> { return this.u; }

  private styleTint?: THREE.Color;
  setAppearance(tint: string, bands: number): void {
    (this.styleTint ??= new THREE.Color()).set(tint);
    this.u.foamBands.value = bands;
    this.lastClarity = NaN;
  }

  /**
   * Colour a long path through this water converges to (single-scattering asymptote): the
   * same `scatter × downwelling` the surface shader uses for deep water, so the view from
   * above and the fog seen from below agree.
   */
  waterColor(shadow: N = float(1)): N {
    const skyAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.6);
    const downwelling = frame.sunColor.mul(max(frame.sunDirection.y, 0)).mul(shadow).mul(1 / Math.PI).add(skyAmbient);
    return this.u.scatter.mul(downwelling);
  }

  /**
   * TSL: exact GPU displaced water surface elevation (world Y) at world XZ `worldXZ`.
   * Performs two fixed-point iterations to invert horizontal chop displacement across the
   * live FFT cascades, then adds shoaling, interaction field height, shoreline breakers
   * and tsunami deformation. Used by both `Underwater` (near-plane meniscus split) and
   * `Ocean` (underside clipping test) so the medium and underside use the same coordinates and inverse mapping.
   */
  surfaceHeightNode(worldXZ: N): N {
    const cascades = this.cascades;
    const bathy = this.bathymetry;
    const field = this.field;
    const tsunami = this.tsunami;
    const u = this.u;
    const level = this.u.level;
    return Fn(() => {
      const p0 = vec2(worldXZ).toVar();
      const depth0 = bathy ? bathy.depthNode(p0, level) : float(1000);
      const shoal = bathy ? smoothstep(-0.05, 5.5, depth0).pow(0.8) : float(1);
      // Invert horizontal choppy displacement (2 fixed-point iterations, mirroring CPU heightAt).
      for (let iter = 0; iter < 2; iter++) {
        let dXZ: N = vec2(0);
        for (const c of cascades) {
          dXZ = dXZ.add(texture(c.displacement, p0.div(c.layout.length)).level(0).xz);
        }
        const at = worldXZ.sub(dXZ.mul(shoal)).toVar();
        If(u.tsunamiOn.greaterThan(0.5), () => {
          at.addAssign(tsunami.uniforms.direction.mul(tsunami.restOffsetNode(at, depth0)));
        });
        p0.assign(at);
      }
      const depth1 = bathy ? bathy.depthNode(p0, level) : float(1000);
      const shoal1 = bathy ? smoothstep(-0.05, 5.5, depth1).pow(0.8) : float(1);
      let dispY: N = float(0);
      for (const c of cascades) {
        dispY = dispY.add(texture(c.displacement, p0.div(c.layout.length)).level(0).y);
      }
      const h = float(level).add(dispY.mul(shoal1)).add(field.heightVertex(p0)).toVar();
      if (bathy) {
        If(depth1.lessThan(2.4), () => {
          h.addAssign(this.breaker(p0, depth1).x);
        });
      }
      If(u.tsunamiOn.greaterThan(0.5), () => {
        h.addAssign(tsunami.deform(p0, depth1).offset.y);
      });
      return h;
    })();
  }

  private readonly unregisterWater: () => void;
  private fieldTime = -Infinity;
  constructor(private engine: LuminaEngine, options: OceanOptions) {
    this.weather = options.weather;
    this.bathymetry = options.bathymetry ?? null;
    this.meanWaterLevel = options.waterLevel ?? 0;
    if (!Number.isFinite(this.meanWaterLevel)) throw new RangeError('Mean water level must be finite.');
    this.setTide(options.tide);
    if (this.bathymetry) this.bathymetry.wetHighWater.value = this.waterLevel;
    this.unregisterWater = engine.world.addWater({ heightAt: (x, z, current) => {
      const depth = this.depthAt(x, z);
      if (depth < -0.15 && !this.tsunami.active) return NaN;
      const height = this.heightAt(x, z);
      if (this.bathymetry && height <= this.waterLevel - depth) return NaN;
      if (current) this.flowAt(x, z, current);
      return height;
    } });
    this.useGpu = engine.backend === 'webgpu';
    this.build(engine.quality.preset);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  private build(preset: QualityPreset): void {
    this.disposeResources();
    const { renderer, scene } = this.engine;
    const cfg = preset.ocean;
    // The CPU twin *is* the ocean on WebGL 2, so keep it small there.
    const resolution = this.useGpu ? cfg.resolution : Math.min(cfg.resolution, 64);
    // …and to two cascades below High: the CPU FFT is the largest JavaScript cost of the fallback.
    const deviceLimits = (renderer.backend as any).device?.limits;
    const portable = deviceLimits && Math.min(deviceLimits.maxSampledTexturesPerShaderStage, deviceLimits.maxSamplersPerShaderStage) < 20;
    const count = this.useGpu ? Math.min(cfg.cascades, portable ? 2 : 4) : Math.min(cfg.cascades, cfg.resolution >= 256 ? 3 : 2);
    const layouts = cascadeLayout(resolution, count);
    const spectraA: Float32Array[] = [], spectraB: Float32Array[] = [];
    this.cascades = layouts.map((layout, index) => {
      // Intermediate tiles end where the next frequency band begins. Preserve all
      // nonzero Fourier coefficients and at least eight texels per shortest wave.
      // Only the finest tile needs the full preset FFT on Ultra.
      const cycles = layout.kMax * layout.length / (Math.PI * 2);
      const grid = this.useGpu ? Math.min(resolution, Math.max(cfg.cpuResolution, 2 ** Math.ceil(Math.log2(cycles * 8)))) : resolution;
      const a = buildInitialSpectrum(grid, layout, index, this.params);
      const b = buildInitialSpectrum(grid, layout, index, this.targetParams);
      spectraA.push(a); spectraB.push(b);
      const cpu = new CpuCascade(layout, this.useGpu ? cfg.cpuResolution : grid, a, b, grid, this.params.depth);
      // At least 32 temporal samples per shortest gravity-wave period.
      const keyInterval = Math.min(1 / 15, Math.PI * 2 / (32 * Math.sqrt(9.81 * layout.kMax)));
      const cascade: Cascade = { keyInterval, layout, resolution: grid, gpu: null, cpu, displacement: null as any, derivatives: null as any, slopeVariance: uniform(0), delta: uniform(0), elapsed: 0 };
      if (this.useGpu) {
        cascade.gpu = new GpuCascade(layout, grid, a, b, this.params.depth, { ...this.sim, delta: cascade.delta });
        cascade.displacement = cascade.gpu.displacementTexture;
        cascade.derivatives = cascade.gpu.derivativeTexture;
      } else {
        const n = cpu.size;
        const floatLinear = (renderer.getContext() as WebGL2RenderingContext).getExtension('OES_texture_float_linear') !== null;
        const make = (data: Float32Array | Uint16Array) => {
          const type = floatLinear ? THREE.FloatType : THREE.HalfFloatType;
          const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, type);
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = tex.magFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
          return tex;
        };
        if (!floatLinear) {
          cascade.cpuDisplacementHalf = new Uint16Array(n * n * 4);
          cascade.cpuDerivativeHalf = new Uint16Array(n * n * 4);
        }
        cascade.displacement = make(cascade.cpuDisplacementHalf ?? cpu.displacement);
        cascade.derivatives = make(cascade.cpuDerivativeHalf ?? cpu.derivatives);
      }
      return cascade;
    });
    this.fftFrame = 0;
    this.carriedCascades = 0;
    // Cache the submission lists once. A camera high above the water cannot resolve the
    // shortest band. Long-period swell can also be sampled every other frame at altitude.
    this.computeMasks = this.useGpu ? Array.from({ length: 1 << count }, (_, mask) =>
      this.cascades.flatMap((c, i) => mask & (1 << i) ? c.gpu!.passes : [])) : [];
    this.hsA = significantHeight(spectraA);
    this.hsB = significantHeight(spectraB);
    this.updateSlopeVariance(spectraA, spectraB);

    this.field = new InteractionField(renderer, preset.interaction.resolution, preset.interaction.extent);
    this.rebuildVersion++;

    const segments = cfg.meshSegments;
    const rings = Math.max(cfg.meshRings, Math.min(256, Math.round(segments * 1.38)));
    // Tight inner ring sits right at the camera near plane so mesh clipping matches the displaced waterline.
    const inner = 0.4, outer = OCEAN_GRID_RADIUS;
    this.u.gridGrowth.value = Math.pow(outer / inner, 1 / (rings - 1)) - 1;
    this.u.ssrSteps.value = Math.round(8 + preset.reflections.ssrQuality * 26);
    const geometry = polarGrid(segments, rings, inner, outer);
    this.mesh = new THREE.Mesh(geometry, this.createMaterial(preset));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.name = 'lumina-ocean';
    scene.add(this.mesh);

    // Crest ribbon: uniform along the crest, tanh-concentrated across it (≈ 0.4 m at the lip).
    // Four-metre spacing resolves the shortest lateral undulation well beyond
    // Nyquist. Across the wave the power warp keeps the lip sub-metre.
    const along = Math.min(448, Math.round(segments * 1.25)), across = Math.min(160, Math.round(segments * 0.45));
    const stripLength = 1800;
    this.u.stripLength.value = stripLength;
    const sg = new THREE.PlaneGeometry(stripLength, 2, along, across).rotateX(-Math.PI / 2);
    const sp = sg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      // z in [-1, 1] → concentrate rows near the crest, extend 15 % further behind than ahead.
      const z = sp.getZ(i);
      const warped = Math.sign(z) * Math.pow(Math.abs(z), 1.9);
      sp.setZ(i, warped < 0 ? warped * 1.15 : warped);
    }
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.crestStrip = new THREE.Mesh(sg, this.createMaterial(preset, 'strip'));
    this.crestStrip.frustumCulled = false;
    this.crestStrip.renderOrder = -10;
    this.crestStrip.visible = false;
    this.crestStrip.name = 'lumina-ocean-crest';
    // Draw the ribbon (hidden far below the sea) for a few frames so its render pipeline is
    // compiled now, not as a hitch at the moment a tsunami is launched.
    this.stripWarmFrames = 6;
    scene.add(this.crestStrip);
  }

  private updateSlopeVariance(a: Float32Array[], b: Float32Array[]): void {
    this.lastBlend = NaN;
    this.cascades.forEach((cascade, index) => {
      const N_ = cascade.resolution, dk = (2 * Math.PI) / cascade.layout.length;
      const mss = [a[index], b[index]].map((s) => {
        let sum = 0;
        for (let y = 0; y < N_; y++) for (let x = 0; x < N_; x++) {
          const k2 = ((x - N_ / 2) * dk) ** 2 + ((y - N_ / 2) * dk) ** 2;
          const o = (y * N_ + x) * 4;
          sum += 2 * (s[o] * s[o] + s[o + 1] * s[o + 1]) * k2;
        }
        return sum;
      });
      (cascade as any).mssA = mss[0];
      (cascade as any).mssB = mss[1];
    });
  }

  /** Rebuild sea state A (`slot` 0) or B (`slot` 1) from its params. Costs a few ms per cascade. */
  rebuildSpectrum(slot: 0 | 1 = 0): void {
    const params = slot === 0 ? this.params : this.targetParams;
    const spectra = this.cascades.map((cascade, index) => {
      const data = buildInitialSpectrum(cascade.resolution, cascade.layout, index, params);
      cascade.gpu?.setSpectrum(slot, data);
      cascade.cpu.setSpectrum(slot, data);
      return data;
    });
    if (slot === 0) this.hsA = significantHeight(spectra); else this.hsB = significantHeight(spectra);
    this.lastBlend = NaN;
    this.cascades.forEach((cascade, index) => {
      const N_ = cascade.resolution, dk = (2 * Math.PI) / cascade.layout.length, s = spectra[index];
      let sum = 0;
      for (let y = 0; y < N_; y++) for (let x = 0; x < N_; x++) {
        const o = (y * N_ + x) * 4;
        sum += 2 * (s[o] * s[o] + s[o + 1] * s[o + 1]) * (((x - N_ / 2) * dk) ** 2 + ((y - N_ / 2) * dk) ** 2);
      }
      (cascade as any)[slot === 0 ? 'mssA' : 'mssB'] = sum;
    });
  }

  /** Set both morph end points at once (e.g. lagoon ↔ deep-ocean swell). */
  setSeaStates(a: OceanParams, b: OceanParams): void {
    Object.assign(this.params, a);
    Object.assign(this.targetParams, b);
    this.rebuildSpectrum(0);
    this.rebuildSpectrum(1);
  }

  // ---------------------------------------------------------------------------
  // Material
  // ---------------------------------------------------------------------------

  /** Shoreline breaker: returns vec2(height, foam) for a still-water depth. */
  private breaker(xz: N, depth: N): N {
    return breakerNode(xz, depth, frame.time, this.u.breaker);
  }

  /**
   * Build the surface material. `variant` selects the vertex layout:
   *  - `polar`  camera-centred polar grid (the whole ocean),
   *  - `strip`  a dense ribbon that rides the tsunami crest (adaptive tessellation of the lip).
   * Both share every line of shading.
   */
  private createMaterial(preset: QualityPreset, variant: 'polar' | 'strip' = 'polar'): THREE.NodeMaterial {
    const u = this.u, weather = this.weather, field = this.field, tsunami = this.tsunami, bathy = this.bathymetry;
    const cascades = this.cascades;
    const level = this.u.level;
    // Three wave bands + refraction/SSR already use all 16 portable GL fragment
    // samplers. Keep the cloud shadow there and add caster shadows where a slot exists.
    const gl = this.useGpu ? undefined : (this.engine.renderer.backend as any).gl as WebGL2RenderingContext | undefined;
    const samplerLimit = gl ? gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) : 32;
    const tightSamplers = !this.useGpu && cascades.length >= 3 && samplerLimit <= 16;
    const castShadows = preset.shadows.enabled && (this.useGpu || cascades.length < 3 ||
      samplerLimit >= (weather.localProbe ? 18 : 17));
    // On 16-sampler GL, the fine normal band shares its slot with the local probe.
    // All displacement bands still reach the water mesh and underwater boundary.
    const shadingCascades = tightSamplers && weather.localProbe ? cascades.slice(0, -1) : cascades;
    const strip = variant === 'strip';
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;      // render after opaques so refraction can read the scene
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    // Both optical branches return alpha one and write depth. The closest
    // interface wins from either side, including through an overturned crest.
    material.forceSinglePass = true;
    material.fog = false;

    // ----- vertex stage ------------------------------------------------------
    const tDir = tsunami.uniforms.direction;
    const tPerp = vec2(tDir.y.negate(), tDir.x);
    const xz0: N = strip
      ? u.stripCenter.add(tPerp.mul(positionGeometry.x)).add(tDir.mul(positionGeometry.z.mul(u.stripHalf)))
      : positionGeometry.xz.add(u.origin);
    const spacing: N = strip ? float(2.2) : length(positionGeometry.xz).mul(u.gridGrowth).add(0.03);
    const depth0: N = bathy ? bathy.depthNode(xz0, level) : float(1000);
    // Waves lose height as they run into shallow water and vanish at the shoreline.
    const shoal: N = bathy ? smoothstep(-0.05, 5.5, depth0).pow(0.8) : float(1);

    let displacement: N = vec3(0);
    for (const c of cascades) {
      const L = c.layout.length;
      const weight = float(1).sub(smoothstep(L / 16, L / 6, spacing));
      displacement = displacement.add(texture(c.displacement, xz0.div(L)).level(0).xyz.mul(weight));
    }
    displacement = displacement.mul(shoal);
    const breakerV: N = bathy ? this.breaker(xz0, depth0) : vec2(0);
    const fieldH = field.heightVertex(xz0);

    // Tsunami deformation + tangent frame, skipped entirely (uniform branch) while calm.
    const eps = 1.5;
    // Ahead of the leading trough the analytic tail is sub-millimetre. Skip the
    // hyperbolic functions on undisturbed near water while the distant front approaches.
    const nearWave = u.tsunamiOn.greaterThan(0.5).and(dot(xz0, tDir).sub(tsunami.uniforms.front).lessThan(tsunami.uniforms.width.mul(5)));
    const waveOffset = Fn(() => {
      const o = vec3(0).toVar();
      If(nearWave, () => { o.assign(tsunami.deform(xz0, depth0).offset); });
      return o;
    })();
    // Transport metre-scale crest coverage on the dense wave mesh; turbulent
    // breakup is evaluated per pixel. Avoid a full hyperbolic profile per fragment.
    const vWave = Fn(() => {
      const shape = vec3(0).toVar();
      If(nearWave, () => {
        const w = tsunami.deform(xz0, depth0);
        shape.assign(vec3(w.crest, w.lip, w.behind));
      });
      return shape;
    })().toVarying('oWave');
    const tangent = (dx: number, dz: number) => Fn(() => {
      const t = vec3(dx, 0, dz).toVar();
      If(nearWave, () => {
        const b = tsunami.deform(xz0.add(vec2(dx * eps, dz * eps)), depth0).offset;
        t.assign(normalize(vec3(dx * eps, 0, dz * eps).add(b).sub(waveOffset)));
      });
      return t;
    })();
    const tangentX = tangent(1, 0);
    const tangentZ = tangent(0, 1);
    const macroNormal = normalize(cross(tangentZ, tangentX));

    const world = vec3(
      xz0.x.add(displacement.x),
      float(level).add(displacement.y).add(fieldH).add(breakerV.x),
      xz0.y.add(displacement.z),
    ).add(waveOffset);
    material.positionNode = strip ? world.sub(vec3(0, u.stripWarm.mul(4000), 0)) : world.sub(vec3(u.origin.x, 0, u.origin.y));

    const vXZ = xz0.toVarying('oXZ');
    const vShoal = shoal.toVarying('oShoal');
    const vDepth = depth0.toVarying('oDepth');
    const vHeight = displacement.y.toVarying('oHeight');
    const coastSlope = bathy ? bathy.reflectedHorizonNode(xz0,displacement.y.add(level),cameraPosition.xz).toVarying('oCoastSlope') : float(0);
    const vTangentX = tangentX.toVarying('oTx');
    const vTangentZ = tangentZ.toVarying('oTz');
    const vMacro = macroNormal.toVarying('oNm');

    // ----- fragment stage ----------------------------------------------------
    // Seen from below, the surface is a window and a mirror: inside Snell's cone (48.6°
    // from the vertical) the whole sky is compressed into a disc; outside it the interface
    // reflects the water body (total internal reflection). Waves bend the rim of the window.
    const underside = (): N => {
      const P = positionWorld;
      const V = normalize(cameraPosition.sub(P));
      const footprint = length(fwidth(vXZ)).mul(0.7);
      const slope = vec2(0).toVar();
      for (const c of shadingCascades) {
        const texel = c.layout.length / c.resolution;
        const w = float(1).sub(smoothstep(texel * 1.5, texel * 7, footprint));
        slope.addAssign(texture(c.derivatives, vXZ.div(c.layout.length)).xy.mul(w));
      }
      slope.mulAssign(vShoal);
      slope.addAssign(field.slope(vXZ));
      // Normal facing the underwater viewer.
      const Nd = normalize(vMacro.sub(vTangentX.mul(slope.x)).sub(vTangentZ.mul(slope.y))).negate();
      const eta = 1.333;
      const cosI = max(dot(Nd, V), 0.001);
      const k = float(1).sub(float(eta * eta).mul(float(1).sub(cosI.mul(cosI))));
      const cosT = sqrt(max(k, 0));
      const refracted = normalize(V.negate().mul(eta).add(Nd.mul(cosI.mul(eta).sub(cosT))));
      // Fresnel on the air side of the interface; the smooth step hides the TIR edge aliasing.
      const fresnel = mix(float(1), float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5))), smoothstep(0.0, 0.03, k));
      const shadow = weather.surfaceSunlight(P, castShadows);
      const L = frame.sunDirection;
      const sky = weather.reflection(refracted, 0);
      // The sun through the window: a hard disc broken into dancing shards by the waves.
      const sunDisc = frame.sunColor.mul(shadow).mul(pow(max(dot(refracted, L), 0), 900).mul(26).add(pow(max(dot(refracted, L), 0), 40).mul(0.9)));
      const body = this.waterColor(shadow);
      // Total internal reflection mirrors the lit water below (brighter than the upwelling colour).
      const mirror = body.mul(1.9);
      // Foam rafts on the surface block the light coming through the window.
      const foam = texture(shadingCascades[shadingCascades.length - 1].derivatives, vXZ.div(shadingCascades[shadingCascades.length - 1].layout.length)).w.mul(u.foamGain).add(field.sample(vXZ).b.mul(0.5)).clamp(0, 1);
      // Radiance grows by n² on entering the denser medium (the sky is squeezed into the cone).
      const window = sky.add(sunDisc).mul(eta * eta).mul(mix(1.0, 0.35, foam));
      return vec4(mix(window, mirror, fresnel), 1);
    };

    material.colorNode = Fn(() => {
      const P = positionWorld;
      const toCamera = cameraPosition.sub(P);
      const viewDistance = length(toCamera);
      const V = toCamera.div(viewDistance);
      const L = frame.sunDirection;

      // The polar grid yields to the dense crest ribbon where the two overlap.
      if (!strip) {
        const sPlain = dot(vXZ, tDir).sub(tsunami.uniforms.front);
        const q = dot(vXZ.sub(u.stripCenter), tPerp);
        If(u.stripOn.greaterThan(0.5)
          .and(abs(q).lessThan(u.stripLength.mul(0.5).sub(8)))
          .and(sPlain.greaterThan(u.stripHalf.mul(-1.15).add(8)))
          .and(sPlain.lessThan(u.stripHalf.sub(8))), () => { Discard(); });
      }

      const result = vec4(0, 0, 0, 1).toVar();
      // Compute screen-space footprints in uniform control flow (used for cascade & capillary AA).
      const dxzX = dFdx(vXZ);
      const dxzY = dFdy(vXZ);
      const footprintIso = length(fwidth(vXZ)).mul(0.7);
      const footprintMax = max(length(dxzX), length(dxzY));
      const footprint = mix(footprintIso, footprintMax, 0.65);

      // Underside only where this pixel's near-plane lens point is below the actual displaced
      // water surface (the exact same `surfaceHeightNode` test `Underwater` uses), so wave
      // backs seen from just above the surface keep their above-water shading with zero seam.
      const isUnderside = float(0).toVar();
      If(u.underView.greaterThan(0.5).and(dot(vMacro, V).lessThan(0)), () => {
        const ray = V.negate();
        const lens = cameraPosition.add(ray.mul(u.lensFrame.w.div(max(dot(ray, u.lensFrame.xyz), 0.05))));
        const lensUnder = this.surfaceHeightNode(lens.xz).sub(lens.y);
        If(lensUnder.greaterThan(0), () => { isUnderside.assign(1); });
      });
      If(isUnderside.greaterThan(0.5), () => {
        result.assign(underside());
      }).Else(() => {

      // ---- one pass over the cascades: slopes, unresolved variance, foam ------
      const slope = vec2(0).toVar();
      const variance = float(0).toVar();
      const foamFft = float(0).toVar();
      for (const c of shadingCascades) {
        const texel = c.layout.length / c.resolution;
        const w = float(1).sub(smoothstep(texel * 1.5, texel * 6.5, footprint));
        const d = texture(c.derivatives, vXZ.div(c.layout.length));
        slope.addAssign(d.xy.mul(w));
        // Wave detail that has shrunk below a pixel becomes roughness (keeps glitter energy).
        variance.addAssign(float(1).sub(w).mul(c.slopeVariance));
        foamFft.addAssign(d.w.mul(mix(float(0.35), float(1), w)));
      }
      slope.mulAssign(vShoal);
      const fieldState = field.sample(vXZ,true);
      const roughWater=float(1).sub(fieldState.a.mul(0.84));
      slope.mulAssign(roughWater);variance.mulAssign(roughWater);
      slope.addAssign(field.slope(vXZ));
      const shore = float(0).toVar();
      if (bathy) {
        // Breakers only exist in the surf zone: skip three noise-heavy evaluations elsewhere.
        If(vDepth.lessThan(2.4), () => {
          const e = 0.35;
          const b0 = this.breaker(vXZ, vDepth);
          const hx = this.breaker(vXZ.add(vec2(e, 0)), bathy.depthNode(vXZ.add(vec2(e, 0)), level)).x;
          const hz = this.breaker(vXZ.add(vec2(0, e)), bathy.depthNode(vXZ.add(vec2(0, e)), level)).x;
          slope.addAssign(vec2(hx.sub(b0.x), hz.sub(b0.x)).div(e));
          shore.assign(b0.y);
        });
      }
      // Footprint-antialiased capillary ripples (and rain pitting): each octave is band-limited
      // against the anisotropic screen-space pixel footprint (`footprintMax`), and the filtered
      // sub-pixel capillary slope variance is conserved inside GGX roughness (`variance`).
      const windAxis = u.windDir;
      const windPerp = vec2(windAxis.y.negate(), windAxis.x);
      const capAmp = float(shadingCascades.length < 3 ? 0.085 : shadingCascades.length < 4 ? 0.042 : 0.020)
        .mul(smoothstep(0, 1.5, u.windSpeed)).mul(mix(0.65, 1.35, smoothstep(1.5, 14, u.windSpeed)))
        .add(u.rain.mul(0.16)).mul(roughWater);
      const wCap1 = float(1).sub(smoothstep(0.032, 0.14, footprintMax));
      const wCap2 = float(1).sub(smoothstep(0.010, 0.044, footprintMax));
      const capVar = capAmp.mul(capAmp).mul(1.8);
      variance.addAssign(float(1).sub(wCap1).mul(capVar.mul(0.55)).add(float(1).sub(wCap2).mul(capVar.mul(0.45))));
      If(wCap1.greaterThan(0.002), () => {
        const drift = windAxis.mul(frame.time.mul(0.75)).add(windPerp.mul(frame.time.mul(0.28)));
        const grad = (p: N, e: number): N => {
          const c0 = valueNoise2(p);
          return vec2(valueNoise2(p.add(vec2(e, 0))).sub(c0), valueNoise2(p.add(vec2(0, e))).sub(c0)).div(e);
        };
        const micro1 = grad(vXZ.mul(7.0).add(drift), 0.3).mul(0.55).mul(wCap1);
        const micro2 = vec2(0).toVar();
        If(wCap2.greaterThan(0.002), () => {
          micro2.assign(grad(vXZ.mul(23.0).sub(drift.mul(2.1)), 0.3).mul(0.45).mul(wCap2));
        });
        slope.addAssign(micro1.add(micro2).mul(capAmp));
      });
      const N0 = normalize(vMacro.sub(vTangentX.mul(slope.x)).sub(vTangentZ.mul(slope.y)));
      // Never shade a micro-facet that points away from the eye (grazing wave backs).
      const Nw = normalize(N0.add(V.mul(max(float(0.04).sub(dot(N0, V)), 0)))).toVar();
      const NdotV = max(dot(Nw, V), 0.02);
      // Unresolved cascade + capillary variance + geometric specular AA (glitter energy conservation).
      const alpha2 = specularAA(Nw, variance.mul(0.5).add(0.0007).add(u.rain.mul(0.004)).min(0.32), 0.25, 0.14);
      const roughness = alpha2.sqrt().sqrt();

      // ---- tsunami per-pixel terms (crest, lip, churned bore) -------------------
      const wave = vWave;

      // ---- reflection -------------------------------------------------------
      const fresnelBase = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5)));
      // Rough seas scatter the grazing mirror term: avoids a chalk-white horizon band.
      const fresnel = mix(fresnelBase, fresnelBase.mul(0.62).add(0.02), variance.mul(6).min(1));
      const R = reflect(V.negate(), Nw);
      const shadow = weather.surfaceSunlight(P, castShadows);
      const reflectionLod = roughness.mul(7);
      const reflection = weather.reflectionAt(P, R, reflectionLod).toVar();
      const skyAmbient = mix(frame.skyHorizon, frame.skyZenith, 0.6);
      const downwelling = frame.sunColor.mul(max(L.y, 0)).mul(shadow).mul(1 / Math.PI).add(skyAmbient);
      const inscatter = u.scatter.mul(downwelling);
      // A plunging face reflects the shaded water below the lip. Mirroring
      // downward rays into the sky produces a second bright horizon on the face.
      const seaHorizon = roughness.mul(0.25).add(0.025);
      const seaWeight = smoothstep(seaHorizon, seaHorizon.negate(), R.y);
      reflection.assign(mix(reflection, inscatter.add(skyAmbient.mul(0.025)), seaWeight));
      if(bathy){
        // A distant hill occludes the sky environment even when the reflected
        // coast is outside the screen-space ray's footprint. Finite wave
        // roughness filters its silhouette at the waterline.
        const slope=R.y.div(length(R.xz).max(0.001)).max(0);
        const penumbra=roughness.mul(0.13).add(0.007);
        const coast=smoothstep(slope.sub(penumbra),slope.add(penumbra),coastSlope)
          .mul(smoothstep(0.003,0.022,coastSlope));
        const terrainBounce=frame.skyHorizon.mul(vec3(0.22,0.27,0.205))
          .add(frame.sunColor.mul(frame.sunVisibility).mul(0.014));
        reflection.assign(mix(reflection,terrainBounce,coast.mul(0.89)));
      }
      if (preset.reflections.ssr) {
        const range=bathy?670:150, far=bathy?680:320;
        If(viewDistance.lessThan(far), () => {
          const hit = traceReflection(P.add(Nw.mul(0.05)), R,
            { steps:u.ssrSteps, maxDistance:range, growth:bathy?1.52:1.32, thickness:0.11 });
          reflection.assign(mix(reflection,hit.rgb,hit.a.mul(seaWeight.oneMinus()).mul(smoothstep(far,far*0.63,viewDistance))));
        });
      }
      const NdotL = max(dot(Nw, L), 0);
      // Glints follow the physical facet. The view-facing normal used to stabilize refraction
      // can turn an occluded wave back toward the eye at grazing angles.
      const facetView = dot(N0, V);
      const sunGlint = frame.sunColor.mul(shadow).mul(smoothstep(-0.00465, 0.00465, L.y))
        .mul(smoothstep(0, 0.045, facetView)).mul(dielectricSunGlint(N0, V, L, facetView.max(0.002), alpha2.add(0.0000054), float(0.02)));

      // ---- refraction + Beer–Lambert -------------------------------------------
      // Analytic water column: no screen taps. The bathymetry depth gives the path length,
      // the seabed is taken as sunlit sand filtered on the way down. It is the whole story on
      // the lowest tier (single-pass water) and the far-field level of detail on the others.
      const analyticColumn = vDepth.max(0).mul(float(1).div(max(NdotV, 0.3)).mul(0.75).add(0.35));
      const analyticTransmit = select(vDepth.lessThan(80), exp(u.absorption.mul(analyticColumn).negate()), vec3(0));
      const analyticFloor = vec3(0.47, 0.42, 0.31).mul(downwelling).mul(exp(u.absorption.mul(max(vDepth, 0)).negate()));
      const transmit = vec3(analyticTransmit).toVar();
      const background = vec3(analyticFloor).toVar();
      const contact = float(0).toVar();
      if (preset.ocean.refraction) {
        // Beyond 250 m the refracted image is a few texels of noise under a grazing mirror:
        // cross-fade to the analytic column over 200–250 m and skip the taps past it.
        If(viewDistance.lessThan(250), () => {
          const surfaceZ = positionView.z.negate();
          const sceneZ0 = perspectiveDepthToViewZ(viewportDepthAt(screenUV), cameraNear, cameraFar).negate();
          const column0 = sceneZ0.sub(surfaceZ);
          // A small, broken line of air entrainment where water meets a solid, using
          // the unperturbed depth so the contact stays attached as refraction changes.
          const contactDepth = max(column0, 0).mul(viewDistance.div(max(surfaceZ, 0.1)));
          contact.assign(smoothstep(0.0, 0.035, contactDepth).mul(smoothstep(0.055, 0.24, contactDepth).oneMinus())
            .mul(smoothstep(25, 60, viewDistance).oneMinus()).mul(0.42));
          const viewNormal = cameraViewMatrix.mul(vec4(Nw, 0)).xyz;
          const offset = viewNormal.xy.mul(vec2(-1, 1)).mul(u.refraction).mul(0.045).mul(smoothstep(0.0, 1.5, column0)).div(surfaceZ.mul(0.04).add(1));
          const uvR = refractedScreenUV(screenUV, offset);
          const sceneZ1 = perspectiveDepthToViewZ(viewportDepthAt(uvR), cameraNear, cameraFar).negate();
          const valid = sceneZ1.greaterThan(surfaceZ.add(0.02));
          const uvFinal = select(valid, uvR, screenUV);
          const sceneZ = select(valid, sceneZ1, sceneZ0);
          const hasFloor = sceneZ.lessThan(cameraFar.mul(0.6));
          // Convert the view-Z gap into path length along the (refracted, steeper) ray.
          const column = max(sceneZ.sub(surfaceZ), 0).mul(viewDistance.div(max(surfaceZ, 0.1))).mul(mix(0.75, 1.0, NdotV));
          const far = smoothstep(200, 250, viewDistance);
          transmit.assign(mix(select(hasFloor, exp(u.absorption.mul(column).negate()), vec3(0)), analyticTransmit, far));
          background.assign(mix(viewportSharedTexture(uvFinal).rgb, analyticFloor, far));
        });
      }

      // Back-lit & side-lit crest subsurface scattering: sunlight refracting through thin,
      // steep wave peaks and overturning tsunami lips, coloured by the water's own absorption.
      const Hsss = normalize(L.add(Nw.mul(0.42)));
      const backLit = pow(max(dot(V, Hsss.negate()), 0), 4).mul(0.85)
        .add(pow(max(dot(V, normalize(vec3(L.x, -0.15, L.z)).negate()), 0), 2).mul(0.28));
      const sideGlow = smoothstep(-0.2, 0.75, dot(Nw, L).negate().mul(0.5).add(0.5)).mul(max(L.y, 0.08)).mul(0.22);
      const crestElev = smoothstep(0.05, 0.95, vHeight.div(u.hs.mul(0.45).add(0.12)));
      const steepness = smoothstep(0.08, 0.65, length(slope));
      const crestThin = crestElev.mul(mix(0.45, 1.0, steepness)).mul(pow(float(1).sub(NdotV).max(0), 1.4).mul(0.75).add(0.25));
      const lipGlow = wave.y.mul(0.95).add(smoothstep(0.55, 0.95, wave.x).mul(0.38));
      const sssTint = exp(u.absorption.mul(vec3(1.5, 1.1, 1.35)).negate()).mul(vec3(0.14, 0.56, 0.48)).add(u.scatter.mul(3.2));
      const sss = sssTint.mul(frame.sunColor).mul(shadow).mul(1 / Math.PI)
        .mul(crestThin.mul(backLit.mul(0.72).add(sideGlow)).add(lipGlow.mul(backLit.mul(0.8).add(0.22)).mul(0.55)))
        .mul(u.sss);

      const body = background.mul(transmit).add(inscatter.mul(vec3(1).sub(transmit))).add(sss);
      const color = mix(body, reflection, fresnel).add(sunGlint).toVar();

      // ---- cellular stretched foam with aerated streaks ----------------------
      // Tsunami: boiling crest, streaks torn down the face, churned white water behind.
      const waveFoam = float(0).toVar();
      If(u.tsunamiOn.greaterThan(0.5).and(wave.x.add(wave.z).greaterThan(0.025)), () => {
        const q = dot(vXZ, tPerp), s = dot(vXZ, tDir).sub(tsunami.uniforms.front);
        const phase = frame.time.mul(0.58);
        // Metre-scale whitewater fingers and bare water between collapsing sections
        // of the lip remain resolved long after individual foam bubbles become subpixel.
        const eddy = valueNoise2(vec2(q.mul(0.105).add(phase.mul(0.17)), s.mul(0.13).sub(phase)));
        const runoff = valueNoise2(vec2(q.mul(0.48).add(eddy.mul(2.8)), s.mul(0.095).sub(phase)));
        const tongue = smoothstep(0.31, 0.76, runoff.mul(0.64).add(eddy.mul(0.36)));
        const boiling = smoothstep(0.68, 0.98, wave.x).mul(wave.y).mul(tongue.mul(1.08).add(0.35));
        const trailing = wave.z.mul(eddy.mul(0.85).add(0.54));
        waveFoam.assign(boiling.add(wave.y.mul(tongue).mul(0.43)).add(trailing));
      });
      const amount = foamFft.mul(u.foamGain).mul(vShoal)
        .add(fieldState.b.mul(0.34).min(0.9))
        .add(shore).add(contact)
        .add(waveFoam)
        .clamp(0, 1.6);
      If(amount.greaterThan(0.02).and(viewDistance.greaterThanEqual(250)), () => {
        // Far field: the lace is sub-pixel, so foam is just coverage (no noise evaluations).
        const mask = smoothstep(0.3, 1.0, amount).mul(0.8);
        const foamLit = vec3(0.78).mul(frame.sunColor.mul(shadow).mul(max(L.y, 0.15)).mul(1 / Math.PI).add(skyAmbient.mul(1.05)));
        color.assign(mix(color, foamLit, mix(mask, smoothstep(0.27, 0.34, mask), u.foamBands)));
      });
      If(amount.greaterThan(0.02).and(viewDistance.lessThan(250)), () => {
        // Wind-aligned anisotropic coordinates: stretch cellular foam webs and aerated
        // streaks along the wind / surface drift direction.
        const along = dot(vXZ, windAxis);
        const across = dot(vXZ, windPerp);
        const driftSpeed = u.windSpeed.mul(0.012).add(0.04);
        const drift = frame.time.mul(driftSpeed);
        const warp = vec2(
          valueNoise2(vec2(along.mul(0.22).sub(drift.mul(1.3)), across.mul(0.38))),
          valueNoise2(vec2(along.mul(0.19).add(5.1).sub(drift), across.mul(0.35).add(2.7))),
        ).sub(0.5);

        // Stretched polygonal Voronoi bubble web (thin bright cell walls around dark water holes).
        const cellUV = vec2(along.mul(2.9).sub(drift.mul(1.6)), across.mul(5.35)).add(warp.mul(2.2));
        const cell = voronoi2(cellUV, frame.time.mul(0.55));
        const rawWeb = float(1).sub(smoothstep(0.015, 0.17, cell.y.sub(cell.x)));
        // Band-limit high-frequency cellular walls by pixel footprint to prevent mid-field shimmer.
        const cellAA = smoothstep(0.025, 0.28, footprintMax);
        const web = mix(rawWeb, float(0.42), cellAA);

        // Elongated aerated wind streaks trailing downwind from whitecaps, wakes and surf.
        const streakUV = vec2(along.mul(0.13).sub(drift.mul(2.1)), across.mul(1.18)).add(warp.mul(0.45));
        const aeratedStreaks = smoothstep(0.34, 0.84, fbm2(streakUV, 3));
        const macroBreakup = fbm2(vec2(along.mul(0.48).sub(drift), across.mul(0.72)).add(warp.mul(0.35)), 2);
        const lace = web.mul(0.18).add(aeratedStreaks.mul(0.46)).add(macroBreakup.mul(0.36));

        // Subsurface aerated bubble plume: milky turquoise haze lingering beneath and around thin foam.
        const subCloud = smoothstep(0.03, 0.55, amount).mul(aeratedStreaks.mul(0.55).add(0.45)).mul(0.42);
        const subColor = mix(inscatter.mul(3.5), vec3(0.46, 0.72, 0.70).mul(downwelling.mul(0.75).add(skyAmbient.mul(0.45))), 0.65);
        color.assign(mix(color, subColor, subCloud.clamp(0, 0.52)));

        // Surface foam raft: thin streaks open into cellular lace; thick crests fill solidly.
        const mask = smoothstep(float(0.96).sub(amount.mul(0.72)), float(1.28).sub(amount.mul(0.72)), lace.add(amount.mul(0.18)))
          .mul(smoothstep(0.0, 0.06, amount));
        const bubbles = valueNoise2(vec2(along.mul(7.5).sub(drift.mul(9.0)), across.mul(11.5))).mul(0.55)
          .add(valueNoise2(vec2(along.mul(21.0).add(drift.mul(13.0)), across.mul(26.0))).mul(0.45));
        const thickness = smoothstep(0.32, 1.22, amount.mul(lace.mul(0.85).add(0.55)));
        const foamAlbedo = mix(vec3(0.54, 0.64, 0.64), vec3(0.95, 0.96, 0.95), thickness).mul(mix(0.80, 1.0, bubbles));
        const foamNormal = normalize(mix(vec3(0, 1, 0), Nw, 0.6));
        // Foam is a translucent multiple-scattering medium: wrap the sun term so white water
        // on shadowed faces (the underside of a breaking lip) stays bright instead of grey.
        const foamSun = dot(foamNormal, L).add(0.55).div(1.55).clamp(0, 1);
        const foamLit = foamAlbedo.mul(frame.sunColor.mul(shadow).mul(foamSun).mul(1 / Math.PI).add(skyAmbient.mul(1.05)));
        color.assign(mix(color, foamLit, mix(mask, smoothstep(0.27, 0.34, mask), u.foamBands).mul(mix(0.65, 0.97, thickness)).mul(mix(0.84, 1.0, bubbles))));
      });

      const fire = fireLights.sampleSurface(P, Nw, V, roughness, preset.ocean.refraction ? localLightVisibility : undefined);
      color.addAssign(fire.specular.add(fire.diffuse.mul(amount.mul(0.19).add(0.025))));
      // An elevated camera sees the finite polar grid end far below the true
      // horizon. Its outer rings converge to the dome's distant airlight.
      const radiusSq = dot(toCamera.xz, toCamera.xz);
      const outer = smoothstep((OCEAN_GRID_RADIUS * 0.70) ** 2, (OCEAN_GRID_RADIUS * 0.98) ** 2, radiusSq);
      const airborne = smoothstep(600, 1600, cameraPosition.y.sub(level));
      result.assign(vec4(weather.aerial(color, P, outer.mul(airborne)), 1));
      });
      return result;
    })();

    // GTAO only needs the large-scale orientation of the water; re-deriving the detailed
    // normal for the MRT attachment would double the fragment cost.
    material.mrtNode = auxSurface(cameraViewMatrix.mul(vec4(vMacro, 0)).xyz, screenVelocity(positionWorld, positionWorld));
    return material;
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  update(dt: number, time: number): void {
    if (this.tideAmplitude > 0) this.updateTide(time);
    const { renderer, camera, wind } = this.engine;
    const u = this.u, sim = this.sim, optics = this.optics, cascades = this.cascades;
    const blend = THREE.MathUtils.clamp(this.morph, 0, 1);
    const p = this.params, q = this.targetParams;
    const chop = THREE.MathUtils.lerp(p.chop, q.chop, blend);
    // Number uniforms hold tagged values, so storing an unchanged number still boxes a new one
    // every frame. Everything below that rarely changes is written only when it has changed,
    // and the two numbers that arrive as arguments (`time` before its first wrap, `dt`) are
    // stored as they are rather than as the result of arithmetic, which would be a fresh copy.
    sim.time.value = time >= 0 && time < OCEAN_LOOP_SECONDS ? time : time % OCEAN_LOOP_SECONDS;
    if (sim.chop.value !== chop) sim.chop.value = chop;
    if (sim.blend.value !== blend) sim.blend.value = blend;

    // Blended sea statistics only move with the morph, the chop or a spectrum rebuild.
    if (blend !== this.lastBlend || chop !== this.lastChop) {
      this.lastBlend = blend;
      this.lastChop = chop;
      const significantHeight = this.significantHeight = THREE.MathUtils.lerp(this.hsA, this.hsB, blend);
      u.hs.value = Math.max(significantHeight, 0.05);
      for (let i = 0; i < cascades.length; i++) {
        const cascade = cascades[i];
        cascade.slopeVariance.value = THREE.MathUtils.lerp((cascade as any).mssA ?? 0, (cascade as any).mssB ?? 0, blend) * chop;
      }
    }

    // Keep the unified wind field consistent with the sea state driving the waves.
    const windSpeed = THREE.MathUtils.lerp(p.windSpeed, q.windSpeed, blend);
    const windDir = THREE.MathUtils.lerp(p.windDirection, q.windDirection, blend);
    const axis = u.windDir.value as THREE.Vector2;
    if (windDir !== this.lastWindDir) {
      this.lastWindDir = windDir;
      axis.set(Math.cos(windDir), Math.sin(windDir));
    }
    wind.direction.copy(axis);
    wind.speed = windSpeed;
    if (u.windSpeed.value !== windSpeed) u.windSpeed.value = windSpeed;

    const clarity = optics.clarity;
    if (clarity !== this.lastClarity) {
      this.lastClarity = clarity;
      const murk = THREE.MathUtils.lerp(5.5, 1, clarity);
      (u.absorption.value as THREE.Vector3).set(0.42 * (0.6 + 0.4 * murk), 0.063 * murk, 0.019 * murk * murk * 0.6 + 0.008);
      (u.scatter.value as THREE.Color).setRGB(
        THREE.MathUtils.lerp(0.018, 0.0035, clarity), THREE.MathUtils.lerp(0.05, 0.021, clarity), THREE.MathUtils.lerp(0.035, 0.05, clarity));
      if (this.styleTint) (u.scatter.value as THREE.Color).copy(this.styleTint).multiplyScalar(0.28);
      this.bathymetry?.absorption.value.copy(u.absorption.value);
    }
    const foam = optics.foam;
    if (foam !== this.lastFoam) {
      this.lastFoam = foam;
      sim.foamBias.value = 0.42 + 0.36 * foam;
      u.foamGain.value = 0.55 + foam * 0.9;
    }
    const sss = optics.sss, refraction = optics.refraction, breakerHeight = optics.breakerHeight, rain = this.weather.params.rain;
    if (this.bathymetry) {
      const runup = swashAmplitude(breakerHeight);
      if (this.bathymetry.runup.value !== runup) this.bathymetry.runup.value = runup;
      const focusing = Math.max(THREE.MathUtils.smoothstep(windSpeed, 0, 5),
        0.25 * THREE.MathUtils.smoothstep(this.significantHeight, 0, 1.5));
      if (this.bathymetry.waveFocusing.value !== focusing) this.bathymetry.waveFocusing.value = focusing;
      this.bathymetry.updateShoreMoisture(dt);
    }
    if (u.sss.value !== sss) u.sss.value = sss;
    if (u.refraction.value !== refraction) u.refraction.value = refraction;
    if (u.breaker.value !== breakerHeight) u.breaker.value = breakerHeight;
    if (u.rain.value !== rain) u.rain.value = rain;

    this.tsunami.update(dt);
    const tsunamiOn = this.tsunami.active;
    u.tsunamiOn.value = tsunamiOn ? 1 : 0;
    u.stripOn.value = tsunamiOn ? 1 : 0;
    const warming = !tsunamiOn && this.stripWarmFrames > 0;
    if (warming) this.stripWarmFrames--;
    u.stripWarm.value = warming ? 1 : 0;
    this.crestStrip.visible = tsunamiOn || warming;
    const cameraX = camera.position.x, cameraZ = camera.position.z;
    if (tsunamiOn) {
      const profile = this.tsunami.profile, front = this.tsunami.front;
      const dx = Math.cos(profile.direction), dz = Math.sin(profile.direction);
      // Centre the ribbon on the crest abreast of the camera, snapped along the crest so
      // its vertices do not swim sideways.
      const q = Math.round((-cameraX * dz + cameraZ * dx) / 6) * 6;
      (u.stripCenter.value as THREE.Vector2).set(dx * front - dz * q, dz * front + dx * q);
      u.stripHalf.value = profile.width * 2.7;
    }

    let computeMask = 0;
    let carried = this.carriedCascades;
    const fftFrame = this.fftFrame++;
    const height = Math.abs(camera.position.y - this.waterLevel);
    for (let i = 0; i < cascades.length; i++) {
      const cascade = cascades[i], bit = 1 << i;
      const distantSwell = i === 0 && height > 18;
      const subpixelRipples = i >= 2 && height > cascade.layout.length * 2;
      if (fftFrame === 0 || (!distantSwell && !subpixelRipples) || ((fftFrame + i) & 1) === 0) {
        computeMask |= bit;
        // A cascade that ran last frame has no carried time: its step is this frame's `dt`
        // itself, with no read of the accumulator and no sum.
        if ((carried & bit) === 0) cascade.delta.value = dt;
        else {
          cascade.delta.value = cascade.elapsed + dt;
          cascade.elapsed = 0;
          carried &= ~bit;
        }
      } else {
        cascade.elapsed = (carried & bit) === 0 ? dt : cascade.elapsed + dt;
        carried |= bit;
      }
      // On WebGPU the CPU twin only feeds buoyancy: swell + wind sea are enough (shorter
      // cascades are centimetre ripples that would just make hulls buzz).
      if (!this.useGpu || i < PHYSICS_CASCADES) {
        if (i < PHYSICS_CASCADES) {
          cascade.cpu.updateInterpolated(sim.time.value, sim.chop.value, sim.blend.value, cascade.keyInterval, this.useGpu);
        } else cascade.cpu.update(sim.time.value, sim.chop.value, sim.blend.value);
      }
    }
    this.carriedCascades = carried;
    if (this.useGpu) {
      if (computeMask) renderer.compute(this.computeMasks[computeMask] as any);
    } else {
      for (let i = 0; i < cascades.length; i++) {
        const cascade = cascades[i];
        cascade.cpu.updateDerivatives(Math.max(dt, 1e-3), sim.foamBias.value, sim.foamDecay.value);
        const dh = cascade.cpuDisplacementHalf, gh = cascade.cpuDerivativeHalf;
        const d = cascade.cpu.displacement, g = cascade.cpu.derivatives;
        const toHalf = THREE.DataUtils.toHalfFloat;
        // Stored as (dx, height, dz) to match the GPU layout.
        if (dh && gh) for (let i = 0; i < d.length; i++) { dh[i] = toHalf(d[i]); gh[i] = toHalf(g[i]); }
        cascade.displacement.needsUpdate = true;
        cascade.derivatives.needsUpdate = true;
      }
    }

    if (this.engine.world.sourceCount && this.fieldTime !== this.engine.time) this.updateField(dt,camera.position);
    // The surface mesh rides under the camera.
    const meshPosition = this.mesh.position, origin = u.origin.value as THREE.Vector2;
    meshPosition.x = cameraX; meshPosition.y = 0; meshPosition.z = cameraZ;
    this.mesh.updateMatrixWorld();
    origin.x = cameraX; origin.y = cameraZ;
  }

  /** Advance the interaction field. Call after queuing this frame's sources. */
  updateField(dt: number, focus: { x: number; z: number }): void {
    const bus = this.engine.world;
    this.fieldTime = this.engine.time;
    const field = this.field, sources = field.sources, waterLevel = this.waterLevel;
    for (let i=0;i<bus.sourceCount;i++) {
      const s = bus.sourceAt(i);
      // Each input of the capsule is read once; the pressure load then goes straight into a
      // world-pressure slot of the field instead of through an intermediate object.
      const pressure = s.pressure;
      if (!pressure) continue;
      const start = s.start, end = s.end, radius = s.radius;
      const startY = start.y, endY = end.y;
      const below = Math.min(startY,endY), above = Math.max(startY,endY);
      const height = Math.max(0,below-waterLevel,waterLevel-above);
      if (height >= radius) continue;
      const o = field.reserveSource(true);
      if (o < 0) continue;
      // The load enters the ocean where the swept source meets the surface.
      const dy = endY - startY;
      const t = Math.abs(dy) > 1e-6 ? THREE.MathUtils.clamp((waterLevel - startY) / dy, 0, 1) : 0.5;
      const startX = start.x, startZ = start.z;
      const push = -pressure*bus.gainAt(i)*(1-height/radius);
      const annular = s.rimLift>0 && s.radial>0;
      sources[o] = startX + (end.x - startX) * t;
      sources[o + 1] = startZ + (end.z - startZ) * t;
      sources[o + 2] = Math.max(0.5, radius * 0.55);
      sources[o + 3] = push;
      sources[o + 4] = 0;
      sources[o + 5] = Math.abs(push)*(annular?1.2:0.12);
      sources[o + 6] = annular ? 1 : 0;
    }
    field.update(dt, focus);
  }

  setQuality(preset: QualityPreset): void { this.build(preset); }

  // ---------------------------------------------------------------------------
  // CPU sampling (buoyancy / gameplay)
  // ---------------------------------------------------------------------------

  private shoalFactor(depth: number): number {
    return Math.pow(THREE.MathUtils.smoothstep(depth, -0.05, 5.5), 0.8);
  }

  /** Still-water depth at a position (large when there is no bathymetry). */
  depthAt(x: number, z: number): number {
    return this.bathymetry ? this.waterLevel - this.bathymetry.heightAt(x, z) : 1000;
  }

  /** Water surface height at world (x, z), including swell, chop inversion and tsunami. */
  heightAt(x: number, z: number): number {
    this.singlePoint[0].x = x;
    this.singlePoint[0].z = z;
    this.heightsAt(this.singlePoint, this.singleProbe);
    return this.singleProbe.heights[0];
  }

  /** Solve the same inverse mapping for a whole hull without boxing a call per point and band. */
  heightsAt(points: readonly THREE.Vector3[], batch: OceanHeightBatch): void {
    const { coordinates, displacement, shoal, heights } = batch;
    const n = points.length;
    const wave = this.tsunami.active, dir = this.tsunami.direction;
    if (heights.length !== n) throw new RangeError('OceanHeightBatch size must match the point count');
    for (let i = 0; i < n; i++) {
      const p = points[i], x = p.x, z = p.z;
      coordinates[i * 2] = x;
      coordinates[i * 2 + 1] = z;
      shoal[i] = this.bathymetry ? this.shoalFactor(this.depthAt(x, z)) : 1;
      heights[i] = this.waterLevel;
    }
    const count = Math.min(this.cascades.length, PHYSICS_CASCADES);
    for (let pass = 0; pass < 3; pass++) {
      const horizontal = pass < 2;
      displacement.fill(0);
      for (let i = 0; i < count; i++) this.cascades[i].cpu.sampleBatch(coordinates, displacement, horizontal);
      for (let i = 0; i < n; i++) {
        if (horizontal) {
          let x = points[i].x - displacement[i * 3] * shoal[i];
          let z = points[i].z - displacement[i * 3 + 2] * shoal[i];
          if (wave) {
            const offset = this.tsunami.restOffset(x, z, this.depthAt(coordinates[i * 2], coordinates[i * 2 + 1]));
            x += dir.x * offset; z += dir.y * offset;
          }
          coordinates[i * 2] = x; coordinates[i * 2 + 1] = z;
        } else {
          heights[i] += displacement[i * 3 + 1] * shoal[i];
          if ((this.bathymetry && shoal[i] < 1) || wave) {
            const x = coordinates[i * 2], z = coordinates[i * 2 + 1], depth = this.depthAt(x, z);
            if (this.bathymetry) heights[i] += breakerAt(x, z, depth, this.engine.time, this.optics.breakerHeight);
            if (wave) heights[i] += this.tsunami.heightAtRest(x, z, depth);
          }
        }
      }
    }
    this.field.addProbeHeights(coordinates, heights);
  }

  /** Height + surface normal (central differences over `span` metres). */
  sample(x: number, z: number, out: OceanSample, span = 0.6): OceanSample {
    const h = this.heightAt(x, z);
    const hx = this.heightAt(x + span, z), hz = this.heightAt(x, z + span);
    out.height = h;
    out.normal.set(-(hx - h) / span, 1, -(hz - h) / span).normalize();
    return out;
  }

  /** Water velocity in m/s, from tsunami flow, local disturbances and tidal rise or fall. */
  flowAt(x: number, z: number, out = _flow): THREE.Vector3 {
    if(this.tsunami.active)this.tsunami.flowAt(x,z,this.depthAt(x,z),out);
    else out.set(0,0,0);
    out.y += this.tideVelocity + this.field.sampleVerticalSpeed(x, z);
    if(this.surfaceCurrent){this.surfaceCurrent(x,z,this.tideVelocity,this.ambientFlow.set(0,0,0));out.add(this.ambientFlow);}
    if (this.bathymetry) out.y += breakerAt(x, z, this.depthAt(x, z), this.engine.time, this.optics.breakerHeight, true);
    return out;
  }

  // ---------------------------------------------------------------------------

  private disposeResources(): void {
    for (const cascade of this.cascades) {
      cascade.gpu?.dispose();
      if (!cascade.gpu) { cascade.displacement.dispose(); cascade.derivatives.dispose(); }
    }
    this.cascades = [];
    this.field?.dispose();
    for (const mesh of [this.mesh, this.crestStrip]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  dispose(): void { this.unregisterWater(); this.disposeResources(); }
}
