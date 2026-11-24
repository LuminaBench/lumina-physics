import { lakeBed } from './place';

// Weathering opens jointed gullies in the elevated sedimentary beds; the valley floor stays broad.
export function surveyRelief(x: number, z: number) {
  const base = lakeBed(x, z);
  const high = Math.min(1, Math.max(0, (base - 7) / 55));
  const channel = Math.sin(x * 0.046 + 0.75 * Math.cos(z * 0.012)) + 0.34 * Math.sin(x * 0.089 - z * 0.023);
  const ribs = 5.8 * Math.sin(x * 0.032 + z * 0.009) * Math.sin(z * 0.027 - x * 0.005);
  return (
    base +
    high * (ribs - 9.5 * Math.exp(-channel * channel * 19)) +
    0.75 * Math.sin(x * 0.031) * Math.cos(z * 0.022) +
    0.2 * Math.sin(z * 0.059 + x * 0.042)
  );
}
