import { test, expect } from '@playwright/test';
import { openScene, watchConsole } from './helpers';

test('Storm Chaos project allocation budget after warmup', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'chaos', 'high', 'webgpu');
  await page.waitForTimeout(4000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const frame = () => page.evaluate(() => (window as any).lumina.engine.stats.frames);
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const from = await frame();
  await page.waitForTimeout(8000);
  const to = await frame();
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const sources = new Map<string, number>();
  const walk = (node: typeof profile.head) => {
    const file = node.callFrame.url.split('?')[0];
    if (/^https?:\/\/[^/]+\/(engine|modules|showcase|test-rigs)\//.test(file))
      sources.set(file, (sources.get(file) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  expect(to - from).toBeGreaterThan(120);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry =>
    new URL(entry.name).pathname.startsWith('/engine/'))), 'profile against the source dev server').toBe(true);
  const bytes = [...sources.values()].reduce((sum, v) => sum + v, 0) / (to - from);
  console.log(`Storm Chaos: ${Math.round(bytes)} project bytes/rendered frame over ${to - from} frames`);
  test.info().annotations.push({ type: 'allocation', description: JSON.stringify({ bytesPerFrame: bytes, sources: Object.fromEntries(sources) }) });
  expect(log.errors).toEqual([]);
  expect(bytes, 'sampled project allocations in bytes/frame').toBeLessThanOrEqual(1024);
});

test('Storm Chaos frame pacing during garbage collection', async ({ page }) => {
  await openScene(page, 'chaos', 'high', 'webgpu');
  await page.waitForTimeout(4000);
  const cdp = await page.context().newCDPSession(page);
  type Trace = { name: string; ph: string; pid: number; tid: number; ts: number; dur?: number };
  const events: Trace[] = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) if (event.name === 'lumina-gc-window' || /^(MinorGC|MajorGC|V8\.GCScavenger|V8\.GCCompactor)$/.test(event.name)) events.push({ name: event.name, ph: event.ph,
      pid: Number(event.pid), tid: Number(event.tid), ts: Number(event.ts), dur: Number(event.dur ?? 0) });
  });
  await cdp.send('Tracing.start', { categories: 'blink.user_timing,devtools.timeline,v8', transferMode: 'ReportEvents' });
  const sample = await page.evaluate(async () => {
    const times = new Float64Array(481);
    const marker = performance.mark('lumina-gc-window').startTime;
    const engine = (window as any).lumina.engine;
    const start = engine.stats.frames;
    await new Promise<void>(resolve => {
      let i = 0;
      const tick = (now: number) => {
        times[i++] = now;
        if (i < times.length) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { marker, times: Array.from(times), frames: engine.stats.frames - start };
  });
  const complete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
  await cdp.send('Tracing.end');
  await complete;
  await cdp.detach();
  const mark = events.find(e => e.name === 'lumina-gc-window');
  expect(mark, 'the real frame clock is aligned to the browser trace').toBeDefined();
  const offset = mark!.ts / 1000 - sample.marker;
  const gc = events.filter(e => e.ph === 'X' && e.pid === mark!.pid && e.tid === mark!.tid && (e.dur ?? 0) > 0);
  const missed: number[] = [];
  for (let i = 1; i < sample.times.length; i++) {
    const start = offset + sample.times[i - 1], end = offset + sample.times[i];
    if (end - start > 25 && gc.some(e => e.ts / 1000 < end && (e.ts + e.dur!) / 1000 > start)) missed.push(end - start);
  }
  const stats = { frames: sample.frames, mainThreadGcSpans: gc.length, missedFramesOverlappingGc: missed.length,
    longestGcMs: gc.reduce((max, e) => Math.max(max, e.dur! / 1000), 0) };
  console.log('Storm Chaos GC pacing', stats);
  test.info().annotations.push({ type: 'gc', description: JSON.stringify(stats) });
  expect(sample.frames).toBeGreaterThanOrEqual(475);
  expect(missed, '60 Hz frames overlapping GC and missing a vsync').toEqual([]);
});
