import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';

/** Rank a periodic void-and-cluster mask once. The shader cycles this single tile without an asset. */
export function cloudOffsetTile(): THREE.DataTexture {
  const size = 32, count = size*size, half = count/2;
  const occupied = new Uint8Array(count), energy = new Float64Array(count), rank = new Uint8Array(count);
  const order = Array.from({length:count},(_,i)=>i), rand=mulberry32(0x62d156);
  const kernel: {x:number; y:number; weight:number}[] = [];
  for (let y=-4;y<=4;y++) for (let x=-4;x<=4;x++) kernel.push({x,y,weight:Math.exp(-(x*x+y*y)/4.5)});
  function mark(i:number,on:number) {
    const sign=on?1:-1, x=i%size,y=i>>5;
    occupied[i]=on;
    for (const k of kernel) energy[((y+k.y+size)%size)*size+(x+k.x+size)%size] += sign*k.weight;
  }
  function extreme(on:number) {
    let selected=-1,best=-Infinity;
    for(let i=0;i<count;i++) if(occupied[i]===on) {
      const score=on?energy[i]:-energy[i]; if(score>best){best=score;selected=i;}
    }
    return selected;
  }
  for(let i=0;i<half;i++){const j=i+Math.floor(rand()*(count-i));[order[i],order[j]]=[order[j],order[i]];mark(order[i],1);}
  for(let i=0;i<count;i++){
    const dense=extreme(1);mark(dense,0);const empty=extreme(0);mark(empty,1);
    if(dense===empty) break;
  }
  const initial=occupied.slice(), initialEnergy=energy.slice();
  for(let i=half-1;i>=0;i--){const at=extreme(1);rank[at]=i>>2;mark(at,0);}
  occupied.set(initial);energy.set(initialEnergy);
  for(let i=half;i<count;i++){const at=extreme(0);rank[at]=i>>2;mark(at,1);}
  const texture=new THREE.DataTexture(rank,size,size,THREE.RedFormat);
  texture.magFilter=texture.minFilter=THREE.NearestFilter;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping; texture.needsUpdate=true;
  return texture;
}
