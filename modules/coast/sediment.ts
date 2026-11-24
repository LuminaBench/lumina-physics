import * as THREE from 'three/webgpu';
import { SandWaterColumn, type SandWaterOptions } from './sand-water';
import type { Coastline } from './coastline';
import type { CoastalSurf } from './surf';

const SIDE = 32,
  CELLS = SIDE * SIDE;
export const SEDIMENT_SPACING = 0.04;
const TILE = SIDE * SEDIMENT_SPACING,
  STEP = 1 / 12,
  clamp = THREE.MathUtils.clamp;
const keyOf = (tx: number, tz: number) => tx + ',' + tz;
const flags = { none: 0, sea: 1, rain: 2, drainage: 3 } as const;
export const sedimentReading = () => ({
  height: 0,
  relief: 0,
  packing: 0,
  film: 0,
  filmMm: 0,
  poreMm: 0,
  poreSaturation: 0,
  water: 0,
  silt: 0,
  lastWet: 'none' as keyof typeof flags,
});
type Reading = ReturnType<typeof sedimentReading>;

interface Tile {
  x: number;
  z: number;
  used: number;
  updated: number;
  edited: boolean;
  retention: number;
  base: Float32Array;
  relief: Float32Array;
  packing: Float32Array;
  film: Float32Array; // retained surface film, mm
  pore: Float32Array; // pore water, mm
  hydrated: boolean;
  water: Float32Array;
  silt: Float32Array;
  delta: Float32Array;
  siltFlux: Float32Array;
  source: Uint8Array;
  blocked: Uint8Array;
  shadow?: Uint8Array;
  inletWeight?: Float32Array;
}
export interface SedimentSave {
  version: 1 | 2;
  remainder?: number;
  hydrology?: number[];
  level?: number;
  strength?: number;
  seed: number;
  spacing: number;
  time: number;
  tiles: {
    x: number;
    z: number;
    data: string;
    codec?: 'runs';
    updated?: number;
    edited?: boolean;
    columns?: { data: string; codec?: 'runs' };
  }[];
}
/** Run-length encode whole cells, keeping heterogeneous pages raw when that is smaller. */
function packCells(bytes: Uint8Array, stride = 6): Pick<SedimentSave['tiles'][number], 'data' | 'codec'> {
  const runs: number[] = [];
  for (let first = 0; first < bytes.length; ) {
    let count = 1;
    while (count < 255 && first + count * stride < bytes.length) {
      let equal = true;
      for (let channel = 0; channel < stride; channel++)
        if (bytes[first + channel] !== bytes[first + count * stride + channel]) {
          equal = false;
          break;
        }
      if (!equal) break;
      count++;
    }
    runs.push(count, ...bytes.subarray(first, first + stride));
    if (runs.length >= bytes.length) return { data: btoa(String.fromCharCode(...bytes)) };
    first += count * stride;
  }
  return { codec: 'runs', data: btoa(String.fromCharCode(...runs)) };
}
function unpackCells(tile: { data: string; codec?: 'runs' }, stride = 6) {
  if (typeof tile.data !== 'string' || tile.data.length > 4 * Math.ceil((CELLS * stride) / 3))
    throw new RangeError('Invalid sediment payload');
  const input = atob(tile.data);
  if (tile.codec === undefined && input.length === CELLS * stride) return input;
  if (tile.codec !== 'runs' || input.length % (stride + 1) !== 0)
    throw new RangeError('Invalid sediment encoding');
  let output = '';
  for (let i = 0; i < input.length; i += stride + 1) {
    const count = input.charCodeAt(i);
    if (!count || output.length + count * stride > CELLS * stride)
      throw new RangeError('Invalid sediment run');
    output += input.slice(i + 1, i + stride + 1).repeat(count);
  }
  if (output.length !== CELLS * stride) throw new RangeError('Incomplete sediment tile');
  return output;
}
export interface SedimentOptions {
  ground: (x: number, z: number) => number;
  maxTiles?: number;
  waterColumn?: SandWaterOptions;
  fullRainMmHour?: number;
  /** Prefer edited tiles around a game landmark on eviction. Receives tile-centre world XZ. */
  retainAt?: (x: number, z: number) => boolean;
  rainAt?: (x: number, z: number) => number;
  moveLooseSand?: (x:number,z:number,yaw:number,width:number,length:number,depth:number,slip:number) => void;
  /** Optional local wall/rock top in world metres. */
  barrierAt?: (x: number, z: number) => number;
}
export class CoastalSediment {
  readonly tiles = new Map<string, Tile>();
  readonly column: SandWaterColumn;
  private readonly rainMetresPerSecond: number;
  time = 0;
  level = 0;
  strength = 0.54;
  private frame = 0;
  private remainder = 0;
  private readonly active: Tile[] = [];
  private readonly heights = new Float64Array(4);
  private readonly spills = new Float64Array(4);
  private readonly shoreTexel = new THREE.Vector4();
  private readonly reader = sedimentReading();
  private readonly maxTiles: number;
  constructor(
    readonly coast: Coastline,
    readonly surf: CoastalSurf,
    readonly options: SedimentOptions,
  ) {
    this.column = new SandWaterColumn({
      drainageSeconds: coast.sand.drainageSeconds,
      ...options.waterColumn,
    });
    const rainRate = options.fullRainMmHour ?? 36;
    if (!Number.isFinite(rainRate) || rainRate < 0) throw new RangeError('Invalid full sand rainfall rate');
    this.rainMetresPerSecond = rainRate / 3_600_000;
    this.maxTiles = options.maxTiles ?? 384;
    if (!Number.isInteger(this.maxTiles) || this.maxTiles < 64)
      throw new RangeError('Coastal sediment needs at least 64 tiles');
  }
  private acquire(x: number, z: number) {
    const key = keyOf(x, z);
    let tile = this.tiles.get(key);
    if (!tile) {
      let recycled: Tile | undefined;
      if (this.tiles.size >= this.maxTiles) {
        let victim: Tile | undefined;
        for (const candidate of this.tiles.values()) {
          if (candidate.used === this.frame) continue;
          const priority = candidate.edited ? candidate.retention : 0,
            old = victim?.edited ? victim.retention : 0;
          if (!victim || priority < old || (priority === old && candidate.used < victim.used))
            victim = candidate;
        }
        if (!victim) victim = this.tiles.values().next().value;
        if (victim) {
          this.tiles.delete(keyOf(victim.x, victim.z));
          recycled = victim;
        }
      }
      tile = recycled ?? {
        x,
        z,
        used: this.frame,
        updated: this.time,
        edited: false,
        retention: 1,
        base: new Float32Array(CELLS),
        relief: new Float32Array(CELLS),
        packing: new Float32Array(CELLS),
        film: new Float32Array(CELLS),
        pore: new Float32Array(CELLS),
        hydrated: false,
        water: new Float32Array(CELLS),
        silt: new Float32Array(CELLS),
        delta: new Float32Array(CELLS),
        siltFlux: new Float32Array(CELLS),
        source: new Uint8Array(CELLS),
        blocked: new Uint8Array(CELLS),
        shadow: this.options.barrierAt ? new Uint8Array(CELLS) : undefined,
        inletWeight: this.surf.localWater ? new Float32Array(CELLS) : undefined,
      };
      tile.retention = this.options.retainAt?.((x + 0.5) * TILE, (z + 0.5) * TILE) ? 2 : 1;
      if (recycled) {
        tile.x = x;
        tile.z = z;
        tile.updated = this.time;
        tile.edited = false;
        tile.relief.fill(0);
        tile.packing.fill(0);
        tile.water.fill(0);
        tile.silt.fill(0);
        tile.film.fill(0);
        tile.pore.fill(0);
        tile.hydrated = false;
        tile.source.fill(0);
      }
      for (let iz = 0, i = 0; iz < SIDE; iz++)
        for (let ix = 0; ix < SIDE; ix++, i++) {
          const wx = x * TILE + (ix + 0.5) * SEDIMENT_SPACING,
            wz = z * TILE + (iz + 0.5) * SEDIMENT_SPACING;
          tile.base[i] = this.options.ground(wx, wz);
          if (tile.inletWeight) tile.inletWeight[i] = this.surf.localWater!.weightAt(wx, wz);
          if (tile.shadow) tile.shadow[i] = Number(this.surf.hasWaveShadow(wx, wz));
          tile.blocked[i] = Number(
            !!this.coast.options.protectedAt?.(wx, wz) ||
              (this.options.barrierAt?.(wx, wz) ?? -Infinity) > tile.base[i] + 0.01,
          );
        }
      this.tiles.set(key, tile);
    }
    tile.used = this.frame;
    return tile;
  }
  refreshGround(minX: number, minZ: number, maxX: number, maxZ: number) {
    for (let tz = Math.floor(minZ / TILE); tz <= Math.floor(maxZ / TILE); tz++)
      for (let tx = Math.floor(minX / TILE); tx <= Math.floor(maxX / TILE); tx++) {
        const tile = this.tiles.get(keyOf(tx, tz));
        if (!tile) continue;
        for (let z = 0, i = 0; z < SIDE; z++)
          for (let x = 0; x < SIDE; x++, i++) {
            const wx = tx * TILE + (x + 0.5) * SEDIMENT_SPACING,
              wz = tz * TILE + (z + 0.5) * SEDIMENT_SPACING;
            if (wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ)
              tile.base[i] = this.options.ground(wx, wz);
          }
      }
  }
  private head(x: number, z: number, h: number) {
    const level = this.surf.localWater?.stageAt(x, z, this.level) ?? this.level;
    return level + this.surf.offset(x, z, level - h, this.time, this.strength, level);
  }
  inspect(x: number, z: number, out = this.reader): Reading {
    const tx = Math.floor(x / TILE),
      tz = Math.floor(z / TILE),
      t = this.tiles.get(keyOf(tx, tz));
    const i =
      Math.floor(x / SEDIMENT_SPACING) - tx * SIDE + SIDE * (Math.floor(z / SEDIMENT_SPACING) - tz * SIDE);
    const h = t ? t.base[i] : this.options.ground(x, z);
    out.relief = t?.relief[i] ?? 0;
    out.height = h + out.relief;
    out.packing = t?.packing[i] ?? 0;
    const blocked = t
      ? t.blocked[i]
      : this.coast.options.protectedAt?.(x, z) || (this.options.barrierAt?.(x, z) ?? -Infinity) > h + 0.01;
    const openDepth = blocked ? 0 : Math.max(0, this.head(x, z, h) - out.height);
    out.water = Math.max(t?.water[i] ?? 0, openDepth);
    out.filmMm = t?.film[i] ?? 0;
    out.poreMm = t?.pore[i] ?? 0;
    out.poreSaturation = out.poreMm / this.column.poreCapacityMm;
    // Legacy contact wetness includes enough water in the grains to adhere to a tire.
    out.film = Math.max(
      out.poreSaturation,
      out.filmMm / this.column.filmCapacityMm,
      Math.min(1, out.water * 360),
    );
    out.silt = t?.silt[i] ?? 0;
    const f = t?.source[i] ?? 0;
    out.lastWet =
      openDepth > 0.001 || f === flags.sea
        ? 'sea'
        : f === flags.rain
          ? 'rain'
          : f === flags.drainage
            ? 'drainage'
            : 'none';
    return out;
  }
  /** yaw is measured from +Z towards +X. load is normalized and slip is signed. */
  imprint(
    kind: 'foot' | 'wheel',
    x: number,
    z: number,
    yaw: number,
    width: number,
    length: number,
    load = 1,
    slip = 0,
  ) {
    if (
      ![x, z, yaw, width, length, load, slip].every(Number.isFinite) ||
      width <= 0 ||
      length <= 0 ||
      Math.max(width, length) > 4
    )
      throw new RangeError('Invalid footprint dimensions');
    if (load <= 0) return;
    this.options.moveLooseSand?.(
      x,
      z,
      yaw,
      width,
      length,
      Math.min(2, load) * (kind === 'foot' ? 0.014 : 0.022),
      slip,
    );
    const radius = Math.hypot(width, length) * 0.66 + SEDIMENT_SPACING,
      s = Math.sin(yaw),
      c = Math.cos(yaw);
    const tx0 = Math.floor((x - radius) / TILE),
      tx1 = Math.floor((x + radius) / TILE),
      tz0 = Math.floor((z - radius) / TILE),
      tz1 = Math.floor((z + radius) / TILE);
    const moisture = this.inspect(x, z).film,
      stiffness = this.coast.sand.packing,
      plastic = 0.022 + 0.025 * (1 - stiffness) + 0.015 * moisture;
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.acquire(tx, tz);
        for (let iz = 0, i = 0; iz < SIDE; iz++)
          for (let ix = 0; ix < SIDE; ix++, i++) {
            if (t.blocked[i]) continue;
            const dx = tx * TILE + (ix + 0.5) * SEDIMENT_SPACING - x,
              dz = tz * TILE + (iz + 0.5) * SEDIMENT_SPACING - z;
            const u = (dx * c - dz * s) / (width * 0.5),
              v = (dx * s + dz * c) / (length * 0.5);
            const fore = kind === 'foot' ? clamp((v + 0.2) * 2, 0, 1) : 1;
            const contour =
              kind === 'foot' ? Math.hypot(u / (0.65 + 0.36 * fore), v) : Math.max(Math.abs(u), Math.abs(v));
            if (contour > 1.26) continue;
            const interior = 1 - THREE.MathUtils.smoothstep(contour, 0.68, 1);
            const rib =
              kind === 'wheel'
                ? 0.78 + 0.22 * Math.cos(13 * v + 2.6 * Math.abs(u))
                : 0.75 + 0.25 * Math.cos(10 * v) * Math.cos(u * 4);
            const pressure =
              plastic * Math.min(2, load) * rib * interior * (kind === 'foot' ? 0.78 + 0.22 * v * v : 1);
            const rim =
              0.013 *
              (1 - Math.min(1, Math.abs(contour - 1.03) / 0.23)) *
              (1 + clamp(slip, -1, 1) * u * 0.65);
            t.relief[i] = clamp(Math.min(t.relief[i], -pressure) + rim, -0.11, 0.055);
            t.packing[i] = Math.max(t.packing[i], interior * clamp(load, 0, 1));
            t.silt[i] = Math.min(1, t.silt[i] + interior * t.water[i] * 3);
            t.edited = true;
          }
      }
  }
  /** Apply a finite shower or splash. Depth in mm tapers to zero at the rim. Returns delivered litres. */
  wetPatch(x: number, z: number, radius: number, depthMm: number) {
    if (![x, z, radius, depthMm].every(Number.isFinite) || radius <= 0 || radius > 4 || depthMm < 0)
      throw new RangeError('Invalid sand wetting radius or depth');
    if (depthMm === 0) return 0;
    let litres = 0;
    for (
      let gz = Math.floor((z - radius) / SEDIMENT_SPACING);
      gz <= Math.floor((z + radius) / SEDIMENT_SPACING);
      gz++
    ) {
      for (
        let gx = Math.floor((x - radius) / SEDIMENT_SPACING);
        gx <= Math.floor((x + radius) / SEDIMENT_SPACING);
        gx++
      ) {
        const dx = (gx + 0.5) * SEDIMENT_SPACING - x,
          dz = (gz + 0.5) * SEDIMENT_SPACING - z;
        const depth = depthMm * Math.max(0, 1 - (dx * dx + dz * dz) / (radius * radius));
        if (!depth) continue;
        const tx = Math.floor(gx / SIDE),
          tz = Math.floor(gz / SIDE),
          tile = this.acquire(tx, tz);
        const i = gx - tx * SIDE + (gz - tz * SIDE) * SIDE;
        if (tile.blocked[i]) continue;
        tile.water[i] += depth * 0.001;
        tile.source[i] = flags.drainage;
        tile.edited = tile.hydrated = true;
        litres += depth * SEDIMENT_SPACING ** 2;
      }
    }
    return litres;
  }
  /** Stir a submerged disk without changing the bed height. Strength is a concentration increment. */
  stir(x: number, z: number, radius: number, strength: number) {
    if (![x, z, radius, strength].every(Number.isFinite) || radius <= 0 || radius > 4 || strength < 0)
      throw new RangeError('Invalid sediment disturbance');
    const radiusSq = radius * radius;
    for (
      let gz = Math.floor((z - radius) / SEDIMENT_SPACING);
      gz <= Math.floor((z + radius) / SEDIMENT_SPACING);
      gz++
    ) {
      const tz = Math.floor(gz / SIDE),
        row = (gz - tz * SIDE) * SIDE;
      for (
        let gx = Math.floor((x - radius) / SEDIMENT_SPACING);
        gx <= Math.floor((x + radius) / SEDIMENT_SPACING);
        gx++
      ) {
        const dx = (gx + 0.5) * SEDIMENT_SPACING - x,
          dz = (gz + 0.5) * SEDIMENT_SPACING - z,
          weight = 1 - (dx * dx + dz * dz) / radiusSq;
        if (weight <= 0) continue;
        const tx = Math.floor(gx / SIDE),
          tile = this.acquire(tx, tz),
          i = row + gx - tx * SIDE;
        if (!tile.blocked[i] && tile.water[i] > 0.002)
          tile.silt[i] = Math.min(1, tile.silt[i] + weight * strength);
      }
    }
  }
  private supply(t: Tile) {
    const dt = STEP,
      timeAway = Math.max(0, this.time - t.updated - dt),
      retainedPore = Math.exp(-dt / this.column.drainageSeconds),
      awayPore = Math.exp(-timeAway / this.column.drainageSeconds);
    const rain = clamp(this.options.rainAt?.((t.x + 0.5) * TILE, (t.z + 0.5) * TILE) ?? 0, 0, 1);
    const awayDecay = timeAway > dt ? Math.exp(-timeAway / 15) : 1,
      retreat = Math.exp(-dt * 3),
      settle = Math.exp(-dt * 0.24);
    t.hydrated = false;
    for (let k = 0; k < 4; k++) {
      const x = (t.x + (k & 1)) * TILE,
        z = (t.z + (k >> 1)) * TILE;
      this.heights[k] = this.head(x, z, this.options.ground(x, z));
      this.spills[k] = this.surf.read(x, z, this.shoreTexel).w;
    }
    const h = this.heights,
      s = this.spills;
    for (let iz = 0, i = 0; iz < SIDE; iz++) {
      const v = (iz + 0.5) / SIDE,
        left = h[0] + (h[2] - h[0]) * v,
        right = h[1] + (h[3] - h[1]) * v;
      const west = s[0] + (s[2] - s[0]) * v,
        east = s[1] + (s[3] - s[1]) * v;
      for (let ix = 0; ix < SIDE; ix++, i++) {
        if (t.blocked[i]) continue;
        const ground = t.base[i] + t.relief[i],
          incoming = t.shadow?.[i]
            ? this.head(
                t.x * TILE + (ix + 0.5) * SEDIMENT_SPACING,
                t.z * TILE + (iz + 0.5) * SEDIMENT_SPACING,
                t.base[i],
              )
            : left + ((right - left) * (ix + 0.5)) / SIDE,
          sea = Math.max(0, incoming - ground);
        const reflooded = sea > 0 || t.source[i] === flags.sea;
        let old = t.water[i] * (reflooded ? awayDecay : 1);
        if (timeAway > 0.000001 && old + t.pore[i] + t.film[i] > 0) {
          const away = this.column.advance(old * 1000, t.film[i], t.pore[i], timeAway, awayPore);
          old = away.standingMm * 0.001;
          t.water[i] = old;
          t.film[i] = away.filmMm;
          t.pore[i] = away.poreMm;
        }
        // An open sheet retreats rapidly. A hollow retains water to the height of its lip.
        const inlet = t.inletWeight?.[i] ?? 0;
        const contactDepth = Math.max(0, -t.relief[i]);
        const trapped = Math.max(
          contactDepth,
          (west + ((east - west) * (ix + 0.5)) / SIDE - ground) * (1 - inlet),
        );
        // The inlet stores the connected water column. Keep just local depression storage
        // in the sand tiles, so draining the pool cannot leave a second standing layer.
        const pickup = sea - inlet * Math.max(0, sea - contactDepth);
        const free = reflooded ? Math.min(old, trapped) + Math.max(0, old - trapped) * retreat : old;
        const water = Math.max(pickup, free) + rain * this.rainMetresPerSecond * dt;
        if (sea > 0.001) {
          t.source[i] = flags.sea;
          const erode = 1 - Math.exp(-dt * Math.min(1.1, sea * 4.8));
          t.silt[i] = Math.min(1, t.silt[i] + Math.abs(t.relief[i]) * erode * 24);
          t.relief[i] *= 1 - erode;
          t.packing[i] *= 1 - erode;
        } else if (rain > 0.01) t.source[i] = flags.rain;
        // The inlet owns its free surface. Admit only what the bed can retain this tick.
        const bedSupply =
          Math.max(0, this.column.filmCapacityMm - t.film[i]) +
          Math.min(this.column.infiltrationMmS * dt, this.column.poreCapacityMm - t.pore[i] * retainedPore);
        const available = Math.max(water * 1000, Math.min(inlet * sea * 1000, bedSupply));
        if (available > 0 || t.pore[i] > 0 || t.film[i] > 0) {
          const col = this.column.advance(available, t.film[i], t.pore[i], dt, retainedPore);
          t.water[i] = col.standingMm * 0.001;
          t.film[i] = col.filmMm;
          t.pore[i] = col.poreMm;
          t.hydrated ||= col.standingMm + col.filmMm + col.poreMm > 0.0001;
        }
        t.silt[i] *= settle;
      }
    }
    t.updated = this.time;
    t.delta.fill(0);
    t.siltFlux.fill(0);
  }
  private transfer(a: Tile, i: number, b: Tile, j: number) {
    if (a.blocked[i] || b.blocked[j] || a.water[i] + b.water[j] < 0.0001) return;
    const head = a.base[i] + a.relief[i] + a.water[i] - b.base[j] - b.relief[j] - b.water[j];
    const flow = head > 0 ? Math.min(head, a.water[i]) * 0.18 : -Math.min(-head, b.water[j]) * 0.18;
    const carried = flow * (flow > 0 ? a.silt[i] : b.silt[j]);
    a.delta[i] -= flow;
    b.delta[j] += flow;
    a.siltFlux[i] -= carried;
    b.siltFlux[j] += carried;
  }
  update(dt: number, x: number, z: number, level: number, strength: number) {
    this.level = level;
    this.strength = strength;
    this.remainder += Math.max(0, dt);
    const ticks = Math.floor(this.remainder / STEP);
    if (!ticks) return false;
    this.remainder -= ticks * STEP;
    this.time += Math.max(0, ticks - 6) * STEP;
    const tx = Math.floor(x / TILE),
      tz = Math.floor(z / TILE);
    this.frame++;
    this.active.length = 0;
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) this.active.push(this.acquire(tx + dx, tz + dz));
    for (let n = 0; n < Math.min(ticks, 6); n++) {
      this.time += STEP;
      for (const t of this.active) this.supply(t);
      for (const t of this.active) {
        const east = t.x < tx + 3 ? this.tiles.get(keyOf(t.x + 1, t.z)) : undefined;
        const north = t.z < tz + 3 ? this.tiles.get(keyOf(t.x, t.z + 1)) : undefined;
        for (let j = 0, k = 0; j < SIDE; j++)
          for (let i = 0; i < SIDE; i++, k++) {
            if (i + 1 < SIDE) this.transfer(t, k, t, k + 1);
            else if (east) this.transfer(t, k, east, k + 1 - SIDE);
            if (j + 1 < SIDE) this.transfer(t, k, t, k + SIDE);
            else if (north) this.transfer(t, k, north, i);
          }
      }
      for (const t of this.active)
        for (let i = 0; i < CELLS; i++) {
          if (t.delta[i] > 0.0003 && t.water[i] < 0.0005) t.source[i] = flags.drainage;
          const nextWater = Math.max(0, t.water[i] + t.delta[i]);
          if (t.delta[i] !== 0 || t.siltFlux[i] !== 0)
            t.silt[i] =
              nextWater > 0.00001 ? clamp((t.silt[i] * t.water[i] + t.siltFlux[i]) / nextWater, 0, 1) : 0;
          t.water[i] = nextWater;
          if (nextWater > 0.000001) t.hydrated = true;
        }
    }
    return true;
  }
  /** RGBA = relief, contact wetness, free depth, silt. Optional second RGBA page carries
   * film coverage, pore saturation and square-root encoded free depth for fine shallow-water optics. */
  raster(x0: number, z0: number, n: number, output: Uint8Array, moisture?: Uint8Array) {
    for (let z = 0, k = 0; z < n; z++) {
      const gz = z0 + z,
        tz = Math.floor(gz / SIDE),
        row = (gz - tz * SIDE) * SIDE;
      for (let x = 0; x < n; ) {
        const gx = x0 + x,
          tx = Math.floor(gx / SIDE),
          ix = gx - tx * SIDE,
          span = Math.min(SIDE - ix, n - x);
        const t = this.tiles.get(keyOf(tx, tz));
        for (let j = 0, i = row + ix; j < span; j++, i++, k += 4) {
          output[k] = 128 + Math.round((t?.relief[i] ?? 0) * 1000);
          const pore = (t?.pore[i] ?? 0) / this.column.poreCapacityMm;
          const film = (t?.film[i] ?? 0) / this.column.filmCapacityMm;
          output[k + 1] = Math.round(Math.max(film, pore) * 255);
          if (moisture) {
            moisture[k] = Math.round(film * 255);
            moisture[k + 1] = Math.round(pore * 255);
            moisture[k + 2] = Math.min(255, Math.round(255 * Math.sqrt((t?.water[i] ?? 0) / 0.1275)));
          }
          output[k + 2] = Math.min(255, Math.round((t?.water[i] ?? 0) * 2000));
          output[k + 3] = Math.round((t?.silt[i] ?? 0) * 255);
        }
        x += span;
      }
    }
  }
  private waterRecipe() {
    const c = this.column;
    return [c.filmCapacityMm, c.poreCapacityMm, c.infiltrationMmS, c.evaporationMmS, c.drainageSeconds];
  }
  save(): SedimentSave {
    const tiles: SedimentSave['tiles'] = [];
    for (const t of this.tiles.values())
      if (t.edited || t.hydrated) {
        const bytes = new Uint8Array(CELLS * 6);
        const columns = t.hydrated ? new Uint8Array(CELLS * 16) : undefined;
        const view = columns && new DataView(columns.buffer);
        for (let i = 0; i < CELLS; i++) {
          const k = i * 6;
          if (view) {
            const offset = i * 16;
            view.setFloat32(offset, t.water[i], true);
            view.setFloat32(offset + 4, t.film[i], true);
            view.setFloat32(offset + 8, t.pore[i], true);
            view.setFloat32(offset + 12, t.relief[i], true);
          }
          bytes[k] = 128 + Math.round(t.relief[i] * 1000);
          bytes[k + 1] = Math.round(t.packing[i] * 255);
          bytes[k + 2] = Math.round((t.film[i] / this.column.filmCapacityMm) * 255);
          bytes[k + 3] = Math.min(255, Math.round(t.water[i] * 1000));
          bytes[k + 4] = Math.round(t.silt[i] * 255);
          bytes[k + 5] = t.source[i];
        }
        tiles.push({
          x: t.x,
          z: t.z,
          ...packCells(bytes),
          updated: t.updated,
          ...(t.edited ? {} : { edited: false }),
          ...(columns && { columns: packCells(columns, 16) }),
        });
      }
    return {
      version: 2,
      level: this.level,
      strength: this.strength,
      remainder: this.remainder,
      hydrology: this.waterRecipe(),
      seed: this.coast.seed,
      spacing: SEDIMENT_SPACING,
      time: this.time,
      tiles,
    };
  }
  restore(save: SedimentSave) {
    if (
      (save.version !== 1 && save.version !== 2) ||
      !Number.isFinite(save.remainder ?? 0) ||
      (save.remainder ?? 0) < 0 ||
      (save.remainder ?? 0) >= STEP ||
      !Number.isFinite(save.level ?? 0) ||
      !Number.isFinite(save.strength ?? 0) ||
      save.seed !== this.coast.seed ||
      save.spacing !== SEDIMENT_SPACING ||
      !Number.isFinite(save.time) ||
      save.time < 0 ||
      save.tiles.length > this.maxTiles
    )
      throw new RangeError('Incompatible sediment save');
    if (
      save.hydrology &&
      (save.hydrology.length !== 5 || this.waterRecipe().some((v, i) => v !== save.hydrology![i]))
    )
      throw new RangeError('Sand water recipe differs from save');
    const keys = new Set<string>();
    const records = save.tiles.map((item) => {
      const key = keyOf(item.x, item.z);
      if (keys.has(key)) throw new RangeError('Duplicate sediment tile');
      keys.add(key);
      const data = unpackCells(item);
      if (!Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.z) || data.length !== CELLS * 6)
        throw new RangeError('Invalid sediment tile');
      const updated = item.updated ?? save.time;
      if (!Number.isFinite(updated) || updated < 0 || updated > save.time)
        throw new RangeError('Invalid tile time');
      let columns: DataView | undefined;
      if (save.version === 2 && item.columns) {
        const decoded = unpackCells(item.columns, 16);
        columns = new DataView(Uint8Array.from(decoded, (c) => c.charCodeAt(0)).buffer);
        for (let k = 0; k < CELLS * 16; k += 16) {
          const w = columns.getFloat32(k, true),
            f = columns.getFloat32(k + 4, true),
            p = columns.getFloat32(k + 8, true),
            r = columns.getFloat32(k + 12, true);
          if (
            ![w, f, p, r].every(Number.isFinite) ||
            w < 0 ||
            f < 0 ||
            f > this.column.filmCapacityMm * 1.00001 ||
            p < 0 ||
            p > this.column.poreCapacityMm * 1.00001 ||
            r < -0.111 ||
            r > 0.056
          )
            throw new RangeError('Incompatible sand water column');
        }
      }
      return { x: item.x, z: item.z, data, updated, columns, edited: item.edited !== false };
    });
    this.tiles.clear();
    this.remainder = save.remainder ?? 0;
    this.time = save.time;
    this.level = save.level ?? this.level;
    this.strength = save.strength ?? this.strength;
    for (const { x, z, data, updated, columns, edited } of records) {
      const t = this.acquire(x, z);
      t.edited = edited;
      t.updated = updated;
      for (let i = 0; i < CELLS; i++) {
        const k = i * 6;
        t.relief[i] = (data.charCodeAt(k) - 128) / 1000;
        t.packing[i] = data.charCodeAt(k + 1) / 255;
        const legacy = data.charCodeAt(k + 2) / 255;
        t.pore[i] = legacy * this.column.poreCapacityMm;
        t.film[i] = Math.min(this.column.filmCapacityMm, data.charCodeAt(k + 3));
        t.water[i] = Math.max(0, data.charCodeAt(k + 3) - t.film[i]) / 1000;
        t.silt[i] = data.charCodeAt(k + 4) / 255;
        t.source[i] = data.charCodeAt(k + 5);
        if (columns) {
          const offset = i * 16;
          t.water[i] = columns.getFloat32(offset, true);
          t.film[i] = columns.getFloat32(offset + 4, true);
          t.pore[i] = columns.getFloat32(offset + 8, true);
          t.relief[i] = columns.getFloat32(offset + 12, true);
        }
        t.hydrated ||= t.water[i] + t.film[i] + t.pore[i] > 0;
      }
    }
  }
}
