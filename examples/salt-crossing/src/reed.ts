import * as THREE from 'three/webgpu';

// Each plant has one arching culm, creased sword leaves, and a terminal seed head.
// Revision 2 opens the rachis into three drooping fingers with comb-like copper awns.
export function combReed(revision:number) {
  const positions:number[]=[], colors:number[]=[], indices:number[]=[];
  function vertex(point:THREE.Vector3, color:THREE.Color){
    positions.push(point.x,point.y,point.z);colors.push(color.r,color.g,color.b);return positions.length/3-1;
  }
  const v=(x:number,y:number,z:number)=>new THREE.Vector3(x,y,z);
  const green=new THREE.Color('#70805b'),straw=new THREE.Color('#b5ad79');
  const head=new THREE.Color('#89573c'),light=new THREE.Color('#d4a36f');
  function tube(points:THREE.Vector3[],radii:number[],base:THREE.Color,tip:THREE.Color){
    const sides=6,rows:number[][]=[];
    for(const [i,p] of points.entries()){
      const tangent=points[Math.min(i+1,points.length-1)].clone().sub(points[Math.max(i-1,0)]).normalize();
      const side=tangent.clone().cross(v(0,0,1)).normalize(),front=tangent.clone().cross(side);
      const row:number[]=[], tint=base.clone().lerp(tip,i/(points.length-1));
      for(let k=0;k<sides;k++){
        const a=2*Math.PI*k/sides,point=p.clone().addScaledVector(side,Math.cos(a)*radii[i]).addScaledVector(front,Math.sin(a)*radii[i]);
        row.push(vertex(point,tint));
      }
      if(i)for(let k=0;k<sides;k++){const j=(k+1)%sides,last=rows[i-1];indices.push(last[k],last[j],row[k],row[k],last[j],row[j]);}
      rows.push(row);
    }
  }
  const top=v(.12,1.21,.04);
  tube([v(0,0,0),v(.015,.49,0),v(.05,.93,.02),top],[.017,.014,.012,.009],green,straw);
  for(let k=0;k<7;k++){
    const a=k*2.4+1,dx=Math.cos(a),dz=Math.sin(a),height=.51+.20*(k%3);
    const origin=.04+k*.063;
    const rows:number[][]=[];
    for(let j=0;j<=5;j++){
      const t=j/5,reach=.47*t*t+.05*t,wide=(.013+.029*Math.sin(t*Math.PI))*(1-t**3),y=origin+height*Math.sin(t*2.10);
      const mid=v(dx*reach,y,dz*reach);
      rows.push([vertex(mid.clone().add(v(-dz*wide,0,dx*wide)),green),
        vertex(mid.clone().add(v(0,wide*.48,0)),straw),vertex(mid.clone().add(v(dz*wide,0,-dx*wide)),green)]);
      if(j){const p=rows[j-1],q=rows[j];indices.push(p[0],p[1],q[0],q[0],p[1],q[1],p[1],p[2],q[1],q[1],p[2],q[2]);}
    }
  }
  if(revision===0) {
    tube([top,v(.13,1.26,.04),v(.15,1.45,.05),v(.16,1.53,.05)],[.013,.036,.031,.003],head,straw);
  }else{
    for(let branch=0;branch<3;branch++){
      const a=branch*2.14+.15,dx=Math.cos(a),dz=Math.sin(a);
      function rachis(t:number){return v(.12+dx*.34*t,1.21+.30*Math.sin(Math.PI*t*.93)-.045*t,.04+dz*.34*t);}
      tube([0,.25,.5,.75,1].map(rachis),[.012,.014,.016,.011,.003],straw,head);
      for(let j=1;j<=6;j++){
        const t=.22+j*.11,p=rachis(t),spread=.053+Math.sin(Math.PI*t)*.045;
        const toe=p.clone().add(v(dx*.028,-.085-.056*t,dz*.028));
        tube([p,p.clone().lerp(toe,.44),toe],[.008,.018,.002],head,light);
        for(const sign of [-1,1]){
          const awn=toe.clone().add(v(-dz*spread*sign,-.058,dx*spread*sign));
          tube([toe,awn],[.005,.0008],light,straw);
        }
      }
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setIndex(indices);g.computeVertexNormals();
  return g;
}
