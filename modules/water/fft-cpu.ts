/**
 * CPU twin of the FFT ocean.
 *
 * Evaluates the low-wavenumber core of every cascade on a small grid (≤ 64²) from the
 * *same* initial spectrum the GPU uses. It serves two purposes:
 *   1. deterministic, zero-latency wave sampling for buoyancy / hydrodynamics (no readback);
 *   2. the complete ocean on the WebGL 2 fallback, where compute FFT is unavailable.
 */
import { GRAVITY, OMEGA_QUANTUM, type CascadeLayout } from './spectrum';

export class CpuCascade {
  readonly size: number;
  /** Interleaved displacement (dx, dy, dz, 0) per texel. */
  readonly displacement: Float32Array;
  /** Interleaved (slopeX, slopeZ, jacobian, foam) per texel – filled by `updateDerivatives`. */
  readonly derivatives: Float32Array;
  private h0: Float32Array;       // blended (re, im, negRe, negIm)
  private h0Slots: [Float32Array, Float32Array];
  private fullSize: number;
  private lastBlend = -1;
  private lastTime = NaN;
  private keyStart = -Infinity;
  private sparse = false;
  private probeGeneration = 0;
  private probeFraction = 0;
  private probeStamp?: Uint32Array;
  private keyInterval = 0;
  private keyA?: Float32Array;
  private keyB?: Float32Array;
  private lastChop = NaN;
  private dirX: Float32Array;
  private dirZ: Float32Array;
  /** Interleaved complex signals per texel: [ar, ai, br, bi] = [Dx+i·Dz, height]. */
  private buf: Float32Array;
  /** Transposed buffer for contiguous column IFFTs. */
  private bufT: Float32Array;
  private rev: Uint16Array;
  private cosT: Float32Array;
  private sinT: Float32Array;
  /** Deduplicated angular frequencies (~8× fewer cos/sin evaluations due to radial symmetry). */
  private uniqueOmega: Float32Array;
  private omegaIdx: Uint16Array;
  private cosOmega: Float32Array;
  private sinOmega: Float32Array;
  /** Sparse active-cell lists (cells with non-zero energy in either spectrum slot). */
  private activeCells: Uint16Array;
  private activeDst: Uint16Array; // precomputed bit-reversed row offset (y * N + rev[x]) * 4
  private activeCount = 0;
  private activeOmegas: Uint16Array;
  private activeOmegaCount = 0;
  private activeRowMask: Uint8Array;
  private omegaSeen: Uint8Array;
  private invLengthN: number;
  private mask: number;

  constructor(readonly layout: CascadeLayout, size: number, spectrumA: Float32Array, spectrumB: Float32Array, fullSize: number, depth: number) {
    const N = this.size = Math.min(size, fullSize);
    this.fullSize = fullSize;
    this.mask = N - 1;
    this.invLengthN = N / layout.length;
    const NN = N * N;
    this.h0Slots = [new Float32Array(NN * 4), new Float32Array(NN * 4)];
    this.displacement = new Float32Array(NN * 4);
    this.derivatives = new Float32Array(NN * 4);
    this.h0 = new Float32Array(NN * 4);
    this.dirX = new Float32Array(NN);
    this.dirZ = new Float32Array(NN);
    this.buf = new Float32Array(NN * 4);
    this.bufT = new Float32Array(NN * 4);
    this.activeCells = new Uint16Array(NN);
    this.activeDst = new Uint16Array(NN);
    this.activeRowMask = new Uint8Array(N);

    const bits = Math.log2(N);
    this.rev = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let bI = 0; bI < bits; bI++) r |= ((i >> bI) & 1) << (bits - 1 - bI);
      this.rev[i] = r;
    }
    this.cosT = new Float32Array(N >> 1);
    this.sinT = new Float32Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) {
      const ang = (2 * Math.PI * i) / N;
      this.cosT[i] = Math.cos(ang);
      this.sinT[i] = Math.sin(ang);
    }

    const dk = (2 * Math.PI) / layout.length;
    const halfN = N >> 1;
    this.omegaIdx = new Uint16Array(NN);
    const omegaMap = new Map<number, number>();
    const uniqueList: number[] = [];
    // Take the central N×N wavenumbers out of the full-resolution spectrum.
    for (let y = 0; y < N; y++) {
      const m = y - halfN;
      const kz = m * dk;
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const n = x - halfN;
        const kx = n * dk;
        const k = Math.sqrt(kx * kx + kz * kz);
        const kd = k * depth;
        const om = Math.round(Math.sqrt(GRAVITY * k * Math.tanh(kd < 20 ? kd : 20)) / OMEGA_QUANTUM) * OMEGA_QUANTUM;
        let idx = omegaMap.get(om);
        if (idx === undefined) {
          idx = uniqueList.length;
          omegaMap.set(om, idx);
          uniqueList.push(om);
        }
        const cell = row + x;
        this.omegaIdx[cell] = idx;
        if (k > 1e-6) {
          const invK = 1 / k;
          this.dirX[cell] = kx * invK;
          this.dirZ[cell] = kz * invK;
        }
      }
    }
    this.uniqueOmega = new Float32Array(uniqueList);
    this.cosOmega = new Float32Array(uniqueList.length);
    this.sinOmega = new Float32Array(uniqueList.length);
    this.activeOmegas = new Uint16Array(uniqueList.length);
    this.omegaSeen = new Uint8Array(uniqueList.length);

    this.setSpectrum(0, spectrumA);
    this.setSpectrum(1, spectrumB);
  }

  /** Copy the central N×N wavenumbers out of a full-resolution spectrum into a slot. */
  setSpectrum(slot: 0 | 1, full: Float32Array): void {
    const N = this.size, F = this.fullSize, dstArr = this.h0Slots[slot];
    const halfN = N >> 1, halfF = F >> 1;
    for (let y = 0; y < N; y++) {
      const m = y - halfN;
      const edgeY = m === -halfN;
      const srcRow = (m + halfF) * F;
      const dstRow = y * N;
      for (let x = 0; x < N; x++) {
        const n = x - halfN;
        const dst = (dstRow + x) * 4;
        // The -N/2 row/column has no mirrored partner on this grid: drop it to stay Hermitian.
        if (edgeY || n === -halfN) {
          dstArr[dst] = dstArr[dst + 1] = dstArr[dst + 2] = dstArr[dst + 3] = 0;
        } else {
          const src = (srcRow + (n + halfF)) * 4;
          dstArr[dst] = full[src];
          dstArr[dst + 1] = full[src + 1];
          dstArr[dst + 2] = full[src + 2];
          dstArr[dst + 3] = full[src + 3];
        }
      }
    }
    this.rebuildActiveLists();
    this.lastBlend = -1;
    this.lastTime = NaN;
    this.keyStart = -Infinity;
  }

  private rebuildActiveLists(): void {
    const N = this.size;
    const sa = this.h0Slots[0], sb = this.h0Slots[1];
    const cells = this.activeCells, dsts = this.activeDst;
    const rowMask = this.activeRowMask, rev = this.rev;
    const omegaIdx = this.omegaIdx, seen = this.omegaSeen, omegas = this.activeOmegas;
    rowMask.fill(0);
    seen.fill(0);
    let count = 0;
    let omCount = 0;
    for (let y = 0; y < N; y++) {
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const cell = row + x;
        const o = cell * 4;
        if (
          sa[o] !== 0 || sa[o + 1] !== 0 || sa[o + 2] !== 0 || sa[o + 3] !== 0 ||
          sb[o] !== 0 || sb[o + 1] !== 0 || sb[o + 2] !== 0 || sb[o + 3] !== 0
        ) {
          cells[count] = cell;
          dsts[count] = (row + rev[x]) * 4;
          count++;
          rowMask[y] = 1;
          const oi = omegaIdx[cell];
          if (seen[oi] === 0) {
            seen[oi] = 1;
            omegas[omCount++] = oi;
          }
        }
      }
    }
    this.activeCount = count;
    this.activeOmegaCount = omCount;
  }

  /**
   * Contiguous fused inverse FFT of one bit-reversed row of length N with 2 interleaved
   * complex signals ([ar, ai, br, bi] per element, stride 4 floats).
   * Stops before `limitHalf` so the column pass can fuse its final stage into `displacement`.
   */
  private ifftRowFused(data: Float32Array, rowBase: number, limitHalf = this.size): void {
    const N = this.size;
    const end = rowBase + N * 4;

    // Stage 0 (half = 1): twiddle is always (1, 0) -> pure add/sub, zero multiplies.
    if (1 < limitHalf) {
      for (let a = rowBase; a < end; a += 8) {
        const b = a + 4;
        const a0 = data[a], a1 = data[a + 1], a2 = data[a + 2], a3 = data[a + 3];
        const b0 = data[b], b1 = data[b + 1], b2 = data[b + 2], b3 = data[b + 3];
        data[a] = a0 + b0; data[a + 1] = a1 + b1; data[a + 2] = a2 + b2; data[a + 3] = a3 + b3;
        data[b] = a0 - b0; data[b + 1] = a1 - b1; data[b + 2] = a2 - b2; data[b + 3] = a3 - b3;
      }
    }

    if (2 >= limitHalf) return;

    // Stage 1 (half = 2): j=0 twiddle (1, 0), j=1 twiddle (0, 1) -> zero multiplies.
    for (let a = rowBase; a < end; a += 16) {
      // j = 0: pair (a, a + 8)
      const b = a + 8;
      const a0 = data[a], a1 = data[a + 1], a2 = data[a + 2], a3 = data[a + 3];
      const b0 = data[b], b1 = data[b + 1], b2 = data[b + 2], b3 = data[b + 3];
      data[a] = a0 + b0; data[a + 1] = a1 + b1; data[a + 2] = a2 + b2; data[a + 3] = a3 + b3;
      data[b] = a0 - b0; data[b + 1] = a1 - b1; data[b + 2] = a2 - b2; data[b + 3] = a3 - b3;

      // j = 1: pair (a + 4, a + 12), multiply b by +i -> (-im, re)
      const c = a + 4, d = a + 12;
      const c0 = data[c], c1 = data[c + 1], c2 = data[c + 2], c3 = data[c + 3];
      const d0 = -data[d + 1], d1 = data[d], d2 = -data[d + 3], d3 = data[d + 2];
      data[c] = c0 + d0; data[c + 1] = c1 + d1; data[c + 2] = c2 + d2; data[c + 3] = c3 + d3;
      data[d] = c0 - d0; data[d + 1] = c1 - d1; data[d + 2] = c2 - d2; data[d + 3] = c3 - d3;
    }

    // Remaining stages (half = 4, 8, ..., limitHalf / 2).
    const cosT = this.cosT, sinT = this.sinT;
    for (let half = 4; half < limitHalf; half <<= 1) {
      const half4 = half << 2;
      const span4 = half4 << 1;
      const step = N / (half << 1);
      for (let start = rowBase; start < end; start += span4) {
        // j = 0: twiddle (1, 0)
        {
          const a = start, b = start + half4;
          const a0 = data[a], a1 = data[a + 1], a2 = data[a + 2], a3 = data[a + 3];
          const b0 = data[b], b1 = data[b + 1], b2 = data[b + 2], b3 = data[b + 3];
          data[a] = a0 + b0; data[a + 1] = a1 + b1; data[a + 2] = a2 + b2; data[a + 3] = a3 + b3;
          data[b] = a0 - b0; data[b + 1] = a1 - b1; data[b + 2] = a2 - b2; data[b + 3] = a3 - b3;
        }
        for (let j = 1, a = start + 4; j < half; j++, a += 4) {
          const ti = j * step;
          const wr = cosT[ti], wi = sinT[ti];
          const b = a + half4;
          const dr = data[b], di = data[b + 1], hr = data[b + 2], hi = data[b + 3];
          const br0 = dr * wr - di * wi, bi0 = dr * wi + di * wr;
          const br1 = hr * wr - hi * wi, bi1 = hr * wi + hi * wr;
          const a0 = data[a], a1 = data[a + 1], a2 = data[a + 2], a3 = data[a + 3];
          data[b] = a0 - br0; data[b + 1] = a1 - bi0;
          data[b + 2] = a2 - br1; data[b + 3] = a3 - bi1;
          data[a] = a0 + br0; data[a + 1] = a1 + bi0;
          data[a + 2] = a2 + br1; data[a + 3] = a3 + bi1;
        }
      }
    }
  }

  /**
   * Interpolate long-period bands between analytical FFT keyframes. Both buoyancy and
   * the fallback displacement texture still see a continuously varying display-rate field.
   * Set probesOnly on an independent physics twin to resolve only texels requested by
   * sample/sampleBatch. Call without it when consuming a full displacement texture.
   */
  updateInterpolated(time: number, chop: number, blend: number, interval: number, probesOnly = false): void {
    if (!(interval > 0 && Number.isFinite(interval))) { this.update(time, chop, blend); return; }
    const field = this.displacement;
    let a = this.keyA, b = this.keyB;
    if (!a || !b) {
      this.keyA = a = new Float32Array(field.length);
      this.keyB = b = new Float32Array(field.length);
    }
    const start = Math.floor(time / interval) * interval;
    if (interval !== this.keyInterval || start !== this.keyStart || chop !== this.lastChop || blend !== this.lastBlend) {
      if (interval === this.keyInterval && Math.abs(start - this.keyStart - interval) < 1e-7 && chop === this.lastChop && blend === this.lastBlend) {
        // The previous upper endpoint is now the lower endpoint.
        this.keyA = b; this.keyB = a; a = this.keyA; b = this.keyB;
      } else {
        this.lastTime = NaN;
        this.evaluate(start, chop, blend, a);
      }
      this.evaluate(start + interval, chop, blend, b);
      this.keyStart = start;
      this.keyInterval = interval;
    }
    const f = (time - start) / interval;
    this.sparse = probesOnly;
    if (probesOnly) {
      // The GPU renders its own FFT. Its CPU twin only needs the texels under a hull.
      this.probeStamp ??= new Uint32Array(this.size * this.size);
      this.probeGeneration = (this.probeGeneration + 1) >>> 0;
      if (this.probeGeneration === 0) { this.probeStamp.fill(0); this.probeGeneration = 1; }
      this.probeFraction = f;
    } else {
      for (let i = 0; i < field.length; i++) field[i] = a[i] + (b[i] - a[i]) * f;
    }
    this.lastTime = NaN;
  }

  update(time: number, chop: number, blend = 0): void {
    this.keyStart = -Infinity;
    this.sparse = false;
    this.evaluate(time, chop, blend, this.displacement);
  }

  private evaluate(time: number, chop: number, blend: number, output: Float32Array): void {
    if (time === this.lastTime && chop === this.lastChop && blend === this.lastBlend) return;
    this.lastTime = time;
    this.lastChop = chop;

    const N = this.size;
    const h0 = this.h0;
    const activeCells = this.activeCells;
    const activeDst = this.activeDst;
    const activeCount = this.activeCount;

    if (blend !== this.lastBlend) {
      const sa = this.h0Slots[0], sb = this.h0Slots[1];
      for (let k = 0; k < activeCount; k++) {
        const o = activeCells[k] * 4;
        h0[o] = sa[o] + (sb[o] - sa[o]) * blend;
        h0[o + 1] = sa[o + 1] + (sb[o + 1] - sa[o + 1]) * blend;
        h0[o + 2] = sa[o + 2] + (sb[o + 2] - sa[o + 2]) * blend;
        h0[o + 3] = sa[o + 3] + (sb[o + 3] - sa[o + 3]) * blend;
      }
      this.lastBlend = blend;
    }

    // Evaluate cos/sin once per unique active angular frequency (~8-10× fewer trig calls).
    const uniqueOmega = this.uniqueOmega, activeOmegas = this.activeOmegas;
    const cosOmega = this.cosOmega, sinOmega = this.sinOmega;
    const omCount = this.activeOmegaCount;
    for (let k = 0; k < omCount; k++) {
      const oi = activeOmegas[k];
      const phase = uniqueOmega[oi] * time;
      cosOmega[oi] = Math.cos(phase);
      sinOmega[oi] = Math.sin(phase);
    }

    // Evolve active wavenumbers directly into bit-reversed row order inside `buf`.
    const buf = this.buf;
    buf.fill(0);
    const omegaIdx = this.omegaIdx, dirX = this.dirX, dirZ = this.dirZ;
    for (let k = 0; k < activeCount; k++) {
      const i = activeCells[k];
      const oi = omegaIdx[i];
      const c = cosOmega[oi], s = sinOmega[oi];
      const o = i * 4;
      const h00 = h0[o], h01 = h0[o + 1], h02 = h0[o + 2], h03 = h0[o + 3];
      // h = h0(k)·e^{-iωt} + conj(h0(-k))·e^{+iωt}
      const hr = (h00 + h02) * c + (h01 + h03) * s;
      const hi = (h01 - h03) * c + (h02 - h00) * s;
      // D̂x = i·(kx/k)·h, D̂z = i·(kz/k)·h ; signal a = D̂x + i·D̂z
      const dx = dirX[i] * chop, dz = dirZ[i] * chop;
      const dst = activeDst[k];
      buf[dst] = -hi * dx - hr * dz;
      buf[dst + 1] = hr * dx - hi * dz;
      buf[dst + 2] = hr;
      buf[dst + 3] = hi;
    }

    // Row IFFTs (skip completely zero rows).
    const rowMask = this.activeRowMask;
    const rowStride = N * 4;
    for (let y = 0; y < N; y++) {
      if (rowMask[y] !== 0) this.ifftRowFused(buf, y * rowStride);
    }

    // Transpose + column bit-reversal into `bufT`, then run contiguous column IFFTs.
    const bufT = this.bufT;
    const rev = this.rev;
    for (let y = 0; y < N; y++) {
      const ry4 = rev[y] * 4;
      const srcRow = y * rowStride;
      if (rowMask[y] !== 0) {
        for (let x = 0; x < N; x++) {
          const src = srcRow + x * 4;
          const dst = x * rowStride + ry4;
          bufT[dst] = buf[src];
          bufT[dst + 1] = buf[src + 1];
          bufT[dst + 2] = buf[src + 2];
          bufT[dst + 3] = buf[src + 3];
        }
      } else {
        for (let x = 0; x < N; x++) {
          const dst = x * rowStride + ry4;
          bufT[dst] = bufT[dst + 1] = bufT[dst + 2] = bufT[dst + 3] = 0;
        }
      }
    }
    // Run column IFFTs up to the penultimate stage, then fuse the final butterfly stage
    // directly with checkerboard sign correction and unpack into `displacement`.
    const halfN = N >> 1;
    const halfN4 = halfN << 2;
    const halfRowBytes = halfN * rowStride;
    const cosT = this.cosT, sinT = this.sinT;
    const d = output;
    for (let x = 0; x < N; x++) {
      const colBase = x * rowStride;
      this.ifftRowFused(bufT, colBase, halfN);
      const x4 = x * 4;
      let sign = (x & 1) !== 0 ? -1 : 1;
      for (let y = 0; y < halfN; y++) {
        const a = colBase + (y << 2);
        const b = a + halfN4;
        const wr = cosT[y], wi = sinT[y];
        const dr = bufT[b], di = bufT[b + 1], hr = bufT[b + 2], hi = bufT[b + 3];
        const br0 = dr * wr - di * wi, bi0 = dr * wi + di * wr;
        const br1 = hr * wr - hi * wi; // height is real-valued; imaginary output is unused
        const a0 = bufT[a], a1 = bufT[a + 1], a2 = bufT[a + 2];
        const dstA = y * rowStride + x4;
        const dstB = dstA + halfRowBytes;
        d[dstA] = (a0 + br0) * sign;
        d[dstA + 1] = (a2 + br1) * sign;
        d[dstA + 2] = (a1 + bi0) * sign;
        // For even halfN (all power-of-two N >= 4), (x + y + halfN) & 1 === (x + y) & 1.
        d[dstB] = (a0 - br0) * sign;
        d[dstB + 1] = (a2 - br1) * sign;
        d[dstB + 2] = (a1 - bi0) * sign;
        sign = -sign;
      }
    }
  }

  /** Finite-difference slopes, Jacobian and persistent foam (WebGL 2 fallback path only). */
  updateDerivatives(dt: number, foamBias: number, foamDecay: number): void {
    const N = this.size, mask = this.mask, d = this.displacement, out = this.derivatives;
    const inv = this.invLengthN * 0.5;
    const fade = Math.exp(-foamDecay * dt);
    for (let y = 0; y < N; y++) {
      const row = y * N;
      const yp = ((y + 1) & mask) * N;
      const ym = ((y - 1) & mask) * N;
      for (let x = 0; x < N; x++) {
        const xp = (x + 1) & mask, xm = (x - 1) & mask;
        const r = (row + xp) * 4, l = (row + xm) * 4, u = (yp + x) * 4, dn = (ym + x) * 4;
        const dDxdx = (d[r] - d[l]) * inv, dDzdz = (d[u + 2] - d[dn + 2]) * inv;
        const dDxdz = (d[u] - d[dn]) * inv, dDzdx = (d[r + 2] - d[l + 2]) * inv;
        const onePlusX = 1 + dDxdx;
        const onePlusZ = 1 + dDzdz;
        const jac = onePlusX * onePlusZ - dDxdz * dDzdx;
        const o = (row + x) * 4;
        out[o] = ((d[r + 1] - d[l + 1]) * inv) / (onePlusX > 0.25 ? onePlusX : 0.25);
        out[o + 1] = ((d[u + 1] - d[dn + 1]) * inv) / (onePlusZ > 0.25 ? onePlusZ : 0.25);
        out[o + 2] = jac;
        const prevFoam = out[o + 3] * fade;
        let fresh = (foamBias - jac) * 2.2;
        if (fresh < 0) fresh = 0;
        else if (fresh > 1) fresh = 1;
        out[o + 3] = prevFoam > fresh ? prevFoam : fresh;
      }
    }
  }

  private resolveProbe(index: number): void {
    const stamp = this.probeStamp!, cell = index >>> 2;
    if (stamp[cell] === this.probeGeneration) return;
    stamp[cell] = this.probeGeneration;
    const a = this.keyA!, b = this.keyB!, d = this.displacement, f = this.probeFraction;
    for (let i = index; i < index + 3; i++) d[i] = a[i] + (b[i] - a[i]) * f;
  }

  /** Bilinear displacement lookup at tile coordinates (u, v in texels, wraps). */
  sample(wx: number, wz: number, out: [number, number, number]): void {
    const N = this.size, mask = this.mask;
    const fx = wx * this.invLengthN, fz = wz * this.invLengthN;
    const x0f = Math.floor(fx), z0f = Math.floor(fz);
    const tx = fx - x0f, tz = fz - z0f;
    const x0 = x0f & mask, z0 = z0f & mask;
    const x1 = (x0 + 1) & mask, z1 = (z0 + 1) & mask;
    const d = this.displacement;
    const r0 = z0 * N, r1 = z1 * N;
    const i00 = (r0 + x0) * 4, i10 = (r0 + x1) * 4, i01 = (r1 + x0) * 4, i11 = (r1 + x1) * 4;
    if (this.sparse) {
      this.resolveProbe(i00); this.resolveProbe(i10); this.resolveProbe(i01); this.resolveProbe(i11);
    }
    const omx = 1 - tx, omz = 1 - tz;
    const w00 = omx * omz, w10 = tx * omz, w01 = omx * tz, w11 = tx * tz;
    out[0] += d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
    out[1] += d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
    out[2] += d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
  }

  /** Sample a whole hull from one tile. Keep the scalar loads/weights in the loop:
   * passing each fractional coordinate through a JS call boxes it on some V8 tiers. */
  sampleBatch(xz: Float64Array, out: Float64Array, horizontal: boolean): void {
    const n = this.size, mask = this.mask, scale = this.invLengthN, field = this.displacement;
    for (let i = 0, dst = 0; i < xz.length; i += 2, dst += 3) {
      const x = xz[i] * scale, z = xz[i + 1] * scale;
      const ix = Math.floor(x), iz = Math.floor(z);
      const fx = x - ix, fz = z - iz;
      const left = ix & mask, right = (ix + 1) & mask;
      const row = (iz & mask) * n, nextRow = ((iz + 1) & mask) * n;
      const a = (row + left) * 4, b = (row + right) * 4;
      const c = (nextRow + left) * 4, d = (nextRow + right) * 4;
      if (this.sparse) {
        this.resolveProbe(a); this.resolveProbe(b); this.resolveProbe(c); this.resolveProbe(d);
      }
      const wa = (1 - fx) * (1 - fz), wb = fx * (1 - fz), wc = (1 - fx) * fz, wd = fx * fz;
      if (horizontal) {
        out[dst] += field[a] * wa + field[b] * wb + field[c] * wc + field[d] * wd;
        out[dst + 2] += field[a + 2] * wa + field[b + 2] * wb + field[c + 2] * wc + field[d + 2] * wd;
      } else out[dst + 1] += field[a + 1] * wa + field[b + 1] * wb + field[c + 1] * wc + field[d + 1] * wd;
    }
  }
}
