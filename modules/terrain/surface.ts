import * as THREE from 'three/webgpu';
import { FocusedGrid, type GridFocus } from '../../engine/focused-grid';
import type { Biome } from './biomes';
import { landscape } from './landscape';

export type SurfaceId = 'bed' | 'sand' | 'reeds' | 'grass' | 'rock' | 'scrub';
export interface TerrainReading {
  height: number;
  normal: THREE.Vector3;
  /** Rise/run, independent of grid resolution. */
  slope: number;
  moisture: number;
  surfaceId: SurfaceId;
}
export const terrainReading = (): TerrainReading => ({
  height: 0,
  normal: new THREE.Vector3(),
  slope: 0,
  moisture: 0,
  surfaceId: 'grass',
});
export interface TerrainSurfaceQuery {
  sample(x: number, z: number, out: TerrainReading): TerrainReading;
}
export interface TerrainHeightmap {
  size: number;
  segments: number;
  heights: ArrayLike<number>;
  focus?: GridFocus;
}

/** Centered regular grid. Row zero is -Z. All users share the rendered triangle diagonal. */
export class TerrainSurface implements TerrainSurfaceQuery {
  readonly size: number;
  readonly segments: number;
  readonly heights: Float32Array;
  readonly grid?: FocusedGrid;
  partFoliage?: (x: number, y: number, z: number, radius: number, speed: number) => void;
  contactLayer?: {
    waterAt(x: number, z: number): number;
    gripAt(x: number, z: number): number;
    wetnessAt(x: number, z: number): number;
  };
  waterLevel = 0;
  private readonly contact = terrainReading();
  get wetness(): number {
    return this.biome === 'dry-highlands' ? 0.08 : 0.25;
  }
  wetnessAt(x: number, z: number): number {
    return this.contactLayer?.wetnessAt(x, z) ?? this.sample(x, z, this.contact).moisture;
  }
  puddleDepth(x: number, z: number): number {
    if (this.contactLayer) return this.contactLayer.waterAt(x, z);
    return this.biome === 'dry-highlands'
      ? 0
      : Math.max(0, this.waterLevel - this.sample(x, z, this.contact).height);
  }
  grip(x: number, z: number): number {
    if (this.contactLayer) return this.contactLayer.gripAt(x, z);
    const kind = this.sample(x, z, this.contact).surfaceId;
    return kind === 'rock' ? 0.92 : kind === 'sand' || kind === 'bed' ? 0.64 : 0.78;
  }
  constructor(
    readonly biome: Biome,
    seed: number,
    map?: TerrainHeightmap,
  ) {
    this.size = map?.size ?? 540;
    const n = (this.segments = map?.segments ?? (biome === 'coastal-cliffs' ? 320 : 224));
    if (!Number.isFinite(this.size) || this.size <= 0 || !Number.isInteger(n) || n < 1 || n > 2048)
      throw new RangeError('Heightmaps require positive metres and 1–2048 grid segments');
    this.grid = map?.focus ? new FocusedGrid(this.size,n,map.focus) : undefined;
    const count = (n + 1) ** 2;
    if (map && map.heights.length !== count) throw new RangeError('Expected (segments + 1)² heights');
    this.heights = new Float32Array(count);
    const generate = landscape(biome, seed),
      spacing = this.size / n;
    for (let j = 0, i = 0; j <= n; j++)
      for (let k = 0; k <= n; k++, i++) {
        const h = map ? map.heights[i] : generate(k * spacing - this.size / 2, j * spacing - this.size / 2);
        if (!Number.isFinite(h)) throw new RangeError('Expected finite height at sample ' + i);
        this.heights[i] = h;
      }
  }

  sample(x: number, z: number, out: TerrainReading): TerrainReading {
    const n = this.segments,
      stride = n + 1,
      scale = n / this.size;
    const gx = THREE.MathUtils.clamp(this.grid ? this.grid.index(x) : x * scale + n / 2, 0, n),
      gz = THREE.MathUtils.clamp(this.grid ? this.grid.index(z) : z * scale + n / 2, 0, n);
    const col = Math.min(n - 1, Math.floor(gx)),
      row = Math.min(n - 1, Math.floor(gz));
    const u = gx - col,
      v = gz - row,
      i = col + stride * row,
      h = this.heights;
    const a = h[i],
      b = h[i + 1],
      c = h[i + stride],
      d = h[i + stride + 1];
    let dx: number, dz: number;
    if (u + v <= 1) {
      dx = b - a;
      dz = c - a;
      out.height = a + dx * u + dz * v;
    } else {
      dx = d - c;
      dz = d - b;
      out.height = d + dx * (u - 1) + dz * (v - 1);
    }
    dx *= this.grid ? 1/this.grid.spacingAt(col) : scale;
    dz *= this.grid ? 1/this.grid.spacingAt(row) : scale;
    out.normal.set(-dx, 1, -dz).normalize();
    out.slope = Math.hypot(dx, dz);
    if (this.biome === 'dry-highlands') {
      out.moisture = 0.08;
      out.surfaceId = out.slope > 0.65 ? 'rock' : 'scrub';
      return out;
    }
    const shore = out.height - this.waterLevel;
    const damp = 1 - THREE.MathUtils.smoothstep(shore, 0.2, 5.5);
    out.moisture = Math.max(0.25, damp);
    if (shore < -0.28) out.surfaceId = 'bed';
    else if (out.slope > 0.65) out.surfaceId = 'rock';
    else if (this.biome === 'temperate-river-valley' && shore < 1.25) out.surfaceId = 'reeds';
    else if (shore < 1.4) out.surfaceId = 'sand';
    else out.surfaceId = 'grass';
    return out;
  }

  geometry(): THREE.BufferGeometry {
    const n = this.segments,
      stride = n + 1,
      positions: number[] = [],
      colors: number[] = [],
      indices: number[] = [];
    const palette = {
      bed: 0x505341,
      sand: 0xc2ad87,
      reeds: 0x667346,
      grass: 0x667644,
      rock: 0x77736e,
      scrub: 0x99865e,
    };
    const reading = terrainReading(),
      tint = new THREE.Color();
    for (let j = 0; j <= n; j++)
      for (let k = 0; k <= n; k++) {
        const x = this.grid ? this.grid.at(k) : (k / n - 0.5) * this.size,
          z = this.grid ? this.grid.at(j) : (j / n - 0.5) * this.size,
          i = j * stride + k;
        this.sample(x, z, reading);
        positions.push(x, this.heights[i], z);
        tint.set(palette[reading.surfaceId]).multiplyScalar(1 - reading.moisture * 0.16);
        colors.push(tint.r, tint.g, tint.b);
        if (j < n && k < n) indices.push(i, i + stride, i + 1, i + 1, i + stride, i + stride + 1);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('terrainColor', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}
