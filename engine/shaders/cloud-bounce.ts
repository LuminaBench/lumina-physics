import { TSL, type N } from '../tsl';
import { fireLights, MAX_FIRE_LIGHTS } from '../particles';

/** Solid-angle approximation for a bright fire under a low cloud deck, evaluated once per ray. */
export function cloudFireBounce(origin: N, ray: N, base: N): N {
  const irradiance = TSL.vec3(0).toVar();
  TSL.If(fireLights.hasActive.greaterThan(0.5).and(ray.y.greaterThan(0.015)), () => {
    const distance = base.sub(origin.y).max(0).div(ray.y.max(0.015));
    const patch = origin.add(ray.mul(distance));
    for (let i = 0; i < MAX_FIRE_LIGHTS; i++) {
      const source = fireLights.posRadius[i];
      const delta = patch.sub(source.xyz);
      const radiusSq = source.w.mul(source.w);
      const solidAngle = radiusSq.div(TSL.dot(delta, delta).add(radiusSq).add(1));
      irradiance.addAssign(fireLights.colorInvR[i].rgb.mul(solidAngle).mul(0.6));
    }
  });
  return irradiance;
}
