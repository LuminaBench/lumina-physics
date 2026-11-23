/**
 * Deformable sand, gravel, snow and mud retain wheel and impact tracks.
 *
 * A 2D stamp buffer covers a patch of ground (fixed, or following a target):
 *
 *   R  compaction   how far the surface has been pressed down (0..1 of the layer depth)
 *   G  berm         material squeezed up beside a rut
 *   B  disturbance  fresh churn: darkens sand, glazes mud, exposes blue shadow in snow
 *
 * Each frame up to 16 stamps (wheel contact patches, floats, falling debris, craters) are
 * written by one full-screen pass; ruts slowly fill back in (`recovery`: wind-blown sand,
 * fresh snowfall). The mesh displaces its vertices from the buffer and derives its normal
 * from the height gradient, so low sun rakes across the tracks. A coarse CPU twin answers
 * `depthAt` for physics (sinkage, rolling resistance) and implements `VehicleSurface`.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { FieldReading, surfaceWetnessNode } from '../../engine/world-bus';
import { frame } from '../../engine/frame';
import { createGravelTexture } from './gravel';
import { valueNoise2, fbm2, hash12, spriteNoise } from '../../engine/noise';
import { ParticleSystem } from '../../engine/particles';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { QualityPreset } from '../../engine/quality';

const {
  Fn, float, vec2, vec3, vec4, uniform, uniformArray, texture, uv, positionWorld, positionGeometry, length, max, min, mix, smoothstep, normalize,
  cameraViewMatrix, cameraPosition, dot, pow, sin, Loop, int,
} = TSL;

export type GroundKind = 'sand' | 'snow' | 'mud' | 'gravel';

export interface GroundLook {
  /** Depth of the loose layer in metres (a full-depth rut is this deep). */
  depth: number;
  /** Friction multiplier for tires on this ground. */
  grip: number;
  /** Rolling resistance per wheel in N per m/s on untouched ground (less in an existing rut). */
  drag: number;
  /** Ruts refilled per second (0 = permanent tracks). */
  recovery: number;
  /** Colour of thrown clumps. */
  clump: number;
}

export const GROUND_LOOKS: Record<GroundKind, GroundLook> = {
  gravel: { depth: 0.045, grip: 0.81, drag: 34, recovery: 0.0005, clump: 0x766d61 },
  sand: { depth: 0.09, grip: 0.72, drag: 55, recovery: 0.004, clump: 0xcbb489 },
  snow: { depth: 0.24, grip: 0.42, drag: 70, recovery: 0.0015, clump: 0xf2f6fa },
  mud: { depth: 0.16, grip: 0.5, drag: 120, recovery: 0.0008, clump: 0x3a2a1c },
};

export interface GroundOptions {
  center: THREE.Vector2;
  /** Side length of the deformable patch in metres. */
  size: number;
  /** Height of the undisturbed surface. */
  surfaceY: number;
  kind?: GroundKind;
  /** Baseline moisture 0–1; rain can wet the patch further. */
  moisture?: number;
  /** Keep the patch centred on this object (open-world tracks around the player). */
  follow?: THREE.Object3D | null;
  /**
   * World rectangle [minX, minZ, maxX, maxZ] the visible ground extends to beyond the
   * deformable patch (undisturbed, same material), so the patch has no visible border.
   */
  extent?: [number, number, number, number];
}

const MAX_STAMPS = 16;
const CPU_RESOLUTION = 128;
const _p = new THREE.Vector3();

interface Track { x: number; z: number; valid: boolean; dustCarry: number }

export class DeformableGround implements EngineModule {
  readonly size: number;
  readonly center: THREE.Vector2;
  surfaceY: number;
  kind: GroundKind;
  follow: THREE.Object3D | null;
  mesh!: THREE.Mesh;
  /** Ballistic clumps thrown by fast contacts. */
  clumps!: ParticleSystem;
  /** Number of stamps written since creation (QA). */
  stamps = 0;
  /** `VehicleSurface`: dry loose ground has no standing water. */
  private moisture = 0;
  get wetness(): number { return Math.max(this.moisture, this.engine.world.surfaceWetness); }
  set wetness(value: number) { this.moisture = THREE.MathUtils.clamp(value, 0, 1); }
  private readonly contactFields = new FieldReading();
  /** Loose-surface moisture at an individual shoe or tire, including local spray. */
  wetnessAt(x: number, z: number): number {
    const world = this.engine.world;
    const rainFilm = Math.max(this.moisture, world.rainFilmAt(x, this.surfaceY, z));
    if (!world.sourceCount) return rainFilm;
    const point = _p.set(x, this.surfaceY, z);
    if (!world.contains(point)) return rainFilm;
    return Math.max(this.moisture, world.disturbance(point, this.contactFields).wetness);
  }
  private readonly uMoisture = uniform(0);
  private readonly aggregate = createGravelTexture();

  private look: GroundLook;
  private targets: THREE.RenderTarget[] = [];
  private quad: THREE.QuadMesh;
  private queue: Array<{ x: number; z: number; radius: number; depth: number }> = [];
  private uStamps = uniformArray(Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4(0, 0, 0, 0)), 'vec4');
  private uCount = uniform(0);
  private uCenter = uniform(new THREE.Vector2());
  private uShift = uniform(new THREE.Vector2());
  private uRecover = uniform(0);
  private uDepth = uniform(0.1);
  private uKind = uniform(0);
  private current: N;
  private previousNode: N;
  private cpu = new Float32Array(CPU_RESOLUTION * CPU_RESOLUTION);
  private cpuScratch = new Float32Array(CPU_RESOLUTION * CPU_RESOLUTION);
  private tracks = new Map<string, Track>();
  private resolution = 512;
  private idleFrames = 0;
  private texel = 1;
  private extent: [number, number, number, number] | null;
  private skirt: THREE.Mesh | null = null;

  constructor(private engine: LuminaEngine, private fx: EffectsKit | null, options: GroundOptions) {
    this.size = options.size;
    this.center = options.center.clone();
    this.surfaceY = options.surfaceY;
    this.kind = options.kind ?? 'sand';
    this.look = { ...GROUND_LOOKS[this.kind] };
    this.follow = options.follow ?? null;
    this.extent = options.extent ?? null;
    this.quad = new THREE.QuadMesh(new THREE.NodeMaterial());
    this.current = texture(new THREE.Texture());
    this.previousNode = texture(new THREE.Texture());
    this.setKind(this.kind);
    if (options.moisture !== undefined) this.wetness = options.moisture;
    this.build(engine.quality.preset);
  }

  /** Tunable copy of the material's physical numbers. */
  get properties(): GroundLook { return this.look; }

  /** Switch the loose material while retaining the existing tracks. */
  setKind(kind: GroundKind): void {
    this.kind = kind;
    this.look = { ...GROUND_LOOKS[kind] };
    this.uKind.value = kind === 'sand' ? 0 : kind === 'snow' ? 1 : kind === 'mud' ? 2 : 3;
    this.uDepth.value = this.look.depth;
    this.wetness = kind === 'mud' ? 1 : 0;
    this.clumps?.uniforms.color.value.set(this.look.clump);
  }

  // ---- construction ----------------------------------------------------------------

  private build(preset: QualityPreset): void {
    this.disposeResources();
    const tier = preset.tier;
    this.resolution = tier === 'low' ? 256 : tier === 'medium' ? 384 : tier === 'ultra' ? 1024 : 512;
    this.texel = this.size / this.resolution;
    const make = () => {
      const target = new THREE.RenderTarget(this.resolution, this.resolution, { type: THREE.HalfFloatType, depthBuffer: false });
      target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
      target.texture.generateMipmaps = false;
      return target;
    };
    this.targets = [make(), make()];
    this.current.value = this.targets[0].texture;
    this.previousNode.value = this.targets[1].texture;

    // ---- stamp pass ---------------------------------------------------------------
    const pass = new THREE.NodeMaterial();
    const stamps = this.uStamps, count = this.uCount;
    pass.fragmentNode = Fn(() => {
      const st = uv();
      const world = st.sub(0.5).mul(this.size).add(this.uCenter);
      const moved = st.add(this.uShift);
      const inside = smoothstep(0.0, 0.002, min(min(moved.x, float(1).sub(moved.x)), min(moved.y, float(1).sub(moved.y))));
      const old = this.previousNode.sample(moved.clamp(0.001, 0.999)).mul(inside);
      const keep = float(1).sub(this.uRecover);
      const compaction = old.r.mul(keep).toVar();
      const berm = old.g.mul(keep).toVar();
      const churn = old.b.mul(float(1).sub(this.uRecover.mul(6).min(0.2))).toVar();
      Loop({ start: int(0), end: int(MAX_STAMPS), type: 'int', condition: '<', name: 'si' }, ({ si }: N) => {
        const s = stamps.element(si);
        const active = float(si).lessThan(count).select(float(1), float(0));
        const d = length(world.sub(s.xy));
        // Flat-bottomed footprint with a soft wall, a raised lip just outside it.
        const foot = float(1).sub(smoothstep(s.z.mul(0.55), s.z, d)).mul(s.w).mul(active);
        const lip = smoothstep(s.z.mul(0.85), s.z.mul(1.15), d).mul(float(1).sub(smoothstep(s.z.mul(1.15), s.z.mul(1.9), d))).mul(s.w).mul(active);
        compaction.assign(max(compaction, foot));
        berm.assign(max(berm, lip.mul(0.6)));
        churn.assign(max(churn, max(foot, lip.mul(0.7)).min(1)));
      });
      return vec4(compaction, berm, churn, 1);
    })();
    this.quad.material = pass;

    // ---- visible surface ------------------------------------------------------------
    const segments = tier === 'low' ? 96 : tier === 'medium' ? 144 : tier === 'ultra' ? 320 : 224;
    const geometry = new THREE.PlaneGeometry(this.size, this.size, segments, segments).rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardNodeMaterial();
    const fieldUV = (xz: N): N => xz.sub(this.uCenter).div(this.size).add(0.5);
    // Geometry is authored around the origin; the patch centre is added here so that
    // following a target never moves vertices relative to the texels (no swimming).
    const baseXZ = positionGeometry.xz.add(this.uCenter);
    const edge = (st: N): N => smoothstep(0.0, 0.03, min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y))));
    const heightAt = (xz: N): N => {
      const st = fieldUV(xz);
      const s = this.current.sample(st.clamp(0.001, 0.999));
      return s.g.mul(float(1).sub(s.r)).mul(0.45).sub(s.r).mul(this.uDepth).mul(edge(st));
    };
    // Gentle undulation, faded to zero at the patch border so the flat skirt meets it without a crack.
    const relief = (xz: N): N => valueNoise2(xz.mul(0.35)).sub(0.5).mul(0.05).add(sin(xz.x.mul(2.1).add(valueNoise2(xz.mul(0.4)).mul(5))).mul(0.006)).mul(edge(fieldUV(xz)));
    material.positionNode = vec3(positionGeometry.x, heightAt(baseXZ).add(relief(baseXZ)), positionGeometry.z);

    // Normal from the height gradient (ruts + micro relief) plus per-grain roughness.
    // Mip filtering averages small stones to their mineral colour in distant views.
    const stone = Fn(() => {
      const tap = vec4(0.5, 0.5, 0.5, 0).toVar();
      TSL.If(this.uKind.greaterThan(2.5), () => {
        tap.assign(texture(this.aggregate, positionWorld.xz.div(0.72)));
      });
      return tap;
    })().toVar();
    const slope = Fn(() => {
      const xz = positionWorld.xz;
      const e = this.texel * 1.25;
      const h0 = heightAt(xz).add(relief(xz));
      const hx = heightAt(xz.add(vec2(e, 0))).add(relief(xz.add(vec2(e, 0))));
      const hz = heightAt(xz.add(vec2(0, e))).add(relief(xz.add(vec2(0, e))));
      const footprint = length(TSL.fwidth(xz));
      const grain = vec2(spriteNoise(xz.mul(41)).sub(0.5), spriteNoise(xz.mul(43),1).sub(0.5))
        .mul(smoothstep(0.05,0.007,footprint));
      // Wind ripples on loose sand and sastrugi on snow (not on mud, not where it is packed down);
      // faded with distance, where they would only alias.
      const near = smoothstep(70, 12, length(cameraPosition.sub(positionWorld)));
      const phase = xz.x.mul(7.5).add(xz.y.mul(2.6)).add(valueNoise2(xz.mul(0.55)).mul(9));
      const untouched = float(1).sub(this.current.sample(fieldUV(xz).clamp(0.001, 0.999)).r.mul(edge(fieldUV(xz))));
      const ripple = TSL.cos(phase).mul(0.14).mul(near).mul(untouched)
        .mul(float(1).sub(smoothstep(0.45,0.55,this.uKind)));
      const gradient = vec2(h0.sub(hx),h0.sub(hz)).div(e).add(grain.mul(0.22))
        .add(vec2(0.94,0.33).mul(ripple)).toVar();
      // Wind-carved snow forms isolated elongated lips among polished patches. Recover
      // the world-space slope from screen derivatives so their shading follows the relief.
      const dx = TSL.dFdx(xz), dz = TSL.dFdy(xz);
      const along = dot(xz,vec2(0.91,0.41)), across = dot(xz,vec2(-0.41,0.91));
      const drift = spriteNoise(vec2(along.mul(0.19),across.mul(0.34))).toVar();
      const ridges = spriteNoise(vec2(along.mul(0.45),across.mul(2.3).add(drift.mul(3.7))),1);
      const reliefSnow = smoothstep(0.4,0.88,ridges).pow(1.7).mul(drift.mul(0.074))
        .add(drift.mul(0.095));
      const sx = TSL.dFdx(reliefSnow), sz = TSL.dFdy(reliefSnow);
      const det = dx.x.mul(dz.y).sub(dx.y.mul(dz.x));
      const inv = TSL.sign(det).div(max(TSL.abs(det),1e-8));
      const snowAmount = smoothstep(0.5,0.55,this.uKind).mul(float(1).sub(smoothstep(1.45,1.5,this.uKind)));
      gradient.subAssign(vec2(sx.mul(dz.y).sub(sz.mul(dx.y)),sz.mul(dx.x).sub(sx.mul(dz.x)))
        .mul(inv).mul(snowAmount).mul(untouched).mul(smoothstep(0.8,0.18,footprint)));
      return gradient.add(stone.rg.sub(0.5).mul(0.8).mul(untouched.mul(0.5).add(0.5)));
    })().toVar();
    const normalWorld = normalize(vec3(slope.x, 1, slope.y));
    material.normalNode = normalize(cameraViewMatrix.mul(vec4(normalWorld, 0)).xyz);

    const stateUV = fieldUV(positionWorld.xz);
    const state = this.current.sample(stateUV.clamp(0.001, 0.999)).mul(edge(stateUV));
    const xz = positionWorld.xz;
    const footprint = length(TSL.fwidth(xz));
    const speckle = mix(float(0.5),spriteNoise(xz.mul(95)),smoothstep(0.025,0.005,footprint));
    const patches = fbm2(xz.mul(0.22), 3);
    const kind = this.uKind;
    // (Albedos are linear reflectance: dry sand ≈ 0.35, snow is held well below its real 0.85 so it keeps detail.)
    // Sand: warm grains, darker and smoother where it is compacted (damp sand underneath).
    const sand = mix(vec3(0.3, 0.235, 0.14), vec3(0.4, 0.32, 0.2), speckle.mul(0.5).add(patches.mul(0.5)))
      .mul(mix(float(1), float(0.4), state.r)).mul(mix(float(1), float(0.78), state.b.mul(float(1).sub(state.r))));
    // Snow: bright, slightly blue in compressed tracks where light scatters deeper.
    const snow = mix(vec3(0.46, 0.5, 0.57), vec3(0.54, 0.57, 0.62), patches).mul(mix(vec3(1), vec3(0.55, 0.68, 0.9), state.r)).mul(mix(float(1), float(0.88), state.b));
    // Mud: dark wet earth; churned ruts hold water.
    const mud = mix(vec3(0.045, 0.03, 0.018), vec3(0.09, 0.062, 0.036), patches.mul(0.6).add(speckle.mul(0.4))).mul(mix(float(1), float(0.55), state.r));
    const gravel = mix(vec3(0.054, 0.049, 0.044), vec3(0.25, 0.235, 0.205), stone.b)
      .mul(mix(1, 0.64, stone.a)).mul(mix(1, 0.76, state.r)).mul(mix(0.76, 1.12, patches));
    const groundColour = mix(mix(sand, snow, smoothstep(0.5, 0.51, kind)), mud, smoothstep(1.5, 1.51, kind));
    const wetMineral = this.uMoisture.max(surfaceWetnessNode(positionWorld)).mul(kind.lessThan(0.5).or(kind.greaterThan(2.5)).select(1, 0));
    material.colorNode = mix(groundColour, gravel, smoothstep(2.5, 2.51, kind)).mul(mix(1, 0.55, wetMineral));
    const roughSand = mix(float(0.96), float(0.82), state.r);
    const roughSnow = mix(float(0.78), float(0.42), state.r);
    const roughMud = mix(float(0.62), float(0.1), max(state.r, state.b.mul(0.7)));
    const groundRough = mix(mix(roughSand, roughSnow, smoothstep(0.5, 0.51, kind)), roughMud, smoothstep(1.5, 1.51, kind));
    material.roughnessNode = mix(mix(groundRough, float(0.89), smoothstep(2.5, 2.51, kind)), float(0.39), wetMineral);
    material.metalness = 0;
    // Snow glitter: a few grains per square metre flash when their facet lines up with the sun.
    const view = normalize(cameraPosition.sub(positionWorld));
    const facet = normalize(vec3(hash12(xz.mul(180).floor()).sub(0.5), 1.6, hash12(xz.mul(180).floor().add(3.7)).sub(0.5)));
    const glint = pow(max(dot(facet, normalize(view.add(frame.sunDirection))), 0), 900).mul(smoothstep(0.5, 0.51, kind)).mul(float(1).sub(smoothstep(1.5, 1.51, kind)));
    material.emissiveNode = frame.sunColor.mul(frame.sunVisibility).mul(glint).mul(float(1).sub(state.r))
      .mul(smoothstep(0.018,0.003,footprint)).mul(2.5);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'lumina-deformable-ground';
    this.engine.scene.add(this.mesh);
    // Undisturbed ground around the patch: four big quads sharing the material (the buffer
    // reads as zero outside the patch, so they shade as untouched sand / snow / mud).
    if (this.extent && !this.follow) {
      const [minX, minZ, maxX, maxZ] = this.extent;
      const h = this.size / 2, cx = this.center.x, cz = this.center.y;
      const quads: Array<[number, number, number, number]> = [
        [minX, minZ, maxX, cz - h], [minX, cz + h, maxX, maxZ], [minX, cz - h, cx - h, cz + h], [cx + h, cz - h, maxX, cz + h],
      ];
      const positions: number[] = [], indices: number[] = [];
      for (const [x0, z0, x1, z1] of quads) {
        if (x1 - x0 < 0.01 || z1 - z0 < 0.01) continue;
        const n = positions.length / 3;
        // Local to the mesh origin (the patch centre), like the dense grid.
        positions.push(x0 - cx, 0, z0 - cz, x1 - cx, 0, z0 - cz, x0 - cx, 0, z1 - cz, x1 - cx, 0, z1 - cz);
        indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
      }
      const skirtGeometry = new THREE.BufferGeometry();
      skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      skirtGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      skirtGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
      skirtGeometry.setIndex(indices);
      this.skirt = new THREE.Mesh(skirtGeometry, material);
      this.skirt.frustumCulled = false;
      this.skirt.receiveShadow = true;
      this.engine.scene.add(this.skirt);
    }

    this.clumps = new ParticleSystem(this.engine.renderer, this.engine.wind, {
      capacity: Math.max(256, Math.min(3000, Math.floor(preset.particles.budget * 0.05))), shading: 'grit', gravity: 1, drag: 0.5, windInfluence: 0.3,
      floorY: this.surfaceY - 0.05, stretch: 0, opacity: 0.95, softness: 0.2, color: this.look.clump,
    });
    this.engine.scene.add(this.clumps.mesh);
    this.placeMesh();
  }

  private placeMesh(): void {
    (this.uCenter.value as THREE.Vector2).copy(this.center);
    this.mesh.position.set(this.center.x, this.surfaceY, this.center.y);
    this.mesh.updateMatrixWorld();
    if (this.skirt) { this.skirt.position.copy(this.mesh.position); this.skirt.updateMatrixWorld(); }
  }

  // ---- stamping --------------------------------------------------------------------

  /** Press a disc into the ground. `depth` is 0..1 of the layer depth. */
  stamp(x: number, z: number, radius: number, depth = 1): void {
    if (Math.abs(x - this.center.x) > this.size / 2 + radius || Math.abs(z - this.center.y) > this.size / 2 + radius) return;
    if (this.queue.length < 96) this.queue.push({ x, z, radius, depth: Math.min(1, Math.max(0, depth)) });
    // CPU twin.
    const cell = this.size / CPU_RESOLUTION;
    const cu = (x - this.center.x) / cell + CPU_RESOLUTION / 2, cv = (z - this.center.y) / cell + CPU_RESOLUTION / 2;
    const span = Math.ceil(radius / cell);
    for (let v = Math.max(0, Math.floor(cv - span)); v <= Math.min(CPU_RESOLUTION - 1, Math.ceil(cv + span)); v++) {
      for (let u = Math.max(0, Math.floor(cu - span)); u <= Math.min(CPU_RESOLUTION - 1, Math.ceil(cu + span)); u++) {
        const d = Math.hypot(u + 0.5 - cu, v + 0.5 - cv) * cell;
        const k = (1 - THREE.MathUtils.smoothstep(d, radius * 0.55, radius)) * depth;
        const i = v * CPU_RESOLUTION + u;
        if (k > this.cpu[i]) this.cpu[i] = k;
      }
    }
    this.stamps++;
  }

  /**
   * A moving contact (wheel, float, foot). Call every frame with the same `id`: stamps are
   * laid along the path since the last call so fast movers leave unbroken ruts, and loose
   * material is thrown when `speed` (m/s) is high.
   */
  track(id: string, x: number, z: number, radius: number, depth: number, speed = 0, heading: { x: number; z: number } | null = null, lateralSpeed = 0): void {
    if (!this.contains(x, z) || depth <= 0 || radius <= 0) { this.lift(id); return; }
    let t = this.tracks.get(id);
    if (!t) { t = { x, z, valid: false, dustCarry: 0 }; this.tracks.set(id, t); }
    const dist = t.valid ? Math.hypot(x - t.x, z - t.z) : 0;
    const spacing = radius * 0.7;
    if (!t.valid || dist > spacing * 12) this.stamp(x, z, radius, depth);
    else if (dist >= spacing * 0.5) {
      const steps = Math.min(8, Math.ceil(dist / spacing));
      for (let s = 1; s <= steps; s++) this.stamp(t.x + ((x - t.x) * s) / steps, t.z + ((z - t.z) * s) / steps, radius, depth);
    } else return;
    t.x = x; t.z = z; t.valid = true;
    const speedAbs = Math.abs(speed);
    if (Math.hypot(speed, lateralSpeed) > 2.5 && depth > 0.1) {
      const slip = Math.min(1, Math.abs(lateralSpeed) / Math.max(speedAbs, 1));
      const disturbed = Math.min(1, depth) * (1 + slip);
      // Meter the fine fraction per metre of contact. Wet aggregate binds its fines.
      const distance = dist > spacing * 12 ? 0 : dist;
      const dry = 1 - this.wetnessAt(x, z);
      t.dustCarry += this.kind === 'mud' ? 0 : distance * disturbed * dry * dry * 1.8;
      const dust = Math.floor(t.dustCarry);
      t.dustCarry -= dust;
      this.spray(x, z, speed, heading, disturbed, dust);
    }
  }

  /** Lift a contact (wheel in the air): the next `track` call starts a new rut. */
  lift(id: string): void { const t = this.tracks.get(id); if (t) { t.valid = false; t.dustCarry = 0; } }

  /** A crater with a thrown rim (explosions, heavy impacts). */
  crater(x: number, z: number, radius: number): void {
    this.stamp(x, z, radius, 1);
    this.engine.events.emit('groundDisplaced', { position: [x, this.surfaceY, z], intensity: Math.min(1, radius / 2) });
    this.spray(x, z, 14 + radius * 3, null, 3, Math.round(6 * (1 - this.wetnessAt(x, z))));
  }

  private spray(x: number, z: number, speed: number, heading: { x: number; z: number } | null, scale = 1, dust = 0): void {
    const k = Math.min(1, Math.abs(speed) / 30);
    const stone = this.kind === 'gravel';
    const back = heading ? -1 : 0;
    this.clumps.emit({
      position: _p.set(x, this.surfaceY + 0.05, z), radius: 0.12 * scale,
      velocity: { x: (heading?.x ?? 0) * back * speed * 0.3, y: (stone ? 0.7 : 1.6) + Math.abs(speed) * (stone ? 0.085 : 0.14), z: (heading?.z ?? 0) * back * speed * 0.3 },
      spread: 1.2 + Math.abs(speed) * 0.12, speedJitter: 0.6, life: 0.9, lifeJitter: 0.5, size: this.kind === 'snow' ? 0.07 : stone ? 0.033 : 0.045, sizeEnd: this.kind === 'snow' ? 0.11 : stone ? 0.033 : 0.055,
      count: Math.ceil((3 + 14 * k) * scale),
    });
    // Fine material hangs in the air: dust off sand, powder off snow; mud only throws clumps.
    if (this.fx && this.kind !== 'mud' && dust > 0) {
      const pool = this.kind === 'snow' ? this.fx.mist : this.fx.dust;
      pool.emit({ position: _p.set(x, this.surfaceY + 0.2, z), radius: 0.25 * scale, velocity: { x: (heading?.x ?? 0) * speed * 0.12, y: 0.8 + k, z: (heading?.z ?? 0) * speed * 0.12 }, spread: 0.9 + k, life: 2.2, lifeJitter: 0.4, size: 0.35, sizeEnd: 1.1 + 1.2 * k * scale, count: dust });
    }
  }

  // ---- queries (physics) -------------------------------------------------------------

  /** Compaction 0..1 at a world position (CPU twin, bilinear). */
  compactionAt(x: number, z: number): number {
    const cell = this.size / CPU_RESOLUTION;
    const fu = (x - this.center.x) / cell + CPU_RESOLUTION / 2 - 0.5, fv = (z - this.center.y) / cell + CPU_RESOLUTION / 2 - 0.5;
    const u = Math.floor(fu), v = Math.floor(fv);
    if (u < 0 || v < 0 || u >= CPU_RESOLUTION - 1 || v >= CPU_RESOLUTION - 1) return 0;
    const tu = fu - u, tv = fv - v, i = v * CPU_RESOLUTION + u;
    return this.cpu[i] * (1 - tu) * (1 - tv) + this.cpu[i + 1] * tu * (1 - tv) + this.cpu[i + CPU_RESOLUTION] * (1 - tu) * tv + this.cpu[i + CPU_RESOLUTION + 1] * tu * tv;
  }

  /** Metres the surface has been pressed down at a world position. */
  depthAt(x: number, z: number): number { return this.compactionAt(x, z) * this.look.depth; }

  /** True inside the deformable patch. */
  contains(x: number, z: number): boolean { return Math.abs(x - this.center.x) < this.size / 2 && Math.abs(z - this.center.y) < this.size / 2; }

  // `VehicleSurface`
  puddleDepth(): number { return 0; }
  grip(x: number, z: number): number { return this.contains(x, z) ? this.look.grip * (1 + 0.25 * this.compactionAt(x, z)) : 1; }
  /** Fresh ground is soft (the wheel sinks and pushes material); an existing rut rolls easier. */
  rollingDrag(x: number, z: number): number { return this.contains(x, z) ? this.look.drag * (1 - 0.6 * this.compactionAt(x, z)) : 0; }

  // ---- per frame ----------------------------------------------------------------------

  setQuality(preset: QualityPreset): void { this.build(preset); }

  update(dt: number): void {
    const { renderer } = this.engine;
    if (this.uMoisture.value !== this.moisture) this.uMoisture.value = this.moisture;
    // Recentre on the followed object in whole texels.
    let shiftX = 0, shiftZ = 0;
    if (this.follow) {
      this.follow.getWorldPosition(_p);
      const nx = Math.round(_p.x / this.texel) * this.texel, nz = Math.round(_p.z / this.texel) * this.texel;
      shiftX = nx - this.center.x; shiftZ = nz - this.center.y;
      if (shiftX !== 0 || shiftZ !== 0) { this.shiftCpu(shiftX, shiftZ); this.center.set(nx, nz); this.placeMesh(); }
    }
    const recover = this.look.recovery * dt;
    // CPU twin decays at the same rate.
    if (recover > 0 && this.engine.time % 0.5 < dt) { const k = 1 - this.look.recovery * 0.5; for (let i = 0; i < this.cpu.length; i++) this.cpu[i] *= k; }
    this.clumps.update();
    const moving = shiftX !== 0 || shiftZ !== 0;
    if (!this.queue.length && !moving) {
      // Nothing new: let ruts recover with an occasional pass instead of one every frame.
      if (recover <= 0 || ++this.idleFrames < 30) return;
    }
    const batch = this.queue.splice(0, MAX_STAMPS);
    for (let i = 0; i < MAX_STAMPS; i++) {
      const s = batch[i];
      (this.uStamps.array[i] as THREE.Vector4).set(s?.x ?? 0, s?.z ?? 0, s?.radius ?? 0, s?.depth ?? 0);
    }
    this.uCount.value = batch.length;
    (this.uShift.value as THREE.Vector2).set(shiftX / this.size, shiftZ / this.size);
    this.uRecover.value = Math.min(0.5, recover * Math.max(1, this.idleFrames));
    this.idleFrames = 0;
    const [read, write] = this.targets;
    this.previousNode.value = read.texture;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(write);
    this.quad.render(renderer);
    renderer.setRenderTarget(previousTarget);
    this.current.value = write.texture;
    this.targets = [write, read];
  }

  private shiftCpu(dx: number, dz: number): void {
    const cell = this.size / CPU_RESOLUTION;
    const su = Math.round(dx / cell), sv = Math.round(dz / cell);
    if (!su && !sv) return;
    const out = this.cpuScratch;
    out.fill(0);
    for (let v = 0; v < CPU_RESOLUTION; v++) {
      const sv0 = v + sv;
      if (sv0 < 0 || sv0 >= CPU_RESOLUTION) continue;
      for (let u = 0; u < CPU_RESOLUTION; u++) {
        const su0 = u + su;
        if (su0 >= 0 && su0 < CPU_RESOLUTION) out[v * CPU_RESOLUTION + u] = this.cpu[sv0 * CPU_RESOLUTION + su0];
      }
    }
    this.cpuScratch = this.cpu;
    this.cpu = out;
  }

  /** Smooth everything back to an untouched surface. */
  reset(): void {
    this.cpu.fill(0);
    this.queue.length = 0;
    this.tracks.clear();
    const { renderer } = this.engine;
    const previousTarget = renderer.getRenderTarget();
    for (const target of this.targets) { renderer.setRenderTarget(target); renderer.clear(); }
    renderer.setRenderTarget(previousTarget);
  }

  private disposeResources(): void {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
    if (this.skirt) { this.skirt.removeFromParent(); this.skirt.geometry.dispose(); this.skirt = null; }
    (this.quad.material as THREE.Material | undefined)?.dispose?.();
    this.clumps?.dispose();
  }

  dispose(): void { this.disposeResources(); this.aggregate.dispose(); }
}
