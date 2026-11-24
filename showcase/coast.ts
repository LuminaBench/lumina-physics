import * as THREE from 'three/webgpu';
import { createCoastalWorld } from '../modules/coast/world';
import { CoastalHabitat } from '../modules/coast/habitat';
import { Promenade, promenadeLayout } from '../examples/coast/promenade';
import { printRock } from '../examples/coast/print-rock';
import { CoastSkiff } from '../examples/coast/skiff';
import { CoastVehicles } from './coast-vehicles';
import { SHORES } from '../examples/coast/recipes';
import type { QualityTier } from '../engine/quality';

const params = new URLSearchParams(location.search),
  id = params.get('shore') ?? 'atlantic',
  recipe = SHORES[id] ?? SHORES.atlantic;
const choose = document.querySelector<HTMLSelectElement>('#shore')!,
  status = document.querySelector<HTMLElement>('#reading')!;
for (const [key, r] of Object.entries(SHORES)) choose.add(new Option(r.name, key));
choose.value = id;
choose.onchange = () => {
  params.set('shore', choose.value);
  location.search = params.toString();
};
if (params.has('clean')) document.querySelector('aside')!.style.display = 'none';
const canvas = document.querySelector('canvas')!;
const layout = promenadeLayout(recipe.coast);
const rock = recipe.printCross ? printRock(layout.coast, recipe.printCross[1]) : undefined;
const world = await createCoastalWorld({
  exposureResponse: { brightenSceneSeconds: 0.95, darkenSceneSeconds: 0.24 },
  detail: rock?.detail,
  barrierAt: rock?.barrierAt,
  canvas,
  coast: { ...recipe.coast, protectedAt: layout.protectedAt },
  front: recipe.front,
  clock: recipe.clock,
  size: 2200,
  segments: 256,
  skyGlow: recipe.town
    ? {
        center: new THREE.Vector2(layout.road.x + 45, layout.road.z + 15),
        radius: 780,
        color: '#faab78',
        intensity: 0.13,
      }
    : undefined,
  weather: recipe.sky,
  swell: recipe.swell,
  retainAt: (x, z) => Math.abs(x - layout.road.x + 18) < 14 && Math.abs(z - layout.road.z) < 12,
  strength: recipe.wave,
  tide: { amplitude: 0.16, periodSeconds: 190, phase: 0 },
  tier: (params.get('tier') ?? 'high') as QualityTier,
  forceWebGL: params.get('backend') === 'webgl',
  dynamicResolution: true,
});
const { engine, coast, sediment } = world,
  cam = engine.camera;
if (rock) {
  const stone = rock.mesh();
  engine.scene.add(stone);
  engine.add({
    dispose() {
      stone.removeFromParent();
      stone.geometry.dispose();
      stone.material.dispose();
    },
  });
}
const road = new Promenade(world, layout, recipe.town);
engine.add({ dispose: () => road.dispose() });
const habitat = engine.add(new CoastalHabitat(world, { duneDensity: id === 'volcanic' ? 0.23 : 0.9 }));
const vehicles = new CoastVehicles(world, road);
engine.add({ dispose: () => vehicles.dispose() });
const origin = coast.project(0, 0).along;
const marker = (along: number, cross: number) => {
  const p = coast.point(origin + along, cross);
  return new THREE.Vector3(p.x, world.ground(p.x, p.z), p.z);
};
let walker = marker(0, 4),
  yaw = 0,
  pitch = -0.28,
  elapsed = 0,
  mode = 'walk',
  replay = true;
const keyboard = new Set<string>(),
  target = new THREE.Vector3(),
  aim = new THREE.Vector3(),
  next = new THREE.Vector3();
const cross = recipe.printCross ?? [0.9, 3.4, 7.7];
const prints = [marker(-0.57, cross[0]), marker(0, cross[1]), marker(0.54, cross[2])];
const seaward = marker(-15, -50);
seaward.y = 7;
function stamp() {
  for (const p of prints) sediment.imprint('foot', p.x, p.z, -0.62, 0.139, 0.292, 1.3);
}
let skiff: CoastSkiff | undefined;
const skiffButton = document.querySelector<HTMLButtonElement>('[data-view="skiff"]')!;
skiffButton.hidden = id !== 'cay';
engine.add({ dispose: () => skiff?.dispose() });
const initialSand = sediment.save();
function reset(restartWater = false) {
  if (restartWater && mode === 'walk') {
    sediment.restore({ ...initialSand, time: engine.time });
    world.surf.setEpoch(engine.time);
    world.ocean.setTide({ amplitude: Number(tide.value), periodSeconds: 190, phase: 0 });
  }
  vehicles.reset(mode);
  if (mode === 'skiff') {
    skiff ??= new CoastSkiff(world);
    skiff.reset();
  } else skiff?.hide();
  elapsed = 0;
  replay = true;
  walker.copy(marker(1.35, cross[1] + 1.35));
  yaw = Math.atan2(prints[1].x - walker.x, prints[1].z - walker.z);
  pitch = -0.34;
  if (mode === 'walk') stamp();
}
const prepared = new Set<string>();
let transition = Promise.resolve();
function view(value: string) {
  if (!['walk', 'drive', 'fly', ...(id === 'cay' ? ['skiff'] : [])].includes(value)) value = 'walk';
  transition = transition.then(async () => {
    mode = value;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === mode));
    reset();
    if (!prepared.has(mode)) {
      engine.stop();
      status.textContent = 'Preparing ' + mode + ' view…';
      const sheet = vehicles.spray?.sheets.mesh;
      await world.prepare(sheet ? [sheet] : []);
      prepared.add(mode);
      engine.start();
    }
  });
  return transition;
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
  b.onclick = () => view(b.dataset.view!);
document.querySelector<HTMLButtonElement>('#replay')!.onclick = () => reset(true);
const clock = document.querySelector<HTMLInputElement>('#clock')!;
clock.value = String(recipe.clock.solarHour);
clock.oninput = () => world.setClock({ ...recipe.clock, solarHour: Number(clock.value) });
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input,select,button,summary')) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  keyboard.add(e.code);
});
window.addEventListener('keyup', (e) => keyboard.delete(e.code));
window.addEventListener('blur', () => keyboard.clear());
let drag = false;
canvas.onpointerdown = (e) => {
  drag = true;
  canvas.setPointerCapture(e.pointerId);
  canvas.focus();
  replay = false;
};
canvas.onpointerup = canvas.onlostpointercapture = () => {
  drag = false;
};
canvas.onpointermove = (e) => {
  if (drag) {
    yaw += e.movementX * 0.004;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.004, -1.25, 1.1);
  }
};
const look = document.querySelector<HTMLSelectElement>('#look')!,
  tide = document.querySelector<HTMLInputElement>('#tide')!;
look.onchange = () => world.setLook(look.value);
tide.oninput = () => world.ocean.setTide({ amplitude: Number(tide.value), periodSeconds: 190, phase: 0 });
const panel = document.querySelector('details')!,
  conditions = document.querySelector<HTMLOutputElement>('#conditions')!;
let stride = 0,
  side = 1,
  readAt = -1;
panel.ontoggle = () => {
  readAt = -1;
};
const previous = engine.onUpdate;
engine.onUpdate = (dt, t) => {
  elapsed += dt;
  previous?.(dt, t);
  if (keyboard.size) replay = false;
  if (mode === 'walk') {
    const forward =
      Number(keyboard.has('KeyW') || keyboard.has('ArrowUp')) -
      Number(keyboard.has('KeyS') || keyboard.has('ArrowDown'));
    const turn =
      Number(keyboard.has('KeyD') || keyboard.has('ArrowRight')) -
      Number(keyboard.has('KeyA') || keyboard.has('ArrowLeft'));
    yaw -= turn * dt * 1.6;
    const step = dt * forward * 2.1;
    walker.x += Math.sin(yaw) * step;
    walker.z += Math.cos(yaw) * step;
    walker.y = world.ground(walker.x, walker.z);
    stride += Math.abs(step);
    if (stride > 0.65) {
      stride %= 0.65;
      side = -side;
      sediment.imprint(
        'foot',
        walker.x + Math.cos(yaw) * side * 0.09,
        walker.z - Math.sin(yaw) * side * 0.09,
        yaw,
        0.13,
        0.285,
      );
    }
    cam.position.copy(walker);
    cam.position.y += replay ? 0.96 : 1.66;
    if (replay) {
      const look =
        THREE.MathUtils.smoothstep(elapsed, 8, 12) * (1 - THREE.MathUtils.smoothstep(elapsed, 15, 19));
      // Interpolate directions so the distant horizon does not overwhelm the near sole on the first frame.
      aim.copy(prints[1]).sub(cam.position).normalize();
      aim.lerp(next.copy(seaward).sub(cam.position).normalize(), look).add(cam.position);
      cam.lookAt(aim);
    } else
      cam.lookAt(
        aim
          .copy(cam.position)
          .add(target.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))),
      );
    world.setFocus(replay ? next.copy(prints[0]).lerp(prints[2], 0.5) : walker);
  } else if (mode === 'drive') vehicles.drive(dt, keyboard, replay);
  else if (mode === 'skiff') skiff!.drive(dt, keyboard, replay);
  else vehicles.fly(dt, elapsed, keyboard, replay);
  road.update(dt, mode === 'drive' ? vehicles.car!.root.position : cam.position);
  if (t > readAt + 0.6) {
    readAt = t;
    if (panel.open) {
      const p = mode === 'drive' ? vehicles.car!.root.position : mode === 'walk' ? walker : cam.position;
      const info = world.inspect(p.x, p.z),
        wheel = mode === 'drive' ? vehicles.inspectWheel(0) : undefined;
      conditions.value =
        'Last wetting: ' +
        info.ground.lastWet +
        ' · Rain ' +
        Math.round(info.weather.rain * 100) +
        '% · Sun: ' +
        info.sun.layer +
        (wheel
          ? ' · Front left: ' +
            wheel.source +
            ', ' +
            wheel.waterMm.toFixed(1) +
            ' mm standing, ' +
            wheel.carryMm.toFixed(1) +
            ' mm carried'
          : '');
    }
    status.textContent =
      mode === 'walk'
        ? 'W/S walk · A/D turn · Drag to look'
        : mode === 'drive'
          ? 'W accelerate · S brake · A/D steer'
          : mode === 'skiff'
            ? 'W/S motor · A/D turn'
            : 'W/S pitch · A/D bank · Shift boost';
  }
};
engine.onBeforeRender = () => {
  if (mode === 'drive') vehicles.placeDriveCamera();
  else if (mode === 'skiff') skiff!.placeCamera();
};
engine.resize();
await view(params.get('view') ?? 'walk');
Object.assign(window, {
  THREE,
  coastDemo: {
    world,
    road,
    vehicles,
    habitat,
    prints,
    view,
    reset,
    get skiff() {
      return skiff;
    },
    get mode() {
      return mode;
    },
    get elapsed() {
      return elapsed;
    },
  },
});
window.addEventListener('pagehide', () => world.dispose(), { once: true });
