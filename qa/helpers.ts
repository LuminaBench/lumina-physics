import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

export const SCENES = ['lagoon', 'jet', 'highway', 'fire', 'chaos', 'landfall', 'playground', 'river'] as const;
export const TIERS = ['low', 'medium', 'high', 'xhigh', 'ultra'] as const;
export type Backend = 'webgpu' | 'webgl2';

export interface PageLog { errors: string[]; warnings: string[] }

/** Benign driver / browser chatter that is not a lumina-physics defect. */
const IGNORED = [/PCFSoftShadowMap has been removed/i, /Download the React DevTools/i, /favicon/i, /GPU stall due to ReadPixels/i];

export function watchConsole(page: Page): PageLog {
  const log: PageLog = { errors: [], warnings: [] };
  page.on('console', (message) => {
    const text = message.text();
    if (IGNORED.some((r) => r.test(text))) return;
    if (message.type() === 'error' || /GPUValidationError|Error while parsing WGSL|pipeline creation failed/i.test(text))
      log.errors.push(text);
    if (message.type() === 'warning') log.warnings.push(text);
  });
  page.on('pageerror', (error) => log.errors.push(`pageerror: ${String(error)}`));
  return log;
}

export async function openScene(page: Page, scene: string, tier: string, backend: Backend): Promise<void> {
  const query = new URLSearchParams({ scene, tier, ui: '0' });
  if (backend === 'webgl2') query.set('webgl', '1');
  await page.goto(`/?${query}`);
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
  const result = await page.evaluate(() => {
    const app = (window as any).lumina;
    return { id: app.sceneId, backend: app.engine.backend, errors: app.errors.slice(0, 3) };
  });
  expect(result.id, JSON.stringify(result.errors)).toBe(scene);
  const actual = result.backend;
  expect(actual, `expected the ${backend} backend`).toBe(backend);
}

export interface ImageStats {
  /** Mean luminance 0..1. */
  mean: number;
  /** Luminance standard deviation – flat fills / blank frames score ~0. */
  contrast: number;
  /** Mean local gradient magnitude – "plastic", detail-free shading scores low. */
  detail: number;
  /** Share of pixels with noticeable colour saturation. */
  colorful: number;
  /** Distinct coarse colours (5 bits / channel) – posterised output scores low. */
  palette: number;
  /** Share of clipped (pure white or pure black) pixels. */
  clipped: number;
}

export function analyse(buffer: Buffer): ImageStats {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const lum = new Float32Array(width * height);
  let sum = 0, colorful = 0, clipped = 0;
  const palette = new Set<number>();
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[p] = l; sum += l;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 0.12) colorful++;
    if (max > 0.995 && min > 0.995) clipped++;
    if (max < 0.004) clipped++;
    if (p % 7 === 0) palette.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
  }
  const n = width * height;
  const mean = sum / n;
  let variance = 0, gradient = 0;
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const p = y * width + x;
    variance += (lum[p] - mean) ** 2;
    gradient += Math.abs(lum[p + 1] - lum[p]) + Math.abs(lum[p + width] - lum[p]);
  }
  return { mean, contrast: Math.sqrt(variance / n), detail: gradient / n, colorful: colorful / n, palette: palette.size, clipped: clipped / n };
}

/** Mean linear-ish RGB (0..1) of a rectangle given as fractions of the image. */
export function regionMean(buffer: Buffer, x0: number, y0: number, x1: number, y1: number): { r: number; g: number; b: number; luma: number } {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
    const i = (y * width + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  n = Math.max(n, 1);
  return { r: r / n / 255, g: g / n / 255, b: b / n / 255, luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255 };
}

/** Share of pixels in a rectangle that differ noticeably between two captures of the same size. */
export function changedFraction(a: Buffer, b: Buffer, x0 = 0, y0 = 0, x1 = 1, y1 = 1, threshold = 24): number {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  const { width, height } = pa;
  let changed = 0, n = 0;
  for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
    const i = (y * width + x) * 4;
    if (Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]) > threshold) changed++;
    n++;
  }
  return changed / Math.max(n, 1);
}

/** Click a panel button by its label with a real pointer event. */
export async function clickPanelButton(page: Page, label: string): Promise<void> {
  const button = page.locator('.panel .buttons button', { hasText: label }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}
