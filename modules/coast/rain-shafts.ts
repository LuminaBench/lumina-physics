import * as THREE from 'three/webgpu';
import { frame, auxPassthrough } from '../../engine/frame';
import { TSL } from '../../engine/tsl';
import type { WeatherFront } from '../weather/front';
import type { Weather } from '../weather/weather';
/** Three world-sampled, camera-facing integration slices through the local precipitation layer. */
export class CoastalRainShafts {
  readonly root = new THREE.Group();
  private readonly material = new THREE.MeshBasicNodeMaterial();
  private readonly mesh: THREE.Mesh[] = [];
  private readonly geom = new THREE.PlaneGeometry(1, 1);
  private readonly base = TSL.uniform(650);
  private readonly forward = new THREE.Vector3();
  constructor(
    private front: WeatherFront,
    private weather: Weather,
    scene: THREE.Scene,
  ) {
    const { positionWorld: p, positionGeometry: local, vec3, sin, mix, smoothstep } = TSL;
    const q = p.xz.add(TSL.vec2(0.13, -0.05).mul(p.y));
    const sample = front.mapNode(q, frame.time);
    const sky = frame.skyHorizon
      .mul(0.57)
      .add(frame.skyZenith.mul(0.18))
      .add(vec3(0.035, 0.042, 0.05));
    const streak = sin(
      q.x
        .mul(0.054)
        .add(q.y.mul(0.028))
        .add(sin(q.y.mul(0.012)).mul(2)),
    )
      .mul(0.055)
      .add(0.945);
    const vertical = smoothstep(0, 0.14, p.y.div(this.base)).mul(smoothstep(1, 0.6, p.y.div(this.base)));
    const edge = smoothstep(0.5, 0.34, local.x.abs());
    this.material.colorNode = mix(
      sky,
      frame.sunColor.mul(0.13).add(sky),
      TSL.dot(frame.sunDirection, p.sub(TSL.cameraPosition).normalize()).max(0).pow(3).mul(0.21),
    );
    this.material.opacityNode = sample.g.pow(1.45).mul(vertical).mul(edge).mul(streak).mul(0.24);
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.side = THREE.DoubleSide;
    this.material.forceSinglePass = true;
    this.material.mrtNode = auxPassthrough();
    this.material.fog = false;
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(this.geom, this.material);
      mesh.renderOrder = 4 - i;
      this.mesh.push(mesh);
      this.root.add(mesh);
    }
    this.root.name = 'Rain beyond the observer';
    scene.add(this.root);
  }
  update(camera: THREE.PerspectiveCamera) {
    const h = this.weather.params.cloudBase;
    this.base.value = h;
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();
    for (let i = 0; i < 3; i++) {
      const mesh = this.mesh[i],
        dist = 490 + i * 670;
      mesh.position.copy(camera.position).addScaledVector(this.forward, dist);
      mesh.position.y = h * 0.5;
      mesh.rotation.y = Math.atan2(this.forward.x, this.forward.z);
      mesh.scale.set(dist * 3.7, h, 1);
    }
    this.root.visible = this.front.options.type !== 'streets' && camera.position.y < h * 1.15;
  }
  dispose() {
    this.geom.dispose();
    this.material.dispose();
    this.root.removeFromParent();
  }
}
