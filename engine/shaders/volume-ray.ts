import { TSL as t, type N } from '../tsl';

/** Local interval visible inside a back-face volume. The depth texture belongs
 * to the scene camera. Scale view-space depth along the actual local ray so
 * the clip stays correct for tilted cameras and nonuniform volume transforms. */
export function visibleVolumeRay(depth: N, lower: N, upper: N) {
  const eye = t.modelWorldMatrixInverse.mul(t.vec4(t.cameraPosition, 1)).xyz;
  const ray = t.normalize(t.positionLocal.sub(eye));
  const inverse = t.mix(t.vec3(-1), t.vec3(1), t.step(t.vec3(0), ray)).div(t.max(t.abs(ray), 1e-5));
  const a = lower.sub(eye).mul(inverse), b = upper.sub(eye).mul(inverse);
  const lo = t.min(a,b), hi = t.max(a,b);
  const near = lo.x.max(lo.y).max(lo.z).max(0);
  const viewRay = t.modelViewMatrix.mul(t.vec4(ray,0)).xyz;
  const opaque = t.perspectiveDepthToViewZ(depth, t.cameraNear, t.cameraFar).negate();
  const end = hi.x.min(hi.y).min(hi.z).min(opaque.div(viewRay.z.negate().max(1e-5)));
  t.If(end.lessThanEqual(near), () => t.Discard());
  return { eye, ray, near, end, viewRay };
}
