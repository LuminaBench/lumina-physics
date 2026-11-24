import * as T from 'three/webgpu';
import { LuminaEngine } from '../../engine/engine';
import type { QualityTier } from '../../engine/quality';
import { TSL } from '../../engine/tsl';
import { mergeStaticMeshes } from '../../engine/batching';
import { MineralFacets } from '../../modules/materials/mineral-facets';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { TerrainHorizon } from '../../modules/weather/terrain-horizon';
import { setSolarTime } from '../../modules/weather/solar-clock';
import { SaltCrust, createSaltCrustMaterial } from '../../modules/surface-deform/salt-crust';
import { lakeBed, saltCover, basinTerrain, surveyCart, poolMaterial, pumpHouse } from './place';

const ui = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K) =>
  document.querySelector<HTMLElementTagNameMap[K]>(tag + '#' + id)!;
const byId = (id: string) => document.getElementById(id)!;
const qs = new URLSearchParams(location.search);
const canvas = document.querySelector('canvas')!;
const engine = await LuminaEngine.create({
  canvas,
  tier: (qs.get('tier') ?? 'high') as QualityTier,
  physics: false,
  preloadClouds: true,
  forceWebGL: qs.get('backend') === 'webgl',
  dynamicResolution: true,
});
const horizon = new TerrainHorizon({ size: 6400, resolution: 97, reach: 4800, heightAt: lakeBed });
const weather = engine.add(
  new Weather(engine, {
    terrainHorizon: horizon,
    localProbe: {
      center: new T.Vector3(1.3, 1.06, 0.5),
      halfSize: new T.Vector3(5.1, 2.4, 6.4),
      layer: 13,
      resolution: 64,
      refreshSeconds: 0.45,
    },
  }),
);
Object.assign(weather.params, WEATHER_PRESETS.tradeCumulus, {
  coverage: 0.37,
  convection: 0.29,
  cloudBase: 1500,
  cloudTop: 3400,
  cloudDensity: 0.92,
  cloudScale: 1.16,
  cloudBank: { billows: 0.81, crownOffset: [360, -180], skylightReach: 135 },
  turbidity: 3.4,
  visibility: 32000,
});
weather.autoExposure = true;
weather.groundColor.set('#a38363').multiplyScalar(0.36);
const pan = new SaltCrust({
  x: -5.12,
  z: -8.4,
  columns: 257,
  rows: 421,
  cellSize: 0.04,
  seed: 310522,
  plateWidthM: 0.83,
  thicknessM: 0.019,
  strengthKPa: 46,
  mudSettlementM: 0.05,
  bedAt: lakeBed,
  coverAt: saltCover,
});
const top = createSaltCrustMaterial({ salt: '#d8cab5', bed: '#705143', ridge: '#f0e4d1', bare: '#a58668' });
const facets = new MineralFacets({
  seed: 88,
  fraction: 0.043,
  diameterMm: 0.83,
  tilt: 0.38,
  roughness: 0.18,
});
facets.apply(
  top,
  TSL.positionWorld.xz,
  top.normalNode,
  TSL.attribute('saltState', 'vec3').y.oneMinus().mul(TSL.attribute('saltCover', 'float')),
);
const crust = new T.Mesh(pan.geometry, top);
crust.receiveShadow = true;
const margin = new T.Group();
for (let j = -1; j <= 1; j++)
  for (let i = -1; i <= 1; i++)
    if (i || j) {
      const outer = new SaltCrust({
        ...pan.options,
        x: i * 10.24 - 5.12,
        z: j * 16.8 - 8.4,
        cellSize: 0.16,
        columns: 65,
        rows: 106,
      });
      const patch = new T.Mesh(outer.geometry, top);
      patch.receiveShadow = true;
      margin.add(patch);
    }
const terrain = basinTerrain(15.36, 25.2);
engine.scene.add(crust, margin, terrain);
const waterLevel = 0.009;
const water = new T.Mesh(new T.PlaneGeometry(10.18, 16.7), poolMaterial(weather.materialEnvironment()));
water.rotation.x = -Math.PI / 2;
water.position.y = waterLevel;
water.receiveShadow = true;
engine.scene.add(water);
const cart = surveyCart(),
  shed = pumpHouse();
shed.root.position.set(1.6, lakeBed(1.6, 4.2) + 0.024, 4.2);
mergeStaticMeshes(shed.root);
for (const root of [shed.root, cart.root]) root.traverse((o) => o.layers.enable(13));
engine.scene.add(cart.root, shed.root);
let lampOn = true;
function setLamp(on: boolean) {
  lampOn = on;
  shed.light.intensity = on ? 16 : 0;
  shed.lamp.emissiveIntensity = on ? 2 : 0;
  byId('lamp').setAttribute('aria-pressed', String(on));
}
byId('lamp').onclick = () => setLamp(!lampOn);
const eye = new T.Vector3(),
  target = new T.Vector3(),
  reading = { height: 0, fracture: 0 };
const gravity = 9.81,
  tare = 29,
  track = 0.46,
  axle = 0.47,
  wheelWidth = 0.118,
  patchLength = 0.104;
const ballast = ui('load', 'input'),
  hour = ui('hour', 'input'),
  near = ui('close', 'button'),
  roll = ui('roll', 'button');
const storage = 'lumina-dry-lake-survey-1';
let distance = 0,
  rolling = false,
  phase = 0,
  view: 'basin' | 'boot' | 'pool' = 'basin',
  orbit = 0,
  lookHeight = 0,
  load = 0,
  readAt = 0;
const routeLength = 11.4,
  startZ = -5.9;
const wheelYs = new Float64Array(4);
function pathX(z: number) {
  return -0.47 + 0.27 * Math.sin((z + 0.7) * 0.61);
}
function yawAt(z: number) {
  return Math.atan(0.27 * 0.61 * Math.cos((z + 0.7) * 0.61));
}
function wheelsAt(z: number, stamp: boolean) {
  const x = pathX(z),
    yaw = yawAt(z),
    sn = Math.sin(yaw),
    cs = Math.cos(yaw);
  // The case rack is ahead of the axle midpoint. Its measured load splits 56:44 front to back.
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? -track : track,
      along = i < 2 ? axle : -axle;
    const wx = x + side * cs + along * sn,
      wz = z - side * sn + along * cs;
    const force = tare * gravity * 0.25 + load * gravity * (i < 2 ? 0.28 : 0.22);
    if (stamp) pan.press(wx, wz, wheelWidth, patchLength, yaw, force);
    wheelYs[i] = pan.sample(wx, wz, reading).height;
  }
}
function poseCart() {
  const z = startZ + distance;
  wheelsAt(z, false);
  const front = (wheelYs[0] + wheelYs[1]) * 0.5,
    back = (wheelYs[2] + wheelYs[3]) * 0.5;
  cart.root.position.set(pathX(z), (front + back) * 0.5, z);
  cart.root.rotation.order = 'YXZ';
  cart.root.rotation.set(
    -Math.atan2(front - back, 2 * axle),
    yawAt(z),
    Math.atan2((wheelYs[1] + wheelYs[3] - wheelYs[0] - wheelYs[2]) * 0.5, 2 * track),
    'YXZ',
  );
  for (const w of cart.wheels) w.rotation.x = phase;
}
function applyLoad() {
  load = Number(ballast.value);
  byId('kg').textContent = load + ' kg';
  cart.cargo.visible = load > 0;
  cart.cargo.scale.y = 0.35 + (0.65 * load) / 180;
}
function applyHour() {
  const h = Number(hour.value),
    mins = Math.round(60 * h);
  byId('clock').textContent =
    String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  setSolarTime(weather.params, { latitudeDeg: 36, dayOfYear: 239, solarHour: h, northAzimuthDeg: 143 });
}
function setRolling(v: boolean) {
  rolling = v;
  roll.textContent = v ? 'Stop cart' : distance >= routeLength ? 'Roll again' : 'Roll cart';
}
function setView(next: typeof view) {
  view = next;
  near.setAttribute('aria-pressed', String(view === 'boot'));
  byId('pool').setAttribute('aria-pressed', String(view === 'pool'));
  orbit = lookHeight = 0;
}
function resetCart() {
  distance = phase = 0;
  setRolling(false);
  poseCart();
}
roll.onclick = () => {
  if (distance >= routeLength) resetCart();
  setRolling(!rolling);
};
ballast.oninput = applyLoad;
hour.oninput = applyHour;
near.onclick = () => setView(view === 'boot' ? 'basin' : 'boot');
byId('pool').onclick = () => setView(view === 'pool' ? 'basin' : 'pool');
const boot = { x: -0.35, z: -1.5 };
byId('step').onclick = () => {
  // Peak contacts at successive phases of one step, from heel strike to toe-off.
  pan.press(boot.x + 0.032, boot.z - 0.143, 0.079, 0.09, -0.24, 580);
  pan.press(boot.x + 0.039, boot.z - 0.058, 0.069, 0.135, -0.24, 410);
  pan.press(boot.x, boot.z, 0.109, 0.126, -0.24, 720);
  pan.press(boot.x - 0.025, boot.z + 0.07, 0.079, 0.079, -0.24, 344);
  pan.flush();
  setView('boot');
};
const fresh = pan.save();
byId('reset').onclick = () => {
  pan.restore(fresh);
  resetCart();
};
const restore = ui('restore', 'button');
const note = byId('save-note');
function updateRestore() {
  try {
    restore.disabled = !localStorage.getItem(storage);
  } catch {
    restore.disabled = true;
  }
}
byId('save').onclick = () => {
  try {
    localStorage.setItem(
      storage,
      JSON.stringify({
        version: 1,
        pan: pan.save(),
        distance,
        phase,
        load,
        hour: Number(hour.value),
        view,
        lampOn,
      }),
    );
    updateRestore();
    note.textContent = 'Survey saved on this device.';
  } catch {
    note.textContent = 'This browser could not store the survey.';
  }
};
restore.onclick = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(storage) ?? 'null');
    if (
      !saved ||
      saved.version !== 1 ||
      !Number.isFinite(saved.distance) ||
      saved.distance < 0 ||
      saved.distance > routeLength ||
      !Number.isFinite(saved.phase) ||
      !Number.isFinite(saved.load) ||
      saved.load < 0 ||
      saved.load > 180 ||
      !Number.isFinite(saved.hour) ||
      saved.hour < 6 ||
      saved.hour > 20
    )
      throw new RangeError('Invalid survey');
    pan.restore(saved.pan);
    distance = saved.distance;
    phase = saved.phase;
    ballast.value = String(saved.load);
    hour.value = String(saved.hour);
    applyLoad();
    applyHour();
    setLamp(saved.lampOn ?? true);
    setView(saved.view === 'pool' || saved.view === 'boot' ? saved.view : saved.close ? 'boot' : 'basin');
    setRolling(false);
    poseCart();
    note.textContent = 'Survey restored.';
  } catch {
    note.textContent = 'This survey could not be restored to the current salt basin.';
  }
};
let pointer: number | undefined,
  lastX = 0,
  lastY = 0;
canvas.onpointerdown = (e) => {
  pointer = e.pointerId;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(pointer);
};
canvas.onpointermove = (e) => {
  if (pointer !== e.pointerId) return;
  orbit -= (e.clientX - lastX) * 0.006;
  lookHeight = T.MathUtils.clamp(lookHeight + (e.clientY - lastY) * 0.004, -0.28, 1);
  lastX = e.clientX;
  lastY = e.clientY;
};
canvas.onpointercancel = canvas.onpointerup = () => {
  pointer = undefined;
};
function camera() {
  if (view === 'pool') {
    target.set(1.44, 0.55, 2.8);
    eye.set(1.4 + 4.8 * Math.sin(orbit), 0.67 + lookHeight, 2.8 - 4.8 * Math.cos(orbit));
  } else if (view === 'boot') {
    target.set(boot.x, pan.sample(boot.x, boot.z, reading).height + 0.018, boot.z);
    const a = 0.78 + orbit;
    eye.set(target.x + 1.22 * Math.sin(a), target.y + 0.38 + lookHeight, target.z - 1.22 * Math.cos(a));
  } else {
    target.set(-0.26, 0.62, -1.2);
    const a = 0.35 + orbit;
    eye.set(target.x + 8.1 * Math.sin(a), 1.48 + lookHeight, target.z - 8.1 * Math.cos(a));
  }
  engine.camera.position.copy(eye);
  engine.camera.lookAt(target);
  weather.shadowFocus.copy(target);
}
applyLoad();
applyHour();
poseCart();
camera();
engine.resize();
engine.onUpdate = (dt, t) => {
  if (rolling && dt > 0) {
    const next = Math.min(routeLength, distance + dt * 1.8);
    // Subdivide the spatial path through each contact patch, including a slow rendering frame.
    const steps = Math.max(1, Math.ceil((next - distance) / 0.025));
    for (let i = 1; i <= steps; i++) wheelsAt(startZ + distance + ((next - distance) * i) / steps, true);
    phase += (next - distance) / 0.19;
    distance = next;
    poseCart();
    pan.flush();
    if (distance >= routeLength) setRolling(false);
  }
  if (t >= readAt) {
    readAt = t + 0.2;
    const f = pan.sample(boot.x, boot.z, reading).fracture;
    byId('reading').textContent =
      'Cart ' +
      (tare + load) +
      ' kg · front wheel ' +
      Math.round(tare * gravity * 0.25 + load * gravity * 0.28) +
      ' N · boot site ' +
      Math.round(100 * f) +
      '% broken';
  }
};
engine.onBeforeRender = camera;
const resize = () => engine.resize();
addEventListener('resize', resize);
await weather.localProbe?.prepare(engine.renderer, engine.scene);
document.querySelector('aside')!.hidden = qs.has('clean');
byId('loading').hidden = true;
updateRestore();
Object.assign(window, {
  dryLake: {
    engine,
    pan,
    weather,
    waterLevel,
    shed,
    wheelYs,
    pathX,
    yawAt,
    boot,
    get progress() {
      return distance;
    },
    get rolling() {
      return rolling;
    },
  },
});
engine.start();
addEventListener(
  'pagehide',
  () => {
    removeEventListener('resize', resize);
    facets.dispose();
    horizon.dispose();
    const geometries = new Set<T.BufferGeometry>(),
      mats = new Set<T.Material>();
    for (const root of [terrain, crust, margin, water, cart.root, shed.root])
      root.traverse((o) => {
        if (o instanceof T.Mesh) {
          geometries.add(o.geometry);
          for (const mat of Array.isArray(o.material) ? o.material : [o.material]) mats.add(mat);
        }
      });
    for (const g of geometries) g.dispose();
    for (const m of mats) m.dispose();
    shed.light.dispose();
    engine.dispose();
  },
  { once: true },
);
