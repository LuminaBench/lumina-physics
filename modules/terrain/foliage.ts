import * as THREE from 'three/webgpu';
import type { WorldBus } from '../../engine/world-bus';
import { QUALITY_TIERS, type QualityPreset } from '../../engine/quality';
import type { AuthoredLandscape } from '../landscape/authored';
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
    private camera?: THREE.Camera,
    gpu?: THREE.WebGPURenderer,
    private readonly shade?: THREE.DataTexture,
    private readonly art?: AuthoredLandscape,
  ) {
    this.grove = new BotanicalGrove(surface, world, art?.seeds.trees ?? seed, plantable, art);

    this.wind = new MeadowWind(
      world,
      surface,
      gpu,
      !!art && (surface.biome === 'temperate-river-valley' || art.region.form === 'mountain'),
    );
    this.meadow = new GroundMeadow(surface, this.wind, art?.seeds.meadow ?? seed, plantable, shade, art);
    this.root.add(this.grove.root, this.meadow.root);
    surface.partFoliage = this.part;
    if (!this.camera) {
      // Older callers only add root to their scene. Learn the host camera on its first draw.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      geometry.setDrawRange(0, 0);
      const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      const observer = new THREE.Mesh(geometry, material);
      observer.frustumCulled = false;
      observer.renderOrder = -1e6;
      observer.name = 'Foliage camera binding';
      this.root.add(observer);
      observer.onBeforeRender = (_renderer, _scene, camera) => {
        this.camera = camera;
        this.update(1 / 60, 0);
        observer.visible = false;
      };
      this.releaseObserver = () => {
        observer.removeFromParent();
        geometry.dispose();
        material.dispose();
      };
    }
    this.resize();
  }
  setStyle(tint: string, density: number, bands = 0) {
    this.grove.bands.value = this.meadow.bands.value = bands;
    this.grove.tint.value.set(tint);
    this.meadow.tint.value.set(tint);
    this.density = density;
    this.resize();
  }
  setQuality(p: QualityPreset) {
    this.tier = [0.25, 0.42, 0.67, 0.84, 1][QUALITY_TIERS.indexOf(p.tier)];
    this.resize();
  }
  private releaseObserver?: () => void;
  private previousShade = -1;
  private resize() {
    this.grove.setDensity(this.art ? 1 : this.density, this.tier);
    this.meadow.setDensity(this.density, this.tier);
    const weight = this.density * (0.75 + 0.25 * this.tier);
    if (this.shade && this.previousShade !== weight) {
      this.grove.bakeShade(this.shade, this.surface.size);
      this.previousShade = weight;
    }
  }
  update(dt: number, time: number) {
    if (!this.camera || !this.root.visible) return;
    this.wind.update(dt, time, this.camera.position);
    this.meadow.updateView(this.camera);
    this.grove.updateView(this.camera);
  }
  dispose() {
    this.releaseObserver?.();
    if (this.surface.partFoliage === this.part) this.surface.partFoliage = undefined;
    this.wind.dispose();
    this.meadow.dispose();
    this.grove.dispose();
    this.root.removeFromParent();
  }
}
