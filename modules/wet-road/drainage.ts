import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface StreetDrain {
  x: number;
  z: number;
  capacityLps: number;
  open?: number;
}
export interface StreetCatchment {
  /** Lower-left corner and extent in world XZ, in metres. Cell values represent area averages. */
  x: number;
  z: number;
  width: number;
  length: number;
  columns: number;
  rows: number;
  ground(x: number, z: number): number;
  initialDepth?(x: number, z: number): number;
  /** Roof area in square metres and downspout outlet inside the road patch. */
  roof: { area: number; seconds: number; outletX: number; outletZ: number };
  drains: readonly StreetDrain[];
}
export interface DrainageSave {
  version: 1 | 2;
  catchment: string;
  depths: number[];
  openings: number[];
  budget: Omit<DrainageBudget,'pickupLitres'|'returnLitres'> & Partial<Pick<DrainageBudget,'pickupLitres'|'returnLitres'>>;
  remainder: number;
  rainDose: number;
  evaporationDose: number;
}
export interface DrainageBudget {
  initialLitres: number;
  rainLitres: number;
  roofLitres: number;
  streetLitres: number;
  sewerLitres: number;
  evaporatedLitres: number;
  downspoutLps: number;
  pickupLitres: number;
  returnLitres: number;
}
/** Local kerbed catchment: finite water on a roof and a surveyed cambered surface.
 * The perimeter is sealed. Open grates and evaporation are the only sinks.
 * Layer-averaged surface flow is diffusive; the host owns splashes and tire motion. */
export class StreetDrainage {
  readonly budget: DrainageBudget = {
    initialLitres: 0,
    rainLitres: 0,
    roofLitres: 0,
    streetLitres: 0,
    sewerLitres: 0,
    evaporatedLitres: 0,
    downspoutLps: 0,
    pickupLitres: 0,
    returnLitres: 0,
  };
  private readonly depth: Float64Array;
  private readonly floor: Float64Array;
  private readonly delta: Float64Array;
  private readonly depthPixels: Uint16Array;
  private readonly depthMap: THREE.DataTexture;
  private readonly grateCells: number[];
  private readonly openings: number[];
  private readonly outlet: number;
  private readonly dx: number;
  private readonly dz: number;
  private readonly litresPerMetre: number;
  private readonly signature: string;
  private remainder = 0;
  private rainDose = 0;
  private evaporationDose = 0;
  constructor(readonly options: StreetCatchment) {
    const o = options,
      roof = o.roof;
    if (
      ![o.x, o.z, o.width, o.length, roof.area, roof.seconds, roof.outletX, roof.outletZ].every(
        Number.isFinite,
      ) ||
      o.width <= 0 ||
      o.length <= 0 ||
      roof.area < 0 ||
      roof.seconds <= 0 ||
      ![o.columns, o.rows].every((n) => Number.isInteger(n) && n >= 2 && n <= 256)
    )
      throw new RangeError('Invalid street or roof catchment');
    this.dx = o.width / o.columns;
    this.dz = o.length / o.rows;
    this.litresPerMetre = 1000 * this.dx * this.dz;
    const cell = (x: number, z: number) => {
      const col = Math.floor((x - o.x) / this.dx),
        row = Math.floor((z - o.z) / this.dz);
      if (
        !Number.isFinite(col) ||
        !Number.isFinite(row) ||
        col < 0 ||
        col >= o.columns ||
        row < 0 ||
        row >= o.rows
      )
        throw new RangeError('Drainage outlet is outside its catchment');
      return col + row * o.columns;
    };
    this.outlet = cell(roof.outletX, roof.outletZ);
    this.grateCells = o.drains.map((d) => cell(d.x, d.z));
    this.openings = o.drains.map((d) => {
      const open = d.open ?? 1;
      if (
        !Number.isFinite(d.capacityLps) ||
        d.capacityLps < 0 ||
        !Number.isFinite(open) ||
        open < 0 ||
        open > 1
      )
        throw new RangeError('Invalid grate capacity or clear fraction');
      return open;
    });
    const size = o.rows * o.columns;
    this.depth = new Float64Array(size);
    this.floor = new Float64Array(size);
    this.delta = new Float64Array(size);
    this.depthPixels = new Uint16Array(size);
    this.depthMap = new THREE.DataTexture(
      this.depthPixels,
      o.columns,
      o.rows,
      THREE.RedFormat,
      THREE.HalfFloatType,
    );
    this.depthMap.minFilter = this.depthMap.magFilter = THREE.LinearFilter;
    this.depthMap.unpackAlignment = 1;
    for (let j = 0, i = 0; j < o.rows; j++)
      for (let k = 0; k < o.columns; k++, i++) {
        const x = o.x + (k + 0.5) * this.dx,
          z = o.z + (j + 0.5) * this.dz;
        const floor = o.ground(x, z),
          depth = o.initialDepth?.(x, z) ?? 0;
        if (!Number.isFinite(floor) || !Number.isFinite(depth) || depth < 0)
          throw new RangeError('Invalid street elevation or liquid depth');
        this.floor[i] = floor;
        this.depth[i] = depth;
        this.depthPixels[i] = THREE.DataUtils.toHalfFloat(depth);
        this.budget.initialLitres += depth * this.litresPerMetre;
      }
    // Millimetre-scale survey fingerprint prevents applying an old flood to a different road.
    let hash = 2166136261;
    for (const h of this.floor) hash = Math.imul(hash ^ Math.round(h * 1000), 16777619);
    this.signature = JSON.stringify([
      o.x,
      o.z,
      o.width,
      o.length,
      o.columns,
      o.rows,
      roof.area,
      roof.seconds,
      this.outlet,
      this.grateCells,
      o.drains.map((d) => d.capacityLps),
      hash >>> 0,
    ]);
    this.budget.streetLitres = this.budget.initialLitres;
    this.depthMap.needsUpdate = true;
  }
  setGrate(index: number, open: number) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.openings.length ||
      !Number.isFinite(open) ||
      open < 0 ||
      open > 1
    )
      throw new RangeError('Expected a grate index and a clear fraction from zero to one');
    this.openings[index] = open;
  }
  depthAt(x: number, z: number) {
    const o = this.options,
      u = (x - o.x) / this.dx,
      v = (z - o.z) / this.dz;
    if (u < 0 || v < 0 || u > o.columns || v > o.rows) return 0;
    const a = Math.max(0, Math.min(o.columns - 1, u - 0.5)),
      b = Math.max(0, Math.min(o.rows - 1, v - 0.5));
    const col = Math.min(o.columns - 2, Math.floor(a)),
      row = Math.min(o.rows - 2, Math.floor(b)),
      i = col + row * o.columns;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.depth[i], this.depth[i + 1], a - col),
      THREE.MathUtils.lerp(this.depth[i + o.columns], this.depth[i + o.columns + 1], a - col),
      b - row,
    );
  }
  depthNode(xz: N): N {
    const o = this.options,
      uv = xz.sub(TSL.vec2(o.x, o.z)).div(TSL.vec2(o.width, o.length));
    const inside = uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all());
    return TSL.select(inside, TSL.texture(this.depthMap, uv).level(0).r, 0);
  }
  /** Exchange litres with a wheel or other moving store. Positive requests add
   * water, negative requests withdraw it. Returns the signed volume accepted. */
  exchangeLitres(x: number,z: number,request: number): number {
    if (!Number.isFinite(x)||!Number.isFinite(z)||!Number.isFinite(request)) throw new RangeError('Expected a finite street-water exchange');
    const o=this.options, col=Math.floor((x-o.x)/this.dx), row=Math.floor((z-o.z)/this.dz);
    if(col<0||col>=o.columns||row<0||row>=o.rows||request===0)return 0;
    const i=col+row*o.columns, amount=Math.max(-this.depth[i]*this.litresPerMetre,request);
    if(amount===0)return 0;
    this.depth[i]=Math.max(0,this.depth[i]+amount/this.litresPerMetre);
    this.budget.streetLitres+=amount;
    if(amount>0)this.budget.returnLitres+=amount;else this.budget.pickupLitres-=amount;
    this.depthPixels[i]=THREE.DataUtils.toHalfFloat(this.depth[i]);
    this.depthMap.needsUpdate=true;
    return amount;
  }
  /** Uniform rain and evaporation in mm/hour. A time-weighted driver survives sub-tick changes. */
  update(dt: number, rainMmHour: number, evaporationMmHour = 0) {
    if (
      !Number.isFinite(dt) ||
      dt < 0 ||
      !Number.isFinite(rainMmHour) ||
      rainMmHour < 0 ||
      !Number.isFinite(evaporationMmHour) ||
      evaporationMmHour < 0
    )
      throw new RangeError('Invalid street weather');
    const step = 0.1;
    while (dt > 1e-10) {
      const slice = Math.min(dt, step - this.remainder);
      this.rainDose += rainMmHour * slice;
      this.evaporationDose += evaporationMmHour * slice;
      this.remainder += slice;
      dt -= slice;
      if (this.remainder >= step - 1e-9) {
        this.advance(step, this.rainDose / 3600000, this.evaporationDose / 3600000);
        this.remainder = 0;
        this.rainDose = 0;
        this.evaporationDose = 0;
      }
    }
  }
  private exchange(a: number, b: number, conductance: number) {
    const head = this.floor[a] + this.depth[a] - this.floor[b] - this.depth[b];
    const donor = head > 0 ? a : b,
      h = this.depth[donor];
    // Four neighbours share each donor. Flow vanishes at a dry uphill cell.
    const magnitude = Math.min(0.24 * h, Math.abs(head) * conductance * Math.min(1, Math.sqrt(h / 0.012)));
    const flux = Math.sign(head) * magnitude;
    this.delta[a] -= flux;
    this.delta[b] += flux;
  }
  private advance(dt: number, rain: number, evaporation: number) {
    const o = this.options,
      b = this.budget,
      area = o.width * o.length,
      roof = o.roof;
    b.rainLitres += rain * 1000 * (area + roof.area);
    const roofInput = rain * 1000 * roof.area;
    const before = b.roofLitres;
    const roofEvap = Math.min(before + roofInput, evaporation * 1000 * roof.area);
    const decay = -Math.expm1(-dt / roof.seconds);
    // Exact linear-reservoir outflow under constant uniform input.
    const through = before * decay + roofInput * (1 - (roof.seconds * decay) / dt);
    const out = Math.min(before + roofInput - roofEvap, Math.max(0, through));
    b.roofLitres = before + roofInput - roofEvap - out;
    b.evaporatedLitres += roofEvap;
    b.downspoutLps = out / dt;
    this.depth[this.outlet] += out / this.litresPerMetre;
    this.delta.fill(0);
    const kx = Math.min(0.22, (dt * 0.42) / (this.dx * this.dx)),
      kz = Math.min(0.22, (dt * 0.42) / (this.dz * this.dz));
    for (let j = 0, i = 0; j < o.rows; j++)
      for (let k = 0; k < o.columns; k++, i++) {
        if (k + 1 < o.columns) this.exchange(i, i + 1, kx);
        if (j + 1 < o.rows) this.exchange(i, i + o.columns, kz);
      }
    let stored = 0,
      streetEvap = 0;
    for (let i = 0; i < this.depth.length; i++) {
      const h = this.depth[i] + this.delta[i] + rain;
      const loss = Math.min(h, evaporation);
      this.depth[i] = h - loss;
      streetEvap += loss;
      stored += this.depth[i];
    }
    for (let j = 0; j < o.drains.length; j++) {
      const i = this.grateCells[j],
        remove = Math.min(
          this.depth[i],
          (o.drains[j].capacityLps * this.openings[j] * dt) / this.litresPerMetre,
        );
      this.depth[i] -= remove;
      stored -= remove;
      b.sewerLitres += remove * this.litresPerMetre;
    }
    b.streetLitres = stored * this.litresPerMetre;
    b.evaporatedLitres += streetEvap * this.litresPerMetre;
    for (let i = 0; i < this.depth.length; i++)
      this.depthPixels[i] = THREE.DataUtils.toHalfFloat(this.depth[i]);
    this.depthMap.needsUpdate = true;
  }
  save(): DrainageSave {
    return {
      version: 2,
      catchment: this.signature,
      depths: Array.from(this.depth),
      openings: this.openings.slice(),
      budget: { ...this.budget },
      remainder: this.remainder,
      rainDose: this.rainDose,
      evaporationDose: this.evaporationDose,
    };
  }
  restore(save: DrainageSave) {
    const valid = (v: number) => Number.isFinite(v) && v >= 0;
    if (
      (save.version !== 1 && save.version !== 2) ||
      save.catchment !== this.signature ||
      !Array.isArray(save.depths) ||
      save.depths.length !== this.depth.length ||
      !save.depths.every(valid) ||
      !Array.isArray(save.openings) ||
      save.openings.length !== this.openings.length ||
      !save.openings.every((v) => valid(v) && v <= 1) ||
      !save.budget ||
      !Object.keys(this.budget).every((k) => valid(save.version===1 && (k==='pickupLitres'||k==='returnLitres')
        ? 0 : (save.budget[k as keyof DrainageBudget] ?? NaN))) ||
      ![save.remainder, save.rainDose, save.evaporationDose].every(valid) ||
      save.remainder >= 0.1
    )
      throw new RangeError('Invalid drainage save for this catchment');
    const b = {...save.budget,pickupLitres:save.version===1 ? 0 : save.budget.pickupLitres!,
      returnLitres:save.version===1 ? 0 : save.budget.returnLitres!},
      scale = Math.max(1, b.rainLitres + b.initialLitres);
    const stored = save.depths.reduce((a, h) => a + h, 0) * this.litresPerMetre;
    if (
      Math.abs(stored - b.streetLitres) > 1e-7 * scale ||
      Math.abs(b.initialLitres + b.rainLitres + b.returnLitres - b.pickupLitres - stored - b.roofLitres - b.sewerLitres - b.evaporatedLitres) >
        1e-7 * scale
    )
      throw new RangeError('Water budget does not balance');
    this.depth.set(save.depths);
    for (let i = 0; i < this.depth.length; i++)
      this.depthPixels[i] = THREE.DataUtils.toHalfFloat(this.depth[i]);
    for (let i = 0; i < this.openings.length; i++) this.openings[i] = save.openings[i];
    Object.assign(this.budget, b);
    this.remainder = save.remainder;
    this.rainDose = save.rainDose;
    this.evaporationDose = save.evaporationDose;
    this.depthMap.needsUpdate = true;
  }
  dispose() {
    this.depthMap.dispose();
  }
}
