export interface ArchSurface {
  /** Signed litres accepted at world XZ. Withdraw with a negative request. */
  exchangeLitres(x: number, z: number, litres: number): number;
  /** Distance from the tire crown to the liner in metres. */
  clearanceM?: number;
  /** Fraction of the upper tire covered by the liner. Zero describes an open wheel. */
  coverage?: number;
  capacityLitres?: number;
  drainSeconds?: number;
}

/** Finite intercepted water on a single wheel liner. Displacement under the tread
 * supplies a tangent spray. Only the portion that reaches the liner enters its store. */
export class WheelArchWater {
  storedLitres = 0;
  capturedLitres = 0;
  dischargedLitres = 0;
  outsideLitres = 0;
  lastDischarge = 0;
  private x = 0;
  private z = 0;
  private readonly clearance: number;
  private readonly cover: number;
  private readonly capacity: number;
  private readonly seconds: number;
  constructor(private readonly surface: ArchSurface) {
    this.clearance = surface.clearanceM ?? 0.1;
    this.cover = surface.coverage ?? 0.68;
    this.capacity = surface.capacityLitres ?? 0.19;
    this.seconds = surface.drainSeconds ?? 1.65;
    if (
      !Number.isFinite(this.clearance) ||
      this.clearance < 0 ||
      !Number.isFinite(this.cover) ||
      this.cover < 0 ||
      this.cover > 1 ||
      !Number.isFinite(this.capacity) ||
      this.capacity < 0 ||
      !Number.isFinite(this.seconds) ||
      this.seconds <= 0
    )
      throw new RangeError('Invalid wheel-arch geometry or drainage time');
  }
  update(
    dt: number,
    x: number,
    z: number,
    outletX: number,
    outletZ: number,
    width: number,
    radius: number,
    depth: number,
    travelSpeed: number,
    rimSpeed: number,
    load: number,
  ) {
    this.lastDischarge = 0;
    if (!(dt > 0)) return;
    this.x = outletX;
    this.z = outletZ;
    const decay = -Math.expm1(-dt / this.seconds),
      before = this.storedLitres;
    const rise = (0.32 * Math.abs(rimSpeed)) ** 2 / (2 * 9.81);
    const reaches = Math.max(0, Math.min(1, (rise - radius - this.clearance) / Math.max(0.02, radius)));
    const swept =
      1000 *
      width *
      Math.max(0, Math.min(depth, 0.008)) *
      Math.abs(travelSpeed) *
      Math.max(0, Math.min(1, load));
    const captureRate = swept * 0.065 * this.cover * reaches;
    // Exact unsaturated linear reservoir, splitting the interval when the liner fills.
    const limit = this.capacity / this.seconds,
      asy = captureRate * this.seconds;
    let requested = captureRate * dt;
    if (asy > this.capacity && before + (asy - before) * decay > this.capacity) {
      const untilFull = this.seconds * Math.log((asy - before) / (asy - this.capacity));
      requested = captureRate * untilFull + limit * (dt - untilFull);
    }
    const captured = requested > 0 ? -this.surface.exchangeLitres(x, z, -requested) : 0;
    const after = Math.min(
      this.capacity,
      Math.max(0, before + ((captured / dt) * this.seconds - before) * decay),
    );
    // With full supply the capped solution sits at capacity for the remainder of this step.
    this.storedLitres =
      captured === requested && asy > this.capacity
        ? Math.min(this.capacity, before + (asy - before) * decay)
        : after;
    this.capturedLitres += captured;
    this.release(Math.max(0, before + captured - this.storedLitres));
  }
  private release(litres: number) {
    this.lastDischarge = litres;
    if (litres === 0) return;
    this.dischargedLitres += litres;
    this.outsideLitres += litres - this.surface.exchangeLitres(this.x, this.z, litres);
  }
  empty() {
    this.release(this.storedLitres);
    this.storedLitres = 0;
  }
}
