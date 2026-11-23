// Review the actual full-resolution WebGPU captures with the locally authenticated Neon CLI.
// Usage: node qa/grade.mjs [scene ...]  (run qa:visual first)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const output = fileURLToPath(new URL('./output/', import.meta.url));
const all = ['lagoon', 'jet', 'highway', 'fire', 'chaos', 'landfall', 'playground', 'river',
  'rotor-water', 'rotor-snow', 'listing-boat', 'cloud-pass', 'street-wading', 'crash-glass', 'waterspout', 'river-rescue'];
const scenes = process.argv.length > 2 ? [...new Set(process.argv.slice(2))] : all;
const model = 'gemini-4-neon-high';
const reviews = [];
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-frames-'));

async function review(scene) {
  if (!all.includes(scene)) throw new Error('Unknown scene ' + scene);
  const buffer = await fs.readFile(path.join(output, 'captures', 'webgpu-' + scene + '.png'));
  const png = PNG.sync.read(buffer);
  if (png.width !== 1920 || png.height !== 1080) throw new Error(scene + ' needs a 1920×1080 capture');
  const dir = path.join(folder, scene);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'frame.png'), buffer);
  const prompt = 'Use your image viewing tool to open frame.png at its native 1920x1080 resolution. ' +
    'Evaluate this real-time rendering against real photographs and high-end open-world game imagery. ' +
    'Assess composition, physical light, water/ground materials, scale, silhouettes, contact shadows, aliasing, artifacts and motion cues visible in the still. ' +
    'Return only JSON with viewed (boolean), score (number 0-10), observation (describe specific objects and their screen positions so the review is verifiable), fixes (array of 1-3 concrete fixes). ' +
    'Use viewed=false if the pixels could not be inspected. Grade candidly. Only inspect the supplied image.';
  const result = await new Promise((resolve, reject) => {
    const child = spawn('agy', ['--model', model, '--sandbox', '--mode', 'plan', '--print-timeout', '5m', '-p', prompt], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-1000) || out.slice(-1000))));
  });
  const parsed = JSON.parse(result.replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ''));
  if (parsed.viewed !== true || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 10 || !parsed.observation || !Array.isArray(parsed.fixes)) {
    throw new Error('Missing visual assessment: ' + result.slice(0, 500));
  }
  return { scene, sha256: createHash('sha256').update(buffer).digest('hex'), viewed: true,
    score: parsed.score, observation: parsed.observation, fixes: parsed.fixes };
}

try {
  const pending = [...scenes];
  let quotaError;
  async function worker() {
    while (pending.length) {
      const scene = pending.shift();
      if (quotaError) reviews.push({ scene, error: 'Review pending. ' + quotaError });
      else {
        try { reviews.push(await review(scene)); }
        catch (e) {
          const message = String(e);
          if (/individual quota reached/i.test(message)) quotaError = message;
          reviews.push({ scene, error: message });
        }
      }
      console.log(JSON.stringify(reviews.at(-1)));
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  reviews.sort((a, b) => all.indexOf(a.scene) - all.indexOf(b.scene));
  const report = { createdAt: new Date().toISOString(), model, width: 1920, height: 1080, target: 9.2, reviews };
  await fs.writeFile(path.join(output, 'neon-' + report.createdAt.replaceAll(':', '-') + '.json'), JSON.stringify(report, null, 2));
  if (reviews.some(r => r.error || r.score < report.target)) process.exitCode = 1;
} finally {
  await fs.rm(folder, { recursive: true, force: true });
}
