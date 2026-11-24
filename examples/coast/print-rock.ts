import * as THREE from 'three/webgpu';
import type { Coastline } from '../../modules/coast/coastline';

/** A single game-owned rock. Geometry and the wetting barrier share an elliptical footprint. */
export function printRock(coast: Coastline, distance: number) {
  const along = coast.project(0, 0).along;
  const middle = coast.point(along, distance),
    site = coast.project(middle.x, middle.z);
  const nx = site.tangentZ,
    nz = -site.tangentX,
    tx = site.tangentX,
    tz = site.tangentZ;
  const x = middle.x - 0.19 * nx + 0.072 * tx,
    z = middle.z - 0.19 * nz + 0.072 * tz;
  const base = coast.height(x, z) + 0.025;
  const long = 0.119,
    width = 0.079,
    height = 0.15;
  return {
    detail: { x: middle.x, z: middle.z, size: 2.8, resolution: 81 },
    barrierAt(wx: number, wz: number) {
      const dx = wx - x,
        dz = wz - z;
      if (Math.abs(dx) > 0.15 || Math.abs(dz) > 0.15) return -Infinity;
      const a = (dx * nx + dz * nz) / long,
        b = (dx * tx + dz * tz) / width;
      const radius = 1 - a * a - b * b;
      return radius > 0 ? base + height * Math.sqrt(radius) : -Infinity;
    },
    mesh() {
      const geometry = new THREE.IcosahedronGeometry(1, 1);
      const material = new THREE.MeshStandardNodeMaterial({
        color: 0x595349,
        roughness: 0.68,
        flatShading: true,
      });
      const rock = new THREE.Mesh(geometry, material);
      rock.name = 'Sea-worn stone beside the middle footprint';
      rock.position.set(x, base, z);
      rock.rotation.y = Math.atan2(-nz, nx);
      rock.scale.set(long, height, width);
      rock.castShadow = rock.receiveShadow = true;
      return rock;
    },
  };
}
