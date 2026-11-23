/**
 * GPU FFT ocean cascade (WebGPU compute, authored in TSL).
 *
 *   evolve    h0(k) → h(k, t), packed as two complex signals (Dx + i·Dz, height), written
 *             in bit-reversed order
 *   transform fused radix-4 butterflies (rows, then columns), ping-ponging two buffers
 *   assemble  sign correction, finite-difference slopes + Jacobian, persistent foam,
 *             written to two filterable storage textures
 *
 * All passes of all cascades are dispatched inside one compute pass per frame.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { GRAVITY, OMEGA_QUANTUM, type CascadeLayout } from './spectrum';

const { Fn, mix, int, float, vec2, vec4, ivec2, instancedArray, instanceIndex, textureStore, cos, sin, sqrt, tanh, min, max, length, select, exp, round } = TSL;

export interface OceanSimUniforms {
  /** Simulation time wrapped to the ocean loop length. */
  time: N;
  delta: N;
  chop: N;
  /** Jacobian threshold below which foam is generated (higher = more foam). */
  foamBias: N;
  foamDecay: N;
  /** 0..1 blend between the two initial spectra (sea-state morph). */
  blend: N;
}

export class GpuCascade {
  readonly displacementTexture: THREE.StorageTexture;
  readonly derivativeTexture: THREE.StorageTexture;
  /** Ordered compute nodes for this cascade. */
  readonly passes: N[] = [];
  private spectra: [N, N];

  constructor(readonly layout: CascadeLayout, readonly resolution: number, spectrumA: Float32Array, spectrumB: Float32Array, depth: number, u: OceanSimUniforms) {
    const R = resolution;
    const bits = Math.round(Math.log2(R));
    const count = R * R;
    const dk = (2 * Math.PI) / layout.length;

    const makeTexture = () => {
      const tex = new THREE.StorageTexture(R, R);
      tex.type = THREE.HalfFloatType;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      return tex;
    };
    this.displacementTexture = makeTexture();
    this.derivativeTexture = makeTexture();

    const h0A = instancedArray(spectrumA, 'vec4');
    const h0B = instancedArray(spectrumB, 'vec4');
    this.spectra = [h0A, h0B];
    const bufA = instancedArray(count, 'vec4');
    const bufB = instancedArray(count, 'vec4');
    const foam = instancedArray(count, 'float');

    const reverseBits = (v: N): N => {
      let r: N = int(0);
      for (let b = 0; b < bits; b++) r = r.bitOr(v.shiftRight(int(b)).bitAnd(int(1)).shiftLeft(int(bits - 1 - b)));
      return r;
    };

    // ---- time evolution --------------------------------------------------------
    this.passes.push(Fn(() => {
      const i = int(instanceIndex);
      const x = reverseBits(i.mod(R)).toVar();
      const y = reverseBits(i.div(R)).toVar();
      const cell = y.mul(R).add(x);
      // Both spectra share the same random phases, so lerping amplitudes is a valid sea-state morph.
      const src = mix(h0A.element(cell), h0B.element(cell), u.blend).toVar();
      const kx = float(x.sub(R / 2)).mul(dk);
      const kz = float(y.sub(R / 2)).mul(dk);
      const k = length(vec2(kx, kz));
      const omegaExact = sqrt(k.mul(GRAVITY).mul(tanh(min(k.mul(depth), 20))));
      const omega = round(omegaExact.div(OMEGA_QUANTUM)).mul(OMEGA_QUANTUM);
      const phase = omega.mul(u.time);
      const c = cos(phase), s = sin(phase);
      const hr = src.x.mul(c).add(src.y.mul(s)).add(src.z.mul(c)).add(src.w.mul(s));
      const hi = src.y.mul(c).sub(src.x.mul(s)).add(src.z.mul(s)).sub(src.w.mul(c));
      const invK = select(k.greaterThan(1e-6), float(1).div(max(k, 1e-6)), float(0));
      const dirX = kx.mul(invK).mul(u.chop);
      const dirZ = kz.mul(invK).mul(u.chop);
      // D̂x = i·(kx/k)·h → (-hi, hr)·dirX ; signal 1 = D̂x + i·D̂z
      const dxr = hi.negate().mul(dirX), dxi = hr.mul(dirX);
      const dzr = hi.negate().mul(dirZ), dzi = hr.mul(dirZ);
      bufA.element(instanceIndex).assign(vec4(dxr.sub(dzi), dxi.add(dzr), hr, hi));
    })().compute(count));

    // ---- butterflies -----------------------------------------------------------
    let source = bufA, target = bufB;
    // A single lane writes all outputs of its butterfly. Four-way stages
    // combine two radix-2 rounds in registers instead of writing a full
    // intermediate grid and reading it back from device memory.
    const rotate = (z: N, re: N, im: N): N => vec4(
      z.x.mul(re).sub(z.y.mul(im)), z.x.mul(im).add(z.y.mul(re)),
      z.z.mul(re).sub(z.w.mul(im)), z.z.mul(im).add(z.w.mul(re)),
    );
    for (const horizontal of [true, false]) {
      const stride = horizontal ? 1 : R;
      for (let stage = 0; stage < bits; stage += 2) {
        const half = 1 << stage;
        const radix = stage + 1 < bits ? 4 : 2;
        const rowLanes = R / radix, span = half * stride;
        const src = source, dst = target;
        this.passes.push(Fn(() => {
          const lane = int(instanceIndex);
          const coord = horizontal ? lane.mod(rowLanes) : lane.div(R);
          const j = coord.mod(half);
          const column = coord.div(half).mul(radix * half).add(j);
          const base = (horizontal ? lane.div(rowLanes).mul(R).add(column) : column.mul(R).add(lane.mod(R))).toVar();
          const a = src.element(base).toVar(), b = src.element(base.add(span)).toVar();
          const angle = float(j).mul(Math.PI / half);
          const wb = rotate(b, cos(angle), sin(angle)).toVar();
          const even = a.add(wb).toVar(), odd = a.sub(wb).toVar();
          if (radix === 2) {
            dst.element(base).assign(even);
            dst.element(base.add(span)).assign(odd);
          } else {
            const c = src.element(base.add(2 * span)).toVar(), d = src.element(base.add(3 * span)).toVar();
            const wd = rotate(d, cos(angle), sin(angle)).toVar();
            const re = cos(angle.mul(0.5)), im = sin(angle.mul(0.5));
            const upper = rotate(c.add(wd), re, im).toVar();
            const lower = rotate(c.sub(wd), im.negate(), re).toVar();
            dst.element(base).assign(even.add(upper));
            dst.element(base.add(span)).assign(odd.add(lower));
            dst.element(base.add(2 * span)).assign(even.sub(upper));
            dst.element(base.add(3 * span)).assign(odd.sub(lower));
          }
        })().compute(count / radix));
        source = dst;
        target = src;
      }
    }
    const result = source;

    // ---- assemble --------------------------------------------------------------
    const invTexel2 = R / layout.length / 2;
    const dispTex = this.displacementTexture, derivTex = this.derivativeTexture;
    this.passes.push(Fn(() => {
      const i = int(instanceIndex);
      const x = i.mod(R).toVar();
      const y = i.div(R).toVar();
      const sign = select(x.add(y).bitAnd(int(1)).equal(int(1)), float(-1), float(1)).toVar();
      const at = (ox: number, oy: number): N => {
        const xx = x.add(ox + R).mod(R);
        const yy = y.add(oy + R).mod(R);
        return result.element(yy.mul(R).add(xx));
      };
      const center = result.element(instanceIndex).mul(sign);
      // Neighbours sit on the opposite checkerboard colour → opposite sign.
      const r = at(1, 0).mul(sign.negate()), l = at(-1, 0).mul(sign.negate());
      const up = at(0, 1).mul(sign.negate()), dn = at(0, -1).mul(sign.negate());
      // Packed layout: x = Dx, y = Dz, z = height.
      const dDxdx = r.x.sub(l.x).mul(invTexel2);
      const dDzdz = up.y.sub(dn.y).mul(invTexel2);
      const dDxdz = up.x.sub(dn.x).mul(invTexel2);
      const dDzdx = r.y.sub(l.y).mul(invTexel2);
      const jacobian = dDxdx.add(1).mul(dDzdz.add(1)).sub(dDxdz.mul(dDzdx));
      const slopeX = r.z.sub(l.z).mul(invTexel2).div(max(dDxdx.add(1), 0.25));
      const slopeZ = up.z.sub(dn.z).mul(invTexel2).div(max(dDzdz.add(1), 0.25));
      const f = foam.element(instanceIndex);
      const fresh = u.foamBias.sub(jacobian).mul(2.2).clamp(0, 1);
      const next = max(f.mul(exp(u.foamDecay.mul(u.delta).negate())), fresh);
      f.assign(next);
      textureStore(dispTex, ivec2(x, y), vec4(center.x, center.z, center.y, 1)).toWriteOnly();
      textureStore(derivTex, ivec2(x, y), vec4(slopeX, slopeZ, jacobian, next)).toWriteOnly();
    })().compute(count));
  }

  /** Replace one of the two initial spectra in place (no shader rebuild). */
  setSpectrum(slot: 0 | 1, data: Float32Array): void {
    const buffer = this.spectra[slot].value;
    (buffer.array as Float32Array).set(data);
    buffer.needsUpdate = true;
  }

  dispose(): void {
    this.displacementTexture.dispose();
    this.derivativeTexture.dispose();
    for (const p of this.passes) p.dispose?.();
  }
}
