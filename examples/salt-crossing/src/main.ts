import * as T from 'three/webgpu';
import {existingLevel, savedPlayer, terrainHeight} from '../level';
import {Estuary, farBank, revision, saveKey, solar, station, type GameSave} from './estuary';
import {buildPlace} from './place';

const element=(id:string)=>document.getElementById(id)!;
const canvas=element('water') as HTMLCanvasElement;
const action=element('action') as HTMLButtonElement, field=element('field') as HTMLButtonElement;
const url=new URLSearchParams(location.search),rev=url.get('revision')==='1'?0:1;
const fmt=(hour:number)=>new Date(Math.round(hour*60)*60000).toISOString().slice(11,16);
async function launch(){
  const renderer=new T.WebGPURenderer({canvas,antialias:true,forceWebGL:url.get('backend')==='webgl'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  await renderer.init();
  const host=await existingLevel();
  let inputSave:GameSave|undefined;
  const record=localStorage.getItem(saveKey);
  if(record)inputSave=JSON.parse(record);
  const game=new Estuary(host,inputSave),view=buildPlace(game,rev),sky=solar(rev);
  const held=new Set<string>(),camera=host.camera;
  let inspecting=false,frames=0,lastTime=performance.now(),hintAge=0;
  let azimuth=0,elevation=0,drag:{x:number,y:number}|undefined;
  const eye=new T.Vector3(),target=new T.Vector3();
  function resize(){
    renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  }
  addEventListener('resize',resize);resize();
  function doAction(){
    if(inspecting){inspect();return;}
    if(!game.sample)game.readGauge();else game.board();
    azimuth=elevation=0;updateHud();
  }
  function inspect(){inspecting=!inspecting;azimuth=elevation=0;updateHud();}
  function updateHud(){
    const driving=game.mode==='drive', s=game.site();
    element('mission').textContent=inspecting?'Comb reed':game.delivered?'Reading delivered':driving?'Cross the estuary':game.sample?'Take the survey cart':'Read the tide staff';
    element('brief').textContent=inspecting?
      'Sheltered brackish ground · '+revision[rev].head:
      game.delivered?'The archive has your tide reading. You can keep exploring.':
      driving?'Follow the causeway east to the rust-red archive box.':
      game.sample?'Your crew has a cart waiting on the west approach.':'Walk to the striped gauge and collect its low-water reading.';
    element('movement').textContent=inspecting?'Drag to orbit':driving?'W/S throttle · A/D steer':'WASD walk · drag to orbit';
    action.innerHTML=inspecting?'Return to survey <kbd>E</kbd>':!game.sample?'Read gauge <kbd>E</kbd>':driving?'Return to shore <kbd>E</kbd>':'Board cart <kbd>E</kbd>';
    action.disabled=!inspecting&&!game.sample&&Math.hypot(game.player.x-station.x,game.player.z-station.z)>=3;
    field.innerHTML=inspecting?'Close field lens <kbd>F</kbd>':'Inspect reed <kbd>F</kbd>';
    element('tread').textContent=inspecting?'Colony '+s.id.split('/')[1]+'  ·  shelter '+game.coast.coast.project(s.x,s.z).shelter.toFixed(2):
      driving?'Tread water   FL '+(game.films[0]*1000).toFixed(1)+'  FR '+(game.films[1]*1000).toFixed(1)+'  RL '+(game.films[2]*1000).toFixed(1)+'  RR '+(game.films[3]*1000).toFixed(1)+' mm':'';
    const px=driving?game.cart.x:game.player.x,pz=driving?game.roadAt(game.cart.x).z+game.cart.lane:game.player.z;
    const rain=game.rain(px,pz);
    element('weather').innerHTML=fmt(revision[rev].hour)+' solar · sunset '+fmt(sky.sunset)+'<br>'+(rain<.01?'Here dry':'Local rain '+Math.round(rain*100)+'%')+' · far bank '+Math.round(game.rain(farBank.x,farBank.z)*100)+'% rain';
  }
  function save(){
    try{localStorage.setItem(saveKey,JSON.stringify(game.save()));element('saved').textContent='Survey saved';}
    catch(e){element('saved').textContent='Save unavailable';console.error(e);}
  }
  action.onclick=doAction;field.onclick=inspect;element('save').onclick=save;
  window.addEventListener('keydown',e=>{
    const key=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','e','f'].includes(key)){
      e.preventDefault();held.add(key);if(!e.repeat){if(key==='e')doAction();if(key==='f')inspect();}
    }
  });
  window.addEventListener('keyup',e=>held.delete(e.key.toLowerCase()));
  window.addEventListener('blur',()=>held.clear());
  canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(drag){azimuth-=(e.clientX-drag.x)*.009;elevation=T.MathUtils.clamp(elevation+(e.clientY-drag.y)*.012,-.5,1.1);drag={x:e.clientX,y:e.clientY};}};
  canvas.onpointerup=canvas.onpointercancel=()=>{drag=undefined;};
  function pose(){
    let range:number,angle:number,h:number;
    if(inspecting){
      const s=game.site();target.set(s.x+.06,s.y+s.scale*1.18,s.z);range=1.32;angle=-.43;h=-.17;
    }else if(game.mode==='drive'){
      target.copy(view.cart.position).add(new T.Vector3(.80,.80,0));range=7.6;angle=-2.50;h=3.55;
    }else{
      target.set(game.player.x+1.3,game.player.y+.76,game.player.z+1.4);
      range=9.0;angle=-.71;h=2.0;
    }
    eye.copy(target).add(new T.Vector3(Math.cos(angle+azimuth)*range,h+elevation*range,Math.sin(angle+azimuth)*range));
    eye.y=Math.max(eye.y,terrainHeight(eye.x,eye.z)+.25);
    camera.position.copy(eye);camera.lookAt(target);
  }
  const key=(name:string,alt:string)=>Number(held.has(name)||held.has(alt));
  const bridgeField=game.coast.layer('bridge'), track=new T.Vector3();
  const diagnostics=()=>({revision:rev+1,head:revision[rev].head,solar:sky,site:game.site(),planted:game.plants.map(p=>p.id),
    reedVertices:view.reeds.geometry.getAttribute('position').count,originalPlayer:savedPlayer,player:{...game.player},
    road:host.road.points.map(p=>p.toArray()),collider:{handle:host.bridge.handle,center:host.bridge.translation(),half:host.bridge.halfExtents()},
    deckObject:host.deck.name,deckCollision:game.bridgeAt(0,2.14,0),groundCollision:game.bridgeAt(0,-1,0),
    localRain:game.rain(game.player.x,game.player.z),farRain:game.rain(farBank.x,farBank.z),
    cart:{...game.cart},depths:[...game.depths],films:[...game.films],leftTrack:bridgeField.sampleAt(-11.6,-.67,track).x,
    rightTrack:bridgeField.sampleAt(-11.6,.67,track).x,sample:game.sample,delivered:game.delivered,
    mode:game.mode,inspecting,frames,renderer:'isWebGLBackend' in renderer.backend?'WebGL 2':'WebGPU'});
  Object.assign(window,{surveyStatus:diagnostics});
  updateHud();
  renderer.setAnimationLoop(()=>{
    const now=performance.now(),dt=Math.min(.075,Math.max(0,(now-lastTime)/1000));lastTime=now;
    const f=key('w','arrowup')-key('s','arrowdown'),side=key('d','arrowright')-key('a','arrowleft');
    const direction=-.71+azimuth, fx=-Math.cos(direction),fz=-Math.sin(direction);
    if(!inspecting)game.step(dt,f,side,f*fx-side*fz,f*fz+side*fx);
    view.update();pose();renderer.render(host.scene,camera);
    if((hintAge+=dt)>.12){updateHud();hintAge=0;}frames++;
  });
  addEventListener('pagehide',()=>{renderer.setAnimationLoop(null);game.dispose();host.physics.free();renderer.dispose();},{once:true});
}
launch().catch(err=>{console.error(err);element('status').textContent='Unable to load the survey. '+err.message;});
