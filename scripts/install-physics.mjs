#!/usr/bin/env node
/**
 * Install lumina-physics modules into a game project. The game owns the copy.
 *
 *   node scripts/install-physics.mjs --engine threejs --project /abs/path/to/game
 *   node scripts/install-physics.mjs --engine threejs ocean buoyancy --project /abs/game
 *   node scripts/install-physics.mjs --engine godot wet-road --project /abs/godot-project
 *   node scripts/install-physics.mjs --engine unity --dest /abs/Unity/Assets/LuminaPhysics
 *
 * Options
 *   --engine <threejs|godot|unity>   required
 *   --project <dir>                  project root (default destination is derived from it)
 *   --dest <dir>                     explicit destination folder
 *   --with-specs                     also copy the math specs for the installed modules
 *   --update                         refresh the modules recorded in this game's manifest
 *   --keep-local <installed path>    accept your merged copy during --update (repeatable)
 *   --dry-run                        preview changed paths without writing
 *   --force                          overwrite files you have edited since the last install
 *
 * Dependencies between modules are resolved automatically. Re-running is safe: files you
 * changed are reported as conflicts and left alone unless --force is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));

const args = process.argv.slice(2);
const opt = { engine: null, project: null, dest: null, withSpecs: false, dryRun: false, force: false, update: false, keepLocal: new Set() };
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--engine') opt.engine = args[++i];
  else if (a === '--project') opt.project = args[++i];
  else if (a === '--dest') opt.dest = args[++i];
  else if (a === '--with-specs') opt.withSpecs = true;
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '--force') opt.force = true;
  else if (a === '--update') opt.update = true;
  else if (a === '--keep-local') {
    const file = args[++i];
    if (!file || file.startsWith('--')) { console.error('--keep-local needs a manifest-relative file path'); process.exit(1); }
    opt.keepLocal.add(file);
  }
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
  else ids.push(a);
}
const fail = (message) => { console.error(`install-physics: ${message}`); process.exit(1); };
if (opt.update && ids.length) fail('--update uses the installed selection; use named modules separately to add a capability');
if (opt.keepLocal.size && (!opt.update || opt.force)) fail('--keep-local requires --update and cannot be combined with --force');
if (!Object.hasOwn(catalog.engines, opt.engine)) fail(`--engine must be one of ${Object.keys(catalog.engines).join(', ')}`);
if (!opt.dest && !opt.project) fail('pass --project <absolute project root> or --dest <absolute folder>');
const dest = path.resolve(opt.dest ?? path.join(opt.project, catalog.engines[opt.engine].dest));
if (opt.project && !fs.existsSync(opt.project)) fail(`project folder does not exist: ${opt.project}`);
// An inferred src/ or Assets/ path can be shared with another game through a
// symlink. Require the caller to select its physical location deliberately.
const projectRoot = opt.project ? path.resolve(opt.project) : null;
for (let candidate = dest; ; candidate = path.dirname(candidate)) {
  if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink())
    fail(`destination follows a link at ${candidate}; use --dest with the intended physical directory`);
  if (opt.dest || path.dirname(candidate) === projectRoot || path.dirname(candidate) === candidate) break;
}

// ---- resolve entries + dependency closure ---------------------------------
const byId = new Map(catalog.entries.map((e) => [e.id, e]));
const available = catalog.entries.filter((e) => e.engines?.[opt.engine]);
const selected = new Map();
const visit = (id) => {
  const entry = byId.get(id);
  if (!entry) fail(`unknown id "${id}". Try: node scripts/search.mjs ${id}`);
  if (entry.kind === 'recipe' && !entry.engines?.[opt.engine]?.files?.length) fail(`"${id}" is a recipe (parameters + specs), not an installable module. See SKILL.md → Remix.`);
  const target = entry.engines?.[opt.engine];
  if (!target) fail(`"${id}" has no ${opt.engine} implementation. It is specified in ${entry.specs.join(', ') || 'the Three.js sources'} – port from there.`);
  if (selected.has(id)) return;
  for (const dep of target.requires ?? []) visit(dep);
  selected.set(id, entry);
};
if (!opt.update) {
  const requested = ids.length ? ids : available.filter((e) => e.kind === 'module').map((e) => e.id);
  requested.forEach(visit);
}

// Serialize writers before reading the installed manifest. A dry run never creates the destination.
const manifestPath = path.join(dest, 'lumina-physics.manifest.json');
if (opt.update && !fs.existsSync(manifestPath)) fail('no installed manifest here; install a named module in this project first');
if (!opt.dryRun) {
  fs.mkdirSync(dest, { recursive: true });
  const lock = path.join(dest, '.lumina-install.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (err) {
    if (err.code === 'EEXIST') fail(`another install holds ${lock}; check its recorded PID before removing a stale lock`);
    throw err;
  }
  process.on('exit', () => fs.rmSync(lock, { force: true }));
}
if (fs.lstatSync(manifestPath, { throwIfNoEntry: false })?.isSymbolicLink()) fail('installed manifest is a game-owned link');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {}, entries: [] };
if (!previous.files || typeof previous.files !== 'object' || Array.isArray(previous.files)) fail('invalid installed manifest');
if (previous.engine && previous.engine !== opt.engine) fail(`destination already contains the ${previous.engine} adapter`);
if (previous.entries !== undefined && (!Array.isArray(previous.entries) || previous.entries.some(id => typeof id !== 'string')))
  fail('invalid module list in installed manifest');
if (opt.update) {
  if (!previous.entries?.length) fail('the installed manifest contains no module selection');
  for (const id of previous.entries) {
    if (byId.get(id)?.engines?.[opt.engine]) visit(id);
    else console.warn(`Keeping retired entry ${id} in the project`);
  }
  if (!selected.size) fail('none of the installed entries are available for this engine');
}
// An incremental install adds capabilities to the host's existing public entry point.
const installedIds = [...new Set([...(previous.entries ?? []), ...selected.keys()])];

// ---- build the file list ----------------------------------------------------
/** Map a repository path to its path inside the destination folder. */
const mapPath = (file) => (opt.engine === 'threejs' ? file : path.basename(file));
const files = new Map();
files.set('LUMINA-LICENSE.txt', fs.readFileSync(path.join(root, 'LICENSE')));
for (const entry of selected.values()) for (const file of entry.engines[opt.engine].files) files.set(mapPath(file), fs.readFileSync(path.join(root, file)));
if (opt.engine !== 'threejs') {
  const readme = path.join(root, 'adapters', opt.engine, 'README.md');
  if (fs.existsSync(readme)) files.set('README.md', fs.readFileSync(readme));
}
if (opt.engine === 'threejs') {
  // Generated barrel: only what was installed.
  const lines = ['// Generated by lumina-physics install-physics.mjs – safe to edit; re-running reports conflicts.'];
  for (const id of installedIds) lines.push(...(byId.get(id)?.engines.threejs?.exports ?? []));
  if (installedIds.some(id => !byId.has(id))) {
    // An older module can outlive its catalog entry. Preserve its working exports.
    const barrel = path.join(dest, 'index.ts');
    if (fs.lstatSync(barrel, { throwIfNoEntry: false })?.isFile()) lines.push(...fs.readFileSync(barrel, 'utf8').split('\n').filter(line => line.startsWith('export ')));
  }
  files.set('index.ts', Buffer.from([...new Set(lines)].join('\n') + '\n'));
}
for (const entry of selected.values()) for (const spec of entry.specs ?? []) {
  if (opt.withSpecs || (opt.update && Object.hasOwn(previous.files, spec)))
    files.set(spec, fs.readFileSync(path.join(root, spec)));
}
for (const relative of opt.keepLocal) {
  if (!files.has(relative) || !Object.hasOwn(previous.files, relative))
    fail(`--keep-local requires a previously installed file in this update: ${relative}`);
}

// ---- write with conflict detection ------------------------------------------
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const report = { written: [], unchanged: [], kept: [], conflicts: [] };
const manifest = { name: catalog.name, version: catalog.version, engine: opt.engine, entries: installedIds, installedAt: new Date().toISOString(), files: { ...previous.files } };
for (const [relative, content] of files) {
  const target = path.join(dest, relative);
  // Replacing a game-owned link or writing through a linked subdirectory
  // changes another asset's ownership. Leave these paths to the host.
  let check = dest;
  let stat;
  for (const part of relative.split('/')) {
    check = path.join(check, part);
    stat = fs.lstatSync(check, { throwIfNoEntry: false });
    if (!stat || (check === target ? !stat.isFile() : !stat.isDirectory())) break;
  }
  if (stat && (check !== target || !stat.isFile())) { report.conflicts.push(relative); continue; }
  const next = sha(content);
  const base = previous.files[relative];
  const current = stat ? sha(fs.readFileSync(target)) : undefined;
  if (current === next) {
    report.unchanged.push(relative);
    manifest.files[relative] = next;
    continue;
  }
  // In update mode an absent tracked file also represents a local edit. Keep
  // the upstream hash as the baseline so the next three-way comparison works.
  if (opt.keepLocal.has(relative) || (opt.update && !opt.force && next === base)) {
    report.kept.push(relative);
    manifest.files[relative] = next;
    continue;
  }
  if (!opt.force && current !== base && (opt.update || current !== undefined)) {
    report.conflicts.push(relative);
    continue;
  }
  report.written.push(relative);
  manifest.files[relative] = next;
}
// Validate the entire batch before changing any host file. In particular, never
// record an unowned file's hash as a pristine install just because it conflicted.
if (!opt.dryRun && !report.conflicts.length) {
  const atomicWrite = (target, bytes) => {
    const tmp = target + '.lumina-' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx' });
      fs.renameSync(tmp, target);
    } finally { fs.rmSync(tmp, { force: true }); }
  };
  for (const relative of report.written) {
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, files.get(relative));
  }
  const metadataChanged = previous.name !== manifest.name || previous.engine !== manifest.engine ||
    previous.version !== manifest.version || JSON.stringify(previous.entries) !== JSON.stringify(installedIds) ||
    JSON.stringify(previous.files) !== JSON.stringify(manifest.files);
  if (report.written.length || metadataChanged) atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`${opt.dryRun ? '[dry run] ' : ''}lumina-physics ${catalog.version} → ${dest}`);
console.log(`modules: ${[...selected.keys()].join(', ')}`);
console.log(`${opt.dryRun ? 'planned' : 'written'}: ${report.conflicts.length && !opt.dryRun ? 0 : report.written.length}   unchanged: ${report.unchanged.length}   conflicts: ${report.conflicts.length}`);
if (opt.dryRun) for (const file of report.written) console.log(`  would write: ${file}`);
for (const file of report.kept) console.log(`  kept game edit: ${file}`);
for (const file of report.conflicts) console.log(`  conflict (kept the game-owned path): ${file}`);
if (opt.engine === 'threejs') {
  const peer = catalog.engines.threejs.peer;
  const needed = new Set([...selected.values()].flatMap(entry => entry.engines.threejs.peers ?? Object.keys(peer)));
  console.log(`\nPeer dependencies: npm install ${Object.entries(peer).filter(([name]) => needed.has(name)).map(([name, range]) => `${name}@"${range}"`).join(' ')}`);
  console.log(`Import: import { … } from '${opt.project ? './' + path.relative(path.join(opt.project, 'src'), dest).replaceAll(path.sep, '/') : './lumina-physics'}';`);
} else {
  console.log(`\nSee ${path.join(dest, 'README.md')} for scene wiring.`);
}
process.exit(report.conflicts.length ? 2 : 0);
