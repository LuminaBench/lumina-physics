#!/usr/bin/env node
/**
 * End-to-end check of the agent-skill packaging with the `skills` CLI, in a throw-away
 * HOME so nothing on this machine is touched:
 *
 *   1. export the tracked files of this repository to a clean temp directory
 *   2. npx skills add <export> -g      → the skill appears under the temp HOME
 *   3. run the installed skill's own search + installer (dry run) from that location
 *   4. npx skills update -g            → succeeds
 *   5. npx skills remove lumina-physics -g → the skill is gone
 *
 *   node scripts/verify-skill.mjs [--keep]
 *
 * Needs network access the first time (npx fetches the `skills` CLI). Telemetry is disabled
 * for the run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-skill-'));
const source = path.join(temp, 'lumina-physics'), home = path.join(temp, 'home'), work = path.join(temp, 'work');
for (const dir of [source, home, work]) fs.mkdirSync(dir, { recursive: true });

// 1. Clean export: exactly what a clone of the repository contains.
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  const to = path.join(source, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, file), to);
}
const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(root, f)).size, 0);
console.log(`exported ${files.length} tracked files (${(bytes / 1048576).toFixed(2)} MB)`);

const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' };
const steps = [];
function skills(args, label) {
  const result = spawnSync('npx', ['--yes', 'skills', ...args], { cwd: work, env, encoding: 'utf8', timeout: 180_000 });
  const ok = result.status === 0;
  steps.push({ label, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log((result.stdout + result.stderr).split('\n').slice(-12).join('\n'));
  return result;
}
/** Every place an agent directory could hold the skill under the temp HOME. */
function installed() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === 'lumina-physics' && fs.existsSync(path.join(full, 'SKILL.md'))) found.push(full);
      else if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'node_modules' && !entry.name.startsWith('.npm')) { try { if (fs.statSync(full).isDirectory()) walk(full, depth + 1); } catch { /* dangling link */ } }
    }
  };
  walk(home, 0);
  return found;
}
const check = (label, ok) => { steps.push({ label, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

// 2. add
skills(['add', source, '-g', '-y', '--agent', 'claude-code'], 'skills add . -g');
const after = installed();
check(`skill present under the temp HOME (${after.map((p) => path.relative(home, p)).join(', ') || 'nowhere'})`, after.length > 0);

// 3. the installed copy works on its own
if (after.length) {
  const dir = fs.realpathSync(after[0]);
  const search = spawnSync(process.execPath, [path.join(dir, 'scripts', 'search.mjs'), 'flag', 'wind'], { encoding: 'utf8' });
  check('installed scripts/search.mjs finds the cloth module', search.status === 0 && /cloth/.test(search.stdout));
  for (const [query, id] of [['independent engine out afterburner', 'aero'], ['sliding contact scrape wall', 'destruction'], ['drooping tree on a wet bank', 'recipe-willow-bank'], ['scalloped vesper cup', 'recipe-vesper-cup']]) {
    const lookup = spawnSync(process.execPath, [path.join(dir, 'scripts', 'search.mjs'), query, '--engine', 'threejs', '--json'], {encoding:'utf8'});
    check(`installed skill resolves "${query}"`, lookup.status === 0 && JSON.parse(lookup.stdout)[0]?.id === id);
  }
  const game = path.join(temp, 'game');
  fs.mkdirSync(game);
  const dry = spawnSync(process.execPath, [path.join(dir, 'scripts', 'install-physics.mjs'), '--engine', 'threejs', 'cloth', 'destruction', 'thermo', '--project', game, '--dry-run'], { encoding: 'utf8' });
  check('installed scripts/install-physics.mjs --dry-run resolves modules', dry.status === 0 && /cloth/.test(dry.stdout) && fs.readdirSync(game).length === 0);
  const installTool = path.join(dir, 'scripts', 'install-physics.mjs');
  const standalone = spawnSync(process.execPath, [installTool, '--engine', 'threejs', 'puddle-contacts', '--project', game], { encoding: 'utf8' });
  for (const [module, required, unrelated] of [
    ['mineral-facets', ['materials/mineral-facets.ts'], 'water/ocean.ts'],
    ['tidal-inlet', ['water/tidal-inlet.ts','water/wrack-drift.ts'], 'water/ocean.ts'],
    ['rain-column', ['weather/rain-column.ts','weather/rain-column-view.ts'], 'weather/weather.ts'],
    ['salt-crust', ['surface-deform/salt-crust.ts'], 'surface-deform/ground.ts'],
    ['wheel-grit', ['wet-road/wheel-grit.ts'], 'wet-road/vehicle.ts'],
    ['wheel-arch', ['wet-road/wheel-arch.ts'], 'wet-road/vehicle.ts'],
    ['coastal-contacts', ['coast/host.ts','coast/surf.ts','wet-road/tread-transfer.ts'], 'coast/habitat.ts'],
    ['coastal-world', ['coast/world.ts','coast/saltation.ts','weather/front.ts','weather/world-looks.json'], 'coast/habitat.ts']
  ]) {
    const coastalGame=path.join(work,module);
    fs.mkdirSync(coastalGame,{recursive:true});
    const selected=spawnSync(process.execPath,[installTool,'--engine','threejs',module,'--project',coastalGame],{env});
    const modules=path.join(coastalGame,'src/lumina-physics/modules');
    check('selective '+module+' install includes its required inputs',selected.status===0&&
      required.every(file=>fs.existsSync(path.join(modules,file)))&&!fs.existsSync(path.join(modules,unrelated)));
  }
  const gutterGame = path.join(work, 'drainage-game');
  fs.mkdirSync(gutterGame, {recursive:true});
  const gutter = spawnSync(process.execPath, [installTool, '--engine', 'threejs', 'street-drainage', '--project', gutterGame], {encoding:'utf8',env});
  const gutterFiles = path.join(gutterGame, 'src/lumina-physics');
  check('standalone roof and grate model installs with Three.js alone', gutter.status===0 &&
    fs.existsSync(path.join(gutterFiles, 'modules/wet-road/drainage.ts')) &&
    !fs.existsSync(path.join(gutterFiles, 'modules/water/ocean.ts')) && !gutter.stdout.includes('@dimforge'));
  const rainGame = path.join(work, 'rain-game');
  fs.mkdirSync(rainGame, {recursive:true});
  const rainInstall = spawnSync(process.execPath, [path.join(dir, 'scripts/install-physics.mjs'), '--engine', 'threejs', 'profile-rain', '--project', rainGame], {env});
  const rainModules = path.join(rainGame, 'src/lumina-physics/modules');
  check('rain attachment installs its profile and palette without ocean or landscape code', rainInstall.status === 0 &&
    fs.existsSync(path.join(rainModules, 'weather/attach-rain.ts')) && fs.existsSync(path.join(rainModules, 'weather/world-looks.json')) &&
    !fs.existsSync(path.join(rainModules, 'water/ocean.ts')) && !fs.existsSync(path.join(rainModules, 'terrain/foliage.ts')));
  const packetDir = path.join(game, 'src', 'lumina-physics');
  check('puddle-only game includes the packet shader and requires Three.js alone', standalone.status === 0
    && fs.existsSync(path.join(packetDir, 'modules/wet-road/puddle-contacts.ts'))
    && !fs.existsSync(path.join(packetDir, 'engine/physics.ts')) && /npm install three@/.test(standalone.stdout)
    && !standalone.stdout.includes('@dimforge'));
  for (const [engine, shader] of [['godot', 'lumina_wet_road.gdshader'], ['unity', 'LuminaWetRoad.shader']]) {
    const nativeDir = path.join(temp, engine);
    const result = spawnSync(process.execPath, [installTool, '--engine', engine, 'puddle-contacts', '--dest', nativeDir], { encoding: 'utf8' });
    check(`standalone ${engine} contact installation includes its road shader`, result.status === 0 && fs.existsSync(path.join(nativeDir, shader)));
  }
  const frontmatter = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^---\nname: (.+)\ndescription: (.+)\n---/);
  check('SKILL.md front matter (name + description ≤ 1024 chars)', !!frontmatter && frontmatter[1] === 'lumina-physics' && frontmatter[2].length <= 1024);
  check('SKILL.md under 400 lines', fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').split('\n').length < 400);
}

// 4. list + update
const list = skills(['list', '-g'], 'skills list -g');
check('lumina-physics is listed', /lumina-physics/.test(list.stdout + list.stderr));
skills(['update', '-g', '-y'], 'skills update -g');
check('skill still present after update', installed().length > 0);

// 5. remove
skills(['remove', 'lumina-physics', '-g', '-y'], 'skills remove lumina-physics -g');
check('skill removed from the temp HOME', installed().length === 0);

if (!keep) fs.rmSync(temp, { recursive: true, force: true });
const failed = steps.filter((s) => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} checks passed${keep ? `  (kept ${temp})` : ''}`);
process.exit(failed.length ? 1 : 0);
