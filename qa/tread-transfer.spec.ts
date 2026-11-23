import { expect, test } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { TreadTransfer, retainedTreadFilm } from '../modules/wet-road/tread-transfer';
import { openScene, watchConsole } from './helpers';

test('a bicycle carries soil out by travelled distance, washes clean and releases its contact in the air', () => {
  function ride(hz: number) {
    const field = new TreadTransfer(), bike = field.contact(0.035), p = new Vector3();
    try {
      let film = 0;
      const sample = (x: number, z: number, soil: number, depth = 0, load = 1) => {
        film = retainedTreadFilm(film, depth, 0, 0.004, 0.31, 3, 1 / hz);
        bike.sample(x, z, film, depth, 0, soil, load, 0.15);
      };
      sample(0, 0, 1);
      for (let i = 1; i <= 2 * hz; i++) sample(0, 3 * i / hz, Number(i <= hz));
      const carried = bike.soil, print = field.sampleAt(0, 4.5, p).y;
      expect(field.sampleAt(0.08, 4.5, p).y).toBe(0);
      const marks = field.points;
      for (let i = 0; i < hz; i++) sample(0, 6, 1);
      expect(field.points).toBe(marks); expect(bike.soil).toBe(carried);
      for (let i = 1; i <= hz; i++) sample(0, 6 + 3 * i / hz, 0, 0.012);
      expect(bike.soil).toBeLessThan(0.01);
      expect(field.sampleAt(0, 7.5, p).length()).toBe(0);
      sample(0, 9, 0, 0, 0); sample(0.5, 8, 0); sample(0.5, 7.95, 0);
      expect(field.sampleAt(0.25, 8.5, p).length()).toBe(0);
      // A 35 mm tire fits inside a single 40 mm texel. Its filtered footprint survives an oblique path.
      bike.reset();
      for (let i = 0; i <= 80; i++) sample(i * 0.025, -4 + i * 0.04, 1);
      expect(field.sampleAt(1.5, -1.6, p).y).toBeGreaterThan(0.2);
      sample(-4, -9, 0);
      expect(bike.soil).toBe(0);
      expect(field.sampleAt(-2, -5, p).y).toBe(0);
      field.update(130, 0, 0);
      expect(field.sampleAt(0, 4.5, p).length()).toBe(0);
      return { carried, print, film };
    } finally { field.dispose(); }
  }
  const a = ride(30), b = ride(120);
  expect(a.carried).toBeCloseTo(b.carried, 8);
  expect(a.print).toBeGreaterThan(0.25);
  expect(Math.abs(a.print - b.print)).toBeLessThan(0.02);
});

test('thin wet bicycle tracks retain the same fraction across a subtexel shift during drying', () => {
  const field = new TreadTransfer(), point = new Vector3();
  try {
    field.stamp(.02, 0, .02, 1, .03, 1, 0, 0);
    field.stamp(.84, 0, .84, 1, .03, 1, 0, 0);
    const centered = field.sampleAt(.02, .42, point).x, split = field.sampleAt(.84, .42, point).x;
    for (let i = 0; i < 14; i++) field.update(.5, 0, 0);
    const centeredRatio = field.sampleAt(.02, .42, point).x / centered;
    const splitRatio = field.sampleAt(.84, .42, point).x / split;
    expect(centeredRatio).toBeGreaterThan(.34);
    expect(Math.abs(centeredRatio - splitRatio)).toBeLessThan(.02);
  } finally { field.dispose(); }
});

for (const backend of ['webgpu','webgl2'] as const) {
  test(backend + ' one-sided soil pickup and material samples agree across a scrolling map edge', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    await page.locator('#ui').evaluate(el => { (el as HTMLElement).style.display=''; });
    await page.getByRole('button', {name:'Cross muddy shoulder'}).click();
    await page.waitForFunction('lumina.scene.vehicle.root.position.z > 76');
    const read = await page.evaluate(async () => {
      const { engine, scene: s } = (window as any).lumina, T = (window as any).THREE, n = T.TSL;
      engine.stop();
      const near = s.tracks.sampleAt(-2.78, 73, new T.Vector3()).y;
      const far = s.tracks.sampleAt(-1.02, 73, new T.Vector3()).y;
      const field = new s.tracks.constructor(), p = new T.Vector3();
      const r=engine.renderer, saved=r.getRenderTarget(), target=new T.RenderTarget(12,1,{type:T.FloatType,depthBuffer:false});
      const mat=new T.NodeMaterial(), start=n.uniform(0), step=.013, z=.2;
      mat.fragmentNode=n.vec4(field.sampleNode(n.vec2(start.add(n.uv().x.mul(12 * step)), z)), 1);
      const quad=new T.QuadMesh(mat);
      const compare = async (left: number) => {
        start.value = left;
        r.setRenderTarget(target); quad.render(r); r.setRenderTarget(saved);
        const pixels=await r.readRenderTargetPixelsAsync(target,0,0,12,1);
        let delta=0, max=0;
        for(let i=0;i<12;i++){
          const cpu=field.sampleAt(left+(i+.5)*step,z,p);
          delta=Math.max(delta,Math.abs(cpu.x-pixels[4*i]),Math.abs(cpu.y-pixels[4*i+1]),Math.abs(cpu.z-pixels[4*i+2]));
          max=Math.max(max,pixels[4*i+1]);
        }
        return {delta,max};
      };
      try {
        field.stamp(-5.1,0,-5.1,.5,.21,.6,1,0);
        field.stamp(5.06,0,5.06,.5,.12,0,.22,0);
        field.update(0,0,0);
        const edge=await compare(-5.16);
        field.update(0,1.5,0);
        const cleared=await compare(5.12), kept=await compare(5.01);
        field.update(0,45,100);
        return {near,far,edge,cleared,kept, old:field.sampleAt(5,.2,p).y};
      } finally {r.setRenderTarget(saved);target.dispose();mat.dispose();field.dispose();}
    });
    expect(read.near).toBeGreaterThan(.55);expect(read.far).toBe(0);
    expect(read.edge.max).toBeGreaterThan(.7);expect(read.edge.delta).toBeLessThan(.012);
    expect(read.kept.max).toBeGreaterThan(.15);expect(read.kept.delta).toBeLessThan(.012);
    expect(read.cleared.max).toBeLessThan(.12);expect(read.cleared.delta).toBeLessThan(.012);
    expect(read.old).toBe(0);expect(log.errors).toEqual([]);
  });
}
