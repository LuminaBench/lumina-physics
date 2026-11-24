import { TSL, type LandLibrary } from '../physics';
export const directionId = 'reach:amber-drybrush';
export function registerPaint(lib: LandLibrary) {
  lib.define(
    'direction',
    directionId,
    {
      ground: '#b99572',
      foliage: '#b98153',
      sky: '#f4d6bb',
      water: '#679695',
      transmission: 0.24,
      exposure: 1.14,
      saturation: 1.12,
      temperature: 0.21,
      bands: 0.64,
      leafShader(color) {
        const p = TSL.positionWorld;
        const stroke = p.x.mul(1.22).sub(p.y.mul(3.7)).add(p.z.mul(0.91)).sin();
        const bristle = p.z.mul(4.7).add(p.y.mul(1.8)).cos().mul(stroke);
        const value = TSL.dot(color, TSL.vec3(0.22, 0.65, 0.13)).add(bristle.mul(0.052));
        const band = TSL.floor(value.mul(5.8)).div(5.8).clamp(0, 1);
        const ink = TSL.mix(TSL.color('#463c53'), TSL.color('#ba6737'), TSL.smoothstep(0, 0.34, band));
        const gold = TSL.mix(ink, TSL.color('#efbd74'), TSL.smoothstep(0.26, 0.64, band));
        return TSL.mix(color, gold.mul(bristle.mul(0.075).add(0.96)), 0.66);
      },
    },
    'lumina:painted',
  );
}
