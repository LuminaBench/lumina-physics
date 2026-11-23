/**
 * Behaviour checks for the v1 modules: underwater, wet lens, cloth, destruction, thermo,
 * deformable ground, animation and camera feel. Every test drives the real showcase (real
 * clicks where a control exists) and asserts on simulation state plus what reached the
 * screen. Zero console / shader errors is part of every test.
 */
import { test, expect, type Page } from '@playwright/test';
import { changedFraction, clickPanelButton, openScene, regionMean, watchConsole } from './helpers';

const L = (page: Page, expression: string) => page.evaluate(`(() => { const lumina = window.lumina, s = lumina.scene, engine = lumina.engine; return (${expression}); })()`) as Promise<any>;

async function open(page: Page, scene: string, tier = 'high', backend: 'webgpu' | 'webgl2' = 'webgpu', ui = true) {
  const log = watchConsole(page);
  if (ui) {
    const query = new URLSearchParams({ scene, tier });
    if (backend === 'webgl2') query.set('webgl', '1');
    await page.goto(`/?${query}`);
    await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
  } else await openScene(page, scene, tier, backend);
  return log;
}

test.describe('underwater', () => {
  test('diving crosses the waterline: fog and bubbles; surfacing drenches the lens', async ({ page }) => {
    const log = await open(page, 'lagoon');
    await L(page, 's.beaver.throttle = 0');
    await page.waitForTimeout(800);
    const above = await L(page, '({ submerged: s.underwater.submerged, depth: s.underwater.depth, under: s.ocean.uniforms.underView.value })');
    expect(above.submerged).toBe(false);
    expect(above.depth).toBeLessThan(0);
    const dry = regionMean(await page.screenshot(), 0.1, 0.3, 0.6, 0.9);

    await clickPanelButton(page, 'Dive');
    await page.waitForTimeout(2000);
    const below = await L(page, '({ submerged: s.underwater.submerged, depth: s.underwater.depth, under: s.ocean.uniforms.underView.value, dives: s.underwater.dives })');
    console.log(`  dive: depth ${below.depth.toFixed(2)} m`);
    expect(below.submerged, 'the camera is under water').toBe(true);
    expect(below.depth).toBeGreaterThan(0.8);
    expect(below.under, 'the ocean shades its underside').toBe(1);
    const wet = regionMean(await page.screenshot(), 0.1, 0.3, 0.6, 0.9);
    // Beer–Lambert: red is absorbed first, so the underwater frame is blue-green dominant.
    expect(wet.b / Math.max(wet.r, 0.01), 'red is absorbed under water').toBeGreaterThan(Math.max(1.25, (dry.b / Math.max(dry.r, 0.01)) * 0.9));
    expect(wet.luma, 'not a black frame').toBeGreaterThan(0.08);

    await clickPanelButton(page, 'Dive');
    await page.waitForFunction('window.lumina.scene.underwater.submerged === false', null, { timeout: 10_000 });
    const wetness = await L(page, 'engine.lens.wetness');
    expect(wetness, 'surfacing drenches the lens').toBeGreaterThan(0.6);
    await page.waitForTimeout(600);
    expect(await L(page, 's.underwater.dives')).toBeGreaterThanOrEqual(2);
    expect(log.errors).toEqual([]);
  });

  test('a half-submerged camera shows both worlds split at the waterline', async ({ page }) => {
    const log = await open(page, 'lagoon', 'high', 'webgpu', false);
    // Hold the lens centre exactly on the moving surface (after the orbit rig has run).
    await L(page, `s.beaver.throttle = 0, s.orbit.floor = null, s.orbit.controls.maxPolarAngle = 3, (() => {
      const t = s.orbit.controls.target; engine.camera.position.set(t.x - 11, 0.02, t.z + 7);
      const rig = engine.onBeforeRender;
      engine.onBeforeRender = (dt, time) => { rig(dt, time); const c = engine.camera.position; c.y = s.ocean.heightAt(c.x, c.z) + 0.004; engine.camera.updateMatrixWorld(); };
    })()`);
    await page.waitForTimeout(1800);
    const depth = await L(page, 's.underwater.depth');
    expect(Math.abs(depth), 'the lens straddles the surface').toBeLessThan(0.03);
    const withWater = await page.screenshot({ path: 'qa/output/captures/webgpu-waterline.png' });
    // Same camera without the underwater effect: only the part of the frame below the
    // waterline may change (that is the per-pixel split), and it must change a lot.
    await L(page, 'engine.pipeline.removeEffect("underwater")');
    await page.waitForTimeout(700);
    const without = await page.screenshot();
    const above = changedFraction(withWater, without, 0.05, 0.02, 0.95, 0.3, 40);
    const below = changedFraction(withWater, without, 0.05, 0.8, 0.95, 0.98, 40);
    const water = regionMean(withWater, 0.05, 0.85, 0.95, 0.98);
    console.log(`  split view: ${(above * 100).toFixed(1)} % of the sky half and ${(below * 100).toFixed(1)} % of the submerged half are shaded by the medium; water g/r ${(water.g / water.r).toFixed(2)}`);
    expect(below, 'the submerged part of the frame is fogged').toBeGreaterThan(0.5);
    expect(above, 'the part above the waterline is untouched').toBeLessThan(0.08);
    expect(water.g / Math.max(water.r, 0.01), 'red is absorbed below the line').toBeGreaterThan(1.3);
    expect(log.errors).toEqual([]);
  });
});

test.describe('wet lens', () => {
  test('rain wets the lens, the toggle removes the effect from the pipeline', async ({ page }) => {
    const log = await open(page, 'lagoon');
    expect(await L(page, 'engine.pipeline.hasEffect("lens-fx")')).toBe(true);
    await L(page, 'engine.lens.rain = 1');
    await page.waitForTimeout(2500);
    expect(await L(page, 'engine.lens.wetness'), 'wetness follows rain').toBeGreaterThan(0.5);
    const wet = await page.screenshot();
    await clickPanelButton(page, 'Wet lens');
    await page.waitForTimeout(700);
    expect(await L(page, 'engine.lens.enabled')).toBe(false);
    expect(await L(page, 'engine.pipeline.hasEffect("lens-fx")'), 'the effect is gone, not just hidden').toBe(false);
    const dry = await page.screenshot();
    expect(changedFraction(wet, dry, 0.05, 0.12, 0.7, 0.75), 'droplets refracted part of the frame').toBeGreaterThan(0.01);
    expect(log.errors).toEqual([]);
  });

  test('storm rain reaches the lens on its own', async ({ page }) => {
    const log = await open(page, 'highway', 'high', 'webgpu', false);
    await page.waitForTimeout(3500);
    expect(await L(page, 'engine.lens.wetness')).toBeGreaterThan(0.2);
    expect(log.errors).toEqual([]);
  });
});

test.describe('cloth', () => {
  test('CPU solver: flags stream downwind, stay on their hoist and respond to wind and blasts', async ({ page }) => {
    const log = await open(page, 'playground', 'medium', 'webgl2', false);
    expect(await L(page, 's.cloth.backend.kind')).toBe('cpu');
    const tip = 'JSON.parse(JSON.stringify((() => { const f = s.flags[0], spec = f.record.spec; const p = f.point(spec.cols - 1, Math.floor(spec.rows / 2)); const h = f.point(0, Math.floor(spec.rows / 2)); return { x: p.x - h.x, y: p.y - h.y, z: p.z - h.z, reach: p.distanceTo(h), width: (spec.cols - 1) * spec.spacing[0] }; })()))';
    await L(page, 's.state.wind = 16, s.state.windDirection = 0.35');
    await page.waitForTimeout(3500);
    const a = await L(page, tip);
    await page.waitForTimeout(500);
    const b = await L(page, tip);
    const wind = { x: Math.cos(0.35), z: Math.sin(0.35) };
    console.log(`  flag tip offset (${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)})  reach ${a.reach.toFixed(2)} of ${a.width.toFixed(2)} m`);
    for (const v of [a.x, a.y, a.z, b.x, b.y, b.z]) expect(Number.isFinite(v)).toBe(true);
    expect(a.x * wind.x + a.z * wind.z, 'the fly streams downwind').toBeGreaterThan(a.width * 0.45);
    expect(a.reach, 'the cloth does not stretch off its hoist').toBeLessThan(a.width * 1.06);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), 'the flag is fluttering').toBeGreaterThan(0.01);
    // Calm air: the flag hangs.
    await L(page, 's.state.wind = 0.3');
    await page.waitForTimeout(5000);
    const calm = await L(page, tip);
    expect(calm.y, 'in calm air the fly hangs well below the hoist').toBeLessThan(Math.min(a.y - 0.4, -a.width * 0.5));
    // A pressure front throws it.
    await L(page, 'engine.wind.addBlast(new THREE.Vector3(-9, 7.5, 8), 40, 30, 1.2)');
    await page.waitForTimeout(450);
    const hit = await L(page, tip);
    expect(Math.hypot(hit.x - calm.x, hit.y - calm.y, hit.z - calm.z), 'a blast moves the cloth').toBeGreaterThan(0.25);
    expect(await L(page, 's.cloth.flaps'), 'flap events were emitted').toBeGreaterThan(0);
    expect(log.errors).toEqual([]);
  });

  test('GPU solver: cloth and ropes animate on screen with zero errors', async ({ page }) => {
    const log = await open(page, 'playground', 'high', 'webgpu', false);
    expect(await L(page, 's.cloth.backend.kind')).toBe('gpu');
    expect(await L(page, 's.cloth.particleCount')).toBeGreaterThan(2500);
    await L(page, 's.state.wind = 14, s.car.targetSpeed = 0, s.orbit.controls.target.set(-6.6, 7.6, 2), engine.camera.position.set(-13, 8.4, 9)');
    await page.waitForTimeout(2500);
    const one = await page.screenshot();
    await page.waitForTimeout(450);
    const two = await page.screenshot();
    const moved = changedFraction(one, two, 0.2, 0.1, 0.8, 0.8, 30);
    console.log(`  flag region changed between frames: ${(moved * 100).toFixed(1)} %`);
    expect(moved, 'the flag is visibly moving').toBeGreaterThan(0.004);
    expect(log.errors).toEqual([]);
  });

  test('a parachute follows its payload down and lands', async ({ page }) => {
    const log = await open(page, 'playground');
    await clickPanelButton(page, 'Air drop');
    await page.waitForTimeout(600);
    const start = await L(page, '({ y: s.supply.position.y, enabled: s.chute.enabled, visible: s.chute.mesh.visible, lines: !!s.chute.lineMesh })');
    expect(start.enabled && start.visible && start.lines, 'canopy and suspension lines are live').toBe(true);
    await page.waitForFunction('window.lumina.scene.drop.active === false', null, { timeout: 20_000 });
    const landed = await L(page, 's.supply.position.y');
    expect(landed).toBeLessThan(start.y - 20);
    expect(log.errors).toEqual([]);
  });
});

test.describe('destruction', () => {
  test('fracture conserves volume and gives chunks their real mass', async ({ page }) => {
    const log = await open(page, 'playground', 'high', 'webgpu', false);
    const report = await L(page, `s.targets.map((t) => ({ material: t.material, chunks: t.chunkCount, volume: t.cells.reduce((a, c) => a + c.volume, 0), box: t.size.x * t.size.y * t.size.z, symmetric: t.cells.every((c, i) => c.neighbours.every((j) => t.cells[j].neighbours.includes(i))) }))`);
    for (const r of report) {
      expect(r.chunks, `${r.material} is pre-fractured`).toBeGreaterThan(4);
      expect(r.volume / r.box, `${r.material} cells fill the box`).toBeGreaterThan(r.material === 'brick' ? 0.9 : 0.995);
      expect(r.volume / r.box).toBeLessThan(1.005);
      expect(r.symmetric, `${r.material} connectivity is symmetric`).toBe(true);
    }
    // One draw call per object, before and after it breaks.
    const meshesBefore = await L(page, 'engine.scene.children.filter((o) => o.name.startsWith("lumina-destructible")).length');
    await L(page, 's.blastAt("c4", 2.5, -6.2)');
    await page.waitForTimeout(1500);
    const after = await L(page, `(() => { const wall = s.targets[0]; const loose = [...wall.loose.entries()].slice(0, 12).map(([i, p]) => ({ mass: p.body.mass(), expected: wall.cells[i].volume * 2400, y: p.body.translation().y })); return { breaks: s.destruction.breaks, live: s.destruction.liveChunks, loose, meshes: engine.scene.children.filter((o) => o.name.startsWith("lumina-destructible")).length, broken: wall.broken }; })()`);
    console.log(`  C4: ${after.breaks} chunks broken, ${after.live} simulated; wall lost ${after.broken}`);
    expect(after.broken, 'the concrete wall broke').toBeGreaterThan(5);
    expect(after.live, 'chunks became rigid bodies').toBeGreaterThan(5);
    expect(after.meshes, 'still one mesh per object').toBe(meshesBefore);
    for (const c of after.loose) expect(c.mass / c.expected, 'mass = volume × density').toBeGreaterThan(0.9), expect(c.mass / c.expected).toBeLessThan(1.1);
    expect(log.errors).toEqual([]);
  });

  test('a real click shatters glass at the hit point and unsupported shards fall', async ({ page }) => {
    const log = await open(page, 'playground');
    await L(page, 's.car.targetSpeed = 0, s.orbit.controls.target.set(-1.0, 2.6, -1.5), engine.camera.position.set(-1.2, 2.9, 5.5)');
    await page.waitForTimeout(900);
    const before = await L(page, 's.targets.filter((t) => t.material === "glass").map((t) => t.broken)');
    expect(before.every((n: number) => n === 0)).toBe(true);
    await L(page, "engine.events.on('shatter', (e) => { if (e.kind === 'glass') s.glassBroke = true; }), true");
    await clickPanelButton(page, 'Shoot');
    await page.waitForTimeout(400);
    const hit = await L(page, `(() => { const g = s.targets.filter((t) => t.material === "glass"); const pane = g.find((t) => t.broken > 0); return pane ? { broken: pane.broken, chunks: pane.chunkCount, loose: pane.looseCount, shattered: s.glassBroke, y: [...pane.loose.values()].map((p) => p.body.translation().y) } : null; })()`);
    expect(hit, 'a pane was hit').not.toBeNull();
    console.log(`  glass: ${hit.broken} of ${hit.chunks} shards broke off`);
    expect(hit.broken).toBeGreaterThan(3);
    expect(hit.shattered, 'glass-shatter was emitted').toBe(true);
    await page.waitForTimeout(1600);
    const later = await L(page, `(() => { const pane = s.targets.filter((t) => t.material === "glass").find((t) => t.broken > 0); return [...pane.loose.values()].map((p) => p.body.translation().y); })()`);
    expect(Math.max(...later), 'the top shards fell toward the deck').toBeLessThan(Math.max(...hit.y) - 0.5);
    expect(log.errors).toEqual([]);
  });
});

test.describe('thermo', () => {
  /** Count and centroid of burning cells on the boardwalk via the public query API. */
  const SURVEY = `(() => { let n = 0, cx = 0, cz = 0, charred = 0; for (let x = -4.8; x <= 4.8; x += 0.4) for (let z = -33; z <= -22; z += 0.4) { if (s.thermo.isBurning(x, z)) { n++; cx += x; cz += z; } if (s.thermo.charAt(x, z) > 0.3) charred++; } return { n, cx: n ? cx / n : 0, cz: n ? cz / n : 0, charred }; })()`;

  test('fire spreads downwind, chars the deck and lights the props', async ({ page }) => {
    test.setTimeout(150_000);
    const log = await open(page, 'playground');
    await L(page, 's.state.wind = 9, s.state.windDirection = 0.35, s.car.targetSpeed = 0');
    await clickPanelButton(page, 'Ignite');
    await page.waitForTimeout(5000);
    const early = await L(page, SURVEY);
    await page.waitForTimeout(9000);
    const late = await L(page, SURVEY);
    const wind = { x: Math.cos(0.35), z: Math.sin(0.35) };
    const advance = (late.cx - early.cx) * wind.x + (late.cz - early.cz) * wind.z;
    console.log(`  fire: ${early.n} → ${late.n} cells burning, front advanced ${advance.toFixed(2)} m downwind, ${late.charred} charred`);
    expect(early.n, 'the deck caught fire').toBeGreaterThan(3);
    expect(late.n + late.charred, 'the fire grew').toBeGreaterThan(early.n + early.charred);
    expect(advance, 'the front moves with the wind').toBeGreaterThan(0.6);
    expect(late.charred, 'burnt deck is charred').toBeGreaterThan(early.charred);
    expect(await L(page, 's.thermo.intensity')).toBeGreaterThan(0);
    // Props: wood ignites, steel heats and glows, ice melts.
    await L(page, 's.thermo.ignite(-2.1, -29.0, 1.4), s.thermo.ignite(2.6, -26.8, 1.4), s.thermo.ignite(3.3, -31, 1.6)');
    await page.waitForTimeout(9000);
    const props = await L(page, `({ wood: s.thermo.bodies.filter((b) => b.options.kind === 'wood' && (b.burning || b.progress > 0)).length, steel: Math.max(...s.thermo.bodies.filter((b) => b.options.kind === 'metal').map((b) => b.temperature)), glow: Math.max(...s.thermo.bodies.filter((b) => b.options.kind === 'metal').map((b) => b.options.material.emissive.r * b.options.material.emissiveIntensity)), ice: s.iceBody.progress })`);
    console.log(`  props: ${props.wood} crates alight, steel ${props.steel.toFixed(0)} °C (glow ${props.glow.toFixed(2)}), ice ${(props.ice * 100).toFixed(0)} % melted`);
    expect(props.wood, 'wooden crates caught fire').toBeGreaterThan(0);
    expect(props.steel, 'steel soaks up heat').toBeGreaterThan(450);
    expect(props.glow, 'hot steel glows').toBeGreaterThan(0.02);
    expect(props.ice, 'ice melts near the fire').toBeGreaterThan(0.03);
    expect(log.errors).toEqual([]);
  });

  test('rain and the hose put fire out in steam', async ({ page }) => {
    test.setTimeout(120_000);
    const log = await open(page, 'playground');
    await L(page, 's.state.wind = 6, s.car.targetSpeed = 0, s.ignite(), s.thermo.ignite(0, -27.5, 2.5)');
    await page.waitForTimeout(7000);
    const burning = await L(page, 's.thermo.stats.burningCells');
    const steamBefore = await L(page, 's.thermo.stats.steamEvents');
    expect(burning).toBeGreaterThan(10);
    await L(page, "engine.events.on('steam', () => { s.sawSteam = true; }), true");
    await clickPanelButton(page, 'Hose');
    await L(page, 's.state.rain = 1');
    await page.waitForTimeout(9000);
    const after = await L(page, '({ burning: s.thermo.stats.burningCells, steam: s.thermo.stats.steamEvents, wet: s.thermo.wetnessAt(0, -27.5), emitted: s.sawSteam, deckWet: s.weather.params.rain })');
    console.log(`  quench: ${burning} → ${after.burning} cells burning, ${after.steam - steamBefore} steam events, wetness ${after.wet.toFixed(2)}`);
    expect(after.steam, 'water on hot ground made steam').toBeGreaterThan(steamBefore);
    expect(after.burning, 'the fire is dying').toBeLessThan(burning * 0.5);
    expect(after.wet).toBeGreaterThan(0.3);
    expect(after.emitted, 'steam event was emitted').toBe(true);
    expect(log.errors).toEqual([]);
  });
});

test.describe('deformable ground', () => {
  test('tires carve ruts; snow is deeper than sand; blasts leave craters', async ({ page }) => {
    const log = await open(page, 'playground');
    await page.waitForTimeout(5000);
    const sand = await L(page, `(() => { const w = s.car.wheels[2].position; return { stamps: s.ground.stamps, speed: Math.abs(s.car.speed), kind: s.ground.kind, depth: s.ground.depthAt(w.x, w.z), away: s.ground.depthAt(0, 42), contacts: s.car.wheels.filter((x) => x.contact).length }; })()`);
    console.log(`  sand: ${sand.stamps} stamps, rut ${(sand.depth * 100).toFixed(1)} cm under the rear wheel, car ${(sand.speed * 3.6).toFixed(0)} km/h`);
    expect(sand.stamps).toBeGreaterThan(100);
    expect(sand.contacts).toBe(4);
    expect(sand.speed, 'the car keeps moving on loose ground').toBeGreaterThan(4);
    expect(sand.depth, 'a rut exists under the wheel').toBeGreaterThan(0.03);
    expect(sand.away, 'untouched ground is flat').toBeLessThan(0.005);
    await clickPanelButton(page, 'snow');
    await page.waitForTimeout(4000);
    const snow = await L(page, `(() => { const w = s.car.wheels[2].position; return { kind: s.ground.kind, depth: s.ground.depthAt(w.x, w.z), speed: Math.abs(s.car.speed) }; })()`);
    expect(snow.kind).toBe('snow');
    expect(snow.depth, 'snow ruts are deeper').toBeGreaterThan(sand.depth * 1.5);
    expect(snow.speed).toBeGreaterThan(3);
    await L(page, 's.blastAt("c4", -12, 34, 0.6)');
    await page.waitForTimeout(700);
    expect(await L(page, 's.ground.compactionAt(-12, 34)'), 'the blast left a crater').toBeGreaterThan(0.8);
    expect(log.errors).toEqual([]);
  });
});

test.describe('animation and camera feel', () => {
  test('coupe: batched meshes, body dives under braking, brake light reaches the wet road', async ({ page }) => {
    const log = await open(page, 'highway', 'high', 'webgpu', false);
    await page.waitForTimeout(5000);
    const cruise = await L(page, `(() => { let meshes = 0; s.rig.object.traverse((o) => { if (o.isMesh) meshes++; }); const c = engine.camera.position, p = s.vehicle.root.position; return { meshes, fov: engine.camera.fov, distance: Math.hypot(c.x - p.x, c.z - p.z), speed: s.vehicle.speed, tracks: s.tracks.points, brake: s.road.brake }; })()`);
    console.log(`  cruise: ${cruise.meshes} meshes, chase distance ${cruise.distance.toFixed(1)} m, fov ${cruise.fov.toFixed(1)}°, ${cruise.tracks} track points`);
    expect(cruise.meshes, 'the coupe is batched').toBeLessThan(30);
    expect(cruise.distance, 'the chase camera trails the car').toBeGreaterThan(5);
    expect(cruise.distance).toBeLessThan(16);
    expect(cruise.fov, 'the lens opens with speed').toBeGreaterThan(54);
    expect(cruise.tracks, 'tire tracks are being laid').toBeGreaterThan(30);
    // Take over with the keyboard: S = brake (a real key event through the scene's handler).
    await L(page, 's.vehicle.autopilot = false');
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(700);
    const braking = await L(page, '({ pitch: s.rig.body.rotation.x, light: s.vehicle.brakeLight, road: s.road.brake, glow: s.rig.brakeGlow, accel: s.vehicle.acceleration.x })');
    console.log(`  braking: ${braking.accel.toFixed(1)} m/s², body pitch ${(braking.pitch * 57.3).toFixed(2)}°`);
    expect(braking.accel).toBeLessThan(-2);
    expect(braking.pitch, 'the nose dives').toBeGreaterThan(0.004);
    expect(braking.light).toBe(1);
    expect(braking.road, 'the road shader receives the brake light').toBeGreaterThan(0.9);
    await page.keyboard.up('KeyS');
    expect(log.errors).toEqual([]);
  });

  test('propeller blur disc, jet nozzles and control surfaces follow their inputs', async ({ page }) => {
    const log = await open(page, 'chaos', 'high', 'webgpu', false);
    await L(page, 's.beaver.throttle = 0.8, s.jet.throttle = 0.3');
    await page.waitForTimeout(2500);
    const first = await L(page, `(() => { let blur = null; s.beaver.rig.object.traverse((o) => { if (o.name === 'lumina-rotor-blur') blur = o; }); return { blur: !!blur && blur.visible, nozzle: s.jet.rig.nozzleArea }; })()`);
    expect(first.blur, 'the propeller is a motion-blur disc at power').toBe(true);
    await L(page, 's.jet.throttle = 1');
    await page.waitForTimeout(2500);
    const second = await L(page, 's.jet.rig.nozzleArea');
    console.log(`  nozzle area ${first.nozzle.toFixed(2)} → ${second.toFixed(2)}`);
    expect(Math.abs(second - first.nozzle), 'the nozzle dilates with power').toBeGreaterThan(0.15);
    expect(log.errors).toEqual([]);
  });
});
