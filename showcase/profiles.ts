import { createLuminaWorld } from '../modules/weather/outdoor-world';
import { LOOK_NAMES, type WorldLook } from '../modules/weather/world-profile';
import { terrainReading } from '../modules/terrain/surface';
import type { QualityTier } from '../engine/quality';
const args = new URLSearchParams(location.search);
const view = args.get('view') ?? 'headland';
const look = (args.get('look') ?? 'natural-daylight') as WorldLook;
const status = document.querySelector('#loading')!;
const nav = document.querySelector('nav')!;
nav.hidden = args.get('ui') === '0';
function selector(id: string, options: readonly string[], initial: string, onSelect: (s: string) => void) {
  const el = document.querySelector<HTMLSelectElement>('#'+id)!;
  for (const value of options) el.add(new Option(value.replaceAll('-', ' '), value));
  el.value = initial; el.onchange = () => onSelect(el.value);
}
async function setup() {
  const world = await createLuminaWorld({ profileVersion:1, seed:721, look, time:16.6,
    biome:view === 'river' ? 'temperate-river-valley' : 'coastal-cliffs',
    quality:(args.get('tier') ?? 'high') as QualityTier, weather:'mixed' },
    { canvas:document.querySelector('canvas')!, physics:false, forceWebGL:args.has('webgl') });
  const { engine, terrain } = world;
  const read = terrainReading();
  const ground = (x:number,z:number) => terrain.sample(x,z,read).height;
  let pathTime = 0;
  function camera(t:number) {
    const a = t * 0.105;
    const c = engine.camera;
    if (view === 'tire') {
      const z = -39 + 12*Math.sin(a), x = -63 + 6*Math.sin(a*0.7);
      c.position.set(x,ground(x,z)+0.78,z); c.lookAt(x+27,ground(x,z)+1.6,z+22);
    } else if (view === 'river') {
      const z = -70 + 52*Math.sin(a*0.65);
      let x = -65, lowest = Infinity;
      for (let i=-64;i<=64;i+=2) { const h=ground(i,z); if(h<lowest){lowest=h;x=i;} }
      c.position.set(x,4.8,z); c.lookAt(x+7,0.3,z+44);
    } else {
      const x = -47+11*Math.sin(a), z = -93+19*Math.sin(a*0.82);
      c.position.set(x,ground(x,z)+18+2*Math.cos(a),z); c.lookAt(12,8,z+71);
    }
    c.updateMatrixWorld();
  }
  camera(0);
  engine.onBeforeRender = dt => { pathTime += dt; camera(pathTime); };
  engine.resize(true);
  selector('look', LOOK_NAMES, look, value => {
    world.patch({look: value as WorldLook});
    args.set('look',value); history.replaceState(null,'','?'+args);
  });
  selector('view',['headland','tire','river'],view,value=>{args.set('view',value);location.search=args.toString();});
  engine.start();
  await new Promise<void>(resolve => requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  status.textContent='';
  Object.assign(window, { profileGallery: { world, camera, get pathTime() { return pathTime; }, readyMs: performance.now() } });
}
setup().catch(error=>{status.textContent=String(error);console.error(error);});
