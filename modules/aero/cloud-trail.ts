import * as THREE from 'three/webgpu';
import { WorldSource } from '../../engine/world-bus';
import type { LuminaEngine } from '../../engine/engine';

/** Cooperating aircraft and other fast-moving scene objects can part a cloud layer
 * without keeping a mesh trail. Each short swept capsule relaxes back into vapour. */
export class CloudTrail {
  readonly last = new THREE.Vector3();
  readonly source = new WorldSource();
  segments = 0;
  private readonly leading = new WorldSource();
  private valid = false;
  constructor(
    private engine: LuminaEngine,
    readonly radius = 32,
    readonly lifetime = 2.4
  ) {
    this.leading.axialSwirl = this.source.axialSwirl = true;
  }

  reset(): void {
    this.valid = false;
    this.engine.world.removeSource(this.leading);
  }
  update(p: THREE.Vector3): void {
    const bus = this.engine.world;
    if (!bus.inCloudLayer(p.y, this.radius)) {
      if (this.valid) this.reset();
      return;
    }
    if (!this.valid) {
      this.last.copy(p);
      this.valid = true;
    }
    const length = this.last.distanceTo(p);
    if (length > this.radius * 14) this.last.copy(p);
    // The leading capsule reaches the aircraft every frame. Leaving it empty
    // between history knots made the cockpit and close chase view pulse in fog.
    const tip = this.leading;
    tip.start.copy(this.last);
    tip.end.copy(p);
    tip.radius = this.radius;
    tip.cloudCut = 1;
    tip.swirl = 4;
    tip.wetness = 0.15;
    bus.publish(tip, 0.22);
    if (length < this.radius * 1.45 || length > this.radius * 14) return;
    const s = this.source;
    s.start.copy(this.last);
    s.end.copy(p);
    s.radius = this.radius;
    s.cloudCut = 1;
    s.swirl = 4;
    s.wetness = 0.15;
    if (bus.publish(s, this.lifetime, true)) this.segments++;
    this.last.copy(p);
  }
}
