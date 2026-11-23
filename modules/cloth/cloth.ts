/**
 * Cloth and rope system: flags, banners, sails, parachutes, power lines.
 *
 *   const cloth = engine.add(new ClothSystem(engine));
 *   cloth.flag({ origin, width: 2.4, height: 1.5, pattern: 'stripes', colors: [0xc8102e, 0xffffff] });
 *   cloth.rope({ from, to, slack: 1.05 });
 *
 * All pieces are solved together (`gpu.ts` on WebGPU, `cpu.ts` on WebGL 2 or on request) and
 * read the engine's wind field, so storm gusts, jet downwash and explosion pressure fronts
 * move them without any per-piece wiring. Supports dynamic tearing & rope snapping (both
 * constraints and visible mesh topology), sphere & oriented box collider pushout, and
 * frustum/distance simulation LOD.
 */
import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../../engine/quality';
import { TSL } from '../../engine/tsl';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import { CpuClothSolver } from './cpu';
import { GpuClothSolver } from './gpu';
import {
  DEFAULT_CLOTH_LOD,
  DEFAULT_TUNING,
  MAX_PIECES,
  type BoxCollider,
  type ClothBackend,
  type ClothLodLevel,
  type ClothLodOptions,
  type Collider,
  type PieceRecord,
  type PieceSpec,
  type PieceTuning,
  type SolverContext,
} from './types';
import { patternNode, type ClothPattern } from './patterns';
import { bannerSpec, flagSpec, parachuteSpec, powerLineSpecs, ropeSpec, sailSpec, type BannerOptions, type FlagOptions, type ParachuteOptions, type PowerLineOptions, type RopeOptions, type SailOptions } from './presets';

const { attribute, normalize, cross, cameraPosition, cameraViewMatrix, vec3, vec4, float, uv, max, dot, length, faceDirection, mix, uniform, step, select } = TSL;

const _v = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

export interface PieceLook {
  pattern?: ClothPattern;
  /** Up to three colours used by the pattern. */
  colors?: THREE.ColorRepresentation[];
  roughness?: number;
  /** 0..1 light that passes through the fabric (back-lit glow). */
  translucency?: number;
  /** Rope colour. */
  color?: THREE.ColorRepresentation;
  /**
   * Draw this many thin lines from evenly spaced rim points to the piece's local origin
   * (parachute suspension lines, awning guy lines).
   */
  lines?: number;
}

export class ClothPiece {
  mesh: THREE.Mesh | null = null;
  /** @internal Suspension lines (see `PieceLook.lines`). */
  lineMesh: THREE.LineSegments | null = null;
  /** @internal */ readonly uOrigin = uniform(new THREE.Vector3());
  /** Object whose world transform the piece's pins and tethers follow. */
  follow: THREE.Object3D | null = null;
  /** Emit `cloth-flap` events as gusts and blasts snap the fabric. */
  audible = true;
  /** @internal */ flapTimer = Math.random();
  /** @internal */ lastSpeed = 0;

  constructor(readonly system: ClothSystem, readonly record: PieceRecord, readonly look: PieceLook) {}

  get matrix(): THREE.Matrix4 { return this.record.matrix; }
  get tuning(): PieceTuning { return this.record.tuning; }
  get enabled(): boolean { return this.record.enabled; }
  set enabled(value: boolean) { this.record.enabled = value; if (this.mesh) this.mesh.visible = value; if (this.lineMesh) this.lineMesh.visible = value; }
  /** Current simulation LOD level (0 = full, 1 = reduced, 2 = offscreen, 3 = sleeping). */
  get lodLevel(): ClothLodLevel { return this.record.lodLevel; }
  /** Number of torn structural links on this piece. */
  get tornCount(): number { return this.system.backend ? this.system.backend.tornCount(this.record) : this.record.tornCount; }
  /** True once any edge on this piece has torn or snapped. */
  get isTorn(): boolean { return this.tornCount > 0 || this.record.snapped; }
  /** Alias for `isTorn` (convenient for ropes). */
  get isSnapped(): boolean { return this.isTorn; }

  /** World position of a grid point (exact on the CPU solver; pinned points only on the GPU solver). */
  point(ix: number, iy: number, out = new THREE.Vector3()): THREE.Vector3 {
    const backend = this.system.backend;
    const index = this.record.offset + iy * this.record.spec.cols + ix;
    return backend ? backend.read(index, out) : this.record.spec.rest(ix, iy, out).applyMatrix4(this.record.matrix);
  }

  /** Throw the whole piece (m/s): a body slamming into a banner, a line being cut. */
  kick(velocity: THREE.Vector3): void { this.system.backend?.kick(this.record, velocity); }

  /** Tear links within `radius` metres of a world-space point. Returns severed link count. */
  tear(worldPoint: THREE.Vector3, radius = 0.45): number {
    this.system.ensureBuilt();
    const n = this.system.backend!.tearSphere(this.record, worldPoint, radius);
    if (n > 0) this.system.onTear?.(this, n, worldPoint);
    return n;
  }

  /** Cut links along a world-space line segment. Returns severed link count. */
  cut(from: THREE.Vector3, to: THREE.Vector3, thickness = 0.25): number {
    this.system.ensureBuilt();
    const n = this.system.backend!.cutSegment(this.record, from, to, thickness);
    if (n > 0) this.system.onTear?.(this, n, _v.addVectors(from, to).multiplyScalar(0.5));
    return n;
  }

  /** Tear links around grid coordinate `(ix, iy)`. */
  tearGrid(ix: number, iy: number, radiusCells = 1): number {
    this.system.ensureBuilt();
    const n = this.system.backend!.tearGrid(this.record, ix, iy, radiusCells);
    if (n > 0) this.system.onTear?.(this, n, this.point(ix, iy, _v));
    return n;
  }

  /** Snap a rope at `segmentIndex` (defaults to middle) or tear a cloth across column `segmentIndex`. */
  snap(segmentIndex?: number): boolean {
    this.system.ensureBuilt();
    const snapped = this.system.backend!.snapPiece(this.record, segmentIndex);
    if (snapped) {
      const col = Math.max(0, Math.min(this.record.spec.cols - 2, segmentIndex ?? Math.floor((this.record.spec.cols - 1) * 0.5)));
      this.system.onTear?.(this, this.record.spec.rows, this.point(col, Math.floor(this.record.spec.rows * 0.5), _v));
    }
    return snapped;
  }

  /** Restore all torn links and tethers on this piece. */
  heal(): void {
    this.system.ensureBuilt();
    this.system.backend!.healPiece(this.record);
  }
}

export interface ClothSystemOptions {
  /** Use the CPU solver even on WebGPU (deterministic gameplay reads via `piece.point`). */
  forceCpu?: boolean;
  substeps?: number;
  iterations?: number;
  /** Grid resolution multiplier for the presets (default 1 on GPU, 0.6 on CPU). */
  detail?: number;
  /** Frustum & distance simulation LOD configuration. */
  lod?: Partial<ClothLodOptions>;
}

export class ClothSystem implements EngineModule {
  readonly pieces: ClothPiece[] = [];
  /** Sphere colliders (poles, hulls, vehicle bodies). At most `MAX_COLLIDERS` are used. */
  readonly colliders: Collider[] = [];
  /** Oriented / axis-aligned box colliders (walls, vehicles, crates). At most `MAX_BOX_COLLIDERS` are used. */
  readonly boxColliders: BoxCollider[] = [];
  /** Frustum and distance simulation LOD settings. */
  readonly lod: ClothLodOptions;
  /** Per-frame LOD distribution across pieces (for telemetry / HUD / QA). */
  readonly lodStats = { full: 0, reduced: 0, offscreen: 0, sleeping: 0 };
  /** Particles never sink below this height (ground or mean water level). */
  groundY = -1e5;
  backend: ClothBackend | null = null;
  /** Number of `cloth-flap` events emitted (QA). */
  flaps = 0;
  /** Optional callback fired when a cloth tears or a rope snaps. */
  onTear: ((piece: ClothPiece, count: number, point: THREE.Vector3) => void) | null = null;

  /**
   * Grid resolution multiplier applied by the presets. 1 on the GPU solver; the CPU solver
   * defaults to 0.6 (about a third of the particles) to stay inside the JavaScript budget.
   */
  readonly detail: number;
  private context: SolverContext;
  private dirty = true;
  private lodDistanceScale: number;
  private ropeMesh: THREE.Mesh | null = null;
  private forceCpu: boolean;
  private uRopeColor = uniform(new THREE.Color(0x0c0c0d));
  private frameCounter = 0;

  constructor(private engine: LuminaEngine, options: ClothSystemOptions = {}) {
    this.lodDistanceScale = engine.quality.preset.renderScale;
    this.forceCpu = options.forceCpu ?? false;
    const cpu = engine.backend !== 'webgpu' || this.forceCpu;
    this.detail = options.detail ?? (cpu ? 0.6 : 1);
    this.lod = { ...DEFAULT_CLOTH_LOD, ...options.lod };
    this.context = {
      pieces: [],
      colliders: this.colliders,
      boxColliders: this.boxColliders,
      groundY: this.groundY,
      substeps: options.substeps ?? (cpu ? 1 : 2),
      iterations: options.iterations ?? (cpu ? 5 : 7),
    };
  }

  /** Add a piece from a raw spec. Presets (`flag`, `sail`, `rope` …) live in `presets.ts`. */
  add(spec: PieceSpec, options: { matrix?: THREE.Matrix4; follow?: THREE.Object3D; look?: PieceLook } = {}): ClothPiece {
    if (this.pieces.length >= MAX_PIECES) throw new Error(`ClothSystem supports ${MAX_PIECES} pieces`);
    const tuning: PieceTuning = { ...DEFAULT_TUNING };
    for (const key of Object.keys(DEFAULT_TUNING) as Array<keyof PieceTuning>) if (spec[key] !== undefined) tuning[key] = spec[key]!;
    const record: PieceRecord = {
      spec,
      tuning,
      offset: 0,
      count: spec.cols * spec.rows,
      matrix: options.matrix?.clone() ?? new THREE.Matrix4(),
      enabled: true,
      boundsCenter: new THREE.Vector3(),
      boundsRadius: 2,
      lodLevel: 0,
      activeThisFrame: true,
      tornCount: 0,
      snapped: false,
    };
    const piece = new ClothPiece(this, record, options.look ?? {});
    piece.follow = options.follow ?? null;
    if (piece.follow) { piece.follow.updateWorldMatrix(true, false); record.matrix.copy(piece.follow.matrixWorld); }
    this.pieces.push(piece);
    this.dirty = true;
    return piece;
  }

  /** Add a sphere collider and return it for live position updates. */
  addSphereCollider(center: THREE.Vector3, radius: number): Collider {
    const c: Collider = { center: center.clone(), radius };
    this.colliders.push(c);
    return c;
  }

  /** Add an oriented or axis-aligned box collider and return it for live updates. */
  addBoxCollider(center: THREE.Vector3, halfExtents: THREE.Vector3, quaternion?: THREE.Quaternion, margin = 0.02): BoxCollider {
    const b: BoxCollider = { center: center.clone(), halfExtents: halfExtents.clone(), quaternion: quaternion?.clone(), margin };
    this.boxColliders.push(b);
    return b;
  }

  /** Tear any pieces intersecting a world-space sphere. */
  tearAt(point: THREE.Vector3, radius = 0.5): number {
    this.ensureBuilt();
    let total = 0;
    for (const piece of this.pieces) {
      if (!piece.enabled) continue;
      const n = this.backend!.tearSphere(piece.record, point, radius);
      if (n > 0) {
        total += n;
        this.onTear?.(piece, n, point);
      }
    }
    return total;
  }

  /** Cut any pieces intersecting a world-space line segment. */
  cutLine(from: THREE.Vector3, to: THREE.Vector3, thickness = 0.25): number {
    this.ensureBuilt();
    let total = 0;
    const mid = _v.addVectors(from, to).multiplyScalar(0.5).clone();
    for (const piece of this.pieces) {
      if (!piece.enabled) continue;
      const n = this.backend!.cutSegment(piece.record, from, to, thickness);
      if (n > 0) {
        total += n;
        this.onTear?.(piece, n, mid);
      }
    }
    return total;
  }

  /** Total torn links across all pieces. */
  get tornCount(): number {
    return this.pieces.reduce((n, p) => n + p.tornCount, 0);
  }

  /** A flag flying from a hoist (pinned along its pole edge). */
  flag(options: FlagOptions): ClothPiece { const b = flagSpec(options, this.detail); return this.add(b.spec, { matrix: b.matrix, look: b.look, follow: options.follow }); }
  /** A banner hung from a rod or strung between its top corners. */
  banner(options: BannerOptions): ClothPiece { const b = bannerSpec(options, this.detail); return this.add(b.spec, { matrix: b.matrix, look: b.look, follow: options.follow }); }
  /** A sail set from a yard with sheeted clews (optionally laced to a mast). */
  sail(options: SailOptions): ClothPiece { const b = sailSpec(options, this.detail); return this.add(b.spec, { matrix: b.matrix, look: b.look, follow: options.follow }); }
  /** A canopy whose lines converge on a payload; the descent's airflow inflates it. */
  parachute(options: ParachuteOptions): ClothPiece { const b = parachuteSpec(options, this.detail); return this.add(b.spec, { matrix: b.matrix, look: b.look, follow: options.follow }); }
  /** A rope, cable or mooring line between two points. */
  rope(options: RopeOptions): ClothPiece { const b = ropeSpec(options, this.detail); const piece = this.add(b.spec, { matrix: b.matrix, look: b.look, follow: options.follow }); piece.audible = false; return piece; }
  /** Conductors strung between pole tops; the first wire of each span creaks in a gale. */
  powerLines(options: PowerLineOptions): ClothPiece[] {
    const wires = options.wires ?? 3;
    return powerLineSpecs(options, this.detail).map((b, i) => { const piece = this.add(b.spec, { matrix: b.matrix, look: b.look }); piece.audible = i % wires === 0; return piece; });
  }

  /** Total simulated particles. */
  get particleCount(): number { return this.pieces.reduce((n, p) => n + p.record.count, 0); }

  /** @internal Build solver and meshes immediately if pending (used by tear/snap before first frame). */
  ensureBuilt(): void { if (this.dirty || !this.backend) this.build(); }

  // ---- construction -------------------------------------------------------------

  private build(): void {
    this.disposeResources();
    this.context.pieces = this.pieces.map((p) => p.record);
    const gpu = this.engine.backend === 'webgpu' && !this.forceCpu;
    this.backend = gpu
      ? new GpuClothSolver(this.engine.renderer, this.context, this.engine.wind)
      : new CpuClothSolver(this.context, this.engine.wind);
    for (const piece of this.pieces) {
      if (piece.record.spec.kind === 'cloth') {
        piece.mesh = this.createClothMesh(piece);
        piece.mesh.visible = piece.record.enabled;
        this.engine.scene.add(piece.mesh);
        if (piece.look.lines) {
          piece.lineMesh = this.createLines(piece, piece.look.lines);
          piece.lineMesh.visible = piece.record.enabled;
          this.engine.scene.add(piece.lineMesh);
        }
      }
    }
    this.ropeMesh = this.createRopeMesh();
    if (this.ropeMesh) this.engine.scene.add(this.ropeMesh);
    this.dirty = false;
  }

  /**
   * Build cloth geometry with per-triangle vertices so torn quads/triangles collapse cleanly
   * in the vertex shader on both WebGPU and WebGL 2 without leaving stretched bridges.
   */
  private createClothMesh(piece: ClothPiece): THREE.Mesh {
    const backend = this.backend!;
    const { cols, rows } = piece.record.spec;
    const base = piece.record.offset;
    const cells = (cols - 1) * (rows - 1);
    const vCount = cells * 6;
    const particle = new Float32Array(vCount);
    const around = new Float32Array(vCount * 4);
    const uvs = new Float32Array(vCount * 2);
    // triInfo: (cellTL, cellTR, cellBL, triHalf: 0 for TL-BL-TR, 1 for TR-BL-BR)
    const triInfo = new Float32Array(vCount * 4);

    let vi = 0;
    const emitVert = (ix: number, iy: number, tl: number, tr: number, bl: number, half: number) => {
      const idx = base + iy * cols + ix;
      particle[vi] = idx;
      around[vi * 4] = base + iy * cols + Math.max(ix - 1, 0);
      around[vi * 4 + 1] = base + iy * cols + Math.min(ix + 1, cols - 1);
      around[vi * 4 + 2] = base + Math.max(iy - 1, 0) * cols + ix;
      around[vi * 4 + 3] = base + Math.min(iy + 1, rows - 1) * cols + ix;
      uvs[vi * 2] = ix / (cols - 1);
      uvs[vi * 2 + 1] = 1 - iy / (rows - 1);
      triInfo[vi * 4] = tl;
      triInfo[vi * 4 + 1] = tr;
      triInfo[vi * 4 + 2] = bl;
      triInfo[vi * 4 + 3] = half;
      vi++;
    };

    for (let iy = 0; iy < rows - 1; iy++) for (let ix = 0; ix < cols - 1; ix++) {
      const tl = base + iy * cols + ix;
      const tr = tl + 1;
      const bl = tl + cols;
      // Tri 1: TL, BL, TR
      emitVert(ix, iy, tl, tr, bl, 0);
      emitVert(ix, iy + 1, tl, tr, bl, 0);
      emitVert(ix + 1, iy, tl, tr, bl, 0);
      // Tri 2: TR, BL, BR
      emitVert(ix + 1, iy, tl, tr, bl, 1);
      emitVert(ix, iy + 1, tl, tr, bl, 1);
      emitVert(ix + 1, iy + 1, tl, tr, bl, 1);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('particle', new THREE.BufferAttribute(particle, 1));
    geometry.setAttribute('around', new THREE.BufferAttribute(around, 4));
    geometry.setAttribute('triInfo', new THREE.BufferAttribute(triInfo, 4));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const look = piece.look;
    const material = new THREE.MeshStandardNodeMaterial();
    material.side = THREE.DoubleSide;
    material.roughness = look.roughness ?? 0.82;
    material.metalness = 0;

    const pIdx = attribute('particle', 'float');
    const pRaw = backend.particle(pIdx);
    const nb = attribute('around', 'vec4');
    const ti = attribute('triInfo', 'vec4');

    // Triangle intactness: Tri 0 requires top & left links; Tri 1 requires right & bottom links.
    const topOk = backend.link(ti.x).x;
    const leftOk = backend.link(ti.x).y;
    const rightOk = backend.link(ti.y).y;
    const bottomOk = backend.link(ti.z).x;
    const triIntact = select(ti.w.lessThan(0.5), topOk.mul(leftOk), rightOk.mul(bottomOk));
    const anchorPos = backend.particle(ti.x);
    const p = mix(anchorPos, pRaw, step(0.5, triIntact));

    // Tear-aware surface normal: do not span across severed edges.
    const selfLinks = backend.link(pIdx);
    const pL = mix(pRaw, backend.particle(nb.x), step(0.5, backend.link(nb.x).x));
    const pR = mix(pRaw, backend.particle(nb.y), step(0.5, selfLinks.x));
    const pU = mix(pRaw, backend.particle(nb.z), step(0.5, backend.link(nb.z).y));
    const pD = mix(pRaw, backend.particle(nb.w), step(0.5, selfLinks.y));
    const normalWorld = normalize(cross(pR.sub(pL), pD.sub(pU)).add(vec3(0, 1e-6, 0)));

    material.positionNode = p;
    const vNormal = normalWorld.toVarying('clothNormal');
    const vWorld = p.toVarying('clothWorld');
    const pPrevRaw = backend.previous(pIdx);
    const pPrev = mix(backend.previous(ti.x), pPrevRaw, step(0.5, triIntact));
    const vPrevious = pPrev.toVarying('clothPrevious');

    // Shade the side that faces the viewer.
    const facing = normalize(vNormal).mul(faceDirection);
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(facing, 0)).xyz);
    const albedo = patternNode(look.pattern ?? 'solid', uv(), (look.colors ?? [0xd8d2c4]).map((c) => new THREE.Color(c)));
    material.colorNode = albedo;
    // Thin fabric lets sunlight through: a back-lit flag glows in its own colours.
    const through = max(dot(facing.negate(), frame.sunDirection), 0);
    material.emissiveNode = albedo.mul(frame.sunColor).mul(frame.sunVisibility).mul(through).mul((look.translucency ?? 0.35) / Math.PI);
    material.mrtNode = auxSurface(material.normalNode, screenVelocity(vWorld, vPrevious));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'lumina-cloth';
    return mesh;
  }

  /** Straight lines from rim particles to the piece origin (they follow the solver on the GPU). */
  private createLines(piece: ClothPiece, count: number): THREE.LineSegments {
    const backend = this.backend!;
    const { cols, rows } = piece.record.spec;
    const rim: number[] = [];
    for (let ix = 0; ix < cols; ix++) rim.push(ix);
    for (let iy = 1; iy < rows; iy++) rim.push(iy * cols + cols - 1);
    for (let ix = cols - 2; ix >= 0; ix--) rim.push((rows - 1) * cols + ix);
    for (let iy = rows - 2; iy >= 1; iy--) rim.push(iy * cols);
    const particle: number[] = [], end: number[] = [];
    for (let k = 0; k < count; k++) {
      const index = piece.record.offset + rim[Math.floor((k / count) * rim.length)];
      particle.push(index, index);
      end.push(0, 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    geometry.setAttribute('particle', new THREE.BufferAttribute(new Float32Array(particle), 1));
    geometry.setAttribute('end', new THREE.BufferAttribute(new Float32Array(end), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const material = new THREE.LineBasicNodeMaterial();
    material.positionNode = mix(backend.particle(attribute('particle', 'float')), piece.uOrigin, attribute('end', 'float'));
    material.colorNode = vec3(0.08, 0.08, 0.085);
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.name = 'lumina-cloth-lines';
    return lines;
  }

  /** One ribbon mesh for every rope piece in the system; snapped segments collapse cleanly. */
  private createRopeMesh(): THREE.Mesh | null {
    const ropes = this.pieces.filter((p) => p.record.spec.kind === 'rope');
    if (!ropes.length) return null;
    const backend = this.backend!;
    const particle: number[] = [], along: number[] = [], side: number[] = [], radius: number[] = [], segLink: number[] = [], indices: number[] = [];
    for (const rope of ropes) {
      const n = rope.record.spec.cols, base = rope.record.offset, r = rope.record.spec.radius ?? 0.02;
      for (let i = 0; i < n - 1; i++) {
        const a = particle.length;
        // 4 vertices per segment so snapping link `base + i` collapses only this segment.
        for (const endIdx of [i, i + 1]) {
          for (const s of [-1, 1]) {
            particle.push(base + endIdx);
            along.push(base + Math.max(endIdx - 1, 0), base + Math.min(endIdx + 1, n - 1));
            side.push(s);
            radius.push(r);
            segLink.push(base + i);
          }
        }
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particle.length * 3), 3));
    geometry.setAttribute('particle', new THREE.BufferAttribute(new Float32Array(particle), 1));
    geometry.setAttribute('along', new THREE.BufferAttribute(new Float32Array(along), 2));
    geometry.setAttribute('side', new THREE.BufferAttribute(new Float32Array(side), 1));
    geometry.setAttribute('radius', new THREE.BufferAttribute(new Float32Array(radius), 1));
    geometry.setAttribute('segLink', new THREE.BufferAttribute(new Float32Array(segLink), 1));
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.MeshStandardNodeMaterial();
    material.side = THREE.DoubleSide;
    material.roughness = 0.6;
    material.metalness = 0.1;

    const pIdx = attribute('particle', 'float');
    const sIdx = attribute('segLink', 'float');
    const segIntact = step(0.5, backend.link(sIdx).x);
    const centreRaw = backend.particle(pIdx);
    const anchor = backend.particle(sIdx);
    const centre = mix(anchor, centreRaw, segIntact);

    const nb = attribute('along', 'vec2');
    const prevP = mix(centreRaw, backend.particle(nb.x), step(0.5, backend.link(nb.x).x));
    const nextP = mix(centreRaw, backend.particle(nb.y), step(0.5, backend.link(pIdx).x));
    const tangent = normalize(nextP.sub(prevP).add(vec3(1e-6, 0, 0)));
    const toCamera = cameraPosition.sub(centre);
    const sideways = normalize(cross(tangent, toCamera).add(vec3(0, 1e-6, 0)));
    // Never thinner than about a pixel, so distant cables do not break into dashes.
    const width = max(attribute('radius', 'float'), length(toCamera).mul(0.0007)).mul(segIntact);
    const s = attribute('side', 'float');
    material.positionNode = centre.add(sideways.mul(s).mul(width));

    const vSide = s.toVarying('ropeSide');
    const vSideways = sideways.toVarying('ropeSideways');
    const vToCamera = normalize(toCamera).toVarying('ropeToCamera');
    const round = normalize(vSideways.mul(vSide).add(vToCamera.mul(float(1).sub(vSide.mul(vSide)).max(0).sqrt())));
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(round, 0)).xyz);
    material.colorNode = mix(this.uRopeColor, this.uRopeColor.mul(1.6), vSide.mul(0.5).add(0.5));
    const vWorld = centre.toVarying('ropeWorld');
    const vPrevious = mix(backend.previous(sIdx), backend.previous(pIdx), segIntact).toVarying('ropePrevious');
    material.mrtNode = auxSurface(material.normalNode, screenVelocity(vWorld, vPrevious));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.name = 'lumina-ropes';
    return mesh;
  }

  /** Colour of every rope / cable in this system. */
  set ropeColor(color: THREE.ColorRepresentation) { (this.uRopeColor.value as THREE.Color).set(color); }

  // ---- simulation LOD -----------------------------------------------------------

  private updateLod(): void {
    const stats = this.lodStats;
    stats.full = stats.reduced = stats.offscreen = stats.sleeping = 0;
    const lod = this.lod;
    const cam = this.engine.camera;
    this.frameCounter++;

    if (!lod.enabled) {
      for (const piece of this.pieces) {
        piece.record.lodLevel = 0;
        piece.record.activeThisFrame = piece.record.enabled;
        if (piece.record.enabled) stats.full++;
      }
      return;
    }

    cam.updateMatrixWorld();
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      const rec = piece.record;
      if (!rec.enabled) {
        rec.lodLevel = 3;
        rec.activeThisFrame = false;
        stats.sleeping++;
        continue;
      }
      _sphere.center.copy(rec.boundsCenter).applyMatrix4(rec.matrix);
      _sphere.radius = rec.boundsRadius + lod.frustumMargin;
      const dist = Math.max(0, _sphere.center.distanceTo(cam.position) - rec.boundsRadius);
      const inFrustum = _frustum.intersectsSphere(_sphere);

      if (dist > lod.sleepDistance * this.lodDistanceScale && !piece.follow) {
        rec.lodLevel = 3;
        rec.activeThisFrame = false;
        stats.sleeping++;
      } else if (!inFrustum) {
        rec.lodLevel = 2;
        const stride = piece.follow ? Math.min(2, Math.max(1, lod.offscreenStride)) : lod.offscreenStride;
        rec.activeThisFrame = stride > 0 && ((this.frameCounter + i) % stride === 0);
        stats.offscreen++;
      } else if (dist > lod.fullDistance * this.lodDistanceScale) {
        rec.lodLevel = 1;
        const stride = Math.max(1, dist > lod.reducedDistance * this.lodDistanceScale ? lod.reducedStride + 1 : lod.reducedStride);
        rec.activeThisFrame = (this.frameCounter + i) % stride === 0;
        stats.reduced++;
      } else {
        rec.lodLevel = 0;
        rec.activeThisFrame = true;
        stats.full++;
      }
    }
  }

  // ---- per frame ----------------------------------------------------------------

  setQuality(preset: QualityPreset = this.engine.quality.preset): void { this.lodDistanceScale = preset.renderScale; }

  update(dt: number, time: number): void {
    if (this.dirty) this.build();
    this.context.groundY = this.groundY;
    const { wind, events } = this.engine;
    for (const piece of this.pieces) {
      if (piece.follow) { piece.follow.updateWorldMatrix(true, false); piece.record.matrix.copy(piece.follow.matrixWorld); }
      if (piece.lineMesh) (piece.uOrigin.value as THREE.Vector3).setFromMatrixPosition(piece.record.matrix);
      if (!piece.audible || !piece.record.enabled || dt <= 0) continue;
      _v.setFromMatrixPosition(piece.record.matrix);
      const speed = wind.sample(_v, time, _wind).length();
      const snap = Math.max(0, speed - piece.lastSpeed) / Math.max(dt, 1e-3);
      piece.lastSpeed = speed;
      const cloth = piece.record.spec.kind === 'cloth';
      piece.flapTimer -= dt * (cloth ? 0.35 + speed * 0.09 : 0.08 + speed * 0.02);
      if (snap > 60 || (piece.flapTimer <= 0 && speed > (cloth ? 2.5 : 9))) {
        piece.flapTimer = 0.6 + Math.random() * 0.7;
        this.flaps++;
        events.emit(cloth ? 'flutter' : 'ropeTension', { position: [_v.x, _v.y, _v.z], intensity: Math.min(1, snap > 60 ? 1 : speed / 28) });
      }
    }
    this.updateLod();
    this.backend!.step(dt, time);
  }

  private disposeResources(): void {
    for (const piece of this.pieces) {
      if (!piece.mesh) continue;
      piece.mesh.removeFromParent();
      piece.mesh.geometry.dispose();
      (piece.mesh.material as THREE.Material).dispose();
      piece.mesh = null;
      if (piece.lineMesh) { piece.lineMesh.removeFromParent(); piece.lineMesh.geometry.dispose(); (piece.lineMesh.material as THREE.Material).dispose(); piece.lineMesh = null; }
    }
    if (this.ropeMesh) {
      this.ropeMesh.removeFromParent();
      this.ropeMesh.geometry.dispose();
      (this.ropeMesh.material as THREE.Material).dispose();
      this.ropeMesh = null;
    }
    this.backend?.dispose();
    this.backend = null;
  }

  dispose(): void { this.disposeResources(); }
}
