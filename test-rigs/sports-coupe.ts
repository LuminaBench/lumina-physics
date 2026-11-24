/**
 * Procedural sports coupe (test vehicle): a low grand-touring fastback with a long sculpted
 * hood, muscular rear haunches, properly rounded wheel wells with dark wheelhouse liners,
 * recessed LED headlamp housings, panel shutlines, metallic-flake clearcoat paint, o-ring
 * grooved tyres and speed-aware wheel motion blur.
 *
 *   body        lofted shell with exact circular wheel-arch cutouts, rolled fender lips and
 *               continuous smooth normals (no interior-wall normal bleed); clearcoat metallic
 *               flake TSL paint with two-stage flop and recessed panel shutlines
 *   wheel wells smooth cylindrical dark wheelhouse tubs tucked cleanly behind the rolled lips
 *   lighting    recessed dark headlamp buckets, twin projector optics, angled DRL blades,
 *               clear lenses, full-width smoked tail-lamp housing with HDR brake signature
 *   wheels      o-ring lathed tyres with procedural tread + speed-aware tread blur, split
 *               5-spoke concave alloys with speed-aware radial motion-blur discs, vented
 *               brushed rotors and stationary multi-piston calipers
 *
 * Rig convention: forward = -Z, right = +X, origin on the road under the wheelbase centre.
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TSL, type N } from '../engine/tsl';
import type { TestCarRig } from './test-car';
import { mergeStaticMeshes } from '../engine/batching';

const {
  Fn, float, vec2, vec3, vec4, uniform, uv, normalView, positionViewDirection,
  abs, dot, normalize, mix, smoothstep, pow, fract, floor, sin, cos, max, min, length, atan, mod, texture,
} = TSL;

export interface SportsCoupeRig extends TestCarRig {
  shell: THREE.Mesh;
  crumpleAttachments: THREE.Mesh[];
  /** 0..1 brake pressure (tail bar brightness). */
  setBrake(amount: number): void;
  setHeadlights(on: boolean, intensityScale?: number): void;
  /** Current brake-light output 0..1 (for road-surface glow). */
  readonly brakeGlow: number;
  rearLampCenters(left: THREE.Vector3, right: THREE.Vector3): void;
  wheelbase: number;
  /** Per-wheel angular velocity (rad/s) for speed-aware spoke & tread blur. */
  setWheelSpeed(index: number, omega: number): void;
}

const LENGTH = 4.54, HALF = LENGTH / 2;
const AXLE_FRONT = -1.4, AXLE_REAR = 1.33, TRACK = 0.81, WHEEL_RADIUS = 0.335;
const ARCH_HUB_Y = WHEEL_RADIUS + 0.014;
const ARCH_RADIUS = WHEEL_RADIUS + 0.058; // ~39.3 cm taut sporty arch opening

const ss = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
/** Smooth bump: 1 at `centre`, 0 beyond `width`. */
const bump = (z: number, centre: number, width: number) => {
  const t = Math.min(1, Math.abs(z - centre) / width);
  return (1 + Math.cos(t * Math.PI)) / 2;
};

/** Height of the body side's upper edge (low nose → sculpted hood → shoulder → rear haunch → ducktail). */
function beltHeight(z: number): number {
  const noseDrop = -0.14 * Math.pow(1 - ss(z, -HALF, -HALF + 0.42), 1.6);
  const hood = lerp(0.64, 0.855, ss(z, -HALF + 0.12, -0.58)) + noseDrop;
  const deck = lerp(0.855, 0.905, ss(z, 0.15, 1.52));
  const tail = 0.905 + 0.048 * bump(z, HALF - 0.14, 0.26) - 0.11 * ss(z, HALF - 0.09, HALF + 0.01);
  return z < 0.15 ? hood : z < 1.52 ? deck : tail;
}

/** 0 outside the cabin, 1 at the roof's highest point: raked windscreen, sweeping fastback. */
function cabin(z: number): number {
  if (z < -0.94 || z > 1.88) return 0;
  return z < 0.04 ? ss(z, -0.94, 0.04) : 1 - ss(z, 0.18, 1.88) ** 1.15;
}

/** Body half-width at the belt: sleek tapered nose, flared front fenders, Coke-bottle waist, wide rear haunches. */
function halfWidth(z: number): number {
  const base = lerp(0.76, 0.945, ss(z, -HALF, -1.52));
  const frontFlare = 0.024 * bump(z, AXLE_FRONT, 0.56);
  const waist = -0.042 * bump(z, -0.08, 0.88);
  const haunch = 0.056 * bump(z, AXLE_REAR - 0.04, 0.78);
  const tail = -0.115 * ss(z, 1.72, HALF);
  return base + frontFlare + waist + haunch + tail;
}

function floorHeight(z: number): number {
  return 0.155 + 0.115 * ss(z, 1.58, HALF) + 0.055 * (1 - ss(z, -HALF, -1.88));
}

/** Exact single-valued wheel-arch lower boundary height at station `z` (equals `floor` outside arches). */
function archBoundary(z: number, floor: number): { yCut: number; inArch: number; flare: number } {
  let yCut = floor;
  let inArch = 0;
  let flare = 0;
  for (const axle of [AXLE_FRONT, AXLE_REAR]) {
    const dz = Math.abs(z - axle);
    // Smooth outward fender flare halo hugging the circular arch
    if (dz < ARCH_RADIUS + 0.18) {
      const f = bump(dz, ARCH_RADIUS * 0.72, 0.34);
      flare = Math.max(flare, f * (axle > 0 ? 0.032 : 0.024));
    }
    if (dz < ARCH_RADIUS + 0.024) {
      if (dz <= ARCH_RADIUS * 0.992) {
        const yCircle = ARCH_HUB_Y + Math.sqrt(Math.max(0, ARCH_RADIUS * ARCH_RADIUS - dz * dz));
        if (yCircle > yCut) {
          yCut = yCircle;
          inArch = 1;
        }
      } else {
        // Crisp 2.4 cm rounded corner where the vertical arch rim meets the lower rocker sill
        const t = 1 - ss(dz, ARCH_RADIUS * 0.992, ARCH_RADIUS + 0.024);
        const yCorner = lerp(floor, ARCH_HUB_Y + ARCH_RADIUS * 0.125, t);
        if (yCorner > yCut) {
          yCut = yCorner;
          inArch = t;
        }
      }
    }
  }
  return { yCut, inArch, flare };
}

/**
 * Right-side cross-section from rolled lower/arch lip up to roof centreline.
 * Points 0..1 are the rolled lip return (tucked inward), 2..11 are the exterior painted body side
 * & fender crown, 12..18 are the greenhouse / hood / roof.
 */
function exteriorSection(z: number): Array<{ x: number; y: number; shade: number }> {
  const w = halfWidth(z), belt = beltHeight(z), floor = floorHeight(z), c = cabin(z);
  // Smooth aerodynamic nose & tail wrap-around (eliminates sharp planar cap creases).
  const uNose = clamp((z - (-HALF)) / 0.30, 0, 1);
  const uTail = clamp((HALF - z) / 0.24, 0, 1);
  const noseWrap = uNose < 1 ? Math.pow(Math.sin(uNose * Math.PI * 0.5), 0.55) : 1;
  const tailWrap = uTail < 1 ? Math.pow(Math.sin(uTail * Math.PI * 0.5), 0.45) : 1;
  const endWrap = Math.min(noseWrap, tailWrap);
  const endWidth = z < 0 ? 0.83 : 0.36;
  const W = w * (endWidth + (1 - endWidth) * endWrap);

  const roofRise = 0.345 * c;
  const crown = (0.042 * (1 - c) * ss(z, -HALF + 0.08, -HALF + 0.65)) * endWrap;
  const roof = belt + roofRise + crown;
  const { yCut, inArch, flare } = archBoundary(z, floor);

  // Subtle hood power-bulge & side shoulder crease
  const hoodScoop = 0.014 * bump(z, -1.32, 0.58) * (1 - c);
  const Wf = W + flare * endWrap;

  // Vertical span from lower edge (rocker or circular wheel arch) to belt line
  const y0 = yCut;
  const span = Math.max(0.06, belt - y0);

  // Rolled lip: inside wheel arches rolls cleanly 4.5 cm inward; along rocker forms lower sill return
  const lipReturnX = inArch > 0.01
    ? lerp(Math.max(0.56, Wf - 0.09), Math.max(0.58, Wf - 0.055), inArch)
    : Wf * 0.82;
  const lipMidX = inArch > 0.01 ? Wf - 0.022 : Wf * 0.945;
  const lipShade = lerp(0.55, 0.08, inArch);
  const lipCrestShade = lerp(0.84, 0.52, inArch);

  // Sculpted body-side curvature (taut rocker tuck, slight door concave sculpt, full fender shoulder)
  const doorSculpt = -0.009 * bump(z, -0.08, 1.02) * (1 - inArch);
  const s1 = lerp(y0, belt, 0.12);
  const s2 = lerp(y0, belt, 0.30);
  const s3 = lerp(y0, belt, 0.50);
  const s4 = lerp(y0, belt, 0.70);
  const s5 = lerp(y0, belt, 0.86);
  const s6 = belt - Math.min(0.032, span * 0.14);

  // Greenhouse tumblehome (or hood/deck contour outside cabin)
  const g0 = lerp(0.86 * Wf, 0.79 * W, c);
  const g1 = lerp(0.68 * Wf, 0.715 * W, c);
  const g2 = lerp(0.49 * Wf, 0.615 * W, c);
  const g3 = lerp(0.30 * Wf, 0.45 * W, c);
  const g4 = lerp(0.14 * Wf, 0.24 * W, c);

  // Lower-body subtle AO near road
  const ao0 = lerp(0.62, 1.0, ss(y0, 0.15, 0.32));
  const ao1 = lerp(0.76, 1.0, ss(s1, 0.18, 0.36));

  return [
    { x: lipReturnX, y: y0 - (inArch > 0.01 ? 0.008 : 0.004), shade: lipShade },              // 0: inner rolled lip return
    { x: lipMidX, y: y0 + 0.003, shade: lipCrestShade },                                      // 1: rolled lip crest
    { x: Wf * 0.985, y: y0 + Math.min(0.022, span * 0.06), shade: ao0 },                      // 2: arch/rocker outer lip
    { x: Wf * 1.008 + doorSculpt * 0.5, y: s1, shade: ao1 },                                  // 3: lower body
    { x: Wf * 1.018 + doorSculpt, y: s2, shade: 0.96 },                                       // 4: lower-mid door / arch flare
    { x: Wf * 1.016 + doorSculpt * 0.7, y: s3, shade: 1.0 },                                  // 5: mid body
    { x: Wf * 1.005, y: s4, shade: 1.0 },                                                     // 6: upper body
    { x: Wf * 0.985, y: s5, shade: 1.0 },                                                     // 7: shoulder curve
    { x: Wf * 0.945, y: s6, shade: 1.0 },                                                     // 8: belt bevel
    { x: g0, y: belt + 0.014 + crown * 0.28, shade: 1.0 },                                    // 9: glazing base / fender top
    { x: g1, y: belt + roofRise * 0.44 + crown * 0.58 + hoodScoop * 0.3, shade: 1.0 },        // 10: mid glass / hood flank
    { x: g2, y: belt + roofRise * 0.82 + crown * 0.84 + hoodScoop * 0.8, shade: 1.0 },        // 11: upper glass / hood ridge
    { x: g3, y: roof - 0.018 + hoodScoop, shade: 1.0 },                                       // 12: roof cantrail / hood crown
    { x: g4, y: roof - 0.004 + hoodScoop * 0.7, shade: 1.0 },                                 // 13: roof inner
    { x: 0, y: roof + hoodScoop * 0.4, shade: 1.0 },                                          // 14: centreline
  ];
}

function buildStations(): number[] {
  const raw: number[] = [];
  const addRange = (a: number, b: number, n: number) => {
    for (let i = 0; i <= n; i++) raw.push(lerp(a, b, i / n));
  };
  // Dense nose wrap
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    raw.push(-HALF + 0.34 * (1 - Math.cos(t * Math.PI * 0.5)));
  }
  addRange(-HALF + 0.34, AXLE_FRONT - ARCH_RADIUS - 0.05, 8);
  // Cosine-clustered circular front arch stations
  for (const axle of [AXLE_FRONT, AXLE_REAR]) {
    raw.push(axle - ARCH_RADIUS - 0.025, axle - ARCH_RADIUS - 0.01);
    for (let i = 0; i <= 26; i++) {
      const th = (i / 26) * Math.PI;
      raw.push(axle - Math.cos(th) * ARCH_RADIUS * 0.992);
    }
    raw.push(axle + ARCH_RADIUS + 0.01, axle + ARCH_RADIUS + 0.025);
  }
  addRange(AXLE_FRONT + ARCH_RADIUS + 0.05, AXLE_REAR - ARCH_RADIUS - 0.05, 28);
  addRange(AXLE_REAR + ARCH_RADIUS + 0.05, HALF - 0.32, 8);
  // Dense tail wrap
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    raw.push(HALF - 0.32 + 0.32 * Math.sin(t * Math.PI * 0.5));
  }
  raw.sort((a, b) => a - b);
  const zs: number[] = [];
  for (const z of raw) if (!zs.length || z - zs[zs.length - 1] > 0.004) zs.push(z);
  return zs;
}

/** Front corners sweep back from the centre of the bumper. */
function noseSetback(x: number): number { return 0.145 * (x / 0.78) ** 2; }

function buildShell(): THREE.BufferGeometry {
  const zs = buildStations();
  const stations = zs.length - 1;
  const half = exteriorSection(0).length; // 15 points (0 = lip return .. 14 = roof centreline)
  const ring = half * 2 - 1;              // open across underside: right lip(0)..roof(14)..left lip(28)
  const positions: number[] = [];
  const colors: number[] = [];

  for (const z of zs) {
    const side = exteriorSection(z);
    const loop: Array<{ x: number; y: number; shade: number }> = [...side];
    for (let i = half - 2; i >= 0; i--) {
      loop.push({ x: -side[i].x, y: side[i].y, shade: side[i].shade });
    }
    for (const pt of loop) {
      positions.push(pt.x, pt.y, z + noseSetback(pt.x) * (1 - ss(z, -HALF, -HALF + 0.42)));
      colors.push(pt.shade, pt.shade, pt.shade);
    }
  }

  const body: number[] = [], glass: number[] = [];
  for (let j = 0; j < stations; j++) {
    const zMid = (zs[j] + zs[j + 1]) * 0.5;
    const c = cabin(zMid);
    for (let i = 0; i < ring - 1; i++) {
      const a = j * ring + i, b = a + 1, d = a + ring, e = b + ring;
      // Symmetric segment index (0 = lip return .. 13 = roof centreline segment)
      const s = i < half - 1 ? i : ring - 2 - i;
      const screen = zMid > -0.88 && zMid < -0.18 && s >= 9;                                   // raked windscreen
      const backlight = zMid > 0.82 && zMid < 1.74 && s >= 10;                                 // fastback rear glass
      const sideGlass = zMid > -0.34 && zMid < 1.04 && s >= 9 && s <= 11 && !(zMid > 0.28 && zMid < 0.38); // B-pillar
      (c > 0.10 && (screen || backlight || sideGlass) ? glass : body).push(a, b, d, b, e, d);
    }
  }

  // Follow the curved bumper face across its width. Form the recessed intake
  // directly in the deformable shell so its lip and grille follow an impact.
  const strips = 32;
  const nose = exteriorSection(zs[0]);
  const noseStart = positions.length / 3;
  const shoulder = 8;
  // The hood crown arches across the final row. Follow its actual height at
  // each lateral station to join the top panel without folding the cap.
  for (let i = 0; i <= shoulder + 1; i++) {
    const row = nose[Math.min(i, shoulder)];
    for (let j = 0; j <= strips; j++) {
      const x = row.x * (2 * j / strips - 1);
      let y = row.y;
      if (i > shoulder) {
        let k = shoulder;
        while (k < nose.length - 2 && Math.abs(x) < nose[k + 1].x) k++;
        const lo = nose[k + 1], hi = nose[k];
        y = lerp(lo.y, hi.y, (Math.abs(x) - lo.x) / (hi.x - lo.x));
      }
      const halfOpening = 0.43 + 0.11 * ss(y, 0.19, 0.41);
      const inset = (1 - ss(Math.abs(x), halfOpening - 0.035, halfOpening))
        * ss(y, 0.202, 0.246) * (1 - ss(y, 0.377, 0.42));
      positions.push(x, y, zs[0] + noseSetback(x) + inset * 0.045);
      colors.push(row.shade, row.shade, row.shade);
    }
  }
  for (let i = 0; i <= shoulder; i++) for (let j = 0; j < strips; j++) {
    const a = noseStart + i * (strips + 1) + j, d = a + strips + 1;
    body.push(a, d, a + 1, a + 1, d, d + 1);
  }
  const last = stations * ring, tailC = positions.length / 3;
  positions.push(0, 0.54, zs[stations] - 0.01); colors.push(0.25, 0.25, 0.25);
  for (let i = 0; i < ring - 1; i++) body.push(tailC, last + i, last + i + 1);
  body.push(tailC, last + ring - 1, last);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('bodyRest', geometry.getAttribute('position').clone());
  geometry.setIndex([...body, ...glass]);
  geometry.addGroup(0, body.length, 0);
  geometry.addGroup(body.length, glass.length, 1);
  geometry.computeVertexNormals();
  return geometry;
}

/** Dark smooth cylindrical wheelhouse tub + inner backing plate so every arch is pitch-dark & rounded. */
function buildWheelhouseLiner(axleZ: number, side: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const rOut = ARCH_RADIUS - 0.008;
  const depth = 0.38;
  // Curved arch ceiling stopping cleanly above the rocker sill (never pokes below floor)
  const archGeo = new THREE.CylinderGeometry(rOut, rOut, depth, 24, 1, true, -Math.PI * 0.50, Math.PI * 1.00);
  archGeo.rotateZ(Math.PI / 2);
  archGeo.rotateX(-Math.PI / 2);
  const arch = new THREE.Mesh(archGeo, mat);
  arch.position.set(side * (TRACK - 0.06), ARCH_HUB_Y, axleZ);
  g.add(arch);
  // Inner vertical backing bulkhead inside wheel well (blocks light seeing through the car)
  const backGeo = new THREE.CircleGeometry(rOut * 0.96, 20, 0, Math.PI * 1.15);
  backGeo.rotateZ(-Math.PI * 0.075);
  backGeo.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
  const back = new THREE.Mesh(backGeo, mat);
  back.position.set(side * 0.55, ARCH_HUB_Y, axleZ);
  g.add(back);
  return g;
}

/** Shared procedural tread + sidewall texture for o-ring tires. */
let TYRE_TREAD_TEX: THREE.CanvasTexture | null = null;
function getTyreTexture(): THREE.CanvasTexture {
  if (TYRE_TREAD_TEX) return TYRE_TREAD_TEX;
  const w = 512, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  // Base vulcanised rubber charcoal
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, w, h);
  // Subtle rubber micro-grain
  for (let i = 0; i < 6000; i++) {
    const x = (i * 197) % w, y = (i * 113 + Math.floor(i / 64) * 29) % h;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(x, y, 2, 2);
  }
  // Lathe UV: v = 0..1 runs from inner bead -> sidewall -> tread -> sidewall -> outer bead,
  // u = 0..1 runs circumferentially around the tyre.
  // Circumferential rain evacuation grooves (tread band sits roughly in v ∈ [0.24, 0.76])
  const grooves = [0.33, 0.43, 0.57, 0.67];
  for (const g of grooves) {
    const gy = g * h;
    ctx.fillStyle = '#070809';
    ctx.fillRect(0, gy - 6, w, 12);
    ctx.fillStyle = '#26292e';
    ctx.fillRect(0, gy - 8, w, 2);
    ctx.fillRect(0, gy + 6, w, 2);
  }
  // Angled water-channel sipes & shoulder tread blocks
  ctx.strokeStyle = '#08090b';
  ctx.lineWidth = 4;
  for (let x = 0; x < w; x += 18) {
    // Upper shoulder blocks
    ctx.beginPath(); ctx.moveTo(x, h * 0.22); ctx.lineTo(x + 11, h * 0.33); ctx.stroke();
    // Lower shoulder blocks
    ctx.beginPath(); ctx.moveTo(x, h * 0.78); ctx.lineTo(x + 11, h * 0.67); ctx.stroke();
    // Center directional chevron sipes
    ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(x + 4, h * 0.43); ctx.lineTo(x + 12, h * 0.50); ctx.lineTo(x + 4, h * 0.57); ctx.stroke();
    ctx.lineWidth = 4;
  }
  // Subtle moulded sidewall concentric ridges & rim-protector band
  for (const vy of [0.11, 0.15, 0.19, 0.81, 0.85, 0.89]) {
    ctx.fillStyle = vy === 0.15 || vy === 0.85 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, vy * h, w, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  TYRE_TREAD_TEX = tex;
  return tex;
}

/** Metallic clearcoat flake car paint with 2-stage flop and crisp panel shutlines. */
function createCarPaintMaterial(color: THREE.ColorRepresentation): THREE.MeshPhysicalNodeMaterial {
  const base = new THREE.Color(color);
  // Deep saturated flop color at grazing angles, subtle warm metallic flake highlight face-on
  const flop = base.clone().multiplyScalar(0.34);
  const flakeTint = base.clone().lerp(new THREE.Color(0xfff4ea), 0.24);

  const mat = new THREE.MeshPhysicalNodeMaterial({
    color: 0xffffff,
    metalness: 0.66,
    roughness: 0.24,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    ior: 1.54,
    envMapIntensity: 1.6,
    vertexColors: true,
  });

  const p = TSL.attribute('bodyRest', 'vec3');
  const NdotV = abs(dot(normalize(normalView), normalize(positionViewDirection))).clamp(0, 1);

  // Ultra-fine 3D metallic micro-flake sparkle in car-local space (smooth pearl shimmer, no coarse dots)
  const cellA = floor(p.mul(580));
  const hA = fract(sin(dot(cellA, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  const cellB = floor(p.mul(960).add(17.3));
  const hB = fract(sin(dot(cellB, vec3(269.5, 183.3, 419.2))).mul(23421.631));
  const flake = smoothstep(0.84, 0.995, hA).mul(0.6).add(smoothstep(0.86, 0.995, hB).mul(0.4));

  // Crisp 5 mm automotive panel shutlines (hood seam, door front/rear seams, rear decklid seam, rocker line)
  const seamLine = (coord: N, target: N, halfW: number, mask: N): N =>
    float(1).sub(smoothstep(halfW * 0.35, halfW, abs(coord.sub(target)))).mul(mask);

  const ax = abs(p.x);
  const hoodMask = smoothstep(-2.06, -1.96, p.z).mul(smoothstep(-0.84, -0.94, p.z)).mul(smoothstep(0.46, 0.56, p.y));
  const hoodTargetX = mix(float(0.56), float(0.76), smoothstep(-2.04, -0.90, p.z));
  const hoodSeam = seamLine(ax, hoodTargetX, 0.0055, hoodMask);
  const noseSeam = seamLine(p.z, float(-2.00), 0.0055, smoothstep(0.62, 0.54, ax).mul(smoothstep(0.42, 0.50, p.y)));
  const doorFront = seamLine(p.z, float(-0.82), 0.006, smoothstep(0.20, 0.28, p.y).mul(smoothstep(0.89, 0.81, p.y)).mul(smoothstep(0.75, 0.86, ax)));
  const doorRear = seamLine(p.z, float(0.62), 0.006, smoothstep(0.20, 0.28, p.y).mul(smoothstep(0.92, 0.84, p.y)).mul(smoothstep(0.75, 0.86, ax)));
  const doorBottom = seamLine(p.y, float(0.265), 0.006, smoothstep(-0.84, -0.78, p.z).mul(smoothstep(0.64, 0.58, p.z)).mul(smoothstep(0.78, 0.86, ax)));
  const rearDeck = seamLine(p.z, float(1.76), 0.0055, smoothstep(0.62, 0.74, p.y).mul(smoothstep(0.84, 0.72, ax)));
  const shutline = max(max(hoodSeam, noseSeam), max(max(doorFront, doorRear), max(doorBottom, rearDeck))).clamp(0, 1);

  // Two-stage metallic paint flop + fine pearl flake sparkle + shutline recess darkening
  const paintTone = mix(vec3(flop.r, flop.g, flop.b), vec3(base.r, base.g, base.b), pow(NdotV, 0.58));
  const withFlake = mix(paintTone, vec3(flakeTint.r, flakeTint.g, flakeTint.b), flake.mul(0.11).mul(pow(NdotV, 0.6).add(0.2)));
  // Subtle lower-sill wetness / grime darkening near road surface
  const lowerShade = mix(float(0.74), float(1.0), smoothstep(0.16, 0.34, p.y));
  const intakeWidth = smoothstep(0.19, 0.41, p.y).mul(0.11).add(0.43);
  const opening = float(1).sub(smoothstep(intakeWidth.sub(0.025), intakeWidth, ax))
    .mul(smoothstep(0.21, 0.24, p.y)).mul(float(1).sub(smoothstep(0.375, 0.403, p.y)))
    .mul(float(1).sub(smoothstep(-HALF + 0.11, -HALF + 0.14, p.z)));
  // Expanded-metal grille. Average the fine diamond openings to their coverage
  // as their pitch approaches a pixel. The surround shares the bumper mesh.
  const strands = (phase: N) => {
    const distance = fract(phase).sub(0.5).abs(), aa = TSL.fwidth(phase).clamp(0.008,0.4);
    return float(1).sub(smoothstep(float(0.075).sub(aa), float(0.075).add(aa), distance));
  };
  const a = p.x.mul(52).add(p.y.mul(79)), b = p.x.mul(52).sub(p.y.mul(79));
  const coverage = mix(strands(a).max(strands(b)), 0.28, smoothstep(0.35, 0.9, TSL.fwidth(a).max(TSL.fwidth(b))));
  const meshColor = mix(vec3(0.004,0.005,0.006), vec3(0.084,0.093,0.102), coverage);
  mat.colorNode = mix(withFlake.mul(lowerShade).mul(mix(float(1.0), float(0.14), shutline)), meshColor, opening);
  mat.roughnessNode = mix(mix(float(0.24).sub(flake.mul(0.06)).add(hB.mul(0.025)), float(0.84), shutline), 0.57, opening);
  mat.metalnessNode = mix(mix(float(0.66).add(flake.mul(0.16)), float(0.1), shutline), coverage.mul(0.6), opening);
  mat.clearcoatNode = float(1).sub(opening);
  return mat;
}

/** Speed-aware tyre material: crisp tread at low speed, smooth circumferential blur at highway speed. */
function createTyreMaterial(uBlur: N): THREE.MeshStandardNodeMaterial {
  const tex = getTyreTexture();
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.04 });
  const st = uv();
  // At speed, blend 4 circumferential samples to blur tread blocks into realistic rolling streaks
  const s0 = texture(tex, st).rgb;
  const s1 = texture(tex, vec2(fract(st.x.add(0.07)), st.y)).rgb;
  const s2 = texture(tex, vec2(fract(st.x.add(0.14)), st.y)).rgb;
  const s3 = texture(tex, vec2(fract(st.x.add(0.21)), st.y)).rgb;
  const blurred = s0.add(s1).add(s2).add(s3).mul(0.25);
  const col = mix(s0, blurred, uBlur);
  // Wet-sheen shoulder/sidewall vs darker matte centre tread
  const isSidewall = float(1).sub(smoothstep(0.19, 0.26, st.y).mul(smoothstep(0.81, 0.74, st.y)));
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.76), float(0.46), isSidewall.mul(0.75));
  return mat;
}

/** Radial motion-blurred spinning alloy spoke disc (fades in smoothly with wheel angular speed). */
function createWheelBlurMaterial(uBlur: N, shutterArc: N): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xb6bcc4,
    roughness: 0.24,
    metalness: 0.92,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const c = uv().mul(2).sub(1);
  const r = length(c);
  const theta = atan(c.y, c.x);
  // Integrate both branches over a shutter interval. The disc rotates with the
  // hub already; the local azimuth therefore needs no second wheel rotation.
  const period = Math.PI*2/5;
  const phase = theta.sub(Math.PI/2).div(period);
  const halfWidth = float(0.038/period).div(r.max(0.23)).clamp(0.03,0.13);
  const split = smoothstep(0.23,0.85,r).mul(0.17/period);
  const sweep = shutterArc.div(period).max(0.001);
  // Antiderivative of a periodic rectangular spoke profile. This remains
  // continuous when an exposure crosses a sector or comprises multiple turns.
  const integral = (x:N) => floor(x).mul(halfWidth.mul(2)).add(fract(x).min(halfWidth.mul(2)));
  const exposure = (offset:N) => {
    const start = phase.add(offset).add(halfWidth).sub(sweep.mul(0.5));
    return integral(start.add(sweep)).sub(integral(start)).div(sweep);
  };
  const coverage = exposure(split).add(exposure(split.negate())).clamp(0,1);
  const rimBand = smoothstep(0.19,0.27,r).mul(float(1).sub(smoothstep(0.94,1.0,r)));
  mat.colorNode = mix(vec3(0.25,0.27,0.30),vec3(0.52,0.54,0.58),smoothstep(0.5,0.90,r));
  mat.opacityNode = coverage.mul(rimBand).mul(uBlur);
  return mat;
}

interface WheelVisual {
  pivot: THREE.Group;
  spokes: THREE.Group;
  spokeMaterial: THREE.MeshStandardMaterial;
  blurDisc: THREE.Mesh;
  uBlur: { value: number };
  shutterArc: { value: number };
}

function buildWheel(
  width: number,
  alloyMat: THREE.Material,
  caliperMat: THREE.Material,
  side: number,
): WheelVisual {
  const pivot = new THREE.Group();
  const spin = new THREE.Group();
  spin.name = 'spin';
  const R = WHEEL_RADIUS, rim = R * 0.69, w = width * 0.5;
  const uBlur = uniform(0);
  const shutterArc = uniform(0);

  // 1) Rounded O-ring tyre profile with rim-protector lip, sidewall bulge and flat tread crown
  const tyreProfile = [
    new THREE.Vector2(rim * 0.97, -w * 0.94),
    new THREE.Vector2(rim * 1.03, -w * 1.02),
    new THREE.Vector2(R * 0.84, -w * 1.04),
    new THREE.Vector2(R * 0.935, -w * 0.96),
    new THREE.Vector2(R * 0.985, -w * 0.80),
    new THREE.Vector2(R, -w * 0.56),
    new THREE.Vector2(R * 1.003, 0),
    new THREE.Vector2(R, w * 0.56),
    new THREE.Vector2(R * 0.985, w * 0.80),
    new THREE.Vector2(R * 0.935, w * 0.96),
    new THREE.Vector2(R * 0.84, w * 1.04),
    new THREE.Vector2(rim * 1.03, w * 1.02),
    new THREE.Vector2(rim * 0.97, w * 0.94),
  ];
  const tyreGeo = new THREE.LatheGeometry(tyreProfile, 64).rotateZ(Math.PI / 2);
  const tyreMesh = new THREE.Mesh(tyreGeo, createTyreMaterial(uBlur));
  tyreMesh.castShadow = true;
  spin.add(tyreMesh);

  // 2) Rim barrel + stepped lip + centre hub + lug nuts + vented brake rotor (merged into 1 mesh via vertex color)
  const rimParts = new THREE.Group();
  const colorize = (geo: THREE.BufferGeometry, r: number, g: number, b: number) => {
    const n = geo.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i * 3] = r; cols[i * 3 + 1] = g; cols[i * 3 + 2] = b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    return geo;
  };
  // Stepped rim barrel
  const barrelProfile = [
    new THREE.Vector2(rim * 0.90, -w * 0.92),
    new THREE.Vector2(rim * 0.92, -w * 0.92),
    new THREE.Vector2(rim * 0.92, w * 0.72),
    new THREE.Vector2(rim * 1.01, w * 0.86),
    new THREE.Vector2(rim * 1.01, w * 0.95),
    new THREE.Vector2(rim * 0.93, w * 0.95),
    new THREE.Vector2(rim * 0.88, w * 0.78),
    new THREE.Vector2(rim * 0.88, -w * 0.92),
  ];
  const barrelGeo = new THREE.LatheGeometry(barrelProfile, 48).rotateZ(side > 0 ? -Math.PI / 2 : Math.PI / 2);
  rimParts.add(new THREE.Mesh(colorize(barrelGeo, 0.82, 0.85, 0.88), alloyMat));
  // Recessed hub bell & centre cap
  const hubGeo = new THREE.CylinderGeometry(R * 0.145, R * 0.19, width * 0.42, 16).rotateZ(Math.PI / 2);
  const hub = new THREE.Mesh(colorize(hubGeo, 0.74, 0.77, 0.82), alloyMat);
  hub.position.x = side * w * 0.42;
  rimParts.add(hub);
  // Brake rotor disc (brushed steel darker tone, slightly recessed inside barrel)
  const rotorGeo = new THREE.CylinderGeometry(rim * 0.81, rim * 0.81, 0.024, 28).rotateZ(Math.PI / 2);
  const rotor = new THREE.Mesh(colorize(rotorGeo, 0.18, 0.19, 0.205), alloyMat);
  rotor.position.x = side * w * 0.08;
  rimParts.add(rotor);
  // Inner rotor hat (dark gunmetal)
  const hatGeo = new THREE.CylinderGeometry(rim * 0.44, rim * 0.46, 0.044, 18).rotateZ(Math.PI / 2);
  const hat = new THREE.Mesh(colorize(hatGeo, 0.085, 0.09, 0.108), alloyMat);
  hat.position.x = side * w * 0.14;
  rimParts.add(hat);
  mergeStaticMeshes(rimParts);
  spin.add(...rimParts.children);

  // 3) Split 5-spoke concave Y-spokes (separate mesh so they fade smoothly at highway speed)
  const spokesGroup = new THREE.Group();
  const spokesMat = (alloyMat as THREE.MeshStandardMaterial).clone();
  spokesMat.transparent = true;
  spokesMat.opacity = 1;
  for (let s = 0; s < 5; s++) {
    const baseA = (s / 5) * Math.PI * 2;
    for (const branch of [-1, 1]) {
      const arm = new THREE.Group();
      arm.rotation.x = baseA + branch * 0.16;
      const spokeGeo = colorize(new THREE.BoxGeometry(0.022, rim * 0.86, 0.028), 0.92, 0.94, 0.97);
      const spoke = new THREE.Mesh(spokeGeo, spokesMat);
      spoke.position.set(side * w * 0.66, rim * 0.52, branch * -0.012);
      spoke.rotation.z = side * -0.14; // subtle concave dish toward hub
      spoke.rotation.x = branch * 0.14;
      arm.add(spoke);
      spokesGroup.add(arm);
    }
  }
  mergeStaticMeshes(spokesGroup);
  const spokes = spokesGroup;
  spin.add(spokes);

  // 4) Speed-aware radial motion-blur spoke disc
  const blurGeo = new THREE.PlaneGeometry(rim * 1.92, rim * 1.92).rotateY(Math.PI / 2);
  const blurDisc = new THREE.Mesh(blurGeo, createWheelBlurMaterial(uBlur, shutterArc));
  blurDisc.position.x = side * w * 0.66;
  blurDisc.visible = false;
  spin.add(blurDisc);

  // 5) Stationary multi-piston performance brake caliper on the upright
  const caliperGroup = new THREE.Group();
  const calMain = new THREE.Mesh(new THREE.BoxGeometry(0.072, rim * 0.50, 0.115), caliperMat);
  calMain.position.set(side * w * 0.10, 0.02, rim * 0.58);
  calMain.rotation.x = -0.16;
  const calCap = new THREE.Mesh(new THREE.BoxGeometry(0.056, rim * 0.34, 0.05), caliperMat);
  calCap.position.set(side * w * 0.14, 0.02, rim * 0.62);
  calCap.rotation.x = -0.16;
  caliperGroup.add(calMain, calCap);
  mergeStaticMeshes(caliperGroup);
  pivot.add(spin, ...caliperGroup.children);

  return { pivot, spokes, spokeMaterial: spokesMat, blurDisc, uBlur, shutterArc };
}

export function createSportsCoupe(color: THREE.ColorRepresentation = 0xc2161c): SportsCoupeRig {
  const object = new THREE.Group();
  object.name = 'rig:sports-coupe';
  const body = new THREE.Group();
  object.add(body);

  const paint = createCarPaintMaterial(color);
  const glass = new THREE.MeshPhysicalNodeMaterial({
    color: 0x293c40, roughness: 0.055, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.025,
    ior: 1.52, transparent: true, opacity: 0.35, depthWrite: false,
  });
  // Tinted laminated glazing transmits the cabin head-on. Reflected sky
  // progressively obscures the seats at glancing angles.
  const glazingCos = dot(normalView, positionViewDirection).abs().clamp(0, 1);
  glass.opacityNode = mix(float(0.28), float(0.94), glazingCos.oneMinus().pow(3));
  const trim = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.52, metalness: 0.22, side: THREE.DoubleSide });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8cdd4, roughness: 0.14, metalness: 0.98 });
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0xcfdff2, roughness: 0.03, metalness: 0.05, clearcoat: 1.0, clearcoatRoughness: 0.02, transparent: true, opacity: 0.34, depthWrite: false,
  });

  const shell = new THREE.Mesh(buildShell(), [paint, glass]);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  const add = (mesh: THREE.Mesh, x: number, y: number, z: number, shadow = false) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    body.add(mesh);
    return mesh;
  };

  // ---- underbody pan & smooth dark wheelhouse tubs ------------------------------------
  add(new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.04, 3.8), trim), 0, 0.175, -0.04);
  for (const axle of [AXLE_FRONT, AXLE_REAR]) {
    for (const s of [-1, 1]) body.add(buildWheelhouseLiner(axle, s, trim));
  }

  // Cabin reference geometry provides parallax through the glass and a closed
  // sill after a pane breaks. The batching pass merges the upholstery and trim.
  const fabric = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.91 });
  // The driver and upholstery share one draw. Bake their linear colours at
  // construction so the driver's silhouette also appears through broken glass.
  function tinted(geometry: THREE.BufferGeometry, shade: number): THREE.Mesh {
    const color = new THREE.Color(shade);
    const count = geometry.getAttribute('position').count;
    const colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    for (let i = 0; i < count; i++) colors.setXYZ(i, color.r, color.g, color.b);
    geometry.setAttribute('color', colors);
    return new THREE.Mesh(geometry, fabric);
  }
  const cushion = (x: number, y: number, z: number, width: number, height: number, depth: number, tilt = 0) => {
    const seat = add(tinted(new RoundedBoxGeometry(width,height,depth,2,0.045), 0x474844),x,y,z);
    seat.rotation.x = tilt;
    return seat;
  };
  for (const side of [-1,1]) {
    const x = side * 0.373;
    cushion(x,0.54,0.13,0.46,0.13,0.48);
    cushion(x,0.76,0.32,0.43,0.43,0.115,0.20);
    cushion(x,1.005,0.375,0.20,0.18,0.135,0.15);
    for (const edge of [-1,1]) cushion(x+edge*0.20,0.73,0.27,0.073,0.32,0.16,0.20);
    add(new THREE.Mesh(new RoundedBoxGeometry(0.095,0.33,1.15,2,0.038),trim),
      side*0.755,0.665,-0.01);
  }
  add(new THREE.Mesh(new RoundedBoxGeometry(1.39,0.17,0.35,2,0.052),trim),0,0.775,-0.56);
  add(new THREE.Mesh(new RoundedBoxGeometry(0.22,0.27,0.75,2,0.048),trim),0,0.52,0.12);
  const helm = add(new THREE.Mesh(new THREE.TorusGeometry(0.151,0.015,6,32),trim),-0.37,0.83,-0.29);
  helm.rotation.x = -0.32;
  add(new THREE.Mesh(new RoundedBoxGeometry(0.2,0.055,0.035,2,0.012),trim),-0.37,0.823,-0.285);
  add(tinted(new RoundedBoxGeometry(1.24,0.18,0.54,2,0.06),0x474844),0,0.68,0.96);
  add(new THREE.Mesh(new RoundedBoxGeometry(0.16,0.048,0.034,2,0.012),trim),0,1.024,-0.48);

  // Reclined driving posture with elbows below the rim and hands at nine
  // and three. Ring contours give the cheek, nose, chin and hairline their
  // own profiles against the windscreen, even when the cabin is in shadow.
  const driverX = -0.373;
  const jacket = 0x425563, skin = 0xb78063;
  const torso = add(tinted(new THREE.SphereGeometry(1,16,12),jacket),driverX,0.791,0.13);
  torso.scale.set(0.168,0.214,0.088);
  torso.rotation.x = 0.32;
  function sleeve(a: THREE.Vector3, b: THREE.Vector3, radius: number, shade: number): void {
    const direction = b.clone().sub(a);
    const span = direction.length();
    const mesh = tinted(new THREE.CapsuleGeometry(radius,Math.max(0.001,span-radius*2),4,12),shade);
    mesh.position.addVectors(a,b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.divideScalar(span));
    body.add(mesh);
  }
  for (const side of [-1,1]) {
    const shoulder = new THREE.Vector3(driverX+side*0.137,0.899,0.159);
    const elbow = new THREE.Vector3(driverX+side*0.187,0.775,-0.032);
    const wrist = new THREE.Vector3(driverX+side*0.137,0.846,-0.249);
    sleeve(shoulder,elbow,0.046,jacket);
    sleeve(elbow,wrist,0.036,jacket);
    const hand = add(tinted(new THREE.SphereGeometry(1,10,8),skin),wrist.x,0.85,-0.276);
    hand.scale.set(0.033,0.035,0.046);
  }
  const headRings = [
    [0.930,0.053,0.051,0.142], [0.967,0.050,0.051,0.144], [0.982,0.058,0.081,0.126],
    [1.007,0.076,0.083,0.135], [1.034,0.083,0.090,0.137], [1.062,0.084,0.092,0.138],
    [1.090,0.083,0.095,0.145], [1.117,0.079,0.092,0.148], [1.142,0.059,0.075,0.150],
    [1.159,0.008,0.012,0.150],
  ];
  const headPos: number[] = [], headColor: number[] = [], headIndices: number[] = [];
  const skinColor = new THREE.Color(skin), hairColor = new THREE.Color(0x322b27);
  const segments = 32;
  for (let row=0; row<headRings.length; row++) {
    const [y,rx,rz,cz] = headRings[row];
    for (let i=0; i<segments; i++) {
      const angle = i * Math.PI*2/segments, front = Math.cos(angle);
      const nose = Math.pow(Math.max(0,front),34) * (row===4 ? 0.029 : row===5 ? 0.012 : 0);
      headPos.push(driverX+rx*Math.sin(angle),y,cz-rz*front-nose);
      const hairLine = 1.036+Math.max(-0.7,front)*0.063;
      const shade = y>hairLine ? hairColor : skinColor;
      headColor.push(shade.r,shade.g,shade.b);
      if (row+1<headRings.length) {
        const a=row*segments+i, b=row*segments+(i+1)%segments;
        headIndices.push(a,a+segments,b,b,a+segments,b+segments);
      }
    }
  }
  const head = new THREE.BufferGeometry();
  head.setAttribute('position',new THREE.Float32BufferAttribute(headPos,3));
  head.setAttribute('color',new THREE.Float32BufferAttribute(headColor,3));
  head.setIndex(headIndices);
  head.computeVertexNormals();
  body.add(new THREE.Mesh(head,fabric));

  // ---- front fascia: contoured splitter, recessed main grille & side brake ducts ------
  // Contoured curved front splitter (no flat plank sticking out)
  const splitterShape = new THREE.Shape();
  splitterShape.moveTo(-0.82, 0.0);
  splitterShape.quadraticCurveTo(-0.78, 0.24, -0.45, 0.30);
  splitterShape.quadraticCurveTo(0, 0.34, 0.45, 0.30);
  splitterShape.quadraticCurveTo(0.78, 0.24, 0.82, 0.0);
  splitterShape.closePath();
  const splitterGeo = new THREE.ExtrudeGeometry(splitterShape, { depth: 0.026, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 2 });
  splitterGeo.rotateX(-Math.PI / 2);
  add(new THREE.Mesh(splitterGeo, trim), 0, 0.165, -HALF + 0.32);

  // Sculpted side air curtains / brake cooling intakes + front splitter winglets
  for (const s of [-1, 1]) {
    const duct = add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.165, 0.12), trim), s * 0.61, 0.305, -HALF + 0.105);
    duct.rotation.y = s * -0.44;
    const fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.014, 0.05), chrome), s * 0.62, 0.305, -HALF + 0.068);
    fin.rotation.y = s * -0.44;
    // Sculpted side rocker skirts with trailing aero winglet ahead of rear arch
    add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.065, 1.78), trim), s * 0.905, 0.185, -0.04);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.18), trim), s * 0.945, 0.21, 0.78);
    // Recessed fender aero vent behind front wheel arch
    const vent = add(new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, 0.22), trim), s * 0.935, 0.44, -0.84);
    vent.rotation.y = s * 0.08;
    // Flush metallic door handles
    add(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.14), chrome), s * 0.92, 0.75, 0.24);
    // Sculpted aerodynamic wing mirrors on angled stalks (no floating boxes!)
    const stalk = add(new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.028, 0.045), trim), s * 0.87, 0.87, -0.60);
    stalk.rotation.z = s * 0.35;
    const capGeo = new THREE.SphereGeometry(0.072, 12, 8);
    capGeo.scale(1.25, 0.62, 0.92);
    const cap = add(new THREE.Mesh(capGeo, trim), s * 0.955, 0.905, -0.60, true);
    cap.rotation.y = s * -0.22;
    // Dual-wall chamfered chrome exhaust tips with dark inner bores
    for (const exOff of [-0.075, 0.075]) {
      const tipX = s * 0.44 + exOff;
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.048, 0.18, 14).rotateX(Math.PI / 2), chrome), tipX, 0.285, HALF - 0.04);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.19, 12).rotateX(Math.PI / 2), trim), tipX, 0.285, HALF - 0.032);
    }
  }

  // ---- rear diffuser with vertical aero strakes + recessed rear fascia ----------------
  add(new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.17, 0.22), trim), 0, 0.28, HALF - 0.12);
  for (const fx of [-0.56, -0.22, 0.22, 0.56]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.15, 0.26), trim), fx, 0.265, HALF - 0.09);
  }
  // Smoked rear light-bar housing + license plate surround
  add(new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.11, 0.06), trim), 0, 0.71, HALF - 0.035);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.15, 0.04), trim), 0, 0.54, HALF - 0.015);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.10, 0.014), chrome), 0, 0.54, HALF + 0.008);

  // ---- sculpted headlamp housings, twin projectors, DRL blades & tail signature -------
  const ledWhite = new THREE.MeshStandardMaterial({ color: 0x202630, emissive: 0xe6f1ff, emissiveIntensity: 0.8, roughness: 0.16 });
  const ledRed = new THREE.MeshStandardMaterial({ color: 0x280202, emissive: 0xff1608, emissiveIntensity: 2.0, roughness: 0.2 });
  const tailLampCenter = new THREE.Vector3(0.54, 0.715, HALF - 0.025);
  const ledAmber = new THREE.MeshStandardMaterial({ color: 0x261402, emissive: 0xff9214, emissiveIntensity: 0.6, roughness: 0.26 });

  for (const s of [-1, 1]) {
    // Sculpted dark headlamp housing contoured flush over the front nose/fender corner (zero paint clipping!)
    const hGroup = new THREE.Group();
    hGroup.position.set(s * 0.585, 0.515, -HALF + 0.135);
    hGroup.rotation.set(0.22, s * -0.46, s * 0.08);
    const addH = (m: THREE.Mesh, x: number, y: number, z: number) => { m.position.set(x, y, z); hGroup.add(m); return m; };
    // Dark recessed optical housing bucket + thin gloss surround
    addH(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.115, 0.14), trim), 0, 0, 0.04);
    addH(new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.016, 0.04), chrome), 0, -0.052, -0.025);
    // Twin circular LED projector optics + chrome shroud rings inside the dark housing
    for (const pOff of [-0.09, 0.06]) {
      addH(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.04, 16).rotateX(Math.PI / 2), ledWhite), s * pOff, 0.008, -0.022);
      addH(new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.006, 8, 18), chrome), s * pOff, 0.008, -0.042);
    }
    // Swept LED daytime-running light blade hugging the lower & outer corner
    addH(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.017, 0.026), ledWhite), 0, -0.038, -0.036);
    const outerHook = addH(new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.085, 0.026), ledWhite), s * 0.185, 0.002, -0.034);
    outerHook.rotation.z = s * -0.22;
    // Amber corner turn-signal accent
    addH(new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.024, 0.028), ledAmber), s * 0.215, 0.015, -0.015);
    // Flush clear polycarbonate cover lens sealing the whole headlamp assembly
    addH(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.125, 0.018), lensMat), 0, 0, -0.052);
    body.add(hGroup);

    // Outer sculpted wrap-around tail lamp elements
    const lamp = add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.048, 0.036), ledRed), s * tailLampCenter.x, tailLampCenter.y, tailLampCenter.z);
    lamp.rotation.y = s * 0.36;
  }
  // Full-width HDR LED tail bar + subtle lower signature bar
  add(new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.026, 0.028), ledRed), 0, 0.72, HALF - 0.004);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.012, 0.024), ledRed), 0, 0.688, HALF - 0.004);

  const headlight = new THREE.SpotLight(0xeef5ff, 0, 90, 0.52, 0.55, 1.25);
  headlight.position.set(0, 0.56, -HALF + 0.08);
  headlight.target.position.set(0, 0.04, -24);
  body.add(headlight, headlight.target);

  // ---- wheels (with shared materials + speed-aware motion blur) -----------------------
  const alloy = new THREE.MeshStandardMaterial({ color: 0xadb4bc, roughness: 0.22, metalness: 0.94, vertexColors: true });
  const caliper = new THREE.MeshStandardMaterial({ color: 0xd4a408, roughness: 0.32, metalness: 0.45 });
  const hardPoints = [
    new THREE.Vector3(-TRACK, WHEEL_RADIUS, AXLE_FRONT), new THREE.Vector3(TRACK, WHEEL_RADIUS, AXLE_FRONT),
    new THREE.Vector3(-TRACK, WHEEL_RADIUS, AXLE_REAR), new THREE.Vector3(TRACK, WHEEL_RADIUS, AXLE_REAR),
  ];
  const wheelVisuals = hardPoints.map((p, i) => {
    const wv = buildWheel(i < 2 ? 0.25 : 0.29, alloy, caliper, p.x < 0 ? -1 : 1);
    wv.pivot.position.copy(p);
    object.add(wv.pivot);
    return wv;
  });
  const wheels = wheelVisuals.map((w) => w.pivot);

  // Collapse all static body trim, liners, exhausts, housings and LEDs to 1 mesh per material.
  mergeStaticMeshes(body, [shell, headlight, headlight.target]);

  const crumpleAttachments: THREE.Mesh[] = [];
  body.traverse(child => {
    if (child instanceof THREE.Mesh && child !== shell && child.material !== fabric)
      crumpleAttachments.push(child);
  });

  let brakeGlow = 0;
  return {
    object, body, shell, crumpleAttachments, wheels, wheelRadius: WHEEL_RADIUS, hardPoints,
    halfExtents: new THREE.Vector3(0.9, 0.34, 2.15),
    mass: 1420,
    wheelbase: AXLE_REAR - AXLE_FRONT,
    rearBumper: new THREE.Vector3(0, 0.45, HALF),
    get brakeGlow() { return brakeGlow; },
    rearLampCenters(left, right) {
      left.copy(tailLampCenter);
      left.x = -left.x;
      body.localToWorld(left);
      body.localToWorld(right.copy(tailLampCenter));
    },
    setBrake(amount) {
      brakeGlow = clamp(amount, 0, 1);
      ledRed.emissiveIntensity = 2.0 + brakeGlow * 24;
    },
    setHeadlights(on, intensityScale=1) {
      ledWhite.emissiveIntensity = on ? 22 : 0.8;
      ledAmber.emissiveIntensity = on ? 1.8 : 0.6;
      headlight.intensity = on ? 1250 * clamp(intensityScale,0,1) : 0;
    },
    setWheelSpeed(index, omega) {
      const wv = wheelVisuals[index];
      if (!wv) return;
      const speed = Math.abs(omega);
      // Smoothly transition from crisp 3D Y-spokes to radial motion-blurred spinning spokes
      const blur = ss(speed, 14, 54);
      wv.uBlur.value = blur;
      wv.shutterArc.value = speed/160;
      wv.spokeMaterial.opacity = 1 - blur * 0.94;
      wv.spokes.visible = blur < 0.95;
      wv.blurDisc.visible = blur > 0.04;
    },
  };
}
