import type { N } from '../../engine/tsl';

export interface CloudDistribution {
  /** A high veil of ice crystals uses a narrower forward scattering lobe. */
  readonly iceVeil?: boolean;
  /** Phase in radians, advected with the corresponding deck. */
  readonly life?: {
    at(x: number, z: number, t: number, upper: boolean): number;
    node(xz: N, t: N, upper: boolean): N;
  };
  coverageNode(xz: N, time: N, upper: boolean): N;
  coverageAt(x: number, z: number, time: number, upper: boolean): number;
}
