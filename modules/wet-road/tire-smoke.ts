import { MathUtils, Vector3 } from 'three/webgpu';
import type { EffectsKit } from '../../engine/fx';

/** Effective tread-skin temperature rise in °C, for smoke rendering. */
export class TireSmoke {
  private readonly heat: Float64Array;
  private readonly carry: Float64Array;
  emitted = 0;
  private readonly plume = { smokeMaterial: 'rubber' as const, position: new Vector3(), velocity: new Vector3(), radius: 0.12, spread: 0.46,
    size: 0.18, sizeEnd: 1.35, life: 2, lifeJitter: 0.42, temperature: 0.04 };

  constructor(private fx: EffectsKit, wheelCount = 4) {
    this.heat = new Float64Array(wheelCount);
    this.carry = new Float64Array(wheelCount);
  }

  temperatureRise(wheel: number): number { return this.heat[wheel] ?? 0; }

  /** Call every frame, including cooling frames. Load in newtons, slip at the tread in m/s. */
  updateWheel(i: number, point: Vector3, load: number, slip: number, wetness: number, dt: number, velocity?: Vector3): void {
    if (i < 0 || i >= this.heat.length || !(dt > 0)) return;
    const film = MathUtils.clamp(wetness, 0, 1);
    const dry = 1 - film;
    const speed = velocity ? Math.hypot(velocity.x, velocity.z) : 0;
    const power = Math.max(0, load) * Math.abs(slip) * 0.32 * dry;
    const cooling = 0.16 + Math.min(speed, 60) * 0.008 + film * 3.8;
    // Exact integration for a constant contact over the frame. Effective capacity
    // is for the heated surface layer of the tread, rather than the whole wheel.
    const previous = this.heat[i];
    const equilibrium = power / (112 * cooling);
    const heat = this.heat[i] = Math.min(260, previous + (equilibrium - previous) * -Math.expm1(-dt * cooling));
    const hot = MathUtils.smoothstep(heat, 46, 143);
    if (!hot || !dry || load <= 0) return;
    const rate = hot * dry * (Math.min(86, power / 100) + 3 * Math.min(1, heat / 120));
    const plume = this.plume;
    plume.position.copy(point); plume.position.y += 0.04;
    plume.velocity.set((velocity?.x ?? 0) * 0.22, 0.35 + hot * 1.15, (velocity?.z ?? 0) * 0.22);
    plume.sizeEnd = 0.48 + hot * 1.22;
    plume.temperature = 0.02 + hot * 0.11;
    this.fx.smoke.emitRateAt(this.carry, i, rate, dt, plume);
    this.emitted += rate * dt;
  }
}
