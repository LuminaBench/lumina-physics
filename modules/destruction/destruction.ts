/**
 * Destruction: pre-fractured concrete, glass, wood and brick that break into Rapier bodies.
 *
 *   const destruction = engine.add(new DestructionSystem(engine, fx, { ocean }));
 *   const wall = destruction.add({ material: 'concrete', size: new THREE.Vector3(4, 2.4, 0.35), position });
 *   wall.impact(point, direction, 40_000);        // joules
 *
 * A destructible is one mesh and one draw call for its whole life: every vertex carries its
 * chunk index and is placed by that chunk's matrix, read from a small float texture. While
 * intact the chunks share one fixed collider. Damage loosens chunks near the hit into
 * dynamic convex-hull bodies with real mass (volume × density); a connectivity search from
 * the anchored chunks then drops whatever is no longer held up. Blasts from
 * `PhysicsWorld.applyBlast` and hard contacts (debris, vehicles) arrive on their own.
 */
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import { FieldReading } from '../../engine/world-bus';
import { perturbNormalHeight } from '../../engine/shading';
import { valueNoise3, hash12, spriteNoise } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from '../water/ocean';
import { BRICK_JOINT_M, DENSITY, fractureBox, type Cell, type FractureMaterial } from './fracture';

const { attribute, textureLoad, ivec2, int, mat4, vec2, vec3, vec4, float, normalize, cameraViewMatrix, mix, smoothstep, abs, dot, max, pow, positionViewDirection } = TSL;

const INTACT = 0, LOOSE = 1, GONE = 2;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Vector3();
const _q2 = new THREE.Quaternion();

export interface DestructibleOptions {
  material: FractureMaterial;
  /** Box dimensions in metres. */
  size: THREE.Vector3;
  /** Centre of the box, world space. */
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  /** Approximate number of chunks (ignored for brick, which is laid in courses). */
  pieces?: number;
  /**
   * Which chunks are held by the world: 'bottom' (a wall on the ground), 'frame' (a pane in
   * its frame: every chunk touching the outline), 'none' (a free-standing prop that falls
   * apart completely).
   */
  anchor?: 'bottom' | 'frame' | 'none';
  /** Multiplier on the energy needed to break it. */
  toughness?: number;
  seed?: number;
  color?: THREE.ColorRepresentation;
}

/** Joules per m³ of material turned into loose chunks. */
const FRACTURE_ENERGY: Record<FractureMaterial, number> = { concrete: 240_000, glass: 2_500, wood: 60_000, brick: 110_000 };
/** Contact force (N) that starts breaking an intact object. */
const CONTACT_THRESHOLD: Record<FractureMaterial, number> = { concrete: 420_000, glass: 2_600, wood: 60_000, brick: 160_000 };

interface Loose {
  body: RAPIER.RigidBody;
  previousPosition: THREE.Vector3; previousRotation: THREE.Quaternion;
  age: number; life: number; wet: boolean;
}

/** A fixed pool of cosmetic chips in the original box coordinates. */
class SurfaceChips {
  readonly slots = Array.from({ length: 8 }, () => new THREE.Vector4());
  readonly centers = TSL.uniformArray(this.slots, 'vec4');
  readonly faces = TSL.uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4()), 'vec4');
  readonly count = TSL.uniform(0, 'int');
  private readonly strokes = TSL.uniformArray(Array.from({length:8}, () => new THREE.Vector4(0, 0, 0, 0)), 'vec4');
  private readonly strokeCount = TSL.uniform(0, 'int');
  private next = 0;

  clear(): void {
    this.count.value = this.strokeCount.value = this.next = 0;
    for (const stroke of this.strokes.array) stroke.set(0, 0, 0, 0);
  }

  stampBox(local: THREE.Vector3, size: THREE.Vector3, radius: number, slide?: THREE.Vector3): boolean {
    if (!(radius > 0 && Number.isFinite(radius + local.x + local.y + local.z))) return false;
    const dx = Math.abs(local.x) - size.x * 0.5;
    const dy = Math.abs(local.y) - size.y * 0.5;
    const dz = Math.abs(local.z) - size.z * 0.5;
    const distance = Math.max(dx, dy, dz);
    if (Math.abs(distance) > radius * 0.5) return false;
    // The caller supplies a scratch point. Snap it to the intact exterior.
    const axis = distance === dx ? 'x' : distance === dy ? 'y' : 'z';
    const normal = this.boxNormal.set(0, 0, 0);
    normal[axis] = Math.sign(local[axis]);
    local[axis] = normal[axis] * size[axis] * 0.5;
    return this.stampFace(local, normal, radius, -1, slide);
  }
  private readonly boxNormal = new THREE.Vector3();

  stampFace(local: THREE.Vector3, normal: THREE.Vector3, radius: number, owner: number, slide?: THREE.Vector3): boolean {
    const stroke = this.strokes.array[this.next];
    if (stroke.w > 0) this.strokeCount.value--;
    stroke.set(0, 0, 0, 0);
    if (slide) {
      const alongNormal = slide.dot(normal);
      const x = slide.x - normal.x * alongNormal, y = slide.y - normal.y * alongNormal, z = slide.z - normal.z * alongNormal;
      const lengthSq = x*x + y*y + z*z;
      if (lengthSq > 1e-10) {
        stroke.set(x, y, z, 1/lengthSq);
        this.strokeCount.value++;
      }
    }
    this.slots[this.next].set(local.x, local.y, local.z, radius);
    this.faces.array[this.next].set(normal.x, normal.y, normal.z, owner);
    this.next = (this.next + 1) % this.slots.length;
    this.count.value = Math.min(this.slots.length, this.count.value + 1);
    return true;
  }

  sample(rest: N, inner: N, chunk: N, wood: boolean): N {
    const normal = attribute('normal', 'vec3').toVarying('chipRestNormal');
    return TSL.Fn(() => {
      // Coverage, stone/fibre variation, cavity shade and signed relief in metres.
      const result = vec4(0).toVar();
      TSL.If(this.count.greaterThan(0), () => {
        TSL.Loop({ start: int(0), end: this.count, type: 'int', condition: '<' }, ({ i }: N) => {
          const stamp = this.centers.element(i), face = this.faces.element(i);
          const delta = rest.sub(stamp.xyz);
          const fromStroke = delta.toVar();
          TSL.If(this.strokeCount.greaterThan(0), () => {
            const stroke = this.strokes.element(i);
            const along = dot(delta, stroke.xyz).mul(stroke.w).saturate();
            fromStroke.subAssign(stroke.xyz.mul(along));
          });
          const radial = TSL.length(wood ? fromStroke.mul(vec3(0.64, 1.36, 1.36)) : fromStroke).div(stamp.w);
          TSL.If(radial.lessThan(1.26).and(dot(normal, face.xyz).greaterThan(0.96))
            .and(abs(dot(delta, face.xyz)).lessThan(0.0045))
            .and(face.w.lessThan(0).and(inner.lessThan(0.5)).or(abs(face.w.sub(chunk)).lessThan(0.1))), () => {
            const uv = vec2(rest.x.add(rest.z.mul(0.81)), rest.y.add(rest.z.mul(0.57)));
            const jagged = spriteNoise(uv.mul(wood ? vec2(32, 142) : vec2(68)), 1);
            const oblique = vec2(uv.x.mul(0.81).sub(uv.y.mul(0.59)), uv.y.mul(0.81).add(uv.x.mul(0.59)));
            const grain = wood ? spriteNoise(uv.mul(vec2(54, 210)), 0) :
              spriteNoise(oblique.mul(109).add(jagged.mul(1.7)), 0).mul(0.7).add(spriteNoise(uv.mul(183), 1).mul(0.3));
            const r = radial.add(jagged.sub(0.5).mul(0.48)).add(grain.sub(0.5).mul(0.09));
            const cover = smoothstep(0.76, 1.08, r).oneMinus();
            const bowl = smoothstep(0.16, 0.90, r).oneMinus();
            const rim = smoothstep(0.61, 0.85, r).mul(smoothstep(0.85, 1.11, r).oneMinus());
            const aggregate = smoothstep(0.40, 0.70, grain);
            const height = rim.mul(0.037).sub(bowl.mul(wood ? 0.12 : 0.195))
              .add(aggregate.sub(0.5).mul(cover).mul(0.042)).mul(stamp.w);
            TSL.If(cover.greaterThan(result.x).or(height.lessThan(result.w)), () => {
              result.assign(vec4(cover, aggregate, bowl, height));
            });
          });
        });
      });
      return result;
    })().toVar();
  }
}

export class Destructible {
  readonly material: FractureMaterial;
  readonly size: THREE.Vector3;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  mesh!: THREE.Mesh;
  cells: Cell[] = [];
  /** Per chunk: 0 intact, 1 loose (a rigid body), 2 gone. */
  state!: Uint8Array;
  /** Number of chunks that have broken off so far. */
  broken = 0;
  /** Called whenever chunks break off. */
  onBreak: ((count: number, point: THREE.Vector3) => void) | null = null;

  private readonly chips: SurfaceChips | null;
  private anchored!: Uint8Array;
  private loose = new Map<number, Loose>();
  private matrices!: Float32Array;
  private texture!: THREE.DataTexture;
  private fixedBody: RAPIER.RigidBody;
  private intactCollider: RAPIER.Collider | null = null;
  private chunkColliders: Array<RAPIER.Collider | null> = [];
  private readonly markTriangle = new THREE.Triangle();
  private readonly markPoint = new THREE.Vector3();
  private readonly markNearest = new THREE.Vector3();
  private readonly markClosest = new THREE.Vector3();
  private readonly markNormal = new THREE.Vector3();
  private readonly markSlide = new THREE.Vector3();
  private readonly markRotation = new THREE.Quaternion();
  private worldMatrix = new THREE.Matrix4();
  private inverse = new THREE.Matrix4();
  private unwatch: (() => void) | null = null;
  private pendingContact = 0;
  private readonly contactFields = new FieldReading();
  private refractured = false;

  constructor(private system: DestructionSystem, readonly options: DestructibleOptions) {
    this.material = options.material;
    this.chips = this.material === 'glass' ? null : new SurfaceChips();
    this.size = options.size.clone();
    this.position = options.position.clone();
    this.quaternion = options.quaternion?.clone() ?? new THREE.Quaternion();
    this.worldMatrix.compose(this.position, this.quaternion, _one);
    this.inverse.copy(this.worldMatrix).invert();
    const { physics } = system.engine;
    const R = physics.RAPIER;
    this.fixedBody = physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(this.position.x, this.position.y, this.position.z).setRotation(this.quaternion));
    this.intactCollider = physics.world.createCollider(R.ColliderDesc.cuboid(this.size.x / 2, this.size.y / 2, this.size.z / 2).setFriction(0.8), this.fixedBody);
    // Something heavy or fast hitting the intact object starts the break.
    const threshold = CONTACT_THRESHOLD[this.material] * (options.toughness ?? 1);
    this.unwatch = physics.onContactForce(this.intactCollider, threshold, (force, other) => {
      const body = other?.parent();
      if (!body) return;
      const t = body.translation(), v = body.linvel();
      this.pendingContact = Math.max(this.pendingContact, force);
      this.contactPoint.set(t.x, t.y, t.z);
      this.contactDirection.set(v.x, v.y, v.z);
      this.contactEnergy = 0.5 * body.mass() * (v.x * v.x + v.y * v.y + v.z * v.z);
    });
    this.fracture(null);
  }
  private contactPoint = new THREE.Vector3();
  private contactDirection = new THREE.Vector3();
  private contactEnergy = 0;

  get chunkCount(): number { return this.cells.length; }
  get looseCount(): number { return this.loose.size; }
  /** True once nothing is left standing. */
  get destroyed(): boolean { return this.broken >= this.cells.length; }

  // ---- fracture + mesh -----------------------------------------------------------

  private fracture(focusLocal: THREE.Vector3 | null): void {
    const o = this.options;
    const budget = this.system.chunkBudget;
    const pieces = Math.min(o.pieces ?? (this.material === 'glass' ? 44 : this.material === 'wood' ? 12 : 28), budget);
    this.cells = fractureBox({ size: this.size, material: this.material, pieces, focus: focusLocal ?? undefined, seed: o.seed ?? 11 });
    const count = this.cells.length;
    this.state = new Uint8Array(count);
    this.anchored = new Uint8Array(count);
    this.chunkColliders = new Array(count).fill(null);
    const anchor = o.anchor ?? (this.material === 'glass' ? 'frame' : 'bottom');
    const half = this.size.clone().multiplyScalar(0.5);
    const thin = half.x <= half.y && half.x <= half.z ? 0 : half.y <= half.z ? 1 : 2;
    this.cells.forEach((cell, i) => {
      let held = false;
      for (const f of cell.faces) for (const p of f.points) {
        if (anchor === 'bottom' && p.y < -half.y + 0.012) held = true;
        if (anchor === 'frame') for (let axis = 0; axis < 3; axis++) if (axis !== thin && Math.abs(Math.abs(p.getComponent(axis)) - half.getComponent(axis)) < 0.004) held = true;
      }
      this.anchored[i] = held ? 1 : 0;
    });

    // One merged geometry; vertices are stored relative to their chunk's centroid.
    const position: number[] = [], normal: number[] = [], rest: number[] = [], chunk: number[] = [], inner: number[] = [];
    this.cells.forEach((cell, i) => {
      for (const f of cell.faces) {
        const flip = f.normal.dot(_v.copy(f.points[0]).sub(cell.centroid)) < 0 ? -1 : 1;
        const n = _w.copy(f.normal).multiplyScalar(flip);
        for (let k = 1; k + 1 < f.points.length; k++) {
          const tri = [f.points[0], f.points[k], f.points[k + 1]];
          // Wind counter-clockwise about the outward normal.
          const ccw = _v.subVectors(tri[1], tri[0]).cross(_e.subVectors(tri[2], tri[0])).dot(n) >= 0;
          for (const p of ccw ? tri : [tri[0], tri[2], tri[1]]) {
            position.push(p.x - cell.centroid.x, p.y - cell.centroid.y, p.z - cell.centroid.z);
            rest.push(p.x, p.y, p.z);
            normal.push(n.x, n.y, n.z);
            chunk.push(i);
            inner.push(f.neighbour === -1 ? 0 : 1);
          }
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute('rest', new THREE.Float32BufferAttribute(rest, 3));
    geometry.setAttribute('chunk', new THREE.Float32BufferAttribute(chunk, 1));
    geometry.setAttribute('inner', new THREE.Float32BufferAttribute(inner, 1));
    geometry.boundingSphere = new THREE.Sphere(this.position.clone(), 1e5);

    // Chunk matrices: 8 texels per row = current mat4 + previous-frame mat4.
    this.matrices = new Float32Array(count * 8 * 4);
    this.texture?.dispose();
    this.texture = new THREE.DataTexture(this.matrices, 8, count, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    for (let i = 0; i < count; i++) {
      _m.makeTranslation(this.cells[i].centroid.x, this.cells[i].centroid.y, this.cells[i].centroid.z).premultiply(this.worldMatrix);
      _m.toArray(this.matrices, i * 32);
      _m.toArray(this.matrices, i * 32 + 16);
      this.matrices[i * 32 + 15] = this.matrices[i * 32 + 31] = 0; // intact in both frames
    }
    this.texture.needsUpdate = true;

    const old = this.mesh;
    this.mesh = new THREE.Mesh(geometry, createMaterial(this.material, this.texture, this.chips, this.options));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = `lumina-destructible:${this.material}`;
    if (this.material === 'glass') { this.mesh.renderOrder = 12; this.mesh.castShadow = false; }
    this.system.engine.scene.add(this.mesh);
    if (old) { old.removeFromParent(); old.geometry.dispose(); (old.material as THREE.Material).dispose(); }
  }

  // ---- damage ---------------------------------------------------------------------

  /** Paint a small chip at a world-space surface contact. Radius is visual, in metres. */
  markSurface(point: THREE.Vector3, radius = 0.04, chunkIndex?: number): boolean {
    return this.markContact(point, radius, chunkIndex);
  }

  /** Sweep one cosmetic chip along the contacted face. Give both world positions in the same body pose. */
  markScrape(from: THREE.Vector3, to: THREE.Vector3, radius = 0.025, chunkIndex?: number): boolean {
    const slide = this.markSlide.subVectors(to, from);
    if (!Number.isFinite(slide.lengthSq())) return false;
    return this.markContact(from, radius, chunkIndex, slide);
  }

  private markContact(point: THREE.Vector3, radius: number, chunkIndex?: number, slide?: THREE.Vector3): boolean {
    if (!this.chips || !(radius > 0 && Number.isFinite(radius))) return false;
    if (!this.broken && chunkIndex === undefined) {
      if (slide) slide.applyQuaternion(this.markRotation.copy(this.quaternion).invert());
      return this.chips.stampBox(this.markPoint.copy(point).applyMatrix4(this.inverse), this.size, radius, slide);
    }
    if (chunkIndex !== undefined && (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this.cells.length)) return false;
    let best = radius * radius * 0.25, owner = -1;
    const first = chunkIndex ?? 0, end = chunkIndex === undefined ? this.cells.length : chunkIndex + 1;
    const tri = this.markTriangle;
    for (let i = first; i < end; i++) {
      if (this.state[i] === GONE) continue;
      const cell = this.cells[i], moving = this.loose.get(i);
      if (moving) {
        moving.body.translation(this.markClosest); moving.body.rotation(this.markRotation);
        this.markPoint.copy(point).sub(this.markClosest).applyQuaternion(this.markRotation.invert()).add(cell.centroid);
      } else this.markPoint.copy(point).applyMatrix4(this.inverse);
      if (this.markPoint.distanceToSquared(cell.centroid) > (cell.radius + radius * 0.5) ** 2) continue;
      for (const face of cell.faces) {
        if (!moving && face.neighbour !== -1 && this.state[face.neighbour] === INTACT) continue;
        tri.a.copy(face.points[0]);
        for (let k = 1; k + 1 < face.points.length; k++) {
          tri.b.copy(face.points[k]); tri.c.copy(face.points[k + 1]);
          tri.closestPointToPoint(this.markPoint, this.markClosest);
          const d = this.markClosest.distanceToSquared(this.markPoint);
          if (d <= best) {
            best = d; owner = i; this.markNearest.copy(this.markClosest);
            this.markNormal.copy(face.normal);
            if (this.markClosest.sub(cell.centroid).dot(this.markNormal) < 0) this.markNormal.negate();
          }
        }
      }
    }
    if (owner < 0) return false;
    if (slide) {
      const moving = this.loose.get(owner);
      if (moving) moving.body.rotation(this.markRotation);
      else this.markRotation.copy(this.quaternion);
      slide.applyQuaternion(this.markRotation.invert());
    }
    return this.chips.stampFace(this.markNearest, this.markNormal, radius, owner, slide);
  }

  clearSurfaceMarks(): void { this.chips?.clear(); }

  get surfaceMarkCount(): number { return this.chips?.count.value ?? 0; }

  /**
   * Hit the object at a world point. `energy` is the kinetic energy delivered in joules
   * (½mv²): a 9 mm round ≈ 500 J, a thrown brick ≈ 300 J, a car at 50 km/h ≈ 150 kJ.
   */
  impact(point: THREE.Vector3, direction: THREE.Vector3, energy: number): number {
    const local = _v.copy(point).applyMatrix4(this.inverse).clone();
    if (energy > 0) this.markSurface(point, 0.046);
    const toughness = this.options.toughness ?? 1;
    // Glass re-fractures around the first hit so the cracks radiate from the bullet hole.
    if (this.material === 'glass' && !this.refractured && this.broken === 0) {
      if (energy < 60 * toughness) return 0;
      this.refractured = true;
      this.fracture(local.clone().clamp(this.size.clone().multiplyScalar(-0.5), this.size.clone().multiplyScalar(0.5)));
    }
    // Volume that this much energy can break, as a sphere around the hit.
    const volume = energy / (FRACTURE_ENERGY[this.material] * toughness);
    let radius = Math.cbrt((volume * 3) / (4 * Math.PI));
    if (this.material === 'glass') radius = Math.max(radius * 6, energy > 400 * toughness ? 10 : 0.35);
    const dir = _w.copy(direction).normalize().clone();
    const picked: number[] = [];
    this.cells.forEach((cell, i) => {
      if (this.state[i] !== INTACT) return;
      if (cell.centroid.distanceTo(local) - cell.radius * 0.5 < radius) picked.push(i);
    });
    if (!picked.length) return 0;
    const speed = Math.min(14, Math.sqrt((2 * energy * 0.25) / Math.max(1, picked.reduce((s, i) => s + this.cells[i].volume, 0) * DENSITY[this.material])));
    for (const i of picked) {
      const out = _v.copy(this.cells[i].centroid).sub(local).applyQuaternion(this.quaternion).normalize();
      this.loosen(i, out.multiplyScalar(speed * 0.35).addScaledVector(dir, speed));
    }
    const fallen = this.collapse();
    this.announce(picked.length + fallen, point, Math.min(1, energy / (FRACTURE_ENERGY[this.material] * 0.2)));
    return picked.length + fallen;
  }

  /** Pressure wave: loosens the chunks it can overcome and throws them outward. */
  blast(center: THREE.Vector3, radius: number, impulse: number): number {
    const local = _v.copy(center).applyMatrix4(this.inverse).clone();
    const reach = radius * (this.material === 'glass' ? 1.4 : this.material === 'concrete' ? 0.42 : 0.6);
    const nearest = Math.max(0, Math.max(Math.abs(local.x) - this.size.x / 2, Math.abs(local.y) - this.size.y / 2, Math.abs(local.z) - this.size.z / 2));
    if (nearest > reach) return 0;
    if (this.material === 'glass' && !this.refractured && this.broken === 0) {
      this.refractured = true;
      this.fracture(local.clone().clamp(this.size.clone().multiplyScalar(-0.5), this.size.clone().multiplyScalar(0.5)));
    }
    const strength = (impulse / 2600) / (this.options.toughness ?? 1);
    const picked: number[] = [];
    this.cells.forEach((cell, i) => {
      if (this.state[i] !== INTACT) return;
      const d = cell.centroid.distanceTo(local);
      const fall = Math.max(0, 1 - d / reach);
      if (fall * fall * strength > (this.material === 'glass' ? 0.02 : this.material === 'concrete' ? 0.5 : 0.25)) picked.push(i);
    });
    for (const i of picked) this.loosen(i, _v.set(0, 0, 0));       // the physics blast that follows throws them
    const fallen = picked.length ? this.collapse() : 0;
    if (picked.length) this.announce(picked.length + fallen, this.position, 1);
    return picked.length + fallen;
  }

  /** Break everything that is still standing (demolition, scripted events). */
  shatter(velocity = new THREE.Vector3()): void {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.state[i] === INTACT) { this.loosen(i, velocity); n++; }
    if (n) this.announce(n, this.position, 1);
  }

  /** Drop every intact chunk that is no longer connected to an anchored one. */
  private collapse(): number {
    const supported = new Uint8Array(this.cells.length);
    const queue: number[] = [];
    for (let i = 0; i < this.cells.length; i++) if (this.state[i] === INTACT && this.anchored[i]) { supported[i] = 1; queue.push(i); }
    while (queue.length) {
      const i = queue.pop()!;
      for (const j of this.cells[i].neighbours) if (!supported[j] && this.state[j] === INTACT) { supported[j] = 1; queue.push(j); }
    }
    let fallen = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.state[i] === INTACT && !supported[i]) { this.loosen(i, _v.set(0, 0, 0)); fallen++; }
    return fallen;
  }

  private loosen(index: number, velocity: THREE.Vector3): void {
    if (this.state[index] !== INTACT) return;
    const { physics } = this.system.engine;
    const R = physics.RAPIER;
    this.ensureChunkColliders();
    const collider = this.chunkColliders[index];
    if (collider) { physics.world.removeCollider(collider, false); this.chunkColliders[index] = null; }
    const cell = this.cells[index];
    this.broken++;
    if (!this.system.claim(this)) { this.state[index] = GONE; this.hide(index); return; }
    this.state[index] = LOOSE;
    const world = _w.copy(cell.centroid).applyMatrix4(this.worldMatrix);
    const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(world.x, world.y, world.z).setRotation(this.quaternion)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setAngvel({ x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 5, z: (Math.random() - 0.5) * 5 })
      .setLinearDamping(0.04).setAngularDamping(0.25));
    const hull = this.hull(cell);
    const desc = (hull && R.ColliderDesc.convexHull(hull)) ?? R.ColliderDesc.ball(Math.max(cell.radius * 0.6, 0.02));
    physics.world.createCollider(desc.setDensity(DENSITY[this.material]).setFriction(this.material === 'glass' ? 0.35 : 0.8).setRestitution(this.material === 'glass' ? 0.12 : 0.08), body);
    // Small fragments are cleaned up sooner; large blocks stay as scenery.
    const life = cell.volume < 0.004 ? 7 + Math.random() * 5 : cell.volume < 0.05 ? 18 + Math.random() * 10 : 1e9;
    this.loose.set(index, { body, previousPosition: world.clone(), previousRotation: this.quaternion.clone(), age: 0, life, wet: false });
    this.matrices[index * 32 + 15] = 1;
    this.texture.needsUpdate = true;
  }

  private hull(cell: Cell): Float32Array | null {
    const points: number[] = [];
    for (const f of cell.faces) for (const p of f.points) points.push(p.x - cell.centroid.x, p.y - cell.centroid.y, p.z - cell.centroid.z);
    return points.length >= 12 ? new Float32Array(points) : null;
  }

  /** After the first damage the single box collider is replaced by one hull per standing chunk. */
  private ensureChunkColliders(): void {
    if (!this.intactCollider) return;
    const { physics } = this.system.engine;
    const R = physics.RAPIER;
    this.unwatch?.();
    this.unwatch = null;
    physics.world.removeCollider(this.intactCollider, false);
    this.intactCollider = null;
    this.cells.forEach((cell, i) => {
      if (this.state[i] !== INTACT) return;
      const hull = this.hull(cell);
      const desc = hull && R.ColliderDesc.convexHull(hull);
      if (desc) this.chunkColliders[i] = physics.world.createCollider(desc.setTranslation(cell.centroid.x, cell.centroid.y, cell.centroid.z).setFriction(0.8), this.fixedBody);
    });
  }

  private hide(index: number): void {
    this.matrices.fill(0, index * 32, index * 32 + 32);
    this.texture.needsUpdate = true;
  }

  private announce(count: number, point: THREE.Vector3, intensity: number): void {
    const { engine, fx } = this.system;
    const big = Math.min(1, count / 12);
    if (this.material === 'glass') {
      // Glittering fragments, almost no dust.
      fx.spray.emit({ position: point, radius: 0.35, velocity: { x: 0, y: 1.5, z: 0 }, spread: 5, life: 0.9, size: 0.03, sizeEnd: 0.05, count: Math.floor(40 + 160 * big) });
    } else {
      // Pulverised material hangs where the object stood (not at the blast centre).
      const scale = Math.min(1, Math.cbrt(this.size.x * this.size.y * this.size.z) / 1.6);
      const fields = engine.world.read(point, engine.time, this.contactFields);
      const fines = this.material === 'wood' ? 0.46 : this.material === 'brick' ? 0.82 : 1;
      const dust = fines * (1 - fields.wetness * 0.90) * (0.35 + 0.65 * intensity);
      const count = Math.floor((6 + 34 * big) * scale * dust);
      if (count) fx.dust.emit({ position: point, radius: 0.3 + 0.7 * scale,
        velocity: _v.set(fields.wind.x * 0.25, 0.9, fields.wind.z * 0.25), spread: 1.4 + 1.6 * big,
        life: 1.3 + 1.9 * dust, lifeJitter: 0.5, size: 0.4, sizeEnd: 1.2 + 1.6 * big * scale, count });
    }
    engine.events.emit('shatter', { kind: this.material, position: [point.x, point.y, point.z], intensity: Math.max(0.3, Math.min(1, intensity * 0.5 + big * 0.6)) });
    engine.trauma.blast(point.distanceTo(engine.camera.position), 0.18 * big);
    this.system.breaks += count;
    this.onBreak?.(count, point);
  }

  // ---- per step / per frame ---------------------------------------------------------

  /** @internal Fixed-step hook: remember poses for interpolation, water forces. */
  preStep(dt: number): void {
    const ocean = this.system.ocean;
    for (const piece of this.loose.values()) {
      const t = piece.body.translation(), r = piece.body.rotation();
      piece.previousPosition.set(t.x, t.y, t.z);
      piece.previousRotation.set(r.x, r.y, r.z, r.w);
      if (!ocean || piece.body.isSleeping()) continue;
      const surface = ocean.heightAt(t.x, t.z);
      if (t.y < surface && ocean.depthAt(t.x, t.z) > 0.1) {
        const mass = piece.body.mass();
        // Archimedes: weight of displaced water, limited to a fully submerged chunk.
        const lift = (1000 / DENSITY[this.material]) * mass * 9.81 * Math.min(1, (surface - t.y) / 0.4);
        piece.body.applyImpulse({ x: 0, y: lift * dt, z: 0 }, true);
        piece.body.setLinearDamping(2.6);
        piece.body.setAngularDamping(2);
        if (!piece.wet) {
          piece.wet = true;
          const v = piece.body.linvel();
          this.system.splash(_v.set(t.x, surface, t.z), Math.min(1, (Math.hypot(v.x, v.y, v.z) * Math.cbrt(mass)) / 40));
        }
      } else if (piece.wet) { piece.body.setLinearDamping(0.04); piece.body.setAngularDamping(0.25); }
    }
  }

  /** @internal */
  update(dt: number, alpha: number): void {
    if (this.pendingContact > 0) {
      const energy = Math.max(this.contactEnergy, this.pendingContact * 0.02);
      this.pendingContact = 0;
      this.impact(this.contactPoint, this.contactDirection.lengthSq() > 1e-6 ? this.contactDirection : _v.set(0, -1, 0), energy);
    }
    if (!this.loose.size) return;
    let changed = false;
    for (const [index, piece] of this.loose) {
      piece.age += dt;
      const t = piece.body.translation();
      if (piece.age > piece.life || t.y < -80) {
        this.system.engine.physics.world.removeRigidBody(piece.body);
        this.loose.delete(index);
        this.state[index] = GONE;
        this.system.release();
        this.hide(index);
        continue;
      }
      const base = index * 32;
      // Previous-frame matrix feeds the motion vectors.
      this.matrices.copyWithin(base + 16, base, base + 16);
      if (piece.body.isSleeping() && piece.life > 1e8) continue;
      const r = piece.body.rotation();
      _v.set(t.x, t.y, t.z).lerpVectors(piece.previousPosition, _v, alpha);
      _q.set(r.x, r.y, r.z, r.w);
      _q.slerpQuaternions(piece.previousRotation, _q2.copy(_q), alpha);
      // Fragments shrink away at the end of their life instead of popping.
      const fade = Math.min(1, (piece.life - piece.age) / 0.5);
      _m.compose(_v, _q, _w.setScalar(Math.max(fade, 0.001))).toArray(this.matrices, base);
      changed = true;
    }
    if (changed) this.texture.needsUpdate = true;
  }

  dispose(): void {
    const { physics } = this.system.engine;
    this.unwatch?.();
    for (const piece of this.loose.values()) { physics.world.removeRigidBody(piece.body); this.system.release(); }
    this.loose.clear();
    if (physics.world.getRigidBody(this.fixedBody.handle)) physics.world.removeRigidBody(this.fixedBody);
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

/** Procedural look per material. Patterns are evaluated in the rest pose so they stick to the chunks. */
function createMaterial(kind: FractureMaterial, matrices: THREE.DataTexture, chips: SurfaceChips | null, options: DestructibleOptions): THREE.NodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  const row = int(attribute('chunk', 'float'));
  const column = (c: number): N => textureLoad(matrices, ivec2(c, row));
  // The last element of the matrix (always 1 in an affine transform) doubles as a flag:
  // 0 while the chunk is still part of the intact object, 1 once it is loose.
  const origin = column(3);
  const current = mat4(column(0), column(1), column(2), vec4(origin.xyz, 1));
  const previous = mat4(column(4), column(5), column(6), vec4(column(7).xyz, 1));
  const looseFlag = origin.w.toVarying('dLoose');
  const local = attribute('position', 'vec3');
  // Each standing block carries half of its bed and head joints. Closing the
  // physical gap in the render mesh gives solid mortar without a second draw.
  const longX = options.size.x >= options.size.z;
  const halfJoint = BRICK_JOINT_M * 0.5;
  const mortarEdge = kind === 'brick' ? TSL.sign(local).mul(longX ? vec3(halfJoint, halfJoint, 0) : vec3(0, halfJoint, halfJoint)) : null;
  const currentLocal = mortarEdge ? local.add(mortarEdge.mul(origin.w.oneMinus())) : local;
  const previousLocal = mortarEdge ? local.add(mortarEdge.mul(column(7).w.oneMinus())) : local;
  const world = current.mul(vec4(currentLocal, 1)).xyz;
  material.positionNode = world;
  const normalWorld = normalize(current.mul(vec4(attribute('normal', 'vec3'), 0)).xyz).toVarying('dNormal');
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalWorld, 0)).xyz);
  const vWorld = world.toVarying('dWorld');
  const vPrevious = previous.mul(vec4(previousLocal, 1)).xyz.toVarying('dPrevious');
  material.mrtNode = auxSurface(material.normalNode, screenVelocity(vWorld, vPrevious));

  const p = attribute('rest', 'vec3').toVarying('dRest');
  const inner = attribute('inner', 'float').toVarying('dInner');
  const id = attribute('chunk', 'float').toVarying('dChunk');
  const base = new THREE.Color(options.color ?? (kind === 'concrete' ? 0x8f908b : kind === 'glass' ? 0xbfe6dc : kind === 'wood' ? 0x7a5632 : 0x9c4a32));
  const c = vec3(base.r, base.g, base.b);
  let surfaceHeight: N | null = null;
  if (kind === 'concrete') {
    const stain = valueNoise3(p.mul(1.7)).mul(0.6).add(valueNoise3(p.mul(9)).mul(0.4));
    // Broken faces show the aggregate: pale cement paste with darker stones.
    const stones = smoothstep(0.55, 0.75, valueNoise3(p.mul(38)));
    const finesUV = vec2(p.x.mul(0.8).sub(p.z.mul(0.58)), p.y.add(p.x.mul(0.41)).add(p.z.mul(0.83)));
    const grit = spriteNoise(finesUV.mul(189).add(stain.mul(3.8)), 0);
    const chipsInPaste = smoothstep(0.41, 0.73, grit.mul(0.56).add(stones.mul(0.44)));
    const fresh = mix(vec3(0.33, 0.315, 0.29), vec3(0.17, 0.16, 0.145), chipsInPaste)
      .mul(grit.mul(0.25).add(0.87));
    const pores = smoothstep(0.60, 0.83, valueNoise3(p.mul(147)));
    const face = c.mul(mix(0.72, 1.08, stain)).mul(stones.mul(-0.15).add(1)).mul(pores.mul(-0.27).add(1));
    material.colorNode = mix(face, fresh, inner);
    material.roughnessNode = mix(pores.mul(0.10).add(0.81), float(0.97), inner);
    surfaceHeight = mix(pores.mul(-0.00055), chipsInPaste.mul(0.0016).add(grit.mul(0.00085)), inner);
    material.metalness = 0;
  } else if (kind === 'wood') {
    // Growth rings run through the log. Cutting the end therefore reveals
    // ring cross-sections while a side cut exposes long, wandering fibres.
    const seed = THREE.MathUtils.euclideanModulo((options.seed ?? 11) * 0.618034, 1);
    const along = p.x, cross = p.y.add(p.z.mul(0.87));
    const knotCell = along.div(1.47).add(seed + 0.3);
    const knotY = hash12(vec2(knotCell.floor(), float(seed * 13 + 1))).mul(0.22).sub(0.11);
    const dy = cross.sub(knotY);
    const knotRadius = TSL.length(vec2(knotCell.fract().sub(0.5).mul(7.35), dy.mul(13.4)));
    const knot = smoothstep(0.08, 1.05, knotRadius).oneMinus();
    const core = smoothstep(0.11, 0.33, knotRadius).oneMinus();
    const fibreAxis = cross.add(knot.mul(dy).mul(2.9));
    const bend = spriteNoise(vec2(along.mul(2.8).add(seed * 7), fibreAxis.mul(9)), 1);
    const growthRadius = TSL.length(vec2(p.y.add(0.11 + seed * 0.09).add(knot.mul(dy).mul(2.1)), p.z.add(0.035 + seed * 0.05)));
    const phase = growthRadius.mul(262 + seed * 60).add(bend.mul(5.6)).add(along.mul(2.4).sin().mul(1.8));
    const ring = smoothstep(0.08, 0.88, phase.sin()).mul(smoothstep(0.9, 3, TSL.fwidth(phase)).oneMinus());
    const fibre = spriteNoise(vec2(along.mul(12).add(seed * 9), fibreAxis.mul(375).add(bend.mul(7))), 0);
    const tone = bend.mul(0.32).add(fibre.mul(0.34)).add(0.51).sub(ring.mul(0.16)).mul(core.mul(-0.39).add(1));
    const outer = c.mul(tone).mul(vec3(0.94, 0.97, 1.06));
    material.colorNode = mix(outer, vec3(0.43, 0.28, 0.14).mul(tone), inner);
    material.roughnessNode = mix(fibre.mul(0.11).add(0.69), float(0.92), inner);
    surfaceHeight = fibre.mul(0.00085).sub(ring.mul(0.00046));
    material.metalness = 0;
  } else if (kind === 'brick') {
    const shade = hash12(vec2(id, id.mul(0.37).add(3.1)));
    const uv = vec2(p.x.add(p.z.mul(0.81)), p.y.add(p.z.mul(0.57)));
    const firing = spriteNoise(uv.mul(12).add(shade.mul(17)), 1);
    const grit = spriteNoise(uv.mul(199).add(firing.mul(1.9)), 0);
    const pits = smoothstep(0.56, 0.86, grit);
    const iron = mix(vec3(0.81, 0.63, 0.58), vec3(1.04, 1.09, 1.12), shade);
    const clay = c.mul(iron).mul(firing.mul(0.35).add(0.69)).mul(pits.mul(-0.28).add(1));
    // Box corners all have the same absolute cell-local coordinates. Take
    // their absolute value in the vertex stage to retain each half extent.
    const half = abs(local).toVarying('brickHalf');
    const coord = local.toVarying('brickLocal');
    const n = abs(attribute('normal', 'vec3')).toVarying('brickFace');
    const bed = half.y.sub(abs(coord.y)).add(n.y);
    const head = longX ? half.x.sub(abs(coord.x)).add(n.x) : half.z.sub(abs(coord.z)).add(n.z);
    const distance = TSL.min(bed, head).add(grit.sub(0.5).mul(0.0037));
    const joint = smoothstep(0.0003, 0.0048, distance).oneMinus()
      .mul(mix(float(1), smoothstep(0.45, 0.77, firing).mul(0.56), looseFlag));
    const lime = vec3(0.285, 0.25, 0.20).mul(grit.mul(0.40).add(0.71));
    material.colorNode = mix(clay, lime, joint);
    material.roughnessNode = mix(pits.mul(0.08).add(0.82), float(0.96), joint);
    surfaceHeight = joint.mul(-0.0024).sub(pits.mul(0.00115));
    material.metalness = 0;
  } else {
    // Glass: mostly reflection and a faint tint; broken edges are thick, green and bright.
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.roughness = 0.04;
    material.metalness = 0;
    const view = normalize(positionViewDirection);
    const facing = abs(dot(material.normalNode, view));
    const fresnel = pow(float(1).sub(facing), 4);
    material.colorNode = mix(c.mul(0.5), vec3(0.3, 0.72, 0.56), inner);
    material.alphaTest = 0.01;
    // Cut faces between chunks that are still in place are not cracks yet: keep them invisible.
    const edge = inner.mul(looseFlag);
    material.opacityNode = max(mix(float(0.16), float(0.85), edge), fresnel.mul(0.85).add(0.1)).mul(mix(float(1), looseFlag, inner));
    // Edges catch the sun: a cheap stand-in for light piped through the glass.
    material.emissiveNode = frame.sunColor.mul(frame.sunVisibility).mul(inner).mul(vec3(0.12, 0.3, 0.22)).mul(0.25);
    material.mrtNode = TSL.mrt({ normal: vec4(0, 0, 0, 0), velocity: vec4(0, 0, 0, 0) });
  }
  if (chips) {
    const patch = chips.sample(p, inner, id, kind === 'wood');
    const substrate = kind === 'wood' ? vec3(0.50, 0.29, 0.13) : kind === 'brick' ? vec3(0.37, 0.13, 0.067) : vec3(0.42, 0.40, 0.36);
    const fresh = substrate.mul(mix(1.13, 0.57, patch.y)).mul(patch.z.mul(-0.44).add(1));
    material.colorNode = mix(material.colorNode, fresh, patch.x);
    material.roughnessNode = mix(material.roughnessNode, kind === 'wood' ? 0.88 : 0.95, patch.x);
    const unmarked: N = material.normalNode;
    material.normalNode = surfaceHeight ? perturbNormalHeight(surfaceHeight.add(patch.w), float(1), unmarked) : TSL.Fn(() => {
      const normal = unmarked.toVar();
      TSL.If(chips.count.greaterThan(0), () => { normal.assign(perturbNormalHeight(patch.w, float(1), unmarked)); });
      return normal;
    })();
    material.mrtNode = auxSurface(material.normalNode, screenVelocity(vWorld, vPrevious));
  }
  return material;
}

export interface DestructionOptions {
  /** Chunks that sink / float and splash need the water surface. */
  ocean?: Ocean | null;
}

export class DestructionSystem implements EngineModule {
  readonly objects: Destructible[] = [];
  ocean: Ocean | null;
  /** Total chunks broken off since creation (QA, scoring). */
  breaks = 0;
  /** Upper bound for chunks per object (scales with the tier). */
  chunkBudget = 64;
  private live = 0;
  private maxLive = 160;
  private unregister: Array<() => void> = [];

  constructor(readonly engine: LuminaEngine, readonly fx: EffectsKit, options: DestructionOptions = {}) {
    this.ocean = options.ocean ?? null;
    this.applyBudget();
    this.unregister.push(engine.physics.onBlast((center, radius, impulse) => { for (const o of this.objects) o.blast(center, radius, impulse); }));
    this.unregister.push(engine.physics.addPreStep((dt) => { for (const o of this.objects) o.preStep(dt); }));
  }

  private applyBudget(): void {
    const debris = this.engine.quality.preset.physics.maxDebris;
    this.maxLive = Math.round(debris * 1.5) + 24;
    this.chunkBudget = debris <= 24 ? 14 : debris <= 48 ? 24 : debris <= 96 ? 40 : 64;
  }

  /** Number of chunk bodies currently simulated. */
  get liveChunks(): number { return this.live; }

  add(options: DestructibleOptions): Destructible {
    const object = new Destructible(this, options);
    this.objects.push(object);
    return object;
  }

  remove(object: Destructible): void {
    const i = this.objects.indexOf(object);
    if (i >= 0) { this.objects.splice(i, 1); object.dispose(); }
  }

  /**
   * Hit whatever destructible lies along a ray (bullets, thrown objects). Returns the
   * object that was hit, or null.
   */
  shoot(origin: THREE.Vector3, direction: THREE.Vector3, energy: number, maxDistance = 400): Destructible | null {
    const dir = _v.copy(direction).normalize().clone();
    let best: Destructible | null = null, bestT = maxDistance;
    const box = new THREE.Box3(), ray = new THREE.Ray(), hit = new THREE.Vector3(), inverse = new THREE.Matrix4();
    for (const o of this.objects) {
      if (o.destroyed) continue;
      inverse.compose(o.position, o.quaternion, _one).invert();
      ray.origin.copy(origin).applyMatrix4(inverse);
      ray.direction.copy(dir).transformDirection(inverse);
      box.setFromCenterAndSize(_w.set(0, 0, 0), o.size);
      if (!ray.intersectBox(box, hit)) continue;
      const t = hit.distanceTo(ray.origin);
      if (t < bestT) { bestT = t; best = o; }
    }
    if (best) best.impact(origin.clone().addScaledVector(dir, bestT), dir, energy);
    return best;
  }

  /** @internal Budget for simultaneous chunk bodies. */
  claim(_owner: Destructible): boolean {
    if (this.live >= this.maxLive) return false;
    this.live++;
    return true;
  }

  /** @internal */
  release(): void { this.live = Math.max(0, this.live - 1); }

  /** @internal A chunk hit the water. */
  splash(position: THREE.Vector3, strength: number): void {
    if (strength < 0.04 || !this.ocean) return;
    this.ocean.field.addSource({ x: position.x, z: position.z, radius: 0.6 + strength * 1.6, impulse: -0.2 * strength, foam: 3 * strength });
    this.fx.spray.emit({ position, radius: 0.25, velocity: { x: 0, y: 3 + 6 * strength, z: 0 }, spread: 2 + 3 * strength, life: 1.2, size: 0.1, sizeEnd: 0.45, count: Math.floor(20 + 120 * strength) });
    this.engine.events.emit('splash', { position: [position.x, position.y, position.z], intensity: strength });
    this.engine.lens.splashAt(position, 2 + strength * 2, 0.6 * strength);
  }

  setQuality(): void { this.applyBudget(); }

  update(dt: number): void {
    const alpha = this.engine.physics.alpha;
    for (const o of this.objects) o.update(dt, alpha);
  }

  dispose(): void {
    for (const u of this.unregister) u();
    for (const o of this.objects) o.dispose();
    this.objects.length = 0;
  }
}
