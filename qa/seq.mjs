// Dev helper: capture a sequence of screenshots after running a trigger.
// usage: node qa/seq.mjs "<query>" "<out prefix>" "<trigger js>" "<comma separated ms>" [width] [height]
import { chromium } from '@playwright/test';
const [query, prefix, trigger = '', times = '500,1200,2400', w = '1280', h = '720'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 600)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 600)}`));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
await page.waitForTimeout(1500);
if (trigger) { try { await page.evaluate(trigger); } catch (e) { logs.push(`[eval] ${String(e).slice(0, 400)}`); } }
let elapsed = 0;
for (const t of times.split(',').map(Number)) {
  await page.waitForTimeout(Math.max(0, t - elapsed)); elapsed = t;
  await page.screenshot({ path: `${prefix}-${t}.png` });
}
console.log(JSON.stringify(await page.evaluate(() => ({ fps: Math.round(window.lumina.engine.quality.profiler.fps), gpu: +window.lumina.engine.stats.gpuMs.toFixed(1), errors: window.lumina.errors }))));
console.log([...new Set(logs)].slice(0, 20).join('\n') || 'no console errors');
await browser.close();
