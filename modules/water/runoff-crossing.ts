import { TidalInlet, type InletSave, type TidalInletOptions, type BoxCulvert } from './tidal-inlet';

export interface RunoffBand {
  /** Representative ground gauge in world [x, elevation, z] metres. */
  gauge: readonly [number, number, number];
  areaM2: number;
  travelSeconds: number;
  infiltrationMmHour: number;
}
export interface RunoffCrossingOptions {
  bands: readonly RunoffBand[];
  /** Recession time of the routed catchment, in seconds. */
  channelSeconds: number;
  patch: TidalInletOptions & { tributary: readonly [number, number]; culvert: BoxCulvert };
}
export interface RunoffSave {
  version: 1;
  survey: string;
  ticks: number;
  remainder: number;
  inTransit: number[];
  channelM3: number;
  rainM3: number;
  infiltrationM3: number;
  deliveredM3: number;
  dischargeM3s: number;
  water: InletSave;
}

export type GroundRain = (x: number, y: number, z: number, seconds: number) => number;
export const RUNOFF_STEP_SECONDS = 0.05;
const STEP = RUNOFF_STEP_SECONDS;
const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;

/** Time–area runoff is delayed by each contributing travel band and attenuated
 * by one linear reservoir. Its measured outflow feeds a surveyed shallow-water patch. */
export class RunoffCrossing {
  readonly water: TidalInlet;
  readonly survey: string;
  private readonly bands;
  private readonly slots: Float64Array;
  private readonly rain: Float64Array;
  private readonly decay: number;
  private readonly releaseFraction: number;
  private readonly tailwater: number;
  private ticks = 0;
  private remainder = 0;
  private channel = 0;
  private rainVolume = 0;
  private infiltrated = 0;
  private delivered = 0;
  private lastDischarge = 0;

  constructor(options: RunoffCrossingOptions) {
    if (!options.patch?.tributary || !options.patch.culvert)
      throw new RangeError('A runoff crossing needs a tributary and a culvert');
    if (!Number.isFinite(options.channelSeconds) || options.channelSeconds <= 0 || !options.bands.length)
      throw new RangeError('Expected contributing runoff bands and a positive channel time');
    this.bands = options.bands.map((b) => {
      if (
        b.gauge.length !== 3 ||
        !b.gauge.every(Number.isFinite) ||
        !Number.isFinite(b.areaM2) ||
        b.areaM2 <= 0 ||
        !nonnegative(b.travelSeconds) ||
        b.travelSeconds > 86400 ||
        !nonnegative(b.infiltrationMmHour)
      )
        throw new RangeError('Invalid runoff band area, soil intake, gauge or travel time');
      const travel = b.travelSeconds / STEP;
      return {
        x: b.gauge[0],
        y: b.gauge[1],
        z: b.gauge[2],
        area: b.areaM2,
        soil: b.infiltrationMmHour,
        lag: Math.floor(travel),
        fraction: travel - Math.floor(travel),
      };
    });
    let maximumLag = 0;
    for (const b of this.bands) maximumLag = Math.max(maximumLag, b.lag);
    this.slots = new Float64Array(maximumLag + 2);
    this.rain = new Float64Array(this.bands.length);
    this.decay = -Math.expm1(-STEP / options.channelSeconds);
    this.releaseFraction = 1 - (this.decay * options.channelSeconds) / STEP;
    this.water = new TidalInlet(options.patch);
    this.tailwater = options.patch.seaLevel;
    this.survey = JSON.stringify([this.water.survey, this.bands, options.channelSeconds, this.tailwater]);
  }
  get time() {
    return this.ticks * STEP + this.remainder;
  }
  get inflowM3s() {
    return this.lastDischarge;
  }
  /** The forcing callback is sampled at absolute tick midpoints, independent of game frame rate. */
  update(dt: number, rainAt: GroundRain, tailwaterAt?: (seconds: number) => number) {
    if (!nonnegative(dt)) throw new RangeError('Expected nonnegative elapsed seconds');
    const elapsed = dt + this.remainder;
    const wholeSteps = Math.floor(elapsed / STEP + 1e-12);
    if (!Number.isSafeInteger(this.ticks + wholeSteps))
      throw new RangeError('Runoff simulation time exceeds its clock');
    for (let i = 0; i < wholeSteps; i++) {
      const mid = (this.ticks + 0.5) * STEP;
      const endStage = tailwaterAt ? tailwaterAt((this.ticks + 1) * STEP) : this.tailwater;
      if (!Number.isFinite(endStage)) throw new RangeError('Invalid downstream stage');
      for (let i = 0; i < this.bands.length; i++) {
        const b = this.bands[i],
          rate = rainAt(b.x, b.y, b.z, mid);
        if (!nonnegative(rate)) throw new RangeError('Expected finite, nonnegative ground rain in mm/hour');
        this.rain[i] = rate;
      }
      this.tick(endStage);
      this.ticks++;
      this.remainder = 0;
    }
    this.remainder = Math.max(0, elapsed - wholeSteps * STEP);
  }
  private tick(stage: number) {
    const cursor = this.ticks % this.slots.length;
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i],
        mm = this.rain[i],
        factor = (b.area * STEP) / 3600000;
      const rain = mm * factor,
        loss = Math.min(mm, b.soil) * factor,
        excess = rain - loss;
      this.rainVolume += rain;
      this.infiltrated += loss;
      const slot = (cursor + b.lag) % this.slots.length;
      this.slots[slot] += excess * (1 - b.fraction);
      this.slots[(slot + 1) % this.slots.length] += excess * b.fraction;
    }
    const arrived = this.slots[cursor];
    this.slots[cursor] = 0;
    const through = Math.min(
      this.channel + arrived,
      Math.max(0, this.channel * this.decay + arrived * this.releaseFraction),
    );
    this.channel += arrived - through;
    this.delivered += through;
    this.lastDischarge = through / STEP;
    this.water.update(STEP, stage, this.lastDischarge);
  }
  balance() {
    const inTransitM3 = this.slots.reduce((a, v) => a + v, 0);
    const patch = this.water.balance();
    return {
      rainM3: this.rainVolume,
      infiltrationM3: this.infiltrated,
      inTransitM3,
      channelM3: this.channel,
      deliveredM3: this.delivered,
      patchM3: patch.waterM3,
      outletM3: patch.ebbM3,
      tailwaterInputM3: patch.floodM3,
      catchmentErrorM3: this.rainVolume - this.infiltrated - inTransitM3 - this.channel - this.delivered,
      patchErrorM3: patch.waterErrorM3,
    };
  }
  save(): RunoffSave {
    return {
      version: 1,
      survey: this.survey,
      ticks: this.ticks,
      remainder: this.remainder,
      inTransit: Array.from(this.slots),
      channelM3: this.channel,
      rainM3: this.rainVolume,
      infiltrationM3: this.infiltrated,
      deliveredM3: this.delivered,
      dischargeM3s: this.lastDischarge,
      water: this.water.save(),
    };
  }
  restore(s: RunoffSave) {
    if (
      !s ||
      s.version !== 1 ||
      s.survey !== this.survey ||
      !Number.isSafeInteger(s.ticks) ||
      s.ticks < 0 ||
      ![s.remainder, s.channelM3, s.rainM3, s.infiltrationM3, s.deliveredM3, s.dischargeM3s].every(
        nonnegative,
      ) ||
      s.remainder >= STEP ||
      !Array.isArray(s.inTransit) ||
      s.inTransit.length !== this.slots.length ||
      !s.inTransit.every(nonnegative) ||
      !s.water ||
      !nonnegative(s.water.runoffM3!) ||
      !nonnegative(s.water.pendingRunoffM3!)
    )
      throw new RangeError('Invalid runoff save for this survey');
    const residual =
      s.rainM3 - s.infiltrationM3 - s.inTransit.reduce((a, v) => a + v, 0) - s.channelM3 - s.deliveredM3;
    const tol = 1e-8 * Math.max(1, s.rainM3);
    if (
      Math.abs(residual) > tol ||
      Math.abs(s.deliveredM3 - s.water.runoffM3! - s.water.pendingRunoffM3!) > tol
    )
      throw new RangeError('Runoff water budget does not balance');
    this.water.restore(s.water);
    this.slots.set(s.inTransit);
    this.ticks = s.ticks;
    this.remainder = s.remainder;
    this.channel = s.channelM3;
    this.rainVolume = s.rainM3;
    this.infiltrated = s.infiltrationM3;
    this.delivered = s.deliveredM3;
    this.lastDischarge = s.dischargeM3s;
  }
  dispose() {
    this.water.dispose();
  }
}
