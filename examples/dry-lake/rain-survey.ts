import * as T from 'three/webgpu';
import { LuminaEngine } from '../../engine/engine';
import type { QualityTier } from '../../engine/quality';
import { TSL } from '../../engine/tsl';
import { RainColumn, type RainColumnOptions } from '../../modules/weather/rain-column';
import { RainCloudBanks } from '../../modules/weather/rain-cloud-banks';
import { RainColumnView } from '../../modules/weather/rain-column-view';
import { Rain } from '../../modules/weather/rain';
import { Weather, WEATHER_PRESETS, CLOUD_LAYERS } from '../../modules/weather/weather';
import { setSolarTime } from '../../modules/weather/solar-clock';
import { basinTerrain } from './place';
import { surveyRelief } from './rain-relief';
import { LandGeology } from '../../modules/terrain/geology';
import { rainVerge } from './rain-verge';
import { rainRoad } from './rain-road';

const qs = new URLSearchParams(location.search),
  canvas = document.querySelector('canvas')!;
const engine = await LuminaEngine.create({
  canvas,
  physics: false,
  tier: (qs.get('tier') ?? 'high') as QualityTier,
  forceWebGL: qs.get('backend') === 'webgl',
  preloadClouds: true,
  dynamicResolution: true,
});
const common: Omit<RainColumnOptions, 'center' | 'seed' | 'humidity'> = {
  radius: [206, 174],
  baseY: 420,
  minimumY: -12,
  rainMmHour: 36,
  dropDiameterMm: 0.79,
  fallSpeed: 4.3,
  upperWind: [-1.3, -1.6],
  lowerWind: [4.2, -3.7],
};
const columns = [
  new RainColumn({ ...common, center: [205, 550], seed: 8723, humidity: [0.95, 0.18] }),
  new RainColumn({ ...common, center: [-289, 584], seed: 5918, humidity: [0.95, 0.92] }),
];
const weather = engine.add(
  new Weather(engine, {
    distribution: new RainCloudBanks(columns),
    upperClouds: { ...CLOUD_LAYERS.highBank, coverage: 0.23, windX: 15, windZ: -5 },
  }),
);
Object.assign(weather.params, WEATHER_PRESETS.tradeCumulus, {
  cloudBase: 420,
  cloudTop: 995,
  coverage: 0.91,
  cloudDensity: 1.38,
  cloudScale: 1.26,
  cloudErosion: 0.32,
  storm: 0.3,
  convection: 0.24,
  cloudBank: { billows: 0.82, crownOffset: [180, -95], skylightReach: 100 },
  turbidity: 3.5,
  visibility: 35000,
});
setSolarTime(weather.params, { latitudeDeg: 36, dayOfYear: 239, solarHour: 17.46, northAzimuthDeg: 266 });
weather.autoExposure = true;
weather.groundColor.set('#a38363').multiplyScalar(0.36);
const views = columns.map((c) => new RainColumnView(c, qs.get('tier') === 'low' ? 8 : 14));
const terrain = basinTerrain(0.2, 0.2, surveyRelief);
const geology = new LandGeology('dry-highlands', 10400);
terrain.material.vertexColors = false;
terrain.geometry.setAttribute('terrainColor', terrain.geometry.getAttribute('color'));
geology.terrain(
  terrain.material,
  TSL.color('#715f46'),
  TSL.float(2),
  TSL.float(0),
  TSL.float(0),
  TSL.float(0),
);
engine.scene.add(terrain, ...views.map((v) => v.root));
const env = weather.materialEnvironment();
const roads = columns.map((c) => {
  let x = c.options.center[0],
    z = c.options.center[1];
  for (let n = 0; n < 5; n++) {
    const v = Math.max(
      0,
      Math.min(
        c.profileSize - 1,
        Math.round(((common.baseY - surveyRelief(x, z)) / c.height) * (c.profileSize - 1)),
      ),
    );
    x = c.options.center[0] + c.profile[v * 4];
    z = c.options.center[1] + c.profile[v * 4 + 1];
  }
  let best = Infinity,
    gx = x,
    gz = z;
  for (let a = -60; a <= 60; a += 10)
    for (let b = -60; b <= 60; b += 10) {
      const wx = x + a,
        wz = z + b;
      const heights = [
        terrain.heightAt(wx - 2.7, wz - 9),
        terrain.heightAt(wx + 2.7, wz + 9),
        terrain.heightAt(wx - 2.7, wz + 9),
        terrain.heightAt(wx + 2.7, wz - 9),
      ];
      const score = Math.max(...heights) - Math.min(...heights) + Math.hypot(a, b) * 0.009;
      if (score < best) {
        best = score;
        gx = wx;
        gz = wz;
      }
    }
  return rainRoad(gx, gz, env, terrain.heightAt);
});
const verge = rainVerge(roads, terrain.heightAt);
engine.scene.add(verge.root);
const initial = roads.map((r) => r.runoff.save());
engine.scene.add(...roads.map((r) => r.root));
const rain = new Rain(engine, weather);
const node = (id: string) => document.getElementById(id)!;
const humidity = node('humidity') as HTMLInputElement;
humidity.oninput = () => {
  const h = Number(humidity.value);
  columns[0].setLowerHumidity(h / 100);
  node('rh').textContent = h + '%';
};
const names = ['ridge', 'east', 'west'] as const;
let site: (typeof names)[number] = 'ridge',
  yaw = 0,
  pitch = 0,
  seconds = 0,
  lastRead = -1;
const groundRates = [0, 0];
function rainAt(x: number, y: number, z: number, time: number) {
  return columns[0].rainAt(x, y, z, time) + columns[1].rainAt(x, y, z, time);
}
function advance(dt: number) {
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i],
      rate = rainAt(r.x, r.floor(r.x, r.z), r.z, seconds + dt * 0.5);
    groundRates[i] = rate;
    // The two small surveyed catchments each receive their own local gauge in mm/hour.
    r.runoff.update(dt, rate);
  }
  seconds += dt;
}
node('minute').onclick = () => advance(60);
node('clear').onclick = () => {
  for (let i = 0; i < roads.length; i++) roads[i].runoff.restore(initial[i]);
};
for (const id of names)
  node(id).onclick = () => {
    site = id;
    yaw = pitch = 0;
    for (const k of names) node(k).setAttribute('aria-pressed', String(site === k));
  };
let pointer: number | undefined,
  lx = 0,
  ly = 0;
canvas.onpointerdown = (e) => {
  pointer = e.pointerId;
  lx = e.clientX;
  ly = e.clientY;
  canvas.setPointerCapture(pointer);
};
canvas.onpointermove = (e) => {
  if (pointer !== e.pointerId) return;
  yaw -= (e.clientX - lx) * 0.004;
  pitch = T.MathUtils.clamp(pitch + (e.clientY - ly) * 0.003, -0.55, 0.7);
  lx = e.clientX;
  ly = e.clientY;
};
canvas.onpointercancel = canvas.onpointerup = () => {
  pointer = undefined;
};
const eye = new T.Vector3(),
  target = new T.Vector3();
function camera() {
  if (site === 'ridge') {
    eye.set(-8, 76, -335);
    const a = yaw,
      tilt = 0.145 + pitch;
    target.set(eye.x + 1000 * Math.sin(a), eye.y + 1000 * Math.tan(tilt), eye.z + 1000 * Math.cos(a));
  } else {
    const r = roads[site === 'east' ? 0 : 1],
      a = yaw - 0.27;
    eye.set(r.x + 3.6 * Math.sin(a), r.floor(r.x, r.z) + 0.74, r.z - 3.6 * Math.cos(a));
    target.set(r.x + 0.42, r.floor(r.x, r.z) + 0.18 + pitch * 2.6, r.z + 1.4);
  }
  engine.camera.position.copy(eye);
  engine.camera.lookAt(target);
  weather.shadowFocus.copy(eye);
  for (const view of views) view.update(engine.camera, seconds);
}
engine.onUpdate = (dt, t) => {
  advance(dt);
  camera();
  rain.intensityOverride = Math.min(1, rainAt(eye.x, eye.y, eye.z, seconds) / 36);
  rain.update(dt);
  if (t - lastRead >= 0.2) {
    node('gauges').textContent = roads
      .map(
        (r, i) =>
          (i ? 'West' : 'East') +
          ' ' +
          groundRates[i].toFixed(1) +
          ' mm/h · rut ' +
          (r.depth() * 1000).toFixed(1) +
          ' mm',
      )
      .join('   |   ');
    lastRead = t;
  }
};
engine.add({ setQuality: (q) => rain.setQuality(q), dispose: () => rain.dispose() });
engine.resize();
camera();
const resize = () => engine.resize();
addEventListener('resize', resize);
document.querySelector('aside')!.hidden = qs.has('clean');
node('wait').hidden = true;
Object.assign(window, {
  rainSurvey: {
    engine,
    weather,
    columns,
    views,
    roads,
    groundRates,
    get site() {
      return site;
    },
    get seconds() {
      return seconds;
    },
  },
});
engine.start();
addEventListener(
  'pagehide',
  () => {
    removeEventListener('resize', resize);
    for (const v of views) v.dispose();
    verge.dispose();
    geology.dispose();
    for (const r of roads) r.runoff.dispose();
    for (const obj of [terrain, ...roads.map((r) => r.root)])
      obj.traverse((m) => {
        if (m instanceof T.Mesh) {
          m.geometry.dispose();
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
        }
      });
    engine.dispose();
  },
  { once: true },
);
