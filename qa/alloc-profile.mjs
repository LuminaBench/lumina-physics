// Dev helper: attribute JavaScript allocations to source files (sampling heap profiler).
// usage: node qa/alloc-profile.mjs "<query>" [seconds] [warmupSeconds]
import { chromium } from '@playwright/test';
const [query = 'scene=chaos&tier=high', seconds = '8', warmupSeconds = '4'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}&ui=0`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60000 });
await page.waitForTimeout(Number(warmupSeconds) * 1000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
const f0 = await page.evaluate(() => window.lumina.engine.stats.frames);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await page.waitForTimeout(Number(seconds) * 1000);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const f1 = await page.evaluate(() => window.lumina.engine.stats.frames);
const frames = f1 - f0;
if (!(frames > 0)) throw new Error("No simulation frames rendered");
const byFile = new Map(), byFn = new Map();
const walk = (node) => {
  const url = node.callFrame.url || '(native)';
  const file = url.replace(/^.*localhost:\d+\//, '').replace(/\?.*$/, '');
  const group = file.includes('node_modules/.vite/deps/three') || file.includes('three') ? 'three.js' : file.includes('rapier') ? 'rapier' : file.startsWith('node_modules') ? 'deps' : file;
  byFile.set(group, (byFile.get(group) ?? 0) + node.selfSize);
  if (group !== 'three.js' && group !== 'rapier' && group !== '(native)') { const k = `${file}:${node.callFrame.functionName || '(anon)'}:${node.callFrame.lineNumber + 1}`; byFn.set(k, (byFn.get(k) ?? 0) + node.selfSize); }
  for (const c of node.children ?? []) walk(c);
};
walk(profile.head);
const total = [...byFile.values()].reduce((a, b) => a + b, 0);
console.log(`${query}: ${(total / frames / 1024).toFixed(1)} KB/frame sampled over ${frames} frames`);
for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(v / frames / 1024).toFixed(2).padStart(8)} KB/frame  ${k}`);
console.log('  -- top functions in project code');
for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`  ${(v / frames).toFixed(0).padStart(8)} B/frame  ${k}`);
await browser.close();
