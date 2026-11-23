const RAD = Math.PI / 180;

export interface SolarClock {
  /** Positive north, in degrees. */
  latitudeDeg: number;
  /** One-based day in the game calendar. Whole-year offsets are allowed. */
  dayOfYear: number;
  /** Local apparent solar time. At 12 the sun crosses the meridian. Hours may run past midnight. */
  solarHour: number;
  daysInYear?: 365 | 366;
  /** Map north in Weather's azimuth convention, from +X toward +Z. Defaults to −Z. */
  northAzimuthDeg?: number;
}

/** Write geometric solar angles into Weather.params or a host-owned pair of numbers.
 * The declination approximation follows NOAA's General Solar Position Calculations.
 * The caller owns the game clock, weather, moon and exposure.
 */
export function setSolarTime(sky: {sunElevation: number; sunAzimuth: number}, clock: SolarClock): void {
  const { latitudeDeg, dayOfYear, solarHour, daysInYear = 365, northAzimuthDeg = -90 } = clock;
  if (!Number.isFinite(latitudeDeg) || Math.abs(latitudeDeg) > 90 ||
      !Number.isInteger(dayOfYear) || !Number.isFinite(solarHour) || !Number.isFinite(northAzimuthDeg) ||
      (daysInYear !== 365 && daysInYear !== 366)) {
    throw new RangeError('Use a latitude from -90 to 90, a whole calendar day, a 365/366-day year and finite solar hours and map north.');
  }
  const yearAngle = 2 * Math.PI * ((dayOfYear - 1 + (solarHour - 12) / 24) % daysInYear) / daysInYear;
  const declination = 0.006918 - 0.399912 * Math.cos(yearAngle) + 0.070257 * Math.sin(yearAngle)
    - 0.006758 * Math.cos(2 * yearAngle) + 0.000907 * Math.sin(2 * yearAngle)
    - 0.002697 * Math.cos(3 * yearAngle) + 0.00148 * Math.sin(3 * yearAngle);
  const latitude = latitudeDeg * RAD;
  const hourAngle = ((solarHour % 24) - 12) * 15 * RAD;
  const alongMeridian = Math.cos(declination) * Math.cos(hourAngle);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(latitude) * Math.sin(declination) - Math.sin(latitude) * alongMeridian;
  const up = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * alongMeridian;
  const horizontal = Math.hypot(east, north);
  sky.sunElevation = Math.atan2(up, horizontal) / RAD;
  // Directly overhead or underfoot any compass heading describes the same ray.
  const heading = horizontal > 1e-12 ? Math.atan2(east, north) / RAD : 0;
  sky.sunAzimuth = (((northAzimuthDeg + heading) % 360) + 360) % 360;
}
