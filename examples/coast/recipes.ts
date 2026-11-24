import { Coastline, SANDS, type CoastOptions } from '../../modules/coast/coastline';
import type { FrontOptions } from '../../modules/weather/front';
import type { WeatherParams } from '../../modules/weather/weather';
import type { SolarClock } from '../../modules/weather/solar-clock';
import type { CoastWorldOptions } from '../../modules/coast/world';

export interface ShoreRecipe {
  name: string;
  coast: CoastOptions;
  front: FrontOptions;
  clock: SolarClock;
  swell: CoastWorldOptions['swell'];
  wave: number;
  /** Cross-shore distances of the lower, middle and dry replay prints, in metres. */
  printCross?: readonly [number, number, number];
  sky: Partial<WeatherParams>;
  town: boolean;
  horizon?: CoastWorldOptions['horizon'];
  air?: CoastWorldOptions['air'];
}
const headlandBase = new Coastline({
  seed: 7231, relief: 'mainland', islandRadius: 960, sand: SANDS.shell,
  beachSlope: 0.068, duneHeight: 5.8, exposure: 0.68,
  shoreline: [[-12,-420],[4,-180],[-16,-52],[0,0],[26,70],[-28,165],[6,370]],
});
export const SHORES: Record<string, ShoreRecipe> = {
  headland: {
    name: 'Shell beach below the headland',
    coast: {
      ...headlandBase.options,
      heightAt(x,z) {
        const spine = (x - 187 - 23 * Math.sin(z / 79)) / 64;
        const along = (z + 18) / 167;
        return headlandBase.height(x,z) + 47 * Math.exp(-spine * spine - along * along);
      },
    },
    front: { type: 'clearing', seed: 957, windSpeed: 5.8, heading: 0.38, span: 3900 },
    clock: { latitudeDeg: 36, dayOfYear: 80, solarHour: 7.0 },
    swell: 'breeze', wave: 0.48, sky: { exposure: 0.57 }, town: false,
    horizon: { resolution: 97, reach: 1100 }, air: 'clear-post-front',
  },
  atlantic: {
    name: 'Atlantic storm beach',
    coast: {
      seed: 2451,
      relief: 'mainland',
      islandRadius: 1030,
      sand: SANDS.quartz,
      duneHeight: 9,
      exposure: 0.88,
      beachSlope: 0.052,
    },
    front: { type: 'squall', seed: 83, heading: -0.28, windSpeed: 12, span: 6800 },
    clock: { latitudeDeg: 51, dayOfYear: 235, solarHour: 17.25, northAzimuthDeg: -42 },
    swell: 'swell',
    wave: 0.57,
    printCross: [6.6, 8.25, 10.15],
    sky: { exposure: 0.63, turbidity: 2.7 },
    town: false,
  },
  cay: {
    name: 'Limestone cay',
    coast: {
      seed: 9172,
      relief: 'cay',
      islandRadius: 690,
      sand: SANDS.shell,
      duneHeight: 3.2,
      exposure: 0.4,
      beachSlope: 0.036,
      shoreline: [
        [4, -390],
        [-3, -210],
        [-24, -94],
        [0, 0],
        [17, 70],
        [-38, 167],
        [9, 370],
      ],
    },
    front: { type: 'streets', seed: 412, heading: 0.75, windSpeed: 4.6 },
    clock: { latitudeDeg: 21, dayOfYear: 160, solarHour: 11.2 },
    swell: 'lagoon',
    wave: 0.33,
    sky: { exposure: 0.53, turbidity: 2.15 },
    town: false,
  },
  volcanic: {
    name: 'Volcanic shore',
    coast: {
      seed: 539,
      relief: 'lava',
      islandRadius: 840,
      pools: [{ along: 0.46, cross: 15, radius: 15, floor: -0.08, lip: 0.21 }],
      sand: SANDS.basalt,
      duneHeight: 7,
      exposure: 0.82,
      beachSlope: 0.078,
      shoreline: [
        [12, -380],
        [-43, -125],
        [0, 0],
        [-12, 130],
        [56, 275],
        [19, 380],
      ],
    },
    front: { type: 'marine', seed: 117, windSpeed: 5.8, heading: -0.62 },
    clock: { latitudeDeg: 61, dayOfYear: 231, solarHour: 19.7 },
    swell: 'swell',
    wave: 0.61,
    sky: { exposure: 0.92, turbidity: 2.4, moonlight: 0.92, moonIllumination: 0.36 },
    town: false,
  },
  boulevard: {
    name: 'Rain-cleared boulevard',
    coast: {
      seed: 622,
      relief: 'terrace',
      islandRadius: 1030,
      sand: SANDS.ochre,
      exposure: 0.61,
      beachSlope: 0.039,
      duneHeight: 3.4,
      shoreline: [
        [4, -390],
        [6, -145],
        [-4, -46],
        [0, 0],
        [6, 110],
        [-1, 300],
        [6, 400],
      ],
    },
    front: {
      type: 'clearing',
      seed: 324,
      windSpeed: 8,
      upperWindSpeed: 4.2,
      upperCrosswind: 1.3,
      heading: 1.1,
      span: 3600,
    },
    clock: { latitudeDeg: 28, dayOfYear: 236, solarHour: 18.5 },
    swell: 'breeze',
    wave: 0.42,
    sky: { turbidity: 3.7, exposure: 0.73 },
    town: true,
  },
};
