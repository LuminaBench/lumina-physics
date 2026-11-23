// Dev helper: frame pacing + CPU breakdown at an arbitrary viewport / device pixel ratio.
// usage: node qa/perf-probe.mjs "<query>" <width> <height> <dpr> ["<js to run first>"] [frames]
import { chromium } from '@playwright/test';
const [query = 'scene=lagoon&tier=high', w = '1920', h = '1080', dpr = '1', evalJs = '', frames = '240'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist', ...(process.env.NOVSYNC ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
const context = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(dpr) });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}&ui=0`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
if (evalJs) await page.evaluate(evalJs);
await page.waitForTimeout(2500);
const r = await page.evaluate(async (n) => {
  const e = window.lumina.engine;
  const t = []; let last = performance.now(); const sim = [], sub = [], gpu = [];
  await new Promise((res) => { const f = (now) => { t.push(now - last); last = now; sim.push(e.stats.simMs); sub.push(e.stats.submitMs); gpu.push(e.stats.gpuMs); t.length < n ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
  t.sort((a, b) => a - b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const size = e.renderer.getDrawingBufferSize(new window.THREE.Vector2());
  return { tier: e.quality.tier, buffer: `${size.x}x${size.y}`, mean: +mean(t).toFixed(2), p50: +t[Math.floor(n * 0.5)].toFixed(1), p95: +t[Math.floor(n * 0.95)].toFixed(1), fps: +(1000 / mean(t)).toFixed(1), simMs: +mean(sim).toFixed(2), submitMs: +mean(sub).toFixed(2), gpuMs: +mean(gpu).toFixed(2), gpuMax: +Math.max(...gpu).toFixed(1), scale: e.stats.renderScale, drsChanges: e.drs.changes, draws: e.stats.drawCalls, tris: e.stats.triangles };
}, Number(frames));
console.log(JSON.stringify(r));
await browser.close();
