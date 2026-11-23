import * as THREE from 'three/webgpu';
import { TSL as t } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { mulberry32, spriteNoise } from '../../engine/noise';
import type { LuminaEngine } from '../../engine/engine';

/** Connected folds of water at the base of a fountain. The fine droplets use the regular spray pool. */
function fountainSheets(): THREE.BufferGeometry {
  const random = mulberry32(57318);
  const positions: number[] = [], uvs: number[] = [], lobes: number[] = [], indices: number[] = [];
  const count = 17, rows = 13, columns = 5;
  for (let lobe = 0; lobe < count; lobe++) {
    const tall = lobe < 9;
    const angle = Math.PI * 2 * (lobe / (tall ? 9 : 8) + random() * 0.06);
    const height = tall ? 9 + 12 * random() : 3.2 + 4.6 * random();
    const reach = tall ? 1.1 + 2.5 * random() : 3.6 + 3.4 * random();
    const width = tall ? 0.13 + 0.23 * random() : 0.21 + 0.26 * random();
    const seed = random(), first = positions.length / 3;
    for (let row = 0; row <= rows; row++) {
      const v = row / rows;
      for (let col = 0; col <= columns; col++) {
        const u = col / columns, across = u * 2 - 1;
        const a = angle + across * width * (1.35 - 0.46 * v) + v * v * Math.sin(seed * 23) * 0.11;
        const fold = Math.cos(across * 4.3 + v * 2 + seed * 18);
        const distance = 0.21 + v * reach * (0.62 + 0.38 * v) + (0.09 + 0.22 * v) * fold;
        const crest = 0.73 + 0.24 * (1 - across * across) + 0.055 * Math.sin(seed * 31 + u * 8);
        positions.push(Math.sin(a) * distance, height * v * crest, Math.cos(a) * distance);
        uvs.push(u, v);
        lobes.push(seed);
        if (row < rows && col < columns) {
          const n = first + row * (columns + 1) + col;
          indices.push(n, n + 1, n + columns + 1, n + 1, n + columns + 2, n + columns + 1);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('lobe', new THREE.Float32BufferAttribute(lobes, 1));
  geometry.setIndex(indices);
  return geometry;
}

export class GeyserSheets {
  private readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  private readonly age = t.uniform(0);
  private elapsed = Infinity;

  constructor(engine: LuminaEngine) {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false });
    mat.forceSinglePass = true;
    const age = this.age;
    const grain = t.attribute('lobe', 'float');
    const st = t.uv();
    // Each sheet rises, curls outwards and falls at a different time. The base
    // stays at the waterline as the detached tips break into the spray particles.
    const phase = age.sub(grain.mul(0.11)).div(grain.mul(0.6).add(1.9)).clamp(0, 1);
    const lift = t.sin(phase.mul(Math.PI)).max(0);
    const radialScale = phase.mul(1.23).add(0.58);
    const p = t.positionGeometry;
    mat.positionNode = t.vec3(p.x.mul(radialScale), p.y.mul(lift).sub(0.16), p.z.mul(radialScale));
    mat.colorNode = t.Fn(() => {
      const seed = grain.toVarying(), coordinate = st;
      const flow = t.vec2(coordinate.x.mul(5).add(seed.mul(43)), coordinate.y.mul(3.6).sub(age.mul(2.8)));
      const rib = spriteNoise(flow);
      const beads = spriteNoise(flow.mul(t.vec2(3.4, 2.3)).add(seed.mul(11)), 1);
      const edges = t.smoothstep(0, 0.14, coordinate.x).mul(t.smoothstep(1, 0.83, coordinate.x));
      const top = t.smoothstep(1, 0.76, coordinate.y.add(rib.sub(0.5).mul(0.32)));
      const veil = t.smoothstep(0.16, 0.84, rib.mul(0.74).add(beads.mul(0.26)));
      const foam = t.smoothstep(0.35, 0.88, rib.mul(0.53).add(beads.mul(0.47)).add(coordinate.y.mul(0.13)));
      const light = frame.skyHorizon.mul(0.42).add(frame.sunColor.mul(frame.sunVisibility).mul(0.38));
      const color = t.mix(t.vec3(0.16, 0.35, 0.38), t.vec3(0.91, 0.97, 0.98), foam).mul(light);
      const solidZ = t.perspectiveDepthToViewZ(engine.pipeline.sceneDepth.sample(t.screenUV).r, t.cameraNear, t.cameraFar);
      const intersection = t.smoothstep(0, 0.52, t.positionView.z.sub(solidZ));
      const fade = t.smoothstep(0, 0.15, phase).mul(t.smoothstep(1, 0.65, phase));
      return t.vec4(color, edges.mul(top).mul(veil).mul(fade).mul(intersection).mul(0.76));
    })();
    this.mesh = new THREE.Mesh(fountainSheets(), mat);
    this.mesh.name = 'aerated fountain sheets';
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    engine.pipeline.softScene.add(this.mesh);
    const warm = new THREE.Mesh(this.mesh.geometry, mat);
    warm.scale.setScalar(1e-5);
    engine.prewarm(warm, 3, engine.pipeline.softScene);
  }

  start(position: THREE.Vector3, size: number, seed: number): void {
    this.elapsed = 0;
    this.mesh.position.copy(position);
    this.mesh.rotation.y = seed * 2.39996;
    this.mesh.scale.set(size, Math.sqrt(size), size);
    this.mesh.visible = true;
    this.age.value = 0;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.age.value = this.elapsed += dt;
    this.mesh.visible = this.elapsed < 2.62;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
