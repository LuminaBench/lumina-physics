// Dev helper: capture several screenshots of one page load at the given times (ms).
// usage: node qa/burst.mjs <url-query> <out-prefix> <t1,t2,...> [evalJs]
import { chromium } from '@playwright/test';
const [query = '', prefix = 'qa/output/burst', times = '2000,4000', evalJs = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[${m.type()}] ${m.text().slice(0, 700)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 700)}`));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}`);
try { await page.waitForFunction('window.__luminaReady === true', null, { timeout: 40000 }); } catch { logs.push('[timeout] not ready'); }
if (evalJs) { try { await page.evaluate(evalJs); } catch (e) { logs.push(`[eval] ${String(e).slice(0, 400)}`); } }
const start = Date.now();
let i = 0;
for (const t of times.split(',').map(Number)) {
  const wait = t - (Date.now() - start);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({ path: `${prefix}_${i++}.png` });
}
const info = await page.evaluate(() => { const l = window.lumina; return l ? { backend: l.engine.backend, tier: l.engine.quality.tier, ms: +l.engine.quality.profiler.ema.toFixed(2), errors: l.errors.slice(0, 5) } : null; });
console.log(JSON.stringify(info));
console.log([...new Set(logs)].slice(0, 20).join('\n') || 'no console errors');
await browser.close();
