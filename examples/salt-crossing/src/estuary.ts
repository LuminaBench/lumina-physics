import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { existingLevel, levelId, seed, savedPlayer, terrainHeight } from '../level';
import { CoastalAttachment, WeatherFront, SANDS, mulberry32, setSolarTime, type SedimentSave } from './lumina-physics';

export type Level = Awaited<ReturnType<typeof existingLevel>>;
export const revision = [
  { day: 220, hour: 18.9, head: 'single spike' },
  { day: 177, hour: 20.35, head: 'three pendant combs' },
] as const;
export const station = {x:4.4, z:-8.8};
export function landingHeight(x:number,z:number) {
  if(Math.abs(z+8.5)>.96||x<2.15||x>12.05)return;
  if(x<=5.45)return 2.14;
  return 2.14+(terrainHeight(12.05,z)-2.14)*(x-5.45)/6.60;
}
export const farBank = {x:5, z:55};
export const seaLevel = -.60;
export const wave = .13;
export const reedId = 'crossing:comb-reed';
export const roadId = 'salt-crossing:heritage-road';
export const saveKey = 'salt-crossing:survey.v1';
export const clamp = THREE.MathUtils.clamp;
export const smooth = THREE.MathUtils.smoothstep;
export type GameSave = {
  version: 1; seed: number; roadId: string; player: typeof savedPlayer;
  cart: {x:number, lane:number}; mode:'walk'|'drive'; sample:boolean; delivered:boolean;
  sediment:SedimentSave; planted:string[]
};

export function solar(rev:number) {
  const {day, hour} = revision[rev];
  const sky = {sunElevation:0, sunAzimuth:0};
  const clock = {latitudeDeg:61, dayOfYear:day, solarHour:hour, northAzimuthDeg:171};
  let lo=16, hi=24;
  for(let i=0;i<24;i++) {
    const mid=(lo+hi)/2;
    setSolarTime(sky,{...clock,solarHour:mid});
    if (sky.sunElevation>0) lo=mid; else hi=mid;
  }
  setSolarTime(sky,clock);
  return {...sky, clock, sunset:(lo+hi)/2};
}

export class Estuary {
  readonly front = new WeatherFront({type:'squall',seed:778,span:260,origin:[0,19],heading:-Math.PI/2,windSpeed:.014});
  readonly samples:THREE.Vector3[];
  readonly coast:CoastalAttachment;
  readonly plants:{id:string,x:number,y:number,z:number,yaw:number,scale:number}[] = [];
  readonly player = {...savedPlayer};
  readonly cart={x:-23,lane:0,speed:0};
  readonly contacts;
  readonly wheels = [
    {name:'front left',axle:1.02,side:-.67}, {name:'front right',axle:1.02,side:.67},
    {name:'rear left',axle:-1.02,side:-.67},{name:'rear right',axle:-1.02,side:.67}
  ];
  readonly films=[0,0,0,0]; readonly depths=[0,0,0,0];
  readonly tirePoints=this.wheels.map(()=>new THREE.Vector3());
  readonly ray=new RAPIER.Ray({x:0,y:0,z:0},{x:0,y:-1,z:0});
  mode:'walk'|'drive'='walk'; sample=false; delivered=false;
  seconds=0; private lastFoot=new THREE.Vector2(savedPlayer.x,savedPlayer.z);

  constructor(readonly host:Level, save?:GameSave) {
    this.samples=host.road.getPoints(512);
    this.coast=new CoastalAttachment({
      heightAt:terrainHeight,
      coast:{seed, shoreline:[[-17,-80],[-17,180]], inletAt:59,exposure:.18,
        sand:{...SANDS.basalt, pale:'#60595a',mineral:'#383c40',heavy:'#1c2026',grainMm:.58,drainageSeconds:38}},
      surf:{size:230,resolution:161,period:8.6},rainAt:(x,z)=>this.rain(x,z),
      deckAt:(x,y,z)=>this.deckAt(x,y,z),
      ...(save?{save:save.sediment}:{}),
    });
    this.contacts=this.wheels.map(()=>this.coast.wheel(.24,.33,.006));
    const rand=mulberry32(0x729aecb2);
    for(let i=0;i<2600;i++){
      const x=-4+rand()*32,z=-25+rand()*41,y=terrainHeight(x,z),yaw=rand()*Math.PI*2,scale=.68+rand()*.58;
      const site=this.coast.coast.project(x,z);
      if(site.brackish<.65 || site.shelter<.68 || y<seaLevel+.14 || y>1 || Math.abs(z-this.roadAt(x).z)<2.65)continue;
      const patches=Math.sin(.82*x+.37*z)+Math.sin(z*.85-x*.26);
      if(patches<.22||landingHeight(x,z)!==undefined||Math.hypot(x-station.x,z-station.z)<.9)continue;
      this.plants.push({id:reedId+'/'+i,x,y,z,yaw,scale});
    }
    if(!this.plants.length) throw new Error('Reed bed has no eligible sites');
    if(save){
      if(save.version!==1||save.seed!==seed||save.roadId!==roadId||save.player.level!==levelId||
          save.planted.join('|')!==this.plants.map(p=>p.id).join('|')) throw new Error('Unexpected survey save');
      Object.assign(this.player,save.player);Object.assign(this.cart,save.cart);
      this.mode=save.mode;this.sample=save.sample;this.delivered=save.delivered;
      this.seconds=save.sediment.time;
    }
  }
  roadAt(x:number) {
    let lo=0,hi=this.samples.length-1;
    while(hi-lo>1){const m=(hi+lo)>>1;if(this.samples[m].x<=x)lo=m;else hi=m;}
    const a=this.samples[lo],b=this.samples[hi],t=clamp((x-a.x)/(b.x-a.x),0,1);
    return {z:a.z+(b.z-a.z)*t,y:a.y+(b.y-a.y)*t,slope:(b.z-a.z)/(b.x-a.x)};
  }
  bridgeAt(x:number,y:number,z:number) {
    const p=this.ray.origin;p.x=x;p.y=y+.055;p.z=z;
    const hit=this.host.bridge.castRay(this.ray,.11,true);
    return hit>=0 && hit<=.11;
  }
  puddle(x:number,z:number) {
    const lateral=z-this.roadAt(x).z;
    const taper=smooth(x,-19.5,-18.1)*(1-smooth(x,-12.75,-12.02));
    const width=.53*Math.sqrt(taper);
    if(!width)return 0;
    return .009*taper*(1-smooth(Math.abs(lateral+.67),width*.55,width));
  }
  deckAt(x:number,y:number,z:number) {
    if(this.bridgeAt(x,y,z))return {id:'bridge',water:0,film:0,soil:0};
    const road=this.roadAt(x);
    if(x< -64 || x>55 || Math.abs(y-road.y)>.13 || Math.abs(z-road.z)>1.77)return;
    const water=this.puddle(x,z);
    return {id:'approach',water,film:Math.min(1,water*400),soil:0};
  }
  rain(x:number,z:number){return this.front.sample(x,z,this.seconds).rain;}
  contactHeight(x:number,z:number) {
    const landing=landingHeight(x,z);if(landing!==undefined)return landing;
    const road=this.roadAt(x);
    if(this.bridgeAt(x,2.14,z))return 2.14;
    return x>=-64&&x<=55&&Math.abs(z-road.z)<1.77?road.y:terrainHeight(x,z);
  }
  step(dt:number,throttle:number,turn:number,walkX:number,walkZ:number) {
    this.seconds+=dt;
    if(this.mode==='walk'&&(walkX||walkZ)){
      const d=Math.hypot(walkX,walkZ);
      this.player.x=clamp(this.player.x+walkX/d*dt*4,-54,52);
      this.player.z=clamp(this.player.z+walkZ/d*dt*4,-32,65);
      this.player.y=this.contactHeight(this.player.x,this.player.z)+.12;
      if(Math.hypot(this.lastFoot.x-this.player.x,this.lastFoot.y-this.player.z)>.7){
        if(landingHeight(this.player.x,this.player.z)===undefined&&!this.deckAt(this.player.x,this.player.y-.12,this.player.z))
          this.coast.sediment.imprint('foot',this.player.x,this.player.z,Math.atan2(walkX,walkZ),.12,.26,.85);
        this.lastFoot.set(this.player.x,this.player.z);
      }
    }
    if(this.mode==='drive'){
      this.cart.speed+=(throttle*(throttle<0?3.2:6.4)-this.cart.speed)*-Math.expm1(-dt*2.8);
      this.cart.x=clamp(this.cart.x+this.cart.speed*dt,-52,48);
      this.cart.lane=clamp(this.cart.lane+turn*dt*Math.min(2,Math.abs(this.cart.speed)*.4),-.87,.87);
      if(this.cart.x>=19&&this.sample)this.delivered=true;
    }
    const cx=this.cart.x,road=this.roadAt(cx),angle=Math.atan(road.slope);
    const east=Math.cos(angle),south=Math.sin(angle);
    const focus=this.mode==='drive'?{x:cx,z:road.z+this.cart.lane}:this.player;
    this.coast.update(dt,focus.x,focus.z,seaLevel,wave);
    if(this.mode==='drive'){
      for(const [i,w] of this.wheels.entries()){
        const x=cx+w.axle*east-w.side*south,z=road.z+this.cart.lane+w.axle*south+w.side*east;
        const y=this.contactHeight(x,z);
        this.tirePoints[i].set(x,y,z);
        this.depths[i]=this.deckAt(x,y,z)?.water??this.coast.sediment.inspect(x,z).water;
        this.films[i]=this.contacts[i].sample(x,y,z,dt,this.cart.speed,.9,Math.PI/2-angle);
      }
    }
  }
  readGauge() {
    if(this.mode==='walk'&&Math.hypot(this.player.x-station.x,this.player.z-station.z)<3)this.sample=true;
  }
  board() {
    if(!this.sample)return;
    for(const w of this.contacts)w.reset();
    this.cart.speed=0;this.mode=this.mode==='walk'?'drive':'walk';
  }
  site() {return this.plants.reduce((a,b)=>Math.hypot(a.x-6.9,a.z+13.1)<Math.hypot(b.x-6.9,b.z+13.1)?a:b);}
  save():GameSave{return {version:1,seed,roadId,player:{...this.player},cart:{x:this.cart.x,lane:this.cart.lane},
    mode:this.mode,sample:this.sample,delivered:this.delivered,planted:this.plants.map(p=>p.id),sediment:this.coast.sediment.save()};}
  dispose(){this.coast.dispose();this.front.dispose();}
}
