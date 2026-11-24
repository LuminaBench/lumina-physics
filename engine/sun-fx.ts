/**
 * Optical sun effects, screen-space volumetric god rays, and filmic colour grading.
 *
 *   occlusion  9-tap concentric solar-disc aperture tested against BOTH the scene depth
 *              buffer (geometry, terrain, vessels, waves) and cloud transmittance (volumetric
 *              cloud buffer on Medium–Ultra, single-pass analytic cloud deck on Low).
 *              Core visibility (tight disc, cloudT²) drives crisp optics (glare, streak,
 *              ghosts); wider aperture visibility (cloudT^0.65) drives atmospheric halo.
 *   sun optics Physically layered HDR sun halo, 6-blade diffraction starburst glare,
 *              anamorphic cinema lens streak and chromatic multi-element lens ghosts — all
 *              inlined into the pipeline's post-resolve `lens` hook (zero extra render target).
 *   god rays   Temporally jittered screen-space crepuscular light shafts in the pre-resolve
 *              `scene` hook (resolved cleanly by TRAA/TAAU), occluded by scene depth and
 *              clouds, with air-column depth weighting so foreground objects stay silhouettes.
 *   grading    Four filmic colour-grading presets (`natural`, `cinematic`, `golden`, `storm`)
 *              with live timed morphing: linear HDR white balance, 3-way shadow/midtone/
 *              highlight colour balance, exposure bias, optical vignette, plus AgX display
 *              contrast / saturation / bloom threshold coordination.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';
import { frame } from './frame';
import { temporalIGN } from './noise';
import type { LuminaEngine, EngineModule } from './engine';
import type { QualityPreset } from './quality';
export interface SunWeather {
  readonly params: { shafts?: number; turbidity: number };
  /** Optional camera-altitude sunlight and fraction above the planetary horizon. */
  readonly eyeSunlight?: N;
  readonly solarDiscVisibility?: number;
  setExternalShafts(enabled: boolean): void;
  cloudTransmittanceAtNdc(ndc: N, fallbackDirection: N): N;
}

const {
  Fn, If, float, vec2, vec3, uniform, length, dot, max, min, exp, pow, mix, smoothstep,
  abs, sin, cos, atan, screenCoordinate, perspectiveDepthToViewZ,
} = TSL;

export type GradingPresetName = 'tropicalNoon' | 'sunset' | 'goldenHour' | 'stormyTwilight';
export const GRADING_PRESET_NAMES: readonly GradingPresetName[] = ['tropicalNoon', 'sunset', 'goldenHour', 'stormyTwilight'];

export interface GradingParams {
  /** Linear HDR exposure multiplier layered on top of weather exposure (1 = neutral). */
  exposureBias: number;
  /** Post-AgX display contrast around mid grey (1 = neutral, default 1.14). */
  contrast: number;
  /** Post-AgX display saturation (1 = neutral, default 1.16). */
  saturation: number;
  /** HDR bloom luminance threshold. */
  bloomThreshold: number;
  /** White-balance temperature shift: -1 cool blue .. +1 warm amber. */
  temperature: number;
  /** White-balance tint shift: -1 green .. +1 magenta. */
  tint: number;
  /** RGB colour balance in shadows (linear lift tint around [1, 1, 1]). */
  shadows: [number, number, number];
  /** RGB colour balance in midtones (around [1, 1, 1]). */
  midtones: [number, number, number];
  /** RGB colour balance in highlights (around [1, 1, 1]). */
  highlights: [number, number, number];
  /** Subtle optical corner vignette strength (0..1). */
  vignette: number;
}

export const GRADING_PRESETS: Record<GradingPresetName, GradingParams> = {
  tropicalNoon: {
    exposureBias: 1.0,
    contrast: 1.14,
    saturation: 1.16,
    bloomThreshold: 1.15,
    temperature: 0.0,
    tint: 0.0,
    shadows: [1.0, 1.0, 1.0],
    midtones: [1.0, 1.0, 1.0],
    highlights: [1.0, 1.0, 1.0],
    vignette: 0.10,
  },
  sunset: {
    exposureBias: 0.98,
    contrast: 1.20,
    saturation: 1.08,
    bloomThreshold: 1.08,
    temperature: 0.08,
    tint: -0.03,
    shadows: [0.91, 0.99, 1.09],
    midtones: [1.01, 1.0, 0.98],
    highlights: [1.08, 1.01, 0.91],
    vignette: 0.28,
  },
  goldenHour: {
    exposureBias: 1.06,
    contrast: 1.16,
    saturation: 1.22,
    bloomThreshold: 1.02,
    temperature: 0.24,
    tint: 0.04,
    shadows: [1.03, 0.95, 1.02],
    midtones: [1.06, 1.0, 0.90],
    highlights: [1.14, 1.02, 0.84],
    vignette: 0.20,
  },
  stormyTwilight: {
    exposureBias: 0.94,
    contrast: 1.22,
    saturation: 0.86,
    bloomThreshold: 1.22,
    temperature: -0.22,
    tint: -0.04,
    shadows: [0.88, 0.96, 1.08],
    midtones: [0.94, 0.99, 1.06],
    highlights: [0.98, 1.02, 1.06],
    vignette: 0.34,
  },
};

export interface SunFxParams {
  /** Master enable for optical sun effects (halo, glare, ghosts, streak, god rays). */
  enabled: boolean;
  /** Atmospheric sun halo / corona strength (0..2). */
  halo: number;
  /** Compact core glare + 6-blade diffraction starburst strength (0..2). */
  glare: number;
  /** Chromatic multi-element optical lens ghost strength (0..2). */
  ghosts: number;
  /** Horizontal anamorphic cinema lens streak strength (0..2). */
  streak: number;
  /** Screen-space volumetric god rays strength (0..2). */
  godRays: number;
  /** Enable filmic colour grading presets. */
  gradingEnabled: boolean;
  /** Solar occlusion aperture at the reference lens; 0.012 is one apparent solar radius. */
  occlusionRadius: number;
  /** Anamorphic streak tilt angle in radians (0 = horizontal). */
  streakAngle: number;
}

export interface SunFxOptions {
  /** Optional Weather module for cloud occlusion and taking over screen-space god rays. */
  weather?: SunWeather;
  /** Starting colour grading preset (default `'tropicalNoon'`). */
  grading?: GradingPresetName;
  /** Initial optical parameter overrides. */
  params?: Partial<SunFxParams>;
}


/** Concentric 9-tap disc offsets (center + 4 inner + 4 outer) in unit-circle coordinates. */
const APERTURE_TAPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0.24],
  [0.45, 0, 0.11],
  [-0.45, 0, 0.11],
  [0, 0.45, 0.11],
  [0, -0.45, 0.11],
  [0.707, 0.707, 0.08],
  [-0.707, 0.707, 0.08],
  [0.707, -0.707, 0.08],
  [-0.707, -0.707, 0.08],
];

/** Multi-element lens ghost descriptors: [axisScale, radius, isRing, intensity, rTint, gTint, bTint]. */
const GHOST_ELEMENTS: ReadonlyArray<readonly [number, number, boolean, number, number, number, number]> = [
  [-0.42, 0.075, false, 0.28, 1.05, 0.88, 0.65],
  [-0.86, 0.135, true,  0.22, 0.55, 0.92, 1.15],
  [ 0.36, 0.055, false, 0.20, 1.10, 0.95, 0.78],
  [-1.32, 0.185, true,  0.16, 0.85, 1.05, 0.72],
  [-1.78, 0.095, false, 0.14, 0.68, 0.84, 1.18],
  [ 0.74, 0.115, true,  0.12, 1.12, 0.78, 0.94],
];

function cloneGrading(g: GradingParams): GradingParams {
  return {
    ...g,
    shadows: [...g.shadows],
    midtones: [...g.midtones],
    highlights: [...g.highlights],
  };
}

export class SunFx implements EngineModule {
  readonly params: SunFxParams = {
    enabled: true,
    halo: 1.0,
    glare: 1.0,
    ghosts: 0.85,
    streak: 0.75,
    godRays: 1.0,
    gradingEnabled: true,
    occlusionRadius: 0.012,
    streakAngle: 0,
  };
  /** Live colour grading parameters (can be edited directly or switched via `setGrading`). */
  readonly grading: GradingParams;

  private _gradingPreset: GradingPresetName = 'tropicalNoon';
  private gradingFrom: GradingParams | null = null;
  private gradingTo: GradingParams | null = null;
  private gradingElapsed = 0;
  private gradingDuration = 0;

  private weather: SunWeather | null = null;
  private shaftSteps = -1;
  private lastTemperature = NaN;
  private lastTint = NaN;
  private lastShafts = NaN;
  private lastTurbidity = NaN;
  private lastRayGain = NaN;
  private lastAngle = NaN;
  private ghostCount = -1;
  private streakEnabled = false;
  private haloEnabled = true;
  private boundWeather: SunWeather | null = null;
  private readonly eyeToWorld: N;
  private readonly inverseProjection: N;

  // Saved pipeline grading defaults to restore on dispose.
  private savedContrast = 1.14;
  private savedSaturation = 1.16;
  private savedBloomThreshold = 1.15;

  // ---- shader uniforms ------------------------------------------------------
  /** Sun position in NDC (x right, y up). */
  private uSunNdc = uniform(new THREE.Vector2(0, 2));
  /** 0..1 master sun-on-front-hemisphere factor (0 behind camera or below horizon). */
  private uSunFront = uniform(0);
  private uAspect = uniform(16 / 9);
  private uNearFar = uniform(new THREE.Vector2(0.3, 60000));
  private uHalo = uniform(1);
  private uGlare = uniform(1);
  private uGhosts = uniform(0.85);
  private uStreak = uniform(0.75);
  private uStreakCS = uniform(new THREE.Vector2(1, 0));
  private uShaftStrength = uniform(0);
  private uOccRadius = uniform(0.012);

  // Grading uniforms (applied in linear HDR before bloom / AgX).
  private uGradeOn = uniform(1);
  private uExposureBias = uniform(1);
  private uWhiteBalance = uniform(new THREE.Vector3(1, 1, 1));
  private uShadows = uniform(new THREE.Vector3(1, 1, 1));
  private uMidtones = uniform(new THREE.Vector3(1, 1, 1));
  private uHighlights = uniform(new THREE.Vector3(1, 1, 1));
  private uVignette = uniform(0.1);

  constructor(private engine: LuminaEngine, options: SunFxOptions = {}) {
    this.eyeToWorld = uniform(engine.camera.matrixWorld);
    this.inverseProjection = uniform(engine.camera.projectionMatrixInverse);
    this._gradingPreset = options.grading ?? 'tropicalNoon';
    this.grading = cloneGrading(GRADING_PRESETS[this._gradingPreset]);
    if (options.params) Object.assign(this.params, options.params);
    this.savedContrast = engine.pipeline.contrast.value;
    this.savedSaturation = engine.pipeline.saturation.value;
    this.savedBloomThreshold = engine.pipeline.bloomThreshold.value;
    if (options.weather) this.bindWeather(options.weather);
    this.setQuality(engine.quality.preset);
  }

  get gradingPreset(): GradingPresetName { return this._gradingPreset; }

  /** Attach (or detach) a `Weather` module for cloud occlusion and god-ray handoff. */
  bindWeather(weather: SunWeather | null): void {
    if (this.weather === weather) return;
    this.weather?.setExternalShafts(false);
    this.weather = weather;
    if (this.weather) this.weather.setExternalShafts(true);
    this.register(true);
  }

  /**
   * Switch to one of the four built-in grading presets (`natural`, `cinematic`, `golden`,
   * `storm`) or morph to custom `GradingParams`. Pass `duration > 0` (seconds) for a smooth
   * transition.
   */
  setGrading(preset: GradingPresetName | Partial<GradingParams>, duration = 0): void {
    const target: GradingParams = typeof preset === 'string'
      ? cloneGrading(GRADING_PRESETS[preset])
      : {
          ...cloneGrading(this.grading),
          ...preset,
          shadows: preset.shadows ? [...preset.shadows] : [...this.grading.shadows],
          midtones: preset.midtones ? [...preset.midtones] : [...this.grading.midtones],
          highlights: preset.highlights ? [...preset.highlights] : [...this.grading.highlights],
        };
    if (typeof preset === 'string') this._gradingPreset = preset;
    if (duration <= 1e-4) {
      this.gradingFrom = null;
      this.gradingTo = null;
      this.copyGrading(this.grading, target);
    } else {
      this.gradingFrom = cloneGrading(this.grading);
      this.gradingTo = target;
      this.gradingElapsed = 0;
      this.gradingDuration = duration;
    }
  }

  private copyGrading(dst: GradingParams, src: GradingParams): void {
    dst.exposureBias = src.exposureBias;
    dst.contrast = src.contrast;
    dst.saturation = src.saturation;
    dst.bloomThreshold = src.bloomThreshold;
    dst.temperature = src.temperature;
    dst.tint = src.tint;
    dst.shadows[0] = src.shadows[0]; dst.shadows[1] = src.shadows[1]; dst.shadows[2] = src.shadows[2];
    dst.midtones[0] = src.midtones[0]; dst.midtones[1] = src.midtones[1]; dst.midtones[2] = src.midtones[2];
    dst.highlights[0] = src.highlights[0]; dst.highlights[1] = src.highlights[1]; dst.highlights[2] = src.highlights[2];
    dst.vignette = src.vignette;
  }

  setQuality(preset: QualityPreset): void {
    const cfg = preset.sunFx ?? {
      enabled: true,
      halo: true,
      ghosts: preset.clouds.shaftSteps >= 12 ? 5 : preset.clouds.shaftSteps >= 8 ? 4 : preset.clouds.shaftSteps > 0 ? 2 : 0,
      streak: preset.clouds.shaftSteps >= 8,
      shaftSteps: preset.clouds.shaftSteps,
    };
    const nextShafts = cfg.enabled ? cfg.shaftSteps : 0;
    const nextGhosts = cfg.enabled ? cfg.ghosts : 0;
    const nextStreak = cfg.enabled && cfg.streak;
    const nextHalo = cfg.enabled && cfg.halo;
    const changed = nextShafts !== this.shaftSteps
      || nextGhosts !== this.ghostCount
      || nextStreak !== this.streakEnabled
      || nextHalo !== this.haloEnabled;
    this.shaftSteps = nextShafts;
    this.ghostCount = nextGhosts;
    this.streakEnabled = nextStreak;
    this.haloEnabled = nextHalo;
    if (changed) this.register(true);
  }

  // ---- shader graph registration --------------------------------------------

  private register(force = false): void {
    if (!force && this.boundWeather === this.weather) return;
    this.boundWeather = this.weather;

    const pipeline = this.engine.pipeline;
    const weather = this.weather;
    const steps = this.shaftSteps;
    const ghostCount = this.ghostCount;
    const streakOn = this.streakEnabled;
    const haloOn = this.haloEnabled;
    const topDown = (this.engine.renderer.backend as any).isWebGPUBackend === true;

    const ndcToDepthUv = (ndc: N): N => topDown
      ? vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))
      : ndc.mul(0.5).add(0.5);

    const sunColor = weather?.eyeSunlight ?? frame.sunColor;
    const cloudTransmittance = (tapNdc: N): N => {
      if (!weather) return frame.sunVisibility;
      // The analytic sky and offscreen fallback need the actual world ray of each tap.
      const view = this.inverseProjection.mul(TSL.vec4(tapNdc, 0.5, 1));
      const direction = TSL.normalize(this.eyeToWorld.mul(TSL.vec4(view.xyz, 0)).xyz);
      return weather.cloudTransmittanceAtNdc(tapNdc, direction);
    };

    /**
     * Evaluate 9-tap concentric aperture occlusion around `uSunNdc` against BOTH the scene
     * depth buffer and cloud transmittance. Returns `vec2(coreVisibility, haloVisibility)`.
     * Every fragment reads the exact same 9 texels around the sun → ~100 % L1 cache hits.
     */
    const aperture = TSL.uniformArray(APERTURE_TAPS.map(([x,y,w]) => new THREE.Vector3(x,y,w)), 'vec3');
    const sampleOcclusion = (depthTex: N): N => Fn(() => {
      const coreSum = float(0).toVar();
      const haloSum = float(0).toVar();
      const aspectInv = float(1).div(max(this.uAspect, 0.25));
      TSL.Loop({start: 0, end: APERTURE_TAPS.length, type: 'int', name: 'apertureTap'}, ({apertureTap}: N) => {
        const tap = aperture.element(apertureTap), ox = tap.x, oy = tap.y, w = tap.z;
        const tapNdc = this.uSunNdc.add(vec2(float(ox).mul(this.uOccRadius).mul(aspectInv), float(oy).mul(this.uOccRadius)));
        const inX = abs(tapNdc.x).lessThan(0.996);
        const inY = abs(tapNdc.y).lessThan(0.996);
        const inFrame = inX.and(inY);
        const tapUv = ndcToDepthUv(tapNdc).clamp(0.001, 0.999);
        const d = depthTex.sample(tapUv).r;
        const sampledOpen = d.greaterThanEqual(0.9999995).select(float(1), float(0));
        // Graceful roll-off just outside the viewport edge for atmospheric halo wrapping;
        // no false geometry pass-through far offscreen.
        const edgeDist = max(abs(tapNdc.x).sub(1), abs(tapNdc.y).sub(1)).max(0);
        const offscreenOpen = smoothstep(0.28, 0.0, edgeDist).mul(0.45);
        const geoOpen = inFrame.select(sampledOpen, offscreenOpen);
        const cloudT = cloudTransmittance(tapNdc).clamp(0, 1);
        // Core optics (starburst, streak, ghosts) require clear line of sight through both
        // geometry and clouds; atmospheric halo wraps softly through thin cloud veils.
        coreSum.addAssign(geoOpen.mul(cloudT).mul(cloudT).mul(w));
        haloSum.addAssign(geoOpen.mul(pow(max(cloudT, 0.0001), 0.65)).mul(w));
      });
      return vec2(coreSum.clamp(0, 1), haloSum.clamp(0, 1));
    })();

    pipeline.addEffect({
      id: 'sun-fx',
      order: 12,
      // ---- pre-resolve volumetric god rays (depth + cloud occluded) ---------
      scene: steps > 0 ? ({ color, depth, uv: st, toNdc, toUv }) => Fn(() => {
        const out = vec3(color).toVar();
        const sunUv = toUv(this.uSunNdc);
        const toSun = sunUv.sub(st);
        const distance = length(toSun.mul(vec2(this.uAspect, 1)));
        If(this.uShaftStrength.greaterThan(0.002).and(this.uSunFront.greaterThan(0.002)).and(distance.lessThan(1.38)), () => {
          const jitter = temporalIGN(screenCoordinate.xy, frame.frameIndex);
          const stride = toSun.mul(0.94 / steps);
          const lit = float(0).toVar();
          const weight = float(1).toVar(), total = (1 - 0.94 ** steps) / (1 - 0.94);
          TSL.Loop({start: 0, end: steps, type: 'int', name: 'shaftTap'}, ({shaftTap}: N) => {
            const p = st.add(stride.mul(jitter.add(float(shaftTap)))).clamp(0.001, 0.999);
            const open = depth.sample(p).r.greaterThanEqual(0.9999995).select(float(1), float(0));
            const through = cloudTransmittance(toNdc(p)).clamp(0, 1);
            lit.addAssign(open.mul(through.mul(through)).mul(weight));
            weight.mulAssign(0.94);
          });
          // Mie forward-scattering envelope + air-column thickness so foreground silhouettes stay crisp.
          const glow = exp(distance.mul(-2.45)).mul(smoothstep(1.38, 0.92, distance));
          const viewZ = perspectiveDepthToViewZ(depth.sample(st).r, this.uNearFar.x, this.uNearFar.y).negate();
          const air = float(1).sub(exp(viewZ.div(-260))).mul(0.94).add(0.06);
          const shaftTint = mix(vec3(1.0, 0.96, 0.90), vec3(1.05, 0.88, 0.68), smoothstep(0.35, 0.04, frame.sunDirection.y));
          out.addAssign(sunColor.mul(shaftTint).mul(lit.mul(glow).mul(air).mul(this.uShaftStrength).mul(this.uSunFront).div(total)));
        });
        return out;
      })() : undefined,

      // ---- post-resolve HDR sun optics + linear filmic grading --------------
      lens: (color: N, _st: N, ndc: N) => Fn(() => {
        const out = vec3(color).toVar();

        // 1. Geometry- & cloud-occluded sun halo, glare, streak and lens ghosts
        if (haloOn || ghostCount > 0 || streakOn) {
          const activeOptics = this.uHalo.add(this.uGlare).add(this.uGhosts).add(this.uStreak);
          If(this.uSunFront.greaterThan(0.002).and(activeOptics.greaterThan(0.002)), () => {
            const occ = sampleOcclusion(pipeline.sceneDepth).toVar();
            const coreVis = occ.x.mul(this.uSunFront);
            const haloVis = occ.y.mul(this.uSunFront);

            If(haloVis.greaterThan(0.001), () => {
              const aspectVec = vec2(this.uAspect, 1);
              const delta = ndc.sub(this.uSunNdc).mul(aspectVec);
              const dist = length(delta);
              // Keep optical glare physically anchored to sun radiance without blowing out HDR.
              const sunRad = sunColor.div(sunColor.mul(0.18).add(1.0));
              const lowSun = smoothstep(0.32, 0.03, frame.sunDirection.y);
              const warmHaloTint = mix(vec3(1.0, 0.97, 0.92), vec3(1.12, 0.84, 0.58), lowSun);

              // ---- Halo (broad atmospheric aureole + inner corona) ----------
              if (haloOn) {
                If(this.uHalo.greaterThan(0.002), () => {
                  const innerCorona = exp(dist.mul(-7.5)).mul(0.36);
                  const outerAureole = exp(dist.mul(-2.15)).mul(0.11);
                  const halo = innerCorona.add(outerAureole).mul(haloVis).mul(this.uHalo);
                  out.addAssign(sunRad.mul(warmHaloTint).mul(halo));
                });
              }

              // ---- Glare (intense compact disc + 6-blade diffraction starburst) ---
              If(coreVis.greaterThan(0.001).and(this.uGlare.greaterThan(0.002)), () => {
                const angle = atan(delta.y, delta.x);
                const rays6 = pow(abs(cos(angle.mul(3.0).add(0.26))), 24.0);
                const rays12 = pow(abs(cos(angle.mul(6.0).sub(0.15))), 38.0).mul(0.45);
                const starburst = rays6.add(rays12).mul(exp(dist.mul(-5.8))).mul(smoothstep(0.65, 0.0, dist));
                const coreGlow = exp(dist.mul(-22.0)).mul(0.55);
                // Subtle prismatic tip hue along diffraction spikes.
                const spikeTint = mix(vec3(1.0, 0.98, 0.94), vec3(1.1, 0.92, 0.78), smoothstep(0.04, 0.28, dist));
                out.addAssign(sunRad.mul(spikeTint).mul(coreGlow.add(starburst.mul(0.42))).mul(coreVis).mul(this.uGlare));
              });

              // ---- Anamorphic cinema streak ---------------------------------
              if (streakOn) {
                If(coreVis.greaterThan(0.001).and(this.uStreak.greaterThan(0.002)), () => {
                  // Rotate delta by streakAngle so the streak can tilt if desired.
                  const rx = delta.x.mul(this.uStreakCS.x).add(delta.y.mul(this.uStreakCS.y));
                  const ry = delta.y.mul(this.uStreakCS.x).sub(delta.x.mul(this.uStreakCS.y));
                  const thinLine = exp(abs(ry).mul(-88.0)).mul(exp(abs(rx).mul(-2.2)));
                  const wideLine = exp(abs(ry).mul(-26.0)).mul(exp(abs(rx).mul(-3.8))).mul(0.28);
                  const tipShift = smoothstep(0.05, 0.65, abs(rx));
                  const streakTint = mix(vec3(1.0, 0.97, 0.92), vec3(0.52, 0.82, 1.18), tipShift);
                  out.addAssign(sunRad.mul(streakTint).mul(thinLine.add(wideLine)).mul(0.48).mul(coreVis).mul(this.uStreak));
                });
              }

              // ---- Chromatic multi-element optical ghosts -------------------
              if (ghostCount > 0) {
                If(coreVis.greaterThan(0.001).and(this.uGhosts.greaterThan(0.002)), () => {
                  // Fade ghosts when the sun leaves the frame or sits right at the extreme border.
                  const sunEdgeFade = smoothstep(1.25, 0.75, max(abs(this.uSunNdc.x), abs(this.uSunNdc.y)));
                  const axis = this.uSunNdc;
                  const ghostAccum = vec3(0).toVar();
                  const count = Math.min(ghostCount, GHOST_ELEMENTS.length);
                  for (let i = 0; i < count; i++) {
                    const [scale, radius, isRing, weight, tr, tg, tb] = GHOST_ELEMENTS[i];
                    const center = axis.mul(scale);
                    const gVec = ndc.sub(center).mul(aspectVec);
                    // Chromatic radial shift along the optical axis (R outward, B inward).
                    const caShift = axis.mul(0.012 * (Math.abs(scale) + 0.35)).mul(aspectVec);
                    const dR = length(gVec.add(caShift));
                    const dG = length(gVec);
                    const dB = length(gVec.sub(caShift));
                    const shape = (d: N): N => {
                      if (isRing) {
                        const rd = d.sub(radius).div(radius * 0.24);
                        return exp(rd.mul(rd).negate()).mul(0.85).add(smoothstep(radius, radius * 0.2, d).mul(0.14));
                      }
                      return smoothstep(radius, radius * 0.18, d).max(0).pow(1.65);
                    };
                    const chroma = vec3(shape(dR).mul(tr), shape(dG).mul(tg), shape(dB).mul(tb));
                    // Optical barrel vignette attenuates ghosts far from center.
                    const radialFade = smoothstep(1.6, 0.25, length(center));
                    ghostAccum.addAssign(chroma.mul(weight).mul(radialFade));
                  }
                  out.addAssign(sunRad.mul(ghostAccum).mul(coreVis).mul(sunEdgeFade).mul(this.uGhosts).mul(0.32));
                });
              }
            });
          });
        }

        // 2. Filmic linear-HDR colour grading (white balance + 3-way CDL + vignette)
        If(this.uGradeOn.greaterThan(0.5), () => {
          const c = out.mul(this.uExposureBias).mul(this.uWhiteBalance).max(0).toVar();
          const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // Smooth 3-way luminance masks (shadows / midtones / highlights) in scene-referred HDR.
          const wShadow = smoothstep(0.42, 0.0, luma);
          const wHigh = smoothstep(0.38, 1.85, luma);
          const wMid = float(1).sub(wShadow).sub(wHigh).clamp(0, 1);
          const balance = this.uShadows.mul(wShadow).add(this.uMidtones.mul(wMid)).add(this.uHighlights.mul(wHigh));
          c.mulAssign(balance);
          // Optical corner vignette (smooth cosine-fourth inspired falloff).
          const r2 = dot(ndc, ndc);
          const vig = float(1).sub(r2.mul(this.uVignette).mul(0.26)).clamp(0.45, 1.0);
          out.assign(c.mul(vig));
        });

        return out;
      })(),
    });
  }

  // ---- per-frame update -----------------------------------------------------

  update(dt: number): void {
    const { camera, pipeline } = this.engine;

    // Advance smooth grading preset transitions.
    if (this.gradingFrom && this.gradingTo) {
      this.gradingElapsed += dt;
      const t = Math.min(1, this.gradingElapsed / Math.max(this.gradingDuration, 1e-4));
      const s = t * t * (3 - 2 * t);
      const a = this.gradingFrom, b = this.gradingTo, g = this.grading;
      const lerp = THREE.MathUtils.lerp;
      g.exposureBias = lerp(a.exposureBias, b.exposureBias, s);
      g.contrast = lerp(a.contrast, b.contrast, s);
      g.saturation = lerp(a.saturation, b.saturation, s);
      g.bloomThreshold = lerp(a.bloomThreshold, b.bloomThreshold, s);
      g.temperature = lerp(a.temperature, b.temperature, s);
      g.tint = lerp(a.tint, b.tint, s);
      for (let i = 0; i < 3; i++) {
        g.shadows[i] = lerp(a.shadows[i], b.shadows[i], s);
        g.midtones[i] = lerp(a.midtones[i], b.midtones[i], s);
        g.highlights[i] = lerp(a.highlights[i], b.highlights[i], s);
      }
      g.vignette = lerp(a.vignette, b.vignette, s);
      if (t >= 1) { this.gradingFrom = null; this.gradingTo = null; }
    }

    // A solar direction has homogeneous w=0. Project it directly so movement
    // through a large world cannot introduce parallax or cancellation error.
    const sun = frame.sunDirection.value as THREE.Vector3;
    const e = (frame.viewProjection.value as THREE.Matrix4).elements;
    const x = sun.x, y = sun.y, z = sun.z;
    const sunW = e[3] * x + e[7] * y + e[11] * z;
    const on = this.params.enabled && sunW > 1e-8;
    const ndc = this.uSunNdc.value as THREE.Vector2;
    if (on) {
      ndc.x = (e[0] * x + e[4] * y + e[8] * z) / sunW;
      ndc.y = (e[1] * x + e[5] * y + e[9] * z) / sunW;
      const front = THREE.MathUtils.smoothstep(sunW, -0.08, 0.25) *
        (this.weather?.solarDiscVisibility ?? THREE.MathUtils.smoothstep(y, -0.04, 0.05));
      if (this.uSunFront.value !== front) this.uSunFront.value = front;
    } else {
      ndc.set(0, 4);
      this.uSunFront.value = 0;
    }
    // Number uniforms hold tagged values: storing an unchanged number would still box a new one
    // every frame, even from optimised code, so each is written only when its value moved. Each
    // live control is read once.
    const params = this.params, aspect = camera.aspect;
    if (this.uAspect.value !== aspect) this.uAspect.value = aspect;
    (this.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);

    let halo = 0, glare = 0, ghosts = 0, streak = 0, gain = 0;
    if (on) {
      halo = params.halo; glare = params.glare; ghosts = params.ghosts; streak = params.streak; gain = params.godRays;
      // Negative (and NaN) gains switch an element off.
      if (!(halo > 0)) halo = 0;
      if (!(glare > 0)) glare = 0;
      if (!(ghosts > 0)) ghosts = 0;
      if (!(streak > 0)) streak = 0;
      if (!(gain > 0)) gain = 0;
    }
    if (this.uHalo.value !== halo) this.uHalo.value = halo;
    if (this.uGlare.value !== glare) this.uGlare.value = glare;
    if (this.uGhosts.value !== ghosts) this.uGhosts.value = ghosts;
    if (this.uStreak.value !== streak) this.uStreak.value = streak;
    const streakAngle = params.streakAngle;
    if (streakAngle !== this.lastAngle) {
      this.lastAngle = streakAngle;
      (this.uStreakCS.value as THREE.Vector2).set(Math.cos(streakAngle), Math.sin(streakAngle));
    }
    const radiusNdc = Math.max(0.002, params.occlusionRadius) * (0.00465 / 0.012) * camera.projectionMatrix.elements[5];
    if (this.uOccRadius.value !== radiusNdc) this.uOccRadius.value = radiusNdc;

    // God-ray strength follows weather turbidity & shaft setting when weather is bound.
    const weatherParams = this.weather ? this.weather.params : null;
    const weatherShafts = weatherParams ? (weatherParams.shafts ?? 0.55) : 0.6;
    const turbidity = weatherParams ? weatherParams.turbidity : 2.6;
    if (gain !== this.lastRayGain || turbidity !== this.lastTurbidity || weatherShafts !== this.lastShafts) {
      this.lastRayGain = gain; this.lastTurbidity = turbidity; this.lastShafts = weatherShafts;
      const haziness = THREE.MathUtils.clamp(0.35 + turbidity * 0.08, 0.35, 1.25);
      this.uShaftStrength.value = gain * weatherShafts * haziness * 0.13;
    }

    // Sync grading uniforms & pipeline post-AgX display look.
    const gradeOn = this.params.gradingEnabled;
    this.uGradeOn.value = gradeOn ? 1 : 0;
    if (gradeOn) {
      const g = this.grading;
      const exposureBias = g.exposureBias, temperature = g.temperature, tint = g.tint;
      if (this.uExposureBias.value !== exposureBias) this.uExposureBias.value = exposureBias;
      // Approximate physical white-balance RGB multipliers from temperature & tint.
      if (temperature !== this.lastTemperature || tint !== this.lastTint) {
        this.lastTemperature = temperature; this.lastTint = tint;
        const rBal = 1 + temperature * 0.24 + tint * 0.08;
        const gBal = 1 - tint * 0.12;
        const bBal = 1 - temperature * 0.24 + tint * 0.08;
        (this.uWhiteBalance.value as THREE.Vector3).set(rBal, gBal, bBal);
      }
      (this.uShadows.value as THREE.Vector3).set(g.shadows[0], g.shadows[1], g.shadows[2]);
      (this.uMidtones.value as THREE.Vector3).set(g.midtones[0], g.midtones[1], g.midtones[2]);
      (this.uHighlights.value as THREE.Vector3).set(g.highlights[0], g.highlights[1], g.highlights[2]);
      const vignette = g.vignette, contrast = g.contrast, saturation = g.saturation, bloomThreshold = g.bloomThreshold;
      if (this.uVignette.value !== vignette) this.uVignette.value = vignette;
      if (pipeline.contrast.value !== contrast) pipeline.contrast.value = contrast;
      if (pipeline.saturation.value !== saturation) pipeline.saturation.value = saturation;
      if (pipeline.bloomThreshold.value !== bloomThreshold) pipeline.bloomThreshold.value = bloomThreshold;
    }
  }

  dispose(): void {
    this.weather?.setExternalShafts(false);
    this.weather = null;
    this.engine.pipeline.removeEffect('sun-fx');
    this.engine.pipeline.contrast.value = this.savedContrast;
    this.engine.pipeline.saturation.value = this.savedSaturation;
    this.engine.pipeline.bloomThreshold.value = this.savedBloomThreshold;
  }
}
