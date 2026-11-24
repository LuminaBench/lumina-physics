import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import type { WorldBus } from '../../engine/world-bus';

/** Vertex bending for rooted, instanced foliage. Local geometry Y runs from
 * root to crown. The input position already includes the instance transform. */
export function canopyBendNode(world: WorldBus, height: number, flexibility: number, time:N=frame.time): N {
  const local = TSL.positionLocal,
    rest = TSL.positionGeometry;
  const p = TSL.modelWorldMatrix.mul(TSL.vec4(local, 1)).xyz;
  const u = rest.y.div(Math.max(0.01, height)).clamp(0, 1);
  const air = world.node(p),
    horizontal = air.xz;
  const flutter = p.x.mul(0.27).add(p.z.mul(0.19)).add(time.mul(2.1)).sin().mul(0.13).add(0.91);
  const bend = u
    .mul(u)
    .mul(flexibility * height)
    .mul(flutter);
  const response = horizontal.mul(bend).div(TSL.length(horizontal).mul(0.023).add(1));
  const settle = TSL.dot(response, response).div(Math.max(0.06, height * 1.8));
  const offset = TSL.modelWorldMatrixInverse.mul(TSL.vec4(response.x, settle.negate(), response.y, 0)).xyz;
  return local.add(offset);
}
