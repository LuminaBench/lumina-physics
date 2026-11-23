import * as THREE from 'three/webgpu';
import type { EngineModule, LuminaEngine } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';

/** Artist-authored collision cards for skipping stones, sparks and arcade tracers. */
export type ImpactSurface = 'water' | 'steel' | 'wood' | 'glass';
export interface ImpactCard {
  kind: ImpactSurface;
  center: THREE.Vector3;
  /** Local X and Y are unit vectors spanning the card. The normal faces the incoming trail. */
  orientation: THREE.Quaternion;
  width: number;
  height: number;
  /** Thin breakaway scenery permits one visual exit. */
  breakaway?: boolean;
}
interface Card extends ImpactCard {
  right: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
}

export class TracerField implements EngineModule {
  private readonly slots: { p: THREE.Vector3; v: THREE.Vector3; age: number; skips: number }[];
  private readonly cards: Card[] = [];
  private readonly positions: THREE.BufferAttribute;
  private readonly trails: THREE.LineSegments;
  private readonly wind = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private cursor = 0;
  readonly stats = { launched: 0, skipped: 0, exited: 0, stopped: 0 };
  /** Artist controls in scene units. */
  gravity = 9;
  drag = 0.13;

  constructor(private engine: LuminaEngine, private fx: EffectsKit, capacity = 96) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.slots = Array.from({ length: capacity }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, skips: 0 }));
    this.positions = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicNodeMaterial({ color: new THREE.Color(2.8, 1.7, 0.65) });
    this.trails = new THREE.LineSegments(geometry, material);
    this.trails.frustumCulled = false;
    this.trails.visible = false;
    engine.scene.add(this.trails);
  }

  addSurface(card: ImpactCard): () => void {
    const orientation = card.orientation.clone().normalize();
    const stored: Card = { ...card, center: card.center.clone(), orientation,
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(orientation),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(orientation),
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(orientation) };
    this.cards.push(stored);
    return () => {
      const index = this.cards.indexOf(stored);
      if (index >= 0) this.cards.splice(index, 1);
    };
  }

  launch(position: THREE.Vector3, velocity: THREE.Vector3): void {
    const slot = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    slot.p.copy(position); slot.v.copy(velocity);
    slot.age = 4; slot.skips = 0;
    this.stats.launched++;
  }

  update(dt: number, time: number): void {
    if (dt <= 0) return;
    let count = 0;
    for (const slot of this.slots) {
      if (slot.age <= 0) continue;
      const { p, v } = slot;
      slot.age -= dt;
      this.engine.wind.sample(p, time, this.wind);
      v.lerp(this.wind, 1 - Math.exp(-dt * this.drag));
      v.y -= this.gravity * dt;
      this.end.copy(p).addScaledVector(v, dt);
      let first: Card | undefined;
      let nearest = 1;
      for (const card of this.cards) {
        const startDistance = this.local.subVectors(p, card.center).dot(card.normal);
        const endDistance = this.local.subVectors(this.end, card.center).dot(card.normal);
        if (startDistance <= 0 || endDistance > 0) continue;
        const fraction = startDistance / (startDistance - endDistance);
        if (fraction > nearest) continue;
        this.local.copy(p).lerp(this.end, fraction).sub(card.center);
        if (Math.abs(this.local.dot(card.right)) > card.width / 2 || Math.abs(this.local.dot(card.up)) > card.height / 2) continue;
        first = card; nearest = fraction;
      }
      this.positions.setXYZ(count++, p.x, p.y, p.z);
      if (first) {
        this.hit.copy(p).lerp(this.end, nearest);
        const vn = v.dot(first.normal);
        const shallow = -vn < v.length() * 0.55;
        const brittle = first.kind === 'glass' || first.kind === 'wood';
        const particles = first.kind === 'water' ? this.fx.spray : first.kind === 'steel' ? this.fx.sparks : this.fx.dust;
        particles.emit({ position: this.hit, velocity: first.normal, radius: 0.08, spread: 1.8, life: 0.4, size: 0.045, sizeEnd: 0.09, count: 14 });
        if (brittle && first.breakaway) {
          this.stats.exited++;
          v.multiplyScalar(0.74);
          this.local.copy(this.hit).addScaledVector(first.normal, -0.08);
          particles.emit({ position: this.local, velocity: v, radius: 0.05, spread: 0.7, life: 0.16, size: 0.035, count: 5 });
        } else if (!brittle && shallow && slot.skips < 3) {
          this.stats.skipped++; slot.skips++;
          v.addScaledVector(first.normal, -1.65 * vn).multiplyScalar(0.78);
        } else {
          this.stats.stopped++;
          slot.age = 0;
        }
        this.end.copy(this.hit).addScaledVector(v, slot.age > 0 ? (1 - nearest) * dt : 0);
      }
      this.positions.setXYZ(count++, this.end.x, this.end.y, this.end.z);
      p.copy(this.end);
    }
    if (count) {
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, count * 3);
      this.positions.needsUpdate = true;
    }
    this.trails.visible = count > 0;
    this.trails.geometry.setDrawRange(0, count);
  }

  dispose(): void {
    this.trails.removeFromParent();
    this.trails.geometry.dispose();
    (this.trails.material as THREE.Material).dispose();
  }
}
