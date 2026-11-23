/**
 * Underwater rendering for an `Ocean`.
 *
 *   waterline   Per pixel: is the *lens* (a plane just beyond the near plane) below the
 *               local water surface? The CPU ocean twin gives the surface height and tilt
 *               at the camera, so a half-submerged camera shows both worlds split by a
 *               moving meniscus line instead of popping between two looks.
 *   medium      Beer–Lambert extinction over the real scene depth with the ocean's own
 *               absorption coefficients (red dies first), converging to the same
 *               `scatter × downwelling` colour the surface shader uses for deep water.
 *   god rays    Sun shafts: the view ray is marched and each sample asks how much light
 *               the moving caustic network lets through at the point where its sun path
 *               crosses the surface.
 *   surface     `Ocean` shades its underside itself (Snell's window + total internal
 *               reflection); this module only tells it when the camera is below.
 *   bubbles     GPU micro-bubbles that rise, wobble and die at the surface.
 *
 * The medium and the god rays are a pipeline `scene` effect (pre-resolve, internal
 * resolution, no extra render target); the gentle refraction wobble is a `distort` hook.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { valueNoise2, temporalIGN } from '../../engine/noise';
import { ParticleSystem } from '../../engine/particles';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { QualityPreset } from '../../engine/quality';
import type { Ocean } from './ocean';

const {
  Fn, If, float, vec2, vec3, vec4, uniform, normalize, dot, max, min, exp, mix, smoothstep, sin, cos, abs, pow, length,
  perspectiveDepthToViewZ, screenCoordinate,
} = TSL;

/** Ratio of sideways in-water radiance to the upwelling radiance seen from above the surface. */
const HORIZONTAL_GAIN = 4.2;

const _m = new THREE.Matrix4();
const _forward = new THREE.Vector3();
const _p = new THREE.Vector3();

export interface UnderwaterParams {
  /** Multiplier on the water's extinction (1 = the ocean's own clarity). */
  fog: number;
  /** God-ray strength. */
  rays: number;
  /** Ambient micro-bubble density multiplier. */
  bubbles: number;
  /** Refraction wobble of the underwater image. */
  wobble: number;
  /** Meniscus band thickness, refraction and highlight strength (0 disables the meniscus band). */
  meniscus: number;
}

export class Underwater implements EngineModule {
  readonly params: UnderwaterParams = { fog: 1, rays: 1, bubbles: 1, wobble: 1, meniscus: 1 };
  /** Metres of water above the camera (negative while above the surface). */
  depth = -1;
  /** True while the lens centre is below the surface. */
  submerged = false;
  /** Number of dives / surfacings since creation (QA, game logic). */
  dives = 0;
  onSubmerge: (() => void) | null = null;
  onSurface: (() => void) | null = null;
  bubbles!: ParticleSystem;

  private uActive = uniform(0);
  /** x: surface height at the camera, yz: surface slope dY/dX, dY/dZ (fallback/diagnostic). */
  private uSurface = uniform(new THREE.Vector3());
  private uCam = uniform(new THREE.Vector3());
  private uForward = uniform(new THREE.Vector3(0, 0, -1));
  private uInvVP = uniform(new THREE.Matrix4());
  private uNearFar = uniform(new THREE.Vector2(0.3, 60000));
  private uLens = uniform(0.5);
  /** Direction from a point under water toward where its sunlight entered the surface. */
  private uSunPath = uniform(new THREE.Vector3(0, 1, 0));
  private uFog = uniform(1);
  private uFloorDepth = uniform(1000);
  private uRays = uniform(1);
  private uWobble = uniform(1);
  private uMeniscus = uniform(1);
  private steps = -1;
  private boundOceanVersion = -1;

  constructor(private engine: LuminaEngine, private ocean: Ocean) {
    this.setQuality(engine.quality.preset);
  }

  // ---- shader pieces -----------------------------------------------------------

  private rayDirection(ndc: N): N {
    const far = this.uInvVP.mul(vec4(ndc, 0.5, 1));
    return normalize(far.xyz.div(far.w).sub(this.uCam));
  }

  /**
   * Signed metres of water above the near-plane lens point seen through this pixel (> 0 = under).
   * Evaluates the ocean's exact GPU displaced surface (`ocean.surfaceHeightNode`) at the
   * pixel's near-plane world XZ so the split follows every live wave crest, trough, wake
   * and tsunami deformation identically to the clipped ocean mesh, plus a micro capillary
   * meniscus wetting oscillation on the glass.
   */
  private submersion(direction: N, ndc: N): N {
    const lens = this.uCam.add(direction.mul(this.uLens.div(max(dot(direction, this.uForward), 0.05))));
    const rel = lens.xz.sub(this.uCam.xz);
    const surfaceY = this.ocean.surfaceHeightNode(lens.xz);
    // Surface-tension capillary adhesion & micro-ripple where the moving waterline wets the dome port.
    const t = frame.time;
    const capillary = sin(rel.x.mul(52).add(t.mul(2.6))).add(sin(rel.y.mul(41).sub(t.mul(1.9)))).mul(0.00095)
      .add(sin(ndc.x.mul(19).add(t.mul(3.4))).mul(0.00045));
    // Slight upward capillary climb toward the rim of a curved underwater lens port.
    const edgeClimb = ndc.x.mul(ndc.x).mul(0.0014).mul(this.uMeniscus);
    return surfaceY.add(capillary.mul(this.uMeniscus)).add(edgeClimb).sub(lens.y);
  }

  /**
   * Light let through by the surface at a world XZ: wave lensing concentrates sunlight into
   * a moving network of bright sheets (the same thing that draws caustics on the seabed).
   */
  private beams(xz: N): N {
    const t = frame.time;
    const a = valueNoise2(xz.mul(0.36).add(vec2(t.mul(0.11), t.mul(0.06))));
    const b = valueNoise2(xz.mul(0.83).sub(vec2(t.mul(0.17), t.mul(-0.13))).add(7.7));
    // Ridges of the noise field = focal lines.
    const ridge = float(1).sub(abs(a.mul(0.65).add(b.mul(0.35)).mul(2).sub(1)));
    return pow(ridge, 3.5).mul(2.6);
  }

  private register(steps: number, force = false): void {
    if (!force && steps === this.steps && this.boundOceanVersion === this.ocean.rebuildVersion) return;
    this.steps = steps;
    this.boundOceanVersion = this.ocean.rebuildVersion;
    const pipeline = this.engine.pipeline;
    const ocean = this.ocean;
    pipeline.addEffect({
      id: 'underwater',
      order: 0,
      scene: ({ color, depth, uv: st, ndc }) => Fn(() => {
        const out = vec3(color).toVar();
        If(this.uActive.greaterThan(0.5), () => {
          const direction = this.rayDirection(ndc);
          const sd = this.submersion(direction, ndc);
          const bandWidth = float(0.0075).mul(this.uMeniscus).max(0.001);
          const under = smoothstep(-0.0018, 0.0018, sd);
          If(sd.greaterThan(bandWidth.negate()), () => {
            const viewZ = perspectiveDepthToViewZ(depth.sample(st).r, this.uNearFar.x, this.uNearFar.y).negate();
            const distance = min(viewZ.div(max(dot(direction, this.uForward), 0.05)), 400);
            const sigma = ocean.uniforms.absorption.mul(this.uFog).add(vec3(0.03, 0.022, 0.02).mul(this.uFog));
            const transmit = exp(sigma.mul(distance).negate());
            // Ambient light fades with the depth of the eye; looking up is brighter than down.
            const eyeDepth = max(this.uSurface.x.sub(this.uCam.y), 0);
            // Inside the medium the light field is far brighter sideways than the few percent
            // that well back up through the surface (which is what `waterColor` describes).
            const ambient = ocean.waterColor().mul(HORIZONTAL_GAIN).mul(exp(sigma.mul(eyeDepth).mul(-0.3))).mul(mix(0.55, 1.5, direction.y.mul(0.5).add(0.5)));
            // Sunlight reflected from a shallow bed illuminates the lower hemisphere.
            // A two-leg Beer path removes this sandy fill automatically over deep water.
            const floorDepth = max(this.uFloorDepth, 0);
            const sunY = max(frame.sunDirection.y, 0.15);
            const bedPath = floorDepth.div(sunY).add(max(floorDepth.sub(eyeDepth), 0));
            const bedLight = frame.sunColor.mul(frame.sunVisibility.mul(0.8).add(0.2)).mul(sunY)
              .mul(vec3(0.46, 0.42, 0.27)).mul(1 / Math.PI)
              .mul(exp(ocean.uniforms.absorption.mul(bedPath).negate()))
              .mul(float(0.7).sub(direction.y.mul(0.35)));
            const lit = vec3(color).mul(transmit).add(ambient.add(bedLight).mul(vec3(1).sub(transmit))).toVar();

            if (steps > 0) {
              If(under.greaterThan(0.001), () => {
                const reach = min(distance, 30);
                const jitter = temporalIGN(screenCoordinate.xy, frame.frameIndex);
                const shafts = float(0).toVar();
                const sigmaMean = dot(sigma, vec3(0.2, 0.45, 0.35));
                // All shafts are parallel to the refracted sun, so along a view ray the entry
                // point slides across the pattern at a constant rate. Looking along the shafts
                // the samples agree (visible rays fanning out from the sun); looking across
                // them the pattern is undersampled and really does average out, so it is
                // faded to its mean there instead of being left as noise.
                const slide = length(direction.xz.sub(this.uSunPath.xz.mul(direction.y.div(max(this.uSunPath.y, 0.2))))).mul(reach).div(steps);
                const coherent = smoothstep(2.6, 0.5, slide);
                for (let i = 0; i < steps; i++) {
                  const t = reach.mul(jitter.add(i)).div(steps);
                  const p = this.uCam.add(direction.mul(t));
                  const below = this.uSurface.x.sub(p.y);
                  // Where this sample's sunlight crossed the surface.
                  const entry = p.xz.add(this.uSunPath.xz.mul(max(below, 0).div(max(this.uSunPath.y, 0.2))));
                  const through = mix(float(0.55), this.beams(entry), coherent).mul(smoothstep(0.0, 0.25, below));
                  shafts.addAssign(through.mul(exp(sigmaMean.mul(t.add(max(below, 0).mul(0.7))).negate())));
                }
                // Water scatters strongly forward: the shafts glow when you look toward the light.
                const phase = pow(max(dot(direction, this.uSunPath), 0), 4).mul(0.85).add(0.15);
                const sun = frame.sunColor.mul(frame.sunVisibility.mul(0.85).add(0.15)).mul(max(frame.sunDirection.y, 0.05));
                lit.addAssign(sun.mul(vec3(0.46, 0.94, 0.88)).mul(shafts.mul(reach).div(steps)).mul(phase).mul(this.uRays).mul(0.015));
              });
            }

            // Physically layered glass meniscus where air and water meet on the lens port:
            //  - dark TIR absorption spine right at sd = 0,
            //  - pale sunlit / sky-reflecting upper capillary lip (just above sd = 0),
            //  - translucent emerald-cyan internal-refraction band just below sd = 0.
            const meniscusMask = smoothstep(0.0, 0.15, this.uMeniscus);
            const sCore = sd.div(bandWidth.mul(0.28));
            const sUpper = sd.add(bandWidth.mul(0.38)).div(bandWidth.mul(0.24));
            const sLower = sd.sub(bandWidth.mul(0.42)).div(bandWidth.mul(0.32));
            const tirCore = exp(sCore.mul(sCore).negate()).mul(meniscusMask);
            const upperLip = exp(sUpper.mul(sUpper).negate()).mul(meniscusMask);
            const lowerGlow = exp(sLower.mul(sLower).negate()).mul(meniscusMask);
            const skyGlint = mix(frame.skyHorizon, frame.skyZenith, 0.45)
              .add(frame.sunColor.mul(frame.sunVisibility).mul(pow(max(dot(direction, frame.sunDirection), 0), 8).mul(0.45).add(0.06)));
            const split = mix(vec3(color), lit, under);
            const menisColor = split
              .mul(float(1).sub(tirCore.mul(0.68)))
              .add(ambient.mul(vec3(0.75, 1.15, 1.1)).mul(lowerGlow.mul(0.48)))
              .add(skyGlint.mul(upperLip.mul(0.42)));
            out.assign(menisColor);
          });
        });
        return out;
      })(),
      distort: (_st: N, ndc: N) => Fn(() => {
        const offset = vec2(0).toVar();
        If(this.uActive.greaterThan(0.5), () => {
          const direction = this.rayDirection(ndc);
          const sd = this.submersion(direction, ndc);
          const under = smoothstep(-0.0018, 0.0018, sd);
          const t = frame.time;
          // Underwater medium refraction wobble.
          const wobble = vec2(sin(ndc.y.mul(17).add(t.mul(1.9))), cos(ndc.x.mul(13.5).sub(t.mul(1.6)))).mul(0.0014).mul(under).mul(this.uWobble);
          // Prismatic meniscus refraction band: curves the image strongly right across the
          // clinging water edge without disturbing the dry sky above.
          const bandWidth = float(0.0075).mul(this.uMeniscus).max(0.001);
          const normSd = sd.div(bandWidth);
          const meniscusEnv = exp(normSd.mul(normSd).mul(-2.2)).mul(smoothstep(0.0, 0.15, this.uMeniscus));
          const bend = vec2(sin(ndc.x.mul(14).add(t.mul(2.1))).mul(0.0022), normSd.mul(-0.011).sub(0.0035)).mul(meniscusEnv);
          offset.assign(wobble.add(bend));
        });
        return offset;
      })(),
    });
  }

  // ---- public API --------------------------------------------------------------

  /** A burst of bubbles (hull slam, diver, sinking debris, underwater blast). */
  burst(position: THREE.Vector3 | { x: number; y: number; z: number }, count = 120, radius = 0.6, speed = 0.8): void {
    this.bubbles.emit({ position, radius, velocity: { x: 0, y: 0.25, z: 0 }, spread: speed, life: 3.2, lifeJitter: 0.6, size: 0.014, sizeEnd: 0.03, count: Math.min(count, this.bubbles.capacity / 4) });
  }

  setQuality(preset: QualityPreset): void {
    const { renderer, wind, scene } = this.engine;
    // God-ray samples share the tier's light-shaft budget.
    this.register(Math.round(preset.clouds.shaftSteps * 0.65));
    this.bubbles?.dispose();
    this.bubbles = new ParticleSystem(renderer, wind, {
      capacity: Math.max(256, Math.min(4096, Math.floor(preset.particles.budget * 0.08))), shading: 'bubble',
      gravity: -0.13, drag: 3, turbulence: 0.7, windInfluence: 0, ceilingY: 0, opacity: 0.9, softness: 0.12, renderOrder: 26,
    });
    scene.add(this.bubbles.mesh);
  }

  update(dt: number): void {
    const { camera } = this.engine;
    const ocean = this.ocean;
    // Re-bind the pipeline effect if the ocean rebuilt its FFT displacement textures.
    if (this.boundOceanVersion !== ocean.rebuildVersion) {
      this.register(Math.max(0, this.steps), true);
    }
    const x = camera.position.x, z = camera.position.z;
    const h = ocean.heightAt(x, z);
    const span = 0.5;
    this.depth = h - camera.position.y;
    // Stay active whenever the near-plane lens can intersect a nearby crest or trough.
    const margin = Math.max(0.75, ocean.significantHeight * 0.55 + 0.45);
    const active = this.depth > -margin;
    this.uActive.value = active ? 1 : 0;
    ocean.uniforms.underView.value = active ? 1 : 0;
    if (active) {
      (this.uSurface.value as THREE.Vector3).set(h, (ocean.heightAt(x + span, z) - h) / span, (ocean.heightAt(x, z + span) - h) / span);
      (this.uCam.value as THREE.Vector3).copy(camera.position);
      camera.getWorldDirection(_forward);
      (this.uForward.value as THREE.Vector3).copy(_forward);
      (this.uInvVP.value as THREE.Matrix4).copy(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert());
      (this.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);
      this.uLens.value = camera.near;   // same clipping plane as the ocean mesh
      (ocean.uniforms.lensSurface.value as THREE.Vector3).copy(this.uSurface.value as THREE.Vector3);
      (ocean.uniforms.lensFrame.value as THREE.Vector4).set(_forward.x, _forward.y, _forward.z, this.uLens.value);
      // Refract the sun into the water (Snell, n = 1.333): shafts lean less than the sun does.
      const L = frame.sunDirection.value as THREE.Vector3;
      const eta = 1 / 1.333;
      const cosI = Math.max(L.y, 0.05);
      const cosT = Math.sqrt(1 - eta * eta * (1 - cosI * cosI));
      (this.uSunPath.value as THREE.Vector3).set(L.x * eta, cosT, L.z * eta).normalize();
      this.uFloorDepth.value = ocean.depthAt(x, z);
      this.uFog.value = this.params.fog;
      this.uRays.value = this.params.rays;
      this.uWobble.value = this.params.wobble;
      this.uMeniscus.value = this.params.meniscus;
    }

    const wasSubmerged = this.submerged;
    if (!wasSubmerged && this.depth > 0.03) this.submerged = true;
    else if (wasSubmerged && this.depth < -0.03) this.submerged = false;
    if (this.submerged !== wasSubmerged) {
      this.dives++;
      if (this.submerged) {
        this.burst(_p.copy(camera.position).addScaledVector(_forward, 0.8), 260, 0.9, 1.1);
        this.engine.events.emit('splash', { position: [camera.position.x, camera.position.y, camera.position.z], intensity: 0.55 });
        this.onSubmerge?.();
      } else {
        this.engine.lens.drench();
        this.engine.events.emit('splash', { position: [camera.position.x, camera.position.y, camera.position.z], intensity: 0.4 });
        this.onSurface?.();
      }
    }
    // Suspended micro-bubbles around the diver; they die at the local surface.
    this.bubbles.uniforms.ceilingY.value = h - 0.03;
    if (this.submerged && this.params.bubbles > 0) {
      _p.copy(camera.position).addScaledVector(_forward, 2.6);
      _p.y = Math.min(_p.y, h - 0.6);
      this.bubbles.emitRate('ambient', 70 * this.params.bubbles, dt, { position: _p, radius: 3.6, velocity: { x: 0, y: 0.12, z: 0 }, spread: 0.1, life: 4.5, lifeJitter: 0.6, size: 0.01, sizeEnd: 0.02 });
    }
    this.bubbles.update();
  }

  dispose(): void {
    this.engine.pipeline.removeEffect('underwater');
    this.ocean.uniforms.underView.value = 0;
    this.bubbles.dispose();
  }
}
