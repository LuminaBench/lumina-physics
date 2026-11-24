import { TSL, type N } from '../../engine/tsl';
import { MathUtils, type Vector3 } from 'three/webgpu';

/** A finite local water body coupled to an open sea. Stage and flow use world metres and seconds. */
export interface LocalWater {
  stageAt(x: number, z: number, openSea: number): number;
  stageNode(xz: N, openSea: N): N;
  weightAt(x: number, z: number): number;
  weightNode(xz: N): N;
  concentrationNode(xz: N): N;
  horizontalFlowNode?(xz: N): N;
  applyCurrent(x: number, z: number, current: Vector3): Vector3;
}

/** Optional game-owned coastal wave field. Coordinates and offsets are in world metres. */
export interface ShoreBreak {
  node(xz:N, depth:N, time:N, strength:N, level:N):N;
  offset(x:number,z:number,depth:number,time:number,strength:number,level:number):number;
}

const RATE = 0.95;
const WIDTH = 1.7;

/** Alongshore variation shared by sediment wetting and the surface displacement. */
export function swashPhaseNode(xz: N, time: N): N {
  return time.mul(RATE).add(TSL.sin(xz.x.mul(0.031).add(xz.y.mul(0.013))).mul(1.8))
    .add(TSL.sin(xz.y.mul(0.028).sub(xz.x.mul(0.012)).add(0.7)).mul(1.3));
}

export function swashAmplitude(breaker: number): number {
  return MathUtils.clamp(breaker * 2.5, 0, 1) * 0.07;
}

/** Height and foam coverage on the local surf cycle. Depth is positive offshore. */
export function breakerNode(xz: N, depth: N, time: N, strength: N): N {
  const { Fn, sin, cos, vec2, smoothstep } = TSL;
  return Fn(() => {
    const swashPhase = swashPhaseNode(xz, time).toVar();
    const phase = swashPhase.add(depth.mul(8.5));
    const envelope = smoothstep(0.03, 0.5, depth).mul(smoothstep(WIDTH, WIDTH * 0.4, depth));
    // The first harmonic steepens the face without a jump at the wave-period boundary.
    const profile = sin(phase).mul(0.55).add(sin(phase.mul(2).sub(0.32)).mul(0.18));
    const wetEdge = smoothstep(1.2, 0, depth);
    const swash = sin(swashPhase).mul(wetEdge).mul(strength.mul(2.5).clamp(0, 1)).mul(0.07);
    const height = strength.mul(envelope).mul(profile).add(swash);
    const crestFoam = smoothstep(-0.12, 0.48, profile).mul(envelope).mul(smoothstep(WIDTH * 0.85, WIDTH * 0.3, depth));
    const advancing = smoothstep(-0.55, 0.65, cos(swashPhase));
    const edgeFoam = smoothstep(0.3, 0, depth).mul(advancing.mul(0.63).add(0.13));
    return vec2(height, crestFoam.mul(1.3).add(edgeFoam).mul(strength.mul(4).clamp(0, 1)));
  })();
}

/** CPU twin for hull heights and vertical water velocity in the surf zone. */
export function breakerAt(x: number, z: number, depth: number, time: number, strength: number, velocity = false): number {
  if (strength <= 0 || depth >= WIDTH) return 0;
  const phase0 = time * RATE + 1.8 * Math.sin(x * 0.031 + z * 0.013) + 1.3 * Math.sin(z * 0.028 - x * 0.012 + 0.7);
  const phase = phase0 + depth * 8.5;
  const envelope = MathUtils.smoothstep(depth, 0.03, 0.5) * (1 - MathUtils.smoothstep(depth, WIDTH * 0.4, WIDTH));
  const edge = swashAmplitude(strength) * (1 - MathUtils.smoothstep(depth, 0, 1.2));
  if (velocity) return RATE * (strength * envelope * (0.55 * Math.cos(phase) + 0.36 * Math.cos(2 * phase - 0.32)) + edge * Math.cos(phase0));
  return strength * envelope * (0.55 * Math.sin(phase) + 0.18 * Math.sin(2 * phase - 0.32)) + edge * Math.sin(phase0);
}
