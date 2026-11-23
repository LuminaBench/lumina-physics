import * as THREE from 'three/webgpu';
import { RescueHelicopter } from './rescue-helicopter';
import { mergeStaticMeshes } from '../../engine/batching';
import { TSL, type N } from '../../engine/tsl';
import { spriteNoise } from '../../engine/noise';
import { RotorWash } from '../../modules/aero/rotor-wash';
import { FloodableVessel, type HullCompartment } from '../../modules/water/floodable-vessel';
import type { LuminaEngine, EngineModule } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Ocean } from '../../modules/water/ocean';
import type { RigidBody } from '../../engine/physics';
import type { Panel } from '../ui';

function launchHull(waterline: N): THREE.Group {
  const g = new THREE.Group(),
    positions: number[] = [],
    indices: number[] = [];
  const sections = [
    [-2.75, 0.12, 0.55],
    [-2.1, 0.71, 0.33],
    [-1.05, 0.98, 0.26],
    [0.55, 1.02, 0.25],
    [2.23, 0.89, 0.29],
    [2.43, 0.82, 0.32],
  ];
  for (const [z, w, deck] of sections)
    positions.push(-w, deck, z, -w * 0.77, -0.2, z, 0, -0.5, z, w * 0.77, -0.2, z, w, deck, z);
  for (let j = 0; j < sections.length - 1; j++)
    for (let x = 0; x < 4; x++) {
      const a = j * 5 + x;
      indices.push(a, a + 1, a + 5, a + 1, a + 6, a + 5);
    }
  for (let j = 0; j < sections.length - 1; j++) {
    const a = j * 5;
    indices.push(a, a + 5, a + 4, a + 4, a + 5, a + 9);
  }
  for (const a of [0, (sections.length - 1) * 5])
    indices.push(a, a + 1, a + 2, a, a + 2, a + 3, a, a + 3, a + 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const blue = new THREE.MeshStandardNodeMaterial({
    color: 0x344d58,
    metalness: 0.52,
    roughness: 0.41,
    side: THREE.DoubleSide,
  });
  const trim = new THREE.MeshStandardNodeMaterial({ color: 0xddded2, roughness: 0.44, metalness: 0.26 });
  const glass = new THREE.MeshPhysicalNodeMaterial({
    color: 0xaec4c8, roughness: 0.075, metalness: 0, clearcoat: 1, ior: 1.52,
    transparent: true, depthWrite: false,
  });
  const facing = TSL.abs(TSL.dot(TSL.normalView, TSL.positionViewDirection));
  glass.opacityNode = facing.oneMinus().pow(4).mul(0.66).add(0.16);
  const p = TSL.positionLocal;
  const grain = spriteNoise(TSL.vec2(p.z.mul(2.6), p.y.mul(9)));
  const paint = TSL.mix(
    TSL.vec3(0.033, 0.048, 0.057),
    TSL.vec3(0.022, 0.113, 0.16),
    TSL.smoothstep(-0.16, 0.015, p.y)
  );
  const stripe = TSL.smoothstep(0.021, 0.026, p.y).mul(TSL.smoothstep(0.068, 0.062, p.y));
  const freeboard = TSL.dot(TSL.vec4(TSL.positionWorld, 1), waterline);
  const wet = TSL.smoothstep(0.20, 0.015, freeboard.add(grain.sub(0.5).mul(0.05)));
  blue.colorNode = TSL.mix(paint, TSL.vec3(0.61, 0.63, 0.59), stripe)
    .mul(grain.mul(0.12).add(0.94)).mul(wet.mul(-0.24).add(1));
  blue.roughnessNode = TSL.float(0.24)
    .add(grain.mul(0.15))
    .add(TSL.smoothstep(0.05, 0.28, p.y).mul(0.11)).mul(wet.mul(-0.44).add(1));
  g.add(new THREE.Mesh(geo, blue));
  const rubber = new THREE.MeshStandardMaterial({ color: 0x242b2b, roughness: 0.83 });
  const rail = new THREE.MeshStandardMaterial({ color: 0xa6adab, metalness: 0.79, roughness: 0.3 });
  const deck = new THREE.MeshStandardMaterial({ color: 0x72746a, metalness: 0.2, roughness: 0.78 });
  const safety = new THREE.MeshStandardMaterial({ color: 0xc84417, roughness: 0.59 });
  const nav = new THREE.MeshStandardMaterial({ color: 0xf5d0a3, emissive: 0xffac72, emissiveIntensity: 1.8 });
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const rod = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) => {
    const vector = b.clone().sub(a),
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, vector.length(), 8), m);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.normalize());
    g.add(mesh);
  };
  const point = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (const side of [-1, 1]) {
    for (let i = 1; i < sections.length; i++) {
      const [za, wa, ha] = sections[i - 1],
        [zb, wb, hb] = sections[i];
      rod(point(side * wa, ha - 0.027, za), point(side * wb, hb - 0.027, zb), 0.043, rubber);
      rod(point(side * wa, ha + 0.04, za), point(side * wb, hb + 0.04, zb), 0.027, rail);
      if (i <= 2) {
        rod(point(side * wa, ha + 0.4, za), point(side * wb, hb + 0.4, zb), 0.017, rail);
        rod(point(side * wb, hb, zb), point(side * wb, hb + 0.4, zb), 0.017, rail);
      }
    }
    for (const z of [0.82, 1.76]) {
      const w = 0.99 - (z - 0.65) * 0.065;
      rod(point(side * w, 0.31, z - 0.08), point(side * (w + 0.09), 0.15, z), 0.012, trim);
      const fender = new THREE.Mesh(new THREE.CapsuleGeometry(0.061, 0.19, 4, 10), rubber);
      fender.position.set(side * (w + 0.075), 0.1, z);
      fender.rotation.x = -0.11;
      g.add(fender);
    }
  }
  box(0, 0.292, 1.18, 1.48, 0.045, 1.85, deck);
  box(0, 0.34, 1.3, 0.68, 0.055, 0.71, rubber);
  box(0, 0.377, 1.3, 0.63, 0.025, 0.66, deck);
  for (let i = 0; i < 5; i++) box(0, 0.394, 1.1 + i * 0.1, 0.51, 0.014, 0.018, rail);
  box(0, 0.52, -0.49, 1.35, 0.48, 1.34, trim);
  // Four panes leave a visible helm and seats inside the glazed wheelhouse.
  const windshield = box(0, 1.01, -1.10, 1.24, 0.51, 0.012, glass);
  windshield.rotation.x = 0.16;
  box(0, 1.01, 0.04, 1.24, 0.49, 0.012, glass);
  for (const side of [-1, 1]) {
    box(side * 0.635, 1.01, -0.51, 0.012, 0.49, 1.07, glass);
    box(side * 0.29, 0.81, -0.28, 0.31, 0.07, 0.35, rubber);
    box(side * 0.29, 0.94, -0.11, 0.31, 0.27, 0.055, rubber);
  }
  const consoleTop = box(0, 0.86, -0.90, 1.12, 0.14, 0.23, rubber);
  consoleTop.rotation.x = -0.16;
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.012, 6, 16), rail);
  wheel.position.set(0.29, 0.927, -0.75); wheel.rotation.x = -0.38; g.add(wheel);
  for (const side of [-1, 1]) {
    rod(point(side * 0.67, 0.73, -1.2), point(side * 0.615, 1.28, -1.08), 0.032, trim);
    rod(point(side * 0.65, 0.74, 0.035), point(side * 0.62, 1.28, 0.05), 0.034, trim);
    box(side * 0.643, 1.01, -0.46, 0.044, 0.47, 0.039, trim);
  }
  rod(point(0, 0.75, -1.13), point(0, 1.27, -1.1), 0.017, rubber);
  box(0, 1.285, -0.49, 1.46, 0.085, 1.53, trim);
  box(0, 1.342, -0.49, 1.29, 0.035, 1.35, deck);
  rod(point(0, 1.35, -0.28), point(0, 1.91, -0.21), 0.026, rail);
  rod(point(0, 1.48, -0.26), point(0.04, 2.17, -0.34), 0.008, rail);
  box(0, 1.93, -0.21, 0.085, 0.1, 0.089, nav);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.047, 8, 24), safety);
  ring.position.set(-0.69, 0.67, -0.22);
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  box(0, 0.52, 2.29, 1.56, 0.22, 0.07, trim);
  mergeStaticMeshes(g);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}
export class CoastRescue implements EngineModule {
  readonly rotor: RotorWash;
  vessel?: FloodableVessel;
  get followingBoat(): boolean {
    return !!this.boat && this.focus === this.boat.position;
  }
  focus: THREE.Vector3 | null = null;
  private helicopter: RescueHelicopter | null = null;
  private boat: THREE.Group | null = null;
  private readonly waterline = TSL.uniform(new THREE.Vector4(0, 1, 0, 1e5));
  private boatBody: RigidBody | null = null;
  private readonly station = new THREE.Vector3();
  private mode: 'water' | 'sand' = 'water';
  private hovering = false;
  constructor(
    private engine: LuminaEngine,
    fx: EffectsKit,
    private ocean: Ocean,
    private ground: (x: number, z: number) => number,
    panel: Panel,
    private anchor: THREE.Vector3
  ) {
    this.rotor = new RotorWash(engine, fx);
    panel.section('Coastal rescue');
    panel.buttons([
      { label: 'Hover over water', onClick: () => this.hover('water') },
      { label: 'Hover over beach', onClick: () => this.hover('sand') },
      { label: 'Stop rotor', onClick: () => this.stop() },
    ]);
    panel.buttons([
      { label: 'Launch workboat', onClick: () => this.launch() },
      { label: 'Flood port compartment', onClick: () => this.flood() },
      {
        label: 'Return to floatplane',
        onClick: () => {
          this.focus = null;
        },
      },
    ]);
  }
  hover(mode: 'water' | 'sand'): void {
    if (!this.helicopter) {
      this.helicopter = new RescueHelicopter();
      this.engine.scene.add(this.helicopter.group);
    }
    this.mode = mode;
    this.hovering = true;
    this.helicopter.group.visible = true;
    this.station.set(this.anchor.x - 34, 0, this.anchor.z - 30);
    if (mode === 'sand') {
      let best = Infinity;
      for (let z = -40; z <= 150; z += 5)
        for (let x = 125; x <= 380; x += 5) {
          const h = this.ground(x, z);
          const score = Math.abs(h - 0.83) + Math.hypot(x - this.anchor.x, z - this.anchor.z) * 0.0003;
          if (h > 0.35 && score < best) {
            best = score;
            this.station.set(x, h, z);
          }
        }
    } else this.station.y = this.ocean.heightAt(this.station.x, this.station.z);
    this.focus = this.station;
  }
  stop(): void {
    this.hovering = false;
    if (this.helicopter) this.helicopter.group.visible = false;
    this.rotor.stop();
    this.focus = null;
  }
  launch(): void {
    if (!this.boat) {
      this.boat = launchHull(this.waterline);
      this.engine.scene.add(this.boat);
      const physics = this.engine.physics,
        R = physics.RAPIER;
      const x = this.anchor.x + 24,
        z = this.anchor.z - 38,
        y = this.ocean.heightAt(x, z);
      this.boatBody = physics.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(x, y + 0.24, z)
          .setLinearDamping(0.16)
          .setAngularDamping(1.26)
      );
      physics.world.createCollider(R.ColliderDesc.cuboid(0.91, 0.32, 2.29).setMass(1200), this.boatBody);
      physics.bind(this.boatBody, this.boat);
      const compartments: HullCompartment[] = [];
      for (const side of [-1, 1])
        for (const end of [-1, 1])
          compartments.push({ center: new THREE.Vector3(side * 0.67, -0.16, end * 1.28), volume: 0.51 });
      this.vessel = this.engine.add(
        new FloodableVessel(this.engine, this.boatBody, { draft: 0.78, compartments })
      );
      this.waterline.value = this.vessel.waterline;
      this.boat.position.set(x, y + 0.24, z);
    }
    this.focus = this.boat.position;
  }
  flood(): void {
    this.launch();
    this.vessel!.damage(0, 0.18);
    this.vessel!.damage(1, 0.1);
  }
  update(dt: number, time: number): void {
    if (!this.hovering || !this.helicopter) return;
    const p = this.helicopter.group.position;
    p.copy(this.station);
    p.y += 5.4 + 0.14 * Math.sin(time * 1.7);
    this.helicopter.update(dt, time);
    this.rotor.step(p, 4.65, 0.95, dt, this.mode, this.station.y);
  }
  dispose(): void {
    this.rotor.dispose();
    if (this.boatBody) {
      this.engine.physics.unbind(this.boatBody);
      this.engine.physics.world.removeRigidBody(this.boatBody);
    }
    const mats = new Set<THREE.Material>();
    this.helicopter?.dispose();
    const g = this.boat;
    if (g) {
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          mats.add(o.material);
        }
      });
      g.removeFromParent();
    }
    for (const m of mats) m.dispose();
  }
}
