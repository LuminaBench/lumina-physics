import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface TidalInletOptions {
  /** Lower-left corner and square cell size in world metres. */
  x: number;
  z: number;
  spacing: number;
  columns: number;
  rows: number;
  bedAt(x: number, z: number): number;
  seaEdge: 'west' | 'east' | 'north' | 'south';
  /** Optional gate along the selected boundary. All other faces are impermeable. */
  mouthAt?(x: number, z: number): boolean;
  seaLevel: number;
  /** Initial mean stage per cell in world metres. Low or dry impoundments can start below sea level. */
  initialStageAt?(x: number, z: number): number;
  /** Loose mineral available for suspension, kg/m². */
  bedSiltAt?(x: number, z: number): number;
  seaSiltKgM3?: number;
  settlingMps?: number;
  /** Manning roughness in s/m^(1/3). */
  roughness?: number;
}

export interface InletSave {
  version: 1;
  survey: string;
  water: number[];
  suspended: number[];
  settled: number[];
  discharge: number[];
  remainder: number;
  seaLevel: number;
  stageDose: number;
  floodM3: number;
  ebbM3: number;
  importedKg: number;
  exportedKg: number;
}

const G = 9.81,
  STEP = 1 / 20,
  WET = 0.00005;
const finite = Number.isFinite;
const positive = (n: number) => finite(n) && n >= 0;

/** Local-inertial shallow water on a staggered grid. Per-face donor limiting moves
 * both water and suspended sediment exactly once. The open sea is the only reservoir. */
export class TidalInlet {
  readonly width: number;
  readonly length: number;
  readonly area: number;
  readonly survey: string;
  readonly texture: THREE.DataTexture;
  readonly initialVolume: number;
  readonly initialSediment: number;
  readonly ledger = { floodM3: 0, ebbM3: 0, importedKg: 0, exportedKg: 0 };
  private readonly ground: Float64Array;
  private readonly water: Float64Array;
  private readonly suspended: Float64Array;
  private readonly settled: Float64Array;
  private readonly from: Int32Array;
  private readonly to: Int32Array;
  private readonly axis: Uint8Array;
  private readonly flux: Float64Array;
  private readonly outgoing: Float64Array;
  private readonly waterDelta: Float64Array;
  private readonly siltDelta: Float64Array;
  private readonly flowX: Float64Array;
  private readonly rise: Float64Array;
  private readonly flowZ: Float64Array;
  private readonly field: Float32Array;
  private readonly pixels: Uint16Array;
  private readonly roughness: number;
  private readonly settling: number;
  private readonly seaSilt: number;
  private readonly origin: N;
  private readonly extent: N;
  private readonly dryFloor: number;
  private seaLevel: number;
  private remainder = 0;
  private stageDose = 0;
  private maxDepth = 0;

  constructor(readonly options: TidalInletOptions) {
    const o = options,
      { columns: nx, rows: nz, spacing } = o;
    this.roughness = o.roughness ?? 0.035;
    this.settling = o.settlingMps ?? 0.0025;
    this.seaSilt = o.seaSiltKgM3 ?? 0;
    if (
      ![nx, nz].every((n) => Number.isInteger(n) && n >= 3 && n <= 256) ||
      ![o.x, o.z, spacing, o.seaLevel].every(finite) ||
      spacing <= 0 ||
      ![this.roughness, this.settling, this.seaSilt].every(positive) ||
      !['west', 'east', 'south', 'north'].includes(o.seaEdge)
    )
      throw new RangeError('Invalid tidal inlet survey');
    this.width = nx * spacing;
    this.length = nz * spacing;
    this.area = spacing * spacing;
    this.origin = TSL.vec2(o.x, o.z);
    this.extent = TSL.vec2(this.width, this.length);
    this.seaLevel = o.seaLevel;
    const cells = nx * nz;
    this.ground = new Float64Array(cells);
    this.water = new Float64Array(cells);
    this.suspended = new Float64Array(cells);
    this.settled = new Float64Array(cells);
    this.outgoing = new Float64Array(cells);
    this.waterDelta = new Float64Array(cells);
    this.siltDelta = new Float64Array(cells);
    this.flowX = new Float64Array(cells);
    this.rise = new Float64Array(cells);
    this.flowZ = new Float64Array(cells);
    this.field = new Float32Array(cells * 4);
    this.pixels = new Uint16Array(cells * 4);
    const from: number[] = [],
      to: number[] = [],
      axis: number[] = [];
    const face = (a: number, b: number, dim: number) => {
      from.push(a);
      to.push(b);
      axis.push(dim);
    };
    let volume = 0,
      minerals = 0,
      floor = Infinity,
      mouths = 0;
    for (let j = 0, i = 0; j < nz; j++)
      for (let k = 0; k < nx; k++, i++) {
        const x = o.x + (k + 0.5) * spacing,
          z = o.z + (j + 0.5) * spacing;
        const bed = o.bedAt(x, z),
          stage = o.initialStageAt?.(x, z) ?? o.seaLevel,
          silt = o.bedSiltAt?.(x, z) ?? 0;
        if (!finite(bed) || !finite(stage) || !positive(silt))
          throw new RangeError('Invalid inlet bed, water level or mineral inventory');
        this.ground[i] = bed;
        this.water[i] = Math.max(0, stage - bed);
        this.settled[i] = silt * this.area;
        floor = Math.min(floor, bed);
        this.maxDepth = Math.max(this.maxDepth, this.water[i]);
        volume += this.water[i] * this.area;
        minerals += this.settled[i];
        if (k > 0) face(i - 1, i, 0);
        if (j > 0) face(i - nx, i, 1);
        const west = k === 0 && o.seaEdge === 'west',
          east = k === nx - 1 && o.seaEdge === 'east';
        const south = j === 0 && o.seaEdge === 'south',
          north = j === nz - 1 && o.seaEdge === 'north';
        if (west || east || south || north) {
          const xf = x + ((Number(east) - Number(west)) * spacing) / 2;
          const zf = z + ((Number(north) - Number(south)) * spacing) / 2;
          if (!o.mouthAt || o.mouthAt(xf, zf)) {
            face(west || south ? -1 : i, west || south ? i : -1, west || east ? 0 : 1);
            mouths++;
          }
        }
      }
    if (!mouths) throw new RangeError('The surveyed inlet needs an open sea face');
    this.dryFloor = floor;
    this.initialVolume = volume;
    this.initialSediment = minerals;
    this.from = Int32Array.from(from);
    this.to = Int32Array.from(to);
    this.axis = Uint8Array.from(axis);
    this.flux = new Float64Array(from.length);
    let hash = 2166136261;
    for (const bytes of [this.ground, this.from, this.to, this.axis])
      for (const byte of new Uint8Array(bytes.buffer)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    this.survey = [
      o.x,
      o.z,
      nx,
      nz,
      spacing,
      hash,
      volume,
      minerals,
      this.roughness,
      this.settling,
      this.seaSilt,
    ].join('/');
    this.texture = new THREE.DataTexture(this.pixels, nx, nz, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.updateTexture();
  }

  /** Supply the external stage at the end of dt. Integrate linearly between samples. */
  update(dt: number, stage: number) {
    if (!positive(dt) || !finite(stage)) throw new RangeError('Invalid inlet time or sea level');
    if (dt === 0) return;
    const start = this.seaLevel;
    let elapsed = 0,
      changed = false;
    while (elapsed < dt - 1e-12) {
      const chunk = Math.min(dt - elapsed, STEP - this.remainder);
      this.stageDose += chunk * (start + ((stage - start) * (elapsed + chunk / 2)) / dt);
      this.remainder += chunk;
      elapsed += chunk;
      if (this.remainder >= STEP - 1e-10) {
        const boundary = this.stageDose / this.remainder;
        const wave = Math.sqrt(G * Math.max(this.maxDepth, boundary - this.dryFloor, 0));
        const steps = Math.max(1, Math.ceil((STEP * wave) / (0.42 * this.options.spacing)));
        for (let i = 0; i < steps; i++) this.advance(STEP / steps, boundary);
        this.stageDose = this.remainder = 0;
        changed = true;
      }
    }
    this.seaLevel = stage;
    if (changed) this.updateTexture();
  }

  private advance(dt: number, stage: number) {
    const dx = this.options.spacing,
      factor = dt * dx,
      bed = this.ground,
      depth = this.water;
    this.outgoing.fill(0);
    this.waterDelta.fill(0);
    this.siltDelta.fill(0);
    this.maxDepth = 0;
    for (let f = 0; f < this.flux.length; f++) {
      const a = this.from[f],
        b = this.to[f],
        ba = bed[a < 0 ? b : a],
        bb = bed[b < 0 ? a : b];
      const ha = a < 0 ? stage : ba + depth[a],
        hb = b < 0 ? stage : bb + depth[b];
      const faceDepth = Math.max(ha, hb) - Math.max(ba, bb);
      let q = 0;
      if (faceDepth > WET) {
        const old = this.flux[f],
          distance = a < 0 || b < 0 ? dx / 2 : dx;
        const drag = (G * this.roughness ** 2 * Math.abs(old)) / faceDepth ** (7 / 3);
        // A little along-channel momentum exchange damps alternating cell-scale
        // standing waves. Each old cell flow is half the sum of its two face fluxes.
        const flow = this.axis[f] === 0 ? this.flowX : this.flowZ;
        const momentum = a < 0 || b < 0 ? old : old + 0.2 * (flow[a] + flow[b] - 2 * old);
        q = (momentum + (dt * G * faceDepth * (ha - hb)) / distance) / (1 + dt * drag);
      }
      this.flux[f] = q;
      const source = q >= 0 ? a : b;
      if (source >= 0) this.outgoing[source] += Math.abs(q) * factor;
    }
    this.flowX.fill(0);
    this.flowZ.fill(0);
    for (let f = 0; f < this.flux.length; f++) {
      const a = this.from[f],
        b = this.to[f],
        q = this.flux[f],
        source = q >= 0 ? a : b;
      if (q === 0) continue;
      const available = source < 0 ? Infinity : depth[source] * this.area;
      const limited =
        source >= 0 && this.outgoing[source] > available ? (q * available) / this.outgoing[source] : q;
      this.flux[f] = limited;
      if (limited === 0) continue;
      const moved = limited * factor;
      const sediment = moved * (source < 0 ? this.seaSilt : this.suspended[source] / available);
      const flow = this.axis[f] === 0 ? this.flowX : this.flowZ;
      if (a >= 0) {
        this.waterDelta[a] -= moved;
        this.siltDelta[a] -= sediment;
        flow[a] += 0.5 * limited;
      }
      if (b >= 0) {
        this.waterDelta[b] += moved;
        this.siltDelta[b] += sediment;
        flow[b] += 0.5 * limited;
      }
      if (a < 0 || b < 0) {
        if (source < 0) {
          this.ledger.floodM3 += Math.abs(moved);
          this.ledger.importedKg += Math.abs(sediment);
        } else {
          this.ledger.ebbM3 += Math.abs(moved);
          this.ledger.exportedKg += Math.abs(sediment);
        }
      }
    }
    for (let i = 0; i < depth.length; i++) {
      const h = (depth[i] = Math.max(0, depth[i] + this.waterDelta[i] / this.area));
      this.rise[i] = this.waterDelta[i] / (this.area * dt);
      this.maxDepth = Math.max(this.maxDepth, h);
      const mass = Math.max(0, this.suspended[i] + this.siltDelta[i]);
      if (mass > 0) {
        const deposit = h <= WET ? mass : mass * -Math.expm1((-dt * this.settling) / h);
        this.settled[i] += deposit;
        this.suspended[i] = mass - deposit;
      } else this.suspended[i] = 0;
    }
  }

  /** Resuspend existing bed sediment at a propeller or foot contact. Returns actual kilograms. */
  stir(x: number, z: number, kilograms: number) {
    if (!finite(x) || !finite(z) || !positive(kilograms)) throw new RangeError('Invalid inlet contact');
    const o = this.options,
      col = Math.floor((x - o.x) / o.spacing),
      row = Math.floor((z - o.z) / o.spacing);
    if (col < 0 || row < 0 || col >= o.columns || row >= o.rows) return 0;
    const i = col + row * o.columns;
    if (this.water[i] < WET) return 0;
    const moved = Math.min(kilograms, this.settled[i]);
    this.settled[i] -= moved;
    this.suspended[i] += moved;
    if (moved > 0) {
      this.writeCell(i);
      this.texture.needsUpdate = true;
    }
    return moved;
  }
  private writeCell(i: number) {
    const h = this.water[i],
      k = i * 4;
    // A dry cell's visual interface recedes below its bed. The conservative volume remains zero.
    let stage = this.ground[i] + h;
    if (h <= WET) {
      const cols = this.options.columns;
      let nearest = -Infinity;
      if (i % cols && this.water[i - 1] > WET) nearest = this.ground[i - 1] + this.water[i - 1];
      if (i % cols < cols - 1 && this.water[i + 1] > WET)
        nearest = Math.max(nearest, this.ground[i + 1] + this.water[i + 1]);
      if (i >= cols && this.water[i - cols] > WET)
        nearest = Math.max(nearest, this.ground[i - cols] + this.water[i - cols]);
      if (i + cols < this.water.length && this.water[i + cols] > WET)
        nearest = Math.max(nearest, this.ground[i + cols] + this.water[i + cols]);
      stage = Math.min(this.ground[i] - 0.04, nearest === -Infinity ? this.seaLevel : nearest);
    }
    this.field[k] = stage;
    this.field[k + 1] = h > WET ? this.flowX[i] / h : 0;
    this.field[k + 2] = h > WET ? this.flowZ[i] / h : 0;
    this.field[k + 3] = h > WET ? this.suspended[i] / (h * this.area) : 0;
    for (let c = 0; c < 4; c++) this.pixels[k + c] = THREE.DataUtils.toHalfFloat(this.field[k + c]);
  }
  private updateTexture() {
    for (let i = 0; i < this.water.length; i++) this.writeCell(i);
    this.texture.needsUpdate = true;
  }
  private channel(
    x: number,
    z: number,
    c: number,
    data: Float32Array | Float64Array = this.field,
    stride = 4,
  ) {
    const o = this.options,
      u = THREE.MathUtils.clamp((x - o.x) / o.spacing - 0.5, 0, o.columns - 1),
      v = THREE.MathUtils.clamp((z - o.z) / o.spacing - 0.5, 0, o.rows - 1);
    const col = Math.min(o.columns - 2, Math.floor(u)),
      row = Math.min(o.rows - 2, Math.floor(v));
    const a = stride * (row * o.columns + col) + c,
      b = a + stride * o.columns;
    const bottom = THREE.MathUtils.lerp(data[a], data[a + stride], u - col);
    const top = THREE.MathUtils.lerp(data[b], data[b + stride], u - col);
    return THREE.MathUtils.lerp(bottom, top, v - row);
  }
  weightAt(x: number, z: number) {
    const dx = x - this.options.x,
      dz = z - this.options.z;
    return THREE.MathUtils.smoothstep(
      Math.min(dx, dz, this.width - dx, this.length - dz),
      0,
      this.options.spacing * 1.5,
    );
  }
  weightNode(xz: N): N {
    const d = xz.sub(this.origin),
      edge = TSL.min(d, this.extent.sub(d));
    return TSL.smoothstep(0, this.options.spacing * 1.5, TSL.min(edge.x, edge.y));
  }
  /** RGBA contains world stage in m, X and Z velocity in m/s and suspended kg/m³. */
  fieldNode(xz: N): N {
    return TSL.texture(this.texture, xz.sub(this.origin).div(this.extent)).level(0);
  }
  stageAt(x: number, z: number, outside: number) {
    const weight = this.weightAt(x, z);
    return weight > 0 ? THREE.MathUtils.lerp(outside, this.channel(x, z, 0), weight) : outside;
  }
  stageNode(xz: N, outside: N): N {
    return TSL.mix(outside, this.fieldNode(xz).r, this.weightNode(xz));
  }
  concentrationNode(xz: N): N {
    return this.fieldNode(xz).a.mul(this.weightNode(xz));
  }
  horizontalFlowNode(xz: N): N {
    return this.fieldNode(xz).gb.mul(this.weightNode(xz));
  }
  /** Blend an existing ambient current into this surveyed flow. */
  applyCurrent(x: number, z: number, out: THREE.Vector3) {
    const weight = this.weightAt(x, z);
    if (weight > 0) {
      out.x = THREE.MathUtils.lerp(out.x, this.channel(x, z, 1), weight);
      out.y = THREE.MathUtils.lerp(out.y, this.channel(x, z, 0, this.rise, 1), weight);
      out.z = THREE.MathUtils.lerp(out.z, this.channel(x, z, 2), weight);
    }
    return out;
  }
  concentrationAt(x: number, z: number) {
    const w = this.weightAt(x, z);
    return w > 0 ? w * this.channel(x, z, 3) : 0;
  }
  balance() {
    let waterM3 = 0,
      suspendedKg = 0,
      bedKg = 0;
    for (let i = 0; i < this.water.length; i++) {
      waterM3 += this.water[i] * this.area;
      suspendedKg += this.suspended[i];
      bedKg += this.settled[i];
    }
    return {
      waterM3,
      suspendedKg,
      bedKg,
      ...this.ledger,
      waterErrorM3: waterM3 + this.ledger.ebbM3 - this.ledger.floodM3 - this.initialVolume,
      sedimentErrorKg:
        suspendedKg + bedKg + this.ledger.exportedKg - this.ledger.importedKg - this.initialSediment,
    };
  }
  save(): InletSave {
    return {
      version: 1,
      survey: this.survey,
      water: Array.from(this.water),
      suspended: Array.from(this.suspended),
      settled: Array.from(this.settled),
      discharge: Array.from(this.flux),
      remainder: this.remainder,
      seaLevel: this.seaLevel,
      stageDose: this.stageDose,
      ...this.ledger,
    };
  }
  restore(s: InletSave) {
    const n = this.water.length;
    if (
      s.version !== 1 ||
      s.survey !== this.survey ||
      ![s.water, s.suspended, s.settled].every(
        (a) => Array.isArray(a) && a.length === n && a.every(positive),
      ) ||
      !Array.isArray(s.discharge) ||
      s.discharge.length !== this.flux.length ||
      !s.discharge.every(finite) ||
      ![s.floodM3, s.ebbM3, s.importedKg, s.exportedKg, s.remainder].every(positive) ||
      s.remainder >= STEP ||
      !finite(s.seaLevel) ||
      !finite(s.stageDose)
    )
      throw new RangeError('Invalid tidal inlet save');
    const sum = (a: number[]) => a.reduce((total, v) => total + v, 0);
    const waterError = sum(s.water) * this.area + s.ebbM3 - s.floodM3 - this.initialVolume;
    const mineralsError =
      sum(s.suspended) + sum(s.settled) + s.exportedKg - s.importedKg - this.initialSediment;
    if (
      Math.abs(waterError) > 1e-8 * Math.max(1, this.initialVolume + s.floodM3) ||
      Math.abs(mineralsError) > 1e-8 * Math.max(1, this.initialSediment + s.importedKg)
    )
      throw new RangeError('Inlet budget does not balance');
    this.water.set(s.water);
    this.suspended.set(s.suspended);
    this.settled.set(s.settled);
    this.flux.set(s.discharge);
    this.maxDepth = this.water.reduce((a, b) => Math.max(a, b), 0);
    this.remainder = s.remainder;
    this.seaLevel = s.seaLevel;
    this.stageDose = s.stageDose;
    this.ledger.floodM3 = s.floodM3;
    this.ledger.ebbM3 = s.ebbM3;
    this.ledger.importedKg = s.importedKg;
    this.ledger.exportedKg = s.exportedKg;
    this.flowX.fill(0);
    this.flowZ.fill(0);
    this.rise.fill(0);
    for (let f = 0; f < this.flux.length; f++) {
      const flow = this.axis[f] === 0 ? this.flowX : this.flowZ,
        q = this.flux[f] * 0.5;
      if (this.from[f] >= 0) {
        flow[this.from[f]] += q;
        this.rise[this.from[f]] -= this.flux[f] / this.options.spacing;
      }
      if (this.to[f] >= 0) {
        flow[this.to[f]] += q;
        this.rise[this.to[f]] += this.flux[f] / this.options.spacing;
      }
    }
    this.updateTexture();
  }
  dispose() {
    this.texture.dispose();
  }
}
