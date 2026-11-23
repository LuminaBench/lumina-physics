import { test, expect } from '@playwright/test';
import { openScene, watchConsole } from './helpers';
import { CLIMATES } from '../engine/climate';
import { WorldBus } from '../engine/world-bus';

test('warm dry air evaporates surface water faster than a cold front', () => {
  const world = new WorldBus();
  function remaining(climate: typeof CLIMATES.coldFront) {
    world.setClimate(climate);
    world.surfaceWetness = 0.8;
    for (let i = 0; i < 10 * 60; i++) world.update(1 / 60);
    return world.surfaceWetness;
  }
  expect(remaining(CLIMATES.dryHeat)).toBeLessThan(remaining(CLIMATES.coldFront) - 0.2);
  expect(() => world.setClimate({ ...CLIMATES.coldFront, topAltitude: -4 })).toThrow(RangeError);
  expect(world.iceHumidityAt(14000)).toBe(CLIMATES.coldFront.topIceHumidity);
  world.clearWorld();
  expect(world.airTemperatureAt(14000)).toBe(18);
  expect(world.iceHumidityAt(14000)).toBeUndefined();
});

test('one loaded wheel produces a local rooster tail, a delayed same-side aerosol and less grip on a frozen film', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'highway', 'high', 'webgpu');
  await page.waitForFunction('lumina.scene.vehicle.wheels.every(w => w.contact && w.load > 0)');
  const r = await page.evaluate(({ cold, warm }) => {
    const { lumina, THREE } = window as any;
    const { engine, scene: { road, vehicle, fx, spray } } = lumina;
    engine.stop();
    const { wheels } = vehicle;
    const load = wheels.reduce((sum: number, w: any) => sum + w.loadRatio, 0);
    const w = wheels[2], x = w.position.x, z = w.position.z;
    road.params.wetness = 1; road.params.flood = 0;
    engine.world.setClimate(warm);
    const warmGrip = road.grip(x, z), warmFilm = road.liquidWetnessAt(x, z);
    engine.world.setClimate(cold);
    const coldGrip = road.grip(x, z), coldFilm = road.liquidWetnessAt(x, z);
    road.params.wetness = 0;
    const dryColdGrip = road.grip(x, z);
    engine.world.setClimate();
    vehicle.chassis.setLinvel(new THREE.Vector3(0, 0, 24), true);
    vehicle.speed = 24;
    vehicle.forward.set(0, 0, 1);
    for (const wheel of wheels) {
      wheel.depth = 0; wheel.loadRatio = 1; wheel.velocity.set(0, 0, 24);
      wheel.rollingDirection.set(0, 0, 1); wheel.rollingSpeed = 24; wheel.angularSpeed = 24 / vehicle.rig.wheelRadius; wheel.lateralSpeed = 0;
    }
    w.depth = 0.026;
    const rates = new Float64Array(10);
    const read = (_carry: Float64Array, slot: number, rate: number) => { rates[slot] = rate; };
    fx.spray.emitRateAt = read; fx.mist.emitRateAt = read;
    spray.aerosol.fill(0); spray.treadFilm.fill(0);
    function advance() { rates.fill(0); spray.update(1 / 60); }
    advance();
    const contact = rates[2], firstMist = rates[8] + rates[9];
    for (let i = 0; i < 30; i++) advance();
    const steady = [rates[8], rates[9]], otherWheels = rates[0] + rates[1] + rates[3];
    w.contact = false;
    advance();
    const lifted = rates[2], lingering = rates[8] + rates[9];
    return { load, warmGrip, warmFilm, coldGrip, coldFilm, dryColdGrip, contact, firstMist, steady, otherWheels, lifted, lingering };
  }, { cold: CLIMATES.coldFront, warm: CLIMATES.dryHeat });
  expect(r.load).toBeGreaterThan(0.5);
  expect(r.coldGrip).toBeLessThan(r.warmGrip / 2);
  expect(r.coldFilm).toBe(0); expect(r.warmFilm).toBe(1); expect(r.dryColdGrip).toBeGreaterThan(r.coldGrip);
  expect(r.contact).toBeGreaterThan(1); expect(r.otherWheels).toBe(0);
  expect(Math.min(...r.steady)).toBe(0); expect(Math.max(...r.steady)).toBeGreaterThan(r.firstMist * 3);
  expect(r.lifted).toBe(0); expect(r.lingering).toBeGreaterThan(r.firstMist);
  expect(log.errors).toEqual([]);
});

test('cold ground preserves ice and an exposed fire quenches while sheltered fuel keeps burning', async ({ page }) => {
  await openScene(page, 'playground', 'high', 'webgpu');
  const log = watchConsole(page);
  const result = await page.evaluate(({ cold, warm }) => {
    const { lumina, THREE } = window as any;
    const { engine, scene: { explosions, thermo, iceBody } } = lumina;
    engine.stop();
    engine.world.setClimate(cold);
    thermo.update(0, engine.time);
    thermo.reset();
    for (let i = 0; i < 20; i++) thermo.update(0.05, engine.time + i * 0.05);
    const coldProgress = iceBody.progress;
    const cruiseTemperature = thermo.temperatureAt3D(90000, cold.topAltitude, 90000);
    engine.world.setClimate(warm);
    thermo.update(0, engine.time);
    thermo.reset();
    for (let i = 0; i < 20; i++) thermo.update(0.05, engine.time + i * 0.05);
    const warmProgress = iceBody.progress;
    explosions.extinguish();
    const p = new THREE.Vector3(200, 40, 100);
    explosions.ignite(p, 1, 20);
    p.x += 25;
    const sheltered = explosions.ignite(p, 1, 20, { rainExposure: 0 });
    engine.world.rainfall = 1;
    for (let i = 0; i < 144; i++) {
      engine.world.update(0.05);
      explosions.update(0.05, engine.time + i * 0.05);
    }
    const count = explosions.fireCount;
    const heated = engine.world.disturbance(p, explosions.fireFields).temperature;
    explosions.extinguish(sheltered);
    const after = engine.world.disturbance(p, explosions.fireFields).temperature;
    return { coldProgress, cruiseTemperature, warmProgress, count, heated, after, ambient: engine.world.airTemperatureAt(p.y) };
  }, { cold: CLIMATES.coldFront, warm: CLIMATES.dryHeat });
  expect(result.coldProgress).toBe(0);
  expect(result.cruiseTemperature).toBe(CLIMATES.coldFront.topTemperatureC);
  expect(result.warmProgress).toBeGreaterThan(0.005);
  expect(result.count).toBe(1);
  expect(result.heated).toBeGreaterThan(result.ambient + 100);
  expect(result.after).toBeCloseTo(result.ambient, 3);
  expect(log.errors).toEqual([]);
});

test('jet exhaust uses flight-level climate and sea spray respects the shoreline', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'jet', 'low', 'webgpu');
  const result = await page.evaluate(({ dry, humid }) => {
    const { THREE, lumina } = window as any;
    const { engine, scene: { jet: { aero }, fx, ocean } } = lumina;
    engine.stop();
    const state = {
      position: new THREE.Vector3(0, 11500, 0), quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(0, 0, -260), throttle: 0.75, gLoad: 1,
    };
    let step = 0;
    const advance = () => {
      state.position.z -= 25;
      aero.setState(state);
      aero.update(1 / 60, engine.time + ++step / 60);
    };
    const trail = aero.contrails[0];
    const strength = () => trail.emissionStrength;
    engine.world.setClimate(dry);
    advance();
    const desert = strength();
    engine.world.setClimate(humid);
    advance();
    const cruise = strength();
    Object.assign(state, { iceHumidity: 0.1 });
    advance();
    const override = strength(), lingering = trail.mesh.visible;
    // Use a synthetic seabed with a raised bank to isolate the water boundary.
    ocean.bathymetry = { depthAt: (x: number) => x > 0 ? -3 : 5, heightAt: (x: number) => x > 0 ? 3 : -5 };
    state.position.set(15, 12, 0);
    let waterBursts = 0;
    const original = fx.mist.emit.bind(fx.mist);
    fx.mist.emit = (options: any) => { waterBursts++; return original(options); };
    state.velocity.z = -370;
    advance();
    const land = { waterBursts, curtain: aero.wakeCurtain.visible };
    state.velocity.z = -260; advance();
    state.position.x = -15;
    state.velocity.z = -370; advance();
    return { desert, cruise, override, lingering, land, waterBursts, curtain: aero.wakeCurtain.visible };
  }, { dry: CLIMATES.dryHeat, humid: CLIMATES.humidCoast });
  expect(result.desert).toBe(0);
  expect(result.cruise).toBeGreaterThan(0.8);
  expect(result.override).toBe(0);
  expect(result.lingering).toBe(true);
  expect(result.land).toEqual({ waterBursts: 0, curtain: false });
  expect(result.waterBursts).toBeGreaterThan(0);
  expect(result.curtain).toBe(true);
  expect(log.errors).toEqual([]);
});
