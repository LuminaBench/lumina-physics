/**
 * Tire-track ribbons: the trace a contact patch leaves on the surface for a few seconds.
 *
 * On wet asphalt a tire squeegees the film away and leaves a pale, matte strip that the
 * rain closes again; after a puddle it lays a dark wet line on dry road. Both are the same
 * thing here: a ring buffer of quads on the ground whose opacity decays with age. All
 * contacts share one mesh (one draw call); lifting a wheel breaks its ribbon.
 */
import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame, auxPassthrough } from '../../engine/frame';
import type { LuminaEngine, EngineModule } from '../../engine/engine';

const { attribute, float, vec4, uniform, smoothstep, abs } = TSL;

export interface TrackOptions {
  /** Maximum number of ribbon points across all contacts. */
  capacity?: number;
  /** Seconds until a track has faded completely. */
  life?: number;
  width?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  /** Lift above the surface to avoid z-fighting (m). */
  lift?: number;
}

interface Contact { lastIndex: number; x: number; z: number; active: boolean }

export class TireTracks implements EngineModule {
  readonly mesh: THREE.Mesh;
  /** Points laid since creation (QA). */
  points = 0;
  life: number;
  private capacity: number;
  private positions: Float32Array;
  private birth: Float32Array;
  private side: Float32Array;
  private cursor = 0;
  private contacts = new Map<string, Contact>();
  private width: number;
  private lift: number;
  private uLife = uniform(6);
  private uOpacity = uniform(0.5);
  private geometry: THREE.BufferGeometry;

  constructor(private engine: LuminaEngine, options: TrackOptions = {}) {
    const capacity = this.capacity = options.capacity ?? 2048;
    this.life = options.life ?? 7;
    this.width = options.width ?? 0.24;
    this.lift = options.lift ?? 0.012;
    // Every point owns two vertices; consecutive points of one contact are joined by a quad.
    this.positions = new Float32Array(capacity * 2 * 3);
    this.birth = new Float32Array(capacity * 2).fill(-1e6);
    this.side = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
    const geometry = this.geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('birth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('side', new THREE.BufferAttribute(this.side, 1));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(capacity * 6), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
    const c = new THREE.Color(options.color ?? 0x0a0b0c);
    this.uOpacity.value = options.opacity ?? 0.5;
    const age = frame.time.sub(attribute('birth', 'float')).toVarying('trackAge');
    const across = attribute('side', 'float').toVarying('trackSide');
    // Soft edges; tracks fade out as the film closes back over them.
    const fade = float(1).sub(smoothstep(this.uLife.mul(0.25), this.uLife, age)).mul(smoothstep(1.0, 0.55, abs(across)));
    material.colorNode = vec4(c.r, c.g, c.b, fade.mul(this.uOpacity));
    material.mrtNode = auxPassthrough();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    this.mesh.name = 'lumina-tire-tracks';
    engine.scene.add(this.mesh);
  }

  /**
   * Extend the ribbon of contact `id` to a new position. `heading` is the direction of
   * travel (the ribbon is laid across it). Call every frame while the contact touches.
   */
  lay(id: string, x: number, y: number, z: number, heading: { x: number; z: number }, width = this.width): void {
    let contact = this.contacts.get(id);
    if (!contact) { contact = { lastIndex: -1, x, z, active: false }; this.contacts.set(id, contact); }
    if (contact.active && Math.hypot(x - contact.x, z - contact.z) < 0.22) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const len = Math.hypot(heading.x, heading.z) || 1;
    const px = (-heading.z / len) * width * 0.5, pz = (heading.x / len) * width * 0.5;
    const p = this.positions;
    p[i * 6] = x - px; p[i * 6 + 1] = y + this.lift; p[i * 6 + 2] = z - pz;
    p[i * 6 + 3] = x + px; p[i * 6 + 4] = y + this.lift; p[i * 6 + 5] = z + pz;
    this.birth[i * 2] = this.birth[i * 2 + 1] = this.engine.time;
    // Join to this contact's previous point (unless the ring buffer wrapped onto it).
    const index = this.geometry.index!.array as Uint32Array;
    const prev = contact.active ? contact.lastIndex : -1;
    if (prev >= 0 && prev !== i) index.set([prev * 2, i * 2, prev * 2 + 1, prev * 2 + 1, i * 2, i * 2 + 1], i * 6);
    else index.fill(0, i * 6, i * 6 + 6);
    // The slot we are about to reuse next must not keep a quad that points at stale data.
    index.fill(0, this.cursor * 6, this.cursor * 6 + 6);
    contact.lastIndex = i; contact.x = x; contact.z = z; contact.active = true;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.birth.needsUpdate = true;
    this.geometry.index!.needsUpdate = true;
    this.points++;
  }

  /** The contact left the surface: its next `lay` starts a new ribbon. */
  lift_(id: string): void { const c = this.contacts.get(id); if (c) c.active = false; }

  /** Alias kept readable at call sites: `tracks.break(id)`. */
  break(id: string): void { this.lift_(id); }

  update(): void { this.uLife.value = this.life; }

  set opacity(value: number) { this.uOpacity.value = value; }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
