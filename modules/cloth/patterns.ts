/** Procedural fabric patterns (TSL): flags, hazard tape, sailcloth, canopy gores. No textures. */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

const { vec2, vec3, float, mix, step, floor, fract, abs, smoothstep, length, atan, mod, sin } = TSL;

export type ClothPattern = 'solid' | 'stripes' | 'tricolor' | 'cross' | 'checker' | 'hazard' | 'sailcloth' | 'canopy' | 'pennant';

/** Albedo (vec3) for a pattern at `st` (u along the fly, v up the hoist). */
export function patternNode(pattern: ClothPattern, st: N, colors: THREE.Color[]): N {
  const c = (i: number): N => { const k = colors[Math.min(i, colors.length - 1)]; return vec3(k.r, k.g, k.b); };
  // Fine weave that reads as fabric rather than plastic when the light rakes across it.
  const weave = sin(st.x.mul(150)).mul(sin(st.y.mul(110))).mul(0.018).add(1);
  let color: N;
  switch (pattern) {
    case 'stripes': {
      const band = floor(st.y.mul(7));
      color = mix(c(0), c(1), mod(band, 2));
      break;
    }
    case 'tricolor':
      color = mix(mix(c(0), c(1), step(1 / 3, st.x)), c(2), step(2 / 3, st.x));
      break;
    case 'cross': {
      // Off-centre cross (toward the hoist), as on Nordic flags.
      const bar = step(abs(st.x.sub(0.36)), 0.075).max(step(abs(st.y.sub(0.5)), 0.11));
      const fimbriation = step(abs(st.x.sub(0.36)), 0.11).max(step(abs(st.y.sub(0.5)), 0.16));
      color = mix(mix(c(0), c(2), fimbriation), c(1), bar);
      break;
    }
    case 'checker': {
      const cell = floor(st.x.mul(8)).add(floor(st.y.mul(5)));
      color = mix(c(0), c(1), mod(cell, 2));
      break;
    }
    case 'hazard':
      color = mix(c(0), c(1), step(0.5, fract(st.x.mul(3).add(st.y.mul(1.6)))));
      break;
    case 'sailcloth': {
      // Horizontal panels with stitched seams and a coloured leech tape.
      const seam = smoothstep(0.012, 0.0, abs(fract(st.y.mul(9)).sub(0.5)).sub(0.488).abs());
      const panel = mix(float(0.94), float(1.0), fract(floor(st.y.mul(9)).mul(0.37)));
      color = mix(mix(c(0).mul(panel), c(0).mul(0.72), seam), c(1), step(0.955, st.x));
      break;
    }
    case 'canopy': {
      // Radial gores alternating two colours, darker apex vent.
      const d = st.sub(vec2(0.5, 0.5));
      const gore = floor(atan(d.y, d.x).div(Math.PI * 2).add(0.5).mul(12));
      color = mix(c(0), c(1), mod(gore, 2)).mul(smoothstep(0.02, 0.07, length(d)).mul(0.6).add(0.4));
      break;
    }
    case 'pennant': {
      const chevron = step(st.x, abs(st.y.sub(0.5)).mul(0.9).add(0.18));
      color = mix(c(1), c(0), chevron);
      break;
    }
    default:
      color = c(0);
  }
  return color.mul(weave);
}


