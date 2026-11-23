import * as THREE from 'three/webgpu';
import { TSL as t, type N } from './tsl';

const LIMIT = 8,
  GRID = 24,
  CELLS = GRID * GRID;
const DROP_SPEED = 9.5,
  WIND_DRIFT = 0.85;
const clamp = THREE.MathUtils.clamp;

export interface RainShelterOptions {
  /** World centre of the underside, horizontal dimensions in metres, Three.js Y rotation in radians. */
  center: THREE.Vector3;
  width: number;
  depth: number;
  yaw?: number;
  /** Elevation of the pavement that retains a drying/wetting history. */
  groundY: number;
  /** Starting film under a vertical rain shadow. Set to 1 for a roof erected over wet ground. */
  initialWetness?: number;
  /** Matte underside reflectance, used for off-screen rays without captured geometry. */
  underside?: THREE.ColorRepresentation;
  /** Width of the simulated apron around the roof. Increase for strong crosswinds. */
  apronM?: number;
}

interface Roof {
  x: number;
  y: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  ground: number;
  margin: number;
  color: THREE.Color;
  film: Float32Array;
}

/** Registered horizontal roofs shared by gameplay, rain, lighting and water reflections. */
export class RainShelters {
  private roofs: Roof[] = [];
  private readonly rows = t.buffer(new Float32Array(LIMIT * 12), 'vec4', LIMIT * 3).setGroup(t.renderGroup);
  private readonly countNode = t.uniform(0, 'int').setGroup(t.renderGroup);
  private readonly direction = t.uniform(new THREE.Vector3(0, 1, 0)).setGroup(t.renderGroup);
  // Sixteen normalized film samples fit one aligned uvec4 on both backends.
  // A render-group buffer stays current on a stationary PBR draw, even when a
  // roof is first registered after the material has already been compiled.
  private readonly filmWords = new Uint32Array((CELLS * LIMIT) / 4);
  private readonly filmBuffer = t.buffer(this.filmWords, 'uvec4', (CELLS * LIMIT) / 16).setGroup(t.renderGroup);
  private revision = 0;
  private filmRevision = 0;
  private elapsed = 0;
  get count(): number {
    return this.roofs.length;
  }

  private writeFilm(index: number, wet: number): boolean {
    const k = index >>> 2,
      shift = (index & 3) * 8,
      previous = this.filmWords[k];
    const next = ((previous & ~(255 << shift)) | (Math.round(wet * 255) << shift)) >>> 0;
    this.filmWords[k] = next;
    return previous !== next;
  }

  /** Returns an idempotent release function for scene streaming. */
  add(options: RainShelterOptions): () => void {
    const { center, width, depth, groundY, yaw = 0, initialWetness = 0 } = options;
    if (
      ![center.x, center.y, center.z, width, depth, groundY, yaw, initialWetness].every(Number.isFinite) ||
      width <= 0 ||
      depth <= 0 ||
      groundY >= center.y ||
      initialWetness < 0 ||
      initialWetness > 1
    )
      throw new RangeError(
        'A shelter needs finite world bounds, positive dimensions, a lower receiving surface and wetness in [0,1].',
      );
    if (this.count === LIMIT)
      throw new RangeError('Eight local roofs are active. Release distant roofs before registering another.');
    if (options.apronM !== undefined && !(Number.isFinite(options.apronM) && options.apronM > 0))
      throw new RangeError('The rain apron must have a positive finite width in metres.');
    const roof: Roof = {
      x: center.x,
      y: center.y,
      z: center.z,
      hx: width / 2,
      hz: depth / 2,
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      ground: groundY,
      margin: options.apronM ?? Math.max(1.5, (center.y - groundY) * 1.5),
      color: new THREE.Color(options.underside ?? 0x6f706e),
      film: new Float32Array(CELLS),
    };
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const x = ((2 * i) / (GRID - 1) - 1) * (roof.hx + roof.margin),
          z = ((2 * j) / (GRID - 1) - 1) * (roof.hz + roof.margin);
        roof.film[j * GRID + i] = Math.abs(x) <= roof.hx && Math.abs(z) <= roof.hz ? initialWetness : 1;
      }
    this.roofs.push(roof);
    this.roofs.sort((a, b) => a.y - b.y);
    this.pack();
    return () => {
      const index = this.roofs.indexOf(roof);
      if (index < 0) return;
      this.roofs.splice(index, 1);
      this.pack();
    };
  }

  private pack(): void {
    this.revision++;
    const buffer = this.rows.value;
    for (let i = 0; i < this.count; i++) {
      const r = this.roofs[i],
        k = i * 12;
      buffer[k] = r.x;
      buffer[k + 1] = r.y;
      buffer[k + 2] = r.z;
      buffer[k + 3] = r.cos;
      buffer[k + 4] = r.hx;
      buffer[k + 5] = r.hz;
      buffer[k + 6] = r.sin;
      buffer[k + 7] = r.ground;
      buffer[k + 8] = r.color.r;
      buffer[k + 9] = r.color.g;
      buffer[k + 10] = r.color.b;
      buffer[k + 11] = r.margin;
      for (let n = 0; n < CELLS; n++) this.writeFilm(i * CELLS + n, r.film[n]);
    }
    this.countNode.value = this.count;
    this.filmRevision++;
  }

  /** Fraction of the incoming ray reaching a point. The direction points back to its source. */
  exposureAt(
    x: number,
    y: number,
    z: number,
    dx = this.direction.value.x,
    dy = 1,
    dz = this.direction.value.z,
  ): number {
    if (dy <= 0.00001) return 1;
    for (const r of this.roofs) {
      const reach = (r.y - y) / dy;
      if (reach <= 0) continue;
      const rx = x - r.x + dx * reach,
        rz = z - r.z + dz * reach;
      if (Math.abs(rx * r.cos - rz * r.sin) <= r.hx && Math.abs(rx * r.sin + rz * r.cos) <= r.hz) return 0;
    }
    return 1;
  }

  /** Limit the outdoor rain film on the receiving ground. Standing flood water is independent. */
  filmAt(x: number, y: number, z: number, outdoor: number): number {
    let wet = outdoor;
    for (const r of this.roofs) {
      if (y > r.y + 0.0001) continue;
      const toGround = r.ground - y;
      const dx = x - r.x + this.direction.value.x * toGround,
        dz = z - r.z + this.direction.value.z * toGround;
      const u = (dx * r.cos - dz * r.sin) / (r.hx + r.margin),
        v = (dx * r.sin + dz * r.cos) / (r.hz + r.margin);
      if (Math.max(Math.abs(u), Math.abs(v)) >= 1) continue;
      const s = (u + 1) * 0.5 * (GRID - 1),
        t = (v + 1) * 0.5 * (GRID - 1);
      const col = Math.min(GRID - 2, Math.floor(s)),
        row = Math.min(GRID - 2, Math.floor(t)),
        k = row * GRID + col,
        fx = s - col,
        fz = t - row;
      const film = r.film;
      const a = film[k] + (film[k + 1] - film[k]) * fx,
        b = film[k + GRID] + (film[k + GRID + 1] - film[k + GRID]) * fx;
      const edge = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(u), Math.abs(v)), 0.88, 1);
      wet = Math.min(wet, outdoor + (Math.min(outdoor, a + (b - a) * fz) - outdoor) * edge);
    }
    return wet;
  }

  /** Six updates per second for a stationary surface. The analytic rates also handle longer game steps. */
  update(dt: number, windX: number, windZ: number, rain: number, dryingRate: number): void {
    this.direction.value.set((-windX * WIND_DRIFT) / DROP_SPEED, 1, (-windZ * WIND_DRIFT) / DROP_SPEED);
    if (!this.count || !(dt > 0 && Number.isFinite(dt))) return;
    this.elapsed += dt;
    if (this.elapsed < 1 / 6) return;
    const step = this.elapsed;
    this.elapsed = 0;
    const rainfall = clamp(rain, 0, 1), rate = rainfall * 0.45;
    const wetGain = -Math.expm1(-rate * step), loss = Math.max(0, dryingRate) * step;
    const exposedLoss = rate > 0 ? Math.max(0, dryingRate) * (1 - rainfall) * wetGain / rate : loss;
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const r = this.roofs[i];
      for (let j = 0; j < GRID; j++)
        for (let k = 0; k < GRID; k++) {
          const lx = ((2 * k) / (GRID - 1) - 1) * (r.hx + r.margin),
            lz = ((2 * j) / (GRID - 1) - 1) * (r.hz + r.margin);
          const x = r.x + lx * r.cos + lz * r.sin,
            z = r.z - lx * r.sin + lz * r.cos;
          const n = j * GRID + k,
            old = r.film[n];
          const open = this.exposureAt(x, r.ground, z);
          const next = Math.max(0, open ? old + (1 - old) * wetGain - exposedLoss : old - loss);
          if (next === old) continue;
          r.film[n] = next;
          if (this.writeFilm(i * CELLS + n, next)) dirty = true;
        }
    }
    if (dirty) this.filmRevision++;
  }

  private footprint(delta: N, center: N, shape: N): N {
    return t.vec2(
      delta.x.mul(center.w).sub(delta.y.mul(shape.z)),
      delta.x.mul(shape.z).add(delta.y.mul(center.w)),
    );
  }

  /** Matte underside RGB and ray coverage in A. Composite eave coverage from the lowest overhead deck upward. */
  rayNode(point: N, ray: N, blur: N = t.float(0)): N {
    return t.Fn(() => {
      const hit = t.vec4(0).toVar();
      t.If(this.countNode.greaterThan(0).and(ray.y.greaterThan(0.00001)), () => {
        t.Loop(
          { start: t.int(0), end: this.countNode, type: 'int', condition: '<', name: 'roofIndex' },
          ({ roofIndex }: N) => {
            const k = roofIndex.mul(3),
              c = this.rows.element(k),
              shape = this.rows.element(k.add(1));
            const distance = c.y.sub(point.y).div(ray.y);
            t.If(distance.greaterThan(0).and(hit.a.lessThan(1)), () => {
              const local = this.footprint(point.xz.sub(c.xz).add(ray.xz.mul(distance)), c, shape);
              const d = t.abs(local).sub(shape.xy),
                edge = t.max(d.x, d.y);
              const penumbra = blur.mul(distance).clamp(0.005, 2);
              const opacity = t.smoothstep(penumbra.negate(), penumbra, edge).oneMinus();
              t.If(opacity.greaterThan(0), () => {
                const weight = hit.a.oneMinus().mul(opacity);
                hit.addAssign(t.vec4(this.rows.element(k.add(2)).rgb, 1).mul(weight));
              });
            });
          },
        );
      });
      return t.vec4(hit.rgb.div(hit.a.max(0.00001)), hit.a);
    })();
  }

  rainNode(point: N, skyward?: N): N {
    return this.rayNode(point, skyward ?? this.direction).a.oneMinus();
  }

  /** X is cached pavement moisture. Y approximates the diffuse sky visible around the eaves. */
  groundNode(point: N, outdoor: N, diffuseSky = true): N {
    return t.Fn(() => {
      const wet = outdoor.toVar(),
        sky = t.float(1).toVar();
      t.Loop(
        { start: t.int(0), end: this.countNode, type: 'int', condition: '<', name: 'groundRoof' },
        ({ groundRoof }: N) => {
          const k = groundRoof.mul(3),
            c = this.rows.element(k),
            shape = this.rows.element(k.add(1)),
            detail = this.rows.element(k.add(2));
          const local = this.footprint(point.xz.sub(c.xz), c, shape);
          const toGround = shape.w.sub(point.y);
          const receiver = this.footprint(point.xz.sub(c.xz).add(this.direction.xz.mul(toGround)), c, shape);
          const extent = shape.xy.add(detail.w),
            st = receiver.div(extent),
            edge = t.max(t.abs(st.x), t.abs(st.y));
          t.If(edge.lessThan(1).and(point.y.lessThanEqual(c.y.add(0.0001))), () => {
            const grid = st
              .mul(0.5)
              .add(0.5)
              .mul(GRID - 1);
            const base = t.min(t.ivec2(grid.floor()), t.ivec2(GRID - 2)),
              f = grid.sub(t.vec2(base));
            const index = groundRoof.mul(CELLS).add(base.y.mul(GRID)).add(base.x);
            const cell = (n: N): N => {
              const word = this.filmBuffer.element(n.div(16)).element(n.div(4).mod(4));
              return t.float(word.shiftRight(t.uint(n.mod(4).mul(8))).bitAnd(t.uint(255))).div(255);
            };
            const limit = t.mix(
              t.mix(cell(index), cell(index.add(1)), f.x),
              t.mix(cell(index.add(GRID)), cell(index.add(GRID + 1)), f.x),
              f.y,
            );
            wet.assign(t.min(wet, t.mix(t.min(outdoor, limit), outdoor, t.smoothstep(0.88, 1, edge))));
          });
          const height = c.y.sub(point.y);
          if (diffuseSky)
            t.If(height.greaterThan(0), () => {
              // Separable projected angular widths of the two roof spans. An open
              // side still supplies diffuse skylight when the zenith is obscured.
              const near = shape.xy.sub(local),
                far = shape.xy.add(local);
              const span = near
                .div(t.sqrt(near.mul(near).add(height.mul(height))))
                .add(far.div(t.sqrt(far.mul(far).add(height.mul(height)))))
                .mul(0.5);
              sky.assign(t.min(sky, t.float(1).sub(span.x.mul(span.y).mul(0.92))));
            });
        },
      );
      return t.vec2(wet, sky);
    })();
  }

  /** Select the shared material uniforms for this renderer submission. */
  bindMaterials(): void {
    const dest = materialShelters;
    dest.direction.value.copy(this.direction.value);
    if (boundShelters !== this || boundRevision !== this.revision) {
      dest.rows.value.set(this.rows.value);
      dest.countNode.value = this.count;
      boundFilmRevision = -1;
      boundShelters = this;
      boundRevision = this.revision;
    }
    if (this.count && boundFilmRevision !== this.filmRevision) {
      dest.filmWords.set(this.filmWords);
      boundFilmRevision = this.filmRevision;
    }
  }

  clear(): void {
    this.roofs.length = 0;
    this.elapsed = 0;
    this.pack();
  }
  dispose(): void {
    this.clear();
    if (boundShelters === this) {
      materialShelters.clear();
      boundShelters = undefined;
      boundRevision = boundFilmRevision = -1;
    }
  }
}

// Ordinary PBR materials may be authored before selecting a renderer. Each world
// binds its geometry rows and film samples before drawing, alongside its weather.
const materialShelters = new RainShelters();
let boundShelters: RainShelters | undefined;
let boundRevision = -1,
  boundFilmRevision = -1;
export function shelteredRainFilmNode(point: N, outdoor: N): N {
  return materialShelters.groundNode(point, outdoor, false).x;
}
