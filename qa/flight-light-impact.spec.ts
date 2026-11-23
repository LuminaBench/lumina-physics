import { expect, test } from '@playwright/test';
import * as THREE from 'three/webgpu';
import { skyRadianceCPU, sunTransmittanceCPU } from '../modules/weather/atmosphere';
import { setSolarTime } from '../modules/weather/solar-clock';
import { openScene, watchConsole } from './helpers';

test('the game clock follows solar noon, polar seasons, rotated maps and calendar rollover', () => {
  const at = (latitudeDeg: number, dayOfYear: number, solarHour: number, northAzimuthDeg = -90, daysInYear: 365 | 366 = 365) => {
    const sky = {sunAzimuth: 0, sunElevation: 0};
    setSolarTime(sky, {latitudeDeg, dayOfYear, solarHour, northAzimuthDeg, daysInYear});
    return sky;
  };
  const summerNoon = at(51.5, 172, 12);
  expect(summerNoon.sunElevation).toBeCloseTo(61.95, 0);
  expect(summerNoon.sunAzimuth).toBeCloseTo(90, 6);
  expect(at(51.5, 355, 12).sunElevation).toBeCloseTo(15.1, 0);
  expect(at(-51.5, 355, 12).sunAzimuth).toBeCloseTo(270, 6);
  expect(at(78, 172, 0).sunElevation).toBeGreaterThan(10);
  expect(at(78, 355, 12).sunElevation).toBeLessThan(-10);
  expect(at(90, 172, 12).sunElevation).toBeCloseTo(at(90, 172, 0).sunElevation, 1);
  expect(at(0, 80, 6).sunElevation).toBeCloseTo(0, 5);
  const morning = at(0, 80, 6).sunAzimuth * Math.PI / 180;
  const evening = at(0, 80, 18).sunAzimuth * Math.PI / 180;
  expect(Math.cos(morning)).toBeGreaterThan(0.99);
  expect(Math.cos(evening)).toBeLessThan(-0.99);
  expect(at(51.5, 172, 12, 0).sunAzimuth).toBeCloseTo(180, 6);
  const sky = {sunAzimuth: 5, sunElevation: 6, coverage: 0.7};
  expect(() => setSolarTime(sky, {latitudeDeg: -91, dayOfYear: 168, solarHour: 5})).toThrow(RangeError);
  expect(sky).toEqual({sunAzimuth: 5, sunElevation: 6, coverage: 0.7});
  setSolarTime(sky, {latitudeDeg: 0, dayOfYear: 168, solarHour: 5});
  expect(sky.coverage).toBe(0.7);
  for (const days of [365, 366] as const) {
    const nextYear = at(35, days, 37, 15, days);
    const nextDay = at(35, 1, 13, 15, days);
    expect(nextYear.sunElevation).toBeCloseTo(nextDay.sunElevation, 8);
    expect(nextYear.sunAzimuth).toBeCloseTo(nextDay.sunAzimuth, 8);
    const rewound = at(35, 2, -11, 15, days);
    expect(rewound.sunElevation).toBeCloseTo(nextDay.sunElevation, 8);
    expect(rewound.sunAzimuth).toBeCloseTo(nextDay.sunAzimuth, 8);
  }
});

test('the antisolar twilight band rises above a bluer horizon and fades into night', () => {
  const sample = (elevation: number, y: number) => {
    const rad = THREE.MathUtils.degToRad(elevation);
    return skyRadianceCPU(new THREE.Vector3(-1, y, 0).normalize(), new THREE.Vector3(Math.cos(rad), Math.sin(rad), 0), 2.5);
  };
  const belt = sample(-3.5, 0.20), shadow = sample(-3.5, 0.035), night = sample(-18, 0.20);
  expect(belt.r / belt.b).toBeGreaterThan(shadow.r / shadow.b);
  expect(night.r + night.g + night.b).toBeLessThan(belt.r + belt.g + belt.b);
});

test('high ice clouds retain direct warm light after the lower deck enters planetary shadow', () => {
  const sun = new THREE.Vector3(Math.cos(0.035), -Math.sin(0.035), 0);
  const low = sunTransmittanceCPU(sun, 1.2, new THREE.Color(), 1500);
  const high = sunTransmittanceCPU(sun, 1.2, new THREE.Color(), 9500);
  expect(low.r + low.g + low.b).toBe(0);
  expect(high.r).toBeGreaterThan(0.15);
  expect(high.r).toBeGreaterThan(high.b * 2);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' a humid transonic pass follows local airspeed and temperature', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const response = await page.evaluate(() => {
      const {engine, scene:{jet}} = (window as any).lumina, T = (window as any).THREE;
      engine.stop();
      const aero = jet.aero;
      const s = {position:new T.Vector3(0, 8000, 0), quaternion:new T.Quaternion(),
        velocity:new T.Vector3(0,0,-300), windVelocity:new T.Vector3(),
        throttle:.78, gLoad:2, relativeHumidity:1, airTemperatureC:-49};
      const read = () => {
        aero.setState(s); aero.update(1/60, engine.time);
        return {mach:aero.mach, cone:aero.coneIntensity, wing:aero.vortices[0].emissionStrength};
      };
      const cold = read();
      s.relativeHumidity = 0; const dry = read();
      s.relativeHumidity = 1; s.airTemperatureC = 22; const warm = read();
      s.windVelocity.z = 44; const headwind = read();
      return {cold, dry, warm, headwind};
    });
    expect(response.cold.mach).toBeCloseTo(.9996, 2);
    expect(response.cold.cone).toBeGreaterThan(.95);
    expect(response.dry.cone).toBe(0); expect(response.dry.wing).toBe(0);
    expect(response.warm.cone).toBe(0); expect(response.warm.mach).toBeLessThan(.9);
    expect(response.headwind.cone).toBeGreaterThan(.95);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' the last-light flight crosses into cold air, sheds banked vapor and returns to the ocean', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    await page.evaluate(() => document.getElementById('ui')!.style.display = '');
    await page.getByRole('button', {name:'Last light at altitude',exact:true}).click();
    await page.waitForFunction('lumina.scene.jet.aero.contrails[0].emissionStrength > .6');
    const readings = await page.evaluate(() => {
      const {engine, scene:{jet}} = (window as any).lumina, T=(window as any).THREE;
      engine.stop();
      const p = new T.Vector3(0,8800,0), wind = new T.Vector3(1,0,0), speed = 240;
      const aero = jet.aero, s = {position:p,velocity:new T.Vector3(0,0,-speed), throttle:.74,
        quaternion:new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1), Math.PI/2),
        relativeHumidity:1,gLoad:3,windVelocity:wind,wakeDescentMps:2};
      const step = () => {p.z-=4;aero.setState(s);aero.update(1/60,engine.time)};
      step();
      const read = (trail:any) => Array.from(trail.releaseWind.slice(trail.head*3,trail.head*3+3)) as number[];
      const banked = read(aero.vortices[0]);
      p.y=.45; s.quaternion.identity(); step();
      const left=read(aero.vortices[0]),right=read(aero.vortices[1]);
      s.gLoad=0;step();const unloaded=aero.vortices[0].emissionStrength;
      engine.start();
      return {banked,left,right,unloaded};
    });
    expect(readings.banked[0]).toBeCloseTo(3, 3);
    expect(readings.banked[1]).toBeCloseTo(0, 3);
    expect(readings.left[0]*readings.right[0]).toBeLessThan(0);
    expect(readings.unloaded).toBe(0);
    await page.getByRole('button', {name:'Low ocean pass',exact:true}).click();
    await page.waitForFunction('lumina.engine.world.climate === null && lumina.scene.jet.aero.altitude < 350');
    expect(log.errors).toEqual([]);
  });

  test(`${backend} throttle cut, humidity and discontinuous flight paths`, async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'jet', 'high', backend);
    const result = await page.evaluate(() => {
      const { lumina, THREE: T } = window as any;
      const { engine, scene: { jet } } = lumina;
      engine.stop();
      const aero = jet.aero, trail = aero.vortices[0];
      const s = { position: new T.Vector3(0, 1200, 0), velocity: new T.Vector3(0, 0, -280),
        quaternion: new T.Quaternion(), relativeHumidity: 0.98, throttle: 1, gLoad: 3.2 };
      let t = engine.time;
      const step = () => {
        s.position.z -= 280 / 60;
        aero.setState(s); aero.update(1 / 60, t += 1 / 60);
      };
      for (let i = 0; i < 40; i++) step();
      const flame = jet.rig.object.getObjectByName('jet-exhaust');
      const lit = flame.visible, length = flame.scale.z;
      const heat = aero.nozzleCoreHeat[0];
      s.relativeHumidity = 0.15; s.throttle = 0;
      step();
      const birth = trail.emissionStrength;
      const releasedCount = trail.count;
      const priorStillVisible = trail.strength.some((v: number) => v > 0.15);
      s.position.x += 2000; step();
      const retained = trail.count === releasedCount;
      for (let i = 0; i < 125; i++) step();
      const cooling = aero.nozzleCoreHeat[0];
      return { lit, length, heat, cooling, birth, priorStillVisible, retained, hidden: !flame.visible && !trail.mesh.visible };
    });
    expect(result.lit).toBe(true); expect(result.length).toBeGreaterThan(4);
    expect(result.cooling).toBeGreaterThan(0);
    expect(result.cooling).toBeLessThan(result.heat * 0.4);
    expect(result.birth).toBe(0); expect(result.priorStillVisible).toBe(true);
    expect(result.retained).toBe(true); expect(result.hidden).toBe(true);
    expect(log.errors).toEqual([]);
  });

  test(`${backend} wall chips stay on the face and reuse eight slots`, async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'playground', 'high', backend);
    const result = await page.evaluate(() => {
      const { lumina, THREE: T } = window as any;
      const wall = lumina.scene.targets[0], pane = lumina.scene.targets[2];
      const point = new T.Vector3();
      const away = wall.markSurface(point.copy(wall.position).addScalar(8), 0.035);
      for (let i = 0; i < 14; i++) {
        point.set(i * 0.05 - 0.35, 0.12, wall.size.z / 2).applyQuaternion(wall.quaternion).add(wall.position);
        wall.markSurface(point, 0.035);
      }
      return { count: wall.surfaceMarkCount, broken: wall.broken, away, glass: pane.markSurface(point) };
    });
    await page.waitForFunction(() => (window as any).lumina.engine.stats.frames > 25);
    expect(result).toEqual({ count: 8, broken: 0, away: false, glass: false });
    expect(log.errors).toEqual([]);
  });
}

test('a sideswipe distributes a shallower dent down the door and repair restores the mesh', async ({ page }) => {
  await openScene(page, 'highway', 'high', 'webgpu');
  const sample = await page.evaluate(() => {
    const { lumina, THREE: T } = window as any;
    const { damage, rig } = lumina.scene;
    const originalTrim = rig.crumpleAttachments.map((m: any) => m.geometry);
    lumina.engine.stop();
    const shell = rig.shell, position = shell.geometry.attributes.position;
    const point = shell.localToWorld(new T.Vector3(-0.91, 0.53, -0.63));
    const normal = new T.Vector3(-1, 0, 0).transformDirection(shell.matrixWorld);
    const slide = new T.Vector3(0, 0, -1).transformDirection(shell.matrixWorld).multiplyScalar(12);
    const changed = () => {
      let count = 0;
      for (let i = 0; i < position.count; i++)
        if (Math.abs(position.getX(i) - damage.rest[i * 3]) > 0.002) count++;
      return count;
    };
    damage.impact(point, 0.74, normal, normal.clone().multiplyScalar(12));
    const straight = { count: changed(), depth: damage.stats.displacement };
    damage.repair();
    damage.impact(point, 0.74, normal, slide);
    const graze = { count: changed(), depth: damage.stats.displacement, glass: damage.stats.glassDamage,
      wear: damage.paintWear.count, trim: rig.crumpleAttachments.some((m: any, i: number) => m.geometry !== originalTrim[i]) };
    damage.repair();
    return { straight, graze, residual: changed(), remainingWear: damage.paintWear.count,
      trimRestored: rig.crumpleAttachments.every((m: any, i: number) => m.geometry === originalTrim[i]) };
  });
  expect(sample.graze.count).toBeGreaterThan(sample.straight.count);
  expect(sample.graze.depth).toBeLessThan(sample.straight.depth);
  expect(sample.graze.glass).toBe(0); expect(sample.graze.wear).toBe(1); expect(sample.graze.trim).toBe(true);
  expect(sample.residual).toBe(0); expect(sample.remainingWear).toBe(0); expect(sample.trimRestored).toBe(true);
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`${backend} moving the moon redirects both the shadow light and reflected radiance`, async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: { weather } } = (window as any).lumina, T = (window as any).THREE, t = T.TSL;
      engine.stop();
      Object.assign(weather.params, { sunElevation: -18, coverage: 0, cloudDensity: 0, storm: 0, rain: 0 });
      const a = new T.Vector3(0.67, 0.53, 0.52).normalize();
      const b = new T.Vector3(-a.x, a.y, -a.z);
      const material = new T.NodeMaterial();
      material.fragmentNode = t.vec4(weather.reflection(t.vec3(a.x, a.y, a.z), 0).b,
        weather.reflection(t.vec3(b.x, b.y, b.z), 0).b, 0, 1);
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
      const renderer = engine.renderer, previous = renderer.getRenderTarget(), quad = new T.QuadMesh(material);
      const sample = async (dir: typeof a, power: number, fraction: number | string = 1) => {
        weather.moonDirection.copy(dir);
        weather.params.moonlight = power; weather.params.moonIllumination = fraction; weather.update(0.25);
        renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(previous);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
        return { a: pixels[0], b: pixels[1], alignment: weather.sun.position.clone().sub(weather.sun.target.position).normalize().dot(dir) };
      };
      try {
        const first = await sample(a, 1), second = await sample(b, 1), off = await sample(b, 0);
        const quarter = await sample(b, 1, 0.5);
        const solar = weather.getSunDirection(new T.Vector3());
        const tangent = solar.clone().addScaledVector(b, -solar.dot(b)).normalize();
        const bright = b.clone().addScaledVector(tangent, 0.0027).normalize();
        const dark = b.clone().addScaledVector(tangent, -0.0027).normalize();
        const disc = new T.NodeMaterial();
        disc.fragmentNode = t.vec4(weather.lunarDisc(t.vec3(bright.x, bright.y, bright.z), false).b,
          weather.lunarDisc(t.vec3(dark.x, dark.y, dark.z), false).b, 0, 1);
        try {
          renderer.setRenderTarget(target); new T.QuadMesh(disc).render(renderer); renderer.setRenderTarget(previous);
          const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          await sample(b, 1, 'fromDirections');
          return { first, second, off, quarter, bright: pixels[0], dark: pixels[1],
            automatic: weather.uMoonPhaseLight.value.w, expected: -b.dot(solar) };
        } finally { disc.dispose(); }
      }
      finally { renderer.setRenderTarget(previous); material.dispose(); target.dispose(); }
    });
    const { first, second, off, quarter } = result;
    expect((quarter.b - off.b) / (second.b - off.b)).toBeCloseTo(0.5, 1);
    expect(result.bright).toBeGreaterThan(result.dark + 1);
    expect(result.automatic).toBeCloseTo(result.expected, 5);
    expect(first.alignment).toBeGreaterThan(0.999); expect(second.alignment).toBeGreaterThan(0.999);
    expect(first.a).toBeGreaterThan(first.b + 0.02); expect(second.b).toBeGreaterThan(second.a + 0.02);
    expect(off.b).toBeLessThan(second.b - 0.02); expect(log.errors).toEqual([]);
  });
}
