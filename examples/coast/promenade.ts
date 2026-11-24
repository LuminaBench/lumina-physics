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
import { GritBed } from '../../modules/wet-road/wheel-grit';
import { StreetDrainage } from '../../modules/wet-road/drainage';
import { PuddleContacts } from '../../modules/wet-road/puddle-contacts';
import type { TireSpraySurface } from '../../modules/wet-road/spray';
import { mergeStaticMeshes } from '../../engine/batching';
import { addShopfronts } from './shopfronts';

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
  readonly grit?: GritBed;
  readonly shops?: ReturnType<typeof addShopfronts>;
  private readonly lamps: THREE.PointLight[] = [];
  private readonly fixture = new THREE.MeshStandardMaterial({
    color: 0xa6a39a,
    emissive: 0xffb56a,
    emissiveIntensity: 0,
    roughness: 0.57,
  });
  private readonly crossSections: number[];
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
      indices: number[] = [],
      paving: number[] = [];
    this.crossSections = [-4.2, -3.65, -1.68, -1.16, -0.64, 0, 3.65, 4.2];
    if (town) this.crossSections.push(4.23, 5.55, 6.87, 9.3, 11.1, 13.1);
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
        let y = h + this.crown(dx) - (town ? 0.056 * basin(dx, z - this.road.z) : 0);
        if (dx > 4.2) {
          const row = THREE.MathUtils.clamp(Math.round((z - this.road.z) / 13), -4, 5);
          const houseX = 14 + (row & 1) * 2;
          const floor = ground(this.road.x + houseX, this.road.z + row * 13);
          const u = THREE.MathUtils.clamp((dx - 4.23) / (houseX - 3 - 4.23), 0, 1);
          y = Math.max(
            ground(this.road.x + dx, z) + 0.028,
            THREE.MathUtils.lerp(h + 0.108, floor + 0.095, u),
          );
        }
        this.roadHeights[j * count + k] = y;
        positions.push(this.road.x + dx, y, z);
      }
      if (j)
        for (let i = 0; i < count - 1; i++) {
          const k = (j - 1) * count + i;
          (sections[i] >= 4.2 ? paving : indices).push(k, k + count, k + 1, k + 1, k + count, k + count + 1);
        }
    }
    if (town) {
      const x = this.road.x,
        z = this.road.z;
      this.grit = new GritBed({ x: x - 3.6, z: z - 8, cellSize: 0.075, columns: 96, rows: 512 });
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
    this.contacts = new PuddleContacts(this);
    const water = standing.max(tyre.x).max(this.wet.mul(0.36));
    const roadColor = TSL.nodeObject(asphalt.colorNode);
    asphalt.colorNode = mix(roadColor.mul(water.mul(-0.22).add(1)), color('#795a3a'), tyre.y.mul(0.67));
    asphalt.roughnessNode = mix(TSL.nodeObject(asphalt.roughnessNode), float(0.075), water);
    if (this.grit) {
      const grains = this.grit.coverageNode(p.xz);
      const visible = standing.mul(-0.66).add(1);
      const fine = grains.x.mul(visible);
      const footprint = TSL.fwidth(p.xz).length();
      const resolved = smoothstep(0.022, 0.004, footprint);
      const speck = TSL.mx_noise_float(p.xz.mul(110)).mul(resolved);
      const coarse = grains.y.mul(visible).mul(speck.mul(0.5).add(0.75)).clamp();
      const dampDust = mix(color('#c4a27c'), color('#877055'), water);
      const gritColor = mix(color('#aa8e6c'), color('#d6c6a0'), speck.add(0.5).clamp());
      asphalt.colorNode = mix(mix(asphalt.colorNode, dampDust, fine), gritColor, coarse);
      const exposed = fine.max(coarse).mul(standing.oneMinus());
      asphalt.roughnessNode = mix(asphalt.roughnessNode, float(0.85), exposed);
    }
    asphalt.clearcoatNode = water;
    asphalt.clearcoatRoughnessNode = mix(0.31, 0.065, water);
    if (town) {
      asphalt.envNode = world.weather.materialEnvironment();
      asphalt.emissiveNode = TSL.nodeObject(asphalt.emissiveNode)
        .add(world.beams.rearRadiance(p).mul(water.mul(0.19).add(0.022)));
      const poolSlope = TSL.Fn(() => {
        const slope = TSL.vec2(0).toVar();
        TSL.If(standing.greaterThan(0.01), () => slope.assign(this.contacts.slopeNode(p.xz).mul(standing)));
        return slope;
      })();
      asphalt.clearcoatNormalNode = TSL.normalWorldGeometry
        .add(TSL.vec3(poolSlope.x.negate(), 0, poolSlope.y.negate()))
        .normalize()
        .transformDirection(TSL.cameraViewMatrix);
    }
    const road = new THREE.Mesh(geo, asphalt);
    road.name = 'Cambered coastal road';
    road.receiveShadow = true;
    this.root.add(road);
    this.geometry.add(geo);
    this.materials.add(asphalt);
    if (town) {
      const walk = new THREE.BufferGeometry();
      walk.setAttribute('position', geo.getAttribute('position'));
      walk.setIndex(paving);
      walk.computeVertexNormals();
      const surface = new THREE.MeshStandardNodeMaterial({ roughness: 0.83 });
      const across = dx.sub(4.23),
        slabs = TSL.vec2(across.div(1.32), dz.div(1.92));
      const joints = slabs.add(0.5).fract().sub(0.5).abs().mul(TSL.vec2(1.32, 1.92));
      const edge = TSL.min(joints.x, joints.y);
      const fade = TSL.fwidth(edge).max(0.0005);
      const joint = smoothstep(fade.negate(), fade, edge.sub(0.004)).oneMinus();
      const stone = mix(color('#aaa49b'), color('#a99e89'), smoothstep(2.59, 2.66, across));
      surface.colorNode = stone.mul(joint.mul(-0.32).add(1));
      const sidewalk = new THREE.Mesh(walk, surface);
      sidewalk.name = 'Sloped paving between curb and shops';
      sidewalk.receiveShadow = true;
      this.root.add(sidewalk);
      this.materials.add(surface);
      this.geometry.add(walk);
    }
    const physics = engine.physics;
    if (physics) {
      const c = physics.world.createCollider(
        physics.RAPIER.ColliderDesc.trimesh(
          new Float32Array(positions),
          new Uint32Array(indices.concat(paving)),
        ),
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
      iron = new THREE.MeshStandardMaterial({ color: 0x3e4846, metalness: 0.54, roughness: 0.48 });
    for (const m of [timber, concrete, paint, iron, this.fixture]) this.materials.add(m);
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
        place(block, this.fixture, x - 1.04, base + 4.86, z, 0.48, 0.12, 0.22);
        if (Math.abs(z - this.road.z) < 45) {
          const lamp = new THREE.PointLight(0xffc691, 30, 15, 2);
          lamp.position.set(x - 1.04, base + 4.76, z);
          this.root.add(lamp);
          this.lamps.push(lamp);
        }
      }
    }
    if (town) {
      this.shops = addShopfronts(
        this.road.x,
        this.road.z,
        ground,
        world.weather,
        concrete,
        paint,
        iron,
        timber,
        (m, x, y, z, w, h, d) => place(block, m, x, y, z, w, h, d),
      );
      this.materials.add(this.shops.pane);
      this.materials.add(this.shops.rooms.material);
      this.root.add(this.shops.rooms);
      this.updateLighting();
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
        // Reflectors never capture themselves. The recess behind each transparent pane is opaque.
        if (o !== road && o.material !== this.shops?.pane) o.layers.enable(12);
      }
    });
    this.root.name = 'Pier and coastal road';
    engine.scene.add(this.root);
    const probe = world.weather.localProbe;
    if (probe) {
      probe.center.set(this.road.x, town ? this.heightAt(this.road.x, this.road.z) + 1.7 : 4, this.road.z);
      if (town) probe.halfSize.x = 12.05;
    }
    this.surface = {
      archSurface: this.drainage,
      gritBed: this.grit,
      sheetOptions: {
        surfaceHeightAt: (x,z) => this.heightAt(x,z) + this.puddleDepth(x,z),
        radiance: world.beams.radiance,
      },
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
  /** A tapered fan of sand washed across the left wheel path at the puddle exit. */
  scatterGrit() {
    const bed = this.grit;
    if (!bed) return;
    const { x, z, cellSize, columns, rows } = bed.options;
    for (let j = 0; j < rows; j++) {
      const wz = z + (j + 0.5) * cellSize;
      const along = (wz - this.road.z - 15.55) / 1.72;
      if (Math.abs(along) >= 1) continue;
      for (let i = 0; i < columns; i++) {
        const wx = x + (i + 0.5) * cellSize;
        const across = (wx - this.road.x + 1.16 - 0.09 * along) / (0.49 + 0.12 * along);
        const edge = 0.10 * Math.sin(17 * along + 4 * across) + 0.05 * Math.sin(11 * across - 9 * along);
        const shape = Math.max(0, 1 - across * across - along * along + edge);
        if (shape > 0) bed.deposit(wx, wz, 1550 * shape * cellSize ** 2,
          830 * shape ** 2 * (1 - along * 0.55) * cellSize ** 2);
      }
    }
  }
  private crown(dx: number) {
    return 0.045 * (1 - Math.min(1, Math.abs(dx) / 3.65));
  }
  onRoad(x: number, z: number) {
    return Math.abs(x - this.road.x) <= 4.2 && Math.abs(z - this.road.z) <= this.rows;
  }
  heightAt(x: number, z: number) {
    const offset = x - this.road.x;
    if (
      offset < this.crossSections[0] ||
      offset > this.crossSections[this.crossSections.length - 1] ||
      Math.abs(z - this.road.z) > this.rows
    )
      return this.world.ground(x, z);
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
    if (this.shops) this.updateLighting();
    this.grit?.upload();
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
  private updateLighting() {
    const elevation = this.world.weather.params.sunElevation;
    const night = 1 - THREE.MathUtils.smoothstep(elevation, -4, 1);
    this.shops?.setSunElevation(elevation);
    this.fixture.emissiveIntensity = night * 3.1;
    for (const lamp of this.lamps) lamp.intensity = night * 30;
  }
  dispose() {
    for (const f of this.unregister) f();
    this.root.removeFromParent();
    this.grit?.dispose();
    this.drainage?.dispose();
    this.tracks.dispose();
    this.shops?.rooms.dispose();
    for (const lamp of this.lamps) lamp.dispose();
    for (const g of this.geometry) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
