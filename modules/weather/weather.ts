/**
 * Weather: atmosphere, volumetric clouds, sun, environment lighting and fog as one module.
 *
 * Everything is parameterised physically (`params`) and can be morphed live. Other modules
 * pull three shader hooks from here:
 *   - `reflection(dir, lod)`     environment radiance incl. clouds (water / wet-road mirrors)
 *   - `cloudShadow(worldPos)`    optical-depth sun visibility
 *   - `aerial(color, worldPos)`  aerial-perspective haze toward the horizon
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { cloudFireBounce } from '../../engine/shaders/cloud-bounce';
import { frame, auxSurface, screenVelocity, sunlightAtHeight } from '../../engine/frame';
import { cloudOffsetTile } from './blue-noise';
import { temporalIGN, bakeCloudNoise } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import { ATMOSPHERE, atmosphereLutNode, skyLutUV, skyRadianceCPU, sunTransmittanceCPU } from './atmosphere';
import { LocalReflectionProbe, type LocalProbeOptions } from './reflection-probe';
import { FieldReading } from '../../engine/world-bus';
import { DEFAULT_CLOUD_EROSION, createCloudModel, createCloudUniforms, type CloudModel, type CloudUniforms } from './clouds';

const {
  Fn, float, vec2, vec3, vec4, uniform, texture, uv, positionWorld, cameraPosition, normalize, mix, exp, max, dot,
  smoothstep, cos, sin, screenCoordinate, If, min, equirectUV, length, pow, fog, positionWorldDirection, abs, perspectiveDepthToViewZ, sqrt,
} = TSL;

export interface WeatherParams {
  /** Sun elevation above the horizon in degrees. */
  sunElevation: number;
  /** Sun azimuth in degrees (0 = +X, 90 = +Z). */
  sunAzimuth: number;
  /** Relative moonlight intensity after dark, 0 for a moonless night. */
  moonlight?: number;
  /** Fraction of the visible lunar disc in light, or derive it from the two celestial directions. */
  moonIllumination?: number | 'fromDirections';
  /** Mie turbidity: 1 crisp · 3 coastal haze · 8+ storm murk. */
  turbidity: number;
  /** 0..1 fraction of sky filled by cloud. */
  coverage: number;
  cloudDensity: number;
  /** Horizontal formation size multiplier. Smaller values produce smaller cells and gaps. */
  cloudScale?: number;
  /** Fraction of the softer cell boundary removed by small-scale turbulence, 0..1. */
  cloudErosion?: number;
  /** Vertical development bias, −1 for shallow cells, +1 for towers. */
  convection?: number;
  /** Cloud deck base / top altitude in metres. */
  cloudBase: number;
  cloudTop: number;
  /** 0..1 storm development: towering dark-based cells, anvils, murk. */
  storm: number;
  /** 0..1 rain intensity (consumed by the rain + wet-road + ocean modules). */
  rain: number;
  /** Meteorological visibility in metres. */
  visibility: number;
  /** Camera exposure multiplier. */
  exposure: number;
  /** 0..1 strength of volumetric light shafts (crepuscular rays) around the sun. */
  shafts?: number;
}

/** A second deck has its own geometry, water content and horizontal drift. */
export interface CloudLayerOptions {
  base: number;
  top: number;
  coverage: number;
  density: number;
  storm: number;
  scale: number;
  erosion?: number;
  convection?: number;
  /** Horizontal advection in world m/s. */
  windX: number;
  windZ: number;
}

export interface WeatherOptions {
  distribution?:import('./clouds').CloudDistribution;
  skyGlow?:{center:THREE.Vector2;radius:number;color:THREE.ColorRepresentation;intensity:number};
  /** Include editable sky tint and cloud lighting bands in this world's shader graph. */
  artDirection?: boolean;
  localProbe?: LocalProbeOptions;
  /** Allocate the two-deck shader. Set coverage to zero to hide this deck live. */
  upperClouds?: CloudLayerOptions;
}

export const CLOUD_LAYERS = {
  highBank: { base: 4600, top: 6300, coverage: 0.61, density: 0.7, storm: 0.12, scale: 1.25, windX: 21, windZ: -6 },
  rainBank: { base: 5700, top: 8000, coverage: 0.86, density: 1.12, storm: 0.8, scale: 1.6, windX: 12, windZ: 8 },
} satisfies Record<string, CloudLayerOptions>;

export const WEATHER_PRESETS: Record<string, WeatherParams> = {
  hotFair: { sunElevation: 66, sunAzimuth: 50, turbidity: 2.1, coverage: 0.30, cloudDensity: 0.82, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 0.44, convection: -0.22, cloudBase: 1450, cloudTop: 2160, storm: 0, rain: 0, visibility: 66000, exposure: 0.52, shafts: 0.18 },
  tradeCumulus: { sunElevation: 46, sunAzimuth: 48, turbidity: 2.5, coverage: 0.43, cloudDensity: 0.88, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0.2, cloudBase: 850, cloudTop: 3800, storm: 0, rain: 0, visibility: 68000, exposure: 0.58, shafts: 0.26 },
  coastalHaze: { sunElevation: 6, sunAzimuth: 28, turbidity: 3.6, coverage: 0.33, cloudDensity: 0.78, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 680, cloudTop: 2150, storm: 0, rain: 0, visibility: 22000, exposure: 0.29, shafts: 0.15 },
  tropical: { sunElevation: 52, sunAzimuth: 35, turbidity: 2.2, coverage: 0.42, cloudDensity: 1, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 1300, cloudTop: 3600, storm: 0, rain: 0, visibility: 60000, exposure: 0.54, shafts: 0.3 },
  goldenHour: { sunElevation: 9, sunAzimuth: 20, turbidity: 3.2, coverage: 0.48, cloudDensity: 1, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 1500, cloudTop: 4200, storm: 0.1, rain: 0, visibility: 45000, exposure: 0.85, shafts: 0.85 },
  blueHour: { sunElevation: -3.5, sunAzimuth: 20, turbidity: 2.5, coverage: 0.33, cloudDensity: 0.86, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0.12, cloudBase: 1200, cloudTop: 3600, storm: 0, rain: 0, visibility: 55000, exposure: 1.05, shafts: 0.06 },
  clearNight: { sunElevation: -18, sunAzimuth: 20, turbidity: 2, coverage: 0.16, cloudDensity: 0.8, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 1400, cloudTop: 3700, storm: 0, rain: 0, visibility: 48000, exposure: 1.55, shafts: 0 },
  overcastSwell: { sunElevation: 34, sunAzimuth: 60, turbidity: 4.5, coverage: 0.72, cloudDensity: 1.1, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 1100, cloudTop: 4200, storm: 0.35, rain: 0, visibility: 30000, exposure: 0.8, shafts: 0.7 },
  storm: { sunElevation: 24, sunAzimuth: 110, turbidity: 8, coverage: 0.86, cloudDensity: 1.3, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 700, cloudTop: 5200, storm: 0.92, rain: 0.85, visibility: 9000, exposure: 1.15, shafts: 0.9 },
  hurricane: { sunElevation: 18, sunAzimuth: 140, turbidity: 10, coverage: 0.9, cloudDensity: 1.45, cloudErosion: DEFAULT_CLOUD_EROSION, cloudScale: 1, convection: 0, cloudBase: 550, cloudTop: 5600, storm: 1, rain: 1, visibility: 5500, exposure: 1.35, shafts: 0.8 },
};

const _dir = new THREE.Vector3();
const _c1 = new THREE.Color();
const _size = new THREE.Vector2();
const _proj = new THREE.Matrix4();
const _vp = new THREE.Matrix4();


const SHADOW_MAP_SIZE = 256;
/** World extent (m) of the cloud shadow map, centred on the camera. */
const SHADOW_MAP_EXTENT = 24000;
const CLOUD_OVERSCAN = 1.12;

/** Large edits replace a cloud field. Small changes during a weather transition can
 * still reuse samples of the same formation from the preceding frame. */
function cloudLayerCut(u: CloudUniforms, base: number, top: number, coverage: number, density: number,
  frequency: number, convection: number, storm: number, erosion: number): boolean {
  return ((u.coverage.value > 0 && u.density.value > 0) !== (coverage > 0 && density > 0)) ||
    Math.abs(u.coverage.value - coverage) > 0.15 || Math.abs(u.density.value - density) > 0.3 ||
    Math.abs(u.base.value - base) > 80 || Math.abs(u.top.value - top) > 160 ||
    Math.abs(u.frequency.value - frequency) > 0.02 * frequency ||
    Math.abs(u.erosion.value - erosion) > 0.18 || Math.abs(u.convection.value - convection) > 0.12 || Math.abs(u.storm.value - storm) > 0.2;
}

let frameWeather:Weather|undefined;

export class Weather implements EngineModule {
  private readonly distribution?:WeatherOptions['distribution'];
  private readonly skyGlow?:WeatherOptions['skyGlow'];
  private readonly eyeHorizon=uniform(new THREE.Color());
  private readonly eyeZenith=uniform(new THREE.Color());
  private skyHeight=-Infinity;
  readonly localProbe: LocalReflectionProbe | null;
  readonly params: WeatherParams = { ...WEATHER_PRESETS.tropical };
  readonly sun: THREE.DirectionalLight;
  readonly clouds: CloudModel;
  readonly upperClouds: CloudLayerOptions | null;
  private readonly upperModel: CloudModel | null;
  private lensProbeTime = 0;
  private readonly eyeFields=new FieldReading();
  private readonly localCloudDensity = uniform(0);
  private readonly mistSunTransmission = uniform(1);
  private readonly mistProbe = new THREE.Vector3();
  private readonly cloudEye: N;
  private readonly eyeToWorld = uniform(new THREE.Matrix4());
  private readonly inverseProjection = uniform(new THREE.Matrix4());
  cloudMoisture = 0;
  readonly cloudUniforms: CloudUniforms;
  /** World point the sun shadow frustum is centred on. */
  readonly shadowFocus = new THREE.Vector3();
  shadowExtent = 45;
  private readonly localShadowCenter = uniform(this.shadowFocus);
  private readonly localShadowRadiusSq = uniform(45 * 45 * 3);
  private readonly terrainShadow: N;
  /** Ocean / ground colour used for the lower hemisphere of the environment map. */
  readonly groundColor = new THREE.Color(0.02, 0.07, 0.11);

  private dome: THREE.Mesh;
  private lutTarget: THREE.RenderTarget;
  private envTarget: THREE.RenderTarget;
  private lutQuad: THREE.QuadMesh;
  private envQuad: THREE.QuadMesh;
  private atmoUniforms = { sunElevation: uniform(0.9), turbidity: uniform(2.2), cameraAltitude: uniform(10) };
  private uFogDensity = uniform(1 / 60000);
  private uOvercast = uniform(0);
  private uGround = uniform(new THREE.Color(0.02, 0.07, 0.11));
  /** Unit direction towards the moon. Games can supply an independent lunar ephemeris. */
  readonly moonDirection = new THREE.Vector3(-0.48, 0.53, 0.70).normalize();
  private readonly uMoonDirection = uniform(this.moonDirection.clone());
  private readonly uMoon = uniform(0);
  private readonly uMoonDisc = uniform(0);
  private readonly uMoonPhaseLight = uniform(new THREE.Vector4(0, 0, 0, 1));
  /** Direct solar spectrum at the camera, before local cloud and disc occlusion. */
  readonly eyeSunlight = uniform(new THREE.Color());
  private readonly discFraction = uniform(1);
  private readonly horizonSine = uniform(0);
  private lastSolarEyeHeight = -Infinity;
  get solarDiscVisibility(): number { return this.discFraction.value; }
  /** Sun position in NDC (y up) and the current light-shaft strength. */
  private uSunUV = uniform(new THREE.Vector2(0.5, 0.5));
  private uShaftStrength = uniform(0);
  private uAspect = uniform(1);
  private uNearFar = uniform(new THREE.Vector2(0.3, 60000));
  /** Fog factor at the geometric horizon: how far the sky's base sinks into the haze. */
  private uHorizonFog = uniform(0.4);
  private shaftSteps = -1;
  private desiredShaftSteps = 0;
  private externalShafts = false;
  private sunElevation = NaN;
  private sunAzimuth = NaN;
  private skyChanged = true;
  private skyFlashed = false;
  private fogAltitude = -Infinity;
  private fogVisibility = -1;
  private readonly sunDirection = new THREE.Vector3();
  private readonly surfaceSun = new THREE.Color();
  private readonly flightSun = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private readonly solarLimbHeights = new THREE.Vector2();
  private readonly surfaceZenith = new THREE.Color();
  private readonly surfaceHorizon = new THREE.Color();
  private sunVisibility = 1;
  /** Lowest tier: sky passes run at a reduced cadence. */
  private sparse = false;
  /** True when Low single-pass analytic cloud dome is active (zero cloud raymarch). */
  private analyticMode = false;
  private uAnalyticClouds = uniform(0);
  private weatherTex: THREE.DataTexture;
  private cachedSun = new THREE.Color();
  private cachedZenith = new THREE.Color();
  private cachedHorizon = new THREE.Color();
  private envAge = 0;
  // Off-screen cloud buffer: reduced resolution, temporally reprojected, overscanned.
  private cloudTargets: [THREE.RenderTarget, THREE.RenderTarget];
  private cloudQuad: THREE.QuadMesh;
  private cloudIndex = 0;
  private cloudScale = 0.5;
  private cloudValid = false;
  private cloudSamples = 0;
  private cloudFlashed = false;
  private readonly cloudFilterRadius = uniform(0);
  private readonly lastForward = new THREE.Vector3(0, 0, -1);
  private readonly lastPosition = new THREE.Vector3();
  private cloudHistory: N;
  private cloudCurrent: N;
  private uCloudInvVP = uniform(new THREE.Matrix4());
  private uCloudVP = uniform(new THREE.Matrix4());
  private uCloudTexel = uniform(new THREE.Vector2(0.25, 0.25));
  private uCloudPrevVP = uniform(new THREE.Matrix4());
  private uCloudCam = uniform(new THREE.Vector3());
  private readonly cloudEyeDelta = uniform(new THREE.Vector3());
  private readonly previousDeckOffsets = new THREE.Vector4();
  private readonly deckDrift = uniform(new THREE.Vector4());
  private uCloudBlend = uniform(1);
  private readonly rayOffsets = cloudOffsetTile();
  private readonly artDirected: boolean;
  readonly skyTint = uniform(new THREE.Color(1, 1, 1));
  readonly cloudBands = uniform(0);

  private cloudAppearance(radiance: N): N {
    const opacity = radiance.a.oneMinus().max(0.003);
    const intensity = TSL.dot(radiance.rgb, vec3(0.2126, 0.7152, 0.0722)).div(opacity).max(0.012);
    const stops = TSL.log2(intensity).mul(1.65);
    const fraction = stops.fract();
    const stepped = TSL.exp2(stops.floor().add(smoothstep(0.40, 0.60, fraction)).div(1.65));
    const gain = mix(1, stepped.div(intensity), this.cloudBands);
    return vec4(radiance.rgb.mul(gain).mul(mix(vec3(1), this.skyTint, 0.40)), radiance.a);
  }
  /** Adapt from the sky and shelter at the lens. Disable to retain an authored fixed exposure. */
  autoExposure = false;
  /** E-folding response times in seconds when entering bright and dark surroundings. */
  exposureResponse = { brightenSceneSeconds: 0.95, darkenSceneSeconds: 0.24 };
  private adaptedExposure = NaN;
  private skyTransition: { key: keyof WeatherParams; from: number; to: number }[] = [];
  private transitionElapsed = 0;
  private transitionDuration = 0;

  transitionTo(target: Partial<WeatherParams>, seconds = 0): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Expected nonnegative transition seconds');
    this.skyTransition.length = 0;
    this.transitionElapsed = 0; this.transitionDuration = seconds;
    for (const key of Object.keys(target) as (keyof WeatherParams)[]) {
      const to = target[key], from = this.params[key];
      if (seconds > 0 && typeof from === 'number' && typeof to === 'number' && from !== to) {
        const end = key === 'sunAzimuth' ? from + THREE.MathUtils.euclideanModulo(to - from + 180,360) - 180 : to;
        this.skyTransition.push({ key, from, to: end });
      } else Object.assign(this.params, { [key]: to });
    }
  }

  // Top-down cloud shadow map (one texture tap for every lit fragment in the scene).
  private shadowTarget: THREE.RenderTarget;
  private shadowQuad: THREE.QuadMesh;
  private uShadowCenter = uniform(new THREE.Vector2());
  private pmremAge = 1e9;
  private frameCounter = 0;
  /** Seconds between PMREM refreshes of the scene environment. */
  pmremInterval = 1.5;
  /** Scene fog node colour/factor are owned by this module. */
  private lightingVersion = 0;
  private reflectedVersion = -1;
  private readonly reflectedSky = new Float64Array(5).fill(NaN);
  private lutAltitude = -Infinity;
  private reflectionAge = Infinity;
  /** Drawing-buffer size and internal scale the cloud buffer was last sized for. */
  private cloudSizedWidth = NaN;
  private cloudSizedHeight = NaN;
  private cloudSizedScale = NaN;

  constructor(private engine: LuminaEngine, options: WeatherOptions = {}) {
    const { scene, renderer } = engine;
    this.distribution=options.distribution;this.skyGlow=options.skyGlow;
    this.artDirected = options.artDirection ?? false;
    this.localProbe = options.localProbe ? new LocalReflectionProbe(options.localProbe) : null;
    this.cloudEye = uniform(engine.camera.position);
    this.cloudUniforms = createCloudUniforms();
    this.clouds = createCloudModel(this.cloudUniforms, p => engine.world.cloudNode(p),this.distribution);
    this.upperClouds = options.upperClouds ? { ...options.upperClouds } : null;
    this.upperModel = null;
    if (this.upperClouds) {
      const upper = createCloudUniforms();
      const common = this.cloudUniforms;
      upper.lightSteps = common.lightSteps;
      upper.visibility = common.visibility;
      upper.flashPosition = common.flashPosition;
      upper.flashColor = common.flashColor;
      upper.offset.value.set(15300, 0, -18400);
      this.upperModel = createCloudModel(upper, p => engine.world.cloudNode(p),this.distribution,true);
      this.updateUpperDeck(0);
    }
    this.weatherTex = bakeCloudNoise().weather;

    const makeCloudTarget = () => {
      const rt = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.cloudTargets = [makeCloudTarget(), makeCloudTarget()];
    this.cloudHistory = texture(this.cloudTargets[0].texture);
    this.cloudCurrent = texture(this.cloudTargets[1].texture);
    this.shadowTarget = makeCloudTarget();
    this.shadowTarget.setSize(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

    this.lutTarget = new THREE.RenderTarget(256, 128, { type: THREE.HalfFloatType, depthBuffer: false });
    this.lutTarget.texture.minFilter = this.lutTarget.texture.magFilter = THREE.LinearFilter;
    this.lutTarget.texture.wrapS = this.lutTarget.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.lutTarget.texture.generateMipmaps = false;
    const lutMaterial = new THREE.NodeMaterial();
    lutMaterial.fragmentNode = atmosphereLutNode(this.atmoUniforms);
    this.lutQuad = new THREE.QuadMesh(lutMaterial);

    const cloudMaterial = new THREE.NodeMaterial();
    cloudMaterial.fragmentNode = this.cloudBufferNode();
    this.cloudQuad = new THREE.QuadMesh(cloudMaterial);
    const shadowMaterial = new THREE.NodeMaterial();
    shadowMaterial.fragmentNode = Fn(() => {
      const world = this.uShadowCenter.add(uv().sub(0.5).mul(SHADOW_MAP_EXTENT));
      const vis = float(1).toVar();
      If(this.uAnalyticClouds.greaterThan(0.5), () => {
        const p = vec3(world.x, 0, world.y);
        vis.assign(this.analyticShadowNode(p));
        if (this.upperModel) {
          const upper = this.upperModel.uniforms;
          If(upper.coverage.greaterThan(0), () => { vis.mulAssign(this.analyticShadowNode(p, upper)); });
        }
      }).Else(() => {
        const p = vec3(world.x, 0, world.y);
        vis.assign(this.clouds.shadow(p));
        if (this.upperModel) {
          const upper = this.upperModel;
          If(upper.uniforms.coverage.greaterThan(0), () => { vis.mulAssign(upper.shadow(p)); });
        }
      });
      return vec4(vec3(vis), 1);
    })();
    this.shadowQuad = new THREE.QuadMesh(shadowMaterial);

    const envSize = engine.quality.preset.clouds.envSize;
    this.envTarget = this.createEnvTarget(envSize);
    const envMaterial = new THREE.NodeMaterial();
    envMaterial.fragmentNode = this.environmentNode();
    this.envQuad = new THREE.QuadMesh(envMaterial);

    // Sun: colour comes from the shared uniform and carries cloud shadows to every lit material.
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    // Share one depth render between standard PBR receivers and custom water shaders.
    this.terrainShadow = TSL.shadow(this.sun);
    this.sun.shadow.shadowNode = this.terrainShadow;
    (this.sun as any).colorNode = sunlightAtHeight(positionWorld.y).mul(this.airborneCloudShadow(positionWorld))
      .add(vec3(0.13, 0.155, 0.21).mul(this.uMoon));
    this.sun.castShadow = true;
    if (this.localProbe) this.sun.layers.enable(this.localProbe.layer);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);

    this.dome = this.createDome();
    scene.add(this.dome);

    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 1;
    (scene as any).fogNode = fog(this.fogColor(positionWorld), this.fogFactor(positionWorld));

    this.registerCloudImmersion();
    this.setQuality(engine.quality.preset);
    void renderer;
  }

  private createEnvTarget(width: number): THREE.RenderTarget {
    const target = new THREE.RenderTarget(width, width / 2, { type: THREE.HalfFloatType, depthBuffer: false });
    target.texture.mapping = THREE.EquirectangularReflectionMapping;
    target.texture.wrapS = THREE.RepeatWrapping;
    target.texture.wrapT = THREE.ClampToEdgeWrapping;
    target.texture.generateMipmaps = true;
    target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    target.texture.magFilter = THREE.LinearFilter;
    return target;
  }

  // -------------------------------------------------------------------------
  // Shader hooks
  // -------------------------------------------------------------------------

  /** True when the Low single-pass analytic cloud dome is active (zero cloud raymarching). */
  get analyticClouds(): boolean { return this.analyticMode; }

  /**
   * Hand off screen-space light shafts to an external post effect (such as `SunFx`) so
   * crepuscular rays are never rendered twice.
   */
  setExternalShafts(enabled: boolean): void {
    if (this.externalShafts === enabled) return;
    this.externalShafts = enabled;
    this.registerShafts(this.externalShafts ? 0 : this.desiredShaftSteps);
  }

  /**
   * Single-pass analytic cloud dome evaluation (zero raymarching, zero 3D textures).
   * Projects `dir` onto the curved earth cloud layer, samples the baked 2D weather texture
   * with a single sun-shifted self-shadow tap and dual-lobe HG silver lining, returning
   * `vec4(scatteredRadiance, transmittance)` matching the volumetric cloud buffer contract.
   */
  private analyticLayer(origin: N, dir: N, atmosphereColor: N, u: CloudUniforms, incidentSun: N = float(1)): N {
    const weatherTex = this.weatherTex;
    const earthCurve = float(1 / (2 * ATMOSPHERE.planetRadius));
    return Fn(() => {
      const result = vec4(0, 0, 0, 1).toVar();
      If(dir.y.greaterThan(-0.015).or(origin.y.greaterThanEqual(u.base)), () => {
        const oy = origin.y;
        const a = float(1).sub(dir.y.mul(dir.y)).mul(earthCurve);
        const alt = mix(u.base, u.top, 0.28);
        const c = oy.sub(alt);
        const disc=dir.y.mul(dir.y).sub(a.mul(c).mul(4));
        const root=sqrt(max(disc,0));
        const fromBelow=c.mul(-2).div(dir.y.add(root).max(1e-4));
        const fromAbove=dir.y.lessThan(0).and(disc.greaterThanEqual(0)).select(c.mul(2).div(dir.y.negate().add(root).max(1e-4)),float(1e7));
        const within=oy.greaterThanEqual(u.base).and(oy.lessThanEqual(u.top));
        const t=within.select(float(38),c.lessThan(0).select(fromBelow,fromAbove));
        If(t.lessThan(150000), () => {
          const pXZ = origin.xz.add(dir.xz.mul(t)).add(u.offset.xz).mul(u.frequency);
          const w1 = texture(weatherTex, pXZ.mul(1 / 46000)).level(0);
          const rotXZ = vec2(pXZ.x.mul(0.8).sub(pXZ.y.mul(0.6)), pXZ.x.mul(0.6).add(pXZ.y.mul(0.8)));
          const w2 = texture(weatherTex, rotXZ.mul(1 / 14500).add(vec2(0.37, 0.71))).level(0);

          const shape = w1.r.mul(0.62).add(w2.r.mul(0.24)).add(w2.b.mul(0.14));
          const cov = mix(smoothstep(float(0.76).sub(u.coverage), float(1.18).sub(u.coverage), shape), float(1), smoothstep(0.76, 1.0, u.coverage));
          const detail = smoothstep(0.12, 0.88, w1.b.mul(0.55).add(w2.g.mul(0.45)));
          const development = max(u.storm, smoothstep(0.26, 0.76, w1.g.mul(0.62).add(w1.b.mul(0.38)))).add(u.convection).clamp(0, 1);
          const loc=origin.xz.add(dir.xz.mul(t));
          const regional=this.distribution?.coverageNode(loc,frame.time,u!==this.cloudUniforms);
          const cover = this.analyticErosion(regional?cov.mul(regional):cov, detail, u);
          const thickness = cover.mul(mix(0.28, 1.20, development)).mul(mix(0.58, 1.0, detail)).mul(u.density).mul(mix(1.0, 2.2, u.storm));
          const horizonFade = oy.greaterThanEqual(u.base).select(float(1),smoothstep(0.0, 0.08, dir.y));
          const samplePoint = origin.add(dir.mul(t));
          const tau = thickness.mul(u.coverage.greaterThan(0).select(1, 0)).mul(horizonFade).mul(3.4).mul(float(1).sub(this.engine.world.cloudNode(samplePoint)));
          const transmittance = exp(tau.negate()).clamp(0, 1);

          // One sun-offset 2D weather tap for analytic self-shadowing (bright tops, shaded bases).
          const sun = frame.sunDirection;
          const pSun = pXZ.add(sun.xz.div(max(sun.y, 0.14)).mul(900).mul(u.frequency));
          const wSun = texture(weatherTex, pSun.mul(1 / 46000)).level(0);
          const sunCov = mix(smoothstep(float(0.74).sub(u.coverage), float(1.16).sub(u.coverage), wSun.r.mul(0.85).add(wSun.b.mul(0.15))), float(1), smoothstep(0.78, 1.0, u.coverage));
          const frontSun=this.distribution?.coverageNode(loc.add(sun.xz.div(max(sun.y,.14)).mul(900)),frame.time,u!==this.cloudUniforms);
          const odL = this.analyticErosion(frontSun?sunCov.mul(frontSun):sunCov, wSun.b, u).mul(u.density).mul(mix(1.0, 2.2, u.storm)).mul(2.3).add(thickness.mul(0.85));
          const beer = max(exp(odL.negate()), exp(odL.mul(-0.18)).mul(0.68));
          const powder = float(1).sub(exp(thickness.mul(-2.8))).mul(0.5).add(0.5);

          const mu = dot(dir, sun);
          const hg = (g: number) => float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(mu.mul(2 * g)).max(1e-4), 1.5));
          const phase = mix(hg(0.76), hg(-0.2), 0.42).mul(4 * Math.PI).add(hg(0.95).mul(4 * Math.PI * 0.032));
          const sunLight = sunlightAtHeight(alt).mul(incidentSun).mul(beer).mul(powder).mul(phase.mul(0.22).add(0.09));
          const heightTint = w1.g.clamp(0, 1);
          const ambient = mix(frame.skyHorizon.mul(1.05), frame.skyZenith.mul(1.45), heightTint)
            .mul(mix(1.0, 0.32, u.storm.mul(float(1).sub(heightTint.mul(0.5)))));
          const q = vec3(origin.x.add(dir.x.mul(t)), alt, origin.z.add(dir.z.mul(t)));
          const flashDist = length(q.sub(u.flashPosition));
          const flash = u.flashColor.mul(exp(flashDist.div(-1900))).mul(float(1).div(flashDist.div(900).pow(2).add(1)));

          const alpha = float(1).sub(transmittance);
          const clarity = exp(t.div(u.visibility).negate());
          const light = sunLight.add(ambient).add(flash).add(cloudFireBounce(origin, dir, u.base)).mul(alpha);
          result.assign(vec4(mix(atmosphereColor.mul(alpha), light, clarity), transmittance));
        });
      });
      return result;
    })();
  }

  /** Analytic 2D cloud shadow (zero 3D volume taps) used on Low tier. */
  private analyticCloudNode(origin: N, dir: N, sky: N): N {
    return this.renderDecks(origin, dir, sky);
  }

  /** Composite premultiplied radiance front to back. Split the existing ray budget
   * between the two occupied decks; the clear gap costs no marching steps. */
  private renderDecks(origin: N, dir: N, sky: N, jitter?: N, steps?: N, distanceOut?: N, upperFraction?: N): N {
    const render = (model: CloudModel, budget: N, reach?: N, incidentSun?: N) => jitter === undefined
      ? this.analyticLayer(origin, dir, sky, model.uniforms, incidentSun)
      : model.march(origin, dir, jitter, budget, sky, reach, incidentSun);
    const upper = this.upperModel;
    if (!upper) return render(this.clouds, steps, distanceOut);
    const high = upper.uniforms, low = this.cloudUniforms;
    return Fn(() => {
      const enabled = high.coverage.greaterThan(0).and(high.density.greaterThan(0));
      const highFirst = origin.y.greaterThanEqual(high.base).or(origin.y.greaterThan(low.top).and(dir.y.greaterThan(0)));
      const both = enabled.and(low.coverage.greaterThan(0)).and(low.density.greaterThan(0)).and(origin.y.lessThan(low.top).and(dir.y.greaterThan(-0.015))
        .or(origin.y.greaterThan(high.base).and(dir.y.lessThan(0))));
      const highBudget = steps ? TSL.floor(steps.mul(0.4)).max(3) : undefined;
      const lowSteps = steps ? both.select(steps.sub(highBudget), steps) : undefined;
      const lowReach = distanceOut ? float(40000).toVar() : undefined;
      // Sunlight arriving at nearby lower-bank droplets has already traversed the upper
      // deck. Sample its broad footprint once per ray before integrating the lower layer.
      const overhead = float(1).toVar();
      const nearBank = smoothstep(low.base.sub(80), low.base.add(20), origin.y)
        .mul(smoothstep(low.top.add(80), low.top.sub(20), origin.y));
      If(enabled.and(nearBank.greaterThan(0)), () => {
        overhead.assign(mix(1, this.analyticShadowNode(origin.add(dir.mul(120)), high), nearBank));
      });
      const lowCloud = render(this.clouds, lowSteps, lowReach, overhead).toVar();
      const result = lowCloud.toVar();
      if (distanceOut) distanceOut.assign(lowReach);
      If(enabled.and(highFirst.or(lowCloud.a.greaterThan(0.01))), () => {
        const highReach = distanceOut ? float(40000).toVar() : undefined;
        const highCloud = render(upper, steps ? both.select(highBudget, steps) : undefined, highReach).toVar();
        const front = highFirst.select(highCloud, lowCloud);
        const back = highFirst.select(lowCloud, highCloud);
        result.assign(vec4(front.rgb.add(back.rgb.mul(front.a)), front.a.mul(back.a)));
        if (distanceOut) {
          const highWeight = highCloud.a.oneMinus().mul(highFirst.select(float(1), lowCloud.a));
          const lowWeight = lowCloud.a.oneMinus().mul(highFirst.select(highCloud.a, float(1)));
          const weight = highWeight.add(lowWeight);
          if (upperFraction) upperFraction.assign(highWeight.div(weight.max(0.001)));
          distanceOut.assign(weight.greaterThan(0.001).select(highReach.mul(highWeight).add(lowReach.mul(lowWeight)).div(weight.max(0.001)), float(40000)));
        }
      });
      return result;
    })();
  }

  /** Undisturbed local condensate, evaluated from the same textures as both decks. */
  sampleCloudDensity(position: THREE.Vector3, time = this.engine.time): number {
    const upper = this.upperModel;
    return upper && position.y >= upper.uniforms.base.value
      ? upper.sampleDensity(position, time) : this.clouds.sampleDensity(position, time);
  }

  /** Shader condensate at a world point, including passing aircraft and blast cavities by default. */
  cloudDensityNode(position: N, disturbed = true): N {
    const upper = this.upperModel;
    if (!upper) return this.clouds.densityNode(position, disturbed);
    return Fn(() => {
      const density = float(0).toVar();
      If(position.y.greaterThanEqual(upper.uniforms.base), () => {
        density.assign(upper.densityNode(position, disturbed));
      }).Else(() => {
        density.assign(this.clouds.densityNode(position, disturbed));
      });
      return density;
    })();
  }

  private updateUpperDeck(dt: number): void {
    const params = this.upperClouds, model = this.upperModel;
    if (!params || !model) return;
    const u = model.uniforms;
    // A rising storm bank can meet the upper layer. Suppress a fully overlapped
    // upper deck instead of accumulating its optical depth twice.
    const base = Math.max(this.params.cloudTop, params.base);
    const top = Math.max(base + 1, params.top);
    const coverage = params.top > base ? THREE.MathUtils.clamp(params.coverage, 0, 1) : 0;
    const density = Math.max(0, params.density);
    const erosion = THREE.MathUtils.clamp(params.erosion ?? DEFAULT_CLOUD_EROSION, 0, 1);
    const convection = THREE.MathUtils.clamp(params.convection ?? 0, -1, 1);
    const frequency = 1 / Math.max(0.05, params.scale);
    const storm = THREE.MathUtils.clamp(params.storm, 0, 1);
    if (u.base.value !== base || u.top.value !== top || u.coverage.value !== coverage ||
        u.erosion.value !== erosion || u.convection.value !== convection || u.density.value !== density || u.storm.value !== storm || u.frequency.value !== frequency) {
      if (cloudLayerCut(u, base, top, coverage, density, frequency, convection, storm, erosion)) this.cloudValid = false;
      u.erosion.value = erosion; u.convection.value = convection;
      u.base.value = base; u.top.value = top; u.coverage.value = coverage;
      u.density.value = density; u.storm.value = storm; u.frequency.value = frequency;
      this.reflectionAge = Infinity;
      this.lightingVersion++;
    }
    u.offset.value.x -= params.windX * dt;
    u.offset.value.z -= params.windZ * dt;
    const present = coverage > 0 && density > 0;
    this.engine.world.upperCloudBase = present ? base : Infinity;
    this.engine.world.upperCloudTop = present ? top : -Infinity;
  }

  /** Erode sparse edges on the 2D fallback using channels already sampled for lighting. */
  private analyticErosion(coverage: N, detail: N, u: CloudUniforms): N {
    const edge = smoothstep(0.55, 0.94, coverage).oneMinus();
    return coverage.mul(float(1).sub(u.erosion.mul(detail.oneMinus()).mul(edge).mul(0.72)));
  }

  private analyticShadowNode(worldPosition: N, u = this.cloudUniforms): N {
    const weatherTex = this.weatherTex;
    return Fn(() => {
      const sun = frame.sunDirection;
      const sy = max(sun.y, 0.08);
      const alt = mix(u.base, u.top, 0.28);
      const t = alt.sub(worldPosition.y).div(sy);
      const pXZ = worldPosition.xz.add(sun.xz.mul(t)).add(u.offset.xz).mul(u.frequency);
      const w = texture(weatherTex, pXZ.mul(1 / 46000)).level(0);
      const cov = mix(smoothstep(float(0.74).sub(u.coverage), float(1.16).sub(u.coverage), w.r.mul(0.85).add(w.b.mul(0.15))), float(1), smoothstep(0.76, 1.0, u.coverage));
      const development = max(u.storm, smoothstep(0.26, 0.76, w.g.mul(0.62).add(w.b.mul(0.38)))).add(u.convection).clamp(0, 1);
      const regional=this.distribution?.coverageNode(worldPosition.xz.add(sun.xz.mul(t)),frame.time,u!==this.cloudUniforms);
      const od = this.analyticErosion(regional?cov.mul(regional):cov, w.b, u).mul(u.density).mul(mix(1.0, 2.2, u.storm)).mul(mix(1, 1.7, development)).div(sy.mul(0.6).add(0.4));
      return u.coverage.greaterThan(0).select(max(exp(od.negate()), 0.12), float(1));
    })();
  }

  /**
   * TSL: cloud transmittance (0 = opaque cloud, 1 = clear sky) along a world direction `dir`
   * evaluated analytically from the 2D weather deck (used in Low analytic mode and as an
   * off-screen fallback for sun occlusion).
   */
  analyticCloudTransmittance(dir: N): N {
    return this.analyticCloudNode(this.cloudEye,dir,this.skyColor(dir)).a;
  }

  /**
   * TSL: cloud transmittance (0..1) at a screen NDC point (y up). Samples the overscanned
   * volumetric cloud buffer in volumetric tiers and the analytic cloud deck on Low tier
   * (zero cloud march). Used by `SunFx` for cloud-occluded halos, flares and god rays.
   */
  cloudTransmittanceAtNdc(ndc: N, fallbackDir: N = frame.sunDirection): N {
    return Fn(() => {
      const trans = float(1).toVar();
      If(this.uAnalyticClouds.greaterThan(0.5), () => {
        trans.assign(this.analyticCloudTransmittance(fallbackDir));
      }).Else(() => {
        const cloudUV = ndc.div(CLOUD_OVERSCAN).mul(0.5).add(0.5);
        const inside = cloudUV.x.greaterThan(0.002).and(cloudUV.x.lessThan(0.998)).and(cloudUV.y.greaterThan(0.002)).and(cloudUV.y.lessThan(0.998));
        If(inside, () => {
          trans.assign(this.cloudCurrent.sample(cloudUV.clamp(0.002, 0.998)).level(0).a);
        }).Else(() => {
          trans.assign(this.analyticCloudTransmittance(fallbackDir));
        });
      });
      return trans;
    })();
  }

  /** Clear-sky radiance for a world direction (LUT lookup, overcast-aware). */
  skyColor(dir: N): N {
    const clear = texture(this.lutTarget.texture, skyLutUV(dir, frame.sunDirection)).level(0).rgb;
    const grey = mix(this.distribution?this.eyeHorizon:frame.skyHorizon, this.distribution?this.eyeZenith:frame.skyZenith, dir.y.clamp(0, 1)).mul(0.9);
    const sky = mix(clear.add(vec3(0.007, 0.012, 0.024).mul(this.uMoon)), grey, this.uOvercast.mul(0.85));
    return this.artDirected ? sky.mul(this.skyTint) : sky;
  }

  /** Environment radiance for reflections. `lod` blurs (0 = sharp). Downward rays mirror up. */
  reflection(dir: N, lod: N | number = 0): N {
    const d = vec3(dir.x, abs(dir.y).max(0.004), dir.z);
    return texture(this.envTarget.texture, equirectUV(normalize(d))).level(lod).rgb;
  }

  /** Sky plus local, box-projected opaque geometry when a reflection volume is configured. */
  reflectionAt(position: N, direction: N, lod: N, background?: N): N {
    const sky = background ?? this.reflection(direction, lod);
    return this.localProbe ? this.localProbe.reflection(position, direction, lod, sky) : sky;
  }

  /**
   * Sun visibility through the cloud deck at a world position: one bilinear tap of the
   * baked top-down shadow map (fades to lit beyond its ±12 km window).
   */
  cloudShadow(worldPosition: N): N {
    const st = worldPosition.xz.sub(this.uShadowCenter).div(SHADOW_MAP_EXTENT).add(0.5);
    const edge = max(abs(st.x.sub(0.5)), abs(st.y.sub(0.5)));
    return mix(texture(this.shadowTarget.texture, st).r, float(1), smoothstep(0.42, 0.5, edge));
  }

  /** A high aircraft leaves the shadow of decks below it. Ground receivers keep the cached shadow map. */
  private airborneCloudShadow(point: N): N {
    return Fn(() => {
      const low = this.cloudUniforms, upper = this.upperModel?.uniforms;
      const visibility = this.cloudShadow(point).toVar();
      If(point.y.greaterThan(low.base), () => {
        const aboveLow = smoothstep(low.base, low.top, point.y);
        const highShadow = float(1).toVar();
        if (upper) {
          If(upper.coverage.greaterThan(0).and(point.y.lessThan(upper.top)), () => {
            highShadow.assign(mix(this.analyticShadowNode(point, upper), 1, smoothstep(upper.base, upper.top, point.y)));
          });
        }
        visibility.assign(mix(visibility, highShadow, aboveLow));
      });
      return visibility;
    })();
  }

  /** March one cloud-buffer texel and blend it with reprojected history. */
  private cloudBufferNode(): N {
    return Fn(() => {
      const st = uv();
      const far = this.uCloudInvVP.mul(vec4(st.mul(2).sub(1), 0.5, 1));
      const cam = this.uCloudCam;
      const dir = normalize(far.xyz);
      const current = vec4(0, 0, 0, 1).toVar();
      const reach = float(40000).toVar(), upperFraction = float(0).toVar();
      If(dir.y.greaterThan(-0.015).or(cam.y.greaterThanEqual(this.cloudUniforms.base)), () => {
        const up = dir;
        // Neighbouring rays cover all four quarters of a step in the first
        // frame. Each 2×2 block has its own phase and cycles through time.
        const pixel = screenCoordinate.xy.floor();
        const odd = pixel.mod(2);
        const quarter = odd.x.mul(2).add(odd.y).mul(0.25);
        const tileUV = pixel.mul(0.5).floor().add(0.5).div(32);
        const offset = TSL.texture(this.rayOffsets, tileUV).level(0).r;
        const jitter = TSL.fract(offset.add(quarter).add(frame.frameIndex.mod(256).mul(0.61803398875)));
        current.assign(this.renderDecks(vec3(cam.x, max(cam.y, 2), cam.z), up, this.skyColor(up), jitter, this.cloudUniforms.steps, reach, upperFraction));
      });
      If(this.uCloudBlend.lessThan(1), () => {
        // Project the scattering centroid, so the closer cloud has the right parallax.
        const wind = mix(this.deckDrift.xy, this.deckDrift.zw, upperFraction);
        const displacement = this.cloudEyeDelta.add(vec3(wind.x, 0, wind.y));
        const previous = this.uCloudPrevVP.mul(vec4(dir.mul(reach.clamp(10, 150000)).add(displacement), 1));
        const prevUV = previous.xy.div(previous.w.max(0.001)).mul(0.5).add(0.5);
        const border = min(prevUV, prevUV.oneMinus()).div(this.uCloudTexel);
        const valid = smoothstep(0.5, 4.5, min(border.x, border.y)).mul(smoothstep(0.01, 1, previous.w));
        const inset = this.uCloudTexel.mul(0.5);
        const history = this.cloudHistory.sample(prevUV.clamp(inset, inset.oneMinus())).level(0);
        // A single sparse march can miss a whole filament. A large opacity difference
        // alone is poor evidence of a newly visible surface in a stationary sky.
        const parallax = length(displacement).div(reach.max(10));
        const changed = smoothstep(0.22, 0.65, abs(history.a.sub(current.a)));
        const disoccluded = changed.mul(smoothstep(0.001, 0.025, parallax));
        const weight = mix(this.uCloudBlend, float(1), disoccluded);
        const reuse = mix(float(1), weight, valid);
        const blended = mix(history, current, reuse);
        // Saturated coarse samples can hide a different thickness at each jitter
        // phase. Average half-path transmission, then traverse both halves.
        const transmission = mix(sqrt(history.a), sqrt(current.a), reuse).pow2();
        const opacity = blended.a.oneMinus();
        const radianceScale = transmission.oneMinus().div(opacity.max(0.0001));
        current.assign(vec4(blended.rgb.mul(radianceScale), transmission));
      });
      return current;
    })();
  }

  /** Reconstruct a cloud texel after a cut. Once enough temporal samples exist
   * the dome and immersion effect return to one filtered texture fetch. */
  private visibleCloud(direction: N, clip = this.uCloudVP.mul(vec4(direction, 0))): N {
    const st = clip.xy.div(clip.w).mul(0.5).add(0.5);
    return Fn(() => {
      const cloud = vec4(0).toVar();
      If(this.cloudFilterRadius.greaterThan(0), () => {
        const d = this.uCloudTexel.mul(this.cloudFilterRadius);
        const other = vec2(d.x, d.y.negate());
        const sample = (offset: N) => this.cloudCurrent.sample(st.add(offset)).level(0);
        cloud.assign(sample(d).add(sample(d.negate())).add(sample(other)).add(sample(other.negate())).mul(0.25));
      }).Else(() => { cloud.assign(this.cloudCurrent.sample(st).level(0)); });
      return cloud;
    })();
  }

  private fogFactor(worldPosition: N): N {
    const dist = length(worldPosition.sub(cameraPosition));
    // Height falloff keeps high-flying aircraft crisp while the surface layer hazes out.
    const heightTerm = exp(max(worldPosition.y, 0).div(-2400));
    return float(1).sub(exp(dist.mul(this.uFogDensity).mul(heightTerm).negate()));
  }

  private fogColor(worldPosition: N): N {
    const view = normalize(worldPosition.sub(cameraPosition));
    const flat = normalize(vec3(view.x, max(view.y, 0.0).mul(0.35).add(0.035), view.z));
    return this.skyColor(flat);
  }

  /** Aerial perspective for custom-lit materials, with optional 0–1 convergence to distant airlight. */
  aerial(color: N, worldPosition: N, farFade?: N): N {
    const fog = this.fogFactor(worldPosition);
    return mix(color, this.fogColor(worldPosition), farFade ? mix(fog, float(1), farFade) : fog);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Forward-scattered sunlight around the disc, shared with the reflection probe. */
  private solarAureole(dir: N): N {
    const mu = max(dot(dir, frame.sunDirection), 0);
    const haze = smoothstep(1.8, 7.5, this.atmoUniforms.turbidity);
    const core = pow(mu, mix(1750, 680, haze)).mul(mix(1.3, 1.7, haze));
    const veil = pow(mu, mix(140, 38, haze)).mul(mix(0.045, 0.24, haze));
    return this.eyeSunlight.mul(this.discFraction).mul(core.add(veil));
  }

  private lunarDisc(dir: N, environment: boolean): N {
    const angle = length(dir.sub(this.uMoonDirection));
    // Prefilter the small source into the environment texels, retaining disc energy.
    const radius = environment ? 0.012 : 0.0045;
    const edge = environment ? float(0.007) : max(TSL.fwidth(angle).mul(0.5), 0.0001);
    const disc = smoothstep(float(radius).add(edge), float(radius).sub(edge), angle).mul(environment ? 1.13 : 8);
    const halo = exp(angle.mul(-30)).mul(0.038);
    const tint = vec3(0.83, 0.90, 1);
    // A subpixel disc in the lighting environment carries its integrated visible
    // fraction. Resolve the terminator only on the visible sky.
    if (environment) return tint.mul(this.uMoon).mul(disc.add(halo));
    const local = dir.sub(this.uMoonDirection).div(radius);
    const face = sqrt(float(1).sub(dot(local, local)).max(0));
    const phase = this.uMoonPhaseLight;
    const light = dot(local, phase.xyz).add(face.mul(phase.w));
    const edgeWidth = TSL.fwidth(light).clamp(0.001, 0.5);
    const lit = phase.w.greaterThan(0.9999).select(float(1),
      phase.w.lessThan(-0.9999).select(float(0), smoothstep(edgeWidth.negate(), edgeWidth, light)));
    return tint.mul(disc.mul(lit).mul(this.uMoonDisc).add(halo.mul(this.uMoon)));
  }

  private litCloud(dir:N,cloud:N):N {
    if(!this.skyGlow)return cloud.rgb;
    const opt=this.skyGlow, alt=this.cloudUniforms.base;
    const dist=alt.sub(this.cloudEye.y).max(0).div(dir.y.max(.06)).min(opt.radius*5);
    const intercept=this.cloudEye.xz.add(dir.xz.mul(dist));
    const falloff=intercept.sub(vec2(opt.center.x,opt.center.y)).length().div(Math.max(1,opt.radius)).pow2().add(1).reciprocal();
    const night=smoothstep(.04,-.13,frame.sunDirection.y);
    return cloud.rgb.add(TSL.color(opt.color).mul(opt.intensity).mul(cloud.a.oneMinus()).mul(falloff).mul(night).mul(smoothstep(-.06,.06,dir.y)));
  }
  private environmentNode(): N {
    return Fn(() => {
      const st = uv();
      const az = st.x.sub(0.5).mul(Math.PI * 2);
      const el = st.y.sub(0.5).mul(Math.PI);
      const dir = vec3(cos(el).mul(cos(az)), sin(el), cos(el).mul(sin(az)));
      const up = normalize(vec3(dir.x, max(dir.y, 0.002), dir.z));
      const sky = this.skyColor(up);
      // This runs on an orthographic quad. Reflections and the aerial view
      // must see the same moving cloud bank, including its lower hemisphere.
      const cam = vec3(this.cloudEye.x, max(this.cloudEye.y, 2), this.cloudEye.z);
      const ground = this.uGround.mul(frame.sunColor.mul(frame.sunVisibility).mul(0.12).add(frame.skyZenith));
      const background = mix(sky, ground, smoothstep(0.0, -0.18, dir.y));
      const cloud = vec4(0, 0, 0, 1).toVar();
      If(this.uAnalyticClouds.greaterThan(0.5), () => {
        cloud.assign(this.analyticCloudNode(cam, dir, background));
      }).Else(() => {
        // The map and the view share an eye. Reuse the settled cloud integral
        // wherever its angular footprint covers the reflected direction.
        // The rest of the sphere still has its independent march.
        const clip = this.uCloudVP.mul(vec4(dir, 0));
        const edge = TSL.abs(clip.xy.div(clip.w.max(0.0001)));
        const visible = smoothstep(0.77, 0.97, max(edge.x, edge.y)).oneMinus().mul(clip.w.greaterThan(0));
        If(visible.lessThan(1), () => {
          cloud.assign(this.renderDecks(cam, dir, background, float(0.5), this.cloudUniforms.envSteps));
        });
        If(visible.greaterThan(0), () => { cloud.assign(mix(cloud, this.visibleCloud(dir, clip), visible)); });
      });
      if (this.artDirected) cloud.assign(this.cloudAppearance(cloud));
      return vec4(background.add(this.solarAureole(dir)).add(this.lunarDisc(dir, true)).mul(cloud.a).add(this.litCloud(dir,cloud)), 1);
    })();
  }

  private createDome(): THREE.Mesh {
    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.BackSide;
    material.depthWrite = false;
    material.fog = false;
    material.colorNode = Fn(() => {
      const dir = normalize(positionWorldDirection);
      const up = normalize(vec3(dir.x, max(dir.y, 0.0015), dir.z));
      const sky = this.skyColor(up).toVar();
      const cloud = vec4(0, 0, 0, 1).toVar();
      If(this.uAnalyticClouds.greaterThan(0.5), () => {
        // Low tier: true single-pass analytic cloud dome (zero off-screen cloud march).
        cloud.assign(this.analyticCloudNode(vec3(cameraPosition.x, max(cameraPosition.y, 2), cameraPosition.z), dir, sky));
      }).Else(() => {
        // Volumetric tiers: sample the temporally accumulated half-resolution cloud buffer
        // by view direction (independent of TRAA jitter and camera shake).
        cloud.assign(this.visibleCloud(dir));
      });
      if (this.artDirected) cloud.assign(this.cloudAppearance(cloud));
      // Sun disc with limb darkening; hidden by cloud optical depth.
      const radius = 0.00465; // Half the apparent solar diameter, in radians.
      const angle = length(dir.sub(frame.sunDirection));
      const fringe = max(TSL.fwidth(angle).mul(0.5), 1e-5);
      const disc = smoothstep(fringe.add(radius), float(radius).sub(fringe), angle);
      const rho = angle.div(radius).min(1);
      const limb = sqrt(float(1).sub(rho.mul(rho))).mul(0.52).add(0.48);
      const horizonAA = max(TSL.fwidth(dir.y).mul(0.5), 1e-6);
      const aboveLimb = smoothstep(this.horizonSine.sub(horizonAA), this.horizonSine.add(horizonAA), dir.y);
      const sunRadiance = this.eyeSunlight.mul(disc).mul(limb).mul(180).mul(aboveLimb);
      // Glare halo that survives thin cloud.
      const glare = this.solarAureole(dir);
      const haze = this.skyColor(normalize(vec3(dir.x, 0.035, dir.z)));
      // From an aircraft the downward sky behind the cloud deck represents
      // distant ground through air. Join the surface shader at the planetary limb.
      const belowPlanet = smoothstep(this.horizonSine.sub(0.025), this.horizonSine, dir.y).oneMinus();
      const background = mix(sky.add(glare).add(this.lunarDisc(dir, false)), haze, belowPlanet);
      const col = background.add(sunRadiance).mul(cloud.a).add(this.litCloud(dir,cloud));
      // Horizon haze: the base of the sky sinks into exactly the haze colour that distant
      // surfaces fade to (`aerial`), by the fog factor reached at the geometric horizon, so
      // sea and sky meet in one continuous tone instead of two unrelated ones.
      const band = exp(max(dir.y, 0).div(-0.05)).mul(this.uHorizonFog);
      const below = smoothstep(0.0, -0.035, dir.y);
      const surfaceView=float(1).sub(smoothstep(this.cloudUniforms.base.sub(90),this.cloudUniforms.base,cameraPosition.y));
      return mix(mix(col, haze, band.mul(surfaceView)), haze, below.mul(surfaceView));
    })();
    material.mrtNode = auxSurface(vec3(0, 0, 1), screenVelocity(positionWorld, positionWorld));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.name = 'lumina-sky-dome';
    return dome;
  }

  /** Call before the first draw following a host-controlled camera or weather cut. */
  resetCloudHistory(): void { this.cloudValid = false; }

  /** Blend all parameters toward a preset. */
  morph(to: Partial<WeatherParams>, t: number): void {
    const p = this.params as any;
    for (const [k, v] of Object.entries(to)) if (typeof v === 'number') p[k] += (v - p[k]) * t;
  }

  private opaqueViewDepth(raw: N): N {
    return perspectiveDepthToViewZ(raw, this.uNearFar.x, this.uNearFar.y).negate();
  }

  /** Composite just the cloud between the eye and an opaque fragment. Sky pixels
   * already contain the complete cloud integral. Far terrain inherits that same
   * scattering; nearby airframes retain contrast in the swept clear channel. */
  private registerCloudImmersion(): void {
    const u=this.cloudUniforms;
    this.engine.pipeline.addEffect({
      id:'weather.cloud-immersion', order:4,
      scene:({color,depth,ndc,uv:st})=>Fn(()=>{
        const result=color.toVar();
        const eye=this.cloudEye;
        let inside = eye.y.greaterThanEqual(u.base).and(eye.y.lessThanEqual(u.top));
        if (this.upperModel) {
          const hi = this.upperModel.uniforms;
          inside = inside.or(hi.coverage.greaterThan(0).and(eye.y.greaterThanEqual(hi.base)).and(eye.y.lessThanEqual(hi.top)));
        }
        const above = eye.y.greaterThan(u.top);
        If(inside.or(above), () => {
          const raw = depth.sample(st).r;
          If(raw.lessThan(0.999999), () => {
            const v = this.inverseProjection.mul(vec4(ndc, 0.5, 1));
            const view = normalize(v.xyz.div(v.w));
            const dir = normalize(this.eyeToWorld.mul(vec4(view, 0)).xyz);
            const reach = this.opaqueViewDepth(raw).div(max(view.z.negate(), 0.001));
            // Altitude at the closest approach to Earth before the opaque hit.
            // An airframe in front of the deck has zero intervening cloud column.
            const curve = dir.y.pow2().oneMinus().mul(1 / (2 * ATMOSPHERE.planetRadius));
            const closest = dir.y.negate().div(curve.mul(2).max(1e-9)).clamp(0, reach);
            const minAltitude = eye.y.add(closest.mul(dir.y.add(curve.mul(closest))));
            const column = (layer: CloudUniforms) => {
              const weight = layer.coverage.mul(layer.density).mul(eye.y.greaterThan(layer.top).select(1, 0));
              const crossed = layer.top.sub(max(minAltitude, layer.base)).max(0);
              return vec2(crossed, layer.top.sub(layer.base)).mul(weight);
            };
            let columns = column(u);
            if (this.upperModel) columns = columns.add(column(this.upperModel.uniforms));
            const fraction = columns.x.div(columns.y.max(0.0001)).clamp(0, 1);
            If(inside.or(fraction.greaterThan(0)), () => {
              const cloud = vec4(0, 0, 0, 1).toVar();
              If(this.uAnalyticClouds.greaterThan(0.5), () => {
                cloud.assign(this.analyticCloudNode(eye, dir, this.skyColor(dir)));
              }).Else(() => {
                cloud.assign(this.visibleCloud(dir));
              });
              const opacity = cloud.a.oneMinus();
              const source = cloud.rgb.div(max(opacity, 0.003));
              If(inside, () => {
                const path = min(reach, 190);
                const clear = this.engine.world.cloudNode(eye.add(dir.mul(path.mul(0.25))))
                  .add(this.engine.world.cloudNode(eye.add(dir.mul(path.mul(0.75))))).mul(0.5);
                const optical = path.mul(this.localCloudDensity).mul(0.024).mul(clear.oneMinus());
                const nearby = min(exp(optical.negate()).oneMinus(), opacity);
                const covered = mix(nearby, opacity, smoothstep(70, 350, reach));
                // A foreground surface receives inscattering only from the air in front of it.
                // The distant sunlit crown is a poor light estimate for droplets in a shaded wake.
                const sunT = this.upperModel ? this.mistSunTransmission.mul(
                  mix(1, this.analyticShadowNode(eye, this.upperModel.uniforms),
                    eye.y.lessThan(this.upperModel.uniforms.base).and(this.upperModel.uniforms.coverage.greaterThan(0)).select(1, 0))) : this.mistSunTransmission;
                const mu = dot(dir, frame.sunDirection);
                const phase = float(0.64).div(pow(float(1.36).sub(mu.mul(1.2)).max(0.16), 1.5));
                const diffuse = mix(frame.skyZenith, frame.skyHorizon, 0.28).mul(sunT.mul(0.38).add(0.44));
                const direct = sunlightAtHeight(eye.y).mul(sunT).mul(phase.mul(0.16).add(0.05));
                const localLight = diffuse.add(direct.mul(mix(0.65, 1, clear)));
                // Fade to the full ray integral before distant terrain meets the cloud horizon.
                const nearWeight = nearby.mul(smoothstep(65, 250, reach).oneMinus());
                result.assign(color.mul(covered.oneMinus()).add(localLight.mul(nearWeight)).add(source.mul(covered.sub(nearWeight))));
              }).Else(() => {
                const covered = pow(cloud.a.max(0.00001), fraction).oneMinus();
                result.assign(mix(color, source, covered));
              });
            });
          });
        });
        return result;
      })(),
    });
  }

  private registerShafts(steps: number): void {
    if (steps === this.shaftSteps) return;
    this.shaftSteps = steps;
    const pipeline = this.engine.pipeline;
    if (steps < 1) { pipeline.removeEffect('weather.shafts'); return; }
    pipeline.addEffect({
      id: 'weather.shafts',
      order: 10,
      scene: ({ color, depth, uv: st, toNdc, toUv }) => Fn(() => {
        const out = vec3(color).toVar();
        const toSun = toUv(this.uSunUV).sub(st);
        const distance = length(toSun.mul(vec2(this.uAspect, 1)));
        If(this.uShaftStrength.greaterThan(0.002).and(distance.lessThan(1.3)), () => {
          const jitter = temporalIGN(screenCoordinate.xy, frame.frameIndex);
          const stride = toSun.mul(0.94 / steps);
          const lit = float(0).toVar();
          let weight = 1, total = 0;
          for (let i = 0; i < steps; i++) {
            const p = st.add(stride.mul(jitter.add(i))).clamp(0.001, 0.999);
            const open = depth.sample(p).r.greaterThanEqual(0.9999995).select(float(1), float(0));
            // The cloud buffer shares the camera with a 12 % overscan: a pure NDC rescale.
            const cloudUV = toNdc(p).div(CLOUD_OVERSCAN).mul(0.5).add(0.5);
            const through = this.cloudCurrent.sample(cloudUV).a;
            lit.addAssign(open.mul(through.mul(through)).mul(weight));
            total += weight; weight *= 0.95;
          }
          // Forward-scattering glow: tight around the sun, fading across the frame.
          const glow = exp(distance.mul(-2.6)).mul(smoothstep(1.3, 0.9, distance));
          // In-scattered light builds up with the length of air in front of a surface, so
          // near objects keep their contrast and read as silhouettes against the glow.
          const viewZ = this.opaqueViewDepth(depth.sample(st).r);
          const air = float(1).sub(exp(viewZ.div(-260))).mul(0.94).add(0.06);
          out.addAssign(this.eyeSunlight.mul(lit.mul(glow).mul(air).mul(this.uShaftStrength).div(total)));
        });
        return out;
      })(),
    });
  }

  setQuality(preset: QualityPreset): void {
    this.desiredShaftSteps = preset.clouds.shaftSteps;
    this.registerShafts(this.externalShafts ? 0 : preset.clouds.shaftSteps);
    this.analyticMode = Boolean(preset.clouds.analytic || preset.clouds.steps <= 0);
    this.uAnalyticClouds.value = this.analyticMode ? 1 : 0;
    this.sparse = preset.tier === 'low' || this.analyticMode;
    const u = this.cloudUniforms;
    u.steps.value = preset.clouds.steps;
    this.cloudScale = preset.clouds.scale;
    u.lightSteps.value = preset.clouds.lightSteps;
    u.envSteps.value = preset.clouds.envSteps;
    if (this.analyticMode) this.cloudValid = false;
    if (this.envTarget.width !== preset.clouds.envSize) {
      this.envTarget.setSize(preset.clouds.envSize, preset.clouds.envSize / 2);
      this.pmremAge = 1e9;
      this.reflectionAge = Infinity;
    }
    const s = this.sun.shadow;
    this.sun.castShadow = preset.shadows.enabled;
    if (s.mapSize.x !== preset.shadows.mapSize) {
      s.mapSize.set(preset.shadows.mapSize, preset.shadows.mapSize);
      s.map?.dispose();
      (s as any).map = null;
    }
    s.radius = preset.shadows.radius * 1.6;
    (s as any).blurSamples = 16;
  }

  /** Direct sunlight at a custom-shaded surface. The small caster map follows the
   * focus; far water only needs the existing large-scale cloud shadow. */
  surfaceSunlight(world: N, castShadows: boolean): N {
    const clouds = this.cloudShadow(world);
    if (!castShadows) return clouds;
    return Fn(() => {
      const amount = float(clouds).toVar();
      const delta = world.sub(this.localShadowCenter);
      If(TSL.dot(delta, delta).lessThan(this.localShadowRadiusSq), () => { amount.mulAssign(this.terrainShadow.r); });
      return amount;
    })();
  }

  /** Unit vector toward the sun for the current params. */
  getSunDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const el = THREE.MathUtils.degToRad(this.params.sunElevation);
    const az = THREE.MathUtils.degToRad(this.params.sunAzimuth);
    return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  }

  /** Reintegrate sky radiance only when its physical inputs change. */
  private updateLighting(): boolean {
    // Each control is read once per frame. Turbidity, coverage and storm are compared with the
    // uniforms that already carry the value the sky was last lit for, rather than with a second
    // private copy: a uniform hands back the number it holds, where reading a numeric field of
    // this object boxes a new one until this code is optimised.
    const p = this.params, atmo = this.atmoUniforms, u = this.cloudUniforms;
    const sunElevation = p.sunElevation, sunAzimuth = p.sunAzimuth, turbidity = p.turbidity;
    const coverage = p.coverage, storm = p.storm;
    const moved = this.sunElevation !== sunElevation || this.sunAzimuth !== sunAzimuth || atmo.turbidity.value !== turbidity;
    if (moved) {
      if (Math.abs(this.sunElevation - sunElevation) > 2 ||
          Math.abs(THREE.MathUtils.euclideanModulo(sunAzimuth - this.sunAzimuth + 180, 360) - 180) > 10 ||
          Math.abs(atmo.turbidity.value - turbidity) > 1) this.cloudValid = false;
      this.sunElevation = sunElevation;
      this.sunAzimuth = sunAzimuth;
      const sunDir = this.getSunDirection(this.sunDirection);
      sunTransmittanceCPU(sunDir, turbidity, this.cachedSun);
      sunTransmittanceCPU(sunDir, turbidity, this.flightSun[0], 2000);
      sunTransmittanceCPU(sunDir, turbidity, this.flightSun[1], 6000);
      sunTransmittanceCPU(sunDir, turbidity, this.flightSun[2], 12000);
      // At twilight a cloud can see part of the solar disc above the curved horizon.
      const depression = -THREE.MathUtils.degToRad(sunElevation);
      const limbHeight = (angle: number) => angle <= 0 ? -1 :
        ATMOSPHERE.planetRadius * (1 / Math.cos(Math.min(angle, 1.56)) - 1);
      const lower = limbHeight(depression - 0.00465);
      this.solarLimbHeights.set(lower, Math.max(lower + 0.01, limbHeight(depression + 0.00465)));
      skyRadianceCPU(_dir.set(0.05, 1, 0.05).normalize(), sunDir, turbidity, this.cachedZenith);
      skyRadianceCPU(_dir.set(-sunDir.x, 0.12, -sunDir.z).normalize(), sunDir, turbidity, this.cachedHorizon);
      atmo.sunElevation.value = Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1));
      atmo.turbidity.value = turbidity;
    }
    // `u.storm` is brought up to date later in the frame, after the lens probe has sampled the
    // cloud model with the previous value, so here it still holds the storm the sky was lit for.
    const night = 1 - THREE.MathUtils.smoothstep(this.sunDirection.y, -0.17, -0.045);
    const alignment = THREE.MathUtils.clamp(this.sunDirection.dot(this.moonDirection), -1, 1);
    const fraction = p.moonIllumination === 'fromDirections' ? (1 - alignment) * 0.5
      : THREE.MathUtils.clamp(p.moonIllumination ?? 1, 0, 1);
    const disc = night * THREE.MathUtils.clamp(p.moonlight ?? 1, 0, 1)
      * THREE.MathUtils.smoothstep(this.moonDirection.y, -0.01, 0.08) * (1 - 0.85 * storm);
    const moon = disc * fraction, phase = 2 * fraction - 1;
    const moonChanged = moon !== this.uMoon.value || disc !== this.uMoonDisc.value ||
      phase !== this.uMoonPhaseLight.value.w || !this.uMoonDirection.value.equals(this.moonDirection);
    if (moonChanged || moved) {
      this.uMoon.value = moon;
      this.uMoonDisc.value = disc;
      this.uMoonDirection.value.copy(this.moonDirection);
      const along = _dir.copy(this.sunDirection).addScaledVector(this.moonDirection, -alignment);
      if (along.lengthSq() < 1e-10) {
        along.set(Math.abs(this.moonDirection.y) < 0.9 ? 0 : 1, Math.abs(this.moonDirection.y) < 0.9 ? 1 : 0, 0);
        along.addScaledVector(this.moonDirection, -along.dot(this.moonDirection));
      }
      along.normalize().multiplyScalar(Math.sqrt(Math.max(0, 1 - phase * phase)));
      this.uMoonPhaseLight.value.set(along.x, along.y, along.z, phase);
      if (moonChanged) this.lightingVersion++;
    }
    this.skyChanged = moonChanged || moved || coverage !== u.coverage.value || storm !== u.storm.value;
    if (u.coverage.value !== coverage) u.coverage.value = coverage;
    if (this.skyChanged) {
      // Quantize only when an input changes. Separate channels keep simultaneous
      // changes in azimuth and cloud cover from cancelling each other.
      const signature = this.reflectedSky;
      const elevation = Math.round(sunElevation * 10), azimuth = Math.round(sunAzimuth);
      const cover = Math.round(coverage * 100), stormStep = Math.round(storm * 100), turbidityStep = Math.round(turbidity * 10);
      if (signature[0] !== elevation || signature[1] !== azimuth || signature[2] !== cover ||
          signature[3] !== stormStep || signature[4] !== turbidityStep) {
        signature[0] = elevation; signature[1] = azimuth; signature[2] = cover;
        signature[3] = stormStep; signature[4] = turbidityStep;
        this.lightingVersion++;
      }
      const overcast = THREE.MathUtils.smoothstep(coverage, 0.62, 0.98);
      const sun = this.surfaceSun.copy(this.cachedSun).multiplyScalar(1 - 0.55 * overcast * storm);
      this.sunVisibility = 1 - 0.94 * THREE.MathUtils.smoothstep(coverage, 0.5, 0.95);
      const grey = (sun.r + sun.g + sun.b) / 3 * (0.1 - 0.055 * storm) + 0.012;
      const haze = _c1.setRGB(grey * 0.92, grey * 0.97, grey * 1.05);
      this.surfaceZenith.copy(this.cachedZenith).lerp(haze, overcast * 0.9);
      this.surfaceHorizon.copy(this.cachedHorizon).lerp(haze, overcast * 0.9);
      this.surfaceHorizon.r += 0.007 * moon; this.surfaceHorizon.g += 0.012 * moon; this.surfaceHorizon.b += 0.024 * moon;
      this.surfaceZenith.r += 0.007 * moon; this.surfaceZenith.g += 0.012 * moon; this.surfaceZenith.b += 0.024 * moon;
      this.uOvercast.value = overcast;
    }
    return moved;
  }

  /** Direct light reaches an elevated eye after sunset at sea level. Clip the
   * disc by the geometric horizon. Lens scatter uses its visible circular area. */
  private updateEyeSunlight(height: number, skyMoved: boolean): void {
    const h = Math.max(0, height);
    if (!skyMoved && Math.abs(h - this.lastSolarEyeHeight) < Math.max(0.05, h * 0.0002)) return;
    this.lastSolarEyeHeight = h;
    const radius = ATMOSPHERE.planetRadius;
    const horizon = -Math.sqrt(h * (2 * radius + h)) / (radius + h);
    this.horizonSine.value = horizon;
    const offset = (THREE.MathUtils.degToRad(this.sunElevation) - Math.asin(horizon)) / 0.00465;
    const fraction = offset <= -1 ? 0 : offset >= 1 ? 1 :
      (Math.acos(-offset) + offset * Math.sqrt(1 - offset * offset)) / Math.PI;
    this.discFraction.value = fraction;
    if (fraction === 0) this.eyeSunlight.value.setRGB(0, 0, 0);
    else {
      // During partial sunset the center ray can hit the planet while the upper limb is lit.
      _dir.copy(this.sunDirection);
      _dir.y = Math.max(_dir.y, horizon + 1e-7);
      sunTransmittanceCPU(_dir, this.params.turbidity, this.eyeSunlight.value, h);
    }
  }

  /** Add short-lived lightning scatter after the ordinary sky has been evaluated. */
  scatterFlash(light: THREE.Color): void {
    this.skyFlashed = true;
    frame.skyZenith.value.add(light);
    frame.skyHorizon.value.add(light);
  }

  update(dt: number): void {
    if (this.skyTransition.length) {
      this.transitionElapsed = Math.min(this.transitionElapsed + dt, this.transitionDuration);
      const s = THREE.MathUtils.smoothstep(this.transitionElapsed, 0, this.transitionDuration);
      for (const change of this.skyTransition)
        (this.params as unknown as Record<string,number>)[change.key] = change.from + (change.to-change.from)*s;
      if (this.transitionElapsed >= this.transitionDuration) this.skyTransition.length = 0;
    }
    const p = this.params;
    const { renderer, camera, wind } = this.engine;
    const u = this.cloudUniforms;
    const frequency = 1 / Math.max(0.05, p.cloudScale ?? 1);
    const convection = THREE.MathUtils.clamp(p.convection ?? 0, -1, 1);
    const erosion = THREE.MathUtils.clamp(p.cloudErosion ?? DEFAULT_CLOUD_EROSION, 0, 1);
    if (this.cloudValid && cloudLayerCut(u, p.cloudBase, p.cloudTop, p.coverage, p.cloudDensity, frequency, convection, p.storm, erosion))
      this.cloudValid = false;
    const stale = this.updateLighting();
    const sunDir = this.sunDirection;
    if (this.skyChanged || this.skyFlashed || frameWeather !== this) {
      frame.skyZenith.value.copy(this.surfaceZenith);
      frame.skyHorizon.value.copy(this.surfaceHorizon);
      this.skyFlashed = false;
    }
    if(this.skyChanged || frameWeather!==this){
      frame.sunDirection.value.copy(sunDir);
      frame.sunColor.value.copy(this.surfaceSun);
      const overcast = THREE.MathUtils.smoothstep(p.coverage, 0.62, 0.98);
      for (let i = 0; i < this.flightSun.length; i++)
        frame.elevatedSun[i].value.copy(this.flightSun[i]).multiplyScalar(1 - 0.55 * overcast * p.storm);
      frame.sunShadowHeights.value.copy(this.solarLimbHeights);
      frame.sunVisibility.value=this.sunVisibility;
      frameWeather=this;
    }
    const eyeY=camera.position.y, altitude=Math.max(eyeY,2);
    this.updateEyeSunlight(eyeY, stale);
    if(this.distribution&&(stale||Math.abs(altitude-this.skyHeight)>Math.max(48,altitude*.025))){
      this.skyHeight=altitude;
      skyRadianceCPU(_dir.set(.05,1,.05).normalize(),sunDir,p.turbidity,this.eyeZenith.value,altitude);
      skyRadianceCPU(_dir.set(-sunDir.x,.12,-sunDir.z).normalize(),sunDir,p.turbidity,this.eyeHorizon.value,altitude);
    }
    // Number uniforms hold tagged values: storing an unchanged number would box it again.
    if(this.atmoUniforms.cameraAltitude.value!==altitude)this.atmoUniforms.cameraAltitude.value=altitude;
    if(u.density.value!==p.cloudDensity)u.density.value=p.cloudDensity;
    // The layer bounds go to the world, the cloud uniforms and both immersion tests from one read.
    const cloudBase=p.cloudBase, cloudTop=p.cloudTop, world=this.engine.world;
    world.rainfall = p.rain;
    world.cloudBase = p.coverage > 0 && p.cloudDensity > 0 ? cloudBase : Infinity;
    world.cloudTop = world.cloudBase < Infinity ? cloudTop : -Infinity;
    if (this.upperModel) this.updateUpperDeck(dt);
    if (u.frequency.value !== frequency || u.convection.value !== convection || u.erosion.value !== erosion) {
      u.erosion.value = erosion;
      u.frequency.value = frequency; u.convection.value = convection;
      this.reflectionAge = Infinity; this.lightingVersion++;
    }
    if (u.storm.value !== p.storm) u.storm.value = p.storm;
    if(u.base.value!==cloudBase)u.base.value = cloudBase;
    if(u.top.value!==cloudTop)u.top.value = cloudTop;
    const insideLayer = world.inCloudLayer(eyeY);
    if (insideLayer) {
      this.lensProbeTime-=dt;
      if(this.lensProbeTime<=0){
        this.lensProbeTime=0.12;
        this.cloudMoisture=this.sampleCloudDensity(camera.position);
        // Four camera-local density probes share the lens cadence. Integrate toward the sun
        // through the nearby bank so a shaded fragment does not inherit a distant silver lining.
        let previous = 0, column = 0;
        for (let end = 12; end <= 324; end *= 3) {
          this.mistProbe.copy(camera.position).addScaledVector(this.sunDirection, (previous + end) * 0.5);
          column += this.sampleCloudDensity(this.mistProbe) * (end - previous);
          previous = end;
        }
        this.mistSunTransmission.value = Math.exp(-0.024 * column);
        // Newly encountered condensate beads the lens. Air in a recently
        // cleared core carries only the residual entrained mist.
        const local=this.engine.world.disturbance(camera.position,this.eyeFields);
        const droplets=this.cloudMoisture*(1-0.87*local.cloudCut);
        if(droplets>0.015)this.engine.lens.splash(Math.min(0.30,droplets*0.9));
      }
    } else {this.lensProbeTime=0;this.cloudMoisture=0;}

    const moisture=this.cloudMoisture;
    if(this.localCloudDensity.value!==moisture)this.localCloudDensity.value=moisture;
    if (insideLayer || eyeY > cloudTop) {
      this.eyeToWorld.value.copy(camera.matrixWorld);
      this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    }
    // Clouds drift with the wind aloft (faster than the surface wind).
    const drift = (wind.speed * 2.2 + 4) * dt;
    (u.offset.value as THREE.Vector3).x -= wind.direction.x * drift;
    (u.offset.value as THREE.Vector3).z -= wind.direction.y * drift;

    // The optical depth to a marine horizon changes slowly at camera scale.
    // Track quarter-metre height intervals while updating visibility edits immediately.
    if(this.fogVisibility!==p.visibility || Math.abs(altitude-this.fogAltitude)>0.25){
      this.fogVisibility=p.visibility;this.fogAltitude=altitude;
      u.visibility.value=p.visibility*1.6;
      const density=3.2/Math.max(p.visibility,500);
      this.uFogDensity.value=density;
      const horizon=Math.min(3570*Math.sqrt(altitude),45000);
      this.uHorizonFog.value=1-Math.exp(-horizon*density*Math.exp(-Math.max(camera.position.y,0)/2400));
    }

    // The cloud immersion pass reads the scene camera's depth, even when SunFx
    // owns light shafts. The post-processing quad has a separate camera.
    const clip = this.uNearFar.value, near = camera.near, far = camera.far;
    if (clip.x !== near || clip.y !== far) clip.set(near, far);
    if (!this.externalShafts) {
      // Light shafts: where the sun sits on screen and how strongly the air scatters toward the eye.
      camera.getWorldDirection(_dir);
      const facing = THREE.MathUtils.smoothstep(_dir.dot(sunDir), -0.05, 0.3);
      _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const e = _proj.elements;
      const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
      const sunW = e[3] * sx + e[7] * sy + e[11] * sz;
      if (sunW > 1e-3) (this.uSunUV.value as THREE.Vector2).set((e[0] * sx + e[4] * sy + e[8] * sz) / sunW, (e[1] * sx + e[5] * sy + e[9] * sz) / sunW);
      // Hazier air scatters more of the beam toward the eye.
      const haziness = THREE.MathUtils.clamp(0.35 + p.turbidity * 0.08, 0.35, 1.2);
      this.uShaftStrength.value = sunW > 1e-3 ? (p.shafts ?? 0.5) * facing * this.solarDiscVisibility * haziness * 0.12 : 0;
      this.uAspect.value = camera.aspect;
    }
    this.uGround.value.copy(this.groundColor);
    if (this.autoExposure) {
      const eye = this.engine.camera.position;
      const openness = this.engine.world.shelters.exposureAt(eye.x, eye.y, eye.z, 0, 1, 0);
      const skyLight = Math.max(0, this.sunDirection.y) * (1 - p.storm * 0.72);
      const target = p.exposure * (1 + (1 - openness) * 0.38) / (0.86 + 0.22 * skyLight);
      if (!Number.isFinite(this.adaptedExposure)) this.adaptedExposure = target;
      const response = target < this.adaptedExposure ? this.exposureResponse.darkenSceneSeconds : this.exposureResponse.brightenSceneSeconds;
      const seconds = Math.max(0.001, response);
      this.adaptedExposure += (target - this.adaptedExposure) * -Math.expm1(-dt / seconds);
      this.engine.pipeline.exposure = this.adaptedExposure;
    } else { this.engine.pipeline.exposure = p.exposure; this.adaptedExposure = NaN; }

    // Sun light + shadow frustum follow the focus point.
    const moonDominates = this.uMoon.value > 0 && this.shadowFocus.y <= this.solarLimbHeights.y;
    this.sun.position.copy(this.shadowFocus).addScaledVector(moonDominates ? this.moonDirection : sunDir, 140);
    this.sun.target.position.copy(this.shadowFocus);
    const cam = this.sun.shadow.camera;
    if (cam.right !== this.shadowExtent) {
      this.localShadowRadiusSq.value = this.shadowExtent * this.shadowExtent * 3;
      cam.left = -this.shadowExtent; cam.right = this.shadowExtent; cam.top = this.shadowExtent; cam.bottom = -this.shadowExtent;
      cam.near = 1; cam.far = 320;
      cam.updateProjectionMatrix();
    }

    this.dome.position.copy(camera.position);
    const domeScale=far*0.92;
    if(this.dome.scale.x!==domeScale)this.dome.scale.setScalar(domeScale);
    this.dome.updateMatrixWorld();

    // ---- off-screen passes --------------------------------------------------
    const previousTarget = renderer.getRenderTarget();
    this.frameCounter++;
    // The sky-view LUT contains only atmospheric radiance. Wind and moving cloud
    // cover are evaluated separately, so neither invalidates the atmospheric integral.
    const sparse = this.sparse;
    const eyeHeight = altitude;
    if (stale || Math.abs(eyeHeight - this.lutAltitude) > Math.max(4, eyeHeight * 0.005)) {
      this.lutAltitude = eyeHeight;
      renderer.setRenderTarget(this.lutTarget);
      this.lutQuad.render(renderer);
    }

    // Cloud shadow map: clouds drift slowly, so a refresh every 4th frame (8th in analytic Low) is plenty.
    if (this.frameCounter % (this.analyticMode ? 8 : 4) === 1) {
      const texel = SHADOW_MAP_EXTENT / SHADOW_MAP_SIZE;
      (this.uShadowCenter.value as THREE.Vector2).set(Math.round(camera.position.x / texel) * texel, Math.round(camera.position.z / texel) * texel);
      renderer.setRenderTarget(this.shadowTarget);
      this.shadowQuad.render(renderer);
    }

    // Cloud buffer: skipped completely in analytic Low mode (true single-pass analytic cloud
    // dome, zero cloud raymarch). On volumetric tiers, reduced resolution with 12 % overscan
    // and direction-reprojected history.
    const flashingNow = (u.flashColor.value as THREE.Color).r > 0.01;
    if (!this.analyticMode && (!sparse || this.frameCounter % 2 === 0 || !this.cloudValid || flashingNow)) {
    renderer.getDrawingBufferSize(_size);
    const internal = this.engine.pipeline.baseScale * this.cloudScale;   // independent of dynamic resolution
    // The buffer size only moves with the drawing buffer or the internal scale: derive it again
    // (and resize the targets if it changed) only when one of those has.
    const bufferWidth = _size.x, bufferHeight = _size.y;
    if (bufferWidth !== this.cloudSizedWidth || bufferHeight !== this.cloudSizedHeight || internal !== this.cloudSizedScale) {
      this.cloudSizedWidth = bufferWidth; this.cloudSizedHeight = bufferHeight; this.cloudSizedScale = internal;
      const cw = Math.max(64, Math.round(bufferWidth * internal)), ch = Math.max(36, Math.round(bufferHeight * internal));
      if (this.cloudTargets[0].width !== cw || this.cloudTargets[0].height !== ch) {
        this.uCloudTexel.value.set(1 / cw, 1 / ch);
        this.cloudTargets[0].setSize(cw, ch);
        this.cloudTargets[1].setSize(cw, ch);
        this.cloudValid = false;
      }
    }
    camera.updateMatrixWorld();
    _proj.copy(camera.projectionMatrix);
    _proj.elements[0] /= CLOUD_OVERSCAN;
    _proj.elements[5] /= CLOUD_OVERSCAN;
    // A distant world origin loses low bits when two near-plane positions are
    // subtracted in a shader. Reconstruct directions with rotation only.
    _vp.copy(camera.matrixWorldInverse).setPosition(0, 0, 0).premultiply(_proj);
    // A camera cut (scene change, teleport) invalidates the history.
    camera.getWorldDirection(_dir);
    if (_dir.dot(this.lastForward) < 0.5 || camera.position.distanceToSquared(this.lastPosition) > 400 * 400) this.cloudValid = false;
    if (!this.cloudValid) this.reflectionAge = Infinity;
    this.lastForward.copy(_dir);
    this.cloudEyeDelta.value.subVectors(camera.position, this.lastPosition);
    this.lastPosition.copy(camera.position);
    const lowOffset = u.offset.value, highOffset = this.upperModel?.uniforms.offset.value ?? lowOffset;
    this.deckDrift.value.set(lowOffset.x, lowOffset.z, highOffset.x, highOffset.z).sub(this.previousDeckOffsets);
    this.previousDeckOffsets.set(lowOffset.x, lowOffset.z, highOffset.x, highOffset.z);
    (this.uCloudPrevVP.value as THREE.Matrix4).copy(this.cloudValid ? (this.uCloudVP.value as THREE.Matrix4) : _vp);
    (this.uCloudVP.value as THREE.Matrix4).copy(_vp);
    (this.uCloudInvVP.value as THREE.Matrix4).copy(_vp).invert();
    (this.uCloudCam.value as THREE.Vector3).copy(camera.position);
    this.cloudSamples = !this.cloudValid || flashingNow || this.cloudFlashed ? 1 : Math.min(10, this.cloudSamples + 1);
    this.cloudFlashed = flashingNow;
    const blend = Math.max(1 / this.cloudSamples, insideLayer ? 0.28 : 0.105);
    const radius = Math.max(0, (6 - this.cloudSamples) * 0.11);
    if (this.cloudFilterRadius.value !== radius) this.cloudFilterRadius.value = radius;
    if (this.uCloudBlend.value !== blend) this.uCloudBlend.value = blend;
    const read = this.cloudTargets[this.cloudIndex], write = this.cloudTargets[1 - this.cloudIndex];
    this.cloudHistory.value = read.texture;
    renderer.setRenderTarget(write);
    this.cloudQuad.render(renderer);
    this.cloudIndex = 1 - this.cloudIndex;
    this.cloudCurrent.value = write.texture;
    this.cloudValid = true;
    }
    const flashing = flashingNow;

    // The distant cloud reflection moves much less than one map texel per display
    // frame. The water normals and local sun glint still run at display cadence.
    // Each refresh timer is read once, advanced, tested and stored.
    const reflectionAge = this.reflectionAge + dt;
    this.reflectionAge = reflectionAge;
    if (reflectionAge >= (sparse ? 0.18 : 0.095) || stale || flashing || this.envAge === 0) {
      this.reflectionAge = 0;
      renderer.setRenderTarget(this.envTarget);
      this.envQuad.render(renderer);
      this.envAge++;
    }
    renderer.setRenderTarget(previousTarget);

    this.localProbe?.update(renderer, this.engine.scene, dt);

    // Refresh image-based lighting when the sky has meaningfully changed.
    const pmremAge = this.pmremAge + dt;
    this.pmremAge = pmremAge;
    if ((this.reflectedVersion !== this.lightingVersion && pmremAge > 0.35) || pmremAge > this.pmremInterval * 4) {
      this.reflectedVersion = this.lightingVersion;
      this.pmremAge = 0;
      (this.envTarget.texture as any).pmremVersion = ((this.envTarget.texture as any).pmremVersion ?? 0) + 1;
    }
  }

  dispose(): void {
    if(frameWeather===this) {
      frameWeather=undefined;
      this.engine.world.cloudBase = this.engine.world.upperCloudBase = Infinity;
      this.engine.world.cloudTop = this.engine.world.upperCloudTop = -Infinity;
    }
    const { scene } = this.engine;
    this.engine.pipeline.removeEffect('weather.cloud-immersion');
    this.engine.pipeline.removeEffect('weather.shafts');
    scene.remove(this.dome, this.sun, this.sun.target);
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.rayOffsets.dispose();
    this.lutTarget.dispose();
    this.cloudTargets[0].dispose();
    this.cloudTargets[1].dispose();
    this.shadowTarget.dispose();
    this.localProbe?.dispose();
    this.envTarget.dispose();
    if (scene.environment === this.envTarget.texture) scene.environment = null;
    (scene as any).fogNode = null;
  }
}

export { vec2 as _v2, ATMOSPHERE };
