/** Compare actual renderer revisions with the same host-authored coast, actors, seed and camera.
 * Usage: node qa/coast-reference.mjs [baseline-ref] [capture-directory]
 * Does not alter the checkout. Bundles stay in an isolated temporary directory. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.argv[2] ?? '2031913',
  out = path.resolve(process.argv[3] ?? 'qa/output/coast-reference');
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'coast-reference-'));
const hash = execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const legacy = path.join(folder, 'before');
await fs.mkdir(legacy);
const archive = path.join(folder, 'base.tar');
execFileSync('git', ['archive', '--format=tar', '-o', archive, hash], { cwd: root });
execFileSync('tar', ['-xf', archive, '-C', legacy]);
await fs.symlink(path.join(root, 'node_modules'), path.join(legacy, 'node_modules'), 'dir');
for (const file of [
  'coast.html',
  'showcase/coast.ts',
  'showcase/coast-vehicles.ts',
  'examples/coast',
  'modules/coast',
  'modules/weather/front.ts',
]) {
  await fs.cp(path.join(root, file), path.join(legacy, file), { recursive: true });
}
// The older renderer exposes its own sky, ocean, materials and waves. The host supplies
// identical geometry and camera fixtures to both. Explicitly omit newer local lighting and sand shaders.
const vehicleFile = path.join(legacy, 'showcase/coast-vehicles.ts');
const vehicleSource = await fs.readFile(vehicleFile, 'utf8');
// The legacy modules predate the park/resume hooks. Each reference page uses a single actor.
await fs.writeFile(
  vehicleFile,
  vehicleSource.replaceAll('.setEnabled(', '.setEnabled?.(').replace('.clearState()', '.clearState?.()'),
);
const worldFile = path.join(legacy, 'modules/coast/world.ts');
let source = await fs.readFile(worldFile, 'utf8');
function replace(pattern, next) {
  const old = source;
  source = source.replace(pattern, next);
  if (old === source) throw Error('Missing baseline fixture anchor ' + pattern);
}
// The fixed-exposure comparison uses the original weather constructor on the baseline.
replace('if (options.exposureResponse)', 'if (false)');
replace(/shadeTerrain:\s*sand\.shadeTerrain,?/, '');
replace(/sand\.attach\(bed, engine\.scene\);[\s\S]*?if \(engine\.physics\)/, 'if (engine.physics)');
replace(/shafts\.update\(engine\.camera\)/, 'shafts.root.visible=false');
replace(/grains = new Saltation\(world\);/, '');
replace(/\[sand\.detail!, \.\.\.extras\]/, 'extras');
await fs.writeFile(worldFile, source);
const shade = path.join(legacy, 'modules/coast/opening-light.ts');
await fs.writeFile(shade, 'export function addOpenShade(){return {dispose(){}};}');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=default'],
});
const routes = [
  { id: 'noon-shore', shore: 'cay', view: 'walk', hour: 12, eye: [3, 5.8, 1.5], target: [-8, -14, 0.36] },
  {
    id: 'low-sun-sand',
    shore: 'atlantic',
    view: 'walk',
    hour: 17.65,
    eye: [1.0, 9.0, 0.62],
    target: [0, 8.25, 0.04],
  },
  { id: 'night-road', shore: 'boulevard', view: 'drive', hour: 19.5, eye: [0, 0, 0], target: [0, 0, 0] },
  { id: 'cloud-edge', shore: 'cay', view: 'fly', hour: 16.6, eye: [0, 0, 0], target: [0, 0, 0] },
];
const report = {
  baseline: hash,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  routes: [],
};
try {
  for (const [revision, dir] of [
    ['before', legacy],
    ['after', root],
  ]) {
    const vite = await createServer({
      configFile: false,
      root: dir,
      cacheDir: path.join(folder, 'cache-' + revision),
      optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
      server: { host: 'localhost', port: 0, strictPort: false },
    });
    await vite.listen();
    try {
      for (const route of routes) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (e) => {
          if (e.type() === 'error' && !e.text().includes('favicon')) errors.push(e.text());
        });
        await page.goto(
          vite.resolvedUrls.local[0] +
            'coast.html?clean=1&tier=high&view=' +
            route.view +
            '&shore=' +
            route.shore,
        );
        await page.waitForFunction(() => window.coastDemo?.world.engine.stats.frames > 3, null, {
          timeout: 90000,
        });
        const metadata = await page.evaluate(async (route) => {
          const d = window.coastDemo,
            w = d.world,
            e = w.engine,
            T = window.THREE;
          e.stop();
          const clock = document.querySelector('#clock');
          clock.value = route.hour;
          clock.dispatchEvent(new Event('input'));
          e.onUpdate = e.onBeforeRender = null;
          e.paused = true;
          e.time = 4;
          w.weather.autoExposure = false;
          e.setDynamicResolution(false);
          const origin = w.coast.project(0, 0).along,
            point = (v) => {
              const p = w.coast.point(origin + v[0], v[1]);
              return new T.Vector3(p.x, w.ground(p.x, p.z) + v[2], p.z);
            };
          if (route.view === 'walk') {
            e.camera.position.copy(point(route.eye));
            e.camera.lookAt(point(route.target));
            w.setFocus(d.prints[1]);
            for (let i = 0; i < 48; i++)
              w.sediment.update(1 / 12, d.prints[1].x, d.prints[1].z, 0, w.ocean.optics.breakerHeight);
            w.sand.update(d.prints[1].x, d.prints[1].z, true);
          } else if (route.view === 'drive') {
            const p = d.road.road,
              x = p.x - 0.38,
              z = p.z - 9,
              body = d.vehicles.car;
            body.autopilot = false;
            body.input.throttle = body.input.steer = 0;
            body.input.brake = 1;
            body.chassis.setTranslation({ x, y: d.road.heightAt(x, z) + 0.68, z }, true);
            body.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
            body.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
            for (let i = 0; i < 120; i++) e.physics.step(1 / 60);
            e.physics.snap(body.chassis);
            body.update(0);
            if (body.wheels.some((w) => !w.contact))
              throw Error('Reference vehicle did not settle on all four tires');
            e.camera.position.set(x - 2.4, d.road.heightAt(x, z) + 1.36, z - 6.1);
            e.camera.lookAt(x, 0.9 + d.road.heightAt(x, z), z + 0.6);
          } else {
            const plane = d.vehicles.jet.object,
              eye = new T.Vector3(-610, 765, 355);
            plane.position.copy(eye);
            plane.rotation.set(0.06, -0.38, -0.1);
            e.camera.position.copy(eye).add(new T.Vector3(-7, 6.7, 22));
            e.camera.lookAt(eye);
          }
          const pose = e.camera.position.toArray(),
            rotation = e.camera.quaternion.toArray();
          for (let i = 0; i < 18; i++) {
            e.tick(performance.now());
            await new Promise(requestAnimationFrame);
          }
          return {
            pose,
            rotation,
            backend: e.backend,
            scale: e.stats.renderScale,
            clock: Number(clock.value),
            seed: w.coast.seed,
            exposure: w.weather.params.exposure,
            fov: e.camera.fov,
            cloudFormation: w.front.options.type,
            clockHours: route.hour,
          };
        }, route);
        await page.screenshot({ path: path.join(out, revision + '-' + route.id + '.jpg'), quality: 89 });
        await page.close();
        console.log(revision, route.id, errors.length);
        if (errors.length) throw Error(errors.join('\n'));
        report.routes.push({ revision, id: route.id, ...metadata });
      }
    } finally {
      await vite.close();
    }
  }
  for (const row of report.routes.filter((r) => r.revision === 'after')) {
    const baseline = report.routes.find((r) => r.id === row.id && r.revision === 'before');
    for (const field of ['pose', 'rotation', 'clock', 'seed', 'backend'])
      if (JSON.stringify(row[field]) !== JSON.stringify(baseline[field]))
        throw Error('Unmatched ' + row.id + ' ' + field);
  }
  await fs.writeFile(path.join(out, 'comparison.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await fs.rm(folder, { recursive: true, force: true });
}
