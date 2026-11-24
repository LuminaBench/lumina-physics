import * as T from 'three/webgpu';
import { TSL as N, fbm2, mulberry32 } from './lumina-physics';
import { terrainHeight } from '../level';
import {Estuary, seaLevel,wave,station,solar,landingHeight} from './estuary';
import {combReed} from './reed';

function surface(x0:number,x1:number,z0:number,z1:number,nx:number,nz:number,height:(x:number,z:number)=>number){
  const g=new T.PlaneGeometry(x1-x0,z1-z0,nx,nz);
  g.rotateX(-Math.PI/2);g.translate((x0+x1)/2,0,(z0+z1)/2);
  const p=g.getAttribute('position');for(let i=0;i<p.count;i++)p.setY(i,height(p.getX(i),p.getZ(i)));g.computeVertexNormals();return g;
}
export function buildPlace(game:Estuary,rev:number) {
  const {scene,deck}=game.host;
  scene.fog=new T.FogExp2('#99a8ae',.006);
  const solarData=solar(rev),clock=N.uniform(0);
  const elev=solarData.sunElevation*Math.PI/180,az=solarData.sunAzimuth*Math.PI/180;
  const solarDirection=new T.Vector3(Math.cos(elev)*Math.cos(az),Math.sin(elev),Math.cos(elev)*Math.sin(az));
  const sun=new T.DirectionalLight('#ffe2a6',2.15);sun.position.copy(solarDirection).multiplyScalar(70);scene.add(sun);
  scene.add(new T.HemisphereLight('#cad9df','#696259',2));
  const skyMat=new T.MeshBasicNodeMaterial({side:T.BackSide,depthWrite:false,fog:false});
  const d=N.positionLocal.normalize(),alt=d.y.max(0),air=N.smoothstep(.0,.72,alt);
  const cloudCoord=N.vec2(d.x,d.z).div(alt.add(.10)).mul(1.35);
  const grain=fbm2(cloudCoord.add(N.vec2(clock.mul(.001),0)),4);
  const varCloud=N.smoothstep(.37,.69,grain.add(d.z.mul(.08))).mul(N.smoothstep(.016,.22,alt));
  const color=N.mix(N.color('#bbc3c4'),N.color('#57788e'),air);
  const clouds=N.mix(N.color('#8d969c'),N.color('#4a6275'),air);
  const dot=d.dot(N.uniform(solarDirection)),halo=N.pow(dot.max(0),32).mul(.65);
  skyMat.colorNode=N.mix(N.mix(color,clouds,varCloud.mul(.90)),N.color('#ffcd84'),halo).add(N.smoothstep(.99991,.999958,dot).mul(N.color('#fff1bf')).mul(2.6));
  const dome=new T.Mesh(new T.SphereGeometry(400,56,24),skyMat);dome.renderOrder=-10;scene.add(dome);

  const groundMat=new T.MeshPhysicalNodeMaterial({roughness:.91,specularIntensity:.3});
  const p=N.positionWorld,grainA=fbm2(p.xz.mul(.87),3),grainB=fbm2(p.xz.mul(21),2);
  const pore=N.smoothstep(seaLevel+.05,seaLevel+.55,p.y);
  const aggregate=N.mix(N.color(game.coast.coast.sand.heavy),N.color(game.coast.coast.sand.pale),grainA.mul(.68).add(grainB.mul(.29)));
  groundMat.colorNode=N.mix(aggregate.mul(.47),aggregate,pore);
  groundMat.roughnessNode=N.mix(N.float(.66),N.float(.94),pore);
  scene.add(new T.Mesh(surface(-143,150,-115,165,176,140,terrainHeight),groundMat));

  const waterMat=new T.MeshBasicNodeMaterial({side:T.DoubleSide});
  const waterGeo=surface(-140,51,-114,163,180,154,()=>seaLevel);
  const loc=N.positionLocal;
  const bed=loc.x.mul(.043).sub(N.exp(loc.z.div(10).pow(2).negate()).mul(.72)).add(N.sin(loc.z.mul(.081)).mul(.13));
  const depth=N.float(seaLevel).sub(bed);
  const swash=game.coast.surf.node(loc.xz,depth,clock,N.float(wave),N.float(seaLevel));
  waterMat.positionNode=loc.add(N.vec3(0,swash.x,0));
  const riff=N.sin(p.z.mul(7.2).add(p.x.mul(.78)).add(clock.mul(1.8)).add(fbm2(p.xz.mul(.36),2).mul(5)));
  const waterColor=N.mix(N.color('#506767'),N.color('#304d56'),N.smoothstep(.05,2,depth));
  const windRipple=fbm2(N.vec2(p.x.mul(1.15),p.z.mul(3.7)).add(N.vec2(clock.mul(.25),clock.mul(.51))),3);
  const view=N.cameraPosition.sub(p).normalize();
  const normal=N.vec3(windRipple.sub(.5).mul(.16),1,riff.mul(.018)).normalize();
  const reflected=N.reflect(view.negate(),normal);
  const glance=N.pow(view.y.max(.01).oneMinus(),3).clamp(0,1);
  const glint=N.pow(reflected.dot(N.uniform(solarDirection)).max(0),290);
  const reflection=N.mix(N.color('#a3a7a7'),N.color('#8f9298'),windRipple);
  waterMat.colorNode=N.mix(waterColor,reflection,glance.mul(.66)).add(windRipple.sub(.5).mul(.025))
    .add(glint.mul(N.color('#eab67c')).mul(.81)).add(swash.y.mul(.6));
  const water=new T.Mesh(waterGeo,waterMat);scene.add(water);

  // The causeway embankment stops at both bridge abutments. Its crown follows the host's curve.
  function approach(x0:number,x1:number) {
    const pts:number[]=[],colors:number[]=[],inds:number[]=[];
    for(let i=0;i<=92;i++){
      const x=x0+(x1-x0)*i/92,r=game.roadAt(x);
      for(const side of [-3.5,-1.76,1.76,3.5]){
        const edge=Math.abs(side)>2;
        const toe=edge?(2.2+Math.max(.5,r.y-terrainHeight(x,r.z))*1.7):Math.abs(side);
        const z=r.z+Math.sign(side)*toe,h=edge?Math.min(r.y-.28,terrainHeight(x,z)-.06):r.y;
        pts.push(x,h,z);const col=new T.Color(Math.abs(side)>2?'#545453':'#716e67');colors.push(col.r,col.g,col.b);
      }
      for(let k=0;i&&k<3;k++){const j=(i-1)*4+k;inds.push(j,j+1,j+4,j+1,j+5,j+4);}
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pts,3));g.setAttribute('color',new T.Float32BufferAttribute(colors,3));g.setIndex(inds);g.computeVertexNormals();
    const m=new T.MeshStandardNodeMaterial({roughness:.9,side:T.DoubleSide});
    const track=game.coast.trackNode('approach',p.xz).r;
    m.colorNode=N.attribute('color','vec3').mul(N.float(1).sub(track.mul(.65))).mul(grainB.mul(.24).add(.85));
    m.roughnessNode=N.float(.89).sub(track.mul(.56));scene.add(new T.Mesh(g,m));
  }
  approach(-64,-12);approach(12,55);
  const bridgeMat=new T.MeshStandardNodeMaterial({roughness:.85});
  const film=game.coast.trackNode('bridge',p.xz).r;
  const plank=N.fract(p.x.mul(2.1)).min(N.fract(p.x.mul(2.1)).oneMinus());
  bridgeMat.colorNode=N.mix(N.color('#514d47'),N.color('#9a9380'),N.smoothstep(0,.050,plank))
    .mul(grainB.mul(.22).add(.86)).mul(N.float(1).sub(film.mul(.78)));
  bridgeMat.roughnessNode=N.float(.86).sub(film.mul(.60));const hostDeck:T.Mesh=deck;hostDeck.material=bridgeMat;

  const wetGeom=surface(-19.5,-12.02,-1.32,-.02,90,18,(x)=>game.roadAt(x).y+.008);
  const wetMat=new T.MeshStandardNodeMaterial({metalness:.34,roughness:.12,transparent:true,depthWrite:false});
  const wx=N.positionWorld.x,wz=N.positionWorld.z;
  const tap=N.smoothstep(-19.5,-18.1,wx).mul(N.smoothstep(-12.75,-12.02,wx).oneMinus());
  const width=tap.sqrt().mul(.53),cross=wz.add(.67).abs();
  wetMat.opacityNode=N.smoothstep(0,.055,width.sub(cross)).mul(.88);
  wetMat.colorNode=N.mix(N.color('#394e53'),N.color('#94a4a7'),riff.mul(.5).add(.5).mul(.25));
  scene.add(new T.Mesh(wetGeom,wetMat));

  const basic=(color:string)=>new T.MeshStandardMaterial({color,roughness:.79});
  const wood=basic('#6b6050'),iron=basic('#45575a'),red=basic('#b54f29'),pale=basic('#d8d1a6');
  function box(parent:T.Object3D,size:number[],at:number[],mat:T.Material) {
    const m=new T.Mesh(new T.BoxGeometry(size[0],size[1],size[2]),mat);
    m.position.set(at[0],at[1],at[2]);parent.add(m);return m;
  }
  function spar(parent:T.Object3D, a:number[],b:number[],r:number,mat:T.Material){
    const from=new T.Vector3(...a as [number,number,number]),to=new T.Vector3(...b as [number,number,number]),delta=to.clone().sub(from);
    const m=new T.Mesh(new T.CylinderGeometry(r,r*1.06,delta.length(),7),mat);
    m.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());m.position.copy(from).lerp(to,.5);parent.add(m);return m;
  }
  for(const x of [-11.5,-6,0,6,11.5]){
    for(const z of [-1.57,1.57]){
      spar(scene,[x,terrainHeight(x,z)-.65,z],[x,2.83,z],.10,wood);
      spar(scene,[x,2.69,z],[x,2.88,z],.104,pale);
    }
    if(x<11)spar(scene,[x,1.7,1.46],[x+5.5,.4,1.46],.1,wood);
  }
  for(const z of [-1.57,1.57])spar(scene,[-11.5,2.63,z],[11.5,2.63,z],.052,iron);
  for(const x of [-38,-24,-13,14,20,28,43]){
    const r=game.roadAt(x);
    for(const side of [-1,1]) {
      const z=r.z+side*1.74;
      box(scene,[.12,.73,.12],[x,r.y+.365,z],wood);
      box(scene,[.126,.13,.126],[x,r.y+.64,z],pale);
    }
  }
  // The old approach runs into tidal water. Its end serves a harbor signal hut.
  const hut=new T.Group();scene.add(hut);hut.position.set(-56,game.roadAt(-56).y,0);
  box(hut,[4.3,2.3,2.8],[0,1.15,0],basic('#8c8170'));
  const roof=basic('#435058');
  for(const side of [-1,1]){
    const panel=box(hut,[4.8,.16,1.77],[0,2.63,side*.76],roof);
    panel.rotation.x=side*.41;
    for(const x of [-1.5,-.48,.57])box(hut,[.66,.71,.07],[x,1.45,side*1.41],iron);
  }
  for(const z of [-.74,.74])box(hut,[.07,.68,.60],[2.17,1.4,z],iron);
  box(hut,[.075,1.66,.69],[2.18,.84,0],wood);
  box(hut,[.34,1.46,.34],[-1.50,2.88,.30],iron);
  spar(hut,[1.72,0,-1.83],[1.72,4.65,-1.83],.062,iron);
  box(hut,[.30,.38,.30],[1.72,4.60,-1.83],red);
  for(const x of [-62,-50])for(const z of [-2.55,2.55]){
    spar(scene,[x,terrainHeight(x,z)-.3,z],[x,2.48,z],.12,wood);
    spar(scene,[x,2.20,z],[x,2.51,z],.126,pale);
  }
  // Survey staff and enamel witness plate use the host landing height.
  // The supplied player save is 2.26 m high. The field landing supports its actual pose.
  box(scene,[3.30,.16,1.92],[3.80,2.06,-8.50],wood);
  for(const x of [2.34,5.20])for(const z of [-9.28,-7.72])
    spar(scene,[x,terrainHeight(x,z)-.23,z],[x,2.06,z],.093,wood);
  for(let i=0;i<24;i++) {
    const x=5.45+(i+.5)*6.6/24,h=landingHeight(x,-8.5)!;
    const board=box(scene,[.282,.10,1.92],[x,h-.05,-8.5],wood);
    board.rotation.z=Math.atan((terrainHeight(12.05,-8.5)-2.14)/6.60);
  }
  const sy=2.14;
  for(let i=0;i<9;i++)box(scene,[.14,.20,.12],[station.x,sy+.10+i*.20,station.z],i%2?red:pale);
  box(scene,[.46,.36,.12],[station.x,sy+1.62,station.z+.09],iron);
  const finish=game.roadAt(19);
  box(scene,[.18,2.05,.18],[19,finish.y+1.02,finish.z+1.63],iron);
  box(scene,[.63,.54,.56],[19,finish.y+1.62,finish.z+1.63],red);

  // Distant moorlands are silhouettes behind the traversable shore.
  const rand=mulberry32(0xaf1f);
  for(let layer=0;layer<3;layer++){
    const ridgePos:number[]=[],ix:number[]=[],color=['#787e80','#676f73','#586468'][layer];
    const radius=185-layer*30;
    for(let i=0;i<=256;i++){
      const a=i/256*2*Math.PI,x=Math.cos(a)*radius,z=Math.sin(a)*radius;
      const gap=.30+.70*T.MathUtils.smoothstep(Math.abs(a-2.10),.08,.9);
      const ridge=gap*(6+layer*1.5+9*Math.sin(a*3+layer*1.2)**2+4*Math.cos(a*11+layer*.7)+1.45*Math.cos(a*28+layer)+rand()*1.25);
      ridgePos.push(x,-15,z,x,ridge,z);if(i){const j=i*2;ix.push(j-2,j-1,j,j-1,j+1,j);}
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(ridgePos,3));g.setIndex(ix);
    scene.add(new T.Mesh(g,new T.MeshBasicMaterial({color,side:T.DoubleSide})));
  }
  // Basalt shingle sits on the host surface. Instance count and placements have their own seed.
  const shingle=new T.InstancedMesh(new T.DodecahedronGeometry(1,0),basic('#555453'),420),o=new T.Object3D();
  for(let i=0;i<420;i++){const x=rand()*67-19,z=rand()*52-29,r=game.roadAt(x);
    const s=Math.abs(z-r.z)<2.8?0:.03+rand()**4*.52;
    o.position.set(x,terrainHeight(x,z)+s*.13,z);o.scale.set(s*1.55,s*.68,s);o.rotation.set(rand()*.5,rand()*6,rand()*.6);o.updateMatrix();shingle.setMatrixAt(i,o.matrix);}
  scene.add(shingle);
  const reeds=new T.InstancedMesh(combReed(rev),new T.MeshStandardMaterial({vertexColors:true,roughness:.85,side:T.DoubleSide}),game.plants.length);
  for(const [i,s] of game.plants.entries()){o.position.set(s.x,s.y,s.z);o.scale.setScalar(s.scale);o.rotation.set(0,s.yaw,0);o.updateMatrix();reeds.setMatrixAt(i,o.matrix);}
  scene.add(reeds);

  const cart=new T.Group();scene.add(cart);const blue=basic('#46656a'),black=basic('#242a2a');
  box(cart,[2.83,.31,1.13],[0,.47,0],iron);box(cart,[2.35,.40,1.10],[0,.72,0],blue);
  box(cart,[.98,.34,1.04],[.79,.97,0],red);box(cart,[.52,.30,.67],[-.50,1.02,0],black);
  box(cart,[.22,.52,.71],[-.73,1.18,0],black);
  for(const z of [-.49,.49]){spar(cart,[-.9,.94,z],[-.92,1.87,z],.035,iron);spar(cart,[.19,1.03,z],[.38,1.87,z],.035,iron);}
  box(cart,[1.55,.095,1.24],[-.30,1.91,0],pale);
  for(const w of game.wheels){const tire=new T.Mesh(new T.CylinderGeometry(.33,.33,.24,16),black);
    tire.rotation.x=Math.PI/2;tire.position.set(w.axle,.33,w.side);cart.add(tire);
    const hub=new T.Mesh(new T.CylinderGeometry(.16,.16,.252,14),wood);hub.rotation.x=Math.PI/2;hub.position.copy(tire.position);cart.add(hub);}
  for(const z of [-.4,.4])box(cart,[.07,.14,.16],[1.41,.80,z],pale);

  // Windblown rain obscures only the far-bank headland. Opacity comes from its local gauges.
  const veilMat=new T.MeshBasicNodeMaterial({transparent:true,depthWrite:false,side:T.DoubleSide});
  const veilNoise=fbm2(N.vec2(p.x.mul(.16).add(p.y.mul(.026)),p.y.mul(.039)),3);
  const bankRain=game.front.mapNode(p.xz,clock).g;
  const heightMask=N.smoothstep(.05,3,p.y).mul(N.smoothstep(14,26,p.y).oneMinus());
  const sideMask=N.smoothstep(22,45,p.x.sub(7).abs()).oneMinus();
  veilMat.opacityNode=N.smoothstep(.28,.72,veilNoise).mul(bankRain).mul(heightMask).mul(sideMask).mul(.39);
  veilMat.colorNode=N.color('#7e919d');
  const veil=new T.Mesh(new T.PlaneGeometry(95,32),veilMat);veil.position.set(7,16,59);scene.add(veil);
  const rainPos=new Float32Array(1400*6),rainSeeds=Array.from({length:1400},()=>{
    const x=(rand()-.5)*125,z=30+rand()*68;return {x,z,y:rand()*23,length:.5+rand()*.85};});
  const rainGeom=new T.BufferGeometry();rainGeom.setAttribute('position',new T.BufferAttribute(rainPos,3).setUsage(T.DynamicDrawUsage));
  const drops=new T.LineSegments(rainGeom,new T.LineBasicMaterial({color:'#a3b2ba',transparent:true,opacity:.27,depthWrite:false}));
  drops.frustumCulled=false;scene.add(drops);
  const avatar=new T.Group();scene.add(avatar);
  const coat=basic('#b87943');
  function oval(radius:number[],at:number[],material:T.Material){
    const shape=new T.Mesh(new T.SphereGeometry(1,11,9),material);
    shape.scale.set(radius[0],radius[1],radius[2]);shape.position.set(at[0],at[1],at[2]);avatar.add(shape);return shape;
  }
  oval([.235,.35,.18],[0,.92,0],coat);
  oval([.143,.16,.14],[0,1.34,.02],coat);
  oval([.109,.11,.09],[0,1.33,.098],iron);
  for(const side of [-1,1]){
    spar(avatar,[side*.11,.67,0],[side*.135,.15,.012],.078,iron);
    oval([.095,.085,.136],[side*.135,.075,.035],black);
    spar(avatar,[side*.18,1.10,0],[side*.25,.80,.042],.078,coat);
    oval([.060,.084,.061],[side*.25,.74,.05],black);
  }
  oval([.154,.209,.081],[0,.98,-.17],iron);
  function update(){
    clock.value=game.seconds;
    const r=game.roadAt(game.cart.x);
    cart.position.set(game.cart.x,game.contactHeight(game.cart.x,r.z+game.cart.lane),r.z+game.cart.lane);cart.rotation.y=-Math.atan(r.slope);
    avatar.position.set(game.player.x,game.player.y-.12,game.player.z);
    avatar.visible=game.mode==='walk';
    for(let i=0;i<rainSeeds.length;i++){
      const s=rainSeeds[i],k=i*6,height=26-((game.seconds*11+s.y)%26),amount=game.rain(s.x,s.z);
      const y=terrainHeight(s.x,s.z)+height;
      rainPos.set([s.x,y,s.z,s.x+.06*amount,y-s.length*amount,s.z-.16*amount],k);
    }
    rainGeom.getAttribute('position').needsUpdate=true;
  }
  update();return {update,cart,avatar,reeds};
}
