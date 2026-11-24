/** Measure actual steering and travel on two successive visits. Each trial gets a new browser profile. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const [baseURL = 'http://localhost:4173', folder = 'qa/output/headland-start', tries = '3'] =
  process.argv.slice(2);
await fs.mkdir(folder, { recursive: true });
for (const backend of ['webgpu', 'webgl2']) {
  for (let trial = 1; trial <= Number(tries); trial++) {
    const browser = await chromium.launch({
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
      });
      await page.addInitScript(() => {
        const stats = (window.startTrace = {
          firstPose: null,
          firstSteer: null,
          firstMovement: null,
          scale: null,
          frames: 0,
          previous: 0,
          intervals: [],
          longTasks: [],
          backend: null,
        });
        if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
          new PerformanceObserver((entries) => {
            for (const e of entries.getEntries()) stats.longTasks.push([e.startTime, e.duration]);
          }).observe({ type: 'longtask', buffered: true });
        function sample(now) {
          const d = window.coastDemo,
            e = d?.world?.engine,
            c = d?.vehicles?.car;
          if (e?.stats.frames > 0 && c?.root.visible && e.stats.frames !== stats.frames) {
            stats.backend = e.backend;
            stats.scale = e.stats.renderScale;
            const p = c.root.position;
            stats.firstPose ??= [p.x, p.z];
            if (c.input.steer > 0.5 && stats.firstSteer === null) stats.firstSteer = now;
            if (
              stats.firstSteer !== null &&
              stats.firstMovement === null &&
              Math.hypot(p.x - stats.firstPose[0], p.z - stats.firstPose[1]) > 0.06
            )
              stats.firstMovement = now;
            if (stats.previous && stats.firstMovement !== null) stats.intervals.push(now - stats.previous);
            stats.previous = now;
            stats.frames = e.stats.frames;
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      const url = new URL('/coast.html', baseURL);
      url.search = new URLSearchParams({
        shore: 'boulevard',
        view: 'drive',
        tier: 'medium',
        backend: backend === 'webgl2' ? 'webgl' : 'webgpu',
      });
      for (const visit of ['cold', 'warm']) {
        await page.goto(url.href, { waitUntil: 'commit' });
        const deadline = Date.now() + 90000;
        do {
          await page.keyboard.down('d');
          await page.waitForTimeout(80);
          if (Date.now() > deadline) throw Error('Driver failed to respond: ' + errors.join(', '));
        } while (!(await page.evaluate(() => window.startTrace?.firstMovement)));
        await page.keyboard.up('d');
        await page.waitForTimeout(6500);
        const row = await page.evaluate(() => {
          const s = window.startTrace,
            sorted = s.intervals.slice().sort((a, b) => a - b);
          return {
            firstPose: s.firstPose,
            firstSteer: s.firstSteer,
            firstMovement: s.firstMovement,
            scale: s.scale,
            backend: s.backend,
            renderedFrames: s.frames,
            p95: sorted[Math.floor(sorted.length * 0.95)],
            worst: sorted.at(-1),
            over50: s.intervals.filter((x) => x > 50).length,
            longTasks: s.longTasks,
            milestones: performance.getEntriesByType('measure').map((e) => [e.name, e.startTime, e.duration]),
          };
        });
        if (row.backend !== backend || errors.length) throw Error(JSON.stringify({ backend, row, errors }));
        const record = { backend, visit, trial, scene: 'boulevard', tier: 'medium', ...row, errors };
        await fs.writeFile(
          path.join(folder, `${backend}-${trial}-${visit}.json`),
          JSON.stringify(record, null, 2),
        );
        console.log(
          backend,
          trial,
          visit,
          'first movement ms',
          Math.round(row.firstMovement),
          'worst interval ms',
          row.worst.toFixed(1),
        );
      }
    } finally {
      await browser.close();
    }
  }
}
