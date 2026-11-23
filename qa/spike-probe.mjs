// Dev helper: peak GPU time after triggering an effect, with selected layers hidden.
// usage: node qa/spike-probe.mjs "<query>" "<setup js>" "<trigger js>" [frames]
import { chromium } from '@playwright/test';
const [query, setup = '', trigger = '', frames = '150', w = '1920', h = '1080'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}&ui=0`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
await page.waitForTimeout(2500);
if (setup) await page.evaluate(setup);
await page.waitForTimeout(500);
const r = await page.evaluate(async ([n, trig]) => {
  const e = window.lumina.engine; const base = e.stats.gpuMs;
  if (trig) (0, eval)(trig);
  let peak = 0, worst = 0, last = performance.now(), i = 0, sum = 0;
  await new Promise((res) => { const f = (now) => { worst = Math.max(worst, now - last); last = now; peak = Math.max(peak, e.stats.gpuMs); sum += e.stats.gpuMs; ++i < n ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
  return { base: +base.toFixed(1), peakGpu: +peak.toFixed(1), meanGpu: +(sum / n).toFixed(1), worstFrame: +worst.toFixed(1), scale: e.stats.renderScale };
}, [Number(frames), trigger]);
console.log(setup.slice(0, 60).padEnd(60), JSON.stringify(r));
await browser.close();
