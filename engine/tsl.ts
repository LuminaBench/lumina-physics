/**
 * TSL import shim.
 *
 * Three's TSL typings are extremely strict about node generics, which fights against
 * the dynamic way shader graphs are composed in this codebase (shared Fn blueprints that
 * accept float | vec2 | vec3 nodes interchangeably). Every module pulls its TSL symbols
 * from this single binding so the escape hatch lives in exactly one place.
 *
 * The shim also replaces `smoothstep` with an explicit Hermite implementation: the
 * built-in is undefined in GLSL / WGSL / SPIR-V when edge0 >= edge1, and reversed edges
 * ("1 → 0 falloff") are used throughout these shaders. The explicit form is identical on
 * every backend and driver.
 */
import * as TSL_ from 'three/tsl';

/** Any TSL node. */
export type N = any;

const base = TSL_ as unknown as Record<string, any>;

function safeSmoothstep(edge0: N, edge1: N, x: N): N {
  const a = base.nodeObject(typeof edge0 === 'number' ? base.float(edge0) : edge0);
  const b = base.nodeObject(typeof edge1 === 'number' ? base.float(edge1) : edge1);
  const v = base.nodeObject(typeof x === 'number' ? base.float(x) : x);
  const t = v.sub(a).div(b.sub(a)).clamp(0, 1);
  return t.mul(t).mul(t.mul(-2).add(3));
}

export const TSL: Record<string, any> = { ...base, smoothstep: safeSmoothstep };
