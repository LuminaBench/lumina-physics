// Dev helper: load the showcase headlessly and capture a screenshot + console errors.
// usage: node qa/shot.mjs <url-query> <out.png> [waitMs] [evalJs]
import { chromium } from '@playwright/test';
const [query = '', out = 'qa/output/shot.png', waitMs = '2500', evalJs = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 900)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 900)}`));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}`);
try { await page.waitForFunction('window.__luminaReady === true', null, { timeout: 30000 }); } catch { logs.push('[timeout] __luminaReady never set'); }
if (evalJs) { try { await page.evaluate(evalJs); } catch (e) { logs.push(`[eval] ${String(e).slice(0, 400)}`); } }
await page.waitForTimeout(Number(waitMs));
const info = await page.evaluate(() => { const l = window.lumina; return l ? { backend: l.engine.backend, tier: l.engine.quality.tier, fps: Math.round(l.engine.quality.profiler.fps), ms: +l.engine.quality.profiler.ema.toFixed(2) } : null; });
await page.screenshot({ path: out });
console.log(JSON.stringify(info));
console.log([...new Set(logs)].slice(0, 25).join('\n') || 'no console errors');
await browser.close();
