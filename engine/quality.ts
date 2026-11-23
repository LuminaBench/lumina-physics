/**
 * lumina-physics · 5-tier scalability system.
 *
 * One preset object drives every subsystem (render resolution, temporal AA mode, FFT
 * ocean, clouds, reflections, particles, shadows, AO). Modules never branch on the tier
 * name — they read numbers from the preset — so custom presets are first-class.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';
export const QUALITY_TIERS: QualityTier[] = ['low', 'medium', 'high', 'xhigh', 'ultra'];


export interface QualityPreset {
  tier: QualityTier;
  label: string;
  /** Upper bound for devicePixelRatio. */
  maxDpr: number;
  /**
   * Budget for internally rendered 3D pixels. Canvases above it keep their display
   * resolution but render the scene at a lower internal scale and reconstruct it with
   * temporal upscaling: fill-rate-bound effects (water optics, clouds, AO) scale with
   * pixels, so this is what keeps 4K / high-DPI windows at 60 fps.
   */
  maxPixels: number;
  /** Internal 3D resolution scale. < 1 switches the resolve from TRAA to temporal upscaling (TAAU). */
  renderScale: number;
  /** Temporal anti-aliasing. `false` renders without history (lowest tier on weak GPUs). */
  temporalAA: boolean;
  /** Post-resolve adaptive sharpening strength (0 disables the pass). */
  sharpen: number;
  ocean: {
    /** Number of FFT cascades (1–4): swell → wind sea → chop → capillary. */
    cascades: number;
    /** FFT grid resolution per cascade (power of two, 64–512). */
    resolution: number;
    /** Polar surface mesh density. */
    meshRings: number;
    meshSegments: number;
    /** Resolution of the CPU twin used for buoyancy sampling (and the WebGL 2 fallback). */
    cpuResolution: number;
    /**
     * Screen-space refraction + depth absorption. `false` shades the water column
     * analytically from the bathymetry depth: single-pass water with no scene copy and no
     * depth taps (the lowest tier). Every tier falls back to it beyond 250 m.
     */
    refraction: boolean;
  };
  interaction: {
    /** Resolution of the 2D wave/foam interaction field. */
    resolution: number;
    /** World extent in metres covered by the field. */
    extent: number;
  };
  clouds: {
    /**
     * Resolution scale of the cloud buffer (clouds are raymarched off-screen at this
     * fraction of the frame, temporally reprojected, then upsampled by the sky dome).
     * Ignored when `analytic` is true (zero cloud march).
     */
    scale: number;
    /** Primary raymarch steps per frame (0 = single-pass analytic cloud dome, zero march). */
    steps: number;
    /** Light-march steps toward the sun (0 in analytic mode). */
    lightSteps: number;
    /** Reflection/environment map width (equirect, height = width / 2). */
    envSize: number;
    /** Raymarch steps used for the reflection environment (0 in analytic mode). */
    envSteps: number;
    /** Screen-space light-shaft samples toward the sun (0 disables the effect). */
    shaftSteps: number;
    /** True on Low tier: single-pass analytic cloud dome & reflection with zero raymarching. */
    analytic?: boolean;
  };
  /** Optical sun effects (halo, glare, ghosts, anamorphic streak, god rays). */
  sunFx?: {
    enabled: boolean;
    halo: boolean;
    ghosts: number;
    streak: boolean;
    shaftSteps: number;
  };
  reflections: {
    ssr: boolean;
    /** 0..1 – SSR ray-march quality. */
    ssrQuality: number;
    ssrResolutionScale: number;
  };
  particles: {
    /** Total GPU particle budget shared by spray, mist, smoke, fire, sparks and rain. */
    budget: number;
  };
  shadows: { enabled: boolean; mapSize: number; radius: number };
  gtao: { enabled: boolean; samples: number; resolutionScale: number };
  bloom: { enabled: boolean; strength: number; radius: number };
  physics: { maxDebris: number; substeps: number };
  /** Frame budget the profiler steers toward, in milliseconds. */
  frameBudgetMs: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  low: {
    tier: 'low', label: 'Low', maxDpr: 1, maxPixels: 2_600_000, renderScale: 0.67, temporalAA: true, sharpen: 0.35,
    ocean: { cascades: 2, resolution: 64, meshRings: 96, meshSegments: 128, cpuResolution: 32, refraction: false },
    interaction: { resolution: 256, extent: 192 },
    clouds: { scale: 0, steps: 0, lightSteps: 0, envSize: 256, envSteps: 0, shaftSteps: 0, analytic: true },
    sunFx: { enabled: true, halo: true, ghosts: 0, streak: false, shaftSteps: 0 },
    reflections: { ssr: false, ssrQuality: 0, ssrResolutionScale: 1 },
    particles: { budget: 2048 },
    shadows: { enabled: false, mapSize: 1024, radius: 1 },
    gtao: { enabled: false, samples: 8, resolutionScale: 0.5 },
    bloom: { enabled: true, strength: 0.28, radius: 0.5 },
    physics: { maxDebris: 24, substeps: 1 },
    frameBudgetMs: 16.7,
  },
  medium: {
    tier: 'medium', label: 'Med', maxDpr: 1.25, maxPixels: 3_000_000, renderScale: 0.77, temporalAA: true, sharpen: 0.3,
    ocean: { cascades: 3, resolution: 128, meshRings: 144, meshSegments: 192, cpuResolution: 32, refraction: true },
    interaction: { resolution: 384, extent: 224 },
    clouds: { scale: 0.5, steps: 14, lightSteps: 3, envSize: 384, envSteps: 8, shaftSteps: 6, analytic: false },
    sunFx: { enabled: true, halo: true, ghosts: 2, streak: false, shaftSteps: 6 },
    reflections: { ssr: false, ssrQuality: 0, ssrResolutionScale: 1 },
    particles: { budget: 8192 },
    shadows: { enabled: true, mapSize: 1024, radius: 2 },
    gtao: { enabled: false, samples: 8, resolutionScale: 0.5 },
    bloom: { enabled: true, strength: 0.3, radius: 0.55 },
    physics: { maxDebris: 48, substeps: 1 },
    frameBudgetMs: 16.7,
  },
  high: {
    tier: 'high', label: 'High', maxDpr: 1.5, maxPixels: 3_000_000, renderScale: 1, temporalAA: true, sharpen: 0.22,
    ocean: { cascades: 3, resolution: 256, meshRings: 208, meshSegments: 288, cpuResolution: 64, refraction: true },
    interaction: { resolution: 512, extent: 256 },
    clouds: { scale: 0.5, steps: 20, lightSteps: 4, envSize: 512, envSteps: 8, shaftSteps: 8, analytic: false },
    sunFx: { enabled: true, halo: true, ghosts: 4, streak: true, shaftSteps: 10 },
    reflections: { ssr: true, ssrQuality: 0.3, ssrResolutionScale: 1 },
    particles: { budget: 20480 },
    shadows: { enabled: true, mapSize: 2048, radius: 3 },
    gtao: { enabled: true, samples: 8, resolutionScale: 0.5 },
    bloom: { enabled: true, strength: 0.32, radius: 0.6 },
    physics: { maxDebris: 96, substeps: 2 },
    frameBudgetMs: 16.7,
  },
  xhigh: {
    tier: 'xhigh', label: 'XHigh', maxDpr: 1.75, maxPixels: 2_600_000, renderScale: 1, temporalAA: true, sharpen: 0.2,
    ocean: { cascades: 4, resolution: 256, meshRings: 272, meshSegments: 384, cpuResolution: 64, refraction: true },
    interaction: { resolution: 768, extent: 288 },
    clouds: { scale: 0.5, steps: 28, lightSteps: 5, envSize: 512, envSteps: 10, shaftSteps: 12, analytic: false },
    sunFx: { enabled: true, halo: true, ghosts: 5, streak: true, shaftSteps: 14 },
    reflections: { ssr: true, ssrQuality: 0.5, ssrResolutionScale: 1 },
    particles: { budget: 49152 },
    shadows: { enabled: true, mapSize: 2048, radius: 4 },
    gtao: { enabled: true, samples: 12, resolutionScale: 0.5 },
    bloom: { enabled: true, strength: 0.34, radius: 0.62 },
    physics: { maxDebris: 160, substeps: 2 },
    frameBudgetMs: 16.7,
  },
  ultra: {
    tier: 'ultra', label: 'Ultra', maxDpr: 2, maxPixels: 2_150_000, renderScale: 1, temporalAA: true, sharpen: 0.18,
    ocean: { cascades: 4, resolution: 512, meshRings: 352, meshSegments: 512, cpuResolution: 64, refraction: true },
    interaction: { resolution: 1024, extent: 320 },
    clouds: { scale: 0.5, steps: 32, lightSteps: 5, envSize: 512, envSteps: 10, shaftSteps: 16, analytic: false },
    sunFx: { enabled: true, halo: true, ghosts: 6, streak: true, shaftSteps: 16 },
    reflections: { ssr: true, ssrQuality: 0.6, ssrResolutionScale: 1 },
    particles: { budget: 90112 },
    shadows: { enabled: true, mapSize: 4096, radius: 5 },
    gtao: { enabled: true, samples: 16, resolutionScale: 0.5 },
    bloom: { enabled: true, strength: 0.36, radius: 0.65 },
    physics: { maxDebris: 256, substeps: 3 },
    frameBudgetMs: 16.7,
  },
};

export interface GpuCapabilities {
  backend: 'webgpu' | 'webgl2';
  vendor: string;
  architecture: string;
  isFallbackAdapter: boolean;
  isMobile: boolean;
  maxTextureSize: number;
  deviceMemoryGb: number;
  cores: number;
  screenPixels: number;
  /** Heuristic 0..100 score used to pick the starting tier. */
  score: number;
}

/** Inspect the adapter / device and derive a capability score without rendering anything. */
export async function detectGpuCapabilities(backend: 'webgpu' | 'webgl2'): Promise<GpuCapabilities> {
  const nav = navigator as any;
  const caps: GpuCapabilities = {
    backend,
    vendor: 'unknown',
    architecture: 'unknown',
    isFallbackAdapter: false,
    isMobile: /Android|iPhone|iPad|Mobile/i.test(nav.userAgent ?? ''),
    maxTextureSize: 4096,
    deviceMemoryGb: nav.deviceMemory ?? 8,
    cores: nav.hardwareConcurrency ?? 4,
    screenPixels: Math.round(screen.width * screen.height * Math.min(devicePixelRatio, 2) ** 2),
    score: 0,
  };
  if (backend === 'webgpu' && nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const info = adapter.info ?? {};
        caps.vendor = String(info.vendor ?? 'unknown').toLowerCase();
        caps.architecture = String(info.architecture ?? 'unknown').toLowerCase();
        caps.isFallbackAdapter = Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter);
        caps.maxTextureSize = adapter.limits?.maxTextureDimension2D ?? 4096;
      }
    } catch { /* adapter probing is best-effort */ }
  }
  let score = backend === 'webgpu' ? 55 : 28;
  if (caps.isFallbackAdapter) score -= 40;
  if (caps.isMobile) score -= 22;
  if (caps.maxTextureSize >= 16384) score += 10;
  if (caps.cores >= 10) score += 12; else if (caps.cores >= 8) score += 7; else if (caps.cores <= 4) score -= 8;
  if (caps.deviceMemoryGb >= 8) score += 6; else if (caps.deviceMemoryGb <= 4) score -= 10;
  if (/apple/.test(caps.vendor) && !caps.isMobile) score += 8;
  if (/nvidia|amd/.test(caps.vendor)) score += 14;
  if (/intel/.test(caps.vendor)) score -= 10;
  // Very large canvases cost fill rate everywhere (raymarched sky, water optics).
  if (caps.screenPixels > 3840 * 2160) score -= 6;
  caps.score = Math.max(0, Math.min(100, score));
  return caps;
}

export function tierFromScore(score: number): QualityTier {
  if (score >= 88) return 'ultra';
  if (score >= 74) return 'xhigh';
  if (score >= 55) return 'high';
  if (score >= 34) return 'medium';
  return 'low';
}

/** Rolling frame-time statistics plus optional automatic tier steering. */
export class FrameBudgetProfiler {
  private samples = new Float32Array(180);
  private sorted = new Float32Array(this.samples.length);
  private cursor = 0;
  private filled = 0;
  private overBudgetTime = 0;
  private underBudgetTime = 0;
  /** Exponential moving average of frame time (ms). */
  ema = 16.7;

  push(frameMs: number): void {
    this.samples[this.cursor] = frameMs;
    this.cursor = (this.cursor + 1) % this.samples.length;
    this.filled = Math.min(this.filled + 1, this.samples.length);
    this.ema += (frameMs - this.ema) * 0.08;
  }

  get fps(): number { return 1000 / Math.max(this.ema, 0.01); }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    this.sorted.set(this.samples);
    this.sorted.fill(Infinity, this.filled);
    this.sorted.sort();
    return this.sorted[Math.min(this.filled - 1, Math.floor(p * this.filled))];
  }

  reset(): void { this.filled = 0; this.cursor = 0; this.overBudgetTime = 0; this.underBudgetTime = 0; }

  /**
   * Returns -1 / +1 when the tier should step down / up, 0 otherwise. Hysteresis: 2.5 s of
   * sustained overrun to drop, 8 s of generous headroom to climb.
   */
  steer(frameMs: number, budgetMs: number): -1 | 0 | 1 {
    const dt = frameMs / 1000;
    // Under 58 fps for 2.5 s → step down. Vsync hides headroom, so stepping *up* needs a
    // long stretch of frames that are clearly faster than the budget (high-refresh displays).
    if (this.ema > budgetMs * 1.055) { this.overBudgetTime += dt; this.underBudgetTime = 0; }
    else if (this.ema < budgetMs * 0.58) { this.underBudgetTime += dt; this.overBudgetTime = 0; }
    else { this.overBudgetTime = Math.max(0, this.overBudgetTime - dt); this.underBudgetTime = 0; }
    if (this.overBudgetTime > 2.5) { this.overBudgetTime = 0; return -1; }
    if (this.underBudgetTime > 8) { this.underBudgetTime = 0; return 1; }
    return 0;
  }
}

type QualityListener = (preset: QualityPreset, previous: QualityPreset) => void;

export class QualityManager {
  preset: QualityPreset;
  capabilities: GpuCapabilities | null = null;
  profiler = new FrameBudgetProfiler();
  /** When true the profiler may change tiers on its own. */
  auto = false;
  /** With `auto`: allow automatic steps up as well as down (off: only ever step down). */
  autoUp = false;
  private listeners = new Set<QualityListener>();

  constructor(tier: QualityTier = 'high') {
    this.preset = QUALITY_PRESETS[tier];
  }

  get tier(): QualityTier { return this.preset.tier; }

  async detect(backend: 'webgpu' | 'webgl2'): Promise<QualityTier> {
    this.capabilities = await detectGpuCapabilities(backend);
    let tier = tierFromScore(this.capabilities.score);
    // The WebGL 2 fallback has no compute FFT; cap it so the CPU ocean twin stays cheap.
    if (backend === 'webgl2' && QUALITY_TIERS.indexOf(tier) > 2) tier = 'high';
    return tier;
  }

  set(tier: QualityTier | QualityPreset): void {
    const next = typeof tier === 'string' ? QUALITY_PRESETS[tier] : tier;
    if (next === this.preset) return;
    const previous = this.preset;
    this.preset = next;
    this.profiler.reset();
    for (const l of this.listeners) l(next, previous);
  }

  onChange(listener: QualityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call once per frame with the measured frame time. */
  tick(frameMs: number): void {
    this.profiler.push(frameMs);
    if (!this.auto) return;
    const step = this.profiler.steer(frameMs, this.preset.frameBudgetMs);
    if (step === 0 || (step > 0 && !this.autoUp)) return;
    const index = QUALITY_TIERS.indexOf(this.preset.tier) + step;
    if (index >= 0 && index < QUALITY_TIERS.length) this.set(QUALITY_TIERS[index]);
  }
}
