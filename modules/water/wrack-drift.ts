import { Vector3 } from 'three/webgpu';

export interface DriftSurface {
  ground(x: number, z: number): number;
  stage(x: number, z: number): number;
  current(x: number, z: number, out: Vector3): Vector3;
}

/** A short waterlogged branch. Its centre rests one draft above the bed on a falling tide. */
export class WrackDrift {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  private readonly flow = new Vector3();
  grounded = false;

  constructor(
    private surface: DriftSurface,
    readonly draft: number,
    private dragSeconds = 0.38,
  ) {
    if (!Number.isFinite(draft) || draft <= 0 || !Number.isFinite(dragSeconds) || dragSeconds <= 0)
      throw new RangeError('Wrack draft and drag time must be positive');
  }
  reset(x: number, z: number) {
    const bed = this.surface.ground(x, z),
      stage = this.surface.stage(x, z);
    this.grounded = stage - bed <= this.draft;
    this.position.set(x, Math.max(stage, bed + this.draft), z);
    this.velocity.set(0, 0, 0);
  }
  update(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Invalid drift time');
    const s = this.surface,
      p = this.position,
      v = this.velocity;
    const steps = Math.ceil(dt * 30);
    if (!steps) return;
    const h = dt / steps,
      gain = -Math.expm1(-h / this.dragSeconds);
    for (let i = 0; i < steps; i++) {
      const stage = s.stage(p.x, p.z),
        bed = s.ground(p.x, p.z);
      if (stage - bed <= this.draft * (this.grounded ? 1.15 : 1)) {
        this.grounded = true;
        p.y = bed + this.draft;
        v.set(0, 0, 0);
        continue;
      }
      this.grounded = false;
      s.current(p.x, p.z, this.flow);
      const vx = v.x,
        vz = v.z;
      v.x += (this.flow.x - vx) * gain;
      v.z += (this.flow.z - vz) * gain;
      const x = p.x + this.flow.x * h + (vx - this.flow.x) * this.dragSeconds * gain;
      const z = p.z + this.flow.z * h + (vz - this.flow.z) * this.dragSeconds * gain;
      const nextStage = s.stage(x, z),
        nextBed = s.ground(x, z);
      if (nextStage - nextBed <= this.draft) {
        // Locate first contact along this step, including narrow banks next to fast water.
        let lo = 0,
          hi = 1;
        for (let j = 0; j < 7; j++) {
          const u = (lo + hi) / 2,
            tx = p.x + (x - p.x) * u,
            tz = p.z + (z - p.z) * u;
          if (s.stage(tx, tz) - s.ground(tx, tz) > this.draft) lo = u;
          else hi = u;
        }
        p.x += (x - p.x) * hi;
        p.z += (z - p.z) * hi;
        p.y = s.ground(p.x, p.z) + this.draft;
        this.grounded = true;
        v.set(0, 0, 0);
      } else p.set(x, nextStage, z);
    }
  }
}
