export {
  SceneryRegistry,
  createTerrainMaterial,
  createRockMaterial,
  createMarineConcreteMaterial,
  createMarineTimberMaterial,
  createMarineMetalMaterial,
  createFoliageMaterial,
  createBeaconMaterial,
  type TerrainPalette,
  type AerialOptions,
  type TerrainMaterialOptions,
} from './materials';

export {
  noise2D,
  fbmCPU,
  ridgedCPU,
  createHeadlandGeometry,
  buildHeadlands,
  createRockVariants,
  buildRockClusters,
  type HeadlandSpec,
  type BuiltHeadlands,
  type RockPlacement,
} from './terrain';

export {
  buildPalmGrove,
  buildCoastalCanopy,
  scatterOnTerrain,
  type TreePlacement,
  type CanopyStyle,
  type ScatterOptions,
} from './vegetation';

export {
  dressPier,
  buildLighthouse,
  buildBuoy,
  buildDistantVessels,
  type PierEdge,
  type PierDressingOptions,
  type LighthouseOptions,
  type BuoySpec,
  type BuoyHandle,
  type VesselSpec,
} from './port';

export {
  buildHighwayEnvironment,
  type HighwayEnvironmentHandle,
} from './highway';
