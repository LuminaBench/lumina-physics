// Dev helper: time series of frame time / GPU time / render scale.
// usage: node qa/drs-trace.mjs "<query>" <width> <height> <dpr> [frames]
import { chromium } from '@playwright/test';
const [query = 'scene=chaos&tier=ultra&drs=1', w = '1920', h = '1080', dpr = '1', frames = '480'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(dpr) });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}&ui=0`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
const rows = await page.evaluate(async (n) => {
  const e = window.lumina.engine; const out = []; let last = performance.now(); let worst = 0, i = 0;
  await new Promise((res) => { const f = (now) => { worst = Math.max(worst, now - last); last = now;
    if (++i % 20 === 0) { out.push(`${i}: worst ${worst.toFixed(1)} gpu ${e.stats.gpuMs.toFixed(1)} scale ${e.stats.renderScale} missed ${e.drs.missed.toFixed(2)}`); worst = 0; }
    i < n ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
  return out;
}, Number(frames));
console.log(rows.join('\n'));
await browser.close();
