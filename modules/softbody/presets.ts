/**
 * Ready-made inflatable soft-body builders: beach balls, air cushions, marine buoys, life rings.
 */
import * as THREE from 'three/webgpu';
import { boxTopology, buoyTopology, sphereTopology, topologyFromGeometry, torusTopology } from './mesh-gen';
import type { SoftBodySpec, SoftBodyTuning } from './types';

export type SoftBodyPattern = 'solid' | 'beachball' | 'stripes' | 'buoy' | 'lifeRing' | 'checker';

export interface SoftBodyLook {
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  /** Back-lit subsurface vinyl/rubber translucency (0..1). */
  translucency?: number;
}

export interface BuiltSoftBody {
  spec: SoftBodySpec;
  look: SoftBodyLook;
}

export interface BallOptions extends Partial<SoftBodyTuning> {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  radius?: number;
  detail?: number;
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  translucency?: number;
  rapierProxy?: boolean;
}

export function ballSpec(o: BallOptions = {}, cpuMode = false): BuiltSoftBody {
  const detail = o.detail ?? (cpuMode ? 1 : 2);
  return {
    spec: {
      topology: sphereTopology(o.radius ?? 0.65, detail),
      position: o.position,
      quaternion: o.quaternion,
      velocity: o.velocity,
      stiffness: o.stiffness ?? 0.88,
      strutWeight: o.strutWeight ?? 0.45,
      pressure: o.pressure ?? 2.0,
      inflation: o.inflation ?? 1.02,
      mass: o.mass ?? 4.5,
      gravity: o.gravity ?? 1,
      damping: o.damping ?? 0.4,
      airDrag: o.airDrag ?? 0.8,
      restitution: o.restitution ?? 0.58,
      friction: o.friction ?? 0.3,
      buoyancy: o.buoyancy ?? 1.2,
      waterDrag: o.waterDrag ?? 2.8,
      leakRate: o.leakRate ?? 0,
      rapierProxy: o.rapierProxy,
    },
    look: {
      pattern: o.pattern ?? 'beachball',
      colors: o.colors ?? [0xe63946, 0xf4f1de, 0x1d6fb8],
      roughness: o.roughness ?? 0.24,
      translucency: o.translucency ?? 0.35,
    },
  };
}

export interface CushionOptions extends Partial<SoftBodyTuning> {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  width?: number;
  height?: number;
  depth?: number;
  segments?: number;
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  translucency?: number;
  rapierProxy?: boolean;
}

export function cushionSpec(o: CushionOptions = {}, cpuMode = false): BuiltSoftBody {
  return {
    spec: {
      topology: boxTopology(o.width ?? 1.8, o.height ?? 0.55, o.depth ?? 1.2, o.segments ?? (cpuMode ? 2 : 3)),
      position: o.position,
      quaternion: o.quaternion,
      velocity: o.velocity,
      stiffness: o.stiffness ?? 0.86,
      strutWeight: o.strutWeight ?? 0.52,
      pressure: o.pressure ?? 1.6,
      inflation: o.inflation ?? 1.0,
      mass: o.mass ?? 12,
      gravity: o.gravity ?? 1,
      damping: o.damping ?? 0.55,
      airDrag: o.airDrag ?? 0.45,
      restitution: o.restitution ?? 0.35,
      friction: o.friction ?? 0.5,
      buoyancy: o.buoyancy ?? 1.1,
      waterDrag: o.waterDrag ?? 3.6,
      leakRate: o.leakRate ?? 0,
      rapierProxy: o.rapierProxy,
    },
    look: {
      pattern: o.pattern ?? 'stripes',
      colors: o.colors ?? [0xf4a261, 0x264653],
      roughness: o.roughness ?? 0.42,
      translucency: o.translucency ?? 0.2,
    },
  };
}

export interface BuoyOptions extends Partial<SoftBodyTuning> {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  radius?: number;
  length?: number;
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  translucency?: number;
  rapierProxy?: boolean;
}

export function buoySpec(o: BuoyOptions = {}, cpuMode = false): BuiltSoftBody {
  return {
    spec: {
      topology: buoyTopology(o.radius ?? 0.42, o.length ?? 0.9, cpuMode ? 8 : 12, cpuMode ? 2 : 3),
      position: o.position,
      quaternion: o.quaternion,
      velocity: o.velocity,
      stiffness: o.stiffness ?? 0.9,
      strutWeight: o.strutWeight ?? 0.5,
      pressure: o.pressure ?? 2.2,
      inflation: o.inflation ?? 1.03,
      mass: o.mass ?? 14,
      gravity: o.gravity ?? 1,
      damping: o.damping ?? 0.5,
      airDrag: o.airDrag ?? 0.4,
      restitution: o.restitution ?? 0.45,
      friction: o.friction ?? 0.45,
      buoyancy: o.buoyancy ?? 1.35,
      waterDrag: o.waterDrag ?? 3.5,
      leakRate: o.leakRate ?? 0,
      rapierProxy: o.rapierProxy,
    },
    look: {
      pattern: o.pattern ?? 'buoy',
      colors: o.colors ?? [0xf26419, 0xf6f7eb],
      roughness: o.roughness ?? 0.32,
      translucency: o.translucency ?? 0.25,
    },
  };
}

export interface TorusOptions extends Partial<SoftBodyTuning> {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  majorRadius?: number;
  tubeRadius?: number;
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  translucency?: number;
  rapierProxy?: boolean;
}

export function torusSpec(o: TorusOptions = {}, cpuMode = false): BuiltSoftBody {
  return {
    spec: {
      topology: torusTopology(o.majorRadius ?? 0.72, o.tubeRadius ?? 0.26, cpuMode ? 6 : 8, cpuMode ? 12 : 16),
      position: o.position,
      quaternion: o.quaternion,
      velocity: o.velocity,
      stiffness: o.stiffness ?? 0.88,
      strutWeight: o.strutWeight ?? 0.48,
      pressure: o.pressure ?? 1.9,
      inflation: o.inflation ?? 1.02,
      mass: o.mass ?? 6.5,
      gravity: o.gravity ?? 1,
      damping: o.damping ?? 0.45,
      airDrag: o.airDrag ?? 0.65,
      restitution: o.restitution ?? 0.52,
      friction: o.friction ?? 0.35,
      buoyancy: o.buoyancy ?? 1.4,
      waterDrag: o.waterDrag ?? 3.4,
      leakRate: o.leakRate ?? 0,
      rapierProxy: o.rapierProxy,
    },
    look: {
      pattern: o.pattern ?? 'buoy',
      colors: o.colors ?? [0xe74c3c, 0xf8f9fa],
      roughness: o.roughness ?? 0.28,
      translucency: o.translucency ?? 0.3,
    },
  };
}

export interface CustomSoftBodyOptions extends Partial<SoftBodyTuning> {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  velocity?: THREE.Vector3;
  pattern?: SoftBodyPattern;
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  translucency?: number;
  pinned?: (vertexIndex: number, localPos: THREE.Vector3) => boolean;
  rapierProxy?: boolean;
}

export function customSoftBodySpec(geometry: THREE.BufferGeometry, o: CustomSoftBodyOptions = {}): BuiltSoftBody {
  return {
    spec: {
      topology: topologyFromGeometry(geometry, { internalStruts: true, bendSprings: true, pinned: o.pinned }),
      position: o.position,
      quaternion: o.quaternion,
      velocity: o.velocity,
      stiffness: o.stiffness,
      strutWeight: o.strutWeight,
      pressure: o.pressure,
      inflation: o.inflation,
      mass: o.mass,
      gravity: o.gravity,
      damping: o.damping,
      airDrag: o.airDrag,
      restitution: o.restitution,
      friction: o.friction,
      buoyancy: o.buoyancy,
      waterDrag: o.waterDrag,
      leakRate: o.leakRate,
      rapierProxy: o.rapierProxy,
    },
    look: {
      pattern: o.pattern ?? 'solid',
      colors: o.colors ?? [0x3a86ff],
      roughness: o.roughness ?? 0.35,
      translucency: o.translucency ?? 0.25,
    },
  };
}
