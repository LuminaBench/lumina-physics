/** Air changes atmospheric extinction and the solar aureole without changing exposure, cloud
 * location or rainfall. A project may supply the same two quantities in its own climate file. */
export interface AirRecipe {
  turbidity: number;
  visibility: number;
}
export const AIR_RECIPES = {
  'clear-post-front': { turbidity: 1.35, visibility: 90000 },
  'humid-sea-breeze': { turbidity: 3.8, visibility: 25500 },
  'dusty-inland': { turbidity: 6.5, visibility: 12300 },
} satisfies Record<string, AirRecipe>;
export function setAirRecipe(target: AirRecipe, air: keyof typeof AIR_RECIPES | AirRecipe) {
  const value = typeof air === 'string' ? AIR_RECIPES[air] : air;
  if (
    !value ||
    !Number.isFinite(value.turbidity) ||
    value.turbidity < 1 ||
    value.turbidity > 16 ||
    !Number.isFinite(value.visibility) ||
    value.visibility < 100 ||
    value.visibility > 300000
  )
    throw new RangeError('Air turbidity must be 1–16 and visibility 100–300000 metres');
  target.turbidity = value.turbidity;
  target.visibility = value.visibility;
}
