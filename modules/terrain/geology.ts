import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame } from '../../engine/frame';
import { perturbNormalHeight } from '../../engine/shading';
import type { Biome } from './biomes';

const { vec3, vec2, float, mix, positionWorld, normalWorldGeometry, smoothstep, texture, uniform } = TSL;
function hash(x: number, y: number) {
  let v = Math.imul(x + 19, 374761393) ^ Math.imul(y + 23, 668265263);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
}
function noise(u: number, v: number, n: number) {
  const x = Math.floor(u * n),
    y = Math.floor(v * n),
    s = THREE.MathUtils.smoothstep(u * n - x, 0, 1),
    t = THREE.MathUtils.smoothstep(v * n - y, 0, 1);
  const h = (a: number, b: number) => hash(((a % n) + n) % n, ((b % n) + n) % n);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(h(x, y), h(x + 1, y), s),
    THREE.MathUtils.lerp(h(x, y + 1), h(x + 1, y + 1), s),
    t,
  );
}
/** Tileable relief, mineral grain and fracture depth. Vertically split bedding shares a crack network across mips. */
function rockAtlas() {
  const n = 256,
    pixels = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = i / n,
        v = j / n,
        warp = noise(u, v, 6) - 0.5,
        small = noise(u, v, 41),
        grain = noise(u, v, 94);
      const x = (u + 0.031 * warp + 0.012 * small) * 7,
        y = (v + 0.022 * warp) * 3,
        k = Math.floor(x),
        l = Math.floor(y);
      let first = 9,
        second = 9;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const a = k + dx,
            b = l + dy,
            h = ((a % 7) + 7) % 7,
            w = ((b % 3) + 3) % 3;
          const d = (x - a - 0.14 - 0.72 * hash(h, w)) ** 2 + (y - b - 0.14 - 0.72 * hash(h + 19, w)) ** 2;
          if (d < first) {
            second = first;
            first = d;
          } else if (d < second) second = d;
        }
      const gap = Math.sqrt(second) - Math.sqrt(first);
      const crack = 1 - THREE.MathUtils.smoothstep(gap, 0.012, 0.14);
      const tilt = Math.sin(u * Math.PI * 2) * 0.31 + warp * 0.72;
      const beds = 0.5 + 0.5 * Math.cos((v * 13 + tilt) * Math.PI * 2),
        lamina = Math.pow(beds, 6);
      const h = 0.27 + 0.28 * noise(u, v, 8) + small * 0.24 + grain * 0.09 - lamina * 0.14 - crack * 0.16;
      const q = 4 * (j * n + i);
      pixels[q] = Math.max(0, h) * 255;
      pixels[q + 1] = 255 * (0.16 + 0.4 * small + 0.25 * grain + noise(u, v, 3) * 0.17);
      pixels[q + 2] = crack * 255;
      pixels[q + 3] = 255;
    }
  const tex = new THREE.DataTexture(pixels, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export class LandGeology {
  readonly atlas = rockAtlas();
  readonly tint = uniform(new THREE.Color('#73804e'));
  readonly bands = uniform(0);
  readonly shade: THREE.DataTexture;
  constructor(
    readonly biome: Biome,
    readonly size: number,
    private readonly art?: import('../landscape/authored').AuthoredLandscape,
  ) {
    const shade = new Uint8Array(256 * 256).fill(255);
    this.shade = new THREE.DataTexture(shade, 256, 256, THREE.RedFormat);
    this.shade.minFilter = this.shade.magFilter = THREE.LinearFilter;
    this.shade.needsUpdate = true;
  }
  get rockRecipe() {
    return this.art?.rock;
  }
  private strata(p: N, n: N) {
    const w = n.abs().pow(4),
      uv = p.mul(0.17);
    const x = texture(this.atlas, vec2(uv.z, uv.y.add(uv.z.mul(0.11)))),
      y = texture(this.atlas, uv.xz.mul(0.78)),
      z = texture(this.atlas, vec2(uv.x, uv.y.sub(uv.x.mul(0.09))));
    return x.mul(w.x).add(y.mul(w.y)).add(z.mul(w.z)).div(w.x.add(w.y).add(w.z).max(0.001));
  }
  rock(p: N, n: N, wet: N) {
    const s = this.strata(p, n),
      micro = this.strata(p.mul(3.81).add(4.63), n);
    const undulation = texture(this.atlas, p.xz.mul(0.0081)).g;
    const bed = p.y
      .mul(this.art?.rock.bedding ?? 3.2)
      .add(p.x.mul(0.23))
      .sub(p.z.mul(0.12))
      .add(undulation.mul(8.3))
      .add(p.z.mul(0.073).sin().mul(1.68))
      .add(s.r.mul(2.5))
      .sin();
    const seam = smoothstep(0.72, 0.97, bed).mul(smoothstep(0.21, 0.64, undulation.add(s.g.mul(0.22))));
    // Large bed joints cross the smaller stone grain on a separate physical scale.
    const joint = this.strata(p.mul(0.233).add(3.19), n).b;
    const exposed = smoothstep(0.21, 0.82, joint).mul(smoothstep(0.27, 0.66, undulation.add(s.g.mul(0.19))));
    const warm = this.art
      ? TSL.color(this.art.rock.light)
      : this.biome === 'dry-highlands'
        ? vec3(0.34, 0.226, 0.136)
        : vec3(0.238, 0.222, 0.201);
    const cool = this.art
      ? TSL.color(this.art.rock.dark)
      : this.biome === 'dry-highlands'
        ? vec3(0.118, 0.092, 0.079)
        : vec3(0.072, 0.087, 0.094);
    const mineral = smoothstep(0.18, 0.81, s.g.mul(0.41).add(micro.g.mul(0.15)).add(undulation.mul(0.44)));
    const banded = TSL.floor(mineral.mul(5)).div(5);
    const lit = mix(mineral, banded, this.bands.mul(0.57));
    let color = mix(cool, warm, lit)
      .mul(s.r.mul(0.64).add(0.74))
      .mul(
        float(1)
          .sub(seam.mul(0.32))
          .sub(s.b.mul(0.19))
          .sub(exposed.mul(this.art ? this.art.rock.fracture * 0.46 : 0.31)),
      );
    const moss = smoothstep(0.58, 0.91, n.y)
      .mul(smoothstep(0.35, 0.68, undulation.add(s.g.sub(0.5).mul(0.63))))
      .mul(this.biome === 'dry-highlands' ? 0.21 : 0.72);
    color = mix(color, this.tint.mul(s.g.mul(0.86).add(0.31)), moss);
    color = color.mul(mix(vec3(1), vec3(0.43, 0.53, 0.57), wet));
    return {
      color,
      height: s.r
        .mul(this.art?.rock.relief ?? 0.14)
        .add(micro.r.mul(0.017))
        .sub(seam.mul(0.026))
        .sub(exposed.mul(0.057)),
      rough: mix(float(0.87), float(0.32), wet),
    };
  }
  terrain = (
    material: THREE.MeshStandardNodeMaterial,
    waterColor: N,
    shore: N,
    wet: N,
    damp: N,
    sandRelief: N,
  ) => {
    const p = positionWorld,
      n = normalWorldGeometry,
      coarse = texture(this.atlas, p.xz.mul(0.037)),
      micro = texture(this.atlas, p.xz.mul(1.46));
    const rockiness = smoothstep(0.07, 0.29, float(1).sub(n.y.abs()).add(coarse.r.sub(0.5).mul(0.11)));
    const splash = smoothstep(-0.15, 1.7, shore).oneMinus().mul(0.85);
    if (this.biome === 'dry-highlands') {
      wet = float(0);
      damp = float(0);
    }
    const rock = this.rock(p, n, this.biome === 'dry-highlands' ? float(0) : wet.max(splash));
    const moss = TSL.attribute('terrainColor', 'vec3'),
      soil = this.biome === 'dry-highlands' ? vec3(0.22, 0.158, 0.085) : vec3(0.096, 0.083, 0.045);
    const shoreLand =
      this.biome === 'dry-highlands' ? float(1) : smoothstep(0.47, 2.65, shore.add(coarse.g.mul(0.45)));
    const veg = mix(soil, this.tint, coarse.g.mul(0.59).add(0.22)).mul(micro.g.mul(0.39).add(0.8));
    let shade = texture(this.shade, p.xz.div(this.size).add(0.5)).r;
    if (this.art) {
      const sun = frame.sunDirection;
      const canopy = texture(
        this.shade,
        p.xz
          .add(sun.xz.div(sun.y.max(0.18)).mul(4.1))
          .div(this.size)
          .add(0.5),
      ).r;
      const flecks = coarse.r.mul(2).sub(0.36).clamp(0.22, 0.9);
      shade = shade.mul(TSL.mix(TSL.float(1), canopy.pow(2), flecks.mul(frame.sunVisibility)));
    }
    const ground = mix(moss.mul(coarse.g.mul(0.36).add(0.81)), veg, 0.76).mul(shade);
    const sand = mix(vec3(0.26, 0.217, 0.14), vec3(0.45, 0.37, 0.25), coarse.g).mul(
      float(1).sub(wet.mul(0.52)).sub(damp.mul(0.14)),
    );
    const beach = mix(waterColor, sand, smoothstep(-0.31, 0.3, shore));
    let surface = mix(beach, ground, shoreLand);
    const shoal = smoothstep(0.49, 0.71, coarse.g)
      .mul(smoothstep(-5, -0.5, shore))
      .mul(smoothstep(-0.25, -0.75, shore));
    surface = mix(
      surface,
      rock.color.mul(mix(vec3(0.43, 0.72, 0.73), vec3(1), smoothstep(-1.8, 0.1, shore))),
      this.biome === 'dry-highlands' ? rockiness : rockiness.max(shoal.mul(0.77)),
    );
    if (this.art) {
      const art = this.art,
        edits = texture(art.earth.map, p.xz.div(this.size).add(0.5));
      const site = texture(art.earth.habitatMap, p.xz.div(this.size).add(0.5));
      const tread = art.tracks.sampleNode(p.xz);
      const exposedSoil = art.groundTint.mul(coarse.g.mul(0.7).add(0.55));
      const patch = TSL.sin(
        p.x
          .mul(0.049)
          .add(art.earth.seed % 29)
          .add(TSL.sin(p.z.mul(0.036))),
      )
        .mul(TSL.cos(p.z.mul(0.057).sub(p.x.mul(0.013))))
        .mul(0.5)
        .add(0.5);
      const gravel = TSL.float(1).sub(site.a.mul(6).sub(2).abs()).saturate();
      const clay = TSL.float(1).sub(site.a.mul(6).sub(1).abs()).saturate();
      const road = TSL.smoothstep(0.86, 0.98, site.a);
      const soilMask = smoothstep(0.26, 0.74, patch).mul(0.42).add(edits.r.mul(0.58)).clamp(0, 1);
      surface = mix(surface, exposedSoil, soilMask.mul(rockiness.oneMinus()).mul(shoreLand));
      surface = mix(
        surface,
        TSL.mix(TSL.color('#66615b'), TSL.color('#928b73'), micro.g).mul(coarse.r.add(0.63)),
        gravel.mul(0.68).mul(shoreLand),
      );
      surface = mix(surface, TSL.color('#785e43').mul(micro.g.add(0.48)), clay.mul(0.61).mul(shoreLand));
      surface = mix(
        surface,
        vec3(0.26, 0.13, 0.048).mul(coarse.g.add(0.55)),
        art.autumn.mul(patch).mul(0.54).mul(shoreLand),
      );
      if (art.region.form === 'street') {
        const fromRoad = p.x.sub(p.z.mul(0.015).sin().mul(8)).abs();
        surface = mix(
          surface,
          vec3(0.054, 0.06, 0.065).mul(micro.g.mul(0.64).add(0.68)),
          smoothstep(4.65, 4.4, fromRoad),
        );
      }
      surface = mix(surface, TSL.color('#494947').mul(micro.g.mul(0.52).add(0.75)), road);
      if (art.region.form === 'farm') {
        const furrow = p.x.mul(2.25).cos().mul(0.5).add(0.5);
        surface = mix(surface, exposedSoil.mul(furrow.mul(0.51).add(0.58)), shoreLand.mul(0.47));
      }
      const snow = art.winter
        .mul(n.y.max(0).pow(2))
        .mul(site.b.mul(0.66).add(0.24).add(patch.mul(0.14)))
        .mul(edits.r.mul(0.84).oneMinus());
      const thaw = art.winter.mul(frame.sunDirection.y.max(0)).mul(site.b.oneMinus()).mul(1.6).add(art.rain.mul(.54)).add(edits.r.mul(.4)).saturate();
      const slush=snow.mul(thaw);wet=wet.max(slush.mul(.81));
      surface = mix(surface, vec3(0.72, 0.8, 0.86).mul(coarse.g.mul(0.31).add(0.82)), snow.mul(thaw.mul(.62).oneMinus()));
      wet = wet
        .max(art.rain.mul(site.g.oneMinus().mul(0.7).add(0.3)))
        .max(edits.g)
        .max(tread.r);
      surface = mix(surface, exposedSoil.mul(0.62), tread.g.mul(0.9));
      surface = surface.mul(wet.mul(0.42).oneMinus()).mul(edits.b.mul(0.15).oneMinus());
    }
    material.colorNode = surface;
    material.roughnessNode = mix(mix(float(0.91), float(0.22), wet), rock.rough, rockiness);
    material.normalNode = perturbNormalHeight(
      mix(
        mix(sandRelief.mul(0.54), micro.g.mul(0.006).add(coarse.g.mul(0.018)), shoreLand),
        rock.height,
        this.biome === 'dry-highlands' ? rockiness : rockiness.max(shoal),
      ),
      1,
    );
  };
  dispose() {
    this.atlas.dispose();
    this.shade.dispose();
  }
}
