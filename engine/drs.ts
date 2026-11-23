/**
 * Dynamic resolution scaling.
 *
 * The canvas always stays at display resolution; only the internal 3D render scale moves
 * (0.55×–1.0× by default) and the temporal upscaler reconstructs the output, so a change
 * is a render-target resize, not a pipeline rebuild, and edges / UI stay sharp.
 *
 * The controller steers toward a GPU load target instead of waiting for dropped frames:
 *
 *   load   = gpuMs / frameBudget                (gpuMs from `LuminaEngine.stats.gpuMs`)
 *   down   when load > 0.93 or frames are being missed: scale *= sqrt(target / load)
 *   up     when the *predicted* load at the next step stays under target + 6 %
 *
 * GPU cost is close to proportional to shaded pixels, hence the square root. Without a GPU
 * time (WebGL 2) only missed frames are visible, so upward steps are probed with an
 * exponential back-off and never go above the tier's static pixel budget.
 */
export class DynamicResolution {
  enabled = false;
  /** Lowest internal scale the controller may choose. */
  min = 0.55;
  /** Highest internal scale (the tier's own render scale). */
  max = 1;
  /** Ceiling used when no GPU time is available (static pixel-budget scale). */
  blindMax = 1;
  /** Current internal scale. */
  scale = 1;
  /** Share of the frame budget the GPU is steered toward. */
  target = 0.76;
  /** Number of scale changes since the last reset (telemetry / QA). */
  changes = 0;
  /** Smoothed share of frames that missed a vsync. */
  missed = 0;

  private cooldown = 1;
  private hot = 0;
  private calm = 0;
  private backoff = 3;
  private lastWasUp = false;

  /** Start from `scale` and ignore measurements for `holdSeconds` (pipelines compiling, history settling). */
  reset(scale: number, holdSeconds = 1.2): void {
    this.scale = scale;
    this.cooldown = holdSeconds;
    this.hot = 0; this.calm = 0; this.missed = 0; this.backoff = 3; this.lastWasUp = false; this.changes = 0;
  }

  /** Pause decisions for a while (scene cuts, tier changes, bursts of pipeline compilation). */
  hold(seconds: number): void { this.cooldown = Math.max(this.cooldown, seconds); }

  /**
   * Feed one frame. `gpuMs` ≤ 0 means "unknown". Returns the new scale when it changed,
   * otherwise `null`.
   */
  update(frameMs: number, gpuMs: number, budgetMs: number): number | null {
    if (!this.enabled) return null;
    const dt = Math.min(frameMs, 100) / 1000;
    this.missed += ((frameMs > budgetMs * 1.4 ? 1 : 0) - this.missed) * 0.06;
    if (this.cooldown > 0) { this.cooldown -= dt; return null; }
    const known = gpuMs > 0;
    const load = known ? gpuMs / budgetMs : this.missed > 0.08 ? 1.1 : 0;
    const ceiling = known ? this.max : Math.min(this.max, this.blindMax);
    let next = this.scale;

    if ((known && load > 0.93) || this.missed > 0.1) {
      this.hot += dt; this.calm = 0;
      if (this.hot > 0.2 && this.scale > this.min + 1e-3) {
        const ratio = known ? Math.sqrt(this.target / Math.max(load, 0.94)) : 0.9;
        next = Math.max(this.min, Math.floor(this.scale * Math.max(ratio, 0.8) * 20 + 1e-6) / 20);
        if (next >= this.scale - 1e-3) next = Math.max(this.min, this.scale - 0.05);
        if (this.lastWasUp) this.backoff = Math.min(this.backoff * 2, 40);
        this.lastWasUp = false;
      }
    } else if (this.missed < 0.015 && this.scale < ceiling - 1e-3) {
      const step = Math.min(ceiling, this.scale + 0.05);
      const predicted = known ? load * (step / this.scale) ** 2 : 0;
      if (predicted < this.target + 0.06) {
        this.calm += dt; this.hot = 0;
        if (this.calm > (known ? 1.2 : this.backoff)) { next = step; this.lastWasUp = true; }
      } else { this.calm = 0; this.hot = 0; }
    } else { this.calm = 0; this.hot = Math.max(0, this.hot - dt); }

    if (Math.abs(next - this.scale) < 1e-3) return null;
    this.scale = Math.round(next * 20) / 20;
    this.cooldown = 0.4;
    this.hot = 0; this.calm = 0;
    this.changes++;
    return this.scale;
  }
}
