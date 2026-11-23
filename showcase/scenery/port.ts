/**
 * Seaside port & maritime architecture:
 *   - Realistic pier dressing: coping curbs, pile caps, longitudinal stringer girders,
 *     tidal-fouled pilings with diagonal cross-bracing, timber/rubber marine fenders,
 *     cast-iron mooring bollards, galvanized safety railings, harbor light stanchions & davit.
 *   - Coastal lighthouses, floating mooring/channel buoys and distant maritime silhouettes.
 *
 * Static assemblies are batched with `mergeStaticMeshes` so an entire dressed harbor pier
 * adds only ~6–10 draw calls.
 */
import * as THREE from 'three/webgpu';
import { mergeStaticMeshes } from '../../engine/batching';
import { OceanHeightBatch, type Ocean } from '../../modules/water/ocean';
import type { Weather } from '../../modules/weather/weather';
import {
  createBeaconMaterial,
  createMarineConcreteMaterial,
  createMarineMetalMaterial,
  createMarineTimberMaterial,
  type SceneryRegistry,
} from './materials';

export type PierEdge = 'north' | 'south' | 'east' | 'west';

export interface PierDressingOptions {
  /** Center X, Z of the rectangular pier deck. */
  centerX: number;
  centerZ: number;
  /** Width along X and length along Z (m). */
  width: number;
  length: number;
  /** Elevation of top of deck (m above mean sea level). */
  deckY: number;
  /** Slab thickness (m). */
  slabThickness: number;
  /** Build full under-deck pilings + cross-bracing (true for open-water piers; false for caisson quays). */
  openPilings?: boolean;
  /** Spacing between piling/fender bays (m). */
  baySpacing?: number;
  /** Which edges receive fenders & bollards (default all 4; exclude landward shore edge). */
  waterEdges?: PierEdge[];
  /** Optional explicit railing spans in world coords (keeps foreground/working zones clear!). */
  railings?: Array<{ x0: number; z0: number; x1: number; z1: number }>;
  /** Optional world positions to skip bollards (e.g. near flagpoles or props). */
  bollardExclusions?: Array<{ x: number; z: number; radius: number }>;
  /** Add explicit extra bollards (e.g. mooring line tie-off). */
  extraBollards?: Array<{ x: number; z: number }>;
  /** Optional harbor lamp stanchion positions (x, z, facingYaw). */
  lampPosts?: Array<{ x: number; z: number; yaw?: number }>;
  /** Optional compact port davit crane silhouette at (x, z, yaw). */
  davit?: { x: number; z: number; yaw: number };
  /** Add an orange life-ring station at (x, z, yaw). */
  lifeRings?: Array<{ x: number; z: number; yaw: number }>;
}

/**
 * Dress a rectangular concrete pier slab with realistic marine engineering details.
 * Never adds physics colliders or blocks the main top working deck.
 */
export function dressPier(
  reg: SceneryRegistry,
  weather: Weather,
  opt: PierDressingOptions,
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'pier-dressing';

  const concrete = createMarineConcreteMaterial(reg, weather);
  const timber = createMarineTimberMaterial(reg, weather, { weathered: true });
  const iron = createMarineMetalMaterial(reg, { name: 'cast-iron', color: 0x262a2e, roughness: 0.52, metalness: 0.78 });
  const galvSteel = createMarineMetalMaterial(reg, { name: 'galv-steel', color: 0x7a838a, roughness: 0.44, metalness: 0.82 });
  const rubber = createMarineMetalMaterial(reg, { name: 'marine-rubber', color: 0x17181a, roughness: 0.86, metalness: 0.05 });
  const safetyOrange = createMarineMetalMaterial(reg, { name: 'safety-orange', color: 0xd9481f, roughness: 0.55, metalness: 0.08 });
  const hazardYellow = createMarineMetalMaterial(reg, { name: 'hazard-yellow', color: 0xd8a21e, roughness: 0.62, metalness: 0.12 });
  const lampGlow = createBeaconMaterial(reg, [28, 19, 8.5], 'pier-lamp-glow');

  const halfW = opt.width / 2;
  const halfL = opt.length / 2;
  const minX = opt.centerX - halfW, maxX = opt.centerX + halfW;
  const minZ = opt.centerZ - halfL, maxZ = opt.centerZ + halfL;
  const deckY = opt.deckY;
  const underY = deckY - opt.slabThickness;
  const bay = opt.baySpacing ?? 7.0;
  const edges = new Set<PierEdge>(opt.waterEdges ?? ['north', 'south', 'east', 'west']);

  const addBox = (
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    mat: THREE.Material,
    cast = true,
    rotY = 0,
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rotY !== 0) m.rotation.y = rotY;
    m.castShadow = cast;
    m.receiveShadow = true;
    root.add(m);
  };

  // ---- 1. Perimeter concrete coping curb + fascia lip + timber waler rub-rail -------------
  const curbH = 0.14, curbW = 0.28;
  const fasciaH = opt.slabThickness + 0.22;
  if (edges.has('west')) {
    addBox(curbW, curbH, opt.length, minX + curbW / 2, deckY + curbH / 2, opt.centerZ, concrete);
    addBox(0.16, fasciaH, opt.length + 0.16, minX - 0.05, deckY - fasciaH / 2 + 0.04, opt.centerZ, concrete, false);
    addBox(0.16, 0.22, opt.length - 0.4, minX - 0.16, deckY - 0.32, opt.centerZ, timber, false);
  }
  if (edges.has('east')) {
    addBox(curbW, curbH, opt.length, maxX - curbW / 2, deckY + curbH / 2, opt.centerZ, concrete);
    addBox(0.16, fasciaH, opt.length + 0.16, maxX + 0.05, deckY - fasciaH / 2 + 0.04, opt.centerZ, concrete, false);
    addBox(0.16, 0.22, opt.length - 0.4, maxX + 0.16, deckY - 0.32, opt.centerZ, timber, false);
  }
  if (edges.has('north')) {
    addBox(opt.width, curbH, curbW, opt.centerX, deckY + curbH / 2, minZ + curbW / 2, concrete);
    addBox(opt.width + 0.16, fasciaH, 0.16, opt.centerX, deckY - fasciaH / 2 + 0.04, minZ - 0.05, concrete, false);
    addBox(opt.width - 0.4, 0.22, 0.16, opt.centerX, deckY - 0.32, minZ - 0.16, timber, false);
  }
  if (edges.has('south')) {
    addBox(opt.width, curbH, curbW, opt.centerX, deckY + curbH / 2, maxZ - curbW / 2, concrete);
    addBox(opt.width + 0.16, fasciaH, 0.16, opt.centerX, deckY - fasciaH / 2 + 0.04, maxZ + 0.05, concrete, false);
    addBox(opt.width - 0.4, 0.22, 0.16, opt.centerX, deckY - 0.32, maxZ + 0.16, timber, false);
  }

  // ---- 2. Under-deck structural pile caps, stringers, pilings & diagonal cross-bracing ----
  if (opt.openPilings) {
    // Longitudinal concrete stringer girders underneath deck edges.
    for (const side of [-1, 1]) {
      addBox(0.7, 0.65, opt.length - 1.0, opt.centerX + side * (halfW - 1.3), underY - 0.32, opt.centerZ, concrete, true);
    }
    const zCount = Math.max(2, Math.floor((opt.length - 4) / bay) + 1);
    const startZ = maxZ - 3.0;
    const stepZ = (opt.length - 6.0) / (zCount - 1);

    for (let i = 0; i < zCount; i++) {
      const bz = startZ - i * stepZ;
      // Transverse concrete pile cap beam spanning width.
      addBox(opt.width - 0.6, 0.58, 0.72, opt.centerX, underY - 0.30, bz, concrete, true);
      // Heavy tidal-collared pilings (left, center-ish if wide, right).
      const xs = opt.width > 12 ? [opt.centerX - (halfW - 1.3), opt.centerX, opt.centerX + (halfW - 1.3)] : [opt.centerX - (halfW - 1.3), opt.centerX + (halfW - 1.3)];
      for (const px of xs) {
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.54, 1.15, 10), timber);
        collar.position.set(px, 0.05, bz);
        collar.receiveShadow = true;
        root.add(collar);
        // Center piling shaft (outer ones may already exist in playground.ts, inner adds structural weight).
        if (Math.abs(px - opt.centerX) < 0.1) {
          const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 8.5, 10), concrete);
          shaft.position.set(px, underY - 4.25, bz);
          shaft.castShadow = true;
          root.add(shaft);
        }
      }
      // Diagonal timber cross-bracing between outer & center pilings above waterline.
      if (i > 0 && i < zCount - 1) {
        const span = halfW - 1.3;
        const dy = underY - 0.4;
        const braceLen = Math.hypot(span, dy);
        const angle = Math.atan2(dy, span);
        for (const side of [-1, 1]) {
          const brace = new THREE.Mesh(new THREE.BoxGeometry(braceLen, 0.18, 0.16), timber);
          brace.position.set(opt.centerX + side * (span * 0.5), dy * 0.5 + 0.1, bz);
          brace.rotation.z = side * (angle - 0.05);
          brace.castShadow = true;
          root.add(brace);
        }
      }
    }
  } else {
    // Reinforced concrete caisson quay wall bays + recessed pilaster ribs around the perimeter.
    const addPilasters = (alongX: boolean, fixedCoord: number, span: number, centerCoord: number) => {
      const count = Math.max(3, Math.floor(span / bay));
      for (let i = 0; i <= count; i++) {
        const t = -0.46 + (i / count) * 0.92;
        const c = centerCoord + t * span;
        if (alongX) addBox(0.65, opt.slabThickness + 1.4, 0.34, c, deckY - (opt.slabThickness + 1.4) / 2 - 0.06, fixedCoord, concrete, false);
        else addBox(0.34, opt.slabThickness + 1.4, 0.65, fixedCoord, deckY - (opt.slabThickness + 1.4) / 2 - 0.06, c, concrete, false);
      }
    };
    if (edges.has('south')) addPilasters(true, maxZ + 0.12, opt.width, opt.centerX);
    if (edges.has('north')) addPilasters(true, minZ - 0.12, opt.width, opt.centerX);
    if (edges.has('west')) addPilasters(false, minX - 0.12, opt.length, opt.centerZ);
    if (edges.has('east')) addPilasters(false, maxX + 0.12, opt.length, opt.centerZ);
  }

  // ---- 3. Marine timber rub-piles & heavy rubber dock fenders -----------------------------
  const addFender = (x: number, z: number, rotY: number) => {
    const g = new THREE.Group();
    g.position.set(x, deckY - 0.45, z);
    g.rotation.y = rotY;
    // Vertical creosote timber fender pile
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.35, 0.24), timber);
    post.position.set(0, -0.35, 0.18);
    post.castShadow = true;
    g.add(post);
    // Steel mounting straps
    for (const sy of [0.22, -0.45]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.09, 0.28), iron);
      strap.position.set(0, sy, 0.12);
      g.add(strap);
    }
    // Black rubber cylindrical marine bumper on outer face
    const bumper = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.35, 10), rubber);
    bumper.position.set(0, -0.15, 0.34);
    bumper.castShadow = true;
    g.add(bumper);
    root.add(g);
  };

  const fenderStep = Math.max(4.6, bay);
  const placeEdgeFenders = (edge: PierEdge) => {
    if (!edges.has(edge)) return;
    if (edge === 'west' || edge === 'east') {
      const n = Math.max(2, Math.floor((opt.length - 4) / fenderStep));
      const x = edge === 'west' ? minX : maxX;
      const rot = edge === 'west' ? -Math.PI / 2 : Math.PI / 2;
      for (let i = 0; i <= n; i++) {
        const z = minZ + 2.5 + (i / n) * (opt.length - 5.0);
        addFender(x, z, rot);
      }
    } else {
      const n = Math.max(2, Math.floor((opt.width - 4) / fenderStep));
      const z = edge === 'north' ? minZ : maxZ;
      const rot = edge === 'north' ? Math.PI : 0;
      for (let i = 0; i <= n; i++) {
        const x = minX + 2.5 + (i / n) * (opt.width - 5.0);
        addFender(x, z, rot);
      }
    }
  };
  placeEdgeFenders('west');
  placeEdgeFenders('east');
  placeEdgeFenders('north');
  placeEdgeFenders('south');

  // ---- 4. Cast-iron T-head mooring bollards ----------------------------------------------
  const isExcluded = (x: number, z: number): boolean => {
    if (!opt.bollardExclusions) return false;
    for (const ex of opt.bollardExclusions) {
      if (Math.hypot(x - ex.x, z - ex.z) < ex.radius) return true;
    }
    return false;
  };

  const addBollard = (x: number, z: number, rotY = 0) => {
    const g = new THREE.Group();
    g.position.set(x, deckY, z);
    g.rotation.y = rotY;
    // Steel baseplate
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.42), iron);
    base.position.y = 0.04;
    base.castShadow = true;
    g.add(base);
    // Tapered cast-iron barrel
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.44, 10), iron);
    barrel.position.y = 0.28;
    barrel.castShadow = true;
    g.add(barrel);
    // Flared T-head cap (classic marine mooring bollard silhouette)
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 0.12, 10), iron);
    cap.position.y = 0.52;
    cap.castShadow = true;
    g.add(cap);
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.48, 8).rotateZ(Math.PI / 2), iron);
    horn.position.y = 0.44;
    g.add(horn);
    // Subtle yellow visibility ring around bollard throat
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.148, 0.06, 10), hazardYellow);
    band.position.y = 0.36;
    g.add(band);
    root.add(g);
  };

  const bollardStep = Math.max(9.0, bay * 1.45);
  const placeEdgeBollards = (edge: PierEdge) => {
    if (!edges.has(edge)) return;
    if (edge === 'west' || edge === 'east') {
      const n = Math.max(2, Math.floor((opt.length - 6) / bollardStep));
      const x = edge === 'west' ? minX + 0.62 : maxX - 0.62;
      for (let i = 0; i <= n; i++) {
        const z = minZ + 3.8 + (i / n) * (opt.length - 7.6);
        if (!isExcluded(x, z)) addBollard(x, z, Math.PI / 2);
      }
    } else {
      const n = Math.max(1, Math.floor((opt.width - 8) / bollardStep));
      const z = edge === 'north' ? minZ + 0.62 : maxZ - 0.62;
      for (let i = 0; i <= n; i++) {
        const x = minX + 4.2 + (i / n) * (opt.width - 8.4);
        if (!isExcluded(x, z)) addBollard(x, z, 0);
      }
    }
  };
  placeEdgeBollards('west');
  placeEdgeBollards('east');
  placeEdgeBollards('north');
  placeEdgeBollards('south');
  opt.extraBollards?.forEach((b) => addBollard(b.x, b.z, Math.PI / 2));

  // ---- 5. Restrained galvanized safety railings along specified spans --------------------
  for (const span of opt.railings ?? []) {
    const dx = span.x1 - span.x0, dz = span.z1 - span.z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.8) continue;
    const yaw = Math.atan2(dx, dz);
    const posts = Math.max(2, Math.round(len / 2.2) + 1);
    const railH = 1.06;

    for (let i = 0; i < posts; i++) {
      const t = i / (posts - 1);
      const px = span.x0 + dx * t, pz = span.z0 + dz * t;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, railH, 6), galvSteel);
      post.position.set(px, deckY + railH / 2, pz);
      post.castShadow = true;
      root.add(post);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.11), iron);
      plate.position.set(px, deckY + 0.012, pz);
      root.add(plate);
    }
    const mx = (span.x0 + span.x1) / 2, mz = (span.z0 + span.z1) / 2;
    for (const ry of [railH - 0.02, railH * 0.54]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6).rotateX(Math.PI / 2), galvSteel);
      bar.position.set(mx, deckY + ry, mz);
      bar.rotation.y = yaw;
      bar.castShadow = true;
      root.add(bar);
    }
  }

  // ---- 6. Harbor floodlight stanchions / dockside beacons --------------------------------
  for (const lp of opt.lampPosts ?? []) {
    const g = new THREE.Group();
    g.position.set(lp.x, deckY, lp.z);
    g.rotation.y = lp.yaw ?? 0;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.30, 0.45, 8), concrete);
    plinth.position.y = 0.225;
    plinth.castShadow = true;
    g.add(plinth);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.11, 6.2, 8), galvSteel);
    mast.position.y = 3.5;
    mast.castShadow = true;
    g.add(mast);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.2), galvSteel);
    arm.position.set(0, 6.45, 0.5);
    arm.rotation.x = -0.14;
    g.add(arm);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.62), iron);
    hood.position.set(0, 6.52, 1.05);
    g.add(hood);
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.48), lampGlow);
    bulb.position.set(0, 6.44, 1.05);
    g.add(bulb);
    root.add(g);
  }

  // ---- 7. Compact weathered steel port davit crane (optional corner landmark) ------------
  if (opt.davit) {
    const g = new THREE.Group();
    g.position.set(opt.davit.x, deckY, opt.davit.z);
    g.rotation.y = opt.davit.yaw;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.58, 0.45, 10), iron);
    base.position.y = 0.225;
    base.castShadow = true;
    g.add(base);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.28, 4.4, 10), safetyOrange);
    col.position.y = 2.4;
    col.castShadow = true;
    g.add(col);
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 4.6), safetyOrange);
    boom.position.set(0, 5.2, 1.85);
    boom.rotation.x = -0.36;
    boom.castShadow = true;
    g.add(boom);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.7, 6), iron);
    strut.position.set(0, 4.1, 1.15);
    strut.rotation.x = 0.72;
    g.add(strut);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.8, 5), galvSteel);
    cable.position.set(0, 4.45, 3.7);
    g.add(cable);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.34, 0.14), hazardYellow);
    hook.position.set(0, 3.0, 3.7);
    g.add(hook);
    root.add(g);
  }

  // ---- 8. Life-ring safety stations ------------------------------------------------------
  for (const lr of opt.lifeRings ?? []) {
    const g = new THREE.Group();
    g.position.set(lr.x, deckY, lr.z);
    g.rotation.y = lr.yaw;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 1.45, 6), galvSteel);
    post.position.y = 0.725;
    post.castShadow = true;
    g.add(post);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.075, 8, 16), safetyOrange);
    ring.position.set(0, 1.12, 0.08);
    ring.castShadow = true;
    g.add(ring);
    root.add(g);
  }

  // Batch all static parts into 1 mesh per material!
  mergeStaticMeshes(root);
  reg.group.add(root);
  return root;
}

// ---- Coastal Lighthouse -----------------------------------------------------------

export interface LighthouseOptions {
  x: number;
  y: number;
  z: number;
  scale?: number;
  /** Warm lantern brightness (higher in storm/golden hour). */
  beaconIntensity?: number;
}

/** Whitewashed masonry coastal lighthouse with red band, gallery deck, lantern & keeper cottage. */
export function buildLighthouse(reg: SceneryRegistry, weather: Weather, opt: LighthouseOptions): THREE.Group {
  const root = new THREE.Group();
  root.name = 'coastal-lighthouse';
  const s = opt.scale ?? 1;
  root.position.set(opt.x, opt.y - 0.6 * s, opt.z);

  const whitePlaster = createMarineConcreteMaterial(reg, weather, { tone: [0.84, 0.82, 0.77], wetLine: 0.2 });
  const redBand = createMarineMetalMaterial(reg, { name: 'lighthouse-red', color: 0x9e251e, roughness: 0.72, metalness: 0.05 });
  const darkRoof = createMarineMetalMaterial(reg, { name: 'lighthouse-roof', color: 0x242a30, roughness: 0.55, metalness: 0.55 });
  const bi = opt.beaconIntensity ?? 32;
  const lanternMat = createBeaconMaterial(reg, [bi, bi * 0.78, bi * 0.38], 'lighthouse-beacon');

  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6 * s, 3.1 * s, 2.2 * s, 12), whitePlaster);
  base.position.y = 1.1 * s;
  root.add(base);
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(2.0 * s, 2.6 * s, 7.2 * s, 12), whitePlaster);
  lower.position.y = 5.6 * s;
  root.add(lower);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.75 * s, 2.0 * s, 3.6 * s, 12), redBand);
  band.position.y = 11.0 * s;
  root.add(band);
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(1.55 * s, 1.75 * s, 3.2 * s, 12), whitePlaster);
  upper.position.y = 14.4 * s;
  root.add(upper);
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(2.15 * s, 1.9 * s, 0.65 * s, 12), darkRoof);
  gallery.position.y = 16.2 * s;
  root.add(gallery);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.18 * s, 1.22 * s, 2.1 * s, 12), lanternMat);
  lantern.position.y = 17.55 * s;
  root.add(lantern);
  const dome = new THREE.Mesh(new THREE.ConeGeometry(1.52 * s, 1.8 * s, 12), darkRoof);
  dome.position.y = 19.45 * s;
  root.add(dome);
  // Small keeper's cottage beside the tower for architectural scale.
  const cottage = new THREE.Mesh(new THREE.BoxGeometry(5.6 * s, 3.0 * s, 3.8 * s), whitePlaster);
  cottage.position.set(4.5 * s, 1.5 * s, 0.6 * s);
  root.add(cottage);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.4 * s, 1.8 * s, 4).rotateY(Math.PI / 4), darkRoof);
  roof.position.set(4.5 * s, 3.9 * s, 0.6 * s);
  root.add(roof);

  mergeStaticMeshes(root);
  reg.group.add(root);
  return root;
}

// ---- Floating Mooring & Navigation Buoys ------------------------------------------

export interface BuoySpec {
  x: number;
  z: number;
  kind: 'mooring' | 'channel';
  color?: number;
  beacon?: [number, number, number];
}

export interface BuoyHandle {
  group: THREE.Group;
  x: number;
  z: number;
  phase: number;
  followSurface(ocean: Pick<Ocean, 'heightsAt'>, camera: THREE.Vector3, dt: number, immersion: number): void;
}

/** Build a realistic steel mooring or lattice navigation buoy (bobs cleanly with `ocean.heightAt`). */
export function buildBuoy(reg: SceneryRegistry, spec: BuoySpec): BuoyHandle {
  const g = new THREE.Group();
  g.name = `buoy-${spec.kind}`;
  g.position.set(spec.x, 0, spec.z);

  const hullMat = createMarineMetalMaterial(reg, {
    name: `buoy-hull-${spec.color ?? 0xb83124}`,
    color: spec.color ?? (spec.kind === 'mooring' ? 0xc03a24 : 0xbd2622),
    roughness: 0.48,
    metalness: 0.42,
  });
  const darkIron = createMarineMetalMaterial(reg, { name: 'buoy-iron', color: 0x20252a, roughness: 0.55, metalness: 0.78 });

  if (spec.kind === 'mooring') {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.56, 0.95, 12), hullMat);
    drum.position.y = 0.05;
    drum.castShadow = true;
    g.add(drum);
    const fenderBand = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.09, 6, 14).rotateX(Math.PI / 2), darkIron);
    fenderBand.position.y = 0.25;
    g.add(fenderBand);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 6, 10), darkIron);
    ring.position.y = 0.66;
    g.add(ring);
  } else {
    const float = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 0.9, 1.35, 10), hullMat);
    float.position.y = 0.1;
    g.add(float);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.9, 6), hullMat);
      leg.position.set(Math.cos(a) * 0.45, 2.0, Math.sin(a) * 0.45);
      leg.rotation.z = Math.cos(a) * 0.22;
      leg.rotation.x = -Math.sin(a) * 0.22;
      g.add(leg);
    }
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.35, 8), darkIron);
    top.position.y = 3.45;
    g.add(top);
    if (spec.beacon) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), createBeaconMaterial(reg, spec.beacon, 'buoy-beacon'));
      lamp.position.y = 3.78;
      g.add(lamp);
    }
  }

  mergeStaticMeshes(g);
  reg.group.add(g);
  const radius = spec.kind === 'channel' ? 1.05 : 0.60;
  const halfWidth = radius * Math.sqrt(3) * 0.5;
  const points = [
    new THREE.Vector3(spec.x-halfWidth,0,spec.z-radius*0.5),
    new THREE.Vector3(spec.x+halfWidth,0,spec.z-radius*0.5),
    new THREE.Vector3(spec.x,0,spec.z+radius),
  ];
  const batch = new OceanHeightBatch(points.length);
  let untilSample = 0, first = true;
  let height = 0, slopeX = 0, slopeZ = 0, tiltX = 0, tiltZ = 0;
  return {
    group: g, x: spec.x, z: spec.z, phase: (spec.x * 0.13 + spec.z * 0.07) % (Math.PI * 2),
    followSurface(ocean,camera,dt,immersion) {
      untilSample -= dt;
      if (untilSample <= 0) {
        const dx = spec.x-camera.x, dz = spec.z-camera.z;
        const interval = dx*dx+dz*dz < 220*220 ? 1/30 : 1/12;
        untilSample = interval + untilSample % interval;
        ocean.heightsAt(points,batch);
        const h = batch.heights;
        // The mean and two gradients of the plane through the waterline probes.
        // All three sample the same FFT, tsunami and local disturbance history.
        height = (h[0]+h[1]+h[2])/3-immersion;
        slopeX = (h[1]-h[0])/(2*halfWidth);
        slopeZ = (h[2]-(h[0]+h[1])*0.5)/(1.5*radius);
      }
      if (dt <= 0 && !first) return;
      const settle = first ? 1 : 1-Math.exp(-dt*9);
      first = false;
      g.position.y += (height-g.position.y)*settle;
      tiltX += (slopeX-tiltX)*settle;
      tiltZ += (slopeZ-tiltZ)*settle;
      // Shortest rotation from up to the sampled normal, retaining the mooring heading.
      const w = 1+Math.sqrt(1+tiltX*tiltX+tiltZ*tiltZ);
      const inv = 1/Math.sqrt(w*w+tiltX*tiltX+tiltZ*tiltZ);
      g.quaternion.set(-tiltZ*inv,0,tiltX*inv,w*inv);
    },
  };
}

// ---- Distant Maritime Vessels (Scale Anchors on Horizon) --------------------------

export interface VesselSpec {
  x: number;
  z: number;
  yaw: number;
  kind: 'freighter' | 'frigate' | 'sailboat';
  scale?: number;
}

/** Low-poly architectural maritime silhouettes anchored in the far/mid distance (2–4 draw calls). */
export function buildDistantVessels(reg: SceneryRegistry, weather: Weather, specs: VesselSpec[]): THREE.Group {
  const root = new THREE.Group();
  root.name = 'distant-vessels';

  const hullDark = createMarineMetalMaterial(reg, { name: 'vessel-hull-dark', color: 0x262e36, roughness: 0.72, metalness: 0.28 });
  const hullRed = createMarineMetalMaterial(reg, { name: 'vessel-red', color: 0x6b2822, roughness: 0.78, metalness: 0.15 });
  const navalGrey = createMarineMetalMaterial(reg, { name: 'vessel-naval', color: 0x56616a, roughness: 0.68, metalness: 0.32 });
  const superWhite = createMarineConcreteMaterial(reg, weather, { tone: [0.80, 0.80, 0.78], wetLine: 0.0 });
  const mastSteel = createMarineMetalMaterial(reg, { name: 'vessel-mast', color: 0x3b4248, roughness: 0.62, metalness: 0.6 });
  const containerA = createMarineMetalMaterial(reg, { name: 'vessel-cargo-a', color: 0x7c3624, roughness: 0.78, metalness: 0.15 });
  const containerB = createMarineMetalMaterial(reg, { name: 'vessel-cargo-b', color: 0x28495c, roughness: 0.78, metalness: 0.15 });
  const navGlow = createBeaconMaterial(reg, [24, 15, 6], 'vessel-nav-glow');

  for (const sp of specs) {
    const g = new THREE.Group();
    const s = sp.scale ?? 1;
    g.position.set(sp.x, 0, sp.z);
    g.rotation.y = sp.yaw;

    if (sp.kind === 'freighter') {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(118 * s, 4.2 * s, 18 * s), hullRed);
      boot.position.y = 0.6 * s;
      g.add(boot);
      const hull = new THREE.Mesh(new THREE.BoxGeometry(116 * s, 7.2 * s, 18.2 * s), hullDark);
      hull.position.y = 5.4 * s;
      g.add(hull);
      const bow = new THREE.Mesh(new THREE.ConeGeometry(9.2 * s, 20 * s, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4), hullDark);
      bow.position.set(66 * s, 5.2 * s, 0);
      g.add(bow);
      // Stacked container blocks
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(36 * s, 7.5 * s, 14.5 * s), containerA);
      c1.position.set(16 * s, 12.6 * s, 0);
      g.add(c1);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(28 * s, 6.2 * s, 14.0 * s), containerB);
      c2.position.set(-18 * s, 12.0 * s, 0);
      g.add(c2);
      // Aft bridge superstructure + funnel
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(14 * s, 16 * s, 15 * s), superWhite);
      bridge.position.set(-42 * s, 16.5 * s, 0);
      g.add(bridge);
      const funnel = new THREE.Mesh(new THREE.CylinderGeometry(1.9 * s, 2.3 * s, 6.5 * s, 8), containerA);
      funnel.position.set(-46 * s, 26.8 * s, 0);
      g.add(funnel);
      const nav = new THREE.Mesh(new THREE.BoxGeometry(1.2 * s, 1.0 * s, 1.2 * s), navGlow);
      nav.position.set(-40 * s, 25.5 * s, 0);
      g.add(nav);
    } else if (sp.kind === 'frigate') {
      // Sleek grey naval escort / destroyer silhouette for the jet test range
      const hull = new THREE.Mesh(new THREE.BoxGeometry(112 * s, 6.5 * s, 14.5 * s), navalGrey);
      hull.position.y = 2.6 * s;
      g.add(hull);
      const bow = new THREE.Mesh(new THREE.ConeGeometry(7.6 * s, 24 * s, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4), navalGrey);
      bow.position.set(66 * s, 2.8 * s, 0);
      g.add(bow);
      const deckhouse = new THREE.Mesh(new THREE.BoxGeometry(44 * s, 8.2 * s, 11.2 * s), navalGrey);
      deckhouse.position.set(4 * s, 9.6 * s, 0);
      g.add(deckhouse);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(14 * s, 7.5 * s, 9.6 * s), navalGrey);
      bridge.position.set(16 * s, 16.5 * s, 0);
      g.add(bridge);
      const mast = new THREE.Mesh(new THREE.ConeGeometry(1.6 * s, 18 * s, 4), mastSteel);
      mast.position.set(12 * s, 28 * s, 0);
      g.add(mast);
      const aftMast = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * s, 1.1 * s, 12 * s, 6), mastSteel);
      aftMast.position.set(-14 * s, 19.5 * s, 0);
      g.add(aftMast);
    } else {
      // Quiet moored coastal sailboat
      const hull = new THREE.Mesh(new THREE.BoxGeometry(9.6 * s, 1.3 * s, 2.9 * s), superWhite);
      hull.position.y = 0.55 * s;
      g.add(hull);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(4.2 * s, 0.85 * s, 2.1 * s), superWhite);
      cabin.position.set(-0.6 * s, 1.5 * s, 0);
      g.add(cabin);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.09 * s, 12.2 * s, 6), mastSteel);
      mast.position.set(0.4 * s, 6.8 * s, 0);
      g.add(mast);
      const furledSail = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.16 * s, 3.8 * s, 6).rotateZ(Math.PI / 2), superWhite);
      furledSail.position.set(-1.5 * s, 2.35 * s, 0);
      g.add(furledSail);
    }

    root.add(g);
  }

  mergeStaticMeshes(root);
  reg.group.add(root);
  return root;
}
