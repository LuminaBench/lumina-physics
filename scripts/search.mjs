#!/usr/bin/env node
/**
 * Search the lumina-physics catalog.
 *
 *   node scripts/search.mjs tsunami wave
 *   node scripts/search.mjs car puddle --engine godot --json
 *   node scripts/search.mjs --kind recipe
 *
 * Tries the literal query first, then the effect terms in a plain-language request.
 * Matches id, title, summary, tags or parameter names. Reads the local catalog.
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
    for (const [text, weight] of fields) {
      if (!text.includes(word)) continue;
      const whole = text.split(/[^a-z0-9]+/).includes(word);
      best = Math.max(best, weight * (text === word ? 3 : whole ? 2 : 1));
    }
    if (best === 0) return 0;
    total += best;
  }
  return terms.length ? total : 1;
};

const entries = catalog.entries
  .filter((e) => !flags.kind || e.kind === flags.kind)
  .filter((e) => !flags.engine || (e.kind === 'recipe' && !Object.keys(e.engines ?? {}).length) || e.engines?.[flags.engine]);
const rank = (terms, preferHost = false) => entries.map(entry => {
  let points = score(entry, terms);
  if (points && preferHost && entry.tags.some(tag => /\b(host|attach|existing)\b/.test(tag))) points += 8;
  return { entry, score: points };
})
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score);

// Preserve an exact phrase if available. Agent tools often pass a whole
// query as one argument even when its words occur in different fields.
let results = rank(words);
if (!results.length && words.some(term => /\s/.test(term))) {
  const tokens = words.flatMap(term => term.trim().split(/\s+/)).filter(Boolean);
  if (tokens.length) results = rank(tokens);
}

if (!results.length) {
  // Keep literal searches first. On a miss, discard request phrasing while
  // requiring every remaining subject to match the same entry.
  const requestWords = new Set([
    'a','an','the','my','our','in','on','with','at','of','for','from','to','and','is','can','you','please',
    'add','make','improve','upgrade','replace','tune','fix','existing','current','game','project','effect','effects',
  ]);
  const tokens = words.flatMap(word => word.split(/[^a-z0-9]+/));
  const preferHost = tokens.some(word => ['existing', 'replace', 'upgrade'].includes(word));
  const terms = tokens.filter(word => word && !requestWords.has(word));
  if (terms.length) results = rank(terms, preferHost);
  if (!results.length && terms.length) {
    const equivalents = new Map([['tyre','tire'], ['tyres','tire'], ['tires','tire'], ['vapour','vapor']]);
    results = rank(terms.map(term => equivalents.get(term) ?? term), preferHost);
  }
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
