/** Camera helpers shared by the showcase scenes. */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Orbit camera whose pivot can follow a moving object without losing the user's framing. */
export class FollowOrbit {
  readonly controls: OrbitControls;
  private readonly offset = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private last = new THREE.Vector3();
  /** Slow automatic orbit (rad/s) while the user is not dragging. */
  autoRotate = 0;
  /** Keep the camera at least this far above a height function (e.g. waves). */
  floor: ((x: number, z: number) => number) | null = null;

  constructor(private camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, target: THREE.Vector3, offset: THREE.Vector3) {
    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.copy(target);
    this.controls.maxPolarAngle = Math.PI * 0.497;
    camera.position.copy(target).add(offset);
    this.last.copy(target);
    this.controls.update();
  }

  /** Move the pivot (and the camera with it) to a new target position. */
  follow(target: THREE.Vector3, smoothing = 1): void {
    const delta = this.offset.copy(target).sub(this.last).multiplyScalar(smoothing);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.last.add(delta);
  }

  update(dt: number): void {
    if (this.autoRotate !== 0) {
      const offset = this.offset.copy(this.camera.position).sub(this.controls.target);
      offset.applyAxisAngle(this.up, this.autoRotate * dt);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.update();
    if (this.floor) {
      const min = this.floor(this.camera.position.x, this.camera.position.z) + 0.6;
      if (this.camera.position.y < min) this.camera.position.y = min;
    }
  }

  dispose(): void { this.controls.dispose(); }
}
