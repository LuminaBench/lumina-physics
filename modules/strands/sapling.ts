import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import type { EngineModule, LuminaEngine } from '../../engine/engine';
import type { RigidBody } from '../../engine/physics';

export interface SaplingOptions {
  height?: number;
  radius?: number;
  seed?: number;
  breakingStrain?: number;
}

/** A tapered trunk carrying flexible branches. A broken crown keeps its world pose and
 * becomes a real collision body. Each branch retains its parent segment's motion. */
export class FlexibleTree implements EngineModule {
  readonly root = new THREE.Group();
  readonly joints: THREE.Group[] = [];
  readonly stats = { peakStrain: 0, brokenAt: -1 };
  private readonly motion = new Float64Array(5 * 4);
  private readonly limbs: THREE.Group[] = [];
  private readonly limbsPhase: number[] = [];
  private readonly position = new THREE.Vector3();
  private readonly wind = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly fixed: RigidBody;
  private fallen: RigidBody | null = null;
  private crown: THREE.Group | null = null;
  private releases: (() => void)[] = [];
  private readonly height: number;
  private readonly radius: number;
  private readonly strength: number;
  private readonly bark = new THREE.MeshStandardNodeMaterial({ color: 0x615044, roughness: 0.93 });
  private readonly foliage = new THREE.MeshStandardNodeMaterial({
    color: 0x496235,
    roughness: 0.83,
    side: THREE.DoubleSide,
  });
  private readonly exposed = new THREE.MeshStandardNodeMaterial({ color: 0xbb9566, roughness: 0.9 });

  constructor(
    private engine: LuminaEngine,
    base: THREE.Vector3,
    options: SaplingOptions = {}
  ) {
    this.height = Math.max(1, options.height ?? 6);
    this.radius = Math.max(0.05, options.radius ?? 0.17);
    this.strength = Math.max(0.08, options.breakingStrain ?? 0.52);
    const rand = mulberry32(options.seed ?? 8741);
    this.root.position.copy(base);
    engine.scene.add(this.root);
    const n = 5,
      length = this.height / n;
    let parent = this.root;
    const leafVerts: number[] = [];
    for (let i = 0; i < 32; i++) {
      const a = i * 2.39996,
        r = 0.25 + rand() * 0.63,
        x = Math.cos(a) * r,
        z = Math.sin(a) * r,
        y = rand() * 0.94;
      const dx = Math.cos(a + 1.3) * 0.095,
        dz = Math.sin(a + 1.3) * 0.095;
      leafVerts.push(
        x - dx,
        y,
        z - dz,
        x + dx,
        y + 0.035,
        z + dz,
        x + 0.2 * Math.cos(a),
        y + 0.3,
        z + 0.2 * Math.sin(a)
      );
    }
    const leaves = new THREE.BufferGeometry();
    leaves.setAttribute('position', new THREE.Float32BufferAttribute(leafVerts, 3));
    leaves.computeVertexNormals();
    for (let i = 0; i < n; i++) {
      const hinge = new THREE.Group();
      hinge.position.y = i ? length : 0;
      parent.add(hinge);
      parent = hinge;
      this.joints.push(hinge);
      const girth = this.radius * (1 - (i / n) * 0.8);
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(girth - this.radius * 0.14, girth, length, 10),
        this.bark
      );
      trunk.position.y = length * 0.5;
      trunk.castShadow = trunk.receiveShadow = true;
      hinge.add(trunk);
      if (i === 0) continue;
      for (let j = 0; j < 3; j++) {
        const arm = new THREE.Group();
        const a = i * 2.39 + j * 2.12;
        arm.position.y = length * (0.22 + 0.24 * j);
        arm.rotation.y = a;
        hinge.add(arm);
        this.limbs.push(arm);
        this.limbsPhase.push(a);
        const span = this.height * (0.22 + rand() * 0.08) * (1 - i * 0.09);
        const limb = new THREE.Mesh(new THREE.CylinderGeometry(girth * 0.1, girth * 0.46, span, 6), this.bark);
        limb.rotation.z = -0.92;
        limb.position.set(span * 0.4, span * 0.3, 0);
        arm.add(limb);
        for (let cl = 0; cl < 3; cl++) {
          const leaf = new THREE.Mesh(leaves, this.foliage);
          leaf.position.set(span * (0.37 + cl * 0.2), span * (0.28 + cl * 0.14), 0);
          leaf.scale.setScalar(this.height * (0.13 + 0.015 * cl));
          leaf.rotation.y = rand() * 6.28;
          leaf.castShadow = true;
          arm.add(leaf);
        }
      }
    }
    const physics = engine.physics,
      R = physics.RAPIER;
    this.fixed = physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(base.x, base.y, base.z));
    const collider = physics.world.createCollider(
      R.ColliderDesc.cylinder(this.height * 0.45, this.radius).setTranslation(0, this.height * 0.45, 0),
      this.fixed
    );
    this.releases.push(
      physics.onContactForce(collider, 900, (force) => this.impact(Math.min(1.6, force / 7500)))
    );
    this.releases.push(
      physics.onBlast((p, range, impulse) => {
        const d = base.distanceTo(p);
        if (d < range) this.impact((1 - d / range) * Math.min(2, impulse * 0.07));
      })
    );
  }

  impact(amount: number): void {
    if (this.fallen || amount <= 0) return;
    this.motion[6] += amount * 4;
    this.motion[7] += amount * 1.7;
    if (amount >= this.strength) this.snap(1);
  }
  private snap(index: number): void {
    if (this.fallen) return;
    const physics = this.engine.physics,
      R = physics.RAPIER,
      crown = this.joints[index];
    crown.updateWorldMatrix(true, true);
    this.engine.scene.attach(crown);
    crown.getWorldPosition(this.position);
    crown.getWorldQuaternion(this.rotation);
    const b = physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(this.position.x, this.position.y, this.position.z)
        .setRotation(this.rotation)
        .setAngularDamping(0.65)
        .setLinearDamping(0.12)
    );
    const len = this.height * (1 - index / 5);
    physics.world.createCollider(
      R.ColliderDesc.capsule(Math.max(0.05, len * 0.46), this.radius * 0.8)
        .setTranslation(0, len * 0.49, 0)
        .setMass(Math.max(2, this.radius * this.radius * this.height * 120)),
      b
    );
    // Replace the intact collider with the surviving stump.
    this.releases[0]();
    if (this.fixed.numColliders()) physics.world.removeCollider(this.fixed.collider(0), true);
    const stump = (this.height * index) / 5;
    physics.world.createCollider(
      R.ColliderDesc.cylinder(stump * 0.5, this.radius).setTranslation(0, stump * 0.5, 0),
      this.fixed
    );
    for (let i = 0; i < 7; i++) {
      const tooth = new THREE.Mesh(
        new THREE.ConeGeometry(this.radius * 0.32, this.radius * (1 + (i % 3)), 4),
        this.exposed
      );
      tooth.position.set(Math.cos(i * 2.4) * this.radius * 0.61, stump, Math.sin(i * 2.4) * this.radius * 0.61);
      this.root.add(tooth);
    }
    // Carry the bend through the fracture. The crown can pivot on the stump
    // until it rolls off, then falls under Rapier gravity.
    const heading = Math.atan2(this.wind.z, this.wind.x + 0.01);
    b.setLinvel({ x: Math.cos(heading) * 0.75, y: 0.08, z: Math.sin(heading) * 0.75 }, true);
    b.setAngvel({ x: Math.sin(heading) * 1.5, y: 0.14, z: -Math.cos(heading) * 1.5 }, true);
    physics.bind(b, crown);
    this.fallen = b;
    this.crown = crown;
    this.stats.brokenAt = index;
    this.engine.events.emitAt('shatter', this.position, 1, 'tree');
  }
  update(dt: number, time: number): void {
    if (!(dt > 0)) return;
    const h = Math.min(dt, 1 / 30),
      limit = this.stats.brokenAt < 0 ? this.joints.length : this.stats.brokenAt;
    let peak = 0;
    for (let i = 0; i < limit; i++) {
      const joint = this.joints[i],
        k = i * 4;
      joint.getWorldPosition(this.position);
      this.position.y += this.height / 10;
      this.engine.wind.sample(this.position, time, this.wind);
      const spring = 25 - i * 2.2,
        scale = 0.00083 * (1 + i * 0.4),
        speed = Math.hypot(this.wind.x, this.wind.z);
      const tx = THREE.MathUtils.clamp(this.wind.z * speed * scale, -0.8, 0.8),
        tz = THREE.MathUtils.clamp(-this.wind.x * speed * scale, -0.8, 0.8);
      this.motion[k + 2] += ((tx - this.motion[k]) * spring - 4.2 * this.motion[k + 2]) * h;
      this.motion[k + 3] += ((tz - this.motion[k + 1]) * spring - 4.2 * this.motion[k + 3]) * h;
      joint.rotation.x = this.motion[k] += this.motion[k + 2] * h;
      joint.rotation.z = this.motion[k + 1] += this.motion[k + 3] * h;
      peak = Math.max(peak, Math.hypot(this.motion[k], this.motion[k + 1]));
    }
    for (let i = 0; i < this.limbs.length; i++)
      this.limbs[i].rotation.z =
        0.08 * Math.sin(time * 2.8 + this.limbsPhase[i]) * Math.min(1, this.wind.length() * 0.08);
    this.stats.peakStrain = peak;
    if (!this.fallen && peak > this.strength) this.snap(1);
  }
  dispose(): void {
    for (const off of this.releases) off();
    this.releases.length = 0;
    if (this.fallen) {
      this.engine.physics.unbind(this.fallen);
      this.engine.physics.world.removeRigidBody(this.fallen);
    }
    this.engine.physics.world.removeRigidBody(this.fixed);
    const geometries = new Set<THREE.BufferGeometry>();
    for (const group of [this.root, this.crown])
      if (group) {
        group.traverse((o) => {
          if (o instanceof THREE.Mesh) geometries.add(o.geometry);
        });
        group.removeFromParent();
      }
    for (const g of geometries) g.dispose();
    this.bark.dispose();
    this.foliage.dispose();
    this.exposed.dispose();
  }
}
