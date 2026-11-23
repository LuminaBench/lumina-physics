import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { Vector3 } from 'three';
import { ATMOSPHERE } from '../modules/weather/atmosphere';
import { WorldBus } from '../engine/world-bus';
import { openScene, watchConsole } from './helpers';

test('an aircraft samples incoming air while its pressure front still reaches other objects', () => {
  const world = new WorldBus();
  const origin = new Vector3(), point = new Vector3(2, 0, 0), result = new Vector3();
  world.set(0, 0, 0);
  world.addBlast(origin, 55, 260, 1.4, 19);
  expect(world.sample(point, 0, result, 19).length()).toBe(0);
  expect(world.sample(point, 0, result, 25).x).toBeGreaterThan(45);
  world.addBlast(origin, 10, 260, 1, 25);
  expect(world.sample(point, 0, result, 19).x).toBeGreaterThan(9);
  world.update(2);
  world.addBlast(origin, 55, 260, 1.4);
  expect(world.sample(point, 0, result, 19).x).toBeGreaterThan(45);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' engine cutoff separates hot metal, exhaust haze and the old ice trail', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    await page.locator('#ui').evaluate(element => { element.style.display = ''; });
    const feed = page.locator('.panel .row').filter({hasText:'Engine feed'}).locator('select');
    await feed.selectOption('cut');
    await page.waitForFunction(() => (window as any).lumina.scene.jet.aero.throttleCommands[0] === 0);
    await feed.selectOption('all');
    await page.waitForFunction(() => (window as any).lumina.scene.jet.aero.throttleCommands[0] === 1);
    const result = await page.evaluate(() => {
      const {engine, scene:{jet}} = (window as any).lumina, T = (window as any).THREE;
      engine.stop();
      const aero = jet.aero, rig = jet.rig;
      const engines = [1, 1];
      const pose = {position:new T.Vector3(0, 9000, 0), quaternion:new T.Quaternion(),
        velocity:new T.Vector3(0, 0, -230), windVelocity:new T.Vector3(), throttle:1,
        engineThrottles:engines, gLoad:3, relativeHumidity:0.96, airTemperatureC:-52, iceHumidity:1.12};
      let time = 0;
      const step = (frames: number) => {
        for (let i = 0; i < frames; i++) {
          pose.position.addScaledVector(pose.velocity, 1/60);
          engine.camera.position.copy(pose.position).z += 25;
          rig.animate(1/60, {throttle:1, afterburner:1, engineThrottles:engines});
          aero.setState(pose);
          aero.update(1/60, time += 1/60);
        }
      };
      step(150);
      const plumes: any[] = [];
      rig.object.traverse((o: any) => {if(o.name === 'jet-exhaust') plumes.push(o);});
      const read = () => ({
        jets:plumes.map(p=>p.visible), haze:aero.hazes.map((h: any)=>h.visible),
        core:Array.from(aero.nozzleCoreHeat) as number[],
        ice:aero.contrails.map((t: any)=>t.emissionStrength),
        old:aero.contrails.map((t: any)=>t.hasSamples), wings:aero.vortices[0].emissionStrength,
      });
      const both = read();
      engines[0] = 0; step(60); const cut = read();
      step(375); const cooled = read();
      engines[0] = NaN; step(65); const inherited = read();
      let calls = 0, collectivePower = 0, collectiveHeat = 0;
      rig.setNozzlePower = undefined;
      rig.setAfterburner = (power: number, _clock: number, heat: number) => {
        calls++; collectivePower = power; collectiveHeat = heat;
      };
      engines[1] = 0; step(160);
      return {both, cut, cooled, inherited, calls, collectivePower, collectiveHeat,
        measuredMean:(aero.nozzleCoreHeat[0]+aero.nozzleCoreHeat[1])*0.5};
    });
    expect(result.both.jets).toEqual([true,true]);
    expect(result.cut.jets).toEqual([false,true]);
    expect(result.cut.haze).toEqual([true,true]);
    expect(result.cut.core[0]).toBeGreaterThan(0.2);
    expect(result.cut.ice[0]).toBe(0);
    expect(result.cut.ice[1]).toBeGreaterThan(.8);
    expect(result.cut.old[0]).toBe(true);
    expect(result.cut.wings).toBeGreaterThan(.4);
    expect(result.cooled.haze).toEqual([false,true]);
    expect(result.inherited.jets).toEqual([true,true]);
    expect(result.calls).toBe(160);
    expect(result.collectivePower).toBeCloseTo(.5,3);
    expect(result.collectiveHeat).toBeCloseTo(result.measuredMean,7);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' an engine cutoff moves the exhaust scour across a low water pass', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const result = await page.evaluate(() => {
      const {engine:e,scene:{jet,ocean}} = (window as any).lumina, T = (window as any).THREE;
      e.stop();
      const field = ocean.field, p = new T.Vector3();
      for (let x=-400; x<=400; x+=20) {
        p.x=x;
        if (ocean.depthAt(x,0)>4) break;
      }
      field.center.set(p.x,0); p.y=ocean.heightAt(p.x,0)+12; e.camera.position.copy(p);
      const state = {position:p,quaternion:new T.Quaternion(),velocity:new T.Vector3(0,0,-180),
        windVelocity:new T.Vector3(),throttle:1,gLoad:1,engineThrottles:[1,1]};
      return [[1,1],[0,1],[0,0]].map(power => {
        state.engineThrottles=power; field.pendingCount=0;
        jet.aero.setState(state); jet.aero.update(1/60,2);
        return {count:field.pendingCount, x:field.sources[21], foam:field.sources[26], wing:field.sources[14+3]};
      });
    });
    expect(result.map(x=>x.count)).toEqual([4,4,3]);
    expect(result[1].x-result[0].x).toBeCloseTo(.76,3);
    expect(result[1].foam/result[0].foam).toBeCloseTo(.5,4);
    expect(result[2].wing).toBe(result[0].wing);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' the solar disc emerges above the curved horizon during a climb', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const values = await page.evaluate(radius => {
      const {engine:e, scene:{weather:w,sunFx:fx}} = (window as any).lumina, T = (window as any).THREE;
      e.stop(); e.onBeforeRender = e.onUpdate = undefined; e.paused = true;
      Object.assign(w.params, {sunElevation:-2, sunAzimuth:22, coverage:0, turbidity:1.6});
      w.upperClouds.coverage = 0;
      w.setExternalShafts(false);
      const heights = [5, radius*(1/Math.cos(Math.PI/90)-1), 9500, 0];
      return heights.map(h => {
        e.camera.position.set(0,h,0);
        e.camera.lookAt(w.getSunDirection(new T.Vector3()).add(e.camera.position));
        e.tick(performance.now()); fx.update(0);
        return {visible:w.solarDiscVisibility, flare:fx.uSunFront.value, shafts:w.uShaftStrength.value, red:w.eyeSunlight.value.r};
      });
    }, ATMOSPHERE.planetRadius);
    expect(values[0].visible).toBe(0);
    expect(values[0].red).toBe(0);
    expect(values[1].visible).toBeCloseTo(.5,1);
    expect(values[2].visible).toBe(1);
    expect(values[2].red).toBeGreaterThan(.1);
    expect(values[0].flare).toBe(0);
    expect(values[2].flare).toBeCloseTo(1,4);
    expect(values[3].flare).toBe(0);
    expect(values[2].shafts).toBeGreaterThan(0.005);
    expect(values[3].shafts).toBe(0);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' pressure jitters near Mach one produce one crossing and rearm below the band', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const booms = await page.evaluate(() => {
      const {engine:e,scene:{jet}} = (window as any).lumina, T = (window as any).THREE;
      e.stop();
      const state = {position:new T.Vector3(0, 900, 0), quaternion:new T.Quaternion(), velocity:new T.Vector3(),
        windVelocity:new T.Vector3(), gLoad:1, throttle:1, airTemperatureC:15};
      const before = jet.aero.booms;
      return [.94, 1.004, .998, 1.006, .993, 1.008, .95, 1.003].map((mach, i) => {
        state.velocity.z = -mach * Math.sqrt(1.4 * 287.05 * 288.15);
        state.position.addScaledVector(state.velocity, 1/60);
        jet.aero.setState(state); jet.aero.update(1/60, i/60);
        return jet.aero.booms - before;
      });
    });
    expect(booms).toEqual([0,1,1,1,1,1,1,2]);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' dense intervening cloud extinguishes lens flare at fixed exposure', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    await page.evaluate(() => {
      const {engine:e,scene:{weather:w}} = (window as any).lumina;
      e.stop(); e.paused = true; e.onUpdate = e.onBeforeRender = undefined; e.lens.enabled = false;
      w.upperClouds.coverage = 0;
      Object.assign(w.params, {sunElevation:22, sunAzimuth:53, cloudBase:900, cloudTop:4300, turbidity:2.45,
        exposure:.6, rain:0, storm:0, shafts:0});
      e.camera.position.set(5300,1650,-4675);
      e.camera.up.set(0,1,0);
      e.camera.lookAt(w.getSunDirection().add(e.camera.position));
      e.camera.zoom = 1; e.camera.fov = 53; e.camera.updateProjectionMatrix();
    });
    const gain = async (coverage: number) => {
      const shots: PNG[] = [];
      for (const enabled of [false, true]) {
        const target = await page.evaluate(({coverage,enabled}) => {
          const {engine:e,scene:{weather:w,sunFx:fx}} = (window as any).lumina;
          w.params.coverage = coverage; w.params.cloudDensity = 1.6; fx.params.enabled = enabled;
          if (!enabled) w.resetCloudHistory();
          e.start(); return e.stats.frames + 48;
        }, {coverage,enabled});
        await page.waitForFunction(n => (window as any).lumina.engine.stats.frames >= n, target);
        await page.evaluate(() => (window as any).lumina.engine.stop());
        shots.push(PNG.sync.read(await page.screenshot()));
      }
      const {width,height} = shots[0];
      let sum = 0, count = 0;
      for (let y = -110; y <= 110; y++) for (let x = -110; x <= 110; x++) {
        const r2 = x*x + y*y;
        if (r2 < 20*20 || r2 > 110*110) continue;
        const i = ((Math.floor(height/2)+y)*width + Math.floor(width/2)+x)*4;
        for (let c = 0; c < 3; c++) sum += shots[1].data[i+c] - shots[0].data[i+c];
        count += 3;
      }
      return sum/count;
    };
    const clear = await gain(0), thick = await gain(1);
    expect(clear).toBeGreaterThan(8);
    expect(Math.abs(thick)).toBeLessThan(clear * .12);
    expect(log.errors).toEqual([]);
  });
}
