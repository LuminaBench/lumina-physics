import { TSL, type N } from '../../engine/tsl';
import type { CloudDistribution } from './cloud-distribution';
import type { RainColumn } from './rain-column';

/** Attach lower cloud banks to the emitting cells. A supplied regional distribution
 * retains its own gaps outside the banks and its independently moving upper deck. */
export class RainCloudBanks implements CloudDistribution {
  readonly life;
  readonly iceVeil;
  private readonly cells;
  constructor(
    columns: readonly RainColumn[],
    private readonly region?: CloudDistribution,
  ) {
    this.life = region?.life;
    this.iceVeil = region?.iceVeil;
    this.cells = columns.map(({ options: o, motion }) => ({
      x: o.center[0],
      z: o.center[1],
      vx: motion[0],
      vz: motion[1],
      inverseWidth: 1 / (2.2 * o.radius[0]),
      inverseLength: 1 / (2.25 * o.radius[1]),
      warpX: o.radius[0] * 0.29,
      warpZ: o.radius[1] * 0.38,
    }));
  }

  coverageAt(x: number, z: number, time: number, upper: boolean) {
    if (upper) return this.region?.coverageAt(x, z, time, true) ?? 1;
    let bank = 0;
    for (const c of this.cells) {
      const px = x - c.vx * time,
        pz = z - c.vz * time;
      const dx =
        (px - c.x + c.warpX * (Math.sin(pz * 0.009) + 0.47 * Math.sin(pz * 0.019 + px * 0.004))) *
        c.inverseWidth;
      const dz =
        (pz - c.z + c.warpZ * (Math.sin(px * 0.008) + 0.47 * Math.cos(px * 0.019))) * c.inverseLength;
      bank = Math.max(bank, Math.exp(-(dx * dx + dz * dz)));
    }
    const background = this.region?.coverageAt(x, z, time, false) ?? 0.1;
    return background + (1.24 - background) * bank;
  }

  coverageNode(p: N, time: N, upper: boolean): N {
    if (upper) return this.region?.coverageNode(p, time, true) ?? TSL.float(1);
    let bank = TSL.float(0);
    for (const c of this.cells) {
      const q = c.vx || c.vz ? p.sub(TSL.vec2(c.vx, c.vz).mul(time)) : p;
      const dx = TSL.sin(q.y.mul(0.009))
        .add(TSL.sin(q.y.mul(0.019).add(q.x.mul(0.004))).mul(0.47))
        .mul(c.warpX);
      const dz = TSL.sin(q.x.mul(0.008))
        .add(TSL.cos(q.x.mul(0.019)).mul(0.47))
        .mul(c.warpZ);
      const xy = q
        .sub(TSL.vec2(c.x, c.z))
        .add(TSL.vec2(dx, dz))
        .mul(TSL.vec2(c.inverseWidth, c.inverseLength));
      bank = bank.max(TSL.exp(TSL.dot(xy, xy).negate()));
    }
    return TSL.mix(this.region?.coverageNode(p, time, false) ?? TSL.float(0.1), 1.24, bank);
  }
}
