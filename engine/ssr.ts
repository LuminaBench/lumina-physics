/**
 * In-material screen-space reflections.
 *
 * Reflective surfaces that render in the transparent pass (ocean, wet asphalt) call
 * `traceReflection` from their own fragment shader and *mix* the hit over their
 * environment reflection. Compared with a post-process SSR this means:
 *   - hits occlude the sky reflection (a dark car body blocks bright cloud in a puddle),
 *   - the surface keeps full control over Fresnel / roughness weighting,
 *   - no extra G-buffer attachments are needed.
 * Rays are jittered per frame and resolved by TRAA; a short binary refinement sharpens
 * contact so mirror puddles stay crisp.
 */
import { TSL, type N } from './tsl';
import { viewportDepthAt } from './shading';
import { frame } from './frame';
import { temporalIGN } from './noise';

const {
  Fn, If, Loop, Break, int, float, vec2, vec4, cameraViewMatrix, cameraProjectionMatrix, cameraNear, cameraFar, getScreenPositionFromClip,
   viewportSharedTexture, perspectiveDepthToViewZ, screenCoordinate, screenSize, min, max, smoothstep, abs,
} = TSL;

export interface ReflectionTraceOptions {
  /** Ray-march step count (uniform node or number). */
  steps: N | number;
  /** Maximum world-space ray length in metres. */
  maxDistance?: number;
  /** Ratio between successive steps. Longer traces use faster growth to retain contact detail. */
  growth?: number;
  /** Depth tolerance behind a surface that still counts as a hit, as a fraction of ray depth. */
  thickness?: number;
  /** Minimum allowed depth residual, in metres, at the reflecting surface. */
  contactTolerance?: number;
}

/** Visibility between a water fragment and a nearby light. An opaque bank,
 * deck or hull between the two attenuates the reflected firelight. Samples
 * outside the camera frame carry no information and leave the light visible. */
export function localLightVisibility(position: N, light: N): N {
  return Fn(() => {
    const start = cameraViewMatrix.mul(vec4(position, 1)), end = cameraViewMatrix.mul(vec4(light, 1));
    const clip = cameraProjectionMatrix.mul(start), clipEnd = cameraProjectionMatrix.mul(end);
    const visibility = float(1).toVar();
    for (const t of [0.18, 0.37, 0.62, 0.84]) {
      const uv = getScreenPositionFromClip(TSL.mix(clip, clipEnd, t));
      const z = TSL.mix(start.z, end.z, t);
      If(z.lessThan(-0.1).and(uv.greaterThan(0).all()).and(uv.lessThan(1).all()), () => {
        const depth = perspectiveDepthToViewZ(viewportDepthAt(uv), cameraNear, cameraFar);
        const gap = depth.sub(z);
        // A thin occluder can sit far in front of an unrelated point in the
        // image. Limit that ambiguity to a local, metre-scale depth interval.
        const blocked = smoothstep(0.035, 0.15, gap).mul(smoothstep(2.6, 0.8, gap));
        visibility.assign(min(visibility, float(1).sub(blocked)));
      });
    }
    return visibility;
  })();
}

/** Returns vec4(hitColour, hitWeight). `hitWeight` already includes screen-edge fade. */
export function traceReflection(worldPosition: N, reflectDir: N, options: ReflectionTraceOptions): N {
  const maxDistance = options.maxDistance ?? 120;
  const thickness = options.thickness ?? 0.12;
  return Fn(() => {
    const result = vec4(0).toVar();
    const steps = float(options.steps as any);
    const jitter = temporalIGN(screenCoordinate.xy.add(vec2(17, 59)), frame.frameIndex);
    // Geometric step growth: dense near the surface (contact), sparse far away.
    const growth = float(options.growth ?? 1.12);
    // Transform the ray once. Clip position stays affine in distance until
    // perspective division, including off-axis and jittered camera projections.
    const viewOrigin = cameraViewMatrix.mul(vec4(worldPosition, 1)).toVar();
    const viewDir = cameraViewMatrix.mul(vec4(reflectDir, 0)).toVar();
    const clipOrigin = cameraProjectionMatrix.mul(viewOrigin).toVar();
    const clipDir = cameraProjectionMatrix.mul(viewDir).toVar();
    const uvAt = (dist: N): N => getScreenPositionFromClip(clipOrigin.add(clipDir.mul(dist)));
    const viewZAt = (dist: N): N => viewOrigin.z.add(viewDir.z.mul(dist));

    // Projected ray speed in pixels per metre. Subpixel probes would fetch
    // the same depth texel repeatedly near the start of a long grazing trace.
    const speed = abs(clipDir.xy.mul(clipOrigin.w).sub(clipOrigin.xy.mul(clipDir.w)))
      .mul(screenSize).div(clipOrigin.w.mul(clipOrigin.w).max(0.0001)).mul(0.5);
    const footprint = float(0.55).div(max(speed.x, speed.y).max(0.1)).min(0.8);
    const stepLen = float(maxDistance).mul(growth.sub(1)).div(growth.pow(steps).sub(1)).max(footprint).toVar();
    const t = stepLen.mul(jitter.mul(0.9).add(0.1)).toVar();
    const lastT = float(0).toVar(), hit = float(0).toVar(), hitUV = vec2(0).toVar();

    Loop({ start: int(0), end: int(steps), type: 'int', condition: '<', name: 'ri' }, () => {
      If(t.greaterThan(maxDistance), () => { Break(); });
      const uvS = uvAt(t).toVar(), rayZ = viewZAt(t).toVar();
      // Leaving the screen (or going behind the camera) ends the trace.
      If(uvS.x.lessThan(0).or(uvS.x.greaterThan(1)).or(uvS.y.lessThan(0)).or(uvS.y.greaterThan(1)).or(rayZ.greaterThan(-0.05)), () => { Break(); });
      const sceneZ = perspectiveDepthToViewZ(viewportDepthAt(uvS), cameraNear, cameraFar);
      const behind = sceneZ.sub(rayZ);
      If(behind.greaterThan(0).and(behind.lessThan(abs(rayZ).mul(thickness).add(stepLen.mul(1.5)))), () => {
        hit.assign(1);
        hitUV.assign(uvS);
        Break();
      });
      lastT.assign(t);
      t.addAssign(stepLen);
      stepLen.mulAssign(growth);
    });

    If(hit.greaterThan(0.5), () => {
      // Binary refinement between the last miss and the first hit.
      const lo = lastT.toVar();
      const hi = t.toVar();
      Loop({ start: int(0), end: int(5), type: 'int', condition: '<', name: 'bi' }, () => {
        const mid = lo.add(hi).mul(0.5);
        const uvMid = uvAt(mid).toVar();
        const sceneZ = perspectiveDepthToViewZ(viewportDepthAt(uvMid), cameraNear, cameraFar);
        If(sceneZ.sub(viewZAt(mid)).greaterThan(0), () => { hi.assign(mid); hitUV.assign(uvMid); }).Else(() => { lo.assign(mid); });
      });
      const edge = min(min(hitUV.x, float(1).sub(hitUV.x)), min(hitUV.y, float(1).sub(hitUV.y)));
      // Silhouette jumps are screen-space discontinuities. Refining a bracket
      // across one can leave the candidate many metres behind the object,
      // especially when a small aircraft crosses distant water. Reject those
      // samples using travel from the reflector rather than camera distance.
      const surfaceZ = perspectiveDepthToViewZ(viewportDepthAt(hitUV), cameraNear, cameraFar);
      const gap = abs(surfaceZ.sub(viewZAt(hi)));
      const tolerance = min(hi, 32).mul(thickness).add(options.contactTolerance ?? 0.22);
      const contact = smoothstep(tolerance, tolerance.mul(0.3), gap);
      const fade = smoothstep(0.0, 0.07, edge).mul(smoothstep(maxDistance, maxDistance * 0.6, hi)).mul(contact);
      result.assign(vec4(viewportSharedTexture(hitUV).rgb, fade));
    });
    return result;
  })();
}

export { max as _max };
