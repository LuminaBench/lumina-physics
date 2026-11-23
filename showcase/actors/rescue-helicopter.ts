import * as THREE from 'three/webgpu';
import { mergeStaticMeshes } from '../../engine/batching';
import { TSL } from '../../engine/tsl';
import { RotorBlur } from '../../modules/animation/rotor';

// Fuselage stations [longitudinal position, beam, half height, centre height] in metres.
const stations = [
  [-2.63, 0.08, 0.11, -0.24],
  [-2.42, 0.48, 0.35, -0.17],
  [-2.09, 0.79, 0.58, -0.1],
  [-1.65, 0.97, 0.79, 0],
  [-1.12, 1.03, 0.92, 0.08],
  [-0.52, 1.05, 0.97, 0.08],
  [0.35, 1.04, 0.98, 0.08],
  [1.18, 0.99, 0.88, 0.08],
  [1.75, 0.85, 0.68, 0.12],
  [2.28, 0.54, 0.48, 0.23],
  [2.85, 0.23, 0.24, 0.36],
];
function stationPoint(z: number, angle: number, offset = 0): THREE.Vector3 {
  let i = 0;
  while (i < stations.length - 2 && stations[i + 1][0] < z) i++;
  const a = stations[i],
    b = stations[i + 1],
    f = THREE.MathUtils.clamp((z - a[0]) / (b[0] - a[0]), 0, 1);
  const width = THREE.MathUtils.lerp(a[1], b[1], f) + offset,
    height = THREE.MathUtils.lerp(a[2], b[2], f) + offset;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return new THREE.Vector3(
    width * Math.sign(c) * Math.pow(Math.abs(c), 0.82),
    THREE.MathUtils.lerp(a[3], b[3], f) + height * Math.sign(s) * Math.pow(Math.abs(s), 0.83),
    z
  );
}
function skin(
  z0: number,
  z1: number,
  a0: number,
  a1: number,
  material: THREE.Material,
  offset = 0,
  raked = 0,
  endRake = 0
): THREE.Mesh {
  const pos: number[] = [],
    index: number[] = [], uv: number[] = [];
  const around = Math.max(3, Math.ceil((a1 - a0) * 7)),
    along = Math.max(3, Math.ceil((z1 - z0) * 6));
  for (let j = 0; j <= along; j++)
    for (let i = 0; i <= around; i++) {
      const u = i / around,
        v = j / along,
        a = a0 + (a1 - a0) * u;
      const p = stationPoint(z0 + (z1 - z0) * v + (raked * (1 - v) + endRake * v) * Math.max(0, Math.sin(a)), a, offset);
      pos.push(p.x, p.y, p.z);
      uv.push(Math.cos((a0 + a1) * 0.5) > 0 ? 1-v : v, Math.sin(a1) > Math.sin(a0) ? u : 1-u);
      if (i < around && j < along) {
        const k = j * (around + 1) + i;
        index.push(k, k + 1, k + around + 1, k + 1, k + around + 2, k + around + 1);
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}
function spar(
  a: THREE.Vector3,
  b: THREE.Vector3,
  root: number,
  tip: number,
  material: THREE.Material
): THREE.Mesh {
  const delta = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(tip, root, delta.length(), 12), material);
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}
export class RescueHelicopter {
  readonly group = new THREE.Group();
  private readonly pitchLinks = new THREE.Group();
  private readonly main = new RotorBlur({
    radius: 4.65,
    coning: 0.061,
    hubRadius: 0.22,
    blades: 4,
    chord: [0.31, 0.22],
    shutter: 1 / 85,
    density: 1.8,
    tipColor: 0xd9b567,
  });
  private readonly tail = new RotorBlur({
    radius: 0.76,
    hubRadius: 0.09,
    blades: 4,
    chord: [0.1, 0.075],
    shutter: 1 / 80,
    density: 1.55,
  });
  constructor() {
    const g = this.group,
      v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const cream = new THREE.MeshStandardNodeMaterial({ color: 0xd4d1bb, roughness: 0.38, metalness: 0.23 });
    const red = new THREE.MeshStandardNodeMaterial({ color: 0xaf3b21, roughness: 0.34, metalness: 0.26 });
    const graphite = new THREE.MeshStandardNodeMaterial({ color: 0x2c3230, roughness: 0.47, metalness: 0.62 });
    const rubber = new THREE.MeshStandardNodeMaterial({ color: 0x191e1c, roughness: 0.68 });
    const glass = new THREE.MeshPhysicalNodeMaterial({
      color: 0xb1ccd0, roughness: 0.065, metalness: 0, ior: 1.52,
      clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, depthWrite: false,
    });
    const facing = TSL.abs(TSL.dot(TSL.normalView, TSL.positionViewDirection));
    glass.opacityNode = facing.oneMinus().pow(3.6).mul(0.63).add(0.19);
    const box = (x: number, y: number, z: number, w: number, h: number, l: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,l),material);
      mesh.position.set(x,y,z);
      g.add(mesh);
      return mesh;
    };
    const panes = [
      { start:-2.41, end:-1.18, lo:-0.01, hi:1.45, rake:0.71 },
      { start:-1.09, end:-0.13, lo:-0.025, hi:1.02, rake:0.07 },
      { start:0.01, end:1.22, lo:0.055, hi:0.95, rake:0 },
    ];
    const bands = [...new Set([-Math.PI/2, Math.PI/2, ...panes.flatMap(p => [p.lo,p.hi])])].sort((a,b)=>a-b);
    const marking = this.serviceMarking();
    for (const side of [-1, 1]) {
      const patch = (z0: number, z1: number, lo: number, hi: number, m: THREE.Material,
        offset=0, rake=0, endRake=0) => skin(z0,z1, side>0 ? lo : Math.PI-hi,
          side>0 ? hi : Math.PI-lo,m,offset,rake,endRake);
      // Loft the painted shell around the openings, preserving sightlines through both sides.
      for (let j=1; j<bands.length; j++) {
        const lo=bands[j-1], hi=bands[j], angle=(lo+hi)/2;
        let start=-2.63;
        for (const pane of panes) {
          if (angle < pane.lo || angle > pane.hi) continue;
          g.add(patch(start,pane.start,lo,hi,cream,0,0,pane.rake));
          start=pane.end;
        }
        g.add(patch(start,2.85,lo,hi,cream));
      }
      for (const {start,end,lo,hi,rake} of panes) {
        const trim=0.027, angleTrim=0.026;
        g.add(patch(start,start+trim,lo,hi,rubber,0.004,rake,rake),
          patch(end-trim,end,lo,hi,rubber,0.004),
          patch(start+trim,end-trim,lo,lo+angleTrim,rubber,0.004,rake),
          patch(start+trim,end-trim,hi-angleTrim,hi,rubber,0.004,rake),
          patch(start+trim,end-trim,lo+angleTrim,hi-angleTrim,glass,0.003,rake));
      }
      g.add(patch(-2.60,2.81,-Math.PI/2,-0.285,red,0.009));
      g.add(patch(-2.34,2.68,-0.252,-0.234,red,0.012));
      g.add(patch(-0.42,1.11,-0.22,-0.035,marking,0.018));
      // Seats, pilots' helmets and the dark coaming remain visible through the curved canopy.
      for (const z of [-0.71,0.69]) {
        box(side*0.48,-0.23,z,0.52,0.14,0.51,rubber);
        box(side*0.48,0.025,z+0.20,0.53,0.53,0.14,graphite).rotation.x=0.10;
      }
      const pilotHelmet = new THREE.Mesh(new THREE.SphereGeometry(0.165,16,10),cream);
      pilotHelmet.position.set(side*0.48,0.42,-0.70);
      g.add(pilotHelmet);
      const shoulder = new THREE.Mesh(new THREE.CapsuleGeometry(0.17,0.16,4,10),rubber);
      shoulder.position.set(side*0.48,0.105,-0.71);
      shoulder.scale.x=1.25;
      g.add(shoulder);
      g.add(spar(v(side * 1.03, -0.2, 0.76), v(side * 1.03, -0.2, 0.99), 0.022, 0.022, graphite));
      g.add(spar(v(side * 1.06, -1.09, -1.69), v(side * 1.06, -1.09, 1.62), 0.065, 0.065, graphite));
      g.add(spar(v(side * 1.06, -1.09, -1.69), v(side * 1.03, -0.98, -1.97), 0.065, 0.05, graphite));
      for (const z of [-0.91, 1.03])
        g.add(spar(v(side * 0.57, -0.52, z), v(side * 1.06, -1.09, z + 0.13), 0.047, 0.052, graphite));
      const duct = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.93, 5, 12), cream);
      duct.rotation.x = Math.PI / 2;
      duct.position.set(side * 0.39, 0.93, 0.53);
      g.add(duct);
      g.add(spar(v(side * 0.47, 0.92, 0.72), v(side * 0.49, 0.94, 1.42), 0.142, 0.13, graphite));
    }
    box(0,-0.105,-1.63,1.45,0.25,0.38,graphite).rotation.x=-0.19;
    box(0,-0.51,-0.1,1.46,0.056,2.86,rubber);
    // Cabin hoist, fairlead and rescue hook mount on the starboard door lintel.
    g.add(spar(v(0.82,0.71,0.17),v(1.29,0.85,0.35),0.048,0.052,graphite));
    g.add(spar(v(0.78,0.71,0.85),v(1.29,0.85,0.64),0.05,0.052,graphite));
    g.add(spar(v(1.26,0.84,0.29),v(1.26,0.84,0.7),0.13,0.13,cream));
    g.add(spar(v(1.29,0.75,0.53),v(1.29,0.48,0.53),0.013,0.013,graphite));
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.063,0.015,8,12,Math.PI*1.6),graphite);
    hook.position.set(1.29,0.43,0.53); hook.rotation.y=Math.PI/2; g.add(hook);
    g.add(spar(v(0, 0.25, 2.13), v(0, 0.81, 6.24), 0.46, 0.12, red));
    const fin = new THREE.Shape();
    fin.moveTo(5.28, 0.61);
    fin.lineTo(6.22, 0.66);
    fin.lineTo(6.56, 2.33);
    fin.lineTo(6.19, 2.32);
    fin.closePath();
    // The outline is in the y/z plane, with a narrow physical thickness across the centreline.
    const f = new THREE.ExtrudeGeometry(fin, { depth: 0.09, bevelEnabled: false });
    f.rotateY(-Math.PI / 2);
    f.translate(0.045, 0, 0);
    g.add(new THREE.Mesh(f, red));
    const stabilizer = new THREE.Mesh(new THREE.BoxGeometry(2.26, 0.065, 0.5), cream);
    stabilizer.position.set(0, 0.74, 4.84);
    g.add(stabilizer);
    g.add(spar(v(0, 0.9, 0.09), v(0, 1.56, 0.09), 0.14, 0.1, graphite));
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 8), graphite);
    hub.scale.y = 0.45;
    hub.position.set(0, 1.52, 0.09);
    g.add(hub);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
    const plate = new THREE.Mesh(new THREE.TorusGeometry(0.175,0.041,8,24),graphite);
    plate.rotation.x=-Math.PI/2; plate.position.set(0,1.32,0.09); g.add(plate);
    this.pitchLinks.position.set(0,1.54,0.09);
    for (let i=0;i<4;i++) {
      const a=i*Math.PI/2, x=Math.cos(a), z=Math.sin(a);
      this.pitchLinks.add(spar(v(x*0.12,0,z*0.12),v(x*0.59,0.023,z*0.59),0.063,0.046,graphite),
        spar(v(x*0.16-z*0.046,-0.20,z*0.16+x*0.046),v(x*0.42-z*0.069,0,z*0.42+x*0.069),0.017,0.017,cream));
    }
    mergeStaticMeshes(this.pitchLinks);
    mergeStaticMeshes(g);
    g.add(this.pitchLinks);
    this.main.mesh.rotation.x = -Math.PI / 2;
    this.main.mesh.position.set(0, 1.55, 0.09);
    g.add(this.main.mesh);
    this.tail.mesh.rotation.y = Math.PI / 2;
    this.tail.mesh.position.set(0.155, 1.36, 6.12);
    g.add(this.tail.mesh);
  }
  private serviceMarking(): THREE.MeshStandardNodeMaterial {
    const canvas=document.createElement('canvas');
    canvas.width=512; canvas.height=80;
    const ctx=canvas.getContext('2d')!;
    ctx.font='bold 62px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#252c31'; ctx.fillText('COAST RESCUE',256,41,490);
    const texture=new THREE.CanvasTexture(canvas);
    texture.colorSpace=THREE.SRGBColorSpace; texture.anisotropy=4;
    const material=new THREE.MeshStandardNodeMaterial({map:texture, alphaTest:0.22, roughness:0.49});
    material.addEventListener('dispose',()=>texture.dispose());
    return material;
  }
  update(dt: number, time: number): void {
    this.group.rotation.set(0.021 * Math.sin(time * 1.13), 0.64, 0.019 * Math.sin(time * 1.47));
    this.pitchLinks.rotation.y = this.main.update(dt, 35.8);
    this.tail.update(dt, 153);
  }
  dispose(): void {
    this.main.dispose();
    this.tail.dispose();
    const materials = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        materials.add(o.material);
      }
    });
    for (const m of materials) m.dispose();
    this.group.removeFromParent();
  }
}
