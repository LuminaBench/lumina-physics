import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';

export interface LocalProbeOptions {
  /** Capture centre and box half extents, in world metres. */
  center: THREE.Vector3;
  halfSize: THREE.Vector3;
  /** Three.js layer containing the opaque objects and lights to capture. */
  layer: number;
  resolution?: number;
  /** Seconds between completed captures, subject to one face per frame. */
  refreshSeconds?: number;
}

/** A small local cubemap for opaque off-screen geometry. Empty pixels leave the weather sky visible. */
export class LocalReflectionProbe {
  readonly center: THREE.Vector3;
  readonly halfSize: THREE.Vector3;
  readonly layer: number;
  enabled = true;
  refreshSeconds: number;
  private readonly targets: [THREE.CubeRenderTarget, THREE.CubeRenderTarget];
  private readonly camera: THREE.CubeCamera;
  private readonly texture: N;
  private readonly active = TSL.uniform(0);
  private readonly capturedCenter = TSL.uniform(new THREE.Vector3());
  private readonly capturedSize = TSL.uniform(new THREE.Vector3(1, 1, 1));
  private readonly captureSize = new THREE.Vector3();
  private readonly previousColor = new THREE.Color();
  private face = 0;
  private writeIndex = 0;
  private untilFace = 0;
  private readonly maxLod: number;

  constructor(options: LocalProbeOptions) {
    const resolution = options.resolution ?? 64;
    if (!Number.isInteger(options.layer) || options.layer < 1 || options.layer > 31 ||
        !Number.isInteger(resolution) || resolution < 16 || resolution > 256 || (resolution & (resolution - 1)) ||
        !options.center.toArray().every(Number.isFinite) || !options.halfSize.toArray().every(x => Number.isFinite(x) && x > 0) ||
        !Number.isFinite(options.refreshSeconds ?? 0.6) || (options.refreshSeconds ?? 0.6) < 0) {
      throw new RangeError('Local probes require finite bounds, layer 1–31, a power-of-two size of 16–256 and a nonnegative refresh interval.');
    }
    this.layer = options.layer;
    this.center = options.center.clone();
    this.halfSize = options.halfSize.clone();
    this.refreshSeconds = options.refreshSeconds ?? 0.6;
    this.maxLod = Math.log2(resolution);
    const target = () => new THREE.CubeRenderTarget(resolution, {
      type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.targets = [target(), target()];
    this.texture = TSL.cubeTexture(this.targets[1].texture);
    this.camera = new THREE.CubeCamera(0.08, this.halfSize.length() * 2, this.targets[0]);
    this.camera.layers.set(this.layer);
  }

  /** Box projection keeps nearby reflected walls and hulls anchored as the viewer moves. */
  reflection(position: N, direction: N, lod: N, sky: N): N {
    const t = TSL;
    return t.Fn(() => {
      const radiance = sky.toVar();
      const local = position.sub(this.capturedCenter);
      const extent = this.capturedSize;
      const edge = t.abs(local).div(extent);
      const influence = t.smoothstep(0.75, 1, t.max(edge.x, t.max(edge.y, edge.z))).oneMinus().mul(this.active);
      t.If(influence.greaterThan(0.001), () => {
        const sign = direction.greaterThanEqual(t.vec3(0)).select(t.vec3(1), t.vec3(-1));
        const exit = extent.sub(local.mul(sign)).div(t.abs(direction).max(0.00001));
        const projected = local.add(direction.mul(t.min(exit.x, t.min(exit.y, exit.z))));
        const sample = this.texture.sample(projected).level(lod.clamp(0, this.maxLod));
        // The clear background is transparent black. Filtered edge and mip RGB
        // are already premultiplied by coverage in the captured texture.
        radiance.assign(sky.mul(t.float(1).sub(sample.a.mul(influence))).add(sample.rgb.mul(influence)));
      });
      return radiance;
    })();
  }

  private positionCamera(renderer: THREE.WebGPURenderer): void {
    const cube = this.camera;
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    cube.position.copy(this.center);
    this.captureSize.copy(this.halfSize);
    const far = this.halfSize.length() * 2;
    for (const child of cube.children) {
      const camera = child as THREE.PerspectiveCamera;
      if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
    }
    cube.updateMatrixWorld(true);
  }

  /** Compile the capture-layer materials during loading, with the renderer stopped.
   * The cubemap has a different attachment layout from the main scene's MRT. */
  async prepare(renderer: THREE.WebGPURenderer, scene: THREE.Scene): Promise<void> {
    this.positionCamera(renderer);
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const mrt = renderer.getMRT(), background = scene.background, backgroundNode = scene.backgroundNode;
    const uncull: THREE.Mesh[] = [];
    scene.traverseVisible(object => {
      if (object instanceof THREE.Mesh && object.frustumCulled && object.layers.test(this.camera.layers)) {
        uncull.push(object);
        object.frustumCulled = false;
      }
    });
    try {
      scene.background = null; scene.backgroundNode = null;
      renderer.setMRT(null);
      renderer.setRenderTarget(this.targets[this.writeIndex], 0);
      await renderer.compileAsync(scene, this.camera.children[0] as THREE.PerspectiveCamera);
    } finally {
      renderer.setRenderTarget(target, face, mip); renderer.setMRT(mrt);
      scene.background = background; scene.backgroundNode = backgroundNode;
      for (const mesh of uncull) mesh.frustumCulled = true;
    }
  }

  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, dt: number): void {
    if (!this.enabled) { this.active.value = 0; this.face = 0; this.untilFace = 0; return; }
    this.untilFace -= dt;
    if (this.untilFace > 0) return;
    this.untilFace = Math.max(0, this.refreshSeconds) / 6;
    const target = this.targets[this.writeIndex], cube = this.camera;
    if (this.face === 0) this.positionCamera(renderer);
    const previous = renderer.getRenderTarget(), prevFace = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    const mrt = renderer.getMRT(), alpha = renderer.getClearAlpha(), autoClear = renderer.autoClear;
    const background = scene.background, backgroundNode = scene.backgroundNode;
    const xr = renderer.xr.enabled;
    renderer.getClearColor(this.previousColor);
    try {
      scene.background = null; scene.backgroundNode = null;
      renderer.xr.enabled = false;
      renderer.setMRT(null); renderer.autoClear = true; renderer.setClearColor(0, 0);
      target.texture.mipmapsAutoUpdate = this.face === 5;
      renderer.setRenderTarget(target, this.face);
      renderer.render(scene, cube.children[this.face] as THREE.PerspectiveCamera);
    } finally {
      renderer.setRenderTarget(previous, prevFace, prevMip); renderer.setMRT(mrt);
      renderer.setClearColor(this.previousColor, alpha); renderer.autoClear = autoClear;
      renderer.xr.enabled = xr;
      scene.background = background; scene.backgroundNode = backgroundNode;
    }
    if (++this.face === 6) {
      this.face = 0;
      this.texture.value = target.texture;
      this.capturedCenter.value.copy(cube.position);
      this.capturedSize.value.copy(this.captureSize);
      this.writeIndex = 1 - this.writeIndex;
      this.active.value = 1;
    }
  }

  dispose(): void { for (const target of this.targets) target.dispose(); }
}
