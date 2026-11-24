import { BufferGeometry, Float32BufferAttribute, Color } from 'three/webgpu';
import {
  mulberry32,
  type FlowerHead,
  type FlowerWriter,
  type LandLibrary,
  type CoverRecipe,
  type AuthoredLandscape,
} from '../physics';
import { basinDepth, hollows } from './valley';
export const flowerId = 'reach:vesper-cup';
export const revisedId = 'reach:scalloped-vesper-cup';
export const meadowId = 'reach:bank-blades';
export function foldedBell(h: FlowerHead, writer: FlowerWriter) {
  // A pinched neck, swollen throat and a rolled, scalloped lip. Each flute has a deep central rib.
  const rows: number[][] = [],
    steps = h.petals * 3;
  for (const [drop, span] of [
    [0, 0.14],
    [0.24, 0.52],
    [0.63, 0.72],
    [0.91, 0.83],
    [1, 1],
  ]) {
    const row: number[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps + h.phase,
        rib = Math.cos(a * h.petals - h.phase * h.petals);
      const rad = h.radius * span * (0.92 + 0.08 * rib);
      const x = Math.cos(a) * rad,
        z = Math.sin(a) * rad;
      row.push(
        writer.vertex(
          h.x + x + drop * h.radius * 0.33,
          h.y - h.radius * Math.abs(h.curve) * (drop + (drop === 1 ? rib * 0.18 : 0)),
          h.z + z,
          Math.cos(a),
          Math.sin(a),
        ),
      );
    }
    const last = rows.at(-1);
    if (last)
      for (let i = 0; i < steps; i++) {
        const k = (i + 1) % steps;
        writer.triangle(last[i], row[k], row[i]);
        writer.triangle(last[i], last[k], row[k]);
      }
    rows.push(row);
  }
}
export function registerFlowers(lib: LandLibrary) {
  // The ordinary meadow only supplies foliage. The flower colony layer owns placement and petals.
  lib.define('cover', meadowId, { bloom: [], flowerHead() {}, height: 0.31, dry: 0.35 }, 'lumina:meadow');
  lib.define(
    'cover',
    flowerId,
    {
      height: 0.48,
      width: 0.012,
      radius: 0.044,
      petals: 5,
      bell: -1.66,
      stemColor: '#668054',
      petalColor: '#587ed6',
      minimumShade: 0.46,
      bloom: ['autumn'],
      flowerHead: foldedBell,
    },
    'lumina:bluebells',
  );
  lib.define('cover', revisedId, { radius: 0.06, petals: 8, petalColor: '#718eef' }, flowerId);
}
export const eligibleSite = (
  land: AuthoredLandscape,
  recipe: Readonly<CoverRecipe>,
  x: number,
  z: number,
) => {
  const site = land.earth.inspect(x, z);
  return (
    site.reason === 'plantable' &&
    site.height > land.surface.waterLevel + 0.32 &&
    site.shade >= (recipe.minimumShade ?? 0) &&
    basinDepth(x, z) > 0.27 &&
    recipe.bloom.includes(land.earth.season)
  );
};
export function colonies(land: AuthoredLandscape, recipe: Readonly<CoverRecipe>) {
  const random = mulberry32(land.seeds.flowers),
    placements: { x: number; y: number; z: number; scale: number; yaw: number }[] = [];
  for (const h of hollows)
    for (let i = 0; i < 165; i++) {
      const a = random() * Math.PI * 2,
        d = h.radius * Math.sqrt(random());
      const x = h.x + d * Math.cos(a),
        z = h.z + d * Math.sin(a),
        scale = 0.69 + random() * 0.54,
        yaw = random() * 6.283;
      if (eligibleSite(land, recipe, x, z))
        placements.push({ x, y: land.earth.inspect(x, z).height, z, scale, yaw });
    }
  return placements;
}
export function flowerGeometry(recipe: Readonly<CoverRecipe>) {
  const p: number[] = [],
    colors: number[] = [],
    indices: number[] = [];
  const leaf = new Color(recipe.stemColor),
    petal = new Color(recipe.petalColor);
  let ink = leaf;
  const writer: FlowerWriter = {
    vertex(x, y, z) {
      p.push(x, y, z);
      colors.push(ink.r, ink.g, ink.b);
      return p.length / 3 - 1;
    },
    triangle(a, b, c) {
      indices.push(a, b, c);
    },
  };
  // A slender arch with a pendant terminal cup and two pointed basal leaves.
  const h = recipe.height,
    dx = h * 0.25,
    stemRows: number[][] = [];
  for (let row = 0; row <= 6; row++) {
    const t = row / 6,
      ring: number[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (k * Math.PI * 2) / 5;
      ring.push(
        writer.vertex(
          dx * t ** 3 + 0.006 * Math.cos(a),
          h * (t + 0.15 * Math.sin(t * Math.PI)),
          0.006 * Math.sin(a),
          0,
          0,
        ),
      );
    }
    const prev = stemRows.at(-1);
    if (prev)
      for (let k = 0; k < 5; k++) {
        const j = (k + 1) % 5;
        writer.triangle(prev[k], ring[k], ring[j]);
        writer.triangle(prev[k], ring[j], prev[j]);
      }
    stemRows.push(ring);
  }
  for (const sign of [-1, 1]) {
    const a = writer.vertex(0, 0.01, 0, 0, 0),
      b = writer.vertex(0.012, h * 0.33, sign * 0.061, 0, 0),
      c = writer.vertex(-0.016, h * 0.32, sign * 0.056, 0, 0),
      d = writer.vertex(-0.04, h * 0.59, sign * 0.13, 0, 0);
    writer.triangle(a, b, c);
    writer.triangle(c, b, d);
  }
  ink = petal;
  recipe.flowerHead!(
    { x: dx, y: h, z: 0, radius: recipe.radius, curve: recipe.bell, petals: recipe.petals, phase: 0.27 },
    writer,
  );
  const mesh = new BufferGeometry();
  mesh.setAttribute('position', new Float32BufferAttribute(p, 3));
  mesh.setAttribute('color', new Float32BufferAttribute(colors, 3));
  mesh.setIndex(indices);
  mesh.computeVertexNormals();
  return mesh;
}
