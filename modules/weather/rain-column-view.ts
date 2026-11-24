import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxPassthrough, sunlightAtHeight } from '../../engine/frame';
import { RainColumn } from './rain-column';

/** World-space extinction integrated through a bounded column. Depth-tested slices allow terrain,
 * vehicles or a moving camera inside the shower to occlude individual segments. */
export class RainColumnView {
  readonly root = new THREE.Group();
  private readonly material = new THREE.MeshBasicNodeMaterial();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly mesh = new THREE.Mesh(this.geometry, this.material);
  private readonly source: THREE.DataTexture;
  private readonly profile: THREE.DataTexture;
  private readonly center = TSL.uniform(new THREE.Vector2());
  private readonly step = TSL.uniform(1);
  private readonly clock = TSL.uniform(0);
  private readonly direction = new THREE.Vector3();
  private readonly observer = new THREE.Vector3();
  private readonly offset = new THREE.Vector2();
  private version = -1;

  constructor(
    readonly column: RainColumn,
    readonly slices = 12,
    tint: THREE.ColorRepresentation = 0xffffff,
  ) {
    if (!Number.isInteger(slices) || slices < 4 || slices > 32)
      throw new RangeError('Expected 4–32 rain slices');
    const o = column.options,
      n = column.sourceSize,
      h = column.profileSize;
    this.source = new THREE.DataTexture(column.source, n, n, THREE.RedFormat);
    this.source.minFilter = this.source.magFilter = THREE.LinearFilter;
    this.source.needsUpdate = true;
    this.profile = new THREE.DataTexture(column.profile, h, 1, THREE.RGBAFormat, THREE.FloatType);
    this.profile.needsUpdate = true;
    let minX = 0,
      maxX = 0,
      minZ = 0,
      maxZ = 0;
    for (let i = 0; i < h; i++) {
      const x = column.profile[i * 4],
        z = column.profile[i * 4 + 1];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    this.offset.set((minX + maxX) / 2, (minZ + maxZ) / 2);
    this.root.scale.set(2 * o.radius[0] + maxX - minX, column.height, 2 * o.radius[1] + maxZ - minZ);
    const points: number[] = [],
      indices: number[] = [];
    for (let i = 0; i < slices; i++) {
      const z = (i + 0.5) / slices - 0.5,
        k = i * 4;
      points.push(-0.5, -0.5, z, 0.5, -0.5, z, 0.5, 0.5, z, -0.5, 0.5, z);
      indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.geometry.setIndex(indices);
    const { float, vec2, vec3, mix, texture, smoothstep, positionWorld: p } = TSL;
    const f = float(o.baseY).sub(p.y).div(column.height).saturate();
    const level = f.mul(h - 1),
      i = level.floor().min(h - 2);
    const at = (index: N) => texture(this.profile, vec2(index.add(0.5).div(h), 0.5)).level(0);
    const air = mix(at(i), at(i.add(1)), level.sub(i));
    const uv = p.xz
      .sub(this.center)
      .sub(air.xy)
      .div(vec2(...o.radius))
      .mul(0.5)
      .add(0.5);
    const source = texture(this.source, uv.mul((n - 1) / n).add(0.5 / n)).level(0).r;
    const diameter2 = source
      .mul(0.53)
      .add(0.47)
      .mul(o.dropDiameterMm ** 2);
    const area = float(1).sub(air.z.div(diameter2)).max(0);
    // Drop count at the source is fixed. Apparent extinction depends on surviving projected area.
    const coefficient = source
      .mul(area)
      .div(diameter2.sqrt())
      .mul((3 * o.rainMmHour) / (3600 * o.fallSpeed));
    const ray = p.sub(TSL.cameraPosition).normalize();
    const toSun = TSL.dot(ray, frame.sunDirection).max(0);
    const fill = frame.skyHorizon
      .mul(0.31)
      .add(frame.skyZenith.mul(0.19))
      .add(vec3(0.003, 0.004, 0.006));
    this.material.colorNode = fill
      .add(sunlightAtHeight(p.y).mul(frame.sunVisibility).mul(toSun.pow(5).mul(0.24).add(0.035)))
      .mul(TSL.color(tint));
    // Optically thin filaments drift along the slanted fall path. The coarse silhouette
    // still comes from the same flux that the game samples.
    const stream = TSL.vec3(uv.x.mul(46).add(uv.y.mul(8)), uv.y.mul(15), f.mul(3).sub(this.clock.mul(0.027)));
    const ribbon = TSL.mx_noise_float(stream);
    const thread = TSL.sin(uv.x.mul(150).add(uv.y.mul(64)).add(ribbon.mul(3)).add(f.mul(8)));
    const optical = coefficient
      .mul(this.step)
      .mul(ribbon.mul(0.43).add(thread.mul(0.11)).add(1))
      .mul(smoothstep(0, 0.07, f));
    this.material.opacityNode = float(1).sub(TSL.exp(optical.negate()));
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.forceSinglePass = true;
    this.material.side = THREE.DoubleSide;
    this.material.fog = false;
    this.material.mrtNode = auxPassthrough();
    this.root.add(this.mesh);
    this.root.name = 'Sub-cloud rain';
  }

  update(camera: THREE.Camera, seconds: number) {
    const c = this.column,
      o = c.options;
    this.clock.value = seconds;
    this.center.value.set(o.center[0] + c.motion[0] * seconds, o.center[1] + c.motion[1] * seconds);
    this.root.position.set(
      this.center.value.x + this.offset.x,
      (o.baseY + o.minimumY) * 0.5,
      this.center.value.y + this.offset.y,
    );
    if (this.version !== c.profileVersion) {
      this.profile.needsUpdate = true;
      this.version = c.profileVersion;
    }
    camera.getWorldPosition(this.observer);
    const d = this.direction.subVectors(this.observer, this.root.position),
      s = this.root.scale;
    if (Math.abs(d.x) <= s.x * 0.5 && Math.abs(d.y) <= s.y * 0.5 && Math.abs(d.z) <= s.z * 0.5)
      camera.getWorldDirection(d).negate();
    d.normalize();
    const x = Math.abs(d.x) / s.x,
      y = Math.abs(d.y) / s.y,
      z = Math.abs(d.z) / s.z;
    // Choose the axis with the densest samples along the viewing ray; draw back to front.
    if (x >= y && x >= z) this.mesh.rotation.set(0, d.x >= 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    else if (y >= z) this.mesh.rotation.set(d.y >= 0 ? -Math.PI / 2 : Math.PI / 2, 0, 0);
    else this.mesh.rotation.set(0, d.z >= 0 ? 0 : Math.PI, 0);
    this.step.value = 1 / (this.slices * Math.max(x, y, z, 1e-8));
  }

  dispose() {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.source.dispose();
    this.profile.dispose();
  }
}
