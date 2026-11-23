#!/usr/bin/env node
/**
 * Search the lumina-physics catalog.
 *
 *   node scripts/search.mjs tsunami wave
 *   node scripts/search.mjs car puddle --engine godot --json
 *   node scripts/search.mjs --kind recipe
 *
 * Every word must match (id, title, summary, tags or parameter names). Broaden the query
 * if nothing comes back. Offline; reads catalog.json next to this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));

const args = process.argv.slice(2);
const flags = { json: false, kind: null, engine: null };
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') flags.json = true;
  else if (a === '--kind') flags.kind = args[++i];
  else if (a === '--engine') flags.engine = args[++i];
  else if (a === '--help' || a === '-h') { console.log('usage: search.mjs [words…] [--kind module|rig|recipe] [--engine threejs|godot|unity] [--json]'); process.exit(0); }
  else words.push(a.toLowerCase());
}

const score = (entry, terms) => {
  const fields = [
    [entry.id, 6], [entry.title.toLowerCase(), 4], [entry.tags.join(' ').toLowerCase(), 3],
    [entry.summary.toLowerCase(), 1], [(entry.params ?? []).map((p) => p.name).join(' ').toLowerCase(), 1],
  ];
  let total = 0;
  for (const word of terms) {
    let best = 0;
    for (const [text, weight] of fields) if (text.includes(word)) best = Math.max(best, weight);
    if (best === 0) return 0;
    total += best;
  }
  return terms.length ? total : 1;
};

const entries = catalog.entries
  .filter((e) => !flags.kind || e.kind === flags.kind)
  .filter((e) => !flags.engine || e.kind === 'recipe' || e.engines?.[flags.engine]);
const rank = terms => entries.map(entry => ({ entry, score: score(entry, terms) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score);

// Preserve an exact phrase if available. Agent tools often pass a whole
// query as one argument even when its words occur in different fields.
let results = rank(words);
if (!results.length && words.some(term => /\s/.test(term))) {
  const tokens = words.flatMap(term => term.trim().split(/\s+/)).filter(Boolean);
  if (tokens.length) results = rank(tokens);
}

if (flags.json) {
  console.log(JSON.stringify(results.map(({ entry }) => ({
    id: entry.id, kind: entry.kind, title: entry.title, summary: entry.summary, tags: entry.tags, params: entry.params,
    specs: entry.specs, engines: Object.keys(entry.engines ?? {}),
    files: flags.engine ? entry.engines?.[flags.engine]?.files ?? [] : undefined,
  })), null, 2));
} else if (results.length === 0) {
  console.log('No matches. Try fewer or broader words (e.g. "water", "storm", "car", "fire").');
} else {
  for (const { entry } of results) {
    const engines = Object.keys(entry.engines ?? {}).join(', ') || 'recipe (parameters + specs)';
    console.log(`${entry.id.padEnd(22)} [${entry.kind}] ${entry.title}`);
    console.log(`${' '.repeat(22)} ${entry.summary.slice(0, 150)}${entry.summary.length > 150 ? '…' : ''}`);
    console.log(`${' '.repeat(22)} engines: ${engines}${entry.specs?.length ? `   specs: ${entry.specs.join(', ')}` : ''}\n`);
  }
}
