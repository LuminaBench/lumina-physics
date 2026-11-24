import * as THREE from 'three/webgpu';
import { BuoyantBody } from '../../modules/water/buoyancy';
import type { RigidBody } from '../../engine/physics';
import type { CoastalWorld } from '../../modules/coast/world';

/** Six hull sections, four buoyancy samples and a shallow propeller wash. */
export class CoastSkiff {
  readonly mesh = new THREE.Group();
  private readonly float: BuoyantBody;
  private readonly body: RigidBody;
  private readonly push = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly stern = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly spawn = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly source = { x: 0, z: 0, radius: 0.58, impulse: 0, push: -0.04, foam: 0.12 };
  private readonly unhook: () => void;
  private readonly hull: THREE.Mesh;
  private readonly seat: THREE.Mesh;
  private motor = 0;
  private soilTick = 0;
  constructor(private w: CoastalWorld) {
    const geom = new THREE.BufferGeometry(),
      points: number[] = [],
      indices: number[] = [];
    const sections = [
      [-1.55, 0.4, 0.27],
      [-1.04, 0.61, 0.27],
      [-0.28, 0.68, 0.29],
      [0.58, 0.6, 0.31],
      [1.28, 0.36, 0.37],
      [1.68, 0.035, 0.5],
    ];
    for (const [z, width, lip] of sections) {
      for (const [u, y] of [
        [-1, lip],
        [-0.87, -0.02],
        [-0.48, -0.23],
        [0, -0.28],
        [0.48, -0.23],
        [0.87, -0.02],
        [1, lip],
      ]) {
        points.push(width * u, y + 0.06 * Math.abs(z) ** 1.5, z);
      }
    }
    for (let k = 0; k < sections.length - 1; k++)
      for (let j = 0; j < 6; j++) {
        const a = k * 7 + j;
        indices.push(a, a + 7, a + 1, a + 1, a + 7, a + 8);
      }
    for (let i = 1; i < 6; i++) {
      indices.push(0, i, i + 1);
      const k = (sections.length - 1) * 7;
      indices.push(k, k + i + 1, k + i);
    }
    geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    this.hull = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: '#a6b8ae',
        roughness: 0.51,
        metalness: 0.09,
        side: THREE.DoubleSide,
      }),
    );
    this.seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.98, 0.065, 0.29),
      new THREE.MeshStandardMaterial({ color: '#836a50', roughness: 0.78 }),
    );
    this.seat.position.set(0, 0.18, -0.24);
    this.mesh.add(this.hull, this.seat);
    this.mesh.castShadow = true;
    w.engine.scene.add(this.mesh);
    const p = w.engine.physics,
      R = p.RAPIER;
    this.body = p.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setLinearDamping(0.28).setAngularDamping(0.72),
    );
    p.world.createCollider(R.ColliderDesc.cuboid(0.47, 0.14, 1.33).setMass(165), this.body);
    this.float = new BuoyantBody(p, w.ocean, this.body, {
      points: [
        new THREE.Vector3(-0.45, -0.17, -0.95),
        new THREE.Vector3(0.45, -0.17, -0.95),
        new THREE.Vector3(-0.36, -0.15, 0.94),
        new THREE.Vector3(0.36, -0.15, 0.94),
      ],
      volume: 0.43,
      draft: 0.27,
      linearDrag: 66,
      quadraticDrag: 18,
      keel: 2,
    });
    p.bind(this.body, this.mesh);
    this.unhook = p.addPreStep((dt) => {
      if (!this.mesh.visible || this.motor === 0) return;
      this.body.rotation(this.rotation);
      this.forward.set(0, 0, 1).applyQuaternion(this.rotation);
      this.forward.y = 0;
      this.body.applyImpulse(this.push.copy(this.forward).multiplyScalar(350 * this.motor * dt), true);
    });
  }
  reset() {
    const w = this.w,
      along = w.coast.project(0, 0).along,
      p = w.coast.point(along - 6, -15),
      s = w.coast.project(p.x, p.z);
    this.rotation.setFromAxisAngle(this.look.set(0, 1, 0), Math.atan2(s.tangentX, s.tangentZ));
    this.mesh.visible = true;
    this.body.setEnabled(true);
    this.body.setTranslation(this.spawn.set(p.x, w.ocean.heightAt(p.x, p.z) + 0.08, p.z), true);
    this.body.setRotation(this.rotation, true);
    this.body.setAngvel(this.push.set(0, 0, 0), true);
    this.body.setLinvel(this.push, true);
    w.engine.physics.snap(this.body);
    this.soilTick = 0;
  }
  hide() {
    this.mesh.visible = false;
    this.motor = 0;
    this.body.setEnabled(false);
  }
  drive(dt: number, keys: Set<string>, replay: boolean) {
    this.motor = replay
      ? 0.68
      : Number(keys.has('KeyW') || keys.has('ArrowUp')) -
        0.45 * Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const turn =
      Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    if (turn) this.body.applyTorqueImpulse(this.push.set(0, dt * turn * 95, 0), true);
    this.forward.set(0, 0, 1).applyQuaternion(this.mesh.quaternion);
    this.stern.copy(this.mesh.position).addScaledVector(this.forward, -1.42);
    this.w.setFocus(this.stern);
    this.soilTick += dt;
    if (this.soilTick >= 0.12) {
      const step = this.soilTick;
      this.soilTick = 0;
      this.body.linvel(this.velocity);
      const speed = this.velocity.length();
      this.source.x = this.stern.x;
      this.source.z = this.stern.z;
      this.source.push = -Math.min(0.28, speed * 0.08);
      this.source.foam = Math.min(0.6, speed * 0.1);
      if (speed > 0.3) this.w.ocean.field.addSource(this.source);
      const depth = this.w.ocean.waterLevel - this.w.ground(this.stern.x, this.stern.z);
      if (depth > 0 && depth < 1.2 && Math.abs(this.motor) > 0.05)
        this.w.sediment.stir(
          this.stern.x,
          this.stern.z,
          0.65,
          step * Math.abs(this.motor) * 2 * (1 - depth / 1.2),
        );
    }
  }
  placeCamera() {
    const p = this.mesh.position,
      cam = this.w.engine.camera;
    cam.position
      .copy(p)
      .addScaledVector(this.forward, -5)
      .add(this.push.set(1.35, 2.1, 0));
    cam.lookAt(this.look.copy(p).addScaledVector(this.forward, -0.45));
  }
  dispose() {
    this.unhook();
    this.float.dispose();
    this.w.engine.physics.removeBody(this.body);
    this.mesh.removeFromParent();
    for (const m of [this.hull, this.seat]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
