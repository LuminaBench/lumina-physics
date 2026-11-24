import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface FilmBand {
  /** Height range in the object's local metres. */
  bottom: number;
  top: number;
  drainageSeconds: number;
  absorptionSeconds: number;
}
export const PAINT_FILM: FilmBand = { bottom: -0.04, top: 0.14, drainageSeconds: 2.4, absorptionSeconds: 14 };
export const FABRIC_FILM: FilmBand = { bottom: 0, top: 0.32, drainageSeconds: 6, absorptionSeconds: 80 };
/** Attach one band to a boot, sleeve, hull or door. The host supplies immersion depth at its foot. */
export class ImmersionFilm {
  wetHeight: number;
  dampHeight: number;
  film = 0;
  absorbed = 0;
  shedding = 0;
  private readonly state = TSL.uniform(new THREE.Vector4());
  constructor(readonly band: FilmBand) {
    if (!(band.top > band.bottom && band.drainageSeconds > 0 && band.absorptionSeconds > 0))
      throw new RangeError('Invalid immersion band');
    this.wetHeight = this.dampHeight = band.bottom;
  }
  update(dt: number, depth: number) {
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(depth)) return;
    const b = this.band,
      h = b.bottom + THREE.MathUtils.clamp(depth, 0, b.top - b.bottom);
    const filmDecay = Math.exp(-dt / b.drainageSeconds),
      dampDecay = Math.exp(-dt / b.absorptionSeconds);
    this.film = Math.max(Number(depth > 0.001), this.film * filmDecay);
    this.absorbed = Math.max(
      this.absorbed * dampDecay,
      depth > 0.001 ? 1 - (1 - this.absorbed) * Math.exp(-dt * 1.4) : 0,
    );
    this.wetHeight = Math.max(h, b.bottom + (this.wetHeight - b.bottom) * filmDecay);
    this.dampHeight = Math.max(h, b.bottom + (this.dampHeight - b.bottom) * dampDecay);
    this.shedding = depth <= 0.001 ? (this.film * (this.wetHeight - b.bottom)) / b.drainageSeconds : 0;
    this.state.value.set(this.wetHeight, this.dampHeight, this.film, this.absorbed);
  }
  node(localHeight: N) {
    const s = this.state,
      edge = Math.min(0.012, (this.band.top - this.band.bottom) * 0.05);
    return TSL.vec2(
      TSL.smoothstep(s.x.add(edge), s.x.sub(edge), localHeight).mul(s.z),
      TSL.smoothstep(s.y.add(edge), s.y.sub(edge), localHeight).mul(s.w),
    );
  }
}
