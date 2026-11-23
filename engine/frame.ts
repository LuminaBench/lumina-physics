/**
 * Per-frame shared uniforms (time, sun, temporal reprojection matrices).
 *
 * These are module-level singletons on purpose: every material in every module shares the
 * same uniform nodes, so toggling a scene or a quality tier never invalidates them.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from './tsl';

const { uniform, Fn, vec4, vec2, mrt } = TSL;

export const frame = {
  /** Simulation time in seconds. */
  time: uniform(0) as N,
  delta: uniform(1 / 60) as N,
  frameIndex: uniform(0) as N,
  /** Unit vector pointing *toward* the sun. */
  sunDirection: uniform(new THREE.Vector3(0.4, 0.6, 0.3).normalize()) as N,
  /** Linear HDR sun radiance after atmospheric transmittance. */
  sunColor: uniform(new THREE.Color(1, 0.95, 0.85)) as N,
  /**
   * 0..1 large-scale direct-sun visibility (overcast decks block it). Effects that cannot
   * afford a per-fragment cloud-shadow march (sprites, ribbons) multiply the sun by this.
   */
  sunVisibility: uniform(1) as N,
  /** Extinction at 2, 6 and 12 km. Weather updates these only when sky lighting changes. */
  elevatedSun: [2000, 6000, 12000].map(() => uniform(new THREE.Color(1, 0.95, 0.85)) as N),
  /** Heights in metres where the upper and lower solar limbs emerge from planetary shadow. */
  sunShadowHeights: uniform(new THREE.Vector2(-2, -1)) as N,
  /** Hemispherical sky irradiance approximations used by custom-lit materials. */
  skyZenith: uniform(new THREE.Color(0.15, 0.3, 0.6)) as N,
  skyHorizon: uniform(new THREE.Color(0.6, 0.7, 0.8)) as N,
  /** Unjittered view-projection matrices of the current and previous frame. */
  viewProjection: uniform(new THREE.Matrix4()) as N,
  previousViewProjection: uniform(new THREE.Matrix4()) as N,
  /**
   * 0.85..1 amplitude of temporal raymarch jitter. Eased slightly while the camera turns or zooms
   * quickly (less TRAA history); going lower trades grain for visible slice banding.
   */
  jitterScale: uniform(1) as N,
  /** Additive HDR flash (lightning, high-explosive detonations). */
  flash: uniform(new THREE.Color(0, 0, 0)) as N,
};

/** Direct irradiance for airborne condensate at height above the game's sea-level datum. */
export function sunlightAtHeight(height: N): N {
  const h = height.max(0);
  const [low, mid, high] = frame.elevatedSun;
  const irradiance = TSL.mix(frame.sunColor, low, h.div(2000).saturate())
    .add(mid.sub(low).mul(h.sub(2000).div(4000).saturate()))
    .add(high.sub(mid).mul(h.sub(6000).div(6000).saturate()));
  return irradiance.mul(TSL.smoothstep(frame.sunShadowHeights.x, frame.sunShadowHeights.y, h));
}

const _vp = new THREE.Matrix4();
const _forward = new THREE.Vector3();
const _previousForward = new THREE.Vector3(0, 0, -1);
let _previousFov = 50;
let _hasPrevious = false;

/** Advance shared uniforms. Call once per frame before rendering, with an unjittered camera. */
export function updateFrameUniforms(camera: THREE.PerspectiveCamera, time: number, delta: number): void {
  frame.time.value = time;
  frame.delta.value = delta;
  frame.frameIndex.value = (frame.frameIndex.value + 1) % 1024;
  camera.updateMatrixWorld();
  _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (_hasPrevious) frame.previousViewProjection.value.copy(frame.viewProjection.value);
  else frame.previousViewProjection.value.copy(_vp);
  frame.viewProjection.value.copy(_vp);
  _hasPrevious = true;
  // Angular speed of the view (rotation + zoom), in screen heights per second.
  camera.getWorldDirection(_forward);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const turn = _forward.angleTo(_previousForward) / Math.max(fovRad, 0.05) + Math.abs(camera.fov - _previousFov) / Math.max(camera.fov, 1);
  const speed = turn / Math.max(delta, 1e-3);
  const target = 1 - 0.15 * THREE.MathUtils.smoothstep(speed, 0.08, 0.9);
  frame.jitterScale.value += (target - frame.jitterScale.value) * 0.25;
  _previousForward.copy(_forward);
  _previousFov = camera.fov;
}

/**
 * Screen-space motion vector for vertex-animated geometry (ocean, sky dome, GPU sprites).
 * Three's built-in `velocity` node only knows object matrices; anything displaced in the
 * vertex stage must supply its own current / previous world position.
 */
export const screenVelocity = Fn(([worldPosition, previousWorldPosition]: N[]) => {
  const current = frame.viewProjection.mul(vec4(worldPosition, 1.0));
  const previous = frame.previousViewProjection.mul(vec4(previousWorldPosition, 1.0));
  return current.xy.div(current.w).sub(previous.xy.div(previous.w));
});

/**
 * MRT override for blended (transparent / additive) materials: alpha 0 leaves the
 * normal and velocity attachments untouched so sprites never corrupt TRAA or GTAO inputs.
 */
export function auxPassthrough(): N {
  return mrt({ normal: vec4(0, 0, 0, 0), velocity: vec4(0, 0, 0, 0) });
}

/** MRT override for custom-displaced opaque surfaces. */
export function auxSurface(normalViewNode: N, velocityNode: N): N {
  return mrt({ normal: vec4(normalViewNode, 1), velocity: vec4(velocityNode, 0, 1) });
}

export { vec2 as _vec2 };
