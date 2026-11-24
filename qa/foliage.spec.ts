import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';
import { mkdirSync, writeFileSync } from 'node:fs';

for (const backend of ['webgpu','webgl2']) for (const view of ['headland','tire']) {
  test(backend + ' foliage at 1080p from ' + view, async ({page}) => {
    const log = watchConsole(page);
    await page.setViewportSize({width:1920,height:1080});
    await page.goto('/profiles.html?ui=0&tier=high&view='+view+(backend==='webgl2'?'&webgl=1':''));
    await page.waitForFunction(()=>!!(window as any).profileGallery);
    await page.waitForTimeout(1900);
    const sample = await page.evaluate(async()=>{
      const g=(window as any).profileGallery, e=g.world.engine;
      const frames:number[] = [];
      let last=0;
      await new Promise<void>(resolve=>{
        const next=(now:number)=>{ if(last) frames.push(now-last); last=now;
          if(frames.length<180) requestAnimationFrame(next); else resolve(); };
        requestAnimationFrame(next);
      });
      frames.sort((a,b)=>a-b);
      return {backend:e.backend, readyMs:g.readyMs, p95:frames[171],
        fps:180000/frames.reduce((a,b)=>a+b,0), scale:e.stats.renderScale,
        width:e.renderer.domElement.width, height:e.renderer.domElement.height,
        grass:g.world.foliage.grass.count, trees:g.world.foliage.crowns.count};
    });
    console.log(backend,view,JSON.stringify(sample));
    mkdirSync('qa/output/profiles',{recursive:true});
    writeFileSync('qa/output/profiles/foliage-'+backend+'-'+view+'.json',JSON.stringify(sample));
    expect(log.errors).toEqual([]); expect(sample.backend).toBe(backend);
    expect(sample.grass).toBeGreaterThan(100); expect(sample.trees).toBeGreaterThan(1);
    expect(sample.fps).toBeGreaterThanOrEqual(58); expect(sample.p95).toBeLessThanOrEqual(18);
  });
}
