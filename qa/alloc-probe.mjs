// Dev helper: JavaScript heap allocation per frame (sum of positive heap deltas between frames).
// usage: node qa/alloc-probe.mjs "<query>" [frames]
import { chromium } from '@playwright/test';
const [query = 'scene=chaos&tier=high', frames = '600'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}&ui=0`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async (n) => {
  let allocated = 0, last = performance.memory.usedJSHeapSize, i = 0, gcs = 0;
  await new Promise((res) => { const f = () => { const now = performance.memory.usedJSHeapSize; if (now > last) allocated += now - last; else if (now < last) gcs++; last = now; ++i < n ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); });
  return { kbPerFrame: +(allocated / n / 1024).toFixed(1), gcs, heapMb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) };
}, Number(frames));
console.log(query.padEnd(34), JSON.stringify(r));
await browser.close();
