/** Local vertical air column. Values outside the two sampled elevations use the nearest endpoint. */
export interface ClimateProfile {
  baseAltitude: number;
  topAltitude: number;
  baseTemperatureC: number;
  topTemperatureC: number;
  /** Relative humidity over ice, as ratios. Values above one are supersaturated. */
  baseIceHumidity: number;
  topIceHumidity: number;
  /** Surface relative humidity over liquid water (0..1), used for film drying. */
  surfaceHumidity: number;
}

export const CLIMATES = {
  humidCoast: { baseAltitude: 0, topAltitude: 11000, baseTemperatureC: 30, topTemperatureC: -54, baseIceHumidity: 0.75, topIceHumidity: 1.14, surfaceHumidity: 0.82 },
  dryHeat: { baseAltitude: 0, topAltitude: 12000, baseTemperatureC: 38, topTemperatureC: -52, baseIceHumidity: 0.28, topIceHumidity: 0.54, surfaceHumidity: 0.22 },
  coldFront: { baseAltitude: 0, topAltitude: 9500, baseTemperatureC: -7, topTemperatureC: -56, baseIceHumidity: 0.86, topIceHumidity: 1.2, surfaceHumidity: 0.78 },
} satisfies Record<string, ClimateProfile>;

export function validateClimate(profile: ClimateProfile): void {
  const { baseAltitude, topAltitude, baseTemperatureC, topTemperatureC, baseIceHumidity, topIceHumidity, surfaceHumidity } = profile;
  if (![baseAltitude, topAltitude, baseTemperatureC, topTemperatureC, baseIceHumidity,
    topIceHumidity, surfaceHumidity].every(Number.isFinite) || topAltitude <= baseAltitude ||
    baseIceHumidity < 0 || topIceHumidity < 0 || surfaceHumidity < 0 || surfaceHumidity > 1) {
    throw new RangeError('A climate profile needs finite values, increasing elevations, nonnegative ice humidity and a surface humidity of 0–1.');
  }
}
