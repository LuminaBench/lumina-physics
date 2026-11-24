/** Exercise the selectively installed inland recipe from a blank local game, offline. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
const repo = fileURLToPath(new URL('..', import.meta.url)),
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'inland-track-'));
let server;
try {
  await fs.symlink(path.join(repo, 'node_modules'), path.join(work, 'node_modules'), 'dir');
  execFileSync(
    process.execPath,
    [
      path.join(repo, 'scripts/install-physics.mjs'),
      '--engine',
      'threejs',
      'recipe-inland-sediment',
      '--project',
      work,
    ],
    { stdio: 'pipe' },
  );
  const root = path.join(work, 'src/lumina-physics');
  assert.equal(
    await fs.stat(path.join(root, 'modules/water/ocean.ts')).then(
      () => true,
      () => false,
    ),
    false,
  );
  server = await createServer({
    configFile: false,
    root: work,
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    cacheDir: path.join(work, 'vite-cache'),
  });
  const { attachInlandTrack, TRAIL_SOILS } = await server.ssrLoadModule(
    '/src/lumina-physics/examples/coast/inland-track.ts',
  );
  const results = [];
  for (const type of Object.keys(TRAIL_SOILS)) {
    let rain = 1;
    const host = { heightAt: (x, z) => 2 + 0.018 * x + 0.014 * z, rainAt: () => rain };
    const track = attachInlandTrack(type, host, 354);
    for (let i = 0; i < 12; i++) track.update(1 / 12, 0, 0, -20, 0);
    track.sediment.imprint('foot', 0.02, 0.02, -0.36, 0.16, 0.31, 1.25);
    track.sediment.imprint('foot', 0.02, 0.02, 0.19, 0.16, 0.31, 0.45);
    rain = 0;
    for (let i = 0; i < 144; i++) track.update(1 / 12, 0, 0, -20, 0);
    const { film, relief } = track.sediment.inspect(0.02, 0.02),
      save = track.sediment.save();
    assert.ok(relief < -0.01 && film > 0 && film < 0.9);
    track.dispose();
    const copy = attachInlandTrack(type, { ...host, save }, 354);
    assert.ok(Math.abs(copy.sediment.inspect(0.02, 0.02).relief - relief) < 0.00051);
    copy.dispose();
    results.push({ type, film, relief });
  }
  assert.ok(results[0].film > results[1].film && results[1].film > results[2].film);
  assert.ok(results[0].relief < results[1].relief && results[1].relief < results[2].relief);
  console.log(JSON.stringify(results));
} finally {
  await server?.close();
  await fs.rm(work, { recursive: true, force: true });
}
