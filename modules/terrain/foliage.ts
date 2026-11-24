import * as THREE from 'three/webgpu';
import type { WorldBus } from '../../engine/world-bus';
import { QUALITY_TIERS, type QualityPreset } from '../../engine/quality';
import { BotanicalGrove } from '../vegetation/grove';
import { GroundMeadow } from '../strands/meadow';
import { MeadowWind } from '../strands/meadow-wind';
import type { TerrainSurface } from './surface';

export class BiomeFoliage {
  readonly root = new THREE.Group();
  readonly grove: BotanicalGrove;
  readonly meadow: GroundMeadow;
  readonly wind: MeadowWind;
  private density = 0.66;
  private tier = 1;
  get grass() {
    return this.meadow.grass;
  }
  get reeds() {
    return this.meadow.reeds;
  }
  get crowns() {
    const batches = this.grove.batches;
    const tree =
      batches.get('cypress') ?? batches.get('willow') ?? batches.get('oak') ?? batches.values().next().value;
    return tree?.levels[0][1] ?? this.grass;
  }
  private readonly part = (x: number, y: number, z: number, radius: number, speed: number) =>
    this.wind.part(x, y, z, radius, speed);
  constructor(
    private readonly surface: TerrainSurface,
    world: WorldBus,
    seed: number,
    plantable?: (x: number, z: number) => boolean,
    private readonly camera?: THREE.Camera,
    gpu?: THREE.WebGPURenderer,
  ) {
    this.grove = new BotanicalGrove(surface, world, seed, plantable);
    this.wind = new MeadowWind(world, surface, gpu);
    this.meadow = new GroundMeadow(surface, this.wind, seed, plantable);
    this.root.add(this.grove.root, this.meadow.root);
    surface.partFoliage = this.part;
  }
  setStyle(tint: string, density: number) {
    this.grove.tint.value.set(tint);
    this.meadow.tint.value.set(tint);
    this.density = density;
    this.resize();
  }
  setQuality(p: QualityPreset) {
    this.tier = [0.25, 0.42, 0.67, 0.84, 1][QUALITY_TIERS.indexOf(p.tier)];
    this.resize();
  }
  private resize() {
    this.grove.setDensity(this.density, this.tier);
    this.meadow.setDensity(this.density, this.tier);
  }
  update(dt: number, time: number) {
    if (!this.camera) return;
    this.wind.update(dt, time, this.camera.position);
    this.meadow.updateView(this.camera);
    this.grove.updateView(this.camera);
  }
  dispose() {
    if (this.surface.partFoliage === this.part) this.surface.partFoliage = undefined;
    this.wind.dispose();
    this.meadow.dispose();
    this.grove.dispose();
    this.root.removeFromParent();
  }
}
