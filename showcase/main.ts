/**
 * lumina-physics interactive showcase.
 *
 *   ?scene=lagoon|jet|highway|fire|chaos|landfall|playground|river   start scene
 *   ?tier=low|medium|high|xhigh|ultra|auto          quality tier. Default: High. `auto` measures
 *                                                   frame pacing at your real window size and picks
 *                                                   the highest tier that holds 58+ fps
 *   ?drs=1|0                                        dynamic resolution scaling (default: on with tier=auto)
 *   ?webgl                                          force the WebGL 2 fallback backend
 *   ?autotier                                       let the frame-budget profiler steer tiers
 *   ?ui=0                                           hide the control chrome (captures)
 */
import * as THREE from 'three/webgpu';
import { LuminaEngine, QUALITY_PRESETS, QUALITY_TIERS, type QualityTier } from '../engine';
import { buildChrome } from './ui';
import type { SceneHandle, ShowcaseScene } from './scenes/types';
import { lagoonScene, landfallScene } from './scenes/coast';
import { jetScene } from './scenes/jet';
import { highwayScene } from './scenes/highway';
import { fireScene } from './scenes/fire';
import { chaosScene } from './scenes/chaos';
import { playgroundScene } from './scenes/playground';

import type { Weather } from '../modules/weather/weather';
import { SunFx, type GradingPresetName, type SunWeather } from '../engine/sun-fx';
import { riverScene } from './scenes/river';

const SCENES: ShowcaseScene[] = [lagoonScene, jetScene, highwayScene, fireScene, chaosScene, landfallScene, playgroundScene, riverScene];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const query = new URLSearchParams(location.search);
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const chrome = buildChrome({
  scenes: SCENES.map((s) => ({ id: s.id, label: s.label })),
  tiers: QUALITY_TIERS.map((t) => ({ id: t, label: QUALITY_PRESETS[t].label })),
  onScene: (id) => void setScene(id),
  onTier: (id) => setTier(id as QualityTier),
});
if (query.get('ui') === '0') document.getElementById('ui')!.style.display = 'none';

let engine: LuminaEngine;
let current: SceneHandle | null = null;
let sceneAttempted = false;
let switching = false;
let queuedTier: QualityTier | null = null;

async function setScene(id: string): Promise<void> {
  if (switching) return;
  const scene = SCENES.find((s) => s.id === id) ?? SCENES[0];
  switching = true;
  (window as any).__luminaReady = false;
  chrome.setLoading(`Building ${scene.title}…`);
  await new Promise((r) => setTimeout(r, 30));
  try {
    engine.stop();
    current?.dispose();
    current = null;
    if (sceneAttempted) await engine.reset();
    sceneAttempted = true;
    chrome.panel.clear();
    current = await scene.create({ engine, panel: chrome.panel, canvas });
    const debug = current.debug ?? (current.debug = {});
    const grading: GradingPresetName = scene.id === 'chaos' || scene.id === 'highway' ? 'stormyTwilight'
      : scene.id === 'river' || scene.id === 'landfall' ? 'goldenHour' : scene.id === 'fire' ? 'sunset' : 'tropicalNoon';
    const sunFx = engine.add(new SunFx(engine, { weather: debug.weather as SunWeather, grading }));
    debug.sunFx = sunFx;
    chrome.panel.select<GradingPresetName>('Color grade', [
      ['tropicalNoon', 'Tropical noon'], ['goldenHour', 'Golden hour'], ['sunset', 'Sunset'],
      ['stormyTwilight', 'Stormy twilight'],
    ], () => sunFx.gradingPreset, value => sunFx.setGrading(value, 0.7));
    chrome.setScene(scene.id);
    history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(query), scene: scene.id })}`);
    (window as any).lumina.scene = current.debug ?? {};
    (window as any).lumina.sceneId = scene.id;
    engine.warmSceneMaterials();
    await engine.pipeline.prepareScenePasses();
    await (debug.weather as Weather | undefined)?.localProbe?.prepare(engine.renderer, engine.scene);
    if (queuedTier !== null) {
      engine.quality.auto = false;
      engine.setQuality(queuedTier);
      queuedTier = null;
    }
    engine.start();
    // Give pipelines a few frames to compile before declaring the scene ready.
    await new Promise<void>(resolve => {
      let frames = 0;
      const wait = () => { if (++frames < 12) requestAnimationFrame(wait); else resolve(); };
      requestAnimationFrame(wait);
    });
    chrome.setLoading(null);
    (window as any).__luminaReady = true;
  } catch (error) {
    console.error('[lumina-physics] scene failed', error);
    errors.push(String(error));
    chrome.setLoading(null);
    chrome.showError(`Scene "${scene.title}" failed to start:\n${String((error as Error)?.stack ?? error)}`);
    (window as any).__luminaReady = true;
  } finally {
    switching = false;
    if (queuedTier !== null) { const tier = queuedTier; queuedTier = null; setTier(tier); }
  }
}

function setTier(tier: QualityTier): void {
  if (switching) { queuedTier = tier; return; }
  engine.quality.auto = false;
  engine.setQuality(tier);
}

async function boot(): Promise<void> {
  chrome.setLoading('Starting WebGPU…');
  const tierParam = (query.get('tier') ?? 'high') as QualityTier | 'auto';
  const drs = query.get('drs');
  engine = await LuminaEngine.create({
    canvas, preloadClouds: true, tier: tierParam, forceWebGL: query.has('webgl'),
    dynamicResolution: drs === null ? undefined : drs !== '0',
  });
  // Auto mode keeps guarding the frame budget afterwards (steps down only, never oscillates).
  engine.quality.auto = tierParam === 'auto' || query.has('autotier');
  engine.quality.onChange((preset) => chrome.setTier(preset.tier));
  chrome.setTier(engine.quality.tier);
  (window as any).lumina = { engine, setScene, setTier, errors, scene: {}, sceneId: '' };
  window.addEventListener('resize', () => engine.resize());
  window.addEventListener('keydown', (e) => {
    // Sliders do not use these keys, so shortcuts keep working while one has focus.
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== 'range')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= SCENES.length) void setScene(SCENES[n - 1].id);
    if (e.key === '[' || e.key === ']') {
      const i = QUALITY_TIERS.indexOf(engine.quality.tier) + (e.key === ']' ? 1 : -1);
      if (i >= 0 && i < QUALITY_TIERS.length) setTier(QUALITY_TIERS[i]);
    }
    if (e.key === 'p') engine.paused = !engine.paused;
  });

  const bufferSize = new THREE.Vector2();
  setInterval(() => {
    if (query.get('ui') === '0') return;
    const p = engine.quality.profiler;
    const caps = engine.quality.capabilities;
    const size = engine.renderer.getDrawingBufferSize(bufferSize);
    const st = engine.stats;
    const budget = engine.quality.preset.frameBudgetMs;
    const lines = [
      `<b>${p.fps.toFixed(0)} fps</b>  ${p.ema.toFixed(1)} ms  p95 ${p.percentile(0.95).toFixed(1)} ms`,
      `${engine.backend}  ·  ${engine.quality.preset.label}${engine.quality.auto ? ' (auto)' : ''}  ·  ${Math.round(size.x)}×${Math.round(size.y)} @${st.renderScale.toFixed(2)}×${engine.drs.enabled ? ' DRS' : ''}`,
      `<span class="frame-bar"><i class="js" style="width:${Math.min(100, (st.cpuMs / budget) * 100).toFixed(1)}%"></i><i class="gpu${st.gpuMs > budget * 0.93 ? ' hot' : ''}" style="width:${Math.max(0, Math.min(100, ((st.gpuMs - st.cpuMs) / budget) * 100)).toFixed(1)}%"></i></span>js ${st.cpuMs.toFixed(1)} ms  ·  gpu ${st.gpuMs > 0 ? `${st.gpuMs.toFixed(1)} ms (${Math.round(st.gpuHeadroom * 100)} % free)` : 'n/a'}  ·  ${st.drawCalls} draws  ${(st.triangles / 1000).toFixed(0)}k tris`,
      `gpu ${caps?.vendor ?? '?'} ${caps?.architecture ?? ''}  score ${caps?.score ?? '?'}`,
      ...(current?.hud?.() ?? []),
    ];
    chrome.setHud(lines.join('\n'));
  }, 250);

  await setScene(query.get('scene') ?? 'lagoon');
  if (tierParam === 'auto') {
    (window as any).__luminaReady = false;
    chrome.setLoading('Calibrating quality for this window…');
    const chosen = await engine.calibrateTier(58);
    console.info(`[lumina-physics] calibrated tier: ${chosen}`);
    chrome.setLoading(null);
    (window as any).__luminaReady = true;
  }
}

boot().catch((error) => {
  console.error(error);
  chrome.setLoading(null);
  chrome.showError(`lumina-physics could not start:\n${String(error?.stack ?? error)}`);
  (window as any).__luminaReady = true;
});
(window as any).THREE = THREE;
