import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
export const levelId='salt-crossing';
export const seed=4102;
export const savedPlayer={level:levelId,x:3.2,y:2.26,z:-8.5};
export const terrainHeight=(x:number,z:number)=>.043*x-.72*Math.exp(-((z/10)**2))+.13*Math.sin(z*.081);
export async function existingLevel(){
  await RAPIER.init();
  const physics=new RAPIER.World({x:0,y:-9.81,z:0});
  const bridge=physics.createCollider(RAPIER.ColliderDesc.cuboid(12,.12,1.8).setTranslation(0,2.02,0));
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(54,1,.03,4200);
  const deck=new THREE.Mesh(new THREE.BoxGeometry(24,.24,3.6),new THREE.MeshStandardMaterial({color:0x787b73}));
  deck.position.y=2.02;deck.name='Heritage bridge';scene.add(deck);
  const road=new THREE.CatmullRomCurve3([new THREE.Vector3(-64,2.14,0),new THREE.Vector3(-12,2.14,0),new THREE.Vector3(12,2.14,0),new THREE.Vector3(55,2.45,13)]);
  scene.userData.levelId=levelId;
  return {scene,camera,physics,bridge,deck,road};
}
