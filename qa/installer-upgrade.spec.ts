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
