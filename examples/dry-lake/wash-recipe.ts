import { RainColumn } from '../../modules/weather/rain-column';
import { RunoffCrossing } from '../../modules/water/runoff-crossing';
import { surveyRelief } from './rain-relief';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (lo: number, hi: number, v: number) => {
  const n = clamp((v - lo) / (hi - lo));
  return n * n * (3 - 2 * n);
};
export const washGauges = [
  [-4.225, 0.325],
  [0.325, 0.325],
  [4.225, 0.325],
] as const;
export const spacing = 0.65,
  columns = 48,
  rows = 28;
export const halfX = (spacing * columns) / 2,
  halfZ = (spacing * rows) / 2;
export const pipeIn = [-3.575, -0.23, 0.325] as const,
  pipeOut = [3.575, -0.34, 0.325] as const;
export const roadCentre = (z: number) => ((0.09 * z * z) / (15 + Math.abs(z))) * Math.sin(0.057 * z);
export const channelCentre = (x: number) => 0.52 * Math.sin(x * 0.19) + 0.17 * Math.cos(x * 0.31);
export function washBed(x: number, z: number) {
  const dx = x - roadCentre(z),
    dz = z - channelCentre(x);
  const channel =
    -0.32 - 0.014 * x + 1.05 * (1 - Math.exp(-((dz / 3.2) ** 2))) + 0.025 * Math.sin(x * 0.71 + z * 0.19);
  const asphalt =
    0.245 + 0.011 * Math.min(35, z * z) + 0.025 * (1 - (Math.min(2.45, Math.abs(dx)) / 2.45) ** 2);
  return channel + Math.max(0, asphalt - channel) * (1 - smooth(2.46, 3.65, Math.abs(dx)));
}
export function washTerrain(x: number, z: number) {
  const t = smooth(1, 3.9, Math.max(Math.abs(x) / halfX, Math.abs(z) / halfZ));
  if (t >= 1) return surveyRelief(x, z);
  return washBed(x, z) * (1 - t) + surveyRelief(x, z) * t;
}

export function makeWashSurvey() {
  const cloud = new RainColumn({
    center: [-260, 232],
    radius: [132, 100],
    baseY: 375,
    minimumY: -8,
    rainMmHour: 58,
    dropDiameterMm: 1.15,
    fallSpeed: 5.3,
    humidity: [0.98, 0.93],
    upperWind: [6.4, 0.5],
    lowerWind: [6.6, -0.5],
    motion: [6.5, 0],
    seed: 50371,
  });
  const band = (x: number, z: number, areaM2: number, travelSeconds: number, infiltrationMmHour: number) => ({
    gauge: [x, washTerrain(x, z), z] as const,
    areaM2,
    travelSeconds,
    infiltrationMmHour,
  });
  const bands = [band(-174, 230, 37500, 60, 3), band(-107, 239, 51000, 77, 5), band(-52, 210, 33000, 95, 4)];
  const patch = {
    x: -halfX,
    z: -halfZ,
    spacing,
    columns,
    rows,
    bedAt: washBed,
    seaEdge: 'east' as const,
    mouthAt: (_x: number, z: number) => Math.abs(z - channelCentre(halfX)) < 2.4,
    seaLevel: -0.56,
    initialStageAt: () => -1,
    roughness: 0.048,
    settlingMps: 0.0012,
    tributary: [-13.975, -0.325] as const,
    tributarySiltKgM3: 0.52,
    culvert: { inlet: pipeIn, outlet: pipeOut, width: 1.28, height: 0.39, dischargeCoefficient: 0.68 },
  };
  const crossing = new RunoffCrossing({ bands, channelSeconds: 14, patch });
  const rainAt = (x: number, y: number, z: number, t: number) => cloud.rainAt(x, y, z, t);
  return { crossing, cloud, bands, rainAt };
}
