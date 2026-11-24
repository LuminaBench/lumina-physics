import { Camera, Color, Vector3, type DirectionalLight, type Scene, type WebGPURenderer } from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { WorldBus } from '../../engine/world-bus';
import { QUALITY_PRESETS, type QualityTier } from '../../engine/quality';
import { BiomeFoliage } from '../terrain/foliage';
import { AuthoredLandscape, type LandscapeProfile, type LandscapeRuntime } from './authored';
import type { TerrainHeightmap } from '../terrain/surface';

export interface LandscapeHost extends LandscapeRuntime {
  scene: Scene;
  camera: Camera;
  heightmap: TerrainHeightmap;
  fields?: WorldBus;
  sun?: DirectionalLight;
  gpu?: WebGPURenderer;
  tier?: QualityTier;
  seed?: number;
}
/** Adds only the vegetation group to an existing scene. The host retains its clock,
 * renderer, terrain mesh, lights, road surfaces and collision bodies. */
export function attachLandscape(profile: LandscapeProfile, host: LandscapeHost) {
  const lighting = host.lighting ?? {
    time: TSL.uniform(0),
    sunDirection: TSL.uniform(new Vector3(0.4, 0.6, 0.3).normalize()),
    sunColor: TSL.uniform(new Color('#fff2d7')),
    sunVisibility: TSL.uniform(1),
  };
  const sunTarget = new Vector3(),
    observer = new Camera();
  const land = new AuthoredLandscape(profile, host.seed ?? 7, { ...host, lighting });
  const fields = host.fields ?? new WorldBus();
  let foliage: BiomeFoliage;
  try {
    foliage = new BiomeFoliage(
      land.surface,
      fields,
      host.seed ?? 7,
      host.plantable,
      observer,
      host.gpu,
      undefined,
      land,
    );
  } catch (error) {
    land.dispose();
    if (!host.fields) fields.shelters.dispose();
    throw error;
  }
  foliage.setStyle(land.direction.foliage, land.meadowDensity, land.direction.bands);
  foliage.setQuality(QUALITY_PRESETS[host.tier ?? 'high']);
  host.scene.add(foliage.root);
  let disposed = false,
    time = 0;
  return {
    land,
    foliage,
    fields,
    update(dt: number) {
      if (disposed) return;
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Expected nonnegative seconds');
      host.camera.updateWorldMatrix(true, false);
      host.camera.matrixWorld.decompose(observer.position, observer.quaternion, observer.scale);
      observer.coordinateSystem = host.camera.coordinateSystem;
      observer.projectionMatrix.copy(host.camera.projectionMatrix);
      observer.updateMatrixWorld(true);
      land.focusX = observer.position.x;
      land.focusZ = observer.position.z;
      time += dt;
      if (!host.lighting) {
        lighting.time.value = time;
        if (host.sun) {
          host.sun.target.getWorldPosition(sunTarget);
          host.sun.getWorldPosition(lighting.sunDirection.value).sub(sunTarget).normalize();
          lighting.sunColor.value.copy(host.sun.color).multiplyScalar(host.sun.intensity);
          lighting.sunVisibility.value = Number(host.sun.visible);
        }
      }
      if (!host.fields) fields.update(dt);
      land.update(dt);
      foliage.update(dt, time);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      foliage.dispose();
      land.dispose();
      if (!host.fields) fields.shelters.dispose();
    },
  };
}
