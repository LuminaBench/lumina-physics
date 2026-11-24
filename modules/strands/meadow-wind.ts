import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { WorldSource, type WorldBus } from '../../engine/world-bus';
import { terrainReading, type TerrainSurface } from '../terrain/surface';

/** Sample the same world wind at ground height once per texel rather than once per blade vertex. */
export class MeadowWind {
  readonly texture: THREE.Texture;
  readonly origin = TSL.uniform(new THREE.Vector2());
  readonly ambient = TSL.uniform(new THREE.Vector2());
  private readonly size = 64;
  private readonly span = 128;
  private readonly point = new THREE.Vector3();
  private readonly air = new THREE.Vector3();
  private readonly ground = terrainReading();
  private readonly heights: THREE.DataTexture | null;
  private readonly pass: N;
  private readonly bytes: Uint8Array | null;
  private readonly contact = new WorldSource();
  private flowClock = 1;
  private readonly flowTexture?: THREE.DataTexture;
  private readonly flowOrigin = TSL.uniform(new THREE.Vector2());
  private readonly waterVelocity = new THREE.Vector3();
  private accumulator = 1;
  constructor(
    private readonly world: WorldBus,
    private readonly surface: TerrainSurface,
    private readonly gpu?: THREE.WebGPURenderer,
    waterCurrents = false,
  ) {
    if (waterCurrents) {
      this.flowTexture = new THREE.DataTexture(new Uint8Array(12 * 12 * 4), 12, 12);
      this.flowTexture.magFilter = this.flowTexture.minFilter = THREE.LinearFilter;
      this.flowTexture.needsUpdate = true;
    }
    const n = this.size;
    if (gpu) {
      const heights = new THREE.DataTexture(
        surface.heights,
        surface.segments + 1,
        surface.segments + 1,
        THREE.RedFormat,
        THREE.FloatType,
      );
      heights.needsUpdate = true;
      this.heights = heights;
      const output = new THREE.StorageTexture(n, n);
      output.type = THREE.HalfFloatType;
      output.magFilter = output.minFilter = THREE.LinearFilter;
      this.texture = output;
      this.bytes = null;
      this.pass = TSL.Fn(() => {
        const i = TSL.int(TSL.instanceIndex),
          x = i.mod(n),
          z = i.div(n);
        const xz = TSL.vec2(x, z)
          .add(0.5)
          .mul(this.span / n)
          .add(this.origin);
        const texel = xz.div(surface.size).add(0.5).mul(surface.segments).clamp(0, surface.segments);
        const cell = TSL.ivec2(texel.floor().min(surface.segments - 1)),
          f = texel.sub(TSL.vec2(cell));
        const a = TSL.textureLoad(heights, cell).r,
          b = TSL.textureLoad(heights, cell.add(TSL.ivec2(1, 0))).r;
        const c = TSL.textureLoad(heights, cell.add(TSL.ivec2(0, 1))).r,
          d = TSL.textureLoad(heights, cell.add(TSL.ivec2(1, 1))).r;
        const y = TSL.select(
          f.x.add(f.y).lessThanEqual(1),
          a.add(b.sub(a).mul(f.x)).add(c.sub(a).mul(f.y)),
          d.add(d.sub(c).mul(f.x.sub(1))).add(d.sub(b).mul(f.y.sub(1))),
        ).add(0.32);
        const wind = world
          .node(TSL.vec3(xz.x, y, xz.y))
          .div(80)
          .add(0.5)
          .saturate();
        TSL.textureStore(output, TSL.ivec2(x, z), TSL.vec4(wind, 1)).toWriteOnly();
      })().compute(n * n);
    } else {
      this.bytes = new Uint8Array(n * n * 4).fill(128);
      this.heights = null;
      this.pass = null;
      const tex = new THREE.DataTexture(this.bytes, n, n, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.texture = tex;
    }
  }
  /** A moving body temporarily displaces nearby stems. The shared bus decays the snapshot on departure. */
  part(x: number, y: number, z: number, radius: number, speed: number) {
    const s = this.contact.at(x, y, z);
    s.radius = Math.max(0.3, radius);
    s.radial = Math.min(28, 8 + Math.abs(speed) * 1.4);
    this.world.publish(s, 0.42);
  }
  update(dt: number, time: number, camera: THREE.Vector3) {
    this.ambient.value.copy(this.world.direction).multiplyScalar(this.world.speed * 0.62);
    this.flowClock += dt;
    if (this.flowTexture && this.flowClock >= 0.25) {
      this.flowClock = 0;
      const texture = this.flowTexture,
        bytes = texture.image.data!,
        span = 72;
      this.flowOrigin.value.set(
        Math.floor(camera.x / 6) * 6 - span / 2,
        Math.floor(camera.z / 6) * 6 - span / 2,
      );
      for (let i = 0; i < 144; i++) {
        const x = this.flowOrigin.value.x + ((i % 12) + 0.5) * 6,
          z = this.flowOrigin.value.y + (Math.floor(i / 12) + 0.5) * 6;
        const depth =
          this.world.waterHeight(x, z, this.waterVelocity) - this.surface.sample(x, z, this.ground).height;
        bytes[i * 4] = 128 + Math.round(THREE.MathUtils.clamp(this.waterVelocity.x, -4, 4) * 31);
        bytes[i * 4 + 1] = 128 + Math.round(THREE.MathUtils.clamp(this.waterVelocity.z, -4, 4) * 31);
        bytes[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(depth, 0, 1) * 255);
        bytes[i * 4 + 3] = 255;
      }
      texture.needsUpdate = true;
    }
    this.accumulator += dt;
    if (this.accumulator < 1 / 18) return;
    this.accumulator = 0;
    const pitch = this.span / this.size;
    this.origin.value.set(
      Math.floor(camera.x / pitch) * pitch - this.span / 2,
      Math.floor(camera.z / pitch) * pitch - this.span / 2,
    );
    if (this.gpu) {
      this.gpu.compute(this.pass);
      return;
    }
    const bytes = this.bytes!,
      n = this.size;
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const wx = this.origin.value.x + (x + 0.5) * pitch,
          wz = this.origin.value.y + (z + 0.5) * pitch;
        this.point.set(wx, this.surface.sample(wx, wz, this.ground).height + 0.32, wz);
        this.world.sample(this.point, time, this.air);
        const i = (z * n + x) * 4;
        bytes[i] = THREE.MathUtils.clamp(128 + (this.air.x * 255) / 80, 0, 255);
        bytes[i + 1] = THREE.MathUtils.clamp(128 + (this.air.y * 255) / 80, 0, 255);
        bytes[i + 2] = THREE.MathUtils.clamp(128 + (this.air.z * 255) / 80, 0, 255);
      }
    this.texture.needsUpdate = true;
  }
  node(p: N): N {
    const uv = p.xz.sub(this.origin).div(this.span);
    const edge = TSL.min(uv, TSL.vec2(1).sub(uv));
    const blend = TSL.smoothstep(0, 0.06, TSL.min(edge.x, edge.y));
    const air = TSL.texture(this.texture, uv.clamp(0, 1)).level(0).rgb.sub(0.5).mul(80);
    return TSL.mix(TSL.vec3(this.ambient.x, 0, this.ambient.y), air, blend);
  }
  currentNode(p: N): N {
    if (!this.flowTexture) return TSL.vec2(0);
    const uv = p.xz.sub(this.flowOrigin).div(72),
      edge = TSL.min(uv, TSL.vec2(1).sub(uv));
    const flow = TSL.texture(this.flowTexture, uv.clamp(0, 1)).level(0);
    return flow.rg
      .sub(128 / 255)
      .mul(255 / 31)
      .mul(flow.b)
      .mul(TSL.smoothstep(0, 0.13, TSL.min(edge.x, edge.y)));
  }
  dispose() {
    this.flowTexture?.dispose();
    this.world.removeSource(this.contact);
    this.pass?.dispose();
    this.texture.dispose();
    this.heights?.dispose();
  }
}
