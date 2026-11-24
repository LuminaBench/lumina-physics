import { terrainReading, type AuthoredLandscape, type Soil } from '../physics';

export const seeds = {
  terrain: 607,
  trees: 40761,
  understory: 8531,
  meadow: 12312,
  flowers: 50899,
  rocks: 341,
  debris: 721,
};
export const bridgeHalf = 17;
export const deckHeight = 3.1;
export const roadHalf = 2.15;
export const hollows = [
  { x: -35, z: 12, radius: 7 },
  { x: -32, z: -11, radius: 8 },
  { x: 29, z: 16, radius: 8 },
  { x: -49, z: 7, radius: 6 },
  { x: 46, z: -13, radius: 9 },
  { x: 39, z: -30, radius: 8 },
];

export function roadZ(x: number) {
  const reach = Math.max(0, Math.abs(x) - 26);
  return Math.sign(x) * 2.3 * (1 - Math.cos(reach * 0.038));
}
export const onBridge = (x: number, z: number) =>
  Math.abs(x) <= bridgeHalf && Math.abs(z - roadZ(x)) <= roadHalf;
export const plantable = (x: number, z: number) => Math.abs(z - roadZ(x)) > roadHalf + 1.15;
export const inClay = (x: number, z: number) => ((x + 20.9) / 4.25) ** 2 + ((z - 0.77) / 0.61) ** 2 <= 1;
export function substrate(x: number, z: number): Soil | undefined {
  if (inClay(x, z)) return 'clay';
  if (Math.abs(z - roadZ(x)) < roadHalf && !onBridge(x, z)) return 'asphalt';
}
export function basinDepth(x: number, z: number) {
  let depression = 0;
  for (const h of hollows) {
    const r2 = ((x - h.x) ** 2 + (z - h.z) ** 2) / h.radius ** 2;
    depression = Math.max(depression, Math.max(0, 1 - r2) ** 2);
  }
  return depression;
}
const smooth = (t: number) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};
export function chalkBanks(x: number, z: number, height: number) {
  const bank = height + smooth((height - 2) / 7) * Math.sin(z * 0.039 + x * 0.022) * 1.8;
  const apron =
    (1 - smooth((Math.abs(z - roadZ(x)) - 2.6) / 4)) *
    (1 - smooth((Math.abs(Math.abs(x) - bridgeHalf) - 2) / 6));
  return bank + (deckHeight - 0.1 - bank) * apron - basinDepth(x, z) * 1.55;
}
const ground = terrainReading();
export function roadHeight(land: AuthoredLandscape, x: number, z: number) {
  const y = land.surface.sample(x, z, ground).height + 0.09;
  return deckHeight + (y - deckHeight) * smooth((Math.abs(x) - bridgeHalf) / 4);
}
