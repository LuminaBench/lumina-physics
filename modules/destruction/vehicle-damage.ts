import * as THREE from 'three/webgpu';
import { PaintWear } from './paint-wear';
import { TireSmoke } from '../wet-road/tire-smoke';
import { TSL, type N } from '../../engine/tsl';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { RigidBody } from '../../engine/physics';
import type { EffectsKit } from '../../engine/fx';

export class VehicleDamage implements EngineModule {
  readonly stats = { hits: 0, displacement: 0, glassDamage: 0, shattered: false, smoke: 0 };
  readonly paintWear: PaintWear | null;
  private readonly scuff = { lengthM: 0, widthM: 0, strength: 0, materialIndex: 0, reachM: 0.15 };
  private readonly stationary = new THREE.Vector3();
  private readonly attachments: { mesh: THREE.Mesh; original: THREE.BufferGeometry; owned: THREE.BufferGeometry | null }[] = [];
  private readonly trimToShell = new THREE.Matrix4();
  private readonly shellToTrim = new THREE.Matrix4();
  private readonly trimRest = new THREE.Vector3();
  private wornMaterials: THREE.Material | THREE.Material[] | null = null;
  private crackedWornMaterials: THREE.Material[] | null = null;
  private readonly original: THREE.BufferGeometry;
  private readonly shell: THREE.BufferGeometry;
  private readonly rest: Float32Array;
  private readonly oldMaterials: THREE.Material | THREE.Material[];
  private readonly cracked: THREE.MeshPhysicalNodeMaterial | null;
  private readonly damage = TSL.uniform(0);
  private readonly origin = TSL.uniform(new THREE.Vector3());
  private readonly glassU = TSL.uniform(new THREE.Vector3(1, 0, 0));
  private readonly glassV = TSL.uniform(new THREE.Vector3(0, 1, 0));
  private readonly paneNormal = new THREE.Vector3();
  private readonly contact = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly contactNormal = new THREE.Vector3();
  private readonly relativeVelocity = new THREE.Vector3();
  private readonly localSlide = new THREE.Vector3();
  private readonly inverseMesh = new THREE.Matrix4();
  private readonly inward = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly unregister: () => void;
  private fracturedMaterials: THREE.Material[] | null = null;
  private strikesAllowedAt = 0;
  private readonly debris: { body: RigidBody; mesh: THREE.Mesh }[] = [];
  private readonly shardMat = new THREE.MeshPhysicalNodeMaterial({
    color: 0x91bdc4,
    roughness: 0.13,
    metalness: 0.5,
    side: THREE.DoubleSide,
  });
  private readonly shardGeo = new THREE.TetrahedronGeometry(0.045);
  readonly tires: TireSmoke;
  private readonly bounds = new THREE.Box3();
  private readonly paneBounds = new THREE.Box3();
  private readonly glassTriangle = new THREE.Triangle();
  private readonly panePoint = new THREE.Vector3();

  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit,
    private body: RigidBody,
    private mesh: THREE.Mesh,
    private glassIndex = 1,
    paintIndex = 0
  ) {
    this.tires = new TireSmoke(fx);
    this.original = mesh.geometry;
    this.shell = this.original.clone();
    mesh.geometry = this.shell;
    const positions = this.shell.getAttribute('position');
    this.rest = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
      this.rest[3*i] = positions.getX(i); this.rest[3*i+1] = positions.getY(i); this.rest[3*i+2] = positions.getZ(i);
    }
    this.shell.computeBoundingBox();
    this.bounds.copy(this.shell.boundingBox!);
    this.bounds.getCenter(this.center);
    this.oldMaterials = mesh.material;
    this.cracked = null;
    if (Array.isArray(mesh.material) && mesh.material[glassIndex]) {
      const old = mesh.material[glassIndex] as THREE.MeshStandardMaterial | THREE.MeshPhysicalNodeMaterial;
      this.cracked = new THREE.MeshPhysicalNodeMaterial({
        color: old.color ?? 0x738e99,
        roughness: old.roughness ?? 0.1,
        metalness: old.metalness ?? 0.4,
        transparent: old.transparent,
        opacity: old.opacity,
        depthWrite: old.depthWrite,
        side: old.side,
        clearcoat: 1,
      });
      const d = TSL.positionGeometry.sub(this.origin);
      const u = TSL.dot(d, this.glassU), v = TSL.dot(d, this.glassV);
      const r = TSL.length(d), angle = TSL.atan(v, u);
      // Evaluate widths in metres on the struck pane. Integrate each narrow
      // fracture across the pixel so side windows and distant glass stay stable.
      const line = (distance: N, width: N) => {
        const pixel = TSL.fwidth(distance).max(0.00008);
        const lo = distance.sub(pixel.mul(0.5)).max(width.negate());
        const hi = distance.add(pixel.mul(0.5)).min(width);
        return hi.sub(lo).div(pixel).clamp(0, 1);
      };
      const crooked = angle.mul(3).add(r.mul(11)).sin().mul(0.31)
        .add(angle.mul(5).sub(r.mul(25)).cos().mul(0.11));
      const branch = angle.mul(6).add(crooked);
      const spokes = line(branch.sin().mul(r).div(6), TSL.float(0.00125));
      const radial = r.mul(49).add(branch.cos().mul(0.8)).add(angle.mul(4).sin());
      const arcs = line(radial.sin().div(49), TSL.float(0.0009)).mul(
        TSL.smoothstep(-0.26, 0.41, angle.mul(4).add(r.mul(19)).cos())
      );
      const radius = this.damage.mul(0.98).add(0.04);
      const chip = TSL.float(1).sub(TSL.smoothstep(0.002, 0.011, r));
      const crack = spokes.max(arcs).max(chip)
        .mul(TSL.smoothstep(radius, radius.mul(0.68), r))
        .mul(TSL.smoothstep(0.01, 0.12, this.damage));
      this.cracked.colorNode = TSL.mix(TSL.materialColor, TSL.vec3(0.72, 0.79, 0.78), crack);
      this.cracked.roughnessNode = TSL.mix(TSL.float(old.roughness ?? 0.12), TSL.float(0.71), crack);
      if (old.transparent) {
        const glazing = ('opacityNode' in old ? old.opacityNode : null) ?? TSL.float(old.opacity);
        this.cracked.opacityNode = TSL.mix(glazing, TSL.float(0.95), crack);
      }
      const mats = mesh.material.slice();
      mats[glassIndex] = this.cracked;
      this.fracturedMaterials = mats;
      for (const group of this.shell.groups)
        if (group.materialIndex === glassIndex)
          for (let j = group.start; j < group.start + group.count; j++)
            this.paneBounds.expandByPoint(
              this.point.fromBufferAttribute(positions, this.shell.index?.getX(j) ?? j)
            );
    }
    this.paintWear = null;
    this.scuff.materialIndex = paintIndex;
    const paint = Array.isArray(this.oldMaterials) ? this.oldMaterials[paintIndex] : paintIndex === 0 ? this.oldMaterials : null;
    if (paint && paintIndex !== glassIndex) {
      const source = engine.renderer.library.fromMaterial(paint) as THREE.MeshStandardNodeMaterial | null;
      if (source?.isMeshStandardNodeMaterial) {
        this.shell.setAttribute('wearRest', new THREE.BufferAttribute(this.rest, 3));
        if (!this.shell.hasAttribute('normal')) this.shell.computeVertexNormals();
        this.shell.setAttribute('wearRestNormal', this.shell.getAttribute('normal').clone());
        this.paintWear = new PaintWear(source, 'wearRest', 'wearRestNormal');
        if (Array.isArray(this.oldMaterials)) {
          this.wornMaterials = this.oldMaterials.slice();
          this.wornMaterials[paintIndex] = this.paintWear.material;
          if (this.fracturedMaterials) {
            this.crackedWornMaterials = this.fracturedMaterials.slice();
            this.crackedWornMaterials[paintIndex] = this.paintWear.material;
          }
        } else this.wornMaterials = this.paintWear.material;
      }
    }
    // Use the same bounded coat shader before and after contact. A first hit
    // then needs a uniform update rather than a new driver pipeline.
    if (this.wornMaterials) mesh.material = this.wornMaterials;
    const physics = engine.physics,
      collider = body.collider(0);
    this.unregister = physics.onContactForce(collider, 8500, (force, other) => {
      if (!other || this.engine.time < this.strikesAllowedAt) return;
      let found = false;
      physics.world.contactPair(collider, other, (manifold) => {
        if (found || !manifold.numSolverContacts()) return;
        found = !!manifold.solverContactPoint(0, this.contact);
        if (found) manifold.normal(this.contactNormal);
      });
      if (found) {
        this.strikesAllowedAt = engine.time + 0.18;
        body.velocityAtPoint(this.contact, this.relativeVelocity);
        const otherBody = other.parent();
        if (otherBody) {
          otherBody.velocityAtPoint(this.contact, this.velocity);
          this.relativeVelocity.sub(this.velocity);
        }
        this.impact(this.contact, Math.min(1, force / 95000), this.contactNormal, this.relativeVelocity);
      }
    });
  }
  /** Register a rigid piece attached to the vehicle, including material-batched trim.
   * Geometry is copied only on first deformation. Repair restores the original. */
  attachTrim(mesh: THREE.Mesh): void {
    if (mesh !== this.mesh && !this.attachments.some(piece => piece.mesh === mesh))
      this.attachments.push({ mesh, original: mesh.geometry, owned: null });
  }

  private displacement(x: number, y: number, z: number, radiusSquared: number, stretch: number, depth: number): number {
    const dx = x - this.local.x, dy = y - this.local.y, dz = z - this.local.z;
    const along = dx * this.localSlide.x + dy * this.localSlide.y + dz * this.localSlide.z;
    const f = 1 - (dx * dx + dy * dy + dz * dz - along * along * stretch) / radiusSquared;
    return f > 0 ? f * f * depth * (0.34 + 0.065 * Math.cos(dx * 28 + dz * 15)) : 0;
  }

  private dentTrim(radiusSquared: number, stretch: number, depth: number): void {
    this.inverseMesh.copy(this.mesh.matrixWorld).invert();
    for (const piece of this.attachments) {
      piece.mesh.updateWorldMatrix(true, false);
      this.trimToShell.multiplyMatrices(this.inverseMesh, piece.mesh.matrixWorld);
      this.shellToTrim.copy(this.trimToShell).invert();
      const rest = piece.original.getAttribute('position');
      let changed = false;
      for (let i = 0; i < rest.count; i++) {
        const p = this.trimRest.fromBufferAttribute(rest, i).applyMatrix4(this.trimToShell);
        const d = this.displacement(p.x, p.y, p.z, radiusSquared, stretch, depth);
        if (!d) continue;
        if (!piece.owned) piece.mesh.geometry = piece.owned = piece.original.clone();
        const out = piece.owned.getAttribute('position');
        this.point.fromBufferAttribute(out, i).applyMatrix4(this.trimToShell).addScaledVector(this.inward, d);
        this.point.sub(p).clampLength(0, 0.62).add(p).applyMatrix4(this.shellToTrim);
        out.setXYZ(i, this.point.x, this.point.y, this.point.z);
        changed = true;
      }
      if (changed && piece.owned) {
        piece.owned.getAttribute('position').needsUpdate = true;
        piece.owned.computeVertexNormals(); piece.owned.computeBoundingBox(); piece.owned.computeBoundingSphere();
      }
    }
  }

  /** A collision normal sets the crush direction. Tangential motion lengthens a grazing scrape. */
  impact(worldPoint: THREE.Vector3, intensity: number, worldNormal?: THREE.Vector3, relativeVelocity?: THREE.Vector3): void {
    if (!(intensity > 0)) return;
    const level = Math.min(1, intensity);
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.worldToLocal(this.local.copy(worldPoint));
    this.bounds.clampPoint(this.local, this.local);
    this.inward.subVectors(this.center, this.local);
    this.inward.y *= 0.54;
    this.inward.normalize();
    let graze = 0;
    if (worldNormal && worldNormal.lengthSq() > 1e-8) {
      this.inverseMesh.copy(this.mesh.matrixWorld).invert();
      this.point.copy(worldNormal).transformDirection(this.inverseMesh);
      if (this.point.dot(this.inward) < 0) this.point.negate();
      this.inward.copy(this.point);
      if (relativeVelocity && relativeVelocity.lengthSq() > 1) {
        this.localSlide.copy(relativeVelocity).transformDirection(this.inverseMesh);
        const incidence = this.localSlide.dot(this.inward);
        this.localSlide.addScaledVector(this.inward, -incidence).normalize();
        graze = (1 - Math.abs(incidence)) * THREE.MathUtils.smoothstep(relativeVelocity.length(), 1, 7);
      }
    }
    if (this.paintWear) {
      const slide = relativeVelocity ?? this.stationary;
      this.scuff.lengthM = 0.08 + level * 0.18 + graze * (0.32 + Math.min(slide.length(), 32) * 0.041);
      this.scuff.widthM = 0.025 + level * 0.12;
      this.scuff.strength = level * (0.78 + 0.22 * graze);
      if (this.paintWear.stamp(this.mesh, worldPoint, slide, this.scuff))
        this.mesh.material = (this.stats.glassDamage > 0 ? this.crackedWornMaterials : this.wornMaterials) ?? this.mesh.material;
    }
    const stretch = 1 - 1 / ((1 + graze) ** 2);
    const r = 0.36 + 0.84 * level,
      a = this.shell.getAttribute('position');
    const depth = level * (1 - 0.66 * graze), radiusSquared = r * r;
    for (let i = 0; i < a.count; i++) {
      const k = i * 3;
      const d = this.displacement(this.rest[k], this.rest[k + 1], this.rest[k + 2], radiusSquared, stretch, depth);
      if (!d) continue;
      this.point.fromBufferAttribute(a, i).addScaledVector(this.inward, d);
      this.velocity.set(this.rest[k], this.rest[k + 1], this.rest[k + 2]);
      this.point.sub(this.velocity).clampLength(0, 0.62);
      this.stats.displacement = Math.max(this.stats.displacement, this.point.length());
      this.point.add(this.velocity);
      a.setXYZ(i, this.point.x, this.point.y, this.point.z);
    }
    a.needsUpdate = true;
    this.shell.computeVertexNormals();
    this.shell.computeBoundingSphere();
    this.dentTrim(radiusSquared, stretch, depth);
    this.stats.hits++;
    if (this.cracked && !this.stats.shattered && !this.paneBounds.isEmpty()) {
      let closest = Infinity;
      for (const group of this.shell.groups) {
        if (group.materialIndex !== this.glassIndex) continue;
        const index = this.shell.index,
          tri = this.glassTriangle;
        for (let i = group.start; i < group.start + group.count; i += 3) {
          tri.a.fromBufferAttribute(a, index?.getX(i) ?? i);
          tri.b.fromBufferAttribute(a, index?.getX(i + 1) ?? i + 1);
          tri.c.fromBufferAttribute(a, index?.getX(i + 2) ?? i + 2);
          tri.closestPointToPoint(this.local, this.panePoint);
          const distance = this.panePoint.distanceToSquared(this.local);
          if (distance < closest) {
            closest = distance;
            this.point.copy(this.panePoint);
            tri.getNormal(this.paneNormal);
          }
        }
      }
      const separation = Math.sqrt(closest);
      const direct = 1 - THREE.MathUtils.smoothstep(separation, 0.05, 0.18);
      const transfer = 1 - graze * (1 - direct);
      const glassLoad = level * Math.max(0, 1 - separation / 0.82) * transfer;
      if (glassLoad > 0.035) {
        this.mesh.material = this.crackedWornMaterials ?? this.fracturedMaterials!;
        if (this.stats.glassDamage === 0) {
          this.origin.value.copy(this.point);
          const n = this.paneNormal, tangent = this.glassU.value;
          if (Math.abs(n.x) < 0.8) tangent.set(1,0,0); else tangent.set(0,0,1);
          tangent.addScaledVector(n, -tangent.dot(n)).normalize();
          this.glassV.value.crossVectors(n, tangent);
        }
        this.stats.glassDamage = Math.min(1, this.stats.glassDamage + glassLoad);
        this.damage.value = this.stats.glassDamage;
        if (this.damage.value >= 0.97) this.shatter();
      }
    }
  }
  private shatter(): void {
    this.stats.shattered = true;
    const physics = this.engine.physics,
      R = physics.RAPIER;
    for (const g of this.shell.groups) if (g.materialIndex === this.glassIndex) g.count = 0;
    this.mesh.localToWorld(this.point.copy(this.origin.value));
    this.body.linvel(this.velocity);
    for (let i = 0; i < 16; i++) {
      const a = i * 2.39996,
        mag = 0.55 + (i % 3);
      const b = physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(
            this.point.x + Math.cos(a) * 0.18,
            this.point.y + 0.015 * i,
            this.point.z + Math.sin(a) * 0.18
          )
          .setLinvel(
            this.velocity.x + Math.cos(a) * mag,
            this.velocity.y + 0.7 + 0.075 * i,
            this.velocity.z + Math.sin(a) * mag
          )
      );
      physics.world.createCollider(R.ColliderDesc.ball(0.026).setMass(0.015), b);
      const mesh = new THREE.Mesh(this.shardGeo, this.shardMat);
      mesh.scale.set(1.0, 0.32, 0.64 + (i % 4) * 0.13);
      this.engine.scene.add(mesh);
      physics.bind(b, mesh);
      this.debris.push({ body: b, mesh });
    }
    this.engine.events.emitAt('shatter', this.point, 1, 'glass');
  }
  tireSmoke(wheel: THREE.Vector3, slip: number, wet: number, dt: number, side: number): void {
    this.tireContact(side, wheel, 3200, Math.max(0, slip - 0.12) * 14, wet, dt);
  }

  tireContact(i: number, point: THREE.Vector3, load: number, slipSpeed: number, wet: number, dt: number, velocity?: THREE.Vector3): void {
    this.tires.updateWheel(i, point, load, slipSpeed, wet, dt, velocity);
    this.stats.smoke = this.tires.emitted;
  }
  /** Restore the owned geometry and remove the spawned glass bodies. */
  repair(): void {
    const p = this.shell.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setXYZ(i, this.rest[3*i], this.rest[3*i+1], this.rest[3*i+2]);
    p.needsUpdate = true;
    const originalNormal = this.original.getAttribute('normal'), normal = this.shell.getAttribute('normal');
    if (originalNormal && normal) {
      for (let i = 0; i < normal.count; i++) normal.setXYZ(i, originalNormal.getX(i), originalNormal.getY(i), originalNormal.getZ(i));
      normal.needsUpdate = true;
    } else this.shell.computeVertexNormals();
    this.shell.computeBoundingBox(); this.shell.computeBoundingSphere();
    for (let i = 0; i < this.shell.groups.length; i++)
      this.shell.groups[i].count = this.original.groups[i].count;
    this.mesh.material = this.wornMaterials ?? this.oldMaterials;
    for (const piece of this.attachments) {
      if (!piece.owned) continue;
      piece.mesh.geometry = piece.original;
      piece.owned.dispose(); piece.owned = null;
    }
    this.paintWear?.clear();
    this.damage.value = 0;
    this.stats.glassDamage = this.stats.displacement = 0;
    this.stats.shattered = false;
    for (const d of this.debris) {
      this.engine.physics.unbind(d.body);
      this.engine.physics.world.removeRigidBody(d.body);
      d.mesh.removeFromParent();
    }
    this.debris.length = 0;
  }
  dispose(): void {
    this.unregister();
    this.repair();
    this.mesh.geometry = this.original;
    this.mesh.material = this.oldMaterials;
    this.shell.dispose();
    this.paintWear?.dispose();
    this.cracked?.dispose();
    this.shardGeo.dispose();
    this.shardMat.dispose();
  }
}
