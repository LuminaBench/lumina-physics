/**
 * lumina-physics render pipeline.
 *
 *   scene pass (MRT: HDR colour · view normal · motion vectors · depth)
 *     → GTAO                       (temporally filtered, tier-scaled)
 *     → soft layer composite       (mist / smoke / dust / fire sprites rendered off-screen at
 *                                   half the internal resolution into a single HDR target)
 *     → scene effects              (`addEffect`: depth-aware HDR ops – underwater fog, light shafts …)
 *     → TRAA   (renderScale = 1)   neighbourhood-clamped temporal reprojection
 *       TAAU   (renderScale < 1)   temporal upscaling to output resolution
 *     → lens effects               (`addEffect`: wet-lens refraction, underwater wobble …)
 *     → trauma fringe + flash
 *     → HDR-threshold bloom        (only scene-referred values above diffuse white bloom)
 *     → AgX tone mapping + sRGB
 *     → adaptive sharpening
 *
 * Screen-space reflections are traced inside the reflective materials themselves
 * (`engine/ssr.ts`) so a hit can *replace* the environment reflection instead of being
 * added on top of it – dark objects correctly occlude bright sky in puddles and water.
 */
import { refractedScreenUV } from './shading';
import * as THREE from 'three/webgpu';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { TSL, type N } from './tsl';
import { frame } from './frame';
import type { QualityPreset } from './quality';

const { pass, mrt, output, normalView, velocity, vec4, vec3, uniform, uv, renderOutput, float, length, mix } = TSL;

/** What a pre-resolve (`scene`) effect receives. Everything is a TSL node. */
export interface SceneEffectInput {
  /** HDR scene colour at this pixel (vec3, ambient occlusion already applied). */
  color: N;
  /** Scene depth texture node; `.sample(uv)` reads other pixels. */
  depth: N;
  /** Raw HDR scene colour texture node; `.sample(uv)` reads other pixels. */
  beauty: N;
  /** View-space normal texture node. */
  normal: N;
  /** Texture coordinate of this pixel: sampling `depth` / `beauty` with it returns this pixel. */
  uv: N;
  /** Normalised device coordinates of this pixel (x right, y up, −1..1). */
  ndc: N;
  /** Convert between texture coordinates and NDC (the row order differs per backend and pass). */
  toNdc(uv: N): N;
  toUv(ndc: N): N;
  camera: THREE.PerspectiveCamera;
}

/**
 * A pipeline effect. All hooks are optional and are inlined into existing passes, so an
 * effect costs shader instructions but no extra render target.
 *
 *   scene    HDR, internal resolution, before the temporal resolve; has depth.
 *   distort  UV offset applied when the resolved frame is read (lens refraction).
 *   lens     HDR colour operation after the resolve, before bloom.
 */
export interface PipelineEffect {
  id: string;
  /** Lower runs first (default 0). */
  order?: number;
  scene?(input: SceneEffectInput): N;
  /** Returns an offset as a fraction of the screen (x right, y up). `ndc` is the pixel's position, y up. */
  distort?(uv: N, ndc: N): N;
  lens?(color: N, uv: N, ndc: N): N;
}

export class LuminaPipeline {
  readonly pipeline: THREE.RenderPipeline;
  /** 0..1 chromatic fringe driven by camera trauma. */
  readonly trauma = uniform(0);
  /** HDR luminance above which pixels contribute to bloom. */
  readonly bloomThreshold = uniform(1.15);
  exposure = 1;
  /** Display-referred look applied after AgX (1 = neutral). AgX base is deliberately flat. */
  readonly contrast = uniform(1.14);
  readonly saturation = uniform(1.16);
  private nodes: Array<{ dispose?: () => void }> = [];
  private scenePass: N = null;
  private preset: QualityPreset | null = null;
  private effects: PipelineEffect[] = [];
  private softPass: N = null;
  private composite: N = null;
  /**
   * Off-screen layer for large soft sprites (mist, smoke, dust, fire). They are fill-rate
   * bound, so they render at `softScale` × the internal resolution into one HDR target
   * (no normal / velocity attachments) and are composited over the lit scene. Objects added
   * here must depth-test in their fragment stage against `sceneDepth`.
   */
  readonly softScene = new THREE.Scene();
  /** Scene depth of the main pass as a stable texture node (survives pipeline rebuilds). */
  readonly sceneDepth: N = TSL.texture(new THREE.DepthTexture(1, 1));
  /** Resolution of the soft layer relative to the internal render resolution. */
  softScale = 0.5;
  private dirty = false;
  /** True while the scale can change without a rebuild (always-TAAU graph). */
  dynamic = false;
  /** Static scale chosen from the tier and canvas size; buffers that should not follow DRS use it. */
  baseScale = 1;

  constructor(
    private renderer: THREE.WebGPURenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    renderer.toneMapping = THREE.AgXToneMapping;
  }

  /** Internal 3D resolution scale currently in use (1 = native, < 1 = temporal upscaling). */
  renderScale = 1;

  /**
   * (Re)build the node graph for a quality preset. `renderScale` overrides the preset's
   * internal resolution scale (the engine lowers it on canvases above the pixel budget).
   */
  configure(preset: QualityPreset, renderScale: number = preset.renderScale, dynamic = this.dynamic): void {
    this.renderScale = renderScale;
    this.baseScale = renderScale;
    this.dynamic = dynamic;
    this.dirty = false;
    for (const n of this.nodes) n.dispose?.();
    this.nodes = [];
    this.preset = preset;

    const scenePass = this.scenePass = pass(this.scene, this.camera);
    const targets = mrt({ output, normal: vec4(normalView, 1), velocity });
    // Auxiliary attachments must honour the material's blending: blended sprites output
    // alpha 0 there (see `auxPassthrough`) so they never overwrite normals / motion vectors.
    const BlendMode = (THREE as any).BlendMode;
    if (BlendMode && targets.setBlendMode) {
      targets.setBlendMode('normal', new BlendMode((THREE as any).MaterialBlending));
      targets.setBlendMode('velocity', new BlendMode((THREE as any).MaterialBlending));
    }
    scenePass.setMRT(targets);
    // Dynamic resolution keeps the upscaling resolve even at 1.0× so the scale can move freely.
    const upscale = preset.temporalAA && (dynamic || renderScale < 0.999);
    if (dynamic || renderScale < 0.999) scenePass.setResolutionScale(renderScale);
    this.nodes.push(scenePass);

    this.sceneDepth.value = scenePass.getTexture('depth');

    const softPass = this.softPass = pass(this.softScene, this.camera, { depthBuffer: false });
    softPass.setResolutionScale(renderScale * this.softScale);
    this.nodes.push(softPass);

    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = scenePass.getTextureNode('normal');
    const motion = scenePass.getTextureNode('velocity');

    let lit: N = color;
    if (preset.gtao.enabled) {
      const aoPass = ao(depth, normal, this.camera) as N;
      aoPass.resolutionScale = preset.gtao.resolutionScale;
      aoPass.samples.value = preset.gtao.samples;
      aoPass.radius.value = 0.6;
      aoPass.thickness.value = 1.2;
      aoPass.useTemporalFiltering = preset.temporalAA;
      this.nodes.push(aoPass);
      // AO is visibility for ambient light; keep 35 % of it out of direct sun to avoid crushing.
      const visibility = aoPass.getTextureNode().r;
      lit = vec4(color.rgb.mul(mix(float(1), visibility, 0.8)), color.a);
    }

    // Soft layer: premultiplied colour + coverage, bilinearly upsampled.
    const soft = softPass.getTextureNode('output');
    lit = vec4(lit.rgb.mul(soft.a.oneMinus().clamp(0, 1)).add(soft.rgb), lit.a);

    // Quad passes address textures with v = 0 at the top on WebGPU and at the bottom on
    // WebGL 2 render targets; effects that need a screen position get NDC instead.
    const topDown = (this.renderer.backend as any).isWebGPUBackend === true;
    const toNdc = (st: N): N => topDown ? TSL.vec2(st.x.mul(2).sub(1), float(1).sub(st.y.mul(2))) : st.mul(2).sub(1);
    const toUv = (ndc: N): N => topDown ? TSL.vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))) : ndc.mul(0.5).add(0.5);

    const ordered = [...this.effects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const effect of ordered) {
      if (!effect.scene) continue;
      const rgb = effect.scene({ color: lit.rgb, depth, beauty: color, normal, uv: uv(), ndc: toNdc(uv()), toNdc, toUv, camera: this.camera });
      lit = vec4(rgb, lit.a);
    }

    // One quad pass at the *internal* resolution evaluates AO, the soft layer and the scene
    // effects; the temporal resolve then reads a texture whose size matches depth and motion.
    const composite = this.composite = TSL.convertToTexture(lit) as N;
    composite.setResolutionScale?.(dynamic || renderScale < 0.999 ? renderScale : 1);
    this.nodes.push(composite);
    lit = composite;

    let resolved: N = lit;
    if (preset.temporalAA) {
      const resolve = (upscale ? taau(lit, depth, motion, this.camera) : traa(lit, depth, motion, this.camera)) as N;
      this.nodes.push(resolve);
      resolved = resolve;
    }

    // Trauma: radial chromatic fringe. Zero trauma collapses to a single effective tap.
    const centered = uv().sub(0.5);
    const fringe = centered.mul(this.trauma.mul(0.012)).mul(length(centered).mul(2));
    let lensUv: N = uv();
    // With sharpening the graded image is an intermediate target; without it this is the canvas pass.
    const intermediate = preset.sharpen > 0.01 && preset.temporalAA;
    const lensNdc: N = intermediate ? toNdc(uv()) : TSL.vec2(uv().x.mul(2).sub(1), float(1).sub(uv().y.mul(2)));
    const distorting = ordered.filter((e) => e.distort);
    if (distorting.length) {
      let offset: N = TSL.vec2(0, 0);
      for (const effect of distorting) offset = offset.add(effect.distort!(uv(), lensNdc));
      // Offsets are screen fractions with y up; texture rows may run the other way.
      const flip = intermediate ? topDown : true;
      lensUv = refractedScreenUV(uv(), flip ? TSL.vec2(offset.x, offset.y.negate()) : offset).toVar();
      if (!resolved.sample) { resolved = TSL.convertToTexture(resolved); this.nodes.push(resolved); }
    }
    let hdr: N;
    if (resolved.sample) {
      hdr = vec3(resolved.sample(refractedScreenUV(lensUv, fringe)).r, resolved.sample(lensUv).g, resolved.sample(refractedScreenUV(lensUv, fringe.negate())).b);
    } else hdr = resolved.rgb;
    for (const effect of ordered) if (effect.lens) hdr = effect.lens(hdr, uv(), lensNdc);
    hdr = hdr.add(frame.flash);

    if (preset.bloom.enabled) {
      // A subpixel solar glint can carry hundreds of scene-linear units. Keep its
      // resolved HDR centre, but limit energy fed into the wide lens-scatter kernel.
      const excess = TSL.luminance(hdr).sub(this.bloomThreshold).max(0);
      const bloomSource = hdr.div(excess.mul(1 / 12).add(1));
      const bloomPass = bloom(vec4(bloomSource, 1), preset.bloom.strength, preset.bloom.radius, 1) as N;
      bloomPass.threshold = this.bloomThreshold;
      this.nodes.push(bloomPass);
      hdr = hdr.add(bloomPass.rgb);
    }

    let display: N = renderOutput(vec4(hdr, 1), THREE.AgXToneMapping, THREE.SRGBColorSpace);
    // "Punchy" look: S-curve contrast around mid grey + saturation, in display space.
    const graded = TSL.saturation(display.rgb, this.saturation);
    const curved = graded.sub(0.5).mul(this.contrast).add(0.5).clamp(0, 1);
    display = vec4(mix(graded, curved, TSL.smoothstep(0.0, 0.12, TSL.luminance(graded))), 1);
    if (preset.sharpen > 0.01 && preset.temporalAA) {
      const sharp = sharpen(display, preset.sharpen) as N;
      this.nodes.push(sharp);
      display = sharp;
    }

    this.pipeline.outputNode = display;
    this.pipeline.needsUpdate = true;
  }

  /**
   * Register a pipeline effect (replacing any effect with the same id). The graph is
   * rebuilt once before the next frame. Returns a function that removes it again.
   */
  addEffect(effect: PipelineEffect): () => void {
    this.effects = this.effects.filter((e) => e.id !== effect.id);
    this.effects.push(effect);
    this.dirty = true;
    return () => this.removeEffect(effect.id);
  }

  removeEffect(id: string): void {
    const before = this.effects.length;
    this.effects = this.effects.filter((e) => e.id !== id);
    if (this.effects.length !== before) this.dirty = true;
  }

  /** True while an effect with this id is registered. */
  hasEffect(id: string): boolean { return this.effects.some((e) => e.id === id); }

  clearEffects(): void {
    if (this.effects.length) { this.effects = []; this.dirty = true; }
  }

  /**
   * Change the internal render scale. In dynamic mode this only resizes the scene render
   * target on the next frame (history and output stay at display resolution).
   */
  setRenderScale(scale: number): void {
    if (Math.abs(scale - this.renderScale) < 1e-4) return;
    if (!this.dynamic || !this.scenePass || !this.preset) { if (this.preset) this.configure(this.preset, scale); return; }
    this.renderScale = scale;
    this.scenePass.setResolutionScale(scale);
    this.softPass?.setResolutionScale(scale * this.softScale);
    this.composite?.setResolutionScale?.(scale);
  }

  private refreshPasses(): void {
    if (this.dirty && this.preset) {
      const scale = this.renderScale, base = this.baseScale;
      this.configure(this.preset, base);
      if (this.dynamic && scale !== base) this.setRenderScale(scale);
    }
  }

  /** Call while rendering is stopped. Three builds the actual MRT variants in time slices. */
  async prepareScenePasses(): Promise<void> {
    this.refreshPasses();
    const renderer = this.renderer;
    const target = renderer.getRenderTarget(), mrt = renderer.getMRT(), context = renderer.contextNode;
    try {
      await this.scenePass.compileAsync(renderer);
      await this.softPass.compileAsync(renderer);
    } finally {
      renderer.setRenderTarget(target);
      renderer.setMRT(mrt);
      renderer.contextNode = context;
    }
  }

  render(): void {
    this.refreshPasses();
    this.renderer.toneMappingExposure = this.exposure;
    this.pipeline.render();
  }

  dispose(): void {
    for (const n of this.nodes) n.dispose?.();
    this.pipeline.dispose();
  }
}
