import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../engine/noise';
import type { PlantForm, Species } from './botany';

function surface(width: number, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true })!;
}
function texture(ctx: CanvasRenderingContext2D, color = false) {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
/** RG stores leaf relief in tangent space and B stores roughness; coverage lives in the colour tile. */
export function leafAtlas(
  kind: Species,
  seed: number,
  recipe?: Readonly<import('../landscape/library').PlantRecipe>,
) {
  const ctx = surface(128),
    rand = mulberry32(seed),
    pinnate = kind === 'palm' || kind === 'fern',
    needle = kind === 'cypress';
  ctx.lineCap = 'round';
  function blade(x: number, y: number, ex: number, ey: number, w: number, light: number) {
    w *= recipe?.leafWidth ?? 1;
    const dx = ex - x,
      dy = ey - y,
      len = Math.max(1, Math.hypot(dx, dy)),
      px = (-dy / len) * w,
      py = (dx / len) * w;
    const green = light * (kind === 'gorse' ? 0.94 : 1);
    ctx.fillStyle =
      'rgb(' + Math.floor(light * 219) + ',' + Math.floor(green * 238) + ',' + Math.floor(light * 182) + ')';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + dx * 0.47 + px, y + dy * 0.47 + py, ex, ey);
    ctx.quadraticCurveTo(x + dx * 0.55 - px * 0.81, y + dy * 0.55 - py * 0.81, x, y);
    ctx.fill();
    if (w > 2.6) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(ex, ey);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = 'rgba(242,230,165,.55)';
      ctx.stroke();
    }
  }
  const axis = (t: number) => 64 + 6 * Math.sin(t * 2.4);
  ctx.beginPath();
  ctx.moveTo(64, 127);
  ctx.quadraticCurveTo(70, 63, axis(1), 4);
  ctx.lineWidth = pinnate ? 2.3 : 1.8;
  ctx.strokeStyle = '#a6a482';
  ctx.stroke();
  const rows = needle ? 23 : pinnate ? 12 : kind === 'willow' ? 10 : 7;
  for (let j = 0; j < rows; j++)
    for (const s of [-1, 1]) {
      const t = (j + 0.2 + rand() * 0.25) / rows,
        x = axis(t),
        y = 123 - t * 108;
      const breadth = (13 + 39 * Math.sin((0.08 + t * 0.87) * Math.PI)) * (0.85 + 0.15 * rand());
      const ex = x + s * breadth,
        ey = Math.max(2, y - (pinnate ? 17 : 12) - rand() * 14);
      if (pinnate || needle)
        blade(x, y, ex, ey, needle ? 2.7 : kind === 'palm' ? 4.7 : 6.9, 0.69 + 0.31 * rand());
      else {
        ctx.strokeStyle = '#888b69';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        for (let k = 1; k <= 3; k++) {
          const f = k / 3,
            sx = x + (ex - x) * f,
            sy = y + (ey - y) * f;
          blade(
            sx,
            sy,
            Math.max(2, Math.min(126, sx + s * (4 + rand() * 11))),
            Math.max(1, sy - 10 - rand() * 10),
            kind === 'willow' || kind === 'sagebrush' || kind === 'heather' ? 3.3 : 5 + rand() * 4,
            0.64 + 0.34 * rand(),
          );
        }
      }
    }
  if (kind === 'gorse' || kind === 'heather') {
    for (let j = 0; j < 11; j++) {
      const t = 0.17 + 0.71 * rand(),
        x = axis(t) + (j % 2 ? 1 : -1) * (9 + rand() * 19),
        y = 124 - t * 109;
      ctx.fillStyle = kind === 'heather' ? (j % 2 ? '#d995b5' : '#ae648c') : j % 3 ? '#f1c34a' : '#d99d32';
      ctx.beginPath();
      ctx.ellipse(x, y, 2.8, 1.8, -0.7, 0, Math.PI * 2);
      ctx.ellipse(x - 1, y - 1.7, 1.8, 2.5, 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (recipe?.drawLeaves) {
    ctx.clearRect(0, 0, 128, 128);
    recipe.drawLeaves(ctx, seed);
  }
  const image = ctx.getImageData(0, 0, 128, 128),
    detail = surface(128),
    out = detail.createImageData(128, 128);
  const value = (x: number, y: number) => {
    const j = 4 * (Math.max(0, Math.min(127, y)) * 128 + Math.max(0, Math.min(127, x)));
    return (image.data[j + 1] * image.data[j + 3]) / 65025;
  };
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const i = 4 * (y * 128 + x);
      out.data[i] = 128 + 55 * (value(x - 1, y) - value(x + 1, y));
      out.data[i + 1] = 128 + 55 * (value(x, y + 1) - value(x, y - 1));
      out.data[i + 2] = 145 + 60 * value(x, y);
      out.data[i + 3] = 255;
    }
  detail.putImageData(out, 0, 0);
  return { leaf: texture(ctx, true), detail: texture(detail), canvas: ctx.canvas };
}

export function barkAtlas() {
  const ctx = surface(128),
    img = ctx.createImageData(128, 128);
  const ridge = (x: number, y: number) => {
    const a = (x * 2 * Math.PI) / 128,
      b = (y * 2 * Math.PI) / 128;
    return (
      Math.pow(0.5 + 0.5 * Math.cos(a * 13 + 0.72 * Math.sin(b + a * 2) + 0.43 * Math.sin(b * 3 - a)), 5) *
        0.65 +
      0.2 * Math.sin(41 * a + Math.sin(2 * b)) +
      0.1 * Math.cos(a * 33 + b * 2)
    );
  };
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const j = 4 * (128 * y + x),
        h = ridge(x, y);
      img.data[j] = 134 + 62 * h;
      img.data[j + 1] = 128 + 70 * (ridge(x - 1, y) - ridge(x + 1, y));
      img.data[j + 2] = 168 + 65 * h;
      img.data[j + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = texture(ctx);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Bake the near mesh's branches and sprays in side views and, for authored crowns, from above. */
export function crownImpostor(
  form: PlantForm,
  tile: HTMLCanvasElement,
  barkColor = '#837368',
  overhead = false,
  seasonal = overhead,
) {
  const res = 256,
    views = overhead ? 4 : 3,
    ctx = surface(res * views, res),
    limbs = seasonal ? surface((res * views) / 2, res / 2) : undefined,
    radius = form.radius,
    h = form.height;
  const pos: number[] = [],
    norm: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  // All projections share the leaf tile and its depth tones.
  const tones = Array.from({ length: 8 }, (_, i) => {
    const shade = surface(tile.width);
    shade.drawImage(tile, 0, 0);
    shade.globalCompositeOperation = 'source-atop';
    shade.fillStyle = 'rgba(16,25,14,' + 0.64 * (1 - i / 7) + ')';
    shade.fillRect(0, 0, tile.width, tile.height);
    return shade.canvas;
  });
  for (let view = 0; view < views; view++) {
    const a = (view * Math.PI) / 3,
      c = Math.cos(a),
      s = Math.sin(a);
    const top = view === 3;
    const x = (p: THREE.Vector3) => res * (0.5 + (top ? p.x : p.x * c + p.z * s) / (radius * 2.03)),
      y = (p: THREE.Vector3) => (top ? res * (0.5 + p.z / (radius * 2.03)) : res * (0.99 - (p.y / h) * 0.97));
    ctx.save();
    ctx.translate(res * view, 0);
    ctx.beginPath();
    ctx.rect(0, 0, res, res);
    ctx.clip();
    ctx.lineCap = 'round';
    for (const b of form.wood) {
      for (let j = 1; j < b.path.length; j++) {
        ctx.strokeStyle = barkColor;
        ctx.lineWidth = Math.max(
          0.62,
          (res / radius) * THREE.MathUtils.lerp(b.base, b.end, (j - 0.5) / (b.path.length - 1)),
        );
        ctx.beginPath();
        ctx.moveTo(x(b.path[j - 1]), y(b.path[j - 1]));
        ctx.lineTo(x(b.path[j]), y(b.path[j]));
        ctx.stroke();
      }
    }
    limbs?.drawImage(ctx.canvas, res * view, 0, res, res, (view * res) / 2, 0, res / 2, res / 2);
    const sorted = [...form.leaves].sort((l, r) =>
      top ? l.root.y - r.root.y : (l.root.z - r.root.z) * c - (l.root.x - r.root.x) * s,
    );
    for (const leaf of sorted) {
      const dx = x(leaf.tip) - x(leaf.root),
        dy = y(leaf.tip) - y(leaf.root),
        len = Math.max(2, Math.hypot(dx, dy));
      const w = Math.max(2, (leaf.span * res) / (radius * 1.75));
      ctx.save();
      ctx.translate(x(leaf.root), y(leaf.root));
      ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
      const height = leaf.root.y / h,
        depth = (leaf.root.z * c - leaf.root.x * s) / radius;
      const lit = THREE.MathUtils.clamp(
        0.12 + 0.56 * height + 0.27 * depth + 0.1 * Math.sin(leaf.tip.x * 4 + leaf.tip.z * 5),
        0,
        1,
      );
      ctx.drawImage(tones[Math.round(lit * 7)], -w / 2, -len, w, len);
      ctx.restore();
    }
    ctx.restore();
    const i = pos.length / 3,
      u0 = (res * view + 1) / (res * views),
      u1 = (res * view + res - 1) / (res * views);
    for (const [side, up] of [
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
    ]) {
      if (top) {
        pos.push(radius * side, h * 0.7, radius * (1 - 2 * up));
        norm.push(0, 1, 0);
      } else {
        pos.push(c * radius * side, h * up, s * radius * side);
        norm.push(-s, 0, c);
      }
      uv.push(side < 0 ? u0 : u1, up);
    }
    idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
  }
  const geo = new THREE.BufferGeometry();
  for (const [name, arr, size] of [
    ['position', pos, 3],
    ['normal', norm, 3],
    ['uv', uv, 2],
  ] as const)
    geo.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  geo.setIndex(idx);
  return { geometry: geo, map: texture(ctx, true), limbs: limbs ? texture(limbs, true) : undefined };
}
