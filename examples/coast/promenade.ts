import * as THREE from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { ClothSystem } from '../../modules/cloth/cloth';
import { addOpenShade } from '../../modules/coast/opening-light';
import { Coastline, type CoastOptions } from '../../modules/coast/coastline';
import type { CoastalWorld } from '../../modules/coast/world';
import { createTimberMaterial } from '../../modules/materials/timber';
import { createAsphaltMaterial } from '../../modules/materials/asphalt';
import { TreadTransfer } from '../../modules/wet-road/tread-transfer';
import { StreetDrainage } from '../../modules/wet-road/drainage';
import { PuddleContacts } from '../../modules/wet-road/puddle-contacts';
import type { TireSpraySurface } from '../../modules/wet-road/spray';
import { mergeStaticMeshes } from '../../engine/batching';

export function promenadeLayout(options: CoastOptions) {
  const c = new Coastline(options),
    along = c.project(0, 0).along,
    road = c.point(along, 18.5),
    pier = c.point(along - 15, 0);
  return {
    coast: c,
    road,
    pier,
    protectedAt: (x: number, z: number) => Math.abs(x - road.x) < 4.5 && Math.abs(z - road.z) < 132,
  };
}
export class Promenade {
  readonly root = new THREE.Group();
  readonly road: ReturnType<typeof promenadeLayout>['road'];
  readonly tracks = new TreadTransfer();
  readonly contacts: PuddleContacts;
  readonly surface: TireSpraySurface;
  readonly drainage?: StreetDrainage;
  private readonly crossSections = [-4.2, -3.65, -1.68, -1.16, -0.64, 0, 3.65, 4.2];
  private readonly roadHeights: Float32Array;
  private readonly outfall = new THREE.Vector3();
  private dropCarry = 0;
  private readonly stream = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(-0.55, -0.4, 0),
    radius: 0.032,
    life: 0.34,
    size: 0.011,
    sizeEnd: 0.004,
    spread: 0.14,
    count: 1,
  };
  private readonly rows = 132;
  private readonly materials = new Set<THREE.Material>();
  private readonly geometry = new Set<THREE.BufferGeometry>();
  private readonly puddle: ReturnType<typeof TSL.uniform>;
  private readonly wet: ReturnType<typeof TSL.uniform>;
  private film = 0.5;
  private readonly unregister: (() => void)[] = [];
  constructor(
    readonly world: CoastalWorld,
    readonly layout: ReturnType<typeof promenadeLayout>,
    town: boolean,
  ) {
    const { ground, coast, engine } = world;
    this.road = layout.road;
    const start = this.road.z - this.rows,
      positions: number[] = [],
      indices: number[] = [];
    const sections = this.crossSections,
      count = sections.length;
    this.roadHeights = new Float32Array((this.rows + 1) * count);
    const basin = (dx: number, dz: number) =>
      (1 - THREE.MathUtils.smoothstep(Math.abs(dx + 1.16), 0.09, 0.52)) *
      (1 - THREE.MathUtils.smoothstep(Math.abs(dz), 8, 17));
    for (let j = 0; j <= this.rows; j++) {
      const z = start + 2 * j;
      const h =
        Math.max(0.65, ground(this.road.x - 4, z), ground(this.road.x + 4, z), ground(this.road.x, z)) +
        0.085;
      for (let k = 0; k < count; k++) {
        const dx = sections[k];
        const y = h + this.crown(dx) - (town ? 0.056 * basin(dx, z - this.road.z) : 0);
        this.roadHeights[j * count + k] = y;
        positions.push(this.road.x + dx, y, z);
      }
      if (j)
        for (let i = 0; i < count - 1; i++) {
          const k = (j - 1) * count + i;
          indices.push(k, k + count, k + 1, k + 1, k + count, k + count + 1);
        }
    }
    if (town) {
      const x = this.road.x,
        z = this.road.z;
      this.outfall.set(x + 3.56, this.heightAt(x + 3.56, z + 4.05) + 0.22, z + 4.05);
      this.drainage = new StreetDrainage({
        x: x - 4.2,
        z: z - 32,
        width: 8.4,
        length: 64,
        columns: 40,
        rows: 96,
        ground: (x, z) => this.heightAt(x, z),
        initialDepth: (wx, wz) => 0.045 * basin(wx - x, wz - z),
        roof: { area: 6.3 * 9.3, seconds: 6.5, outletX: this.outfall.x, outletZ: this.outfall.z },
        drains: [
          { x: x + 3.56, z: z + 4.05, capacityLps: 1.8 },
          { x: x - 3.61, z: z - 12, capacityLps: 0.75 },
        ],
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const asphalt = createAsphaltMaterial({
      color: '#545557',
      wear: 0.52,
      wetness: 0.18,
      puddle: 0,
      cracks: 0.24,
      bumpScale: 0.0035,
    });
    const { positionWorld: p, smoothstep, mix, float, color } = TSL;
    const dx = p.x.sub(this.road.x),
      dz = p.z.sub(this.road.z);
    this.puddle = TSL.uniform(town ? 1 : 0.34);
    this.wet = TSL.uniform(this.film);
    const gutter = smoothstep(0.48, 0.06, dx.add(1.16).abs())
      .mul(smoothstep(17, 8, dz.abs()))
      .mul(this.puddle);
    const tyre = this.tracks.sampleNode(p.xz);
    const standing = this.drainage ? smoothstep(0.00015, 0.004, this.drainage.depthNode(p.xz)) : gutter;
    const water = standing.max(tyre.x).max(this.wet.mul(0.36));
    const roadColor = TSL.nodeObject(asphalt.colorNode);
    asphalt.colorNode = mix(roadColor.mul(water.mul(-0.22).add(1)), color('#795a3a'), tyre.y.mul(0.67));
    asphalt.roughnessNode = mix(TSL.nodeObject(asphalt.roughnessNode), float(0.075), water);
    asphalt.clearcoatNode = water;
    asphalt.clearcoatRoughnessNode = mix(0.31, 0.065, water);
    const road = new THREE.Mesh(geo, asphalt);
    road.name = 'Cambered coastal road';
    road.receiveShadow = true;
    this.root.add(road);
    this.geometry.add(geo);
    this.materials.add(asphalt);
    const physics = engine.physics;
    if (physics) {
      const c = physics.world.createCollider(
        physics.RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)),
      );
      this.unregister.push(() => physics.world.removeCollider(c, true));
    }
    const block = new THREE.BoxGeometry(),
      pole = new THREE.CylinderGeometry(1, 1.08, 1, 10);
    this.geometry.add(block);
    this.geometry.add(pole);
    const timber = createTimberMaterial({
      color: '#a79073',
      grainColor: '#51473c',
      weathering: 0.74,
      bumpScale: 0.0028,
      plankWidth: 0.21,
    });
    const salt = smoothstep(0.6, 0.75, p.y).mul(smoothstep(1.14, 0.78, p.y));
    timber.colorNode = mix(
      TSL.nodeObject(timber.colorNode).mul(smoothstep(-0.12, 0.48, p.y).mul(0.29).add(0.71)),
      color('#a4a18c'),
      salt.mul(0.15),
    );
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb5aca0, roughness: 0.91 }),
      paint = new THREE.MeshStandardMaterial({ color: 0xe6d4ab, roughness: 0.67 }),
      iron = new THREE.MeshStandardMaterial({ color: 0x3e4846, metalness: 0.54, roughness: 0.48 }),
      glow = new THREE.MeshStandardMaterial({ color: 0xf9dbaf, emissive: 0xffb56a, emissiveIntensity: 2.3 });
    for (const m of [timber, concrete, paint, iron, glow]) this.materials.add(m);
    const place = (
      geometry: THREE.BufferGeometry,
      m: THREE.Material,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
    ) => {
      const o = new THREE.Mesh(geometry, m);
      o.position.set(x, y, z);
      o.scale.set(w, h, d);
      o.castShadow = o.receiveShadow = true;
      this.root.add(o);
      return o;
    };
    const pier = layout.pier,
      deckY = Math.max(3.2, this.heightAt(this.road.x, pier.z) + 3.0),
      from = pier.x - 30,
      end = this.road.x + 6;
    const shade = addOpenShade(engine.scene, {
      center: new THREE.Vector3((from + end) / 2, deckY * 0.5, pier.z),
      halfSize: new THREE.Vector3((end - from) / 2, deckY * 0.5, 2),
      towardsOpenSky: new THREE.Vector3(-0.8, 0.55, -0.4),
      groundColor: coast.sand.pale,
    });
    this.unregister.push(
      () => shade.dispose(),
      engine.world.shelters.add({
        center: new THREE.Vector3((from + end) / 2, deckY - 0.32, pier.z),
        width: end - from,
        depth: 3.8,
        groundY: this.heightAt(this.road.x, pier.z),
        underside: '#716653',
      }),
    );
    place(block, timber, (from + end) / 2, deckY, pier.z, end - from, 0.23, 3.8);
    for (let i = 0; i <= 8; i++) {
      const span = (end - from) / 8,
        x = from + span * i;
      for (const s of [-1, 1]) {
        if (Math.abs(x - this.road.x) > 4.4)
          place(pole, timber, x, (deckY - 2.8) / 2, pier.z + s * 1.48, 0.17, deckY + 2.8, 0.17);
        place(block, iron, x, deckY + 0.55, pier.z + s * 1.75, 0.062, 1.07, 0.062);
        if (i < 8) place(block, iron, x + span * 0.5, deckY + 1.04, pier.z + s * 1.75, span, 0.055, 0.055);
      }
      place(block, timber, x, deckY - 0.25, pier.z, 0.21, 0.25, 3.85);
    }
    place(pole, iron, from + 0.35, deckY + 1.95, pier.z + 1.49, 0.041, 3.9, 0.041);
    const cloth = engine.add(new ClothSystem(engine));
    cloth.flag({
      origin: new THREE.Vector3(from + 0.35, deckY + 3.85, pier.z + 1.49),
      width: 1.76,
      height: 0.92,
      pattern: 'stripes',
      colors: [0xc46a4b, 0xe5d7b8],
    });
    for (const s of [-1, 1])
      place(block, timber, (end + from) / 2, deckY - 0.43, pier.z + s * 1.23, end - from, 0.39, 0.18);
    for (let j = 0; j < this.rows; j += 2) {
      const z = start + j * 2,
        cy = this.heightAt(this.road.x, z);
      if (j % 4 === 0) place(block, paint, this.road.x, cy + 0.008, z, 0.082, 0.009, 2.3);
      for (const side of [-1, 1]) {
        const x = this.road.x + side * 4.12;
        if (town) place(block, concrete, x, this.heightAt(x, z) + 0.05, z, 0.24, 0.14, 3.93);
      }
      if (town && j % 12 === 0) {
        const x = this.road.x + 5.4,
          base = this.heightAt(this.road.x + 4, z);
        place(pole, iron, x, base + 2.45, z, 0.066, 4.9, 0.066);
        place(block, iron, x - 0.53, base + 4.92, z, 1.18, 0.065, 0.13);
        place(block, glow, x - 1.04, base + 4.86, z, 0.48, 0.12, 0.22);
        if (Math.abs(z - this.road.z) < 45) {
          const lamp = new THREE.PointLight(0xffc691, 30, 15, 2);
          lamp.position.set(x - 1.04, base + 4.76, z);
          this.root.add(lamp);
        }
      }
    }
    if (town)
      for (let j = -4; j < 6; j++) {
        const z = this.road.z + j * 13,
          x = this.road.x + 14 + (j & 1) * 2,
          h = 3.2 + ((0.9 * (j + 8)) % 2.4),
          base = ground(x, z);
        place(block, concrete, x, base + h / 2, z, 6, h, 9);
        place(block, timber, x, base + h + 0.09, z, 6.3, 0.21, 9.3);
        for (let k = -1; k <= 1; k++)
          place(block, (j + k) % 3 === 0 ? glow : iron, x - 3.02, base + 1.75, z + k * 2.6, 0.04, 1.24, 1.39);
        place(block, paint, x - 3.55, base + 2.79, z, 1.32, 0.11, 8.2);
      }
    if (this.drainage) {
      const ox = this.outfall.x,
        oz = this.outfall.z,
        wall = this.road.x + 10.9;
      const roof = ground(this.road.x + 14, this.road.z) + 3.2 + ((0.9 * 8) % 2.4) + 0.15;
      const knee = this.outfall.y + 0.19;
      place(pole, iron, wall, (roof + knee) / 2, oz, 0.063, roof - knee, 0.063);
      const spill = place(
        pole,
        iron,
        (wall + ox) / 2,
        (knee + this.outfall.y) / 2,
        oz,
        0.063,
        Math.hypot(wall - ox, knee - this.outfall.y),
        0.063,
      );
      spill.rotation.z = -Math.atan2(wall - ox, knee - this.outfall.y);
      for (const g of this.drainage.options.drains) {
        const y = this.heightAt(g.x, g.z) + 0.012;
        place(block, iron, g.x, y, g.z, 0.37, 0.016, 0.62);
        for (let j = -2; j <= 2; j++)
          place(block, concrete, g.x, y + 0.009, g.z + j * 0.11, 0.34, 0.012, 0.017);
      }
    }
    // Batch repeated opaque members once and retain the dynamic road material.
    mergeStaticMeshes(this.root, [road]);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        this.geometry.add(o.geometry);
        o.layers.enable(12);
      }
    });
    this.root.name = 'Pier and coastal road';
    engine.scene.add(this.root);
    world.weather.localProbe?.center.set(this.road.x, 4, this.road.z);
    this.contacts = new PuddleContacts(this);
    this.surface = {
      heightAt: (x, z) => this.heightAt(x, z),
      puddleDepth: (x, z) => this.puddleDepth(x, z),
      rainFilmAt: (x, z) => (this.onRoad(x, z) ? this.film : world.sediment.inspect(x, z).film),
      liquidWetnessAt: (x, z) =>
        this.onRoad(x, z)
          ? Math.max(this.film, this.puddleDepth(x, z) * 30)
          : world.sediment.inspect(x, z).film,
      contacts: this.contacts,
      field: world.ocean.field,
      tread: this.tracks,
      transfer: {
        soil: {
          amountAt: (x, z) =>
            this.onRoad(x, z) ? 0 : coast.sand.packing * (0.3 + 0.7 * world.sediment.inspect(x, z).film),
        },
      },
    };
    this.wet.value = this.film = town ? 0.37 : 0.045;
  }
  private crown(dx: number) {
    return 0.045 * (1 - Math.min(1, Math.abs(dx) / 3.65));
  }
  onRoad(x: number, z: number) {
    return Math.abs(x - this.road.x) <= 4.2 && Math.abs(z - this.road.z) <= this.rows;
  }
  heightAt(x: number, z: number) {
    if (!this.onRoad(x, z)) return this.world.ground(x, z);
    const j = THREE.MathUtils.clamp((z - this.road.z + this.rows) / 2, 0, this.rows),
      a = Math.min(this.rows - 1, Math.floor(j));
    const dx = x - this.road.x,
      c = this.crossSections,
      count = c.length;
    let k = 0;
    while (k < count - 2 && dx > c[k + 1]) k++;
    const u = (dx - c[k]) / (c[k + 1] - c[k]),
      v = j - a,
      i = a * count + k,
      h = this.roadHeights;
    return u + v <= 1
      ? h[i] + u * (h[i + 1] - h[i]) + v * (h[i + count] - h[i])
      : h[i + count + 1] +
          (1 - u) * (h[i + count] - h[i + count + 1]) +
          (1 - v) * (h[i + 1] - h[i + count + 1]);
  }
  puddleDepth(x: number, z: number) {
    if (!this.onRoad(x, z)) return this.world.sediment.inspect(x, z).water;
    if (this.drainage) return this.drainage.depthAt(x, z);
    const dx = Math.abs(x - this.road.x + 1.16),
      dz = Math.abs(z - this.road.z);
    return (
      (1 - THREE.MathUtils.smoothstep(dx, 0.06, 0.48)) *
      (1 - THREE.MathUtils.smoothstep(dz, 8, 17)) *
      0.049 *
      this.puddle.value
    );
  }
  update(dt: number, focus: THREE.Vector3) {
    this.contacts.update(dt);
    this.tracks.update(dt, focus.x, focus.z);
    const rain = this.world.rainAt(this.road.x, this.road.z);
    if (this.drainage) {
      const wind = this.world.front.sample(this.road.x, this.road.z, this.world.engine.time);
      const sun = Math.max(0, frame.sunDirection.value.y);
      this.drainage.update(
        dt,
        rain * 100,
        (0.06 + 0.46 * sun + 0.024 * Math.hypot(wind.windX, wind.windZ)) * (1 - rain),
      );
      this.dropCarry += this.drainage.budget.downspoutLps * dt * 120;
      if (this.dropCarry >= 1) {
        const due = Math.floor(this.dropCarry);
        this.dropCarry -= due;
        if (focus.distanceToSquared(this.outfall) < 2500) {
          this.stream.position.copy(this.outfall);
          this.stream.count = Math.min(6, due);
          this.world.fx.spray.emit(this.stream);
        }
      }
    }
    this.film = THREE.MathUtils.lerp(this.film, rain, 1 - Math.exp(-dt / (rain > this.film ? 4 : 98)));
    this.wet.value = this.film;
  }
  dispose() {
    for (const f of this.unregister) f();
    this.root.removeFromParent();
    this.drainage?.dispose();
    this.tracks.dispose();
    for (const g of this.geometry) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
