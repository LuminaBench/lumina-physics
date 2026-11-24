/** Equivalent water depths in millimetres. One column covers one square metre or one bed texel. */
export interface SandWaterOptions {
  filmCapacityMm?: number;
  poreCapacityMm?: number;
  infiltrationMmS?: number;
  evaporationMmS?: number;
  /** Time constant for water to percolate below the simulated grain layer. */
  drainageSeconds?: number;
}

/** Allocation-free vertical exchange. Read the result before advancing another column. */
export class SandWaterColumn {
  readonly filmCapacityMm: number;
  readonly poreCapacityMm: number;
  readonly infiltrationMmS: number;
  readonly evaporationMmS: number;
  readonly drainageSeconds: number;
  standingMm = 0;
  filmMm = 0;
  poreMm = 0;
  drainedMm = 0;
  evaporatedMm = 0;
  constructor(options: SandWaterOptions = {}) {
    this.filmCapacityMm = options.filmCapacityMm ?? 0.32;
    this.poreCapacityMm = options.poreCapacityMm ?? 2.6;
    this.infiltrationMmS = options.infiltrationMmS ?? 0.26;
    this.evaporationMmS = options.evaporationMmS ?? 0.0005;
    this.drainageSeconds = options.drainageSeconds ?? 36;
    if (
      ![this.filmCapacityMm, this.poreCapacityMm, this.drainageSeconds].every(
        (x) => Number.isFinite(x) && x > 0,
      ) ||
      ![this.infiltrationMmS, this.evaporationMmS].every((x) => Number.isFinite(x) && x >= 0)
    )
      throw new RangeError(
        'Expected positive sand storage and drainage time, and nonnegative water flux rates',
      );
  }
  /** exp(-dt/drainageSeconds) can be shared by every cell in a fixed tick. */
  advance(
    standingMm: number,
    filmMm: number,
    poreMm: number,
    dt: number,
    retainedPore = Math.exp(-dt / this.drainageSeconds),
  ) {
    if (
      !Number.isFinite(standingMm + filmMm + poreMm + dt + retainedPore) ||
      standingMm < 0 ||
      filmMm < 0 ||
      poreMm < 0 ||
      dt < 0 ||
      retainedPore < 0 ||
      retainedPore > 1 ||
      poreMm > this.poreCapacityMm * 1.00001
    )
      throw new RangeError('Invalid sand water depth or timestep');
    const pore = poreMm * retainedPore;
    this.drainedMm = poreMm - pore;
    let surface = standingMm + filmMm;
    const absorbed = Math.min(surface, Math.max(0, this.poreCapacityMm - pore), this.infiltrationMmS * dt);
    surface -= absorbed;
    const evaporation = this.evaporationMmS * dt;
    const surfaceLoss = Math.min(surface, evaporation);
    surface -= surfaceLoss;
    // After the connected surface dries, a buried meniscus supplies much less vapour.
    const poreLoss = Math.min(pore + absorbed, (evaporation - surfaceLoss) * 0.12);
    this.evaporatedMm = surfaceLoss + poreLoss;
    this.poreMm = pore + absorbed - poreLoss;
    this.filmMm = Math.min(this.filmCapacityMm, surface);
    this.standingMm = surface - this.filmMm;
    return this;
  }
}
