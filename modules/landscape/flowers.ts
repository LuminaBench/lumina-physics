/** Local-metres flower geometry. Supply arbitrary triangles through the same writer used by the meadow. */
export interface FlowerHead {
  x: number;
  y: number;
  z: number;
  radius: number;
  petals: number;
  curve: number;
  phase: number;
}
export interface FlowerWriter {
  vertex(x: number, y: number, z: number, nx: number, nz: number): number;
  triangle(a: number, b: number, c: number): void;
}
export function bellFlower(h: FlowerHead, mesh: FlowerWriter) {
  const segments = h.petals * 2,
    rows: number[][] = [];
  for (let ring = 0; ring < 4; ring++) {
    const row: number[] = [];
    rows.push(row);
    for (let j = 0; j < segments; j++) {
      const angle = h.phase + (j * 2 * Math.PI) / segments,
        tip = j % 2 === 0,
        rad = h.radius * [0.13, 0.5, 0.7, tip ? 1 : 0.78][ring];
      const drop = h.radius * Math.abs(h.curve) * [0, 0.42, 0.83, tip ? 0.96 : 1.17][ring];
      row.push(
        mesh.vertex(
          h.x + Math.cos(angle) * rad,
          h.y - drop,
          h.z + Math.sin(angle) * rad,
          Math.cos(angle),
          Math.sin(angle),
        ),
      );
    }
    if (!ring) continue;
    const last = rows[ring - 1];
    for (let j = 0; j < segments; j++) {
      const n = (j + 1) % segments;
      mesh.triangle(last[j], row[j], last[n]);
      mesh.triangle(last[n], row[j], row[n]);
    }
  }
}
export function seedSpike(h: FlowerHead, mesh: FlowerWriter) {
  for (let i = 0; i < 7; i++) {
    const a = h.phase + i * 2.4,
      r = h.radius * (1 - i * 0.085),
      y = h.y + h.radius * i * 0.53,
      dx = Math.cos(a) * r,
      dz = Math.sin(a) * r;
    const p = mesh.vertex(h.x, y, h.z, 0, 1),
      q = mesh.vertex(
        h.x + dx * 0.65 - dz * 0.29,
        y + r * 0.4,
        h.z + dz * 0.65 + dx * 0.29,
        Math.cos(a),
        Math.sin(a),
      ),
      s = mesh.vertex(
        h.x + dx * 0.65 + dz * 0.29,
        y + r * 0.4,
        h.z + dz * 0.65 - dx * 0.29,
        Math.cos(a),
        Math.sin(a),
      ),
      t = mesh.vertex(h.x + dx, y + r * 1.7, h.z + dz, Math.cos(a), Math.sin(a));
    mesh.triangle(p, q, s);
    mesh.triangle(q, t, s);
  }
}
