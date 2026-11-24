import { chalkStreamGarden } from '../examples/landscape/chalk-stream';
import { riverCenter } from '../modules/landscape/earth';
import { seedFor, SEASONS, type Season } from '../modules/landscape/library';
import { createLuminaWorld } from '../modules/weather/outdoor-world';
import { SKY_STATES } from '../modules/weather/world-profile';
import type { QualityTier } from '../engine/quality';
import { fieldRoute, VIEWS, type FieldView } from './field-route';
import { crossingHeightmap, roadClear, woodedRoad } from './field-crossing';

const args = new URLSearchParams(location.search);
const canvas = document.querySelector('canvas')!;
const status = document.querySelector('#loading')!;
const short = (s: string) => s.replace(/^lumina:/, '').replaceAll('-', ' ');
function reflect(key: string, v: string) {
  args.set(key, v);
  history.replaceState(null, '', '?' + args);
}
function select(id: string, items: readonly string[], initial: string, change: (value: string) => void) {
  const node = document.getElementById(id) as HTMLSelectElement;
  for (const v of items) node.add(new Option(short(v), v));
  node.value = initial;
  node.onchange = () => change(node.value);
  return node;
}
async function boot() {
  const { library } = chalkStreamGarden(),
    region = args.get('region') ?? 'lumina:seasonal-woodland';
  const base = library.get('region', region),
    direction = args.get('direction') ?? base.direction;
  const wooded = base.form === 'wood';
  const centre = riverCenter(-40, seedFor(721, 'terrain'));
  const world = await createLuminaWorld(
    {
      profileVersion: 1,
      seed: 721,
      time: args.has('hour') ? Number(args.get('hour')) : base.time,
      quality: (args.get('tier') ?? 'high') as QualityTier,
      weather: base.form === 'street' ? 'squall' : base.form === 'wash' ? 'clear' : 'mixed',
      landscape: { revision: 1, region, direction, season: (args.get('season') ?? base.season) as Season },
    },
    {
      canvas,
      library,
      forceWebGL: args.has('webgl'),
      physics: true,
      heightmap: wooded ? crossingHeightmap(base, seedFor(721, 'terrain')) : undefined,
      plantable: wooded
        ? roadClear
        : base.form === 'street'
          ? (x, z) => Math.abs(x - 8 * Math.sin(z * 0.015)) > 6
          : undefined,
      substrate: wooded
        ? (x, z) =>
            Math.abs(z - woodedRoad(x)) < 2.65
              ? x > centre + 25
                ? 'clay'
                : x < centre - 35
                  ? 'gravel'
                  : undefined
              : undefined
        : undefined,
    },
  );
  const route = fieldRoute(world, (args.get('view') ?? 'ridge') as FieldView),
    engine = world.engine;
  engine.add({ dispose: () => route.dispose() });
  document.querySelector('summary')!.textContent = route.name + ' · Landscape field guide';
  select('region', library.ids('region'), region, (v) => {
    args.set('region', v);
    args.delete('direction');
    args.delete('season');
    location.search = args.toString();
  });
  const directionSelect = select('direction', library.ids('direction'), direction, (v) => {
    world.setDirection(v);
    reflect('direction', v);
  });
  const view = select('view', VIEWS, route.view, (v) => {
    route.setView(v as FieldView);
    reflect('view', v);
    canvas.focus();
  });
  const season = select('season', SEASONS, world.land!.earth.season, (v) => {
    world.setSeason(v as Season);
    reflect('season', v);
  });
  select('sky', Object.keys(SKY_STATES), world.profile.weather, (v) =>
    world.patch({ weather: v as keyof typeof SKY_STATES }, 1.5),
  );
  const hour = document.querySelector<HTMLInputElement>('#time')!;
  hour.value = String(world.profile.time);
  hour.oninput = () => {
    world.patch({ time: hour.valueAsNumber }, 0.25);
    reflect('hour', hour.value);
  };
  const act = document.querySelector<HTMLButtonElement>('#act')!;
  act.textContent = route.actionLabel;
  act.onclick = () => {
    route.act();
    act.textContent = route.actionLabel;
    season.value = world.land!.earth.season;
    view.value = route.view;
    directionSelect.value = world.profile.landscape!.direction ?? base.direction;
    canvas.focus();
  };
  const treeButton = document.querySelector<HTMLButtonElement>('#tree')!;
  treeButton.hidden = base.form !== 'wood';
  treeButton.onclick = () => {
    route.treeImpact();
    canvas.focus();
  };
  const soil = document.querySelector<HTMLElement>('#soil')!;
  document.querySelector<HTMLButtonElement>('#inspect')!.onclick = () => {
    const s = route.inspect();
    soil.hidden = false;
    soil.textContent = [
      s.soil,
      Math.round(s.moisture * 100) + '% soil moisture',
      s.flowerReason,
      s.nearest ? short(s.nearest.recipe) + ' · ' + s.nearest.level + ' detail' : 'open ground',
    ].join(' · ');
  };
  document.querySelector('details')!.hidden = args.get('ui') === '0';
  let inputAt = 0;
  const recordInput = () => {
    if (!inputAt) inputAt = performance.now();
  };
  canvas.addEventListener('keydown', recordInput);
  canvas.addEventListener('pointerdown', recordInput);
  engine.onBeforeRender = (dt) => {
    route.update(dt);
    if (view.value !== route.view) {
      view.value = route.view;
      act.textContent = route.actionLabel;
    }
  };
  engine.resize(true);
  status.textContent = 'Preparing landscape materials…';
  await world.prepare(
    route.vehicle ? [route.vehicle.root, world.fx.dust.mesh, world.fx.spray.mesh, world.fx.mist.mesh] : [],
  );
  engine.start();
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  status.textContent = '';
  Object.assign(window, {
    fieldGuide: {
      world,
      route,
      get firstInputMs() {
        return inputAt;
      },
      readyMs: performance.now(),
    },
  });
  canvas.focus({ preventScroll: true });
}
boot().catch((error) => {
  status.textContent = String(error);
  console.error(error);
});
