import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three/webgpu';
import type { AuthoredLandscape } from '../physics';
import { onBridge, roadHalf, roadHeight, roadZ } from './valley';

export const axle = [
  { dx: 0.94, dz: 0.77 },
  { dx: 0.94, dz: -0.77 },
  { dx: -0.94, dz: 0.77 },
  { dx: -0.94, dz: -0.77 },
];
export function roadGeometry(land: AuthoredLandscape) {
  const vertices: number[] = [],
    indices: number[] = [];
  for (let i = 0; i <= 336; i++) {
    const x = -84 + 0.5 * i;
    for (const side of [-1, 0, 1]) {
      const z = roadZ(x) + side * roadHalf;
      vertices.push(x, roadHeight(land, x, z), z);
    }
    if (i)
      for (let col = 0; col < 2; col++) {
        const a = (i - 1) * 3 + col;
        indices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
export class Cart {
  x = -27;
  seconds = 0;
  readonly wheels;
  readonly contactHeights = [0, 0, 0, 0];
  readonly point = new Vector3();
  readonly deck = { soil: 'asphalt' as const, water: 0, film: 0, moisture: 0 };
  constructor(readonly land: AuthoredLandscape) {
    this.wheels = axle.map(() => land.contact(0.24));
    this.reset();
  }
  get baseFilm() {
    return 0.19 * Math.exp(-this.seconds / 15);
  }
  reset() {
    this.x = -27;
    this.seconds = 0;
    this.land.tracks.clear();
    for (const c of this.wheels) c.reset();
    this.land.earth.discharge(-20.9, 0.77, 0.0012, 1.4);
    this.step(0, 0);
  }
  step(dt: number, speed: number) {
    this.seconds += dt;
    this.x = Math.min(46, Math.max(-44, this.x + speed * dt));
    this.deck.film = this.deck.moisture = this.baseFilm;
    for (const [i, w] of axle.entries()) {
      const x = this.x + w.dx,
        z = roadZ(this.x) + w.dz;
      this.contactHeights[i] = roadHeight(this.land, x, z);
      this.wheels[i].sample(x, z, speed, 0.88, dt, onBridge(x, z) ? this.deck : undefined);
    }
  }
}
