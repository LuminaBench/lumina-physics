import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('runtime, installer and clean showcase have no audio dependency', () => {
  const removed = 'lumina' + '-sfx';
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(Object.keys(pkg.scripts).filter(k => k === 'sfx' || k.startsWith('sfx:'))).toEqual([]);
  expect(fs.existsSync(path.join(root, 'public', removed))).toBe(false);
  for (const dir of ['engine', 'modules', 'adapters', 'showcase', 'scripts']) {
    for (const file of fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]) {
      if (!/\.(ts|js|mjs|md|cs|gd|json)$/.test(file)) continue;
      const text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      expect(text.includes(removed), path.join(dir, file)).toBe(false);
    }
  }
});
