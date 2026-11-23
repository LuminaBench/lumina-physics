/**
 * Procedural branching lightning.
 *
 * Bolts are grown as recursive Lichtenberg figures (midpoint displacement for the leader,
 * probabilistic forks that inherit a fraction of the channel's power), rendered as
 * camera-facing ribbons with an opaque HDR core (so they appear in screen-space
 * reflections on water and wet asphalt) plus an additive glow. A strike flickers through
 * several return strokes, lights the volumetric clouds from inside, flashes the scene and
 * emits a world-space lightning event.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxPassthrough } from '../../engine/frame';
import { mulberry32 } from '../../engine/noise';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { Weather } from './weather';

const { Fn, float, vec3, vec4, uniform, attribute, cameraPosition, normalize, cross, mix, length, exp, abs, max, smoothstep } = TSL;

export interface BoltSegment { a: THREE.Vector3; b: THREE.Vector3; power: number }

/** Grow a branching bolt between two points. Pure function – reusable for arcs of any scale. */
export function growBolt(start: THREE.Vector3, end: THREE.Vector3, options: { seed?: number; jaggedness?: number; branching?: number; depth?: number } = {}): BoltSegment[] {
  const rand = mulberry32(options.seed ?? Math.floor(Math.random() * 1e9));
  const jag = options.jaggedness ?? 0.22;
  const branching = options.branching ?? 0.28;
  const segments: BoltSegment[] = [];
  const channel = (a: THREE.Vector3, b: THREE.Vector3, power: number, depth: number) => {
    // Midpoint displacement: 2^levels jagged segments.
    let pts = [a.clone(), b.clone()];
    const levels = Math.max(3, Math.min(7, Math.round(Math.log2(a.distanceTo(b) / 6) + 2)));
    let offset = a.distanceTo(b) * jag;
    for (let l = 0; l < levels; l++) {
      const next: THREE.Vector3[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const mid = pts[i].clone().lerp(pts[i + 1], 0.5);
        mid.x += (rand() - 0.5) * offset; mid.z += (rand() - 0.5) * offset; mid.y += (rand() - 0.5) * offset * 0.35;
        next.push(pts[i], mid);
      }
      next.push(pts[pts.length - 1]);
      pts = next;
      offset *= 0.52;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      segments.push({ a: pts[i], b: pts[i + 1], power });
      // Forks leave the channel at a shallow angle and die out before reaching the ground.
      if (depth > 0 && i > 2 && i < pts.length - 3 && rand() < branching * (depth === (options.depth ?? 3) ? 0.3 : 0.18)) {
        const remaining = pts[pts.length - 1].clone().sub(pts[i]);
        const len = remaining.length() * (0.25 + rand() * 0.45);
        const dir = remaining.normalize();
        dir.x += (rand() - 0.5) * 1.5; dir.z += (rand() - 0.5) * 1.5; dir.y *= 0.55 + rand() * 0.4;
        channel(pts[i], pts[i].clone().addScaledVector(dir.normalize(), len), power * (0.3 + rand() * 0.25), depth - 1);
      }
    }
  };
  channel(start, end, 1, options.depth ?? 3);
  return segments;
}

/** Build a ribbon geometry (4 vertices per segment) expanded in the vertex shader. */
export function boltGeometry(segments: BoltSegment[]): THREE.BufferGeometry {
  const n = segments.length;
  const start = new Float32Array(n * 12), end = new Float32Array(n * 12), corner = new Float32Array(n * 8), power = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  segments.forEach((s, i) => {
    for (let v = 0; v < 4; v++) {
      // (Direct writes: array literals here were two megabytes of garbage per strike.)
      const o = i * 12 + v * 3;
      start[o] = s.a.x; start[o + 1] = s.a.y; start[o + 2] = s.a.z;
      end[o] = s.b.x; end[o + 1] = s.b.y; end[o + 2] = s.b.z;
      corner[i * 8 + v * 2] = v >> 1; corner[i * 8 + v * 2 + 1] = (v & 1) * 2 - 1;
      power[i * 4 + v] = s.power;
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(start.slice(), 3));
  g.setAttribute('segStart', new THREE.BufferAttribute(start, 3));
  g.setAttribute('segEnd', new THREE.BufferAttribute(end, 3));
  g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('power', new THREE.BufferAttribute(power, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/** Ribbon material: `width` in metres (scaled up with distance so far bolts stay visible). */
export function boltMaterial(intensity: N, color: N, width: number, glow: boolean): THREE.NodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.DoubleSide;
  material.fog = false;
  const segStart = attribute('segStart', 'vec3'), segEnd = attribute('segEnd', 'vec3');
  const corner = attribute('corner', 'vec2'), power = attribute('power', 'float');
  const p = mix(segStart, segEnd, corner.x);
  const eyeLocal = TSL.modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const toCamera = eyeLocal.sub(p);
  const dist = length(toCamera);
  const side = normalize(cross(normalize(segEnd.sub(segStart)), toCamera.div(dist)).add(vec3(1e-5, 0, 0)));
  const w = float(width).mul(power.sqrt()).mul(dist.mul(glow ? 0.0045 : 0.0009).add(1));
  // Slight overlap along the segment hides ribbon joints.
  const along = normalize(segEnd.sub(segStart)).mul(corner.x.mul(2).sub(1)).mul(w.mul(0.5));
  material.positionNode = p.add(side.mul(corner.y).mul(w)).add(along);
  const across = corner.y.toVarying('boltAcross');
  const vPower = power.toVarying('boltPower');
  if (glow) {
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.colorNode = Fn(() => {
      const halo = exp(abs(across).mul(-5.5));
      return vec4(color.mul(intensity).mul(vPower).mul(halo).mul(0.35), halo);
    })();
    material.mrtNode = auxPassthrough();
  } else {
    material.colorNode = Fn(() => {
      const core = smoothstep(1.0, 0.25, abs(across));
      return vec4(mix(color, vec3(1), 0.7).mul(intensity).mul(vPower.mul(0.7).add(0.3)).mul(core.mul(0.8).add(0.2)), 1);
    })();
  }
  return material;
}

interface ActiveStrike { group: THREE.Group; age: number; active: boolean; strokes: number[]; position: THREE.Vector3; power: number }

export class Lightning implements EngineModule {
  /** Mean strikes per minute when `auto` is on (scaled by the weather's storm level). */
  rate = 9;
  auto = true;
  /** Horizontal range (m) for automatic strikes around the camera. */
  range: [number, number] = [350, 2200];
  readonly light = new THREE.PointLight(0xbfd4ff, 0, 0, 1.6);
  /** Current flash intensity 0..~1.5 (for UI / other modules). */
  intensity = 0;
  private readonly strikes: ActiveStrike[] = [];
  private nextTemplate = 0;
  private readonly skyBoost = new THREE.Color();
  private uIntensity = uniform(0);
  private uColor = uniform(new THREE.Color(0.72, 0.82, 1.0));
  private coreMaterial: THREE.NodeMaterial;
  private glowMaterial: THREE.NodeMaterial;
  private cooldown = 2;
  /** Ground / sea level strikes terminate at. */
  groundY = 0;
  onStrike: ((position: THREE.Vector3) => void) | null = null;

  constructor(private engine: LuminaEngine, private weather: Weather) {
    this.coreMaterial = boltMaterial(this.uIntensity.mul(140), this.uColor, 0.55, false);
    this.glowMaterial = boltMaterial(this.uIntensity.mul(60), this.uColor, 9, true);
    engine.scene.add(this.light);
    // Generate the branching topology during scene setup. Rotation and height vary per strike.
    for (let i = 0; i < 6; i++) {
      const origin = new THREE.Vector3();
      const sky = new THREE.Vector3((Math.random() - 0.5) * 440, 1000, (Math.random() - 0.5) * 440);
      const geometry = boltGeometry(growBolt(sky, origin, { seed: 401 + i * 79, branching: 0.3 }));
      const group = new THREE.Group();
      const core = new THREE.Mesh(geometry, this.coreMaterial);
      const glow = new THREE.Mesh(geometry, this.glowMaterial);
      glow.renderOrder = 26;
      core.frustumCulled = glow.frustumCulled = false;
      group.add(core, glow);
      group.visible = false;
      engine.scene.add(group);
      this.strikes.push({ group, active: false, age: 0, power: 0, strokes: [0, 0, 0, 0], position: new THREE.Vector3() });
    }
    const warm = this.strikes[0].group.clone();
    warm.visible = true;
    engine.prewarm(warm);
  }

  /** Trigger a strike. Without a target it lands at a random spot around the camera. */
  strike(target?: THREE.Vector3, power = 1): THREE.Vector3 {
    const { camera, events } = this.engine;
    const end = target?.clone() ?? new THREE.Vector3();
    if (!target) {
      end.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const angle = Math.atan2(end.z, end.x) + (Math.random() - 0.5) * 1.9;
      const range = THREE.MathUtils.lerp(this.range[0], this.range[1], Math.random() ** 1.4);
      end.set(camera.position.x + Math.cos(angle) * range, this.groundY, camera.position.z + Math.sin(angle) * range);
    }
    const s = this.strikes[this.nextTemplate];
    this.nextTemplate = (this.nextTemplate + 1) % this.strikes.length;
    const height = Math.max(1, this.weather.params.cloudBase + 220 - end.y);
    s.group.position.copy(end);
    s.group.scale.set(1, height / 1000, 1);
    s.group.rotation.y = Math.random() * 2 * Math.PI;
    s.position.copy(end).y += height * 0.5;
    s.active = true;
    s.age = 0;
    s.power = power;
    s.strokes.length = 2 + Math.floor(Math.random() * 3);
    for (let i = 1; i < s.strokes.length; i++) s.strokes[i] = s.strokes[i - 1] + 0.045 + Math.random() * 0.09;

    events.emitAt('lightning', end, power);
    this.onStrike?.(end);
    return end;
  }

  update(dt: number): void {
    const { camera } = this.engine;
    if (this.auto && this.weather.params.storm > 0.25) {
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this.strike();
        const perSecond = (this.rate * this.weather.params.storm) / 60;
        this.cooldown = -Math.log(1 - Math.random() * 0.98) / Math.max(perSecond, 1e-3);
      }
    }
    let total = 0;
    let dominant: ActiveStrike | null = null;
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if (!s.active) continue;
      s.age += dt;
      let level = 0;
      for (let j = 0; j < s.strokes.length; j++) {
        const t = s.strokes[j];
        if (s.age >= t) level += Math.exp(-(s.age - t) / 0.05) * (0.65 + 0.35 * Math.sin(t * 91.7) ** 2);
      }
      level *= s.power;
      if (s.age > s.strokes[s.strokes.length - 1] + 0.32) {
        s.group.visible = false;
        s.active = false;
        continue;
      }
      s.group.visible = level > 0.02;
      if (level > total) { dominant = s; }
      total = Math.max(total, level);
    }
    this.intensity = total;
    this.uIntensity.value = total;

    const cu = this.weather.cloudUniforms;
    const flashColor = cu.flashColor.value as THREE.Color;
    if (dominant) {
      (cu.flashPosition.value as THREE.Vector3).set(dominant.position.x, this.weather.params.cloudBase + 500, dominant.position.z);
      flashColor.setRGB(26 * total, 32 * total, 46 * total);
      this.light.position.copy(dominant.position);
      const d = dominant.position.distanceTo(camera.position);
      // Inverse-square so a strike 1 km away still throws hard light across the scene.
      this.light.intensity = total * 3.0 * d * d;
      const sceneFlash = Math.min(1, 900 / (d + 250));
      this.engine.flash(0xbcd2ff, total * 0.28 * sceneFlash, 26);
      // Custom-lit materials read these ambient uniforms: lift them for the flash.
      const boost = total * 1.6 * sceneFlash;
      this.skyBoost.setRGB(boost * 0.8, boost * 0.9, boost * 1.1);
      this.weather.scatterFlash(this.skyBoost);
    } else {
      flashColor.setRGB(0, 0, 0);
      this.light.intensity = 0;
    }
  }

  dispose(): void {
    for (const s of this.strikes) { s.group.removeFromParent(); (s.group.children[0] as THREE.Mesh).geometry.dispose(); }
    this.strikes.length = 0;
    this.light.removeFromParent();
    this.coreMaterial.dispose();
    this.glowMaterial.dispose();
    (this.weather.cloudUniforms.flashColor.value as THREE.Color).setRGB(0, 0, 0);
  }
}

export { max as _max };
