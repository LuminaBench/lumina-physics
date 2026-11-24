/**
 * LuminaEngine: renderer + pipeline + physics + shared fields, with a tiny module host.
 *
 * Modules (ocean, weather, aero, fire, wet-road …) register themselves; the engine calls
 * `update` every frame, `setQuality` on tier changes and `dispose` on teardown. Nothing
 * in here is showcase-specific – this is the piece a game embeds.
 */
import * as THREE from 'three/webgpu';
import { QualityManager, QUALITY_TIERS, type QualityPreset, type QualityTier } from './quality';
import { LuminaPipeline } from './pipeline';
import { installWorldMaterials, WorldBus } from './world-bus';
import { PhysicsEvents } from './events';
import { CameraTrauma } from './trauma';
import { initRapier, PhysicsWorld } from './physics';
import { frame, updateFrameUniforms } from './frame';
import { DynamicResolution } from './drs';
import { prepareCloudNoise } from './noise';
import { LensFx } from './lens-fx';

/** Upper bound for canvas (output) pixels: ≈ 3440×1600. Beyond this displays gain nothing visible. */
const MAX_OUTPUT_PIXELS = 5_600_000;

export interface EngineModule {
  update?(dt: number, time: number): void;
  setQuality?(preset: QualityPreset): void;
  dispose?(): void;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** `'auto'` runs GPU capability detection. */
  tier?: QualityTier | 'auto';
  /** Force the WebGL 2 backend (fallback testing). */
  forceWebGL?: boolean;
  /** Cooperatively prepare shared volumetric textures for outdoor scenes. */
  preloadClouds?: boolean;
  /** Create a Rapier world (default true). */
  physics?: boolean;
  /** Dynamic resolution scaling (default: on for `tier: 'auto'`, off otherwise). */
  dynamicResolution?: boolean;
}

export class LuminaEngine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly quality: QualityManager;
  readonly world = new WorldBus();
  readonly wind = this.world;
  readonly events = new PhysicsEvents();
  readonly trauma = new CameraTrauma();
  pipeline!: LuminaPipeline;
  /** Water on the camera lens: droplets, runners, the sheet after surfacing. `lens.enabled` toggles it. */
  lens!: LensFx;
  physics!: PhysicsWorld;
  backend: 'webgpu' | 'webgl2' = 'webgpu';
  time = 0;
  /** Simulation time scale (slow-motion for inspecting blasts). */
  timeScale = 1;
  paused = false;
  /** Called first every frame: game logic, input, forces, effect emission. */
  onUpdate: ((dt: number, time: number) => void) | null = null;
  /**
   * Called after physics and before reprojection matrices are captured: place the camera
   * here so it frames this frame's interpolated physics poses.
   */
  onBeforeRender: ((dt: number, time: number) => void) | null = null;
  /** `simMs` = game + physics + module updates, `submitMs` = render submission, `cpuMs` = both. */
  /**
   * `gpuMs` is the time from the end of render submission until the GPU reports the frame's
   * work done (WebGPU only; 0 when unknown). `gpuHeadroom` = 1 − gpuMs / frame budget.
   */
  readonly stats = { frames: 0, frameMs: 16.7, cpuMs: 0, simMs: 0, submitMs: 0, gpuMs: 0, gpuHeadroom: 0, drawCalls: 0, triangles: 0, renderScale: 1 };
  /** Dynamic resolution controller. Toggle with `setDynamicResolution`. */
  readonly drs = new DynamicResolution();

  private restoreMaterials: () => void;
  private modules = new Set<EngineModule>();
  private lastNow = 0;
  private readonly flashTint = new THREE.Color();
  private flashDecay = 14;
  private running = false;
  private errorCount = 0;
  private warming: Array<{ object: THREE.Object3D; frames: number }> = [];
  private loadingFrusta: THREE.Object3D[] = [];
  private gpuProbeBusy = false;
  private gpuProbeStart = 0;
  private readonly onGpuDone = (): void => {
    const ms = performance.now() - this.gpuProbeStart;
    this.gpuProbeBusy = false;
    // Ignore probes that straddled a hidden tab or a long task.
    if (ms < 250) this.stats.gpuMs += (ms - this.stats.gpuMs) * (this.stats.gpuMs === 0 ? 1 : 0.12);
  };

  private constructor(readonly renderer: THREE.WebGPURenderer, readonly canvas: HTMLCanvasElement) {
    this.restoreMaterials = installWorldMaterials(renderer);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 60000);
    this.quality = new QualityManager('high');
  }

  static async create(options: EngineOptions): Promise<LuminaEngine> {
    // WebGPU otherwise exposes only the portable minimum even on desktop adapters.
    const gpu = (navigator as any).gpu;
    const adapter = !options.forceWebGL && gpu ? await gpu.requestAdapter({
      powerPreference: 'high-performance', featureLevel: 'compatibility',
    }).catch(() => null) : null;
    const requiredLimits = adapter ? {
      maxSampledTexturesPerShaderStage: Math.min(32, adapter.limits.maxSampledTexturesPerShaderStage),
      maxSamplersPerShaderStage: Math.min(32, adapter.limits.maxSamplersPerShaderStage),
      maxStorageBuffersPerShaderStage: Math.min(16, adapter.limits.maxStorageBuffersPerShaderStage),
    } : {};
    const renderer = new THREE.WebGPURenderer({
      requiredLimits,
      canvas: options.canvas,
      antialias: false,
      forceWebGL: options.forceWebGL ?? false,
      powerPreference: 'high-performance',
    } as any);
    await Promise.all([renderer.init(), options.preloadClouds ? prepareCloudNoise() : undefined,
      options.physics !== false ? initRapier() : undefined]);
    const engine = new LuminaEngine(renderer, options.canvas);
    engine.backend = (renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2';
    renderer.shadowMap.type = THREE.PCFShadowMap;

    // 'auto' starts from the capability score but never above High: anything higher has to
    // be earned by measurement (`calibrateTier`) at the real canvas size.
    const tierOption = options.tier ?? 'auto';
    const detected = await engine.quality.detect(engine.backend).catch(() => 'high' as QualityTier);
    const tier = tierOption === 'auto' ? QUALITY_TIERS[Math.min(QUALITY_TIERS.indexOf(detected), 2)] : tierOption;
    engine.quality.set(tier);

    if (options.physics !== false) {
      engine.physics = await PhysicsWorld.create();
      engine.physics.fields = engine.world;
    }
    engine.pipeline = new LuminaPipeline(renderer, engine.scene, engine.camera);
    engine.lens = new LensFx(engine.pipeline, engine.camera);
    engine.lens.setQuality(engine.quality.preset);
    engine.lens.attach();
    engine.drs.enabled = options.dynamicResolution ?? tierOption === 'auto';
    engine.pipeline.dynamic = engine.drs.enabled;
    engine.applyQuality(engine.quality.preset);
    engine.quality.onChange((preset) => engine.applyQuality(preset));
    return engine;
  }

  add<T extends EngineModule>(module: T): T {
    this.modules.add(module);
    return module;
  }

  remove(module: EngineModule): void {
    if (this.modules.delete(module)) module.dispose?.();
  }

  setQuality(tier: QualityTier): void { this.quality.set(tier); }

  /**
   * Compile an effect's render pipeline *now* instead of on first use. The object is drawn
   * for a few frames far below the world (never visible), then removed. Use it for anything
   * that only appears mid-game – shockwaves, lightning, debris – so the first blast or
   * strike does not hitch. Pass a throw-away object that shares the real material and
   * vertex layout.
   */
  prewarm(object: THREE.Object3D, frames = 5, scene = this.scene): void {
    object.position.y -= 9000;
    object.traverse((o) => { o.frustumCulled = false; });
    object.updateMatrixWorld(true);
    scene.add(object);
    this.warming.push({ object, frames });
  }

  /** Submit initially off-camera scenery through the real scene passes during loading.
   * Three's render target, MRT layout and lighting all affect the program variant.
   * Visibility flags still control dormant gameplay effects. */
  warmSceneMaterials(): void {
    this.restoreLoadingFrusta();
    const include = (object: THREE.Object3D): void => {
      if (object instanceof THREE.Mesh && object.frustumCulled) {
        this.loadingFrusta.push(object);
        object.frustumCulled = false;
      }
    };
    this.scene.traverseVisible(include);
    this.pipeline.softScene.traverseVisible(include);
  }

  private restoreLoadingFrusta(): void {
    for (let i = 0; i < this.loadingFrusta.length; i++) this.loadingFrusta[i].frustumCulled = true;
    this.loadingFrusta.length = 0;
  }

  /** Dispose every module and start from an empty scene + fresh physics world. */
  async reset(): Promise<void> {
    this.restoreLoadingFrusta();
    this.world.clearWorld();
    for (const m of this.modules) m.dispose?.();
    this.modules.clear();
    this.onUpdate = null;
    this.onBeforeRender = null;
    this.warming = [];
    this.pipeline.clearEffects();
    this.lens.clear();
    this.lens.attach();
    this.drs.hold(1.5);
    this.timeScale = 1;
    this.trauma.trauma = 0;
    this.trauma.rumble = 0;
    this.wind.set(0, 6, 0.35);
    for (const child of [...this.scene.children]) this.scene.remove(child);
    for (const child of [...this.pipeline.softScene.children]) this.pipeline.softScene.remove(child);
    this.scene.environment = null;
    (this.scene as any).fogNode = null;
    this.physics?.dispose();
    this.physics = await PhysicsWorld.create();
    this.physics.fields = this.world;
    (frame.flash.value as THREE.Color).setRGB(0, 0, 0);
  }

  /**
   * Internal render scale for a canvas size: the tier's own scale, lowered further when
   * the canvas exceeds the tier's pixel budget. The canvas itself stays at display
   * resolution; the scene is reconstructed to it by temporal upscaling (TAAU), so large and
   * high-DPI windows keep crisp edges and UI-sharp output at a bounded GPU cost.
   */
  private renderScaleFor(preset: QualityPreset, width: number, height: number, dpr: number): number {
    const fit = Math.sqrt(preset.maxPixels / Math.max(width * height * dpr * dpr, 1));
    const scale = Math.min(preset.renderScale, fit);
    // Quantise so small window resizes do not rebuild the pipeline.
    return Math.max(0.5, Math.min(1, Math.floor(scale * 20 + 1e-6) / 20));
  }

  private applyQuality(preset: QualityPreset): void {
    this.renderer.shadowMap.enabled = preset.shadows.enabled;
    this.resize(true);
    this.lens?.setQuality(preset);
    for (const m of this.modules) m.setQuality?.(preset);
  }

  resize(reconfigure = false): void {
    const preset = this.quality.preset;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    // Output (canvas) resolution is capped as well: resolve, bloom and sharpening run there.
    const dpr = Math.min(window.devicePixelRatio || 1, preset.maxDpr, Math.sqrt(MAX_OUTPUT_PIXELS / Math.max(width * height, 1)));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    const scale = this.renderScaleFor(preset, width, height, dpr);
    if (reconfigure || Math.abs(scale - this.pipeline.baseScale) > 0.001 || this.pipeline.dynamic !== this.drs.enabled) {
      this.pipeline.configure(preset, scale, this.drs.enabled);
      this.drs.max = Math.min(1, preset.renderScale);
      this.drs.blindMax = scale;
      this.drs.reset(scale);
    }
  }

  /**
   * Turn dynamic resolution scaling on or off (any tier). While on, the internal render
   * scale follows measured GPU load between `drs.min` (0.55) and the tier's render scale.
   */
  setDynamicResolution(enabled: boolean): void {
    if (this.drs.enabled === enabled) return;
    this.drs.enabled = enabled;
    this.resize(true);
  }

  /** Trigger a full-screen HDR flash (lightning, detonation). Decays exponentially. */
  flash(color: THREE.ColorRepresentation, intensity: number, decayPerSecond = 14): void {
    const c = this.flashTint.set(color).multiplyScalar(intensity);
    const f = frame.flash.value as THREE.Color;
    f.r = Math.max(f.r, c.r); f.g = Math.max(f.g, c.g); f.b = Math.max(f.b, c.b);
    this.flashDecay = decayPerSecond;
  }

  /** Advance and render one frame. `now` is a `performance.now()` timestamp. */
  tick(now: number): void {
    const rawDt = this.lastNow === 0 ? 1 / 60 : (now - this.lastNow) / 1000;
    this.lastNow = now;
    const frameMs = rawDt * 1000;
    const dt = this.paused ? 0 : Math.min(rawDt, 1 / 20) * this.timeScale;
    const cpuStart = performance.now();
    this.time += dt;

    this.trauma.restore(this.camera);
    this.world.update(dt);
    this.onUpdate?.(dt, this.time);
    // Fixed 1/60 s steps; bound objects come out with render-interpolated transforms.
    if (this.physics && dt > 0) this.physics.step(dt, this.quality.preset.physics.substeps + 2);
    // Camera rigs run *after* physics so they frame this frame's interpolated poses, and
    // *before* the reprojection matrices are captured (TRAA, cloud history).
    this.onBeforeRender?.(dt, this.time);
    this.trauma.apply(this.camera, rawDt);
    this.pipeline.trauma.value = this.trauma.shake;
    updateFrameUniforms(this.camera, this.time, Math.max(dt, 1e-4));
    const simulationTime = this.time;
    for (const module of this.modules) module.update?.(dt, simulationTime);
    this.lens.update(rawDt);
    const f = frame.flash.value as THREE.Color;
    f.multiplyScalar(Math.exp(-this.flashDecay * rawDt));

    const submitStart = performance.now();
    if (this.warming.length) {
      let live = 0;
      for (let i = 0; i < this.warming.length; i++) {
        const entry = this.warming[i];
        if (--entry.frames < 0) entry.object.removeFromParent();
        else this.warming[live++] = entry;
      }
      this.warming.length = live;
    }
    this.world.bindMaterials();
    this.pipeline.render();
    if (this.loadingFrusta.length) this.restoreLoadingFrusta();
    this.stats.frames++;
    const end = performance.now();
    this.probeGpu(end);
    // Smoothed so the HUD is readable; peaks still show in `quality.profiler`.
    this.stats.simMs += (submitStart - cpuStart - this.stats.simMs) * 0.1;
    this.stats.submitMs += (end - submitStart - this.stats.submitMs) * 0.1;
    this.stats.cpuMs = this.stats.simMs + this.stats.submitMs;
    this.stats.frameMs = frameMs;
    const info = this.renderer.info.render as any;
    this.stats.drawCalls = info.drawCalls ?? info.calls ?? 0;
    this.stats.triangles = info.triangles ?? 0;
    const budget = this.quality.preset.frameBudgetMs;
    this.stats.gpuHeadroom = this.stats.gpuMs > 0 ? 1 - this.stats.gpuMs / budget : 0;
    if (this.drs.enabled && !this.paused) {
      const next = this.drs.update(frameMs, this.stats.gpuMs, budget);
      if (next !== null) this.pipeline.setRenderScale(next);
    }
    this.stats.renderScale = this.pipeline.renderScale;
    this.quality.tick(frameMs);
  }

  /**
   * GPU time estimate: `queue.onSubmittedWorkDone()` resolves when everything submitted so
   * far has finished executing, so the delay after submission is the GPU's share of the
   * frame (plus a little IPC latency). One probe is in flight at a time.
   */
  private probeGpu(submittedAt: number): void {
    if (this.gpuProbeBusy) return;
    const queue = (this.renderer.backend as any).device?.queue;
    if (!queue?.onSubmittedWorkDone) return;
    this.gpuProbeBusy = true;
    this.gpuProbeStart = submittedAt;
    queue.onSubmittedWorkDone().then(this.onGpuDone, this.onGpuDone);
  }

  /**
   * Pick the highest tier that really holds `targetFps` at the *current canvas size* on
   * this GPU, by measuring frame pacing: drop tiers while frames are being missed, then
   * probe upward one tier at a time and keep each step only if it still holds. (GPU
   * timestamp sums are not comparable across tile-based GPUs, so pacing is the ground
   * truth; vsync hides headroom, which is why upward steps are probed rather than guessed.)
   * Call while a scene is rendering, e.g. behind a loading overlay. Resolves with the tier.
   */
  async calibrateTier(targetFps = 58, maxTier: QualityTier = 'ultra'): Promise<QualityTier> {
    const budget = 1000 / targetFps;
    /** Mean frame time after letting pipelines compile and history buffers settle. */
    const measure = async (frames = 46): Promise<number> => {
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let last = 0, n = 0;
        const step = (now: number) => {
          if (n++ > 28 && last > 0) times.push(now - last);   // skip warm-up frames
          last = now;
          if (times.length >= frames) resolve(); else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      times.sort((a, b) => a - b);
      // Trim the two worst frames: one-off hitches (GC, shader upload) are not the tier's cost.
      const kept = times.slice(0, times.length - 2);
      return kept.reduce((a, b) => a + b, 0) / kept.length;
    };
    const tiers = QUALITY_TIERS;
    const ceiling = tiers.indexOf(maxTier);
    let index = Math.min(tiers.indexOf(this.quality.tier), ceiling);
    let ms = await measure();
    while (ms > budget && index > 0) { this.setQuality(tiers[--index]); ms = await measure(); }
    // Vsync hides headroom, so a higher tier is only accepted if it runs a longer window
    // with essentially no missed frames (a calm scene must leave room for busy moments).
    const strict = Math.min(budget, 16.95);
    while (ms <= budget && index < ceiling) {
      this.setQuality(tiers[index + 1]);
      const next = await measure(100);
      if (next > strict) { this.setQuality(tiers[index]); break; }
      index++; ms = next;
    }
    return tiers[index];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop((now: number) => {
      try { this.tick(now); }
      catch (error) {
        if (this.errorCount++ < 5) console.error('[lumina-physics] frame error', error);
      }
    });
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    for (const m of this.modules) m.dispose?.();
    this.modules.clear();
    this.events.clear();
    this.pipeline.dispose();
    this.physics?.dispose();
    this.restoreMaterials();
    this.world.shelters.dispose();
    this.renderer.dispose();
  }
}
