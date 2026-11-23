import { ActiveRagdoll } from '../../modules/ragdoll/active';
import { FlexibleTree } from '../../modules/strands/sapling';
import { WeatherVortex } from '../../modules/weather/vortex';
import * as THREE from 'three/webgpu';
import { EffectsKit } from '../../engine/fx';
import { Weather, WEATHER_PRESETS } from '../../modules/weather/weather';
import { InlandWater, RIVER_PRESETS } from '../../modules/water/inland';
import { StrandSystem } from '../../modules/strands';
import { createTitaniumMaterial, createTimberMaterial, createSeaSprayGlassMaterial } from '../../modules/materials';
import { SoftBodySystem } from '../../modules/softbody';
import { TracerField, type ImpactSurface } from '../../modules/ballistics';
import { FollowOrbit } from '../camera';
import { buildRiverValley, disposeValley, crestY, fallsZ, riverCenter, upperWater, valleyHeight } from '../scenery/river-valley';
import type { ShowcaseScene } from './types';

export const riverScene: ShowcaseScene = {
  id: 'river', label: 'River Rapids', title: 'Soft Bodies, Strands, Rivers & Ballistics', description: '',
  async create({ engine, panel, canvas }) {
    const { camera, scene } = engine;
    camera.near = 0.11; camera.far = 40000; camera.fov = 49; camera.updateProjectionMatrix();
    const weather = engine.add(new Weather(engine));
    Object.assign(weather.params, WEATHER_PRESETS.goldenHour, {
      sunElevation: 29, sunAzimuth: 148, coverage: 0.35, turbidity: 2.4, exposure: 0.72, shafts: 0.36,
    });
    weather.shadowFocus.set(-1, 1, -6);
    weather.shadowExtent = 24;
    const bounce = new THREE.HemisphereLight(0xd9e5ed, 0x706e50, 0.64);
    scene.add(bounce);
    const valley = buildRiverValley(engine.world);
    scene.add(valley);
    const fx = engine.add(new EffectsKit(engine));
    fx.setFloor(-0.1);
    const inland = engine.add(new InlandWater(engine, { weather, fx }));
    const channel = (z: number, y: number) => ({ x: riverCenter(z), y, z });
    inland.addRiver({ ...RIVER_PRESETS.forestStream, width: 11.8, flowmapSize: 128, autoRocks: 3,
      // The upper reach comes round a bend from the valley head and steepens upstream; the
      // stations at z >= -32 (and the crest) are where they were.
      points: [-108, -94, -80, -68, -56, -46, -38, -32, -24, fallsZ - 0.8].map(z => channel(z, upperWater(z))) });
    const river = inland.addRiver({ ...RIVER_PRESETS.mountainRapids, turbulence: 0.26, optics: { foam: 0.83, rapidsFoam: 0.95, clarity: 0.76 }, speed: 1.1, width: 12.9, autoRocks: 5, flowmapSize: 128,
      points: [fallsZ, -12, -5, 2, 12, 28, 48].map(z => channel(z, 0)) });
    const falls = inland.addWaterfall({ position: channel(fallsZ - 1, crestY), direction: Math.PI / 2, height: crestY,
      width: 8.4, exitSpeed: 2.3, aeration: 0.76, mistIntensity: 0.65, plungeRadius: 3.4 });
    const strands = engine.add(new StrandSystem(engine, { groundY: -1.5, substeps: 1 }));
    const grass = strands.grass({ center: new THREE.Vector3(0, 0, -2), size: [28, 32], count: 2600,
      height: [0.18, 0.69], width: 0.023, heightAt: valleyHeight,
      mask: (x, z) => valleyHeight(x,z) > 0.16 });
    const kelp = strands.kelp({ center: new THREE.Vector3(0, -1, 3), size: [7, 14],
      count: 94, segments: 4, height: [0.27, 0.74], width: 0.035, heightAt: valleyHeight });
    inland.flowAt(0, 2, strands.waterCurrent);
    const soft = engine.add(new SoftBodySystem(engine, { ocean: inland, waterLevel: 0, groundY: -1.2, substeps: 2, iterations: 3 }));
    const buoyStart = new THREE.Vector3(0.5, 0.4, 0);
    const buoy = soft.buoy({ position: buoyStart, radius: 0.28, length: 0.62, mass: 18, stiffness: 0.46, strutWeight: 0.18, pressure: 1.25, colors: [0x952d17, 0xd8cdb0] });
    const ringStart = new THREE.Vector3(-1.95, 0.35, -2.8);
    const ring = soft.torus({ position: ringStart, pattern: 'lifeRing', majorRadius: 0.63, tubeRadius: 0.16, stiffness: 0.63, strutWeight: 0.25, colors: [0xb14f1a, 0xcfc8ab], mass: 12 });
    const nudge = () => {
      buoy.kick(new THREE.Vector3(0.7, -2.4, 0.4));
      buoy.impulseAt(buoy.getCenter().add(new THREE.Vector3(0.16, 0.22, 0)), new THREE.Vector3(-2.7, -4.2, 0.8), 0.38);
      ring.impulseAt(ring.getCenter().add(new THREE.Vector3(0.53, 0.04, 0)), new THREE.Vector3(-1.9, 4.2, 0.7), 0.76);
    };
    const tracers = engine.add(new TracerField(engine, fx));
    const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    tracers.addSurface({ kind: 'water', orientation: up, center: new THREE.Vector3(0, 0.03, 0), width: 10, height: 45 });

    const origin = new THREE.Vector3(-2.5, 0.94, -5.5);
    const velocity = new THREE.Vector3(3.8, 0.7, 10.2);
    const skip = () => tracers.launch(origin, velocity);
    const fixtures = new THREE.Group();
    const impactPoint = new THREE.Vector3(6.3, valleyHeight(6.3, -3) + 0.64, -3);
    const panelFacing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const surfaces: Record<'glass' | 'wood' | 'steel', THREE.Material> = {
      glass: createSeaSprayGlassMaterial(), wood: createTimberMaterial(), steel: createTitaniumMaterial(),
    };
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.3, 0.045), surfaces.glass);
    plate.position.copy(impactPoint); plate.quaternion.copy(panelFacing);
    plate.castShadow = true;
    fixtures.add(plate);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.062, 1.25, 10), new THREE.MeshStandardNodeMaterial({ color: 0x514939, roughness: 0.78 }));
    leg.position.copy(impactPoint); leg.position.y -= 0.86;
    fixtures.add(leg); scene.add(fixtures);
    const probeOrigin = new THREE.Vector3(), probeVelocity = new THREE.Vector3();
    let kind: ImpactSurface = 'glass';
    const register = () => tracers.addSurface({ kind, center: impactPoint, orientation: panelFacing, width: 1.05, height: 1.3, breakaway: kind !== 'steel' });
    let removePlate = register();
    const passThrough = () => {
      probeOrigin.copy(impactPoint).add(new THREE.Vector3(-1.2, 0.01, -3));
      probeVelocity.set(4.8, 1.15, 12);
      tracers.launch(probeOrigin, probeVelocity);
    };
    const target = new THREE.Vector3(-0.7, 1.3, -6.1);
    const orbit = new FollowOrbit(camera, canvas, target, new THREE.Vector3(2.9, 3.1, 16.0));
    orbit.controls.minDistance = 2.5; orbit.controls.maxDistance = 45;
    const state = { wind: 4.5 };
    engine.wind.set(1.0, state.wind, 0.3);


    panel.header('River rapids', 'Inspect the current, floating body and bank vegetation up close.');
    panel.slider('Crosswind', 0, 18, 0.1, () => state.wind, value => { state.wind = value; engine.wind.set(1, value, 0.3); }, v => v.toFixed(1) + ' m/s');
    panel.slider('River flow', 0, 2, 0.05, () => river.optics.flowScale, v => {
      river.optics.flowScale = v; falls.flow = v; inland.flowAt(0, 2, strands.waterCurrent);
    });
    panel.buttons([{ label: 'Gust through reeds', onClick: () => strands.addBlast(new THREE.Vector3(4.7, 0.4, 2), 16, 7, 1.4) }]);
    panel.section('Inflatables');
    panel.buttons([{ label: 'Push buoys', onClick: nudge }, { label: 'Restore buoys', onClick: () => { buoy.reset(buoyStart); ring.reset(ringStart); } }]);
    panel.slider('Ring pressure', 0.25, 4, 0.05, () => ring.pressure, v => { ring.pressure = v; });
    panel.section('Impact trails');
    panel.buttons([{ label: 'Skip across water', onClick: skip }, { label: 'Strike panel', onClick: passThrough }]);
    panel.select<ImpactSurface>('Panel material', [['glass', 'Glass'], ['wood', 'Timber'], ['steel', 'Steel']], () => kind, choice => {
      removePlate(); kind = choice; removePlate = register();
      plate.material = surfaces[choice as keyof typeof surfaces];
    });
    const vortex=engine.add(new WeatherVortex(engine,fx,{radius:4.35,height:34,groundHeight:valleyHeight}));
    let tree:FlexibleTree|null=null, worker:ActiveRagdoll|null=null;
    let followWorker = false;
    engine.onBeforeRender = dt => {
      if (followWorker && worker) {
        target.copy(worker.torso.mesh.position);
        target.y = Math.max(0.22, target.y + 0.12);
        orbit.follow(target, Math.min(1, 8 * dt));
      }
      orbit.update(dt);
    };
    let bedCollider:ReturnType<typeof engine.physics.world.createCollider>|undefined;
    const frameAction=(x:number,y:number,z:number,dx:number,dy:number,dz:number)=>{
      followWorker = false;
      target.set(x,y,z);orbit.follow(target);orbit.controls.target.copy(target);
      camera.position.set(x+dx,y+dy,z+dz);orbit.update(0);
    };
    const sapling=()=>{
      if(!tree){const z=-5,x=riverCenter(z)+8.3;
        tree=engine.add(new FlexibleTree(engine,new THREE.Vector3(x,valleyHeight(x,z),z),{height:4.9,radius:0.145}));}
      return tree;
    };
    const spawnWorker=(water:boolean)=>{
      if(worker)engine.remove(worker);
      if(!bedCollider){
        const R=engine.physics.RAPIER,n=48,w=44;
        const heights=new Float32Array((n+1)*(n+1));
        for(let x=0;x<=n;x++)for(let z=0;z<=n;z++)heights[x*(n+1)+z]=valleyHeight((x/n-0.5)*w,(z/n-0.5)*w);
        bedCollider=engine.physics.world.createCollider(R.ColliderDesc.heightfield(n,n,heights,{x:w,y:1,z:w}));
      }
      const z=water?1.5:-1.0,x=riverCenter(z)+(water?0.9:8.2);
      const y = water ? engine.world.waterHeight(x,z) : valleyHeight(x,z) + 0.04;
      worker = engine.add(new ActiveRagdoll(engine,new THREE.Vector3(x,y,z),water ? 'afloat' : 'standing'));
      // Afloat, frame from the open middle of the channel: the old right-hand offset parked
      // the lens 1.8-2.4 m from a rapid boulder (5.2, 4.9) once the swimmer drifted.
      if(water)frameAction(x,0.35,z,-1.6,1.05,3.9);
      else frameAction(x,valleyHeight(x,z)+0.8,z,2.15,0.93,3.45);
      followWorker = true;
      return worker;
    };
    panel.section('Wind, vegetation and rescue');
    let restoreWeather: Pick<typeof weather.params,'cloudBase'|'cloudTop'|'coverage'|'visibility'|'storm'> | undefined;
    const beginStorm=()=>{
      const w=weather.params;
      restoreWeather??={cloudBase:w.cloudBase,cloudTop:w.cloudTop,coverage:w.coverage,visibility:w.visibility,storm:w.storm};
      Object.assign(w,{cloudBase:30,cloudTop:360,coverage:0.73,visibility:6200,storm:0.64});
      sapling();
    };
    panel.buttons([{label:'Launch waterspout',onClick:()=>{beginStorm();vortex.start(riverCenter(-5),-5,0.32,0.18);frameAction(riverCenter(-5),16.5,-5,6.8,1.6,43.5);}},
      {label:'Land tornado',onClick:()=>{beginStorm();vortex.start(riverCenter(-5)+10.3,-5,-0.12,0.1);frameAction(riverCenter(-5)+8,5.1,-5,-8,1.0,22);}},
      {label:'Clear vortex',onClick:()=>{vortex.stop();if(restoreWeather){Object.assign(weather.params,restoreWeather);restoreWeather=undefined;}}}]);
    panel.buttons([{label:'Bend sapling',onClick:()=>sapling().impact(0.32)},{label:'Break trunk',onClick:()=>sapling().impact(1.2)},
      {label:'Stumble on bank',onClick:()=>{(worker??spawnWorker(false)).stumble(new THREE.Vector3(8,0.5,3));}},
      {label:'Float rescue worker',onClick:()=>spawnWorker(true)}]);
    return {
      debug: { weather, fx, inland, vortex, get tree(){return tree;},get worker(){return worker;}, river, falls, strands, grass, kelp, soft, buoy, ring, nudge, tracers, state, orbit, skip, passThrough },
      hud: () => [`skips ${tracers.stats.skipped}  ·  exits ${tracers.stats.exited}  ·  stops ${tracers.stats.stopped}`],
      dispose() { if(bedCollider)engine.physics.world.removeCollider(bedCollider,true); bounce.removeFromParent(); removePlate(); orbit.dispose(); for (const material of Object.values(surfaces)) if (material !== plate.material) material.dispose(); disposeValley(fixtures); disposeValley(valley); },
    };
  },
};
