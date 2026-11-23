import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { surfaceWetnessNode } from '../../engine/world-bus';

/**
 * Procedural clothed rescue swimmer, built once on load as a single skinned surface whose
 * bones are the ragdoll's own rigid segments. A continuous skin replaces 35 separate
 * rigid shells: sleeves, hips and neck stay closed when joints bend, and the whole
 * worker is one draw (plus its shadow) instead of 35.
 *
 * Dimensions follow an adult male of ~1.80 m stature in a drysuit; the arm and leg axes
 * are fixed by the ragdoll's joint anchors, so girths are fitted around them.
 * Garments: dark drysuit with taped seams, knee and elbow reinforcement and latex wrist
 * and neck seals; a high-visibility flotation vest with quilted foam channels, centre
 * zip, reflective band, waist webbing and buckle, shoulder straps and a flotation
 * collar; a white water helmet with peak, vents and chin strap; neoprene gloves; boots
 * with a contrasting sole. Ambient occlusion is baked per vertex on load; wetness comes
 * from the world surface field and from each segment's measured immersion.
 */

// Bone order matches ActiveRagdoll.limbs: pelvis, torso, head, then per side (-1, +1)
// thigh, shin, foot, upper arm, forearm/hand.
export const BONE = { pelvis: 0, torso: 1, head: 2 } as const;
const limbBone = (side: number, k: 0 | 1 | 2 | 3 | 4) => 3 + (side < 0 ? 0 : 5) + k;
export const SWIMMER_BONES = 13;

interface Surface { color: number; rough: number; absorb: number; weave: number }
const S: Record<string, Surface> = {
  suit: { color: 0x1d262e, rough: 0.78, absorb: 0.38, weave: 1 },
  seam: { color: 0x2f3b46, rough: 0.55, absorb: 0.2, weave: 0 },
  pad: { color: 0x2b2e31, rough: 0.9, absorb: 0.25, weave: 0.5 },
  latex: { color: 0x1b1a19, rough: 0.42, absorb: 0.04, weave: 0 },
  pfd: { color: 0xd24a1b, rough: 0.72, absorb: 0.32, weave: 1 },
  pfdSide: { color: 0x2b2c2e, rough: 0.74, absorb: 0.3, weave: 0.7 },
  channel: { color: 0x9e3714, rough: 0.66, absorb: 0.3, weave: 0.6 },
  zip: { color: 0x101112, rough: 0.5, absorb: 0.05, weave: 0 },
  webbing: { color: 0x151719, rough: 0.8, absorb: 0.3, weave: 1 },
  buckle: { color: 0x3c3f43, rough: 0.38, absorb: 0.02, weave: 0 },
  tape: { color: 0xb6bab5, rough: 0.3, absorb: 0.04, weave: 0 },
  helmet: { color: 0xd9d7d0, rough: 0.34, absorb: 0.03, weave: 0 },
  vent: { color: 0x1c1d1f, rough: 0.6, absorb: 0.05, weave: 0 },
  skin: { color: 0xa86e50, rough: 0.55, absorb: 0.08, weave: 0 },
  socket: { color: 0x4a2d21, rough: 0.45, absorb: 0.05, weave: 0 },
  lip: { color: 0x8a4a3c, rough: 0.45, absorb: 0.05, weave: 0 },
  brow: { color: 0x3a2a20, rough: 0.7, absorb: 0.1, weave: 0 },
  glove: { color: 0x17191b, rough: 0.6, absorb: 0.12, weave: 0.3 },
  boot: { color: 0x1c1e20, rough: 0.55, absorb: 0.1, weave: 0 },
  sole: { color: 0x45433f, rough: 0.88, absorb: 0.15, weave: 0 },
};

const _mix = new THREE.Color(), _to = new THREE.Color();
/** Blend two surfaces (soft facial features instead of per-vertex steps). */
const blend = (a: Surface, b: Surface, t: number): Surface => t <= 0.01 ? a : t >= 0.99 ? b : ({
  color: _mix.set(a.color).lerp(_to.set(b.color), t).getHex(),
  rough: a.rough + (b.rough - a.rough) * t, absorb: a.absorb + (b.absorb - a.absorb) * t, weave: a.weave + (b.weave - a.weave) * t,
});

/** Two-bone skin weight: `t` is the share of bone `b`. */
interface W { a: number; b: number; t: number }
const one = (a: number): W => ({ a, b: a, t: 0 });
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Blend from `below` to `above` across a joint at height `y0`. */
const across = (y: number, y0: number, zone: number, below: number, above: number): W =>
  ({ a: below, b: above, t: smooth(y0 - zone, y0 + zone, y) });

const FRONT = -Math.PI / 2; // −z faces forward
const angleTo = (theta: number, target: number) => Math.abs(Math.atan2(Math.sin(theta - target), Math.cos(theta - target)));

interface RingSpec {
  c: THREE.Vector3;
  hw: number;
  hd: number;
  w: W;
  /** Surface by ring angle. */
  surface: (theta: number) => Surface;
  /** Relative radial offset by angle (features, quilting, pads). */
  push?: (theta: number) => number;
  /** Vertical offset by angle (helmet rim, hems). */
  lift?: (theta: number) => number;
}

class Builder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly surface: number[] = [];
  readonly skinIndex: number[] = [];
  readonly skinWeight: number[] = [];
  readonly index: number[] = [];
  private readonly c = new THREE.Color();
  get count(): number { return this.position.length / 3; }

  vertex(p: THREE.Vector3, s: Surface, w: W, shade = 1): number {
    this.position.push(p.x, p.y, p.z);
    this.c.set(s.color).multiplyScalar(shade);
    this.color.push(this.c.r, this.c.g, this.c.b);
    const slot = w.t < 0.5 ? w.a : w.b;
    this.surface.push(s.rough, s.absorb, s.weave, slot);
    this.skinIndex.push(w.a, w.b, 0, 0);
    this.skinWeight.push(1 - w.t, w.t, 0, 0);
    return this.count - 1;
  }

  /** Sweep elliptical rings along their centres; frames follow the path tangent. */
  sweep(rings: RingSpec[], sides: number, hint: THREE.Vector3, caps: [boolean, boolean] = [true, true]): void {
    const first = this.count, start = this.index.length;
    const tangent = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), p = new THREE.Vector3();
    for (let j = 0; j < rings.length; j++) {
      const r = rings[j];
      tangent.subVectors(rings[Math.min(j + 1, rings.length - 1)].c, rings[Math.max(j - 1, 0)].c).normalize();
      u.crossVectors(tangent, hint).normalize();
      v.crossVectors(u, tangent).normalize();
      for (let i = 0; i < sides; i++) {
        const theta = (i / sides) * Math.PI * 2;
        const k = 1 + (r.push ? r.push(theta) : 0);
        p.copy(r.c).addScaledVector(u, Math.cos(theta) * r.hw * k).addScaledVector(v, Math.sin(theta) * r.hd * k);
        if (r.lift) p.addScaledVector(tangent, r.lift(theta));
        this.vertex(p, r.surface(theta), r.w);
        if (j === 0) continue;
        const a = first + (j - 1) * sides + i, b = first + (j - 1) * sides + ((i + 1) % sides);
        this.index.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
    const capAt = (j: number, flip: boolean) => {
      const r = rings[j], centre = this.vertex(r.c, r.surface(FRONT), r.w), base = first + j * sides;
      for (let i = 0; i < sides; i++) {
        const a = base + i, b = base + ((i + 1) % sides);
        if (flip) this.index.push(centre, b, a); else this.index.push(centre, a, b);
      }
    };
    if (caps[0]) capAt(0, false);
    if (caps[1]) capAt(rings.length - 1, true);
    // Orient outward: compare the first quad's normal with its radial direction.
    const pa = new THREE.Vector3().fromArray(this.position, (first) * 3);
    const pb = new THREE.Vector3().fromArray(this.position, (first + sides) * 3);
    const pc = new THREE.Vector3().fromArray(this.position, (first + 1) * 3);
    const n = new THREE.Vector3().crossVectors(pb.sub(pa), pc.sub(pa));
    const radial = pa.clone().sub(rings[0].c);
    if (n.dot(radial) < 0) for (let i = start; i < this.index.length; i += 3) {
      const t = this.index[i + 1]; this.index[i + 1] = this.index[i + 2]; this.index[i + 2] = t;
    }
  }
}

// --------------------------------------------------------------------------------------
// Anatomy (rest pose: standing, arms at sides; y up, −z forward, metres above origin)
// --------------------------------------------------------------------------------------

/** Trunk cross-sections [y, half-width, half-depth, forward offset] over the drysuit. */
const TRUNK: readonly (readonly [number, number, number, number])[] = [
  [0.795, 0.06, 0.05, 0.004], [0.81, 0.11, 0.08, 0.004], [0.84, 0.14, 0.096, 0.004], [0.89, 0.159, 0.105, 0.002],
  [0.95, 0.168, 0.11, 0], [1.02, 0.162, 0.106, 0], [1.1, 0.148, 0.098, -0.002], [1.18, 0.152, 0.103, -0.004],
  [1.26, 0.165, 0.11, -0.006], [1.33, 0.176, 0.117, -0.008], [1.4, 0.182, 0.112, -0.004], [1.45, 0.18, 0.1, 0.002],
  [1.48, 0.158, 0.088, 0.006], [1.505, 0.12, 0.076, 0.008], [1.54, 0.072, 0.066, 0.008], [1.57, 0.058, 0.058, 0.008], [1.605, 0.052, 0.054, 0.008],
];
function trunkAt(y: number): [number, number, number] {
  for (let i = 1; i < TRUNK.length; i++) if (y <= TRUNK[i][0]) {
    const a = TRUNK[i - 1], b = TRUNK[i], t = (y - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
  const l = TRUNK[TRUNK.length - 1];
  return [l[1], l[2], l[3]];
}
const trunkWeights = (y: number): W => y < 1.4 ? across(y, 1.14, 0.07, BONE.pelvis, BONE.torso) : across(y, 1.565, 0.03, BONE.torso, BONE.head);

function trunk(b: Builder): void {
  const rings: RingSpec[] = TRUNK.map(([y, hw, hd, cz]) => ({
    c: new THREE.Vector3(0, y, cz), hw, hd, w: trunkWeights(y),
    surface: (theta) => y >= 1.535 ? S.latex : Math.abs(y - 1.1) < 0.008 ? S.seam
      : angleTo(theta, 0) < 0.05 || angleTo(theta, Math.PI) < 0.05 ? S.seam : S.suit,
  }));
  b.sweep(rings, 24, new THREE.Vector3(0, 0, 1));
}

function leg(b: Builder, side: number): void {
  const x0 = side * 0.104, outer = side > 0 ? 0 : Math.PI;
  const table: [number, number, number, number, number][] = [
    // y, hw, hd, cz, x inset
    [0.99, 0.074, 0.082, 0, 0.006], [0.93, 0.08, 0.088, 0, 0.006], [0.84, 0.077, 0.083, -0.005, 0.006], [0.72, 0.071, 0.074, -0.004, 0.004],
    [0.62, 0.059, 0.063, -0.002, 0.006], [0.555, 0.053, 0.057, 0, 0.007], [0.5, 0.052, 0.058, 0.004, 0.007],
    [0.43, 0.055, 0.061, 0.012, 0.006], [0.36, 0.051, 0.056, 0.011, 0.005], [0.29, 0.044, 0.047, 0.007, 0.004],
    [0.22, 0.038, 0.04, 0.004, 0.003], [0.17, 0.035, 0.037, 0.002, 0.002],
  ];
  const rings = table.map(([y, hw, hd, cz, inset]) => {
    const w = y > 0.8 ? across(y, 0.937, 0.05, BONE.pelvis, limbBone(side, 0)) : across(y, 0.53, 0.05, limbBone(side, 1), limbBone(side, 0));
    const pad = y > 0.47 && y < 0.62;
    return {
      c: new THREE.Vector3(x0 - side * inset, y, cz), hw, hd, w,
      surface: (theta: number) => pad && angleTo(theta, FRONT) < 0.95 ? S.pad : angleTo(theta, outer) < 0.06 ? S.seam : S.suit,
      push: (theta: number) => pad ? 0.1 * Math.max(0, Math.cos(angleTo(theta, FRONT))) ** 2 : 0,
    } satisfies RingSpec;
  });
  b.sweep(rings, 16, new THREE.Vector3(0, 0, 1));
}

function boot(b: Builder, side: number): void {
  const x0 = side * 0.104;
  const shaft: RingSpec[] = [[0.32, 0.055, 0.058, 0.007], [0.27, 0.05, 0.053, 0.005], [0.2, 0.046, 0.05, 0.002], [0.14, 0.047, 0.056, -0.004]]
    .map(([y, hw, hd, cz]) => ({
      c: new THREE.Vector3(x0, y, cz), hw, hd, w: across(y, 0.15, 0.04, limbBone(side, 2), limbBone(side, 1)),
      surface: () => (y > 0.31 ? S.sole : S.boot), push: () => (y > 0.31 ? -0.02 : 0),
    }));
  b.sweep(shaft, 14, new THREE.Vector3(0, 0, 1), [false, false]);
  // Foot from heel to toe along −z; the sole wraps the bottom of every ring.
  const foot: [number, number, number, number][] = [
    [0.07, 0.072, 0.03, 0.04], [0.05, 0.075, 0.042, 0.05], [0.0, 0.074, 0.047, 0.049], [-0.06, 0.064, 0.051, 0.039],
    [-0.12, 0.054, 0.052, 0.029], [-0.17, 0.048, 0.047, 0.023], [-0.2, 0.046, 0.036, 0.019], [-0.212, 0.046, 0.02, 0.012],
  ];
  const rings: RingSpec[] = foot.map(([z, yc, hw, hh]) => ({
    c: new THREE.Vector3(x0 + side * 0.006 * Math.max(0, -z) / 0.2, yc, z), hw, hd: hh, w: one(limbBone(side, 2)),
    surface: (theta) => Math.sin(theta) < -0.55 ? S.sole : S.boot,
  }));
  b.sweep(rings, 14, new THREE.Vector3(0, 1, 0));
}

function arm(b: Builder, side: number): void {
  const x0 = side * 0.225;
  const table: [number, number, number, number, number][] = [
    [1.505, 0.022, 0.026, 0.004, -0.03], [1.49, 0.04, 0.046, 0.004, -0.024], [1.46, 0.052, 0.058, 0.002, -0.014], [1.41, 0.053, 0.056, 0, -0.004],
    [1.33, 0.048, 0.052, 0, 0], [1.26, 0.045, 0.047, 0.002, 0.004], [1.2, 0.043, 0.046, 0.002, 0.005], [1.14, 0.045, 0.044, -0.004, 0.007],
    [1.07, 0.042, 0.039, -0.008, 0.009], [1.0, 0.034, 0.03, -0.01, 0.01], [0.965, 0.03, 0.026, -0.01, 0.01],
  ];
  const back = Math.PI / 2;
  const rings = table.map(([y, hw, hd, cz, out]) => {
    const w = y > 1.36 ? across(y, 1.48, 0.05, limbBone(side, 3), BONE.torso) : across(y, 1.198, 0.045, limbBone(side, 4), limbBone(side, 3));
    const pad = y > 1.15 && y < 1.25;
    return {
      c: new THREE.Vector3(x0 + side * out, y, cz), hw, hd, w,
      surface: (theta: number) => y < 0.99 ? S.latex : pad && angleTo(theta, back) < 1.0 ? S.pad : Math.abs(y - 1.43) < 0.006 ? S.seam : S.suit,
      push: (theta: number) => pad ? 0.09 * Math.max(0, Math.cos(angleTo(theta, back))) ** 2 : 0,
    } satisfies RingSpec;
  });
  b.sweep(rings, 16, new THREE.Vector3(0, 0, 1));
}

function glove(b: Builder, side: number): void {
  const x0 = side * 0.235, w = one(limbBone(side, 4));
  // Hanging hand: palm faces the thigh, so the hand is wide front-to-back (z).
  const table: [number, number, number, number][] = [
    [0.975, 0.033, 0.032, -0.01], [0.94, 0.03, 0.033, -0.01], [0.905, 0.022, 0.041, -0.012], [0.87, 0.019, 0.044, -0.013],
    [0.835, 0.017, 0.042, -0.013], [0.8, 0.015, 0.037, -0.012], [0.775, 0.012, 0.029, -0.011], [0.765, 0.007, 0.016, -0.01],
  ];
  b.sweep(table.map(([y, hw, hd, cz]) => ({ c: new THREE.Vector3(x0, y, cz), hw, hd, w, surface: () => (y > 0.955 ? S.latex : S.glove) })),
    12, new THREE.Vector3(0, 0, 1));
  const thumb = [[0.9, -0.045], [0.872, -0.058], [0.85, -0.064], [0.838, -0.065]].map(([y, z], k) => ({
    c: new THREE.Vector3(x0 - side * 0.006, y, z), hw: 0.012 - k * 0.001, hd: 0.011 - k * 0.001, w, surface: () => S.glove,
  }));
  b.sweep(thumb, 8, new THREE.Vector3(1, 0, 0));
}

function head(b: Builder): void {
  // Soft-edged features: weights fall off over a few vertices rather than switching.
  const eyes = (theta: number, y: number) => Math.exp(-(((angleTo(theta, FRONT) - 0.38) / 0.17) ** 2) - ((y - 1.701) / 0.0085) ** 2);
  const brows = (theta: number, y: number) => Math.exp(-(((angleTo(theta, FRONT) - 0.38) / 0.2) ** 2) - ((y - 1.716) / 0.004) ** 2);
  const lips = (theta: number, y: number) => Math.exp(-((angleTo(theta, FRONT) / 0.24) ** 2) - ((y - 1.632) / 0.006) ** 2);
  const rows: [number, number, number, number][] = [
    [1.53, 0.054, 0.056, 0.01], [1.57, 0.05, 0.053, 0.012], [1.595, 0.053, 0.058, 0.006], [1.61, 0.06, 0.07, 0],
    [1.625, 0.065, 0.08, -0.006], [1.64, 0.068, 0.085, -0.006], [1.655, 0.07, 0.088, -0.005], [1.67, 0.072, 0.091, -0.004],
    [1.685, 0.074, 0.094, -0.003], [1.693, 0.075, 0.095, -0.002], [1.701, 0.076, 0.096, -0.002], [1.709, 0.0765, 0.0965, -0.001], [1.716, 0.077, 0.097, -0.001], [1.73, 0.077, 0.097, 0],
    [1.75, 0.077, 0.096, 0.002], [1.775, 0.073, 0.09, 0.003], [1.8, 0.062, 0.076, 0.004], [1.82, 0.044, 0.055, 0.004], [1.833, 0.02, 0.025, 0.004],
  ];
  const rings: RingSpec[] = rows.map(([y, hw, hd, cz]) => ({
    c: new THREE.Vector3(0, y, cz), hw, hd, w: y < 1.6 ? across(y, 1.565, 0.03, BONE.torso, BONE.head) : one(BONE.head),
    surface: (theta) => {
      if (y < 1.595) return S.latex;
      return blend(blend(blend(S.skin, S.lip, lips(theta, y)), S.brow, brows(theta, y)), S.socket, eyes(theta, y));
    },
    push: (theta) => {
      const f = angleTo(theta, FRONT);
      const nose = Math.exp(-((f / 0.15) ** 2)) * smooth(1.648, 1.662, y) * (1 - smooth(1.705, 1.72, y)) * 0.27;
      const brow = Math.exp(-((f / 0.6) ** 2)) * Math.exp(-(((y - 1.722) / 0.008) ** 2)) * 0.05;
      const chin = Math.exp(-((f / 0.4) ** 2)) * Math.exp(-(((y - 1.603) / 0.012) ** 2)) * 0.09;
      const socket = Math.exp(-(((f - 0.4) / 0.16) ** 2)) * Math.exp(-(((y - 1.7) / 0.01) ** 2)) * 0.045;
      const ear = (Math.exp(-((angleTo(theta, 0) / 0.22) ** 2)) + Math.exp(-((angleTo(theta, Math.PI) / 0.22) ** 2)))
        * Math.exp(-(((y - 1.685) / 0.02) ** 2)) * 0.12;
      return nose + brow + chin + ear - socket;
    },
  }));
  b.sweep(rings, 36, new THREE.Vector3(0, 0, 1));
}

function helmet(b: Builder): void {
  const w = one(BONE.head);
  // Shell rides ~2 cm over the skull. The rim sits mid-forehead (≈4 cm above the eyes)
  // and drops behind the ears to cover the occiput.
  const rows: [number, number, number, number][] = [
    [1.728, 0.1, 0.123, 0.008], [1.745, 0.101, 0.124, 0.006], [1.768, 0.1, 0.121, 0.005], [1.79, 0.092, 0.11, 0.005],
    [1.815, 0.077, 0.092, 0.005], [1.837, 0.053, 0.064, 0.005], [1.85, 0.028, 0.034, 0.005], [1.855, 0.008, 0.01, 0.005],
  ];
  const vent = (theta: number, y: number) => y > 1.79 && y < 1.83 &&
    [FRONT + 0.55, FRONT - 0.55, Math.PI / 2 + 0.5, Math.PI / 2 - 0.5].some((a) => angleTo(theta, a) < 0.09);
  b.sweep(rows.map(([y, hw, hd, cz], j) => ({
    c: new THREE.Vector3(0, y, cz), hw, hd, w,
    surface: (theta: number) => (vent(theta, y) ? S.vent : S.helmet),
    lift: j === 0 ? (theta: number) => 0.018 * Math.max(0, -Math.sin(theta)) ** 2 - 0.065 * Math.max(0, Math.sin(theta)) ** 1.5 : undefined,
  })), 32, new THREE.Vector3(0, 0, 1), [false, true]);
  // Peak over the brow: a flattened band swept along the front of the rim.
  const peak: RingSpec[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = FRONT - 0.95 + (1.9 * k) / 8, r = 1 - 0.25 * Math.abs(k - 4) / 4;
    peak.push({ c: new THREE.Vector3(Math.cos(a) * 0.106, 1.744 - 0.006 * (1 - r), 0.008 + Math.sin(a) * 0.127), hw: 0.019 * r + 0.006, hd: 0.0065, w, surface: () => S.helmet });
  }
  b.sweep(peak, 8, new THREE.Vector3(0, 1, 0));
  // Chin strap from each side of the rim, under the chin.
  const strap: RingSpec[] = [[-0.1, 1.715, -0.012], [-0.088, 1.65, -0.03], [-0.055, 1.6, -0.055], [0, 1.585, -0.062], [0.055, 1.6, -0.055], [0.088, 1.65, -0.03], [0.1, 1.715, -0.012]]
    .map(([x, y, z]) => ({ c: new THREE.Vector3(x, y, z), hw: 0.008, hd: 0.0035, w, surface: () => S.webbing }));
  b.sweep(strap, 6, new THREE.Vector3(0, 0, 1));
}

function vest(b: Builder): void {
  const thickness = (theta: number) => {
    const s = Math.sin(theta);
    return 0.02 + 0.023 * Math.max(0, -s) ** 0.8 + 0.013 * Math.max(0, s) ** 0.8; // front 4.3 cm, back 3.3, sides 2
  };
  const channels = [1.17, 1.255, 1.335];
  const rows: number[] = [];
  for (let y = 1.07; y <= 1.405; y += 0.018) rows.push(y);
  const rings: RingSpec[] = rows.map((y, j) => {
    const [hw, hd, cz] = trunkAt(y);
    const edge = Math.min(j, rows.length - 1 - j);
    const hem = edge === 0 ? 0.25 : edge === 1 ? 0.75 : 1;
    const quilt = channels.some((c) => Math.abs(y - c) < 0.009);
    return {
      c: new THREE.Vector3(0, y, cz), hw, hd, w: trunkWeights(y),
      // Expand each ring by the foam thickness along its own radius.
      push: (theta: number) => {
        const r = Math.hypot(Math.cos(theta) * hw, Math.sin(theta) * hd);
        const front = Math.max(0, -Math.sin(theta));
        return (thickness(theta) * hem * (quilt ? 0.82 * front + (1 - front) : 1)
          + (Math.abs(y - 1.118) < 0.012 ? 0.006 : 0) - (angleTo(theta, FRONT) < 0.035 ? 0.006 : 0)) / r;
      },
      surface: (theta: number) => {
        if (Math.abs(y - 1.118) < 0.012) return S.webbing;
        if (angleTo(theta, FRONT) < 0.035) return S.zip;
        if (Math.abs(y - 1.216) < 0.011) return S.tape;
        if (Math.abs(Math.cos(theta)) > 0.86) return S.pfdSide;
        return quilt ? S.channel : S.pfd;
      },
    } satisfies RingSpec;
  });
  b.sweep(rings, 28, new THREE.Vector3(0, 0, 1));
  const w = one(BONE.torso);
  // Buckle and chest pocket: short rectangular sweeps on the front foam.
  const surfaceZ = (y: number) => { const [, hd, cz] = trunkAt(y); return cz - hd - 0.043; };
  b.sweep([-0.026, 0.026].map((x) => ({ c: new THREE.Vector3(x, 1.118, surfaceZ(1.118) - 0.009), hw: 0.008, hd: 0.017, w, surface: () => S.buckle })),
    4, new THREE.Vector3(0, 0, 1));
  b.sweep([-0.115, -0.05].map((x) => ({ c: new THREE.Vector3(x, 1.3, surfaceZ(1.3) - 0.008), hw: 0.01, hd: 0.035, w, surface: () => S.pfd })),
    4, new THREE.Vector3(0, 0, 1));
  // Shoulder straps over each shoulder, front to back, with a reflective tab in front.
  for (const side of [-1, 1]) {
    const path: [number, number, number][] = [[0.098, 1.39, -0.165], [0.1, 1.45, -0.135], [0.104, 1.505, -0.07], [0.106, 1.53, 0.0],
      [0.104, 1.505, 0.07], [0.1, 1.45, 0.12], [0.098, 1.39, 0.15]];
    b.sweep(path.map(([x, y, z], k) => ({
      c: new THREE.Vector3(side * x, y, z), hw: 0.032, hd: 0.013, w: trunkWeights(Math.min(y, 1.5)),
      surface: () => (k === 1 ? S.tape : S.pfd),
    })), 8, new THREE.Vector3(0, 1, 0));
  }
  // Flotation collar behind the neck, between the straps.
  const collar: RingSpec[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = Math.PI * (k / 8);
    collar.push({ c: new THREE.Vector3(-Math.cos(a) * 0.1, 1.55 + 0.02 * Math.sin(a), 0.01 + Math.sin(a) * 0.075), hw: 0.034, hd: 0.03, w: one(BONE.torso), surface: () => S.pfd });
  }
  b.sweep(collar, 10, new THREE.Vector3(0, 0, 1));
}

/** Ambient exposure: occlusion from nearby surfaces in the hemisphere above each vertex
 * (armpits, crotch, under the helmet rim and collar, eye sockets). Baked once on load. */
function bakeOcclusion(position: Float32Array, normal: Float32Array): Float32Array {
  const n = position.length / 3, ao = new Float32Array(n).fill(1);
  const stride = 3, reach = 0.13, cell = reach;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i += stride) {
    const k = key(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
    let list = grid.get(k); if (!list) grid.set(k, (list = [])); list.push(i);
  }
  for (let i = 0; i < n; i++) {
    const px = position[i * 3], py = position[i * 3 + 1], pz = position[i * 3 + 2];
    const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let occ = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const j of list) {
        const ox = position[j * 3] - px, oy = position[j * 3 + 1] - py, oz = position[j * 3 + 2] - pz;
        const d = Math.hypot(ox, oy, oz);
        if (d < 0.012 || d > reach) continue;
        const facing = (ox * nx + oy * ny + oz * nz) / d;
        // Only surfaces that face back toward this vertex shadow its sky.
        const back = -(ox * normal[j * 3] + oy * normal[j * 3 + 1] + oz * normal[j * 3 + 2]) / d;
        if (facing > 0.15 && back > 0) occ += facing * back * (1 - d / reach) ** 2;
      }
    }
    ao[i] = 1 - Math.min(0.6, occ * 0.32);
  }
  return ao;
}

/** Build the clothed swimmer in rest pose, relative to the ragdoll origin. */
export function buildSwimmerGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  trunk(b);
  vest(b);
  head(b);
  helmet(b);
  for (const side of [-1, 1]) {
    leg(b, side);
    boot(b, side);
    arm(b, side);
    glove(b, side);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(b.color, 3));
  geometry.setAttribute('luminaSurface', new THREE.Float32BufferAttribute(b.surface, 4));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(b.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(b.skinWeight, 4));
  geometry.setIndex(b.count > 65535 ? new THREE.Uint32BufferAttribute(b.index, 1) : new THREE.Uint16BufferAttribute(b.index, 1));
  geometry.computeVertexNormals();
  const ao = bakeOcclusion(geometry.getAttribute('position').array as Float32Array, geometry.getAttribute('normal').array as Float32Array);
  geometry.setAttribute('luminaAO', new THREE.Float32BufferAttribute(ao, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** One material for every garment: per-vertex albedo, roughness, wet absorption and
 * weave strength; baked occlusion on indirect light; wetness from the world surface
 * field and from each segment's immersion (`wetness`, one value per bone). */
export function swimmerMaterial(wetness: N): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  // Wetness is composed here; skip the engine's generic wet-film adaptation.
  material.userData.luminaWorldSurface = true;
  const surface = TSL.attribute('luminaSurface', 'vec4');
  const slot = surface.w.toVarying('swimmerSlot');
  const wet = surfaceWetnessNode(TSL.positionWorld).max(wetness.element(slot.add(0.5).toInt())).clamp(0, 1);
  // Unresolved weave averages to the base colour instead of shimmering.
  const coord = TSL.positionGeometry;
  const u = coord.x.add(coord.z.mul(0.62)).mul(4400), v = coord.y.mul(3700);
  const resolved = TSL.smoothstep(4, 0.7, TSL.fwidth(u).max(TSL.fwidth(v)));
  const thread = u.sin().mul(v.sin()).mul(resolved).mul(surface.z);
  // Water fills fabric pores: darker, glossier; rubber, latex and plastic barely darken.
  material.colorNode = TSL.vec3(thread.mul(0.045).add(1).mul(TSL.float(1).sub(wet.mul(surface.y))));
  const dry = surface.x.add(thread.mul(0.06));
  material.roughnessNode = TSL.mix(dry, dry.mul(0.42).add(0.07), wet);
  material.aoNode = TSL.attribute('luminaAO', 'float');
  return material;
}
