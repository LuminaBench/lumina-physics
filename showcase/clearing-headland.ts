import * as THREE from 'three/webgpu';
import type { ProfileWorld } from '../modules/weather/outdoor-world';
import { WetRoad } from '../modules/wet-road/road';
import { TerrainSurface } from '../modules/terrain/surface';

/** Grade the road bed into the same heightmap the coast and its plants use. */
export function headlandRoadMap(seed:number) {
  const grid=new TerrainSurface('coastal-cliffs',seed), n=grid.segments;
  for(let j=0;j<=n;j++) for(let i=0;i<=n;i++) {
    const x=(i/n-0.5)*grid.size;
    const weight=1-THREE.MathUtils.smoothstep(Math.abs(x),9,22);
    const k=j*(n+1)+i;
    grid.heights[k]=THREE.MathUtils.lerp(grid.heights[k],7.97,weight);
  }
  return grid;
}

export function clearingHeadland(world:ProfileWorld) {
  const {engine}=world;
  const road=engine.add(new WetRoad(engine,world.weather));
  road.group.position.y=8; road.vehicleLighting=false; road.weatherTimeScale=14;
  road.params.wetness=1; road.params.flood=0.68;road.setSurroundingsVisible(false);
  const structure=new THREE.Group(), mat=new THREE.MeshStandardMaterial({color:0x514d47,roughness:0.84});
  const roof=new THREE.Mesh(new THREE.BoxGeometry(23,1.0,30),mat);
  roof.position.set(0,15,-46);structure.add(roof);
  for(const x of [-10.5,10.5]) for(const z of [-58,-46,-34]) {
    const pier=new THREE.Mesh(new THREE.CylinderGeometry(0.45,0.65,7,8),mat);
    pier.position.set(x,11.4,z);structure.add(pier);
  }
  engine.scene.add(structure);
  const release=engine.world.shelters.add({center:new THREE.Vector3(0,14.5,-46), width:23,depth:30,groundY:8});
  engine.add({dispose(){release();structure.removeFromParent();for(const mesh of structure.children)(mesh as THREE.Mesh).geometry.dispose();mat.dispose();}});
  let clearing=false;
  return { road, camera(t:number) {
    if(t>=1.4&&!clearing){clearing=true;world.patch({weather:'clear',time:17.55},5);}
    const eye=engine.camera, z=-54+Math.min(12,t)*4.45;
    const turn=THREE.MathUtils.smoothstep(t,4,11.3);
    eye.position.set(-2+turn*4.6,9.65+turn*2.2,z);
    eye.lookAt(eye.position.x+turn*64,8.3+3*turn,z+45*(1-turn)+7);
  }};
}
