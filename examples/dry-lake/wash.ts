import * as T from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { LuminaEngine } from '../../engine/engine';
import type { QualityTier } from '../../engine/quality';
import { Weather, WEATHER_PRESETS, CLOUD_LAYERS } from '../../modules/weather/weather';
import { setSolarTime } from '../../modules/weather/solar-clock';
import { RainCloudBanks } from '../../modules/weather/rain-cloud-banks';
import { RainColumnView } from '../../modules/weather/rain-column-view';
import { RUNOFF_STEP_SECONDS } from '../../modules/water/runoff-crossing';
import { makeWashSurvey, washBed, washGauges as gauges } from './wash-recipe';
import { washPlace } from './wash-place';

const node = (id: string) => document.getElementById(id)!;
const qs = new URLSearchParams(location.search),
  canvas = node('world') as HTMLCanvasElement;
const engine = await LuminaEngine.create({
  canvas,
  physics: false,
  preloadClouds: true,
  tier: (qs.get('tier') ?? 'high') as QualityTier,
  forceWebGL: qs.get('backend') === 'webgl',
  dynamicResolution: true,
});
const { crossing: sim, cloud, bands, rainAt } = makeWashSurvey();
const simulationClock = TSL.uniform(0),
  banks = new RainCloudBanks([cloud]);
const weather = engine.add(
  new Weather(engine, {
    distribution: {
      coverageAt: (x, z, _t, upper) => banks.coverageAt(x, z, sim.time, upper),
      coverageNode: (p, _t, upper) => banks.coverageNode(p, simulationClock, upper),
    },
    upperClouds: { ...CLOUD_LAYERS.highBank, coverage: 0.31, windX: 18, windZ: -3 },
  }),
);
Object.assign(weather.params, WEATHER_PRESETS.tradeCumulus, {
  cloudBase: 375,
  cloudTop: 1190,
  coverage: 0.85,
  cloudDensity: 1.12,
  cloudScale: 1.18,
  storm: 0.31,
  convection: 0.2,
  cloudBank: { billows: 0.83, crownOffset: [230, -85], skylightReach: 140 },
  turbidity: 3.1,
  visibility: 29000,
});
setSolarTime(weather.params, { latitudeDeg: 36, dayOfYear: 223, solarHour: 17.35, northAzimuthDeg: 225 });
weather.autoExposure = true;
weather.groundColor.set('#978166').multiplyScalar(0.4);
const shaft = new RainColumnView(cloud, engine.quality.tier === 'low' ? 8 : 12);
const place = washPlace(sim, weather.materialEnvironment());
engine.scene.add(place.root, shaft.root);
const initial = sim.save(),
  key = 'lumina-runoff-crossing-1',
  duration = 300;

const current = new Float64Array(3),
  record = new Float32Array(3 * (duration + 1));
let recorded = 0,
  playing = false,
  speed = 8,
  lastUI = -Infinity;
const views = ['crossing', 'inlet', 'outlet', 'ridge'] as const;
let view: (typeof views)[number] = 'crossing',
  orbit = 0,
  tilt = 0;
const opening = node('opening') as HTMLInputElement,
  restore = node('restore') as HTMLButtonElement;
const status = node('save-status');
function updateOpening(f: number) {
  sim.water.setCulvertOpening(f);
  opening.value = String(Math.round(f * 100));
  node('aperture').textContent = opening.value + '%';
}
function run(on: boolean) {
  playing = on;
  node('run').textContent = on
    ? 'Pause'
    : sim.time >= duration
      ? 'Replay shower'
      : sim.time > 0
        ? 'Resume shower'
        : 'Run shower';
}
function fresh() {
  const clear = sim.water.culvertOpening;
  sim.restore(initial);
  updateOpening(clear);
  recorded = 0;
  record.fill(0);
  run(false);
  status.textContent = '';
}
function readGauges() {
  for (let i = 0; i < 3; i++) current[i] = sim.water.depthAt(gauges[i][0], gauges[i][1]);
}
function advance(dt: number) {
  const end = Math.min(duration, sim.time + dt);
  while (sim.time < end - 1e-10) {
    const until = Math.min(end, recorded + 1);
    sim.update(until - sim.time, rainAt);
    if (sim.time >= recorded + 1 - 1e-9) {
      recorded++;
      readGauges();
      record.set(current, recorded * 3);
    }
  }
  if (sim.time >= duration - 1e-8) run(false);
}
function setView(v: typeof view) {
  view = v;
  orbit = tilt = 0;
  for (const id of views) node(id).setAttribute('aria-pressed', String(id === v));
}
for (const id of views) node(id).onclick = () => setView(id);
node('run').onclick = () => {
  if (sim.time >= duration - 1e-8) fresh();
  run(!playing);
};
node('restart').onclick = fresh;
opening.oninput = () => updateOpening(Number(opening.value) / 100);
node('skip').onclick = () => {
  run(false);
  advance(15);
  run(false);
};
(node('speed') as HTMLSelectElement).onchange = (e) => {
  speed = Number((e.target as HTMLSelectElement).value);
};
try {
  restore.disabled = !localStorage.getItem(key);
} catch {
  restore.disabled = true;
}
node('save').onclick = () => {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        state: sim.save(),
        record: Array.from(record.subarray(0, (recorded + 1) * 3)),
        view,
        speed,
      }),
    );
    restore.disabled = false;
    status.textContent = 'Storm saved on this device.';
  } catch {
    status.textContent = 'This browser could not store the storm.';
  }
};
restore.onclick = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    const t = saved?.state?.ticks * RUNOFF_STEP_SECONDS + saved?.state?.remainder,
      count = Math.floor(t + 1e-9);
    if (
      saved?.version !== 1 ||
      !Number.isFinite(t) ||
      t < 0 ||
      t > duration + 1e-8 ||
      !views.includes(saved.view) ||
      ![1, 4, 8, 12].includes(saved.speed) ||
      !Array.isArray(saved.record) ||
      saved.record.length !== (count + 1) * 3 ||
      !saved.record.every((v: number) => Number.isFinite(v) && v >= 0)
    )
      throw new RangeError('Invalid survey record');
    sim.restore(saved.state);
    recorded = count;
    record.fill(0);
    record.set(saved.record);
    updateOpening(sim.water.culvertOpening);
    speed = saved.speed;
    (node('speed') as HTMLSelectElement).value = String(speed);
    setView(saved.view);
    run(false);
    status.textContent = 'Storm restored.';
  } catch {
    status.textContent = 'This storm could not be restored to the current survey.';
  }
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
  if (e.pointerId !== pointer) return;
  orbit -= (e.clientX - lx) * 0.006;
  tilt = T.MathUtils.clamp(tilt + (e.clientY - ly) * 0.005, -0.42, 0.75);
  lx = e.clientX;
  ly = e.clientY;
};
canvas.onpointercancel = canvas.onpointerup = () => {
  pointer = undefined;
};
const eye = new T.Vector3(),
  target = new T.Vector3();
function camera() {
  if (view === 'ridge') {
    eye.set(-5, 35, -240);
    const a = -0.16 + orbit;
    target.set(eye.x + 600 * Math.sin(a), eye.y + 600 * Math.tan(0.16 + tilt), eye.z + 600 * Math.cos(a));
  } else {
    const road = view === 'crossing',
      up = view === 'inlet';
    target.set(road ? 0.15 : up ? -3.6 : 3.6, road ? 0.22 : up ? 0.05 : -0.06, road ? 0.21 : 0.325);
    const a = (road ? 0.5 : up ? -1.02 : 1.18) + orbit,
      dist = road ? 10.2 : 3.95;
    eye.set(
      target.x + dist * Math.sin(a),
      target.y + (road ? 2.4 : 0.83) + tilt * dist * 0.35,
      target.z - dist * Math.cos(a),
    );
    eye.y = Math.max(eye.y, washBed(eye.x, eye.z) + 0.22);
  }
  engine.camera.position.copy(eye);
  engine.camera.lookAt(target);
  weather.shadowFocus.copy(target);
  shaft.update(engine.camera, sim.time);
}
const chart = (node('chart') as HTMLCanvasElement).getContext('2d')!;
function drawRecord() {
  const w = 360,
    h = 70;
  chart.clearRect(0, 0, w, h);
  chart.strokeStyle = '#354242';
  chart.lineWidth = 1;
  for (let n = 1; n <= 2; n++) {
    chart.beginPath();
    chart.moveTo(0, (h * n) / 3);
    chart.lineTo(w, (h * n) / 3);
    chart.stroke();
  }
  const color = ['#e9bd7c', '#92c4db', '#adc4a5'];
  for (let n = 0; n < 3; n++) {
    chart.beginPath();
    chart.strokeStyle = color[n];
    chart.lineWidth = n === 1 ? 2 : 1.35;
    for (let i = 0; i <= recorded; i++) {
      const x = (i * w) / duration,
        y = h - 1 - Math.min(1, record[i * 3 + n] / 0.6) * (h - 2);
      if (i) chart.lineTo(x, y);
      else chart.moveTo(x, y);
    }
    chart.stroke();
  }
}
function ui() {
  const b = sim.balance();
  readGauges();
  let rate = 0;
  for (const band of bands) rate = Math.max(rate, rainAt(...band.gauge, sim.time));
  node('flow').textContent =
    sim.time.toFixed(0) +
    ' s · upstream rain ' +
    rate.toFixed(1) +
    ' mm/h · arrived ' +
    (sim.inflowM3s * 1000).toFixed(0) +
    ' L/s';
  node('levels').textContent =
    'Inlet ' +
    (current[0] * 100).toFixed(1) +
    ' cm · road ' +
    (current[1] * 100).toFixed(1) +
    ' cm · outlet ' +
    (current[2] * 100).toFixed(1) +
    ' cm';
  if (document.querySelector('details')!.open) {
    drawRecord();
    node('balance').textContent =
      'Rain ' +
      b.rainM3.toFixed(1) +
      ' m³ · in transit ' +
      b.inTransitM3.toFixed(1) +
      ' m³ · channel storage ' +
      b.channelM3.toFixed(1) +
      ' m³ · on site ' +
      b.patchM3.toFixed(1) +
      ' m³ · exited ' +
      b.outletM3.toFixed(1) +
      ' m³ · soil ' +
      b.infiltrationM3.toFixed(1) +
      ' m³';
  }
}
engine.onUpdate = (dt, t) => {
  if (playing) advance(dt * speed);
  simulationClock.value = sim.time;
  place.update(sim.time);
  camera();
  if (t - lastUI > 0.15) {
    ui();
    lastUI = t;
  }
};
engine.resize();
place.update(0);
camera();
ui();
const resize = () => engine.resize();
addEventListener('resize', resize);
document.querySelector('aside')!.hidden = qs.has('clean');
node('wait').hidden = true;
Object.assign(window, {
  washSurvey: {
    sim,
    engine,
    cloud,
    bands,
    rainAt,
    record,
    gauges,
    get playing() {
      return playing;
    },
    get view() {
      return view;
    },
  },
});
engine.start();
addEventListener(
  'pagehide',
  () => {
    removeEventListener('resize', resize);
    shaft.dispose();
    place.dispose();
    sim.dispose();
    engine.dispose();
  },
  { once: true },
);
