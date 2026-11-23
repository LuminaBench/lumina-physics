/** Long-wave CPU twin of the local interaction texture. Buoyancy reads it without
 * waiting for a GPU readback. The grid resolves hull-scale waves and omits foam. */
export class WaveProbeGrid {
  private readonly size: number;
  private readonly cell: number;
  private previous: Float32Array;
  private next: Float32Array;
  private readonly edge: Float32Array;
  private cx = 0;
  private cz = 0;
  private active = false;

  constructor(extent: number, resolution = 96) {
    this.size = resolution;
    this.cell = extent / resolution;
    this.previous = new Float32Array(resolution * resolution * 2);
    this.next = new Float32Array(this.previous.length);
    this.edge = new Float32Array(resolution * resolution);
    for (let z = 0; z < resolution; z++)
      for (let x = 0; x < resolution; x++) {
        const u = Math.min(
          1,
          (Math.min(x, z, resolution - 1 - x, resolution - 1 - z) + 0.5) / (resolution * 0.05)
        );
        this.edge[z * resolution + x] = u * u * (3 - 2 * u);
      }
  }

  step(
    dt: number,
    focusX: number,
    focusZ: number,
    speed: number,
    damping: number,
    sources: Float32Array,
    count: number
  ): void {
    if (!this.active && count === 0) return;
    const n = this.size,
      cell = this.cell,
      cx = Math.round(focusX / cell),
      cz = Math.round(focusZ / cell);
    const sx = cx - this.cx,
      sz = cz - this.cz;
    this.cx = cx;
    this.cz = cz;
    const old = this.previous,
      next = this.next;
    const decay = Math.exp(-damping * dt),
      lapScale = (speed * speed * dt) / (cell * cell);
    next.fill(0);
    // Scroll and integrate in one pass. Boundaries absorb waves before they leave the window.
    const x0 = Math.max(1, 1 - sx),
      x1 = Math.min(n - 1, n - 1 - sx);
    const z0 = Math.max(1, 1 - sz),
      z1 = Math.min(n - 1, n - 1 - sz);
    let peak = 0;
    if (this.active)
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const i = z * n + x,
            j = ((z + sz) * n + x + sx) * 2;
          const h = old[j],
            lap = old[j - 2] + old[j + 2] + old[j - 2 * n] + old[j + 2 * n] - 4 * h;
          const v = (old[j + 1] + lap * lapScale) * decay,
            edge = this.edge[i];
          next[i * 2] = (h + v * dt) * edge;
          next[i * 2 + 1] = v * edge;
          peak = Math.max(peak, Math.abs(h), Math.abs(v));
        }
      }
    const originX = (cx - n / 2 + 0.5) * cell,
      originZ = (cz - n / 2 + 0.5) * cell;
    let forced = false;
    for (let s = 0; s < count; s++) {
      const o = s * 7,
        x = (sources[o] - originX) / cell,
        z = (sources[o + 1] - originZ) / cell;
      const r = sources[o + 2] / cell,
        push = sources[o + 3],
        impulse = sources[o + 4],
        ring = sources[o + 6];
      if (push === 0 && impulse === 0) continue;
      // Preserve displaced volume when a sub-cell wake is filtered to the hull grid.
      const variance = r * r + 0.21,
        inv = 1 / variance,
        area = r * r * inv,
        reach = 2.4 * Math.sqrt(variance);
      const left = Math.max(1, Math.floor(x - reach)),
        right = Math.min(n - 2, Math.ceil(x + reach));
      const back = Math.max(1, Math.floor(z - reach)),
        front = Math.min(n - 2, Math.ceil(z + reach));
      if (left > right || back > front) continue;
      forced = true;
      for (let iz = back; iz <= front; iz++)
        for (let ix = left; ix <= right; ix++) {
          const q = ((ix - x) * (ix - x) + (iz - z) * (iz - z)) * inv;
          const g = Math.exp(-2.5 * q),
            rim = ring ? Math.exp(-6 * (q - 1) * (q - 1)) * ring : 0;
          const i = iz * n + ix,
            gain = area * this.edge[i];
          next[i * 2] += impulse * g * gain;
          next[i * 2 + 1] += push * (g - 0.555 * rim) * dt * gain;
        }
    }
    this.previous = next;
    this.next = old;
    this.active = forced || peak > 0.0005;
  }

  /** Add the long-wave response at all hull points without boxing scalar
   * returns at each call boundary. Positions are packed xz in world metres. */
  addHeights(coordinates: Float64Array, out: Float64Array): void {
    if (!this.active) return;
    const n = this.size,
      stride = 2 * n,
      half = n / 2 - 0.5,
      inv = 1 / this.cell;
    const ox = half - this.cx,
      oz = half - this.cz,
      data = this.previous;
    for (let j = 0; j < out.length; j++) {
      const x = coordinates[j * 2] * inv + ox,
        z = coordinates[j * 2 + 1] * inv + oz;
      if (x < 0 || x >= n - 1 || z < 0 || z >= n - 1) continue;
      const ix = Math.floor(x),
        iz = Math.floor(z),
        u = x - ix,
        v = z - iz,
        k = (iz * n + ix) * 2;
      const a = data[k] + (data[k + 2] - data[k]) * u;
      const b = data[k + stride] + (data[k + stride + 2] - data[k + stride]) * u;
      out[j] += a + (b - a) * v;
    }
  }

  sample(x: number, z: number, channel: 0 | 1 = 0): number {
    if (!this.active) return 0;
    const n = this.size,
      gx = x / this.cell - this.cx + n / 2 - 0.5,
      gz = z / this.cell - this.cz + n / 2 - 0.5;
    if (gx < 0 || gx >= n - 1 || gz < 0 || gz >= n - 1) return 0;
    const ix = Math.floor(gx),
      iz = Math.floor(gz),
      tx = gx - ix,
      tz = gz - iz,
      i = (iz * n + ix) * 2 + channel;
    const a = this.previous,
      k = i + 2 * n;
    return (a[i] + (a[i + 2] - a[i]) * tx) * (1 - tz) + (a[k] + (a[k + 2] - a[k]) * tx) * tz;
  }
}
