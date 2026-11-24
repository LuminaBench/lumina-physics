import * as THREE from 'three/webgpu';
import { createCoastalWorld } from '../modules/coast/world';
import { CoastalHabitat } from '../modules/coast/habitat';
import { Promenade, promenadeLayout } from '../examples/coast/promenade';
import { printRock } from '../examples/coast/print-rock';
import { InletMarkers } from '../examples/coast/inlet-markers';
import { CoastSkiff } from '../examples/coast/skiff';
import { CoastVehicles } from './coast-vehicles';
import { AIR_RECIPES } from '../modules/weather/air';
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
const keyboard = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input,select,button,summary')) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  keyboard.add(e.code);
});
window.addEventListener('keyup', (e) => keyboard.delete(e.code));
window.addEventListener('blur', () => keyboard.clear());
const layout = promenadeLayout(recipe.coast);
const rock = recipe.printCross ? printRock(layout.coast, recipe.printCross[1]) : undefined;
let localShower = false;
const world = await createCoastalWorld({
  rainAt: (x,z,_time,regional) => localShower
    ? Math.max(regional, 1-THREE.MathUtils.smoothstep(Math.hypot(x-layout.road.x,z-layout.road.z),36,65))
    : regional,
  exposureResponse: { brightenSceneSeconds: 0.95, darkenSceneSeconds: 0.24 },
  detail: rock?.detail ?? recipe.detail,
  gridFocus: recipe.gridFocus,
  inlet: recipe.inlet,
  barrierAt: rock?.barrierAt,
  canvas,
  coast: { ...recipe.coast, protectedAt: layout.protectedAt },
  front: recipe.front,
  clock: recipe.clock,
  horizon: recipe.horizon,
  dune: recipe.dune ? {...recipe.dune,protectedAt: layout.protectedAt} : undefined,
  air: recipe.air,
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
  tide: { amplitude: recipe.inlet ? 0.65 : 0.16, periodSeconds: 190, phase: 0 },
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
const inletMarkers = world.inlet ? engine.add(new InletMarkers(world)) : undefined;
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
const target = new THREE.Vector3(),
  aim = new THREE.Vector3(),
  next = new THREE.Vector3();
const cross = recipe.printCross ?? [0.9, 3.4, 7.7];
const prints = [marker(-0.57, cross[0]), marker(0, cross[1]), marker(0.54, cross[2])];
if (world.inlet) {
  for (let i=0;i<prints.length;i++) {
    const x=-14.3+i*0.6,z=9.4+i*0.75;
    prints[i].set(x,world.ground(x,z),z);
  }
}
const seaward = marker(-15, -50);
seaward.y = 7;
function stamp() {
  for (const p of prints) sediment.imprint('foot', p.x, p.z, -0.62, 0.139, 0.292, 1.3);
}
let skiff: CoastSkiff | undefined;
const skiffControls = document.querySelector<HTMLElement>('#skiff-controls')!;
const payloadKg = document.querySelector<HTMLInputElement>('#load-kg')!;
const payloadX = document.querySelector<HTMLInputElement>('#load-x')!;
const setPayload = () => skiff?.setLoad(Number(payloadKg.value), Number(payloadX.value));
payloadKg.oninput = payloadX.oninput = setPayload;
const skiffButton = document.querySelector<HTMLButtonElement>('[data-view="skiff"]')!;
skiffButton.hidden = id !== 'cay' && !world.inlet;
engine.add({ dispose: () => skiff?.dispose() });
const initialSand = sediment.save();
const initialInlet = world.inlet?.save();
const grainButton = document.querySelector<HTMLButtonElement>('#inspect-grains')!;
const facetStrength = document.querySelector<HTMLInputElement>('#facet-strength')!;
let inspectGrains = false;
document.querySelector<HTMLElement>('#grain-controls')!.hidden = !world.sand.facets;
facetStrength.oninput = () => {
  if (world.sand.facets) world.sand.facets.strength.value = Number(facetStrength.value);
};
function leaveGrainView() {
  inspectGrains = false;
  grainButton.setAttribute('aria-pressed', 'false');
}
function reset(restartWater = false) {
  leaveGrainView();
  if (restartWater && mode === 'walk') {
    sediment.restore({ ...initialSand, time: engine.time });
    world.surf.setEpoch(engine.time);
    if (world.inlet && initialInlet) world.inlet.restore(initialInlet);
    inletMarkers?.reset();
    world.ocean.setTide({ amplitude: Number(tide.value), periodSeconds: 190, phase: 0 });
  }
  vehicles.reset(mode);
  if (mode === 'skiff') {
    skiff ??= new CoastSkiff(world);
    skiff.reset();
    setPayload();
  } else skiff?.hide();
  elapsed = 0;
  replay = true;
  if (world.inlet) walker.set(-8, world.ground(-8, 16), 16);
  else walker.copy(marker(1.35, cross[1] + 1.35));
  yaw = Math.atan2(prints[1].x - walker.x, prints[1].z - walker.z);
  pitch = -0.34;
  if (mode === 'walk') stamp();
}
const prepared = new Set<string>();
let transition = Promise.resolve();
function view(value: string) {
  if (!['walk', 'drive', 'fly', ...(!skiffButton.hidden ? ['skiff'] : [])].includes(value)) value = 'walk';
  transition = transition.then(async () => {
    mode = value;
    skiffControls.hidden = mode !== 'skiff';
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === mode));
    reset();
    if (!prepared.has(mode)) {
      engine.stop();
      status.textContent = 'Preparing ' + mode + ' view…';
      const sheet = vehicles.spray?.sheets.mesh;
      // Prepare the actual driver view first. Offscreen reflections and transparent
      // materials have different attachments and must compile against those targets.
      if (mode === 'drive') vehicles.placeDriveCamera();
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
const authoredBank=recipe.sky.cloudBank;
if (authoredBank) {
  document.querySelector<HTMLElement>('#bank-controls')!.hidden=false;
  const lean=document.querySelector<HTMLInputElement>('#bank-lean')!;
  const reach=document.querySelector<HTMLInputElement>('#bank-sky')!;
  reach.value=String(authoredBank.skylightReach ?? 0);
  const applyBank=()=>{
    const scale=Number(lean.value)/100;
    world.weather.params.cloudBank={
      ...authoredBank,
      crownOffset: [(authoredBank.crownOffset?.[0]??0)*scale, (authoredBank.crownOffset?.[1]??0)*scale],
      skylightReach: Number(reach.value),
    };
  };
  lean.oninput=reach.oninput=applyBank;
}
const shower = document.querySelector<HTMLButtonElement>('#shower')!;
const grate = document.querySelector<HTMLButtonElement>('#grate')!;
shower.hidden = grate.hidden = !road.drainage;
shower.onclick = () => {
  localShower = !localShower;
  shower.setAttribute('aria-pressed', String(localShower));
};
grate.onclick = () => {
  const block = grate.getAttribute('aria-pressed') !== 'true';
  road.drainage?.setGrate(0, block ? 0 : 1);
  grate.setAttribute('aria-pressed', String(block));
};
const cutButton = document.querySelector<HTMLButtonElement>('#cut')!;
cutButton.hidden = !world.dune;
cutButton.onclick = async () => {
  const dune=world.dune;
  if(!dune)return;
  if(mode!=='walk')await view('walk');
  const {centerX:x,centerZ:z}=dune.options;
  leaveGrainView();
  dune.cut(x,z,2.3,0.73,0.4,0.49,-0.94,0.25);
  walker.set(x+2.4,world.ground(x+2.4,z+3.35),z+3.35);
  yaw=Math.atan2(x-walker.x,z-walker.z);pitch=-0.27;replay=false;
};
grainButton.onclick = async () => {
  if (mode !== 'walk') await view('walk');
  if (inspectGrains) {
    leaveGrainView();
    pitch = -0.28;
    return;
  }
  const dune = world.dune?.options;
  const site = dune ? new THREE.Vector3(dune.centerX + 0.55, 0, dune.centerZ + 0.35) : marker(2, 9);
  const { x, z } = site, step = 0.16;
  site.y = world.ground(x, z);
  const normal = new THREE.Vector3(world.ground(x-step,z)-world.ground(x+step,z),2*step,
    world.ground(x,z-step)-world.ground(x,z+step)).normalize();
  const reflected = world.weather.getSunDirection().negate().reflect(normal);
  const reach = THREE.MathUtils.clamp(0.31 / Math.max(0.15,reflected.y), 0.3, 1.3);
  walker.set(x + reach*reflected.x, 0, z + reach*reflected.z);
  walker.y = road.heightAt(walker.x,walker.z);
  yaw = Math.atan2(x-walker.x,z-walker.z);
  pitch = Math.atan2(site.y-walker.y-0.31,Math.hypot(x-walker.x,z-walker.z));
  inspectGrains = true;
  grainButton.setAttribute('aria-pressed','true');
  replay = false;
};
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
if (world.inlet) {
  tide.value = '0.65';
  for (const [id,phase] of [['flood',0.25],['ebb',0.75]] as const) {
    const button=document.querySelector<HTMLButtonElement>('#'+id)!;
    button.hidden=false;
    button.onclick=()=>world.ocean.setTide({amplitude:Number(tide.value),periodSeconds:190,phase});
  }
}
look.onchange = () => world.setLook(look.value);
const air = document.querySelector<HTMLSelectElement>('#air')!;
const originalAir = { turbidity: world.weather.params.turbidity, visibility: world.weather.params.visibility };
for (const name of Object.keys(AIR_RECIPES)) air.add(new Option(name.replaceAll('-', ' '), name));
air.value = typeof recipe.air === 'string' ? recipe.air : '';
air.onchange = () => world.setAir(air.value ? AIR_RECIPES[air.value as keyof typeof AIR_RECIPES] : originalAir);
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
    walker.y = road.heightAt(walker.x, walker.z);
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
    cam.position.y += inspectGrains ? 0.31 : replay ? 0.96 : 1.66;
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
      const info = world.inspect(p.x, p.z, p.y),
        wheel = mode === 'drive' ? vehicles.inspectWheel(0) : undefined;
      conditions.value =
        'Last wetting: ' +
        info.ground.lastWet +
        (inletMarkers ? ' · Pool ' + world.ocean.meanLevelAt(-3,8).toFixed(2) + ' m · Sea ' + world.ocean.waterLevel.toFixed(2) + ' m · Sill current ' + inletMarkers.sillCurrent.toFixed(2) + ' m/s (+ inland)' : '') +
         (road.drainage ? ' · Roof ' + road.drainage.budget.roofLitres.toFixed(1) + ' L · Downspout ' + road.drainage.budget.downspoutLps.toFixed(2) + ' L/s' : '') +
        (mode === 'skiff' && skiff ? ' · Draft ' + skiff.reading.draft.toFixed(2) + ' m · Heel ' + skiff.reading.heelDeg.toFixed(1) + '°' : '') +
        ' · Rain ' +
        Math.round(info.weather.rain * 100) +
        '% · Sun: ' +
        info.sun.layer +
        (world.horizon ? ' · Sun above terrain ' + Math.round(info.sun.terrainVisibility * 100) + '%' : '') +
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
    inletMarkers,
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
