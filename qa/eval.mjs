// Dev helper: evaluate an expression in the running showcase and print the JSON result.
import { chromium } from '@playwright/test';
const [query = '', expr = '1', waitMs = '1500'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto(`http://localhost:${process.env.PORT ?? 5183}/?${query}`);
await page.waitForFunction('window.__luminaReady === true', null, { timeout: 30000 });
await page.waitForTimeout(Number(waitMs));
console.log(JSON.stringify(await page.evaluate(expr)));
await browser.close();
