import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { openScene, watchConsole } from './helpers';

test('rough swell shades the submerged side of the independently measured near-plane contour', async ({ page }) => {
  const log = watchConsole(page);
  await openScene(page, 'lagoon', 'high', 'webgpu');
  await page.evaluate(() => (window as any).lumina.scene.applySea(1));
  await page.waitForTimeout(700);
  const contour = await page.evaluate(async () => {
    const { engine, scene } = (window as any).lumina;
    engine.paused = true;
    engine.onBeforeRender = null;
    engine.lens.clear();
    scene.underwater.params.meniscus = 1;
    const ocean = scene.ocean, camera = engine.camera;
    // Freeze evolution, then read real WebGPU storage textures. In this part of the
    // open ocean the depth, breaking surf and local interaction field have no contribution.
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const cascades: { n: number; length: number; data: Float32Array }[] = [];
    for (const c of ocean.cascades) {
      const raw = await engine.renderer.backend.copyTextureToBuffer(c.displacement, 0, 0, c.resolution, c.resolution, 0);
      const data = new Float32Array(raw.length);
      if (raw instanceof Uint16Array) {
        for (let i = 0; i < data.length; i++) {
          const bits = raw[i], exp = (bits >> 10) & 31, mantissa = bits & 1023;
          data[i] = (bits & 32768 ? -1 : 1) * (exp ? (1 + mantissa/1024)*2**(exp-15) : mantissa*2**-24);
        }
      } else data.set(raw);
      cascades.push({ n: c.resolution, length: c.layout.length, data });
    }
    function displacement(x: number, z: number, channel: number) {
      let sum = 0;
      for (const { n, length, data } of cascades) {
        const u = x/length*n - 0.5, v = z/length*n - 0.5;
        const i = Math.floor(u), j = Math.floor(v), fx = u-i, fz = v-j;
        const at = (i: number,j: number) => data[4*((j & (n-1))*n + (i & (n-1))) + channel];
        const a = at(i,j) * (1-fx) + at(i+1,j)*fx, b = at(i,j+1)*(1-fx) + at(i+1,j+1)*fx;
        sum += a*(1-fz) + b*fz;
      }
      return sum;
    }
    function height(x: number,z: number) {
      let px = x, pz = z;
      for (let i = 0; i < 2; i++) {
        const ox = displacement(px,pz,0), oz = displacement(px,pz,2);
        px = x-ox; pz = z-oz;
      }
      return ocean.waterLevel + displacement(px,pz,1);
    }
    const half = camera.near*Math.tan(camera.fov*Math.PI/360);
    const z = 420.73;
    let x = 400;
    // Choose an actual sloping section with both media well inside the viewport.
    for (let i = 0; i < 300; i++) {
      const candidate = 400 + i*0.67;
      const slope = Math.abs((height(candidate+0.18,z)-height(candidate-0.18,z))/0.36);
      if (slope > 0.16 && slope < 0.34) { x = candidate; break; }
    }
    const y = height(x,z);
    camera.position.set(x, y, z + camera.near);
    camera.lookAt(x, y, z - 10);
    camera.updateMatrixWorld(true);
    const rows: number[] = [];
    for (let column = 1; column < 16; column++) {
      const ndc = 2*column/16 - 1;
      const surface = height(x + ndc*half*camera.aspect,z);
      rows.push((1-(surface-y)/half)/2);
    }
    return { hs: ocean.significantHeight, rows };
  });
  expect(contour.hs).toBeGreaterThan(1);
  expect(Math.max(...contour.rows) - Math.min(...contour.rows)).toBeGreaterThan(0.12);
  await page.waitForTimeout(650);
  const wet = PNG.sync.read(await page.screenshot());
  await page.evaluate(() => (window as any).lumina.engine.pipeline.removeEffect('underwater'));
  await page.waitForTimeout(650);
  const dry = PNG.sync.read(await page.screenshot());
  const changes = (offset: number) => contour.rows.map((row, i) => {
    const sx = Math.round((i+1)*wet.width/16), sy = Math.round((row+offset)*wet.height);
    let delta = 0, samples = 0;
    for (let y = sy-2; y <= sy+2; y++) for (let x = sx-2; x <= sx+2; x++) {
      if (y < 0 || y >= wet.height) continue;
      for (let c = 0; c < 3; c++) {
        const index = (y*wet.width+x)*4+c;
        delta += Math.abs(wet.data[index]-dry.data[index]); samples++;
      }
    }
    return delta / Math.max(1,samples);
  });
  const air = changes(-0.085), water = changes(0.085);
  const avg = (v: number[]) => v.reduce((a,b) => a+b,0)/v.length;
  console.log(`Rough split: ${contour.hs.toFixed(2)} m sea, ${(Math.min(...contour.rows)*100).toFixed(0)}–${(Math.max(...contour.rows)*100).toFixed(0)}% contour; mean RGB change ${avg(air).toFixed(1)} above, ${avg(water).toFixed(1)} below`);
  expect(log.errors).toEqual([]);
  expect(avg(air)).toBeLessThan(12);
  expect(avg(water)).toBeGreaterThan(avg(air) + 8);
  expect(water.filter((v,i) => v > air[i]+3).length).toBeGreaterThanOrEqual(11);
});
