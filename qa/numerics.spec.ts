import { createHash } from 'node:crypto';
import { bakeCloudNoise, prepareCloudNoise } from '../engine/noise';
import { test, expect } from '@playwright/test';
import { BufferGeometry, DataUtils, Float32BufferAttribute, Group, MathUtils, Mesh, Uint8BufferAttribute, Vector2, Vector3 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { InteractionField, SOURCE_STRIDE } from '../modules/water/interaction';
import { Bathymetry } from '../modules/water/seabed';
import { seabedGeometry } from '../modules/water/bed-mesh';
import { WaveProbeGrid } from '../modules/water/wave-probe';
import { CpuCascade } from '../modules/water/fft-cpu';
import { buildInitialSpectrum, cascadeLayout, OCEAN_PRESETS } from '../modules/water/spectrum';
import { TrailRibbon } from '../modules/aero/trails';
import { addCanopyHorizons, createHeadlandGeometry } from '../showcase/scenery/terrain';
import { Tsunami } from '../modules/water/tsunami';

test('a hull and a spray emitter meet the displaced, falling breaker lip', () => {
  const wave = new Tsunami(), base = new Vector3(), lip = new Vector3();
  wave.launch({x: 0, z: 0}, 60, { height: 24, width: 46, direction: 0.73, breaking: 0.92 });
  for (let i = 0; i < 240; i++) wave.update(1 / 60);
  for (const cross of [-43, 3, 79]) for (const depth of [4, 17, 200]) {
    wave.crestBase(cross, base);
    wave.crestPoint(cross, lip, depth);
    const H = 24 * wave.amplitude * (1 + 0.16 * Math.sin(cross * 0.017 + 0.5) + 0.06 * Math.sin(cross * 0.083 + 0.9))
      * Math.min(1.8, Math.max(1, (60 / depth) ** 0.25));
    const b = (0.73 + 0.27 * Math.sin(cross * 0.043 + 1.4) * Math.cos(cross * 0.013))
      * Math.max(0.92, MathUtils.smoothstep(H / depth, 0.45, 0.95));
    const forward = 1.37 * b * H;
    expect(Math.hypot(lip.x - base.x, lip.z - base.z)).toBeCloseTo(forward, 6);
    expect(lip.y).toBeCloseTo(H * (1 - 0.1 * Math.exp(-2.25) - 0.2 * b * b), 6);
    expect(wave.heightAt(lip.x, lip.z, depth)).toBeCloseTo(lip.y, 1);
    expect(wave.restOffset(lip.x, lip.z, depth)).toBeCloseTo(-forward, 1);
    expect(wave.heightAt(lip.x + 300, lip.z + 300, depth)).toBeCloseTo(0, 5);
  }
});

test('a full wake pool preserves priority emitters and rejects excess pressure safely', () => {
  const field = new InteractionField({} as WebGPURenderer,64,96);
  const slots = field.sources.length / SOURCE_STRIDE;
  for (let i=0; i<slots; i++) field.addSource({ x:i, z:0, radius:2, push:1 }, i % 2 === 0);
  expect(field.reserveSource()).toBe(-1);
  for (let i=slots-1; i>0; i-=2) {
    const offset = field.reserveSource(true);
    expect(offset).toBe(i * SOURCE_STRIDE);
    field.sources[offset] = 100+i;
  }
  expect(field.reserveSource(true)).toBe(-1);
  for (let i=0; i<slots; i++) expect(field.sources[i*SOURCE_STRIDE]).toBe(i%2 ? 100+i : i);
  field.dispose();
});

test('a translated coast sees overhead foliage, an eastern tree and a distant clearing', () => {
  const g = new BufferGeometry(), mesh = new Mesh(g);
  g.setAttribute('position', new Float32BufferAttribute([0,0,0, 5,0,0, 90,0,0], 3));
  for (const name of ['horizonCardinal','horizonDiagonal']) g.setAttribute(name, new Uint8BufferAttribute(new Uint8Array(12),4,true));
  mesh.position.set(100,3,-20);
  addCanopyHorizons(mesh, [{x:105,y:3,z:-20,scale:1}], 5,2,2);
  const c = g.getAttribute('horizonCardinal');
  expect(c.getX(0)).toBeGreaterThan(0.65);
  expect(c.getZ(0)).toBe(0);
  for (let k=0; k<4; k++) expect(c.getComponent(1,k)).toBeGreaterThan(0.9);
  expect(c.getX(2)).toBe(0);
  g.dispose();
});

test('rotated coastal terrain grounds tree roots on every rendered triangle', () => {
  const { geometry, heightAt } = createHeadlandGeometry({ x: 121, z: -63, radiusX: 140, radiusZ: 87,
    height: 54, rotation: 0.61, segments: 32, seed: 11 });
  const indices = geometry.index!, p = geometry.getAttribute('position');
  expect(indices.count).toBeLessThan(32 * 32 * 6);
  for (let i = 0; i < indices.count; i += 21) {
    const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2);
    const x = 0.4 * p.getX(a) + 0.35 * p.getX(b) + 0.25 * p.getX(c);
    const z = 0.4 * p.getZ(a) + 0.35 * p.getZ(b) + 0.25 * p.getZ(c);
    expect(heightAt(x, z)).toBeCloseTo(0.4 * p.getY(a) + 0.35 * p.getY(b) + 0.25 * p.getY(c), 3);
  }
  expect(heightAt(5000, -10)).toBe(-14);
  geometry.dispose();
});

test('low-frequency FFT keyframes track exact updates across seeks and parameter changes', () => {
  const grid = 64;
  for (const [index, band] of cascadeLayout(grid, 3).slice(0, 2).entries()) {
    const a = buildInitialSpectrum(grid, band, index, OCEAN_PRESETS.hurricane);
    const b = buildInitialSpectrum(grid, band, index, OCEAN_PRESETS.lagoon);
    const exact = new CpuCascade(band, grid, a, b, grid, 300);
    const interpolated = new CpuCascade(band, grid, a, b, grid, 300);
    const interval = Math.min(1 / 15, 2 * Math.PI / (32 * Math.sqrt(9.81 * band.kMax)));
    let squaredError = 0, energy = 0;
    for (let k = 0; k < 240; k++) {
      const t = (k < 180 ? k : k - 180) / 60, blend = k < 150 ? 0.2 : 0.8, chop = k < 100 ? 1 : 0.85;
      exact.update(t, chop, blend);
      interpolated.updateInterpolated(t, chop, blend, interval);
      for (let j = 1; j < exact.displacement.length; j += 4) {
        const h = exact.displacement[j], error = h - interpolated.displacement[j];
        energy += h * h;
        squaredError += error * error;
      }
    }
    expect(Math.sqrt(squaredError / energy)).toBeLessThan(0.005);
    interpolated.update(59 / 60, 0.85, 0.8);
    expect(interpolated.displacement.every((v, i) => v === exact.displacement[i])).toBe(true);
    const coords = new Float64Array([-14.3, 1.9, 300, -8.7, -1025.8, 923]);
    const sample = new Float64Array(9);
    exact.sampleBatch(coords, sample, true);
    exact.sampleBatch(coords, sample, false);
    for (let i = 0; i < 3; i++) {
      const point: [number,number,number] = [0,0,0];
      exact.sample(coords[i * 2], coords[i * 2 + 1], point);
      expect([...sample.slice(i * 3, i * 3 + 3)]).toEqual(point);
    }
  }
});

test('sparse buoyancy texels match the complete FFT between keyframes and after a seek', () => {
  const size=32,band=cascadeLayout(size,2)[0];
  const a=buildInitialSpectrum(size,band,0,OCEAN_PRESETS.hurricane),b=buildInitialSpectrum(size,band,0,OCEAN_PRESETS.swell);
  const dense=new CpuCascade(band,size,a,b,size,300),sparse=new CpuCascade(band,size,a,b,size,300);
  const coords=new Float64Array(28),lhs=new Float64Array(42),rhs=new Float64Array(42);
  for(let i=0;i<260;i++){
    const t=(i<200?i:i-200)/60,blend=i<160?0.15:0.75,chop=i<80?1.15:0.8;
    dense.updateInterpolated(t,chop,blend,1/15);sparse.updateInterpolated(t,chop,blend,1/15,true);
    for(let j=0;j<coords.length;j++)coords[j]=Math.sin(j*0.78+t*0.62)*470+t*4;
    lhs.fill(0);rhs.fill(0);
    for(const horizontal of [true,false]){
      dense.sampleBatch(coords,lhs,horizontal);sparse.sampleBatch(coords,rhs,horizontal);
    }
    expect(rhs).toEqual(lhs);
  }
  sparse.update(3.9,0.6);dense.update(3.9,0.6);expect(sparse.displacement).toEqual(dense.displacement);
});

test('hover pressure produces a local buoyancy dish and raised rim across a scrolling grid', () => {
  const field=new WaveProbeGrid(96,96), source=new Float32Array([12,-7,5.2,-6.3,0,0,1]);
  for(let i=0;i<55;i++)field.step(1/60,i<30?0:7,0,4.2,0.22,source,1);
  const centre=field.sample(12,-7), rim=field.sample(17,-7);
  expect(centre).toBeLessThan(-0.45);
  expect(rim).toBeGreaterThan(0.12);
  expect(field.sample(40,22)).toBeCloseTo(0,5);
  const points=new Float64Array([12,-7,17.32,-6.78,39.7,21.4,500,10]);
  const heights=new Float64Array([1,2,3,4]);
  field.addHeights(points,heights);
  for(let j=0;j<heights.length;j++)expect(heights[j]).toBeCloseTo(j+1+field.sample(points[2*j],points[2*j+1]),8);
  field.step(0,12,-6,4.2,0.22,source,0);
  expect(field.sample(12,-7)).toBeCloseTo(centre,6);
  for(let i=0;i<90;i++)field.step(1/60,12,-6,4.2,0.22,source,0);
  expect(field.sample(12,-7)).toBeGreaterThan(centre+0.2);
  expect(field.sample(120,-7)).toBe(0);
});

test('slow wingtip motion accumulates trail length through ring wrap and clear', () => {
  const trail = new TrailRibbon({ capacity: 8, spacing: 3, life: 5, width: 0.2, widthEnd: 1 });
  const pos = new Vector3();
  for (let i = 0; i < 1200; i++) {
    trail.push(pos.set(i * 0.2, 2, -8));
    trail.update(1 / 60);
  }
  const { geometry } = trail.mesh;
  expect(geometry.drawRange.count).toBe(42);
  const centers = geometry.getAttribute('center');
  expect(centers.getX(0)).toBeCloseTo(239.8, 3);
  expect(centers.getX(0) - centers.getX(14)).toBeGreaterThan(16);
  for (let i = 2; i < 16; i += 2) expect(centers.getX(i)).toBeLessThan(centers.getX(i - 2));
  trail.clear();
  expect(geometry.drawRange.count).toBe(0);
  trail.dispose();
});

test('overlapping static coast meshes raise the GPU depth grid and CPU water probes together', () => {
  const resolution = 17;
  const bed = new Bathymetry({ height: () => -8, size: 16, resolution, segments: 4 });
  const plane = new BufferGeometry();
  plane.setAttribute('position', new Float32BufferAttribute([-2, 0, -2, 2, 2, -2, 2, 2, 2, -2, 0, 2], 3));
  plane.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new Mesh(plane), coast = new Group();
  coast.position.set(2, 2, -1);
  coast.add(mesh);
  bed.addCoast(mesh);
  const measure = (x: number, z: number) => DataUtils.fromHalfFloat(
    (bed.texture.image.data as Uint16Array)[((z + 8) * resolution + x + 8) * 4]);
  expect(measure(1, -1)).toBe(2.5);
  expect(bed.heightAt(1.5, -1)).toBeCloseTo(2.75);
  expect(bed.heightAt(-5, 5)).toBe(-8);
  const upper = new Mesh(plane.toNonIndexed());
  upper.position.y = 1.25;
  coast.add(upper);
  bed.addCoast(upper);
  bed.addCoast(mesh);
  expect(measure(1, -1)).toBe(3.75);
  expect(bed.heightAt(1.5, -1)).toBeCloseTo(4);
  bed.setSink(5);
  expect(bed.depthAt(1.5, -1)).toBeCloseTo(1);
  bed.dispose();
  upper.geometry.dispose();
  plane.dispose();
});

test('adaptive seabed stays watertight across coarse/fine edges and preserves shore relief', () => {
  const segments = 49, width = 49;
  const bed = (x: number,z: number) => -2 + 0.016 * x * z + 2.8 * Math.exp(-((x-8)**2 + (z+6)**2) / 14);
  const geo = seabedGeometry(width, new Vector2(), segments, bed);
  const p = geo.getAttribute('position'), index = geo.getIndex()!;
  const edgeCounts = new Map<string, number>();
  let maxError = 0, area = 0;
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i),index.getX(i+1),index.getX(i+2)];
    for (let j = 0; j < 3; j++) {
      const a = tri[j], b = tri[(j+1) % 3];
      // A boundary edge lies entirely on one outer edge. Every other edge
      // must be used twice, including edges between different resolutions.
      if ((p.getX(a) === p.getX(b) && Math.abs(p.getX(a)) === width / 2) ||
          (p.getZ(a) === p.getZ(b) && Math.abs(p.getZ(a)) === width / 2)) continue;
      const key = [a,b].sort((a,b)=>a-b).join(',');
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
    const [a,b,c] = tri;
    const twiceArea = (p.getZ(b)-p.getZ(a))*(p.getX(c)-p.getX(a))-(p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a));
    expect(twiceArea).toBeGreaterThan(0);
    area += twiceArea / 2;
    const x = (p.getX(a)+p.getX(b)+p.getX(c))/3, z = (p.getZ(a)+p.getZ(b)+p.getZ(c))/3;
    maxError = Math.max(maxError, Math.abs((p.getY(a)+p.getY(b)+p.getY(c))/3 - bed(x,z)));
  }
  expect([...edgeCounts.values()].every(count => count === 2)).toBe(true);
  expect(area).toBeCloseTo(width * width);
  expect(maxError).toBeLessThan(0.12);
  expect(index.count/3).toBeLessThan(segments ** 2);
  console.log(`Adaptive bed: ${index.count/3} vs ${segments ** 2 * 2} triangles, ${(maxError*100).toFixed(2)} cm maximum centroid error`);
  geo.dispose();
});

test('cooperative cloud preparation preserves every seeded texture byte', async () => {
  await Promise.all([prepareCloudNoise(), prepareCloudNoise()]);
  const { base, detail, weather } = bakeCloudNoise();
  const hashes = [base, detail, weather].map(texture =>
    createHash('sha256').update(texture.image.data as Uint8Array).digest('hex'));
  expect(hashes).toEqual([
    '1e5056a65008590b433c80c403bf5144ac612fa004b7ec2de4c8879824432b55',
    'f53faf2fde1fcd446a1904b8b988ea2b92e2198c4e2d4f3ecb821e49aa7a4a7a',
    '158805497abb13fe6fd4602cec55a56c53245a73b43618141061271a94c47e8c',
  ]);
  expect(bakeCloudNoise().base).toBe(base);
});
