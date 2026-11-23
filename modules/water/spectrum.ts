/**
 * Directional ocean wave spectrum synthesis (JONSWAP wind sea + narrow-band swell).
 *
 * The sea state is described by physical inputs only – wind speed at 10 m, fetch, swell
 * height / period / heading and a chop factor – and is split into wavenumber bands, one
 * per FFT cascade, so large swells, wind chop and capillary ripples each get full grid
 * resolution without double-counting energy.
 *
 * Random phases come from an integer hash of the wavenumber index, so the identical sea
 * is produced at any grid resolution (tier switches do not re-roll the ocean) and by the
 * CPU buoyancy twin.
 */

export const GRAVITY = 9.81;
/**
 * The animation loops every `OCEAN_LOOP_SECONDS`: angular frequencies are quantised to
 * multiples of 2π / loop so `time mod loop` can be used, keeping float32 phase precision
 * on the GPU after hours of runtime.
 */
export const OCEAN_LOOP_SECONDS = 1200;
export const OMEGA_QUANTUM = (2 * Math.PI) / OCEAN_LOOP_SECONDS;

export interface OceanParams {
  /** Wind speed at 10 m in m/s. Drives JONSWAP energy and peak frequency. */
  windSpeed: number;
  /** Direction the wind blows toward, radians (0 = +X). */
  windDirection: number;
  /** Fetch in metres: distance the wind has blown over open water. */
  fetch: number;
  /** Significant height of the long-period swell in metres (0 disables). */
  swellHeight: number;
  /** Direction the swell travels toward, radians. */
  swellDirection: number;
  /** Swell peak period in seconds. */
  swellPeriod: number;
  /** Horizontal (Gerstner) displacement scale: 0 = rounded, 1 = sharp crests. */
  chop: number;
  /** Mean water depth for the dispersion relation (use ≥ 200 for deep ocean). */
  depth: number;
  /** Seed for the random phases. */
  seed: number;
}

export const OCEAN_PRESETS: Record<string, OceanParams> = {
  still: { windSpeed: 0, windDirection: 0, fetch: 100, swellHeight: 0, swellDirection: 0, swellPeriod: 7, chop: 0, depth: 30, seed: 7 },
  lagoon: { windSpeed: 3.2, windDirection: 0.6, fetch: 6000, swellHeight: 0.12, swellDirection: 0.9, swellPeriod: 7, chop: 0.75, depth: 30, seed: 7 },
  breeze: { windSpeed: 6.5, windDirection: 0.5, fetch: 60000, swellHeight: 0.5, swellDirection: 0.8, swellPeriod: 9, chop: 0.95, depth: 400, seed: 7 },
  swell: { windSpeed: 11, windDirection: 0.4, fetch: 280000, swellHeight: 3.2, swellDirection: 0.75, swellPeriod: 13, chop: 1.05, depth: 2000, seed: 7 },
  storm: { windSpeed: 21, windDirection: 0.3, fetch: 450000, swellHeight: 5.5, swellDirection: 0.55, swellPeriod: 14.5, chop: 1.18, depth: 3000, seed: 7 },
  hurricane: { windSpeed: 33, windDirection: 0.25, fetch: 600000, swellHeight: 8.5, swellDirection: 0.45, swellPeriod: 16, chop: 1.25, depth: 4000, seed: 7 },
};

export interface CascadeLayout {
  /** Tile length in metres. */
  length: number;
  /** Wavenumber band [kMin, kMax) owned by this cascade. */
  kMin: number;
  kMax: number;
}

/** Non-commensurate tile lengths and exclusive wavenumber bands for `count` cascades. */
export function cascadeLayout(resolution: number, count: number): CascadeLayout[] {
  const base = Math.min(1021, Math.max(251, resolution * 4 - 3));
  // Fewer cascades must each span a wider band; the ratio is capped so the next cascade's
  // lowest wavenumber stays below this cascade's Nyquist limit (no gap in the spectrum).
  const ratio = Math.min(resolution * 0.115, count >= 4 ? 6.07 : count === 3 ? 7.93 : 9.1);
  const lengths = Array.from({ length: count }, (_, c) => base / Math.pow(ratio, c));
  return lengths.map((length, c) => {
    const nyquist = (Math.PI * resolution) / length;
    // The next cascade starts at 4 wavelengths per tile so its tiling never shows.
    const next = c + 1 < count ? (2 * Math.PI * 4) / lengths[c + 1] : Infinity;
    const kMin = c === 0 ? 0 : (2 * Math.PI * 4) / length;
    return { length, kMin, kMax: Math.min(nyquist * 0.95, next) };
  });
}

const LGAMMA_C = new Float64Array([
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
]);
const TWO_PI = 2 * Math.PI;
const HALF_LOG_2PI = 0.5 * Math.log(TWO_PI);
const SQRT_2PI = Math.sqrt(TWO_PI);
const INV_TWO_SQRT_PI = 1 / (2 * Math.sqrt(Math.PI));

function lgamma(x: number): number {
  // Lanczos approximation.
  x -= 1;
  let a = LGAMMA_C[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LGAMMA_C[i] / (x + i);
  return HALF_LOG_2PI + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Normalisation of the cos^2s(θ/2) directional spreading function. */
function spreadNorm(s: number): number {
  return Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) * INV_TWO_SQRT_PI;
}

const SWELL_SPREAD = 38;
const SWELL_SPREAD_NORM = spreadNorm(SWELL_SPREAD);

function hash2(n: number, m: number, seed: number): number {
  let h = Math.imul(n + 0x7fff, 374761393) ^ Math.imul(m + 0x7fff, 668265263) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) + 0.5) / 4294967296;
}

export function dispersion(k: number, depth: number): number {
  return Math.sqrt(GRAVITY * k * Math.tanh(Math.min(k * depth, 20)));
}

/** Directional variance density Ψ(kx, kz) in m⁴ for the combined wind sea + swell. */
export function waveSpectrum(kx: number, kz: number, p: OceanParams): number {
  const k = Math.sqrt(kx * kx + kz * kz);
  if (k < 1e-6) return 0;
  const kd = k * p.depth;
  const th = Math.tanh(kd < 20 ? kd : 20);
  const omega = Math.sqrt(GRAVITY * k * th);
  const sech2 = 1 - th * th;
  const dOmegaDk = (GRAVITY * (th + kd * sech2)) / (2 * omega);
  const theta = Math.atan2(kz, kx);
  let psi = 0;

  // --- JONSWAP wind sea -------------------------------------------------------
  const U = p.windSpeed > 0.2 ? p.windSpeed : 0.2;
  const F = p.fetch > 100 ? p.fetch : 100;
  const alpha = (p.windSpeed <= 0 ? 0 : 0.076) * Math.pow((U * U) / (F * GRAVITY), 0.22);
  const omegaP = 22 * Math.pow((GRAVITY * GRAVITY) / (U * F), 1 / 3);
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const dOm = omega - omegaP;
  const sOmP = sigma * omegaP;
  const r = Math.exp(-(dOm * dOm) / (2 * sOmP * sOmP));
  const om2 = omega * omega;
  const omRatio = omegaP / omega;
  const omRatio2 = omRatio * omRatio;
  const S = ((alpha * GRAVITY * GRAVITY) / (om2 * om2 * omega)) * Math.exp(-1.25 * omRatio2 * omRatio2) * Math.pow(3.3, r);
  // Mitsuyasu-type spreading: narrow at the peak, broad for short waves.
  const ratio = omega / omegaP;
  const rawS = 14 * (ratio <= 1 ? ratio * ratio * ratio * ratio * ratio : Math.pow(ratio, -2.5));
  const s = rawS > 1.2 ? rawS : 1.2;
  const dWind = spreadNorm(s) * Math.pow(Math.abs(Math.cos((theta - p.windDirection) * 0.5)), 2 * s);
  // Viscous cut-off for the very shortest capillaries.
  const kc = k * 0.004;
  psi += S * dWind * Math.exp(-(kc * kc));

  // --- Swell: narrow Gaussian in frequency, tightly collimated -----------------
  if (p.swellHeight > 0.01) {
    const omegaS = TWO_PI / p.swellPeriod;
    const h4 = p.swellHeight * 0.25;
    const m0 = h4 * h4;
    const sw = 0.075 * omegaS;
    const dSw = omega - omegaS;
    const Ss = (m0 / (sw * SQRT_2PI)) * Math.exp(-(dSw * dSw) / (2 * sw * sw));
    psi += Ss * SWELL_SPREAD_NORM * Math.pow(Math.abs(Math.cos((theta - p.swellDirection) * 0.5)), 2 * SWELL_SPREAD);
  }
  return (psi * dOmegaDk) / k;
}

/**
 * Initial spectrum for one cascade on an N×N grid, laid out with the wavenumber origin at
 * (N/2, N/2). Each texel holds (h0(k).re, h0(k).im, h0(-k).re, h0(-k).im).
 */
export function buildInitialSpectrum(resolution: number, layout: CascadeLayout, cascadeIndex: number, params: OceanParams): Float32Array {
  const N = resolution;
  const halfN = N >> 1;
  const data = new Float32Array(N * N * 4);
  if (params.windSpeed <= 0 && params.swellHeight <= 0.01) return data;
  const dk = TWO_PI / layout.length;
  const dk2Half = (dk * dk) * 0.5;
  const kMin = layout.kMin > 1e-6 ? layout.kMin : 1e-6;
  const kMax = layout.kMax;
  const depth = params.depth;
  const windDir = params.windDirection;
  const swellDir = params.swellDirection;

  // Hoist sea-state invariants out of the N×N wavenumber loop.
  const U = params.windSpeed > 0.2 ? params.windSpeed : 0.2;
  const F = params.fetch > 100 ? params.fetch : 100;
  const alphaG2 = (params.windSpeed <= 0 ? 0 : 0.076) * Math.pow((U * U) / (F * GRAVITY), 0.22) * GRAVITY * GRAVITY;
  const omegaP = 22 * Math.pow((GRAVITY * GRAVITY) / (U * F), 1 / 3);
  const invOmegaP = 1 / omegaP;
  const inv2SigLo2 = 1 / (2 * 0.07 * 0.07 * omegaP * omegaP);
  const inv2SigHi2 = 1 / (2 * 0.09 * 0.09 * omegaP * omegaP);

  const hasSwell = params.swellHeight > 0.01;
  const omegaS = hasSwell ? TWO_PI / params.swellPeriod : 0;
  const h4 = params.swellHeight * 0.25;
  const sw = 0.075 * omegaS;
  const swellPeak = hasSwell ? ((h4 * h4) / (sw * SQRT_2PI)) * SWELL_SPREAD_NORM : 0;
  const inv2Sw2 = hasSwell ? 1 / (2 * sw * sw) : 0;

  const seedA = params.seed * 16 + cascadeIndex * 4;
  const seedB = seedA + 1;

  const writeAmp = (n: number, m: number, dst: number): void => {
    const kx = n * dk, kz = m * dk;
    const k = Math.sqrt(kx * kx + kz * kz);
    if (k < kMin || k >= kMax) return;

    const kd = k * depth;
    const th = Math.tanh(kd < 20 ? kd : 20);
    const omega = Math.sqrt(GRAVITY * k * th);
    const sech2 = 1 - th * th;
    const dOmegaDk = (GRAVITY * (th + kd * sech2)) / (2 * omega);
    const theta = Math.atan2(kz, kx);

    const dOm = omega - omegaP;
    const r = Math.exp(-(dOm * dOm) * (omega <= omegaP ? inv2SigLo2 : inv2SigHi2));
    const om2 = omega * omega;
    const omRatio = omegaP / omega;
    const omRatio2 = omRatio * omRatio;
    const S = (alphaG2 / (om2 * om2 * omega)) * Math.exp(-1.25 * omRatio2 * omRatio2) * Math.pow(3.3, r);
    const ratio = omega * invOmegaP;
    const rawS = 14 * (ratio <= 1 ? ratio * ratio * ratio * ratio * ratio : Math.pow(ratio, -2.5));
    const s = rawS > 1.2 ? rawS : 1.2;
    const dWind = spreadNorm(s) * Math.pow(Math.abs(Math.cos((theta - windDir) * 0.5)), 2 * s);
    const kc = k * 0.004;
    let psi = S * dWind * Math.exp(-(kc * kc));

    if (hasSwell) {
      const dSw = omega - omegaS;
      const Ss = swellPeak * Math.exp(-(dSw * dSw) * inv2Sw2);
      psi += Ss * Math.pow(Math.abs(Math.cos((theta - swellDir) * 0.5)), 2 * SWELL_SPREAD);
    }

    const spec = (psi * dOmegaDk) / k;
    const a = Math.sqrt(spec * dk2Half);
    const u1 = hash2(n, m, seedA);
    const u2 = hash2(n, m, seedB);
    const mag = Math.sqrt(-2 * Math.log(u1)) * a * Math.SQRT1_2;
    const phi = TWO_PI * u2;
    data[dst] = mag * Math.cos(phi);
    data[dst + 1] = mag * Math.sin(phi);
  };

  // Pass 1: compute h0(k) once per grid point (and h0(-k) directly only on the x=0 or y=0 border).
  for (let y = 0; y < N; y++) {
    const m = y - halfN;
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const n = x - halfN;
      const o = (row + x) * 4;
      writeAmp(n, m, o);
      if (x === 0 || y === 0) writeAmp(-n, -m, o + 2);
    }
  }
  // Pass 2: interior h0(-k) is already computed at the mirrored texel (N - x, N - y).
  for (let y = 1; y < N; y++) {
    const row = y * N;
    const mRow = (N - y) * N;
    for (let x = 1; x < N; x++) {
      const o = (row + x) * 4;
      const mo = (mRow + (N - x)) * 4;
      data[o + 2] = data[mo];
      data[o + 3] = data[mo + 1];
    }
  }
  return data;
}

/** Significant wave height (4·√m0) implied by a set of initial spectra – used for HUD + tuning. */
export function significantHeight(spectra: Float32Array[]): number {
  let m0 = 0;
  for (const s of spectra) for (let i = 0; i < s.length; i += 4) m0 += 2 * (s[i] * s[i] + s[i + 1] * s[i + 1]);
  return 4 * Math.sqrt(m0);
}
