import * as THREE from 'three/webgpu';
import type { createCoastalWorld } from '../../modules/coast/world';

/** A real survey stake, included in the local environment seen by the wet sand. */
export class SandGauge {
  readonly stake = new THREE.Group();
  private readonly wood = new THREE.MeshStandardMaterial({ color: '#59382d', roughness: 0.85 });
  private readonly red = new THREE.MeshStandardMaterial({ color: '#ae4329', roughness: 0.55 });
  private readonly white = new THREE.MeshStandardMaterial({ color: '#ede3c8', roughness: 0.62 });
  private readonly block = new THREE.BoxGeometry();
  private readonly cap = new THREE.CylinderGeometry(0.002, 0.096, 0.085, 4);
  private readonly oldCenter: THREE.Vector3;
  private readonly oldSize: THREE.Vector3;
  constructor(
    readonly world: Awaited<ReturnType<typeof createCoastalWorld>>,
    readonly point: THREE.Vector3,
  ) {
    const probe = world.weather.localProbe!;
    this.oldCenter = probe.center.clone();
    this.oldSize = probe.halfSize.clone();
    const x = point.x - 0.77,
      z = point.z;
    this.stake.position.set(x, world.ground(x, z) - 0.025, z);
    const piece = (mat: THREE.Material, y: number, w: number, h: number, d: number, offset = 0) => {
      const m = new THREE.Mesh(this.block, mat);
      m.position.set(offset, y, 0);
      m.scale.set(d, h, w);
      m.layers.enable(probe.layer);
      m.castShadow = m.receiveShadow = true;
      this.stake.add(m);
    };
    piece(this.wood, 0.59, 0.145, 1.18, 0.08);
    piece(this.red, 0.57, 0.135, 1.08, 0.012, 0.046);
    for (let i = 0; i < 5; i++) piece(this.white, 0.16 + 0.2 * i, 0.135, 0.062, 0.012, 0.054);
    for (let i = 0; i < 10; i++) piece(this.white, 0.105 + 0.1 * i, 0.052, 0.008, 0.014, 0.057);
    const top = new THREE.Mesh(this.cap, this.wood);
    top.rotation.y = Math.PI / 4;
    top.scale.z = 1.08;
    top.scale.x = 0.6;
    top.position.y = 1.22;
    top.layers.enable(probe.layer);
    this.stake.add(top);
    this.stake.scale.y = 0.82;
    this.stake.name = 'Painted sand survey stake';
    this.stake.visible = false;
    world.engine.scene.add(this.stake);
  }
  show(visible: boolean) {
    if (visible === this.stake.visible) return;
    this.stake.visible = visible;
    const probe = this.world.weather.localProbe!,
      p = this.stake.position;
    if (visible) {
      // The capture box's seaward wall coincides with the painted stake face.
      probe.center.set(p.x + 1.41, p.y + 0.48, p.z);
      probe.halfSize.set(1.36, 1.75, 1.85);
    } else {
      probe.center.copy(this.oldCenter);
      probe.halfSize.copy(this.oldSize);
    }
  }
  wet() {
    const { x, z } = this.point,
      bed = this.world.sediment;
    bed.imprint('wheel', x, z, 0, 0.92, 1.6, 0.9, 0.08);
    return bed.wetPatch(x, z, 1.05, 9);
  }
  dispose() {
    this.show(false);
    this.stake.removeFromParent();
    this.block.dispose();
    this.cap.dispose();
    this.wood.dispose();
    this.white.dispose();
    this.red.dispose();
  }
}
