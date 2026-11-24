import { test, expect } from '@playwright/test';
import { watchConsole, openScene } from './helpers';
import { PNG } from 'pngjs';

for(const backend of ['webgpu','webgl2'] as const){
  test(backend+' rough-water highlight follows the solar disc',async({page})=>{
    await page.setViewportSize({width:896,height:504});const log=watchConsole(page);
    await page.goto('/profiles.html?ui=0&tier=high'+(backend==='webgl2'?'&webgl=1':''));
    await page.waitForFunction(()=>!!(window as any).profileGallery);
    const samples=[];
    for(const azimuth of [-11,11]){
      const sunX=await page.evaluate(async angle=>{
        const w=(window as any).profileGallery.world,e=w.engine,c=e.camera;
        e.onBeforeRender=undefined;e.trauma.rumble=0;
        c.position.set(150,5,30);c.lookAt(400,0,30);c.updateMatrixWorld();
        Object.assign(w.weather.params,{sunElevation:6,sunAzimuth:angle,coverage:0,rain:0,storm:0,turbidity:2.3});
        await new Promise<void>(done=>{
          const first=e.stats.frames;
          const settle=()=>e.stats.frames-first>=75?done():requestAnimationFrame(settle);
          requestAnimationFrame(settle);
        });
        const dir=w.weather.getSunDirection().multiplyScalar(4000).add(c.position).project(c);
        return (dir.x+1)/2;
      },azimuth);
      let total=0,weighted=0;
      for(let frame=0;frame<6;frame++){
      await page.waitForTimeout(75);
      const png=PNG.sync.read(await page.screenshot());
      for(let y=Math.floor(png.height*0.55);y<png.height*0.85;y++)for(let x=0;x<png.width;x++){
        const i=(y*png.width+x)*4;
        const w=Math.pow(Math.max(0,(png.data[i]*0.34+png.data[i+1]*0.56+png.data[i+2]*0.1)/255-0.46),3);
        total+=w;weighted+=w*x/png.width;
      }
      }
      samples.push({sunX,glint:weighted/total,energy:total});
    }
    console.log(backend,'solar path',JSON.stringify(samples));expect(log.errors).toEqual([]);
    for(const s of samples){expect(s.energy).toBeGreaterThan(0.2);expect(Math.abs(s.sunX-s.glint)).toBeLessThan(0.055);}
    expect(samples[1].glint-samples[0].glint).toBeGreaterThan(0.12);
  });
  test(backend+' cockpit retains contrast in a bright lower cloud bank',async({page})=>{
    await page.setViewportSize({width:960,height:540});const log=watchConsole(page);
    await openScene(page,'jet','high',backend);
    const crop=await page.evaluate(()=>{
      const {engine:e,scene:{weather,jet,cloudPass}}=(window as any).lumina;
      const T=(window as any).THREE;cloudPass();e.stop();
      let now=performance.now();for(let i=0;i<38;i++) e.tick(now+=16.67);
      e.onBeforeRender=undefined;e.onUpdate=undefined;e.trauma.rumble=0;
      const airframe=jet.rig.object;
      const canopy=airframe.getObjectByName('Canopy glazing');
      const center=canopy.getWorldPosition(new T.Vector3());
      const offset=new T.Vector3(3.8,3.9,6.8).applyQuaternion(airframe.quaternion);
      e.camera.position.copy(center).add(offset);e.camera.lookAt(center);e.camera.updateMatrixWorld();
      for(let i=0;i<16;i++) e.tick(now+=16.67);
      const box=new T.Box3().setFromObject(canopy,true), xs:number[]=[],ys:number[]=[];
      for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
        const p=new T.Vector3(x,y,z).project(e.camera);xs.push((p.x+1)*480);ys.push((1-p.y)*270);
      }
      return {x:Math.max(0,Math.floor(Math.min(...xs))),y:Math.max(0,Math.floor(Math.min(...ys))),
        w:Math.min(959,Math.ceil(Math.max(...xs))),h:Math.min(539,Math.ceil(Math.max(...ys))),
        altitude:center.y,base:weather.params.cloudBase,top:weather.params.cloudTop};
    });
    const png=PNG.sync.read(await page.screenshot()),luma:number[]=[];
    for(let y=crop.y;y<=crop.h;y++)for(let x=crop.x;x<=crop.w;x++){const i=4*(y*png.width+x);luma.push((png.data[i]+2*png.data[i+1]+png.data[i+2])/4);}
    luma.sort((a,b)=>a-b);const low=luma[Math.floor(luma.length*0.1)],high=luma[Math.floor(luma.length*0.9)];
    console.log(backend,'canopy',crop,low,high);
    expect(crop.altitude).toBeGreaterThan(crop.base);expect(crop.altitude).toBeLessThan(crop.top);
    expect(high-low).toBeGreaterThan(28);expect(low).toBeLessThan(170);expect(log.errors).toEqual([]);
  });
}
