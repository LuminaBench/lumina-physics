/**
 * Shared shading helpers for custom-lit (unlit-material) surfaces.
 */
import { TSL, type N } from './tsl';

const { Fn, dFdx, dFdy, dot, min, abs, cross, normalize, sign, positionView, normalView, faceDirection } = TSL;

// All optical taps read one depth snapshot per render target. Constructing a
// viewportDepthTexture node at each tap makes a separate framebuffer clone
// for each one in an offscreen pass and can exceed WebGL 2's sampler limit.
const opticalDepth = TSL.viewportDepthTexture();
opticalDepth.mergeable = false;
export function viewportDepthAt(uv: N): N {
  return opticalDepth.sample(uv).r;
}

/** Direct solar GGX lobe for an isotropic dielectric. The input variance is squared
 * microfacet alpha (perceptual roughness to the fourth power), including pixel filtering. */
export function dielectricSunGlint(normal: N, view: N, light: N, nDotV: N, alpha2: N, f0: N): N {
  const bisector = light.add(view);
  const half = bisector.div(bisector.length().max(0.000001));
  const nh = dot(normal, half).clamp(0, 1);
  const nl = dot(normal, light).max(0);
  const a2 = alpha2.max(0.00001);
  const denom = nh.pow2().mul(a2.sub(1)).add(1);
  const distribution = a2.div(denom.pow2().mul(Math.PI));
  const fresnel = f0.add(f0.oneMinus().mul(dot(view, half).clamp(0, 1).oneMinus().pow(5)));
  const gv = nl.mul(a2.add(nDotV.pow2().mul(a2.oneMinus())).sqrt());
  const gl = nDotV.mul(a2.add(nl.pow2().mul(a2.oneMinus())).sqrt());
  return distribution.mul(fresnel).mul(nl).mul(0.5).div(gv.add(gl).max(0.00001)).min(90);
}

/** Keep a refracted lookup on the image while retaining spatial variation
 * at the edge. With a constant offset the mapping keeps at least one third
 * of the original pixel spacing, even when looking out of the frame. */
export function refractedScreenUV(st: N, offset: N): N {
  const room = TSL.select(offset.greaterThan(TSL.vec2(0)), st.oneMinus(), st);
  return st.add(offset.mul(room).div(room.add(abs(offset).mul(1.5)).add(0.00001)));
}

/**
 * Geometric specular anti-aliasing (Tokuyoshi & Kaplanyan 2019, "Improved Geometric
 * Specular Antialiasing"). Where the shading normal changes faster than one pixel can
 * resolve, a mirror-sharp lobe turns into single-pixel sparkle that temporal AA cannot
 * settle. Widening the GGX lobe by the screen-space variance of the normal converts that
 * sparkle into the roughness the pixel footprint really sees, and conserves energy.
 *
 * @param normal  world- or view-space shading normal (any consistent space)
 * @param alpha2  squared GGX roughness (α²) before filtering
 * @returns filtered α²
 */
export function specularAA(normal: N, alpha2: N, sigma2 = 0.25, kappa = 0.18): N {
  const dx = dFdx(normal), dy = dFdy(normal);
  const kernel = min(dot(dx, dx).add(dot(dy, dy)).mul(2 * sigma2), kappa);
  return alpha2.add(kernel).min(1);
}

/** Perceptual-roughness flavour of `specularAA` (roughness = sqrt(α)). */
export function specularAARoughness(normal: N, roughness: N, sigma2 = 0.25, kappa = 0.18): N {
  const alpha = roughness.mul(roughness);
  return specularAA(normal, alpha.mul(alpha), sigma2, kappa).sqrt().sqrt();
}

/**
 * Mikkelsen unparameterized screen-space derivative height-to-view-normal perturbation.
 * Works on any procedural world/triplanar height field on both WebGPU and WebGL 2 without UVs.
 */
export const perturbNormalHeight = Fn(([height, scale, surfNorm = normalView]: N[]) => {
  const surfPos = positionView;
  const vSigmaX = dFdx(surfPos);
  const vSigmaY = dFdy(surfPos);
  const R1 = cross(vSigmaY, surfNorm);
  const R2 = cross(surfNorm, vSigmaX);
  const fDet = dot(vSigmaX, R1).mul(faceDirection);
  const dHdx = dFdx(height).mul(scale);
  const dHdy = dFdy(height).mul(scale);
  const vGrad = sign(fDet).mul(R1.mul(dHdx).add(R2.mul(dHdy)));
  // Guard degenerate screen-space triangles so normalize never emits NaN.
  return normalize(surfNorm.mul(abs(fDet).add(1e-6)).sub(vGrad));
});
