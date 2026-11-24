import { clearingHeadland, headlandRoadMap } from './clearing-headland';
import { createLuminaWorld } from '../modules/weather/outdoor-world';
import { LOOK_NAMES, SKY_STATES, type WorldLook } from '../modules/weather/world-profile';
import { BIOMES, type Biome } from '../modules/terrain/biomes';
import { terrainReading } from '../modules/terrain/surface';
import type { QualityTier } from '../engine/quality';
const args = new URLSearchParams(location.search);
const view = args.get('view') ?? 'headland';
const transition = view === 'clearing';
const biome = (
  view === 'river' ? 'temperate-river-valley' : (args.get('biome') ?? 'coastal-cliffs')
) as Biome;
const initialHour = args.has('hour') ? Number(args.get('hour')) : transition ? 16.9 : 16.6;
const look = (args.get('look') ?? 'natural-daylight') as WorldLook;
const status = document.querySelector('#loading')!;
const nav = document.querySelector('nav')!;
nav.hidden = args.get('ui') === '0';
function selector(id: string, options: readonly string[], initial: string, onSelect: (s: string) => void) {
  const el = document.querySelector<HTMLSelectElement>('#' + id)!;
  for (const value of options) el.add(new Option(value.replaceAll('-', ' '), value));
  el.value = initial;
  el.onchange = () => onSelect(el.value);
}
async function setup() {
  const world = await createLuminaWorld(
    {
      profileVersion: 1,
      seed: 721,
      look,
      time: initialHour,
      biome,
      quality: (args.get('tier') ?? 'high') as QualityTier,
      weather: transition ? 'squall' : 'mixed',
    },
    {
      canvas: document.querySelector('canvas')!,
      physics: false,
      forceWebGL: args.has('webgl'),
      heightmap: transition ? headlandRoadMap(721) : undefined,
      plantable: transition ? (x) => Math.abs(x) > 9 : undefined,
    },
  );
  const { engine, terrain } = world;
  const clearing = transition ? clearingHeadland(world) : null;
  const read = terrainReading();
  const ground = (x: number, z: number) => terrain.sample(x, z, read).height;
  let pathTime = 0;
  function camera(t: number) {
    const a = t * 0.105;
    const c = engine.camera;
    if (clearing) clearing.camera(t);
    else if (biome === 'temperate-river-valley' && view !== 'river') {
      const z = -76 + 12 * Math.sin(a * 0.8);
      let channel = 0,
        lowest = Infinity;
      for (let x = -63; x <= 63; x += 1) {
        const h = ground(x, z);
        if (h < lowest) {
          lowest = h;
          channel = x;
        }
      }
      let bank = channel;
      while (bank < 118 && ground(bank, z) < 0.91) bank += 0.35;
      const x = view === 'tire' ? bank + 2.7 : bank + 23;
      c.position.set(x, ground(x, z) + (view === 'tire' ? 0.8 : 12), z);
      c.lookAt(channel - 7, view === 'tire' ? 2.6 : 1.4, z + 48);
    } else if (biome === 'dry-highlands') {
      const z = -86 + 6 * Math.sin(a * 0.74),
        x = -52 + 3 * Math.sin(a * 0.63);
      c.position.set(x, ground(x, z) + (view === 'tire' ? 0.78 : 13), z);
      c.lookAt(x + 91, view === 'tire' ? 24 : 15, z + 47);
    } else if (view === 'tire') {
      const z = -39 + 12 * Math.sin(a),
        x = -63 + 6 * Math.sin(a * 0.7);
      c.position.set(x, ground(x, z) + 0.78, z);
      c.lookAt(x + 27, ground(x, z) + 1.6, z + 22);
    } else if (view === 'river') {
      const z = -70 + 52 * Math.sin(a * 0.65);
      let total = 0,
        moment = 0;
      for (let i = -64; i <= 64; i += 2) {
        const weight = Math.exp(-ground(i, z) * 1.9);
        total += weight;
        moment += weight * i;
      }
      const x = moment / total;
      c.position.set(x, 4.8, z);
      c.lookAt(x + 7, 0.3, z + 44);
    } else {
      const x = 32 + 9 * Math.sin(a),
        z = -128 + 23 * Math.sin(a * 0.82);
      c.position.set(x, 24 + 2 * Math.cos(a), z);
      c.lookAt(-6, 17, z + 72);
    }
    c.updateMatrixWorld();
  }
  camera(0);
  engine.onBeforeRender = (dt) => {
    pathTime += dt;
    camera(pathTime);
  };
  engine.resize(true);
  selector('look', LOOK_NAMES, look, (value) => {
    world.patch({ look: value as WorldLook });
    args.set('look', value);
    history.replaceState(null, '', '?' + args);
  });
  selector('biome', BIOMES, biome, (value) => {
    args.set('biome', value);
    if (view === 'river' || transition) args.set('view', 'headland');
    location.search = args.toString();
  });
  selector('view', ['headland', 'tire', 'river', 'clearing'], view, (value) => {
    args.set('view', value);
    location.search = args.toString();
  });
  selector('weather', Object.keys(SKY_STATES), world.profile.weather, (value) =>
    world.patch({ weather: value as keyof typeof SKY_STATES }, 2),
  );
  const hour = document.querySelector<HTMLInputElement>('#hour')!,
    output = document.querySelector<HTMLOutputElement>('#time')!;
  hour.value = String(world.profile.time);
  output.value = hour.value;
  hour.oninput = () => {
    output.value = hour.value;
    args.set('hour', hour.value);
    history.replaceState(null, '', '?' + args);
    world.patch({ time: hour.valueAsNumber }, 0.25);
  };
  if (!args.has('manual')) {
    status.textContent = 'Preparing landscape materials…';
    await world.prepare();
    engine.start();
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  status.textContent = '';
  Object.assign(window, {
    profileGallery: {
      world,
      clearing,
      camera,
      get pathTime() {
        return pathTime;
      },
      readyMs: performance.now(),
    },
  });
}
setup().catch((error) => {
  status.textContent = String(error);
  console.error(error);
});
