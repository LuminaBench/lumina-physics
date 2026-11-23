import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { auxPassthrough, frame } from '../../engine/frame';
import { spriteNoise } from '../../engine/noise';
import { traceReflection } from '../../engine/ssr';
import type { RainShelters } from '../../engine/rain-shelters';
import { WorldSource, type WorldBus } from '../../engine/world-bus';
import type { EngineModule, LuminaEngine } from '../../engine/engine';
import type { EffectsKit } from '../../engine/fx';
import type { Weather } from '../weather/weather';
import type { AquaplaningVehicle } from './vehicle';
import type { WetRoad } from './road';

/** Shallow waves and a conservative transport grid for an immiscible surface film.
 * Grid cells store a water displacement, vertical velocity, liquid inventory and a
 * normalized cinematic flame state. Closed edges retain liquid at the boundary. */
export class StreetFlowGrid {
  readonly floor: Float32Array;
  readonly wave: Float32Array;
  readonly velocity: Float32Array;
  readonly film: Float32Array;
  readonly flame: Float32Array;
  private readonly channels: Float32Array[];
  private readonly inventory: Float32Array;
  private readonly nextFlame: Float32Array;
  readonly stats = { film: 0, burning: 0, peakWave: 0 };
  constructor(
    readonly nx = 40,
    readonly nz = 112,
    readonly spacing = 0.7
  ) {
    if (nx < 3 || nz < 3 || !(spacing > 0))
      throw new RangeError('Street grid needs at least three cells per axis and positive spacing');
    const n = nx * nz;
    this.floor = new Float32Array(n);
    this.wave = new Float32Array(n);
    this.velocity = new Float32Array(n);
    this.film = new Float32Array(n);
    this.flame = new Float32Array(n);
    this.channels = [this.wave, this.velocity, this.film, this.flame];
    this.inventory = new Float32Array(n);
    this.nextFlame = new Float32Array(n);
  }
  /** Recenter the simulation in whole cells. The overlapping region keeps its world-space state. */
  shift(dx: number, dz: number): void {
    if (!dx && !dz) return;
    const nx = this.nx,
      nz = this.nz,
      scratch = this.inventory;
    const x0 = Math.max(0, -dx),
      x1 = Math.min(nx, nx - dx),
      z0 = Math.max(0, -dz),
      z1 = Math.min(nz, nz - dz);
    for (const field of this.channels) {
      scratch.fill(0);
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++) scratch[z * nx + x] = field[(z + dz) * nx + x + dx];
      field.set(scratch);
    }
  }
  /** Project only the cells touched by a swept source. A positive pressure pulse
   * displaces water towards its rim. Local heat and spray affect film with inventory. */
  couple(
    bus: WorldBus,
    centerX: number,
    centerZ: number,
    level: number,
    dt: number,
    owner?: WorldSource
  ): void {
    const halfX = (this.nx - 1) * 0.5,
      halfZ = (this.nz - 1) * 0.5;
    for (let k = 0; k < bus.sourceCount; k++) {
      if (owner && bus.ownedBy(k, owner)) continue;
      const s = bus.sourceAt(k),
        gain = bus.gainAt(k);
      if (!s.pressure && !s.wetness && !s.heat) continue;
      const a = s.start,
        b = s.end,
        r = s.radius,
        dx = b.x - a.x,
        dy = b.y - a.y,
        dz = b.z - a.z;
      const inv = 1 / Math.max(1e-6, dx * dx + dy * dy + dz * dz),
        rr = r * r;
      const x0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - r - centerX) / this.spacing + halfX));
      const x1 = Math.min(this.nx - 1, Math.floor((Math.max(a.x, b.x) + r - centerX) / this.spacing + halfX));
      const z0 = Math.max(0, Math.ceil((Math.min(a.z, b.z) - r - centerZ) / this.spacing + halfZ));
      const z1 = Math.min(this.nz - 1, Math.floor((Math.max(a.z, b.z) + r - centerZ) / this.spacing + halfZ));
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const cell = z * this.nx + x,
            surface = Math.max(this.floor[cell], level + this.wave[cell]);
          const px = centerX + (x - halfX) * this.spacing - a.x,
            py = surface - a.y,
            pz = centerZ + (z - halfZ) * this.spacing - a.z;
          const t = Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) * inv));
          const rx = px - dx * t,
            ry = py - dy * t,
            rz = pz - dz * t,
            q = (rx * rx + ry * ry + rz * rz) / rr;
          if (q >= 1) continue;
          const w = (1 - q) * (1 - q) * gain;
          if (surface > this.floor[cell] + 0.015) this.velocity[cell] -= dt * s.pressure * w * (1 - 4 * q);
          if (this.film[cell] < 0.012) continue;
          const fire = this.flame[cell] + dt * (Math.max(0, s.heat * w - 115) * 0.015 - 2.6 * s.wetness * w);
          this.flame[cell] = Math.min(1, Math.max(0, fire));
        }
    }
  }
  step(dt: number, flood: number, rain: number, shelters?: RainShelters, centerX = 0, centerZ = 0): void {
    const { nx, nz, floor, wave, velocity, film, flame } = this;
    // Subdivide long game ticks so the explicit wave update satisfies its CFL limit.
    if (!(dt > 0)) return;
    let minFloor = Infinity;
    if (flood !== -1e3) for (let i = 0; i < floor.length; i++) minFloor = Math.min(minFloor, floor[i]);
    const c2 = 9.81 * Math.max(0.055, flood - minFloor),
      safe = Math.min(1 / 24, (this.spacing * 0.65) / Math.sqrt(c2));
    if (dt > safe * 1.001) {
      const n = Math.ceil(dt / safe);
      for (let k = 0; k < n; k++) this.step(dt / n, flood, rain, shelters, centerX, centerZ);
      return;
    }
    const factor = (c2 * dt) / (this.spacing * this.spacing),
      damp = Math.exp(-dt * 1.2);
    for (let z = 1; z < nz - 1; z++)
      for (let x = 1; x < nx - 1; x++) {
        const i = z * nx + x;
        velocity[i] =
          (velocity[i] + (wave[i - 1] + wave[i + 1] + wave[i - nx] + wave[i + nx] - 4 * wave[i]) * factor) *
          damp;
      }
    let peak = 0,
      mass = 0,
      burning = 0;
    this.inventory.set(film);
    this.nextFlame.set(flame);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        wave[i] += velocity[i] * dt;
        peak = Math.max(peak, Math.abs(wave[i]));
        if (film[i] < 1e-6) {
          this.nextFlame[i] = 0;
          continue;
        }
        const l = x ? i - 1 : i,
          r = x < nx - 1 ? i + 1 : i,
          a = z ? i - nx : i,
          b = z < nz - 1 ? i + nx : i;
        const head = Math.max(floor[i], flood) + wave[i] + 0.11 * film[i];
        const fl = Math.max(0, head - Math.max(floor[l], flood) - wave[l] - 0.11 * film[l]);
        const fr = Math.max(0, head - Math.max(floor[r], flood) - wave[r] - 0.11 * film[r]);
        const fa = Math.max(0, head - Math.max(floor[a], flood) - wave[a] - 0.11 * film[a]);
        const fb = Math.max(0, head - Math.max(floor[b], flood) - wave[b] - 0.11 * film[b]),
          sum = fl + fr + fa + fb;
        if (sum > 1e-7) {
          const rate = Math.min(film[i] * 0.3, sum * dt * 2.8) / sum;
          this.inventory[i] -= sum * rate;
          this.inventory[l] += fl * rate;
          this.inventory[r] += fr * rate;
          this.inventory[a] += fa * rate;
          this.inventory[b] += fb * rate;
        }
        const nearby = Math.max(flame[l], flame[r], flame[a], flame[b]);
        const rainHere = rain > 0 && shelters?.count ? rain * shelters.exposureAt(
          centerX + (x - (nx - 1) * 0.5) * this.spacing, Math.max(flood + wave[i], floor[i]),
          centerZ + (z - (nz - 1) * 0.5) * this.spacing) : rain;
        let f = flame[i] + dt * (nearby * (1.2 + Math.min(1, film[i])) + flame[i] * (1.45 - rainHere * 2.4));
        f = Math.min(1, Math.max(0, f));
        if (film[i] < 0.012) f *= Math.max(0, 1 - dt * 6);
        this.nextFlame[i] = f;
        this.inventory[i] -= Math.min(this.inventory[i], dt * 0.095 * f);
      }
    film.set(this.inventory);
    flame.set(this.nextFlame);
    for (let i = 0; i < film.length; i++) {
      mass += film[i];
      if (flame[i] > 0.12) burning++;
    }
    this.stats.film = mass;
    this.stats.burning = burning;
    this.stats.peakWave = peak;
  }
}

export class FloodedStreet implements EngineModule {
  readonly grid = new StreetFlowGrid();
  readonly mesh: THREE.Mesh;
  readonly center = new THREE.Vector2();
  flooded = false;
  leaking = false;
  readonly stats = { depth: 0, bow: 0, spray: 0, hoodSpray: 0, rearSpray: 0 };
  /** Height of the lower body edge above the road, in metres. Wheels displace shallower water. */
  clearance = 0.13;
  private running = false;
  private accumulator = 0;
  private floodLevel = 0;
  private unregisterWater: () => void;
  private readonly surfacePulse = new WorldSource();
  private readonly bowSpray = new WorldSource();
  private readonly fieldTexture: THREE.DataTexture;
  private readonly pixels: Float32Array;
  private readonly position = new THREE.Vector3();
  private readonly carry = new Float64Array(10);
  private readonly u = {
    level: TSL.uniform(-1e3),
    rain: TSL.uniform(0),
    carPos: TSL.uniform(new THREE.Vector3()),
    carFwd: TSL.uniform(new THREE.Vector3(0, 0, 1)),
    headlights: TSL.uniform(1),
  };
  private readonly out = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 0.38,
    spread: 1.3,
    life: 0.8,
    lifeJitter: 0.32,
    size: 0.09,
    sizeEnd: 0.22,
    temperature: 0,
  };
  constructor(
    private engine: LuminaEngine,
    private fx: EffectsKit,
    private weather: Weather,
    private road: WetRoad,
    private car: AquaplaningVehicle
  ) {
    const g = this.grid;
    this.pixels = new Float32Array(g.nx * g.nz * 4);
    this.fieldTexture = new THREE.DataTexture(this.pixels, g.nx, g.nz, THREE.RGBAFormat, THREE.FloatType);
    this.fieldTexture.minFilter = this.fieldTexture.magFilter = THREE.NearestFilter;
    this.fieldTexture.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(
      (g.nx - 1) * g.spacing,
      (g.nz - 1) * g.spacing,
      g.nx - 1,
      g.nz - 1
    ).rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const st = TSL.vec2(TSL.uv().x, TSL.uv().y.oneMinus())
      .mul(TSL.vec2((g.nx - 1) / g.nx, (g.nz - 1) / g.nz))
      .add(TSL.vec2(0.5 / g.nx, 0.5 / g.nz));
    const sample = TSL.texture(this.fieldTexture, st).level(0);
    // Interpolation happens on triangles. Nearest vertex fetch needs no float-linear extension.
    m.positionNode = TSL.vec3(TSL.positionGeometry.x, sample.r.add(TSL.smoothstep(0, 0.002, sample.a).oneMinus().mul(0.0015)), TSL.positionGeometry.z);
    const film = sample.g.toVarying('streetOil'),
      flame = sample.b.toVarying('streetFire'),
      depth = sample.a.toVarying('streetDepth');
    const P = TSL.positionWorld;
    const u = this.u;
    // Interpolate central-difference normals. Face derivatives produce one
    // flat sky reflection per triangle precisely where the bow wave is steep.
    const tex = TSL.texture(this.fieldTexture);
    const dx = TSL.vec2(1 / g.nx, 0),
      dz = TSL.vec2(0, 1 / g.nz);
    const hx = tex
      .sample(st.add(dx))
      .level(0)
      .r.sub(tex.sample(st.sub(dx)).level(0).r);
    const hz = tex
      .sample(st.add(dz))
      .level(0)
      .r.sub(tex.sample(st.sub(dz)).level(0).r);
    const up = TSL.normalize(TSL.vec3(hx.negate(), 2 * g.spacing, hz.negate()).toVarying('streetNormal'));
    const elevation = sample.r.sub(u.level).toVarying('streetCrest');
    const toEye = TSL.cameraPosition.sub(P);
    const distance = TSL.length(toEye);
    const view = toEye.div(distance);
    const oil = TSL.smoothstep(0.015, 0.3, film);
    // Wind chop (~0.4 m) and rain-scale ripples (~0.16 m): two isotropic noise slopes.
    // A single plane wave here read as uniform corrugation bands across the whole flood.
    // Oil films damp capillary ripples.
    const t = frame.time;
    const slopeOf = (q: N, channel: 0 | 1, frequency: number, amplitude: number): N => {
      const e = 0.06, base = spriteNoise(q, channel);
      return TSL.vec2(spriteNoise(q.add(TSL.vec2(e, 0)), channel).sub(base), spriteNoise(q.add(TSL.vec2(0, e)), channel).sub(base))
        .mul(frequency * amplitude / e);
    };
    const chop = slopeOf(P.xz.mul(2.3).add(TSL.vec2(t.mul(-0.35), t.mul(0.21))), 0, 2.3, 0.011);
    const fallingRain = u.rain.mul(engine.world.shelters.rainNode(P));
    const ripple = slopeOf(P.xz.mul(6.1).add(TSL.vec2(t.mul(0.52), t.mul(-0.44))), 1, 6.1, 0.0045).mul(fallingRain.mul(0.8).add(0.2));
    const near = TSL.smoothstep(60, 5, distance);
    const slope = chop.add(ripple).mul(near).mul(oil.mul(-0.75).add(1));
    const n = TSL.normalize(up.add(TSL.vec3(slope.x.negate(), 0, slope.y.negate())));
    const nv = TSL.dot(n, view).abs().clamp(0.01, 1);
    const R = TSL.reflect(view.negate(), n);
    // Near the car the reflected ray meets the dark hull, not the sky. Without a traced
    // reflection, grazing Fresnel (≈35–50 % at the side camera) painted bright sky right
    // against the body: a milky band with no hull reflection. Same tracer and quality gate
    // as the road surface.
    const preset = engine.quality.preset;
    const reflection = TSL.Fn(() => {
      const roof = engine.world.shelters.rayNode(P, R, TSL.float(0.015));
      const underside = TSL.mix(frame.skyHorizon, frame.skyZenith, 0.5).mul(roof.rgb);
      const background = TSL.mix(weather.reflection(R, 0.18), underside, roof.a);
      const env = weather.reflectionAt(P, R, TSL.float(0.18), background).toVar();
      if (preset.reflections.ssr) {
        TSL.If(distance.lessThan(120), () => {
          const hit = traceReflection(P.add(TSL.vec3(0, 0.01, 0)), TSL.normalize(TSL.vec3(R.x, R.y.max(0.01), R.z)),
            { steps: Math.round(12 + preset.reflections.ssrQuality * 28), maxDistance: 45, thickness: 0.2 });
          env.assign(TSL.mix(env, hit.rgb, hit.a));
        });
      }
      return env;
    })();
    // Water F0 0.02; a mineral-oil film (n ≈ 1.47) raises it to ~0.036.
    const F0 = TSL.mix(TSL.float(0.02), TSL.float(0.036), oil);
    const fresnel = nv.oneMinus().pow(5).mul(F0.oneMinus()).add(F0);

    // Optical path through the water to whatever is actually behind it: the car body, a
    // wheel or the road. Using the road depth everywhere drew a 0.5 m veil over every
    // submerged panel, erasing the lower half of the car.
    const sceneZ = TSL.perspectiveDepthToViewZ(TSL.viewportDepthTexture(TSL.screenUV).r, TSL.cameraNear, TSL.cameraFar).negate();
    const surfaceZ = TSL.positionView.z.negate().max(1e-3);
    const toObject = sceneZ.sub(surfaceZ).max(0).mul(distance.div(surfaceZ));
    // Refraction steepens the ray under water (Snell, n = 1.333): at the low side camera a
    // 12° grazing view continues at ~43° below the surface, so the path to a submerged
    // panel is ~3× shorter than along the unrefracted view ray.
    const sinRefracted = TSL.float(1).sub(nv.mul(nv).oneMinus().div(1.777)).sqrt();
    const below = toObject.mul(nv).min(depth);
    const path = below.div(sinRefracted);
    // Turbid floodwater: suspended silt extinguishes ~2/m, so a panel 15 cm under the
    // surface stays visible but dim, while the road paint 0.34 m down only just reads.
    const transmit = path.mul(-2.1).exp();
    const ambient = TSL.mix(frame.skyHorizon, frame.skyZenith, 0.5);
    // Headlights scatter forward through the silt column ahead of the car.
    const rel = P.sub(u.carPos);
    const lz = TSL.dot(rel.xz, u.carFwd.xz), lx = TSL.dot(rel.xz, TSL.vec2(u.carFwd.z, u.carFwd.x.negate()));
    const ahead = lz.sub(2.05);
    const spread = ahead.mul(0.14).add(0.85);
    const beam = TSL.smoothstep(-0.15, 2.2, ahead).mul(ahead.mul(-0.06).exp())
      .mul(lx.add(0.56).div(spread).pow(2).negate().exp().add(lx.sub(0.56).div(spread).pow(2).negate().exp()))
      .mul(u.headlights);
    const silt = TSL.vec3(0.07, 0.066, 0.052);
    const inscatter = silt.mul(ambient.add(TSL.vec3(0.94, 0.97, 1.04).mul(beam).mul(1.6)));
    const waterAlpha = TSL.float(1).sub(fresnel.oneMinus().mul(transmit));
    const waterColour = reflection.mul(fresnel).add(inscatter.mul(transmit.oneMinus()).mul(fresnel.oneMinus()))
      .div(waterAlpha.max(0.005));

    // Whitewater only where it physically forms: on steep, raised bow-wave crests, and as
    // a churned collar where the car or a wheel pierces the surface (a short path behind a
    // deep column). Both are lit like a rough diffuse surface.
    const steep = TSL.smoothstep(0.03, 0.1, up.xz.length());
    const breakup = spriteNoise(P.xz.mul(5.2).add(TSL.vec2(t.mul(0.9), t.mul(-0.6))), 1);
    const crest = TSL.smoothstep(0.05, 0.16, elevation).mul(steep).mul(TSL.smoothstep(0.35, 0.65, breakup));
    const collar = TSL.float(1).sub(TSL.smoothstep(0.012, 0.06, toObject)).mul(TSL.smoothstep(0.06, 0.12, depth))
      .mul(TSL.smoothstep(0.25, 0.6, breakup).mul(0.6).add(0.4));
    const foam = TSL.max(crest, collar).mul(0.85);
    const foamLit = TSL.vec3(0.78, 0.8, 0.8).mul(ambient.add(frame.sunColor.mul(frame.sunVisibility).mul(TSL.dot(n, frame.sunDirection).max(0)).mul(1 / Math.PI)));
    const present = TSL.smoothstep(0, 0.02, depth);
    const flood = TSL.mix(waterColour, foamLit, foam);
    const floodAlpha = TSL.max(waterAlpha, foam).mul(present);

    // Oil: a thin specular film with interference colour where it is thin. It adds
    // reflectance, not a grey body (an 83 % opaque slick read as milky paint).
    const interference = TSL.vec3(0, 2.1, 4.2).add(film.mul(9).add(nv.mul(7))).cos().mul(0.5).add(0.5);
    const sheen = reflection.mul(interference.mul(0.7).add(0.3));
    const oilAlpha = oil.mul(fresnel.add(0.05)).mul(TSL.smoothstep(0.3, 0.05, film).mul(0.6).add(0.4));
    const alpha = TSL.float(1).sub(floodAlpha.oneMinus().mul(oilAlpha.oneMinus()));
    const colour = flood.mul(floodAlpha).mul(oilAlpha.oneMinus()).add(sheen.mul(oilAlpha)).div(alpha.max(0.005));
    m.colorNode = colour.add(TSL.vec3(2.1, 0.39, 0.037).mul(flame));
    m.opacityNode = TSL.max(alpha, flame.mul(0.6));
    m.mrtNode = auxPassthrough();
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    engine.scene.add(this.mesh);
    this.unregisterWater = engine.world.addWater({
      heightAt: (x, z) => {
        if (!this.flooded) return NaN;
        const bed = this.road.heightAt(x, z), surface = this.waterHeight(x, z);
        return surface > bed + 0.001 ? surface : NaN;
      },
    });
    road.streetFluid = this;
  }
  private index(x: number, z: number): number {
    const g = this.grid,
      ix = Math.round((x - this.center.x) / g.spacing + (g.nx - 1) * 0.5),
      iz = Math.round((z - this.center.y) / g.spacing + (g.nz - 1) * 0.5);
    return ix >= 0 && iz >= 0 && ix < g.nx && iz < g.nz ? iz * g.nx + ix : -1;
  }
  private begin(): void {
    const g = this.grid,
      p = this.car.root.position;
    const gx = Math.round(p.x / g.spacing),
      gz = Math.round((p.z + this.car.forward.z * 8) / g.spacing);
    const dx = gx - Math.round(this.center.x / g.spacing),
      dz = gz - Math.round(this.center.y / g.spacing);
    if (this.running) {
      if (Math.abs(dx) < g.nx * 0.25 && Math.abs(dz) < g.nz * 0.25) return;
      g.shift(dx, dz);
    }
    this.running = this.mesh.visible = true;
    this.center.set(gx * g.spacing, gz * g.spacing);
    this.mesh.position.set(this.center.x, 0, this.center.y);
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const wx = this.center.x + (x - (g.nx - 1) * 0.5) * g.spacing,
          wz = this.center.y + (z - (g.nz - 1) * 0.5) * g.spacing;
        // The gutter crowns the road and drains spills away from the lane.
        g.floor[z * g.nx + x] = this.road.heightAt(wx, wz);
      }
  }
  setFlood(enabled: boolean, depthM = 0.34): void {
    if (enabled) {
      this.begin();
      this.floodLevel = this.road.heightAt(this.car.root.position.x, this.car.root.position.z) + Math.max(0, depthM);
    } else {
      if (this.flooded) {
        this.grid.wave.fill(0);
        this.grid.velocity.fill(0);
        this.grid.stats.peakWave = this.stats.depth = 0;
      }
      this.floodLevel = -1e3;
    }
    this.flooded = enabled;
    this.sleepIfDry();
  }

  setLeak(enabled: boolean): void {
    if (enabled) this.begin();
    this.leaking = enabled;
    if (!this.flooded) this.floodLevel = -1e3;
    this.sleepIfDry();
  }

  private sleepIfDry(): void {
    if (!this.running || this.flooded || this.leaking || this.grid.film.some(v => v > 0)) return;
    this.running = this.mesh.visible = false;
    this.accumulator = 0;
  }
  ignite(): void {
    this.begin();
    const g = this.grid;
    let best = -1;
    for (let i = 0; i < g.film.length; i++)
      if (g.film[i] > 0.025 && (best < 0 || g.film[i] > g.film[best])) best = i;
    if (best >= 0) g.flame[best] = 1;
  }
  /** Interpolate over the same diagonal as the rendered grid. */
  private waterHeight(x: number, z: number): number {
    const g = this.grid;
    const gx = (x - this.center.x) / g.spacing + (g.nx - 1) * 0.5;
    const gz = (z - this.center.y) / g.spacing + (g.nz - 1) * 0.5;
    if (gx < 0 || gz < 0 || gx > g.nx - 1 || gz > g.nz - 1) return -Infinity;
    const ix = Math.min(Math.floor(gx), g.nx - 2), iz = Math.min(Math.floor(gz), g.nz - 2);
    const tx = gx - ix, tz = gz - iz, a = iz * g.nx + ix, w = g.wave;
    if (tx + tz <= 1) return this.floodLevel + w[a] * (1 - tx - tz) + w[a + 1] * tx + w[a + g.nx] * tz;
    return this.floodLevel + w[a + g.nx + 1] * (tx + tz - 1) + w[a + g.nx] * (1 - tx) + w[a + 1] * (1 - tz);
  }
  depth(x: number, z: number): number {
    return this.flooded ? Math.max(0, this.waterHeight(x, z) - this.road.heightAt(x, z)) : 0;
  }
  /** Re-entry of a representative water sheet drives a local ring without adding net water. */
  returnSpray(x: number, z: number, strength: number): boolean {
    if (!this.flooded || this.depth(x, z) <= 0.001) return false;
    const g = this.grid, i = this.index(x, z);
    if (i < g.nx || i >= g.wave.length - g.nx || i % g.nx < 1 || i % g.nx === g.nx - 1) return false;
    const impulse = Math.min(1, Math.max(0, strength)) * 0.022;
    g.velocity[i] -= impulse;
    g.velocity[i - 1] += impulse * 0.25; g.velocity[i + 1] += impulse * 0.25;
    g.velocity[i - g.nx] += impulse * 0.25; g.velocity[i + g.nx] += impulse * 0.25;
    return true;
  }
  grip(x: number, z: number): number {
    if (!this.running) return 1;
    const i = this.index(x, z);
    return i < 0 ? 1 : 1 - Math.min(0.72, this.grid.film[i] * 2.0);
  }
  update(dt: number): void {
    if (!this.running || dt <= 0) return;
    const g = this.grid,
      p = this.car.root.position,
      f = this.car.forward;
    this.u.level.value = this.floodLevel;
    this.u.rain.value = this.engine.world.rainfall;
    (this.u.carPos.value as THREE.Vector3).copy(p);
    (this.u.carFwd.value as THREE.Vector3).copy(f);
    this.u.headlights.value = this.road.headlights;
    if (this.leaking || this.flooded) this.begin();
    const at = this.index(p.x - f.x * 1.35, p.z - f.z * 1.35);
    if (this.leaking && at >= 0) g.film[at] = Math.min(2, g.film[at] + dt * 3.8);
    const d = this.depth(p.x, p.z),
      speed = Math.abs(this.car.speed);
    this.stats.depth = d;
    if (this.flooded && speed > 0.2) {
      const sign = this.car.speed < 0 ? -1 : 1;
      const fx = f.x * sign, fz = f.z * sign;
      const half = this.car.rig.halfExtents;
      const leading = half.z * 0.86, trailing = half.z * 0.66, sideOffset = half.x * 0.88;
      const stern = this.index(p.x - fx * trailing, p.z - fz * trailing);
      const sternDepth = this.depth(p.x - fx * trailing, p.z - fz * trailing);
      const available = sternDepth * 0.6;
      const returnSpeed = Math.sqrt(9.81 * sternDepth);
      const momentumBudget = stern < 0 ? 0 : Math.max(0, g.velocity[stern] + returnSpeed);
      let displaced = 0, total = 0, wetDraft = 0;
      let highestCorner = -Infinity;
      const response = -Math.expm1(-dt * (8 + Math.min(16, speed)));
      for (let side = -1; side <= 1; side += 2) {
        const x = p.x + fx * leading + f.z * side * sideOffset;
        const z = p.z + fz * leading - f.x * side * sideOffset;
        const i = this.index(x, z);
        // Still-water draft sets the forcing. Feeding the crest back into its own
        // source can pump the surface above the roof on repeated slow passes.
        const draft = this.floodLevel - this.road.heightAt(x, z) - this.clearance;
        if (i < 0 || draft <= 0 || stern < 0) continue;
        wetDraft += draft * 0.5;
        highestCorner = Math.max(highestCorner, this.waterHeight(x, z));
        const crest = Math.min(0.42, draft * 0.95) * -Math.expm1(-speed * 0.2);
        const rise = Math.min(available * 0.5, Math.max(0, crest - g.wave[i]) * response);
        g.wave[i] += rise; displaced += rise;
        const target = Math.min(Math.sqrt(9.81 * draft) * 0.4, Math.max(0, crest - g.wave[i]) * 5);
        const increment = Math.min(momentumBudget * 0.5, Math.max(0, target - g.velocity[i]) * response);
        g.velocity[i] += increment; total += increment;
        const out = this.out;
        out.position.set(x, this.waterHeight(x, z) + 0.015, z);
        out.velocity.set((fx * 0.18 + f.z * side * 0.35) * speed,
          Math.min(6, speed * 0.31) * Math.min(1, draft * 4.5),
          (fz * 0.18 - f.x * side * 0.35) * speed);
        out.size = 0.08; out.sizeEnd = 0.24; out.temperature = 0;
        const rate = Math.min(120, draft * speed * 32);
        this.fx.spray.emitRateAt(this.carry, side > 0 ? 0 : 1, rate, dt, out);
        this.stats.spray += dt * rate;
      }
      if (wetDraft > 0) {
        const wet = this.bowSpray.at(p.x - fx * 0.75, this.floodLevel, p.z - fz * 0.75);
        wet.end.x = p.x + fx * leading; wet.end.z = p.z + fz * leading;
        wet.radius = half.x * 1.7;
        wet.wetness = Math.min(0.93, wetDraft * speed * 0.4);
        this.engine.world.publish(wet, 0.22);
        // A reversing car piles up water against the rear valance. Only the
        // forward-leading grille can send water over the hood.
        const edgeX = p.x + fx * half.z * 0.97, edgeZ = p.z + fz * half.z * 0.97;
        const edgeDepth = this.floodLevel - this.road.heightAt(edgeX, edgeZ);
        if (edgeDepth > this.clearance + 0.06 && speed > 3) {
          const head = this.out;
          head.position.set(edgeX, highestCorner + 0.022, edgeZ);
          head.velocity.set(fx * speed * 0.7, Math.min(5.4, speed * 0.45) * Math.min(1, edgeDepth * 2.6), fz * speed * 0.7);
          head.radius = half.x * 0.5; head.spread = 1.1; head.size = 0.065; head.sizeEnd = 0.15;
          const rate = Math.min(105, (edgeDepth - this.clearance) * speed * 26);
          this.fx.spray.emitRateAt(this.carry, 9, rate, dt, head);
          if (sign > 0) this.stats.hoodSpray += rate * dt;
          else this.stats.rearSpray += rate * dt;
          head.radius = 0.38; head.spread = 1.3;
        }
        g.velocity[stern] -= total;
        g.wave[stern] -= displaced;
        this.stats.bow += total;
        this.car.chassis.linvel(this.position);
        this.position.multiplyScalar(-Math.min(0.08, dt * wetDraft * 1.25) * this.car.chassis.mass());
        this.position.y = 0;
        this.car.chassis.applyImpulse(this.position, true);
      }
    }
    this.accumulator += dt;
    if (this.accumulator < 1 / 24) return;
    const step = Math.min(this.accumulator, 0.085);
    this.accumulator = 0;
    const waterLevel = this.flooded ? this.floodLevel : -1e3;
    g.couple(this.engine.world, this.center.x, this.center.y, waterLevel, step, this.surfacePulse);
    g.step(step, waterLevel, this.engine.world.rainfall, this.engine.world.shelters, this.center.x, this.center.y);
    let emit = 0,
      first = -1;
    for (let i = 0; i < g.film.length; i++) {
      const c = i * 4;
      this.pixels[c] = Math.max(g.floor[i], this.floodLevel + g.wave[i]);
      this.pixels[c + 1] = g.film[i];
      this.pixels[c + 2] = g.flame[i];
      this.pixels[c + 3] = Math.max(0, this.floodLevel + g.wave[i] - g.floor[i]);
      if (g.flame[i] > 0.15 && emit < 7) {
        if (first < 0) first = i;
        const out = this.out;
        out.position.set(
          this.center.x + ((i % g.nx) - (g.nx - 1) * 0.5) * g.spacing,
          this.pixels[c] + 0.08,
          this.center.y + (Math.floor(i / g.nx) - (g.nz - 1) * 0.5) * g.spacing
        );
        out.velocity.set(0, 1.7, 0);
        out.size = 0.42;
        out.sizeEnd = 0.8;
        out.temperature = 0.9;
        this.fx.fire.emitRateAt(this.carry, 2 + emit++, 18 * g.flame[i], step, out);
      }
    }
    if (first >= 0) {
      const s = this.surfacePulse.at(this.out.position.x, this.out.position.y, this.out.position.z);
      s.radius = 2.5;
      s.heat = 180;
      this.engine.world.publish(s, 0.3);
    }
    this.fieldTexture.needsUpdate = true;
  }
  dispose(): void {
    this.unregisterWater();
    this.engine.world.removeSource(this.surfacePulse);
    this.engine.world.removeSource(this.bowSpray);
    if (this.road.streetFluid === this) this.road.streetFluid = undefined;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.fieldTexture.dispose();
  }
}
