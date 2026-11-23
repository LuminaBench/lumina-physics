/**
 * Closed manifold soft-body mesh & spring-graph generators.
 *
 * Converts standard Three.js geometries (icospheres, rounded boxes, capsules, tori, or
 * arbitrary closed BufferGeometries) into welded manifold topologies with:
 *   - guaranteed outward CCW triangle winding and exact signed rest volume V₀,
 *   - structural surface springs along every triangle edge,
 *   - internal cross-bracing struts (diametric / opposite-face / bend springs) so
 *     inflatables keep their shape under violent impacts and never invert inside-out.
 */
import * as THREE from 'three/webgpu';
import { MAX_VALENCE, type SoftBodyTopology } from './types';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _cross = new THREE.Vector3();

/** Build a welded closed manifold SoftBodyTopology from any closed BufferGeometry. */
export function topologyFromGeometry(geometry: THREE.BufferGeometry, options: {
  weldTolerance?: number;
  internalStruts?: boolean;
  bendSprings?: boolean;
  pinned?: (vertexIndex: number, localPos: THREE.Vector3) => boolean;
} = {}): SoftBodyTopology {
  const tol = options.weldTolerance ?? 1e-4;
  const invTol = 1 / tol;
  const posAttr = geometry.getAttribute('position');
  const uvAttr = geometry.getAttribute('uv');
  const index = geometry.getIndex();

  const weldedPos: number[] = [];
  const weldedUv: number[] = [];
  const keyToIdx = new Map<string, number>();
  const remap = new Uint32Array(posAttr.count);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const key = `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}`;
    let idx = keyToIdx.get(key);
    if (idx === undefined) {
      idx = weldedPos.length / 3;
      keyToIdx.set(key, idx);
      weldedPos.push(x, y, z);
      if (uvAttr) weldedUv.push(uvAttr.getX(i), uvAttr.getY(i));
      else weldedUv.push(Math.atan2(z, x) / (Math.PI * 2) + 0.5, y * 0.5 + 0.5);
    }
    remap[i] = idx;
  }

  const vCount = weldedPos.length / 3;
  // Center topology around origin so local rest positions are centered.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < vCount; i++) { cx += weldedPos[i * 3]; cy += weldedPos[i * 3 + 1]; cz += weldedPos[i * 3 + 2]; }
  cx /= vCount; cy /= vCount; cz /= vCount;
  let maxR = 0;
  for (let i = 0; i < vCount; i++) {
    weldedPos[i * 3] -= cx; weldedPos[i * 3 + 1] -= cy; weldedPos[i * 3 + 2] -= cz;
    const r = Math.hypot(weldedPos[i * 3], weldedPos[i * 3 + 1], weldedPos[i * 3 + 2]);
    if (r > maxR) maxR = r;
  }

  const triList: number[] = [];
  const srcCount = index ? index.count : posAttr.count;
  for (let i = 0; i < srcCount; i += 3) {
    const ia = remap[index ? index.getX(i) : i];
    const ib = remap[index ? index.getX(i + 1) : i + 1];
    const ic = remap[index ? index.getX(i + 2) : i + 2];
    if (ia === ib || ib === ic || ic === ia) continue;
    triList.push(ia, ib, ic);
  }

  // Compute signed volume and total surface area; flip winding if inverted.
  let signedVol = 0;
  let area = 0;
  for (let t = 0; t < triList.length; t += 3) {
    const ia = triList[t] * 3, ib = triList[t + 1] * 3, ic = triList[t + 2] * 3;
    _a.set(weldedPos[ia], weldedPos[ia + 1], weldedPos[ia + 2]);
    _b.set(weldedPos[ib], weldedPos[ib + 1], weldedPos[ib + 2]);
    _c.set(weldedPos[ic], weldedPos[ic + 1], weldedPos[ic + 2]);
    _cross.crossVectors(_b, _c);
    signedVol += _a.dot(_cross) / 6;
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    area += _cross.crossVectors(_ab, _ac).length() * 0.5;
  }
  if (signedVol < 0) {
    signedVol = -signedVol;
    for (let t = 0; t < triList.length; t += 3) {
      const tmp = triList[t + 1];
      triList[t + 1] = triList[t + 2];
      triList[t + 2] = tmp;
    }
  }

  const positions = new Float32Array(weldedPos);
  const uvs = new Float32Array(weldedUv);
  const triangles = new Uint32Array(triList);

  // Extract unique structural edges and opposite-triangle bending pairs.
  const springs: SoftBodyTopology['springs'] = [];
  const edgeSet = new Set<number>();
  const edgeOpposite = new Map<number, number>();
  const valence = new Uint8Array(vCount);

  const pairKey = (u: number, v: number) => (u < v ? u * vCount + v : v * vCount + u);
  const addSpring = (u: number, v: number, kind: 0 | 1): boolean => {
    if (u === v) return false;
    if (valence[u] >= MAX_VALENCE || valence[v] >= MAX_VALENCE) return false;
    const key = pairKey(u, v);
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    valence[u]++; valence[v]++;
    const dx = positions[v * 3] - positions[u * 3];
    const dy = positions[v * 3 + 1] - positions[u * 3 + 1];
    const dz = positions[v * 3 + 2] - positions[u * 3 + 2];
    const rest = Math.hypot(dx, dy, dz);
    if (rest < 1e-5) return false;
    springs.push({ a: Math.min(u, v), b: Math.max(u, v), rest, kind });
    return true;
  };

  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    const edges: Array<[number, number, number]> = [[a, b, c], [b, c, a], [c, a, b]];
    for (const [u, v, opp] of edges) {
      addSpring(u, v, 0);
      if (options.bendSprings !== false) {
        const key = pairKey(u, v);
        const prevOpp = edgeOpposite.get(key);
        if (prevOpp === undefined) edgeOpposite.set(key, opp);
        else addSpring(prevOpp, opp, 1);
      }
    }
  }

  // Add internal cross-bracing struts linking vertices to their approximate antipodal vertex.
  if (options.internalStruts !== false && vCount >= 8) {
    for (let i = 0; i < vCount; i++) {
      if (valence[i] >= MAX_VALENCE - 1) continue;
      const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      let best = -1, bestDistSq = -1;
      for (let j = i + 1; j < vCount; j++) {
        if (valence[j] >= MAX_VALENCE) continue;
        // Prefer vertices on the opposite side of the centroid.
        const dotOpp = px * positions[j * 3] + py * positions[j * 3 + 1] + pz * positions[j * 3 + 2];
        if (dotOpp >= 0) continue;
        const dx = positions[j * 3] - px, dy = positions[j * 3 + 1] - py, dz = positions[j * 3 + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > bestDistSq) { bestDistSq = d2; best = j; }
      }
      if (best >= 0) addSpring(i, best, 1);
    }
  }

  return {
    positions,
    uvs,
    triangles,
    pinned: options.pinned,
    restVolume: Math.max(signedVol, 1e-4),
    restRadius: Math.max(maxR, 0.05),
    restArea: Math.max(area, 1e-3),
    springs,
  };
}

/** Inflatable sphere (geodesic icosphere: uniform edge lengths and smooth pressure response). */
export function sphereTopology(radius = 0.75, detail = 2): SoftBodyTopology {
  const geo = new THREE.IcosahedronGeometry(radius, Math.max(1, Math.min(3, Math.round(detail))));
  const topo = topologyFromGeometry(geo, { internalStruts: true, bendSprings: true });
  geo.dispose();
  return topo;
}

/** Inflatable subdivided box / cushion / air mattress. */
export function boxTopology(width = 1.4, height = 0.8, depth = 1.4, segments = 3): SoftBodyTopology {
  const seg = Math.max(2, Math.min(6, Math.round(segments)));
  const geo = new THREE.BoxGeometry(width, height, depth, seg, Math.max(2, Math.round(seg * (height / Math.max(width, depth)))), seg);
  // Slightly puff corners outward so box inflatables look pillowy and resist corner folding.
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  const hx = width * 0.5, hy = height * 0.5, hz = depth * 0.5;
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i) / hx, pos.getY(i) / hy, pos.getZ(i) / hz);
    const len = v.length();
    if (len > 1) {
      const puff = 1 + (1 / len - 1) * 0.22;
      pos.setXYZ(i, pos.getX(i) * puff, pos.getY(i) * puff, pos.getZ(i) * puff);
    }
  }
  const topo = topologyFromGeometry(geo, { internalStruts: true, bendSprings: true });
  geo.dispose();
  return topo;
}

/** Marine inflatable buoy / dock fender (capsule topology). */
export function buoyTopology(radius = 0.45, length = 1.1, radialSegments = 12, capSegments = 3): SoftBodyTopology {
  const geo = new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments);
  const topo = topologyFromGeometry(geo, { internalStruts: true, bendSprings: true });
  geo.dispose();
  return topo;
}

/** Inflatable life ring / inner tube (torus topology). */
export function torusTopology(majorRadius = 0.75, tubeRadius = 0.28, radialSegments = 8, tubularSegments = 16): SoftBodyTopology {
  const geo = new THREE.TorusGeometry(majorRadius, tubeRadius, radialSegments, tubularSegments);
  geo.rotateX(Math.PI * 0.5);
  const topo = topologyFromGeometry(geo, { internalStruts: true, bendSprings: true });
  geo.dispose();
  return topo;
}
