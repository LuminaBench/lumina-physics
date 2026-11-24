import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TSL } from '../../engine/tsl';
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
  private readonly bag: THREE.Mesh;
  private readonly gunwale: THREE.Mesh;
  private readonly runner: THREE.Mesh;
  private readonly line = TSL.uniform(new THREE.Vector4());
  private readonly flow = new THREE.Vector3();
  readonly load = { kg: 0, side: 0 };
  readonly reading = { draft: 0, heelDeg: 0, relativeSpeed: 0, displacedLitres: 0 };
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
    const skin = new THREE.MeshStandardNodeMaterial({
      color: '#96afa5',
      roughness: 0.54,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const across = TSL.smoothstep(-0.42, 0.42, TSL.positionGeometry.x);
    const along = TSL.smoothstep(-0.95, 0.94, TSL.positionGeometry.z);
    const sea = TSL.mix(
      TSL.mix(this.line.x, this.line.y, across),
      TSL.mix(this.line.z, this.line.w, across),
      along,
    );
    const above = TSL.positionWorld.y.sub(sea);
    const damp = TSL.smoothstep(0.03, -0.011, above);
    const meniscus = TSL.smoothstep(0.012, 0.001, above.abs());
    const stripe = TSL.smoothstep(0.021, 0.013, TSL.positionGeometry.y.sub(0.182).abs());
    const paint = TSL.mix(TSL.color('#a7b8a9'), TSL.color('#344b50'), stripe);
    skin.colorNode = paint.mul(damp.mul(-0.28).add(1));
    skin.roughnessNode = TSL.mix(0.56, 0.16, damp.max(meniscus));
    this.hull = new THREE.Mesh(geom, skin);
    // One continuous raised lip on each side gives the shell a readable thickness from the water.
    const lipPos: number[] = [],
      lipIds: number[] = [];
    for (const side of [-1, 1]) {
      const first = lipPos.length / 3;
      for (const [z, width, lip] of sections) {
        const y = lip + 0.06 * Math.abs(z) ** 1.5;
        for (let k = 0; k < 6; k++) {
          const a = (k * Math.PI) / 3;
          lipPos.push(side * width + 0.018 * Math.cos(a), y + 0.018 * Math.sin(a), z);
        }
      }
      for (let j = 0; j < sections.length - 1; j++)
        for (let k = 0; k < 6; k++) {
          const a = first + j * 6 + k,
            b = first + j * 6 + ((k + 1) % 6);
          lipIds.push(a, b, a + 6, b, b + 6, a + 6);
        }
    }
    const railGeom = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(lipPos, 3),
    );
    railGeom.setIndex(lipIds);
    railGeom.computeVertexNormals();
    this.gunwale = new THREE.Mesh(
      railGeom,
      new THREE.MeshStandardMaterial({ color: '#455851', roughness: 0.53, side: THREE.DoubleSide }),
    );
    this.runner = new THREE.Mesh(
      new RoundedBoxGeometry(0.65, 0.055, 1.9, 2, 0.017),
      new THREE.MeshStandardMaterial({ color: '#8e7e63', roughness: 0.72 }),
    );
    this.runner.position.y = -0.14;
    this.bag = new THREE.Mesh(
      new RoundedBoxGeometry(0.49, 0.3, 0.52, 3, 0.09),
      new THREE.MeshStandardMaterial({ color: '#91633f', roughness: 0.91 }),
    );
    this.bag.position.set(0, 0.27, -0.24);
    this.bag.visible = false;
    this.seat = new THREE.Mesh(
      new THREE.BoxGeometry(0.98, 0.065, 0.29),
      new THREE.MeshStandardMaterial({ color: '#836a50', roughness: 0.78 }),
    );
    this.seat.position.set(0, 0.18, -0.24);
    this.mesh.add(this.hull, this.seat, this.bag, this.runner, this.gunwale);
    for (const child of this.mesh.children) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
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
  /** Additional passenger or cargo mass. Lateral position is measured from the keel. */
  setLoad(kg: number, side: number) {
    if (!Number.isFinite(kg) || kg < 0 || kg > 120 || !Number.isFinite(side) || Math.abs(side) > 0.42)
      throw new RangeError('Skiff payload must fit this hull: 0–120 kg within 0.42 m of its keel');
    this.load.kg = kg;
    this.load.side = side;
    // Additional inertia is about the payload's own centre; Rapier combines it with the hull.
    this.body.setAdditionalMassProperties(
      kg,
      { x: side, y: 0.28, z: -0.24 },
      {
        x: (kg * (0.3 ** 2 + 0.52 ** 2)) / 12,
        y: (kg * (0.49 ** 2 + 0.52 ** 2)) / 12,
        z: (kg * (0.49 ** 2 + 0.3 ** 2)) / 12,
      },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    this.body.recomputeMassPropertiesFromColliders();
    this.bag.visible = kg > 0;
    this.bag.position.x = side;
    this.bag.scale.setScalar(Math.cbrt(Math.max(0.06, kg / 90)));
  }
  reset() {
    const w = this.w,
      along = w.coast.project(0, 0).along - 6;
    // Launch beyond the drying bar. Leave enough water under the loaded hull at the current tide.
    let cross = -15;
    let p = w.coast.point(along, cross);
    while (cross > -110 && w.ocean.waterLevel - w.ground(p.x, p.z) < 0.78) {
      cross -= 2;
      p = w.coast.point(along, cross);
    }
    const s = w.coast.project(p.x, p.z);
    this.rotation.setFromAxisAngle(this.look.set(0, 1, 0), Math.atan2(s.tangentX, s.tangentZ));
    this.mesh.visible = true;
    this.body.setEnabled(true);
    this.body.setTranslation(this.spawn.set(p.x, w.ocean.heightAt(p.x, p.z) + 0.08, p.z), true);
    this.body.setRotation(this.rotation, true);
    this.body.setAngvel(this.push.set(0, 0, 0), true);
    this.body.setLinvel(this.push, true);
    w.engine.physics.snap(this.body);
    this.soilTick = 0.12;
    this.line.value.setScalar(w.ocean.waterLevel);
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
      this.w.ocean.flowAt(this.mesh.position.x, this.mesh.position.z, this.flow);
      this.velocity.sub(this.flow);
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const state = this.float.state;
      for (let i = 0; i < 4; i++) {
        const v = state.pointWorld[i];
        this.line.value.setComponent(i, this.w.ocean.heightAt(v.x, v.z));
      }
      const mean = (this.line.value.x + this.line.value.y + this.line.value.z + this.line.value.w) * 0.25;
      this.reading.draft = Math.max(0, mean - this.mesh.position.y + 0.28);
      const sideAxis = this.look.set(1, 0, 0).applyQuaternion(this.mesh.quaternion);
      this.reading.heelDeg = (Math.asin(THREE.MathUtils.clamp(sideAxis.y, -1, 1)) * 180) / Math.PI;
      this.reading.displacedLitres = state.submersion * 430;
      this.reading.relativeSpeed = speed;
      if (speed > 0.3) {
        // Divergent bow crests originate where the submerged shoulders first meet the flow.
        this.w.ocean.field.matchKelvin(speed);
        const fwd = this.velocity.dot(this.forward) >= 0 ? 1 : -1;
        const strength = Math.min(1, speed * 0.24) * state.submersion;
        for (const side of [-1, 1]) {
          this.look
            .set(side * 0.36, -0.06, fwd * 0.83)
            .applyQuaternion(this.mesh.quaternion)
            .add(this.mesh.position);
          this.source.x = this.look.x;
          this.source.z = this.look.z;
          this.source.radius = 0.31;
          this.source.push = 0.085 * strength;
          this.source.foam = 0.2 * strength;
          this.w.ocean.field.addSource(this.source);
        }
      }
      this.source.radius = 0.58;
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
    for (const m of [this.hull, this.seat, this.gunwale, this.runner, this.bag]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
