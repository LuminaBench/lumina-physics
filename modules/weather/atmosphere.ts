/**
 * Physically based Rayleigh + Mie (+ ozone) single scattering.
 *
 * The same integrator exists twice on purpose:
 *  - `atmosphereLutNode()` – TSL, baked every frame into a small sky-view LUT that the sky
 *    dome, the reflection environment and aerial-perspective fog all sample.
 *  - `skyRadianceCPU()` / `sunTransmittanceCPU()` – JS mirror used to derive the sun
 *    colour, hemisphere ambient colours and fog tint without any GPU readback.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

const { Fn, float, vec2, vec3, Loop, int, exp, max, sqrt, dot, length, uv, cos, sin, pow, abs, acos, asin, normalize, If } = TSL;

export const ATMOSPHERE = {
  planetRadius: 6_360_000,
  atmosphereRadius: 6_440_000,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6] as const,
  rayleighHeight: 8000,
  mie: 3.996e-6,
  mieHeight: 1200,
  mieG: 0.8,
  ozone: [0.65e-6, 1.881e-6, 0.085e-6] as const,
  /** Sun irradiance at the top of the atmosphere in scene units (π·4 → sun-lit white ≈ 4). */
  sunIrradiance: 12.6,
};

export interface AtmosphereUniforms {
  /** Sun direction in LUT space: azimuth along +X, so only elevation matters. */
  sunElevation: N;
  /** Mie multiplier: 1 = crisp, 4 = hazy coastal air, 10+ = storm murk. */
  turbidity: N;
  cameraAltitude: N;
}

const _skyDir = new THREE.Vector3();
const _sumR = [0, 0, 0], _sumM = [0, 0, 0], _sumMS = [0, 0, 0], _tauV = [0, 0, 0];
const VIEW_STEPS = 16;
const LIGHT_STEPS = 6;

function raySphereFar(originY: number, dirY: number, radius: number): number {
  const b = originY * dirY;
  const c = originY * originY - radius * radius;
  const disc = b * b - c;
  return disc < 0 ? -1 : -b + Math.sqrt(disc);
}

// Low-order angular approximation for multiply scattered twilight. It is evaluated
// once per sky-LUT update and by the CPU hemisphere lights, including reflections.
const TWILIGHT_BELT = [0.38, 0.13, 0.17] as const;
const TWILIGHT_SHADOW = [0.018, 0.034, 0.092] as const;
const NIGHT_SKY = [0.0008, 0.0013, 0.0028] as const;

/** JS mirror of the shader integrator. Returns linear radiance for a unit direction. */
export function skyRadianceCPU(dir: THREE.Vector3, sunDir: THREE.Vector3, turbidity: number, out = new THREE.Color(), heightM = 50): THREE.Color {
  const A = ATMOSPHERE;
  const oy = A.planetRadius + Math.max(2,heightM);
  const d = _skyDir.copy(dir);
  if (d.y < 0.005) { d.y = 0.005; d.normalize(); }
  const tMax = raySphereFar(oy, d.y, A.atmosphereRadius);
  const sumR = _sumR.fill(0), sumM = _sumM.fill(0), sumMS = _sumMS.fill(0);
  const tauV = _tauV.fill(0);
  const mieS = A.mie * turbidity, mieE = mieS / 0.9;
  for (let i = 0; i < VIEW_STEPS; i++) {
    // Quadratic step distribution: fine near the eye where extinction changes fastest.
    const t0 = tMax * (i / VIEW_STEPS) ** 2, t1 = tMax * ((i + 1) / VIEW_STEPS) ** 2;
    const dt = t1 - t0, t = (t0 + t1) / 2;
    const px = d.x * t, py = oy + d.y * t, pz = d.z * t;
    const r = Math.hypot(px, py, pz);
    const h = r - A.planetRadius;
    const dR = Math.exp(-h / A.rayleighHeight), dM = Math.exp(-h / A.mieHeight), dO = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    // Light path.
    const b = px * sunDir.x + py * sunDir.y + pz * sunDir.z;
    const cG = r * r - A.planetRadius * A.planetRadius;
    const lit = !(b < 0 && b * b - cG > 0); // sun above the local horizon
    let lR = 0, lM = 0, lO = 0;
    if (lit) {
      const tL = -b + Math.sqrt(Math.max(0, b * b - (r * r - A.atmosphereRadius * A.atmosphereRadius)));
      const dl = tL / LIGHT_STEPS;
      for (let j = 0; j < LIGHT_STEPS; j++) {
        const s = (j + 0.5) * dl;
        const hh = Math.hypot(px + sunDir.x * s, py + sunDir.y * s, pz + sunDir.z * s) - A.planetRadius;
        lR += Math.exp(-hh / A.rayleighHeight) * dl; lM += Math.exp(-hh / A.mieHeight) * dl; lO += Math.max(0, 1 - Math.abs(hh - 25000) / 15000) * dl;
      }
    }
    for (let c = 0; c < 3; c++) {
      const sigma = A.rayleigh[c] * dR + mieE * dM + A.ozone[c] * dO;
      const stepT = Math.exp(-sigma * dt);
      // Analytic in-step integration: exact for a homogeneous slab, never over-shoots.
      const weight = (Math.exp(-tauV[c]) * (1 - stepT)) / Math.max(sigma, 1e-12);
      // Light scattered out of the sun path is mostly re-scattered, not absorbed: count 45 %.
      const attL = lit ? Math.exp(-(A.rayleigh[c] * lR * 0.45 + mieE * lM * 0.45 + A.ozone[c] * lO)) : 0;
      sumR[c] += dR * attL * weight;
      sumM[c] += dM * attL * weight;
      sumMS[c] += (A.rayleigh[c] * dR + mieS * dM) * weight;
      tauV[c] += sigma * dt;
    }
  }
  const mu = d.dot(sunDir);
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = A.mieG;
  const phaseM = (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  const E = A.sunIrradiance;
  const ms = 1.1;
  const msGain = 0.042 * (THREE.MathUtils.smoothstep(sunDir.y, -0.12, 0.35) * 0.9 + 0.1);
  const sy = sunDir.y;
  const twilight = THREE.MathUtils.smoothstep(sy, -0.20, -0.045) * (1 - THREE.MathUtils.smoothstep(sy, -0.012, 0.075));
  const opposite = THREE.MathUtils.smoothstep(-(d.x * sunDir.x + d.z * sunDir.z), -0.16, 0.92);
  const height = 0.11 + Math.max(0, -sy) * 1.45;
  const belt = twilight * opposite * Math.exp(-(((d.y - height) / 0.095) ** 2));
  const shadow = twilight * opposite * (1 - THREE.MathUtils.smoothstep(d.y, height * 0.36, height));
  const secondary = THREE.MathUtils.smoothstep(sy, -0.24, -0.025);
  const night = 1 - secondary;
  out.setRGB(
    E * ms * (sumR[0] * A.rayleigh[0] * phaseR + sumM[0] * mieS * phaseM + sumMS[0] * msGain * secondary),
    E * ms * (sumR[1] * A.rayleigh[1] * phaseR + sumM[1] * mieS * phaseM + sumMS[1] * msGain * secondary),
    E * ms * (sumR[2] * A.rayleigh[2] * phaseR + sumM[2] * mieS * phaseM + sumMS[2] * msGain * secondary),
  );
  out.r += TWILIGHT_BELT[0] * belt + TWILIGHT_SHADOW[0] * shadow + NIGHT_SKY[0] * night;
  out.g += TWILIGHT_BELT[1] * belt + TWILIGHT_SHADOW[1] * shadow + NIGHT_SKY[1] * night;
  out.b += TWILIGHT_BELT[2] * belt + TWILIGHT_SHADOW[2] * shadow + NIGHT_SKY[2] * night;
  return out;
}

/** Direct solar irradiance. An explicit sample altitude (metres) uses the curved planetary horizon. */
export function sunTransmittanceCPU(sunDir: THREE.Vector3, turbidity: number, out = new THREE.Color(), heightM?: number): THREE.Color {
  const A = ATMOSPHERE;
  const oy = A.planetRadius + (heightM === undefined ? 50 : Math.max(0, heightM));
  const dy = heightM === undefined ? Math.max(sunDir.y, -0.02) : sunDir.y;
  // A ray below the geometric horizon intersects the ground before it exits the air.
  if (heightM !== undefined && dy < 0 && oy * oy * (1 - dy * dy) <= A.planetRadius ** 2) return out.setRGB(0, 0, 0);
  const horiz = Math.sqrt(Math.max(0, 1 - dy * dy));
  const tMax = raySphereFar(oy, dy, A.atmosphereRadius);
  const steps = 24, dl = tMax / steps;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dl;
    const h = Math.hypot(horiz * s, oy + dy * s) - A.planetRadius;
    odR += Math.exp(-h / A.rayleighHeight) * dl; odM += Math.exp(-h / A.mieHeight) * dl; odO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dl;
  }
  const mieE = (A.mie * turbidity) / 0.9;
  // Fade the disc out as it sinks under the horizon.
  const horizonFade = heightM === undefined ? THREE.MathUtils.smoothstep(sunDir.y, -0.04, 0.02) : 1;
  return out.setRGB(
    Math.exp(-(A.rayleigh[0] * odR + mieE * odM + A.ozone[0] * odO)) * A.sunIrradiance * horizonFade,
    Math.exp(-(A.rayleigh[1] * odR + mieE * odM + A.ozone[1] * odO)) * A.sunIrradiance * horizonFade,
    Math.exp(-(A.rayleigh[2] * odR + mieE * odM + A.ozone[2] * odO)) * A.sunIrradiance * horizonFade,
  );
}

/** LUT parametrisation: u = azimuth from the sun (0..π), v = √(elevation / 90°). */
export const skyLutUV = Fn(([dir, sunDir]: N[]) => {
  const elevation = asin(dir.y.clamp(0, 1));
  const v = sqrt(elevation.div(Math.PI / 2));
  const flat = normalize(vec2(dir.x, dir.z).add(vec2(1e-5, 0)));
  const sunFlat = normalize(vec2(sunDir.x, sunDir.z).add(vec2(1e-5, 0)));
  const u = acos(dot(flat, sunFlat).clamp(-1, 1)).div(Math.PI);
  // Half-texel inset keeps bilinear taps inside the table.
  return vec2(u.mul(254 / 256).add(1 / 256), v.mul(126 / 128).add(1 / 128));
});

/** Fragment node that integrates the atmosphere for one LUT texel. */
export function atmosphereLutNode(u: AtmosphereUniforms): N {
  const A = ATMOSPHERE;
  return Fn(() => {
    const st = uv();
    const lu = st.x.sub(1 / 256).div(254 / 256).clamp(0, 1);
    const lv = st.y.sub(1 / 128).div(126 / 128).clamp(0, 1);
    const elevation = lv.mul(lv).mul(Math.PI / 2);
    const azimuth = lu.mul(Math.PI);
    const dir = vec3(cos(elevation).mul(cos(azimuth)), sin(elevation).max(0.004), cos(elevation).mul(sin(azimuth))).normalize();
    const sun = vec3(cos(u.sunElevation), sin(u.sunElevation), 0);
    const origin = vec3(0, float(A.planetRadius).add(u.cameraAltitude.max(2)), 0);

    const b = dot(origin, dir);
    const c = dot(origin, origin).sub(A.atmosphereRadius * A.atmosphereRadius);
    const tMax = b.negate().add(sqrt(max(b.mul(b).sub(c), 0)));
    const mieS = float(A.mie).mul(u.turbidity);
    const mieE = mieS.div(0.9);
    const betaR = vec3(...A.rayleigh);
    const betaO = vec3(...A.ozone);

    const tauV = vec3(0).toVar();
    const sumR = vec3(0).toVar();
    const sumM = vec3(0).toVar();
    const sumMS = vec3(0).toVar();
    Loop({ start: int(0), end: int(VIEW_STEPS), type: 'int', condition: '<', name: 'vi' }, ({ vi }: N) => {
      // Quadratic step distribution: fine near the eye where extinction changes fastest.
      const f0 = float(vi).div(VIEW_STEPS), f1 = float(vi).add(1).div(VIEW_STEPS);
      const t0 = tMax.mul(f0).mul(f0), t1 = tMax.mul(f1).mul(f1);
      const dt = t1.sub(t0);
      const p = origin.add(dir.mul(t0.add(t1).mul(0.5))).toVar();
      const r = length(p);
      const h = r.sub(A.planetRadius);
      const dens = vec3(exp(h.div(-A.rayleighHeight)), exp(h.div(-A.mieHeight)), max(float(1).sub(abs(h.sub(25000)).div(15000)), 0)).toVar();
      const sigma = betaR.mul(dens.x).add(vec3(mieE).mul(dens.y)).add(betaO.mul(dens.z)).toVar();
      // Analytic in-step integration: exact for a homogeneous slab, never over-shoots.
      const weight = exp(tauV.negate()).mul(vec3(1).sub(exp(sigma.mul(dt).negate()))).div(max(sigma, vec3(1e-12))).toVar();
      sumMS.addAssign(betaR.mul(dens.x).add(vec3(mieS).mul(dens.y)).mul(weight));
      const lb = dot(p, sun);
      const groundDisc = lb.mul(lb).sub(r.mul(r).sub(A.planetRadius * A.planetRadius));
      If(lb.greaterThanEqual(0).or(groundDisc.lessThanEqual(0)), () => {
        const tL = lb.negate().add(sqrt(max(lb.mul(lb).sub(r.mul(r).sub(A.atmosphereRadius * A.atmosphereRadius)), 0)));
        const dl = tL.div(LIGHT_STEPS);
        const odL = vec3(0).toVar();
        Loop({ start: int(0), end: int(LIGHT_STEPS), type: 'int', condition: '<', name: 'li' }, ({ li }: N) => {
          const hh = length(p.add(sun.mul(float(li).add(0.5).mul(dl)))).sub(A.planetRadius);
          odL.addAssign(vec3(exp(hh.div(-A.rayleighHeight)), exp(hh.div(-A.mieHeight)), max(float(1).sub(abs(hh.sub(25000)).div(15000)), 0)).mul(dl));
        });
        // Light scattered out of the sun path is mostly re-scattered, not absorbed: count 45 %.
        const attL = exp(betaR.mul(odL.x.mul(0.45)).add(vec3(mieE).mul(odL.y.mul(0.45))).add(betaO.mul(odL.z)).negate());
        sumR.addAssign(attL.mul(weight).mul(dens.x));
        sumM.addAssign(attL.mul(weight).mul(dens.y));
      });
      tauV.addAssign(sigma.mul(dt));
    });
    const mu = dot(dir, sun);
    const phaseR = mu.mul(mu).add(1).mul(3 / (16 * Math.PI));
    const g = A.mieG;
    const phaseM = float((3 / (8 * Math.PI)) * (1 - g * g)).mul(mu.mul(mu).add(1))
      .div(float(2 + g * g).mul(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5)));
    const msGain = float(0.042).mul(TSL.smoothstep(-0.12, 0.35, sin(u.sunElevation)).mul(0.9).add(0.1));
    const sy = sun.y;
    const twilight = TSL.smoothstep(-0.20, -0.045, sy).mul(TSL.smoothstep(-0.012, 0.075, sy).oneMinus());
    const opposite = TSL.smoothstep(-0.16, 0.92, dot(dir.xz, sun.xz).negate());
    const height = sy.negate().max(0).mul(1.45).add(0.11);
    const fromBelt = dir.y.sub(height).div(0.095);
    const belt = twilight.mul(opposite).mul(exp(fromBelt.mul(fromBelt).negate()));
    const shadow = twilight.mul(opposite).mul(TSL.smoothstep(height.mul(0.36), height, dir.y).oneMinus());
    const secondary = TSL.smoothstep(-0.24, -0.025, sy);
    const radiance = sumR.mul(betaR).mul(phaseR).add(sumM.mul(mieS).mul(phaseM)).add(sumMS.mul(msGain).mul(secondary)).mul(A.sunIrradiance * 1.1)
      .add(vec3(...TWILIGHT_BELT).mul(belt)).add(vec3(...TWILIGHT_SHADOW).mul(shadow)).add(vec3(...NIGHT_SKY).mul(secondary.oneMinus()));
    return TSL.vec4(radiance, 1);
  })();
}
