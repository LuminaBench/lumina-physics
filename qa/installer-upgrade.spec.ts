import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/install-physics.mjs', import.meta.url));

test('selective upgrades keep existing imports and a conflict stays safe across retries', () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-existing-game-'));
  const dest = path.join(game, 'src/lumina-physics');
  const install = (...args: string[]) => spawnSync(process.execPath, [cli, '--engine', 'threejs', '--project', game, ...args], {encoding:'utf8'});
  try {
    const save = path.join(game, 'level.json');
    fs.writeFileSync(save, '{"seed":72}');
    expect(install('puddle-contacts', '--dry-run').status).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(install('puddle-contacts').status).toBe(0);
    const barrel = path.join(dest, 'index.ts'), ledger = path.join(dest, 'lumina-physics.manifest.json');
    const original = fs.readFileSync(barrel, 'utf8');
    const previous = fs.readFileSync(ledger, 'utf8');
    const incoming = path.join(dest, 'modules/materials/mineral-facets.ts');
    fs.mkdirSync(path.dirname(incoming), {recursive:true});
    fs.writeFileSync(incoming, '// game-owned surface');
    for (let retry=0; retry<2; retry++) {
      expect(install('mineral-facets').status).toBe(2);
      expect(fs.readFileSync(incoming, 'utf8')).toBe('// game-owned surface');
      expect(fs.readFileSync(barrel, 'utf8')).toBe(original);
      expect(fs.readFileSync(ledger, 'utf8')).toBe(previous);
    }
    fs.renameSync(incoming, incoming + '.host');
    expect(install('mineral-facets').status).toBe(0);
    const upgraded = fs.readFileSync(barrel, 'utf8');
    for(const line of original.split('\n').filter(line=>line.startsWith('export'))) expect(upgraded).toContain(line);
    expect(upgraded).toContain('mineral-facets');
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8')).entries).toEqual(expect.arrayContaining(['puddle-contacts','mineral-facets']));
    fs.appendFileSync(incoming, '\n// custom shader');
    expect(install('mineral-facets').status).toBe(2);
    expect(fs.readFileSync(incoming, 'utf8')).toContain('// custom shader');
    expect(fs.readFileSync(save, 'utf8')).toBe('{"seed":72}');
    // A linked install root must never send writes into a sibling project.
    fs.renameSync(dest, dest + '-original');
    const shared = path.join(game, 'shared');
    fs.mkdirSync(shared);
    fs.symlinkSync(shared, dest, 'dir');
    expect(install('puddle-contacts', '--force').status).toBe(1);
    expect(fs.readdirSync(shared)).toEqual([]);
  } finally {
    fs.rmSync(game, {recursive:true, force:true});
  }
});

test('project update performs a three-way comparison and keeps the original selection', () => {
  const root = path.dirname(path.dirname(cli));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-update-'));
  const game = path.join(temp, 'game');
  const incoming = path.join(temp, 'skill');
  const dest = path.join(game, 'src/lumina-physics');
  const ledger = path.join(dest, 'lumina-physics.manifest.json');
  const shader = 'modules/wet-road/puddle-contacts.ts';
  const spec = 'specs/05-wet-road-aquaplaning.md';
  const act = (tool: string, ...args: string[]) =>
    spawnSync(process.execPath, [tool, '--engine', 'threejs', '--project', game, ...args], { encoding: 'utf8' });
  fs.mkdirSync(game);
  try {
    expect(act(cli, '--update').status).toBe(1);
    expect(fs.existsSync(dest)).toBe(false);
    expect(act(cli, 'puddle-contacts', '--with-specs').status).toBe(0);
    const original = fs.readFileSync(ledger, 'utf8');
    const manifest = JSON.parse(original);
    const selected = Object.keys(manifest.files);
    // Build a second upstream revision without changing the actual checkout.
    const sourceFiles = ['scripts/install-physics.mjs', 'catalog.json', 'LICENSE',
      ...selected.filter(p => p !== 'LUMINA-LICENSE.txt' && p !== 'index.ts')];
    for (const file of sourceFiles) {
      fs.mkdirSync(path.dirname(path.join(incoming, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(incoming, file));
    }
    const tool = path.join(incoming, 'scripts/install-physics.mjs');
    const source = (file: string) => path.join(incoming, file);
    const copy = (file: string) => path.join(dest, file);
    fs.appendFileSync(copy(shader), '\n// game-owned shading');
    fs.appendFileSync(source(spec), '\nUpdated units.\n');
    const planned = act(tool, '--update', '--dry-run');
    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain('would write: ' + spec);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(original);
    expect(act(tool, '--update').status).toBe(0);
    expect(fs.readFileSync(copy(shader), 'utf8')).toContain('game-owned shading');
    expect(fs.readFileSync(copy(spec), 'utf8')).toEqual(fs.readFileSync(source(spec), 'utf8'));
    expect(fs.existsSync(copy('modules/water/ocean.ts'))).toBe(false);

    fs.appendFileSync(source(shader), '\n// revised upstream shader');
    fs.appendFileSync(source(spec), 'New storm range.\n');
    const before = fs.readFileSync(ledger, 'utf8');
    expect(act(tool, '--update').status).toBe(2);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(before);
    expect(fs.readFileSync(copy(spec), 'utf8')).not.toContain('New storm range.');
    expect(act(tool, '--update', '--keep-local', 'save.json').status).toBe(1);
    fs.appendFileSync(copy(shader), '\n// merged upstream change');
    expect(act(tool, '--update', '--keep-local', shader).status).toBe(0);
    const merged = fs.readFileSync(copy(shader), 'utf8');
    const settled = fs.readFileSync(ledger, 'utf8');
    expect(merged).toContain('game-owned shading');
    expect(merged).toContain('merged upstream change');
    expect(fs.readFileSync(copy(spec), 'utf8')).toContain('New storm range.');
    expect(act(tool, '--update').status).toBe(0);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(settled);
    expect(fs.readFileSync(copy(shader), 'utf8')).toBe(merged);
    expect(JSON.parse(settled).entries).toEqual(manifest.entries);

    fs.unlinkSync(copy(spec));
    expect(act(tool, '--update').status).toBe(0);
    expect(fs.existsSync(copy(spec))).toBe(false);
    fs.appendFileSync(source(spec), 'Another upstream change.\n');
    expect(act(tool, '--update').status).toBe(2);
    expect(fs.existsSync(copy(spec))).toBe(false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const [engine, destination] of [['godot', 'addons/lumina_physics'], ['unity', 'Assets/LuminaPhysics']]) {
  test(engine + ' project refresh retains native shader edits and previously selected components', () => {
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-adapter-'));
    const dest = path.join(game, destination);
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--engine', engine, '--project', game, ...args]);
    try {
      expect(run('puddle-contacts').status).toBe(0);
      const ledger = path.join(dest, 'lumina-physics.manifest.json');
      const before = fs.readFileSync(ledger, 'utf8');
      const shader = fs.readdirSync(dest).find(file => /\.(?:gdshader|shader)$/.test(file))!;
      const file = path.join(dest, shader);
      fs.appendFileSync(file, '\n// game material settings\n');
      expect(run('--update').status).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toContain('game material settings');
      expect(fs.readFileSync(ledger, 'utf8')).toBe(before);
    } finally { fs.rmSync(game, { recursive: true, force: true }); }
  });
}
