// Capture reproducible moving frames from a local production preview. Set LUMINA_FFMPEG
// to an ffmpeg executable with MJPEG input and a libvpx-vp9 encoder.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.LUMINA_PREVIEW_URL ?? 'http://localhost:5285';
const landscape = process.argv.includes('--landscapes');
const output = path.resolve(
  process.env.LUMINA_CAPTURE_DIR ?? (landscape ? 'qa/output/landscapes-1.0' : 'qa/output/world-profiles-1.0'),
);
await mkdir(output, { recursive: true });
const looks = ['natural-daylight', 'golden-coast', 'cold-overcast', 'painterly', 'neon-night', 'alien-dusk'];
const jobs = looks.map((look) => ({
  id: look,
  route: '/profiles.html?manual=1&ui=0&look=' + look,
  profile: true,
  seconds: 4,
  fps: 24,
}));
if (landscape) {
  for (const biome of ['coastal-cliffs', 'temperate-river-valley', 'dry-highlands'])
    for (const view of ['headland', 'tire']) {
      jobs.push({
        id: biome + '-' + view,
        route: '/profiles.html?ui=0&manual=1&biome=' + biome + '&view=' + view,
        profile: true,
        seconds: 3,
        fps: 24,
      });
    }
  jobs.push({
    id: 'neon-night-after-dark',
    route: '/profiles.html?ui=0&manual=1&look=neon-night&hour=2',
    profile: true,
    seconds: 3,
    fps: 24,
  });
} else
  jobs.push(
    {
      id: 'coastal-flight',
      route: '/?scene=jet&tier=high',
      action: 'Fly through cloud',
      seconds: 6,
      fps: 24,
    },
    {
      id: 'wet-road-drive',
      route: '/?scene=highway&tier=high',
      action: 'Curbside puddle',
      seconds: 6,
      fps: 24,
    },
    {
      id: 'quiet-river',
      route: '/profiles.html?manual=1&ui=0&view=river',
      profile: true,
      seconds: 6,
      fps: 24,
    },
    {
      id: 'clearing-squall',
      route: '/profiles.html?manual=1&ui=0&view=clearing',
      profile: true,
      seconds: 13,
      fps: 60,
    },
  );
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'],
});
const manifest = [];
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' || /GPUValidationError|Error while parsing WGSL/i.test(m.text()))
        errors.push(m.text());
    });
    await page.goto(base + job.route);
    await page.waitForFunction(
      (profile) => (profile ? !!window.profileGallery : window.__luminaReady === true),
      !!job.profile,
    );
    if (job.action) await page.getByRole('button', { name: job.action, exact: true }).click();
    const params = await page.evaluate(
      ({ profile, fps }) => {
        const g = window.profileGallery,
          e = profile ? g.world.engine : window.lumina.engine;
        e.stop();
        const step = 1000 / fps;
        let now = performance.now();
        const copy = document.createElement('canvas');
        copy.width = 32;
        copy.height = 18;
        const ctx = copy.getContext('2d', { willReadFrequently: true });
        const image = e.renderer.domElement;
        // Subdivide each 24fps image into simulation ticks so sprung
        // motion and cloud history stay sampled at gameplay rates. Capture 60fps as single ticks.
        const substeps = Math.ceil(step / (1000 / 60));
        window.captureFrame = (still = false) => {
          for (let i = 0; i < substeps; i++) e.tick((now += step / substeps));
          ctx.drawImage(image, 0, 0, 32, 18);
          const d = ctx.getImageData(0, 0, 32, 18).data;
          let mean = 0,
            white = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] + 2 * d[i + 1] + d[i + 2]) / 1020;
            mean += l;
            if (l > 0.985) white++;
          }
          return {
            mean: mean / (32 * 18),
            white: white / (32 * 18),
            jpeg: image.toDataURL('image/jpeg', 0.88).split(',')[1],
            png: still ? image.toDataURL('image/png').split(',')[1] : null,
          };
        };
        // Identical pre-roll for all locked-camera comparisons.
        for (let i = 0; i < 22; i++) e.tick((now += 1000 / 60));
        return {
          seed: g?.world.profile.seed,
          biome: g?.world.profile.biome,
          look: g?.world.profile.look,
          backend: e.backend,
          renderScale: e.stats.renderScale,
        };
      },
      { profile: !!job.profile, fps: job.fps },
    );
    const video = path.join(output, job.id + '.webm');
    const encoder = spawn(
      process.env.LUMINA_FFMPEG ?? 'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        '-framerate',
        String(job.fps),
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-row-mt',
        '1',
        '-threads',
        '4',
        '-b:v',
        '3400k',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'webm',
        video,
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    const done = once(encoder, 'close');
    encoder.stdin.on('error', () => {});
    const luma = [],
      white = [];
    try {
      for (let i = 0; i < job.seconds * job.fps; i++) {
        const frame = await page.evaluate(
          (p) => window.captureFrame(p),
          i === Math.floor((job.seconds * job.fps) / 2),
        );
        if (frame.png) await writeFile(path.join(output, job.id + '.png'), Buffer.from(frame.png, 'base64'));
        if (encoder.exitCode !== null) throw new Error('Encoder exited ' + encoder.exitCode);
        if (!encoder.stdin.write(Buffer.from(frame.jpeg, 'base64'))) await once(encoder.stdin, 'drain');
        luma.push(frame.mean);
        white.push(frame.white);
      }
      encoder.stdin.end();
      const [code] = await done;
      if (code !== 0) throw new Error('Encoding failed: ' + code);
    } finally {
      if (encoder.exitCode === null) encoder.kill();
    }
    const minMean = Math.min(...luma),
      maxMean = Math.max(...luma),
      maxWhite = Math.max(...white);
    const maxJump = Math.max(...luma.slice(1).map((v, i) => Math.abs(v - luma[i])));
    if (errors.length || minMean < 0.003 || maxMean > 0.985 || maxWhite > 0.98)
      throw new Error(job.id + ': ' + JSON.stringify({ errors, minMean, maxMean, maxWhite }));
    if (job.id === 'clearing-squall' && maxJump > 0.14) throw new Error('Exposure discontinuity: ' + maxJump);
    const entry = {
      id: job.id,
      frames: luma.length,
      fps: job.fps,
      bytes: (await stat(video)).size,
      minMean,
      maxMean,
      maxWhite,
      maxJump,
      ...params,
    };
    manifest.push(entry);
    console.log(JSON.stringify(entry));
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const cards = manifest.map(
  (m) =>
    `<figure><video controls playsinline preload="none" poster="${m.id}.png" src="${m.id}.webm"></video><figcaption>${m.id.replaceAll('-', ' ')} · <a href="${m.id}.png">Full-size still</a></figcaption></figure>`,
);
await writeFile(
  path.join(output, 'index.html'),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>World Profiles 1.0</title><style>*{box-sizing:border-box}body{font:16px/1.5 system-ui;background:#10191d;color:#e9efed;max-width:1500px;margin:auto;padding:30px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:24px}figure{margin:0}video{width:100%;aspect-ratio:16/9;background:#000}figcaption{text-transform:capitalize}a{color:#9adbc4}</style><h1>World Profiles 1.0</h1><h2>Six looks on the same headland</h2><section>${cards.slice(0, 6).join('')}</section><h2>${landscape ? 'Three biomes at two camera heights and the coast after dark' : 'Gameplay and the clearing squall'}</h2><section>${cards.slice(6).join('')}</section></html>`,
);
