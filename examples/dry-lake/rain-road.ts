import * as T from 'three/webgpu';
import { TSL } from '../../engine/tsl';
import { perturbNormalHeight } from '../../engine/shading';
import { StreetDrainage } from '../../modules/wet-road/drainage';

/** A short surveyed piece of abandoned tarmac. Runoff can collect in its two worn wheel paths. */
export function rainRoad(x: number, z: number, environment: any, bed: (x: number, z: number) => number) {
  const length = 18,
    width = 5.2;
  let crest = -Infinity;
  for (const dx of [-width / 2, 0, width / 2])
    for (const dz of [-length / 2, 0, length / 2]) crest = Math.max(crest, bed(x + dx, z + dz));
  const level = crest + 0.14;
  const floor = (wx: number, wz: number) => {
    const a = wx - x,
      b = wz - z,
      lane = Math.abs(a + 0.06 * Math.sin(b * 0.44)) - 0.94;
    return (
      level +
      0.014 * (1 - (a / 2.7) ** 2) -
      0.023 * Math.exp(-((lane / 0.26) ** 2)) +
      0.003 * Math.cos(b * 0.57)
    );
  };
  const runoff = new StreetDrainage({
    x: x - width / 2,
    z: z - length / 2,
    width,
    length,
    columns: 32,
    rows: 48,
    ground: floor,
    roof: { area: 0, seconds: 4, outletX: x, outletZ: z },
    drains: [],
  });
  const root = new T.Group();
  const surface = new T.PlaneGeometry(width, length, 52, 60);
  surface.rotateX(-Math.PI / 2);
  const pos = surface.getAttribute('position');
  for (let i = 0; i < pos.count; i++)
    pos.setXYZ(i, x + pos.getX(i), floor(x + pos.getX(i), z + pos.getZ(i)), z + pos.getZ(i));
  surface.computeVertexNormals();
  const mat = new T.MeshPhysicalNodeMaterial({ roughness: 0.91, ior: 1.45 });
  const p = TSL.positionWorld.xz,
    depth = runoff.depthNode(p);
  const noise = TSL.mx_noise_float(TSL.vec3(p.mul(18), 0.4))
    .mul(0.5)
    .add(0.5);
  const coarse = TSL.mx_noise_float(TSL.vec3(p.mul(1.7), 4.8))
    .mul(0.5)
    .add(0.5);
  const dry = TSL.mix(TSL.color('#41413e'), TSL.color('#6b6861'), coarse.mul(0.53).add(noise.mul(0.43)));
  const film = TSL.smoothstep(0.00006, 0.00065, depth);
  const standing = TSL.smoothstep(0.0007, 0.0022, depth);
  const lateral = p.x.sub(x).abs();
  const lineWidth = 0.041;
  const aa = TSL.fwidth(lateral).max(0.003);
  const edgePaint = TSL.smoothstep(aa.negate(), aa, TSL.float(lineWidth).sub(lateral.sub(2.22).abs()))
    .mul(TSL.smoothstep(0.35, 0.77, coarse.mul(0.55).add(noise.mul(0.45))))
    .mul(0.6);
  const crack = p.x
    .sub(x + 1.54)
    .sub(TSL.sin(p.y.mul(1.44)).mul(0.045))
    .sub(coarse.mul(0.073))
    .abs();
  const intact = TSL.smoothstep(0.002, aa.add(0.012), crack).mul(0.32).add(0.68);
  mat.colorNode = TSL.mix(dry.mul(intact), TSL.color('#c8c0a7'), edgePaint).mul(film.mul(-0.49).add(1));
  mat.roughnessNode = TSL.mix(noise.mul(0.13).add(0.8), 0.48, film);
  const aggregate = noise.mul(0.00045).add(coarse.mul(0.0007)).mul(standing.oneMinus());
  const normal = TSL.mix(
    TSL.normalView,
    TSL.vec3(0, 1, 0).transformDirection(TSL.cameraViewMatrix),
    standing,
  ).normalize();
  mat.normalNode = perturbNormalHeight(aggregate, 1, normal);
  mat.positionNode = TSL.positionGeometry.add(TSL.vec3(0, runoff.depthNode(TSL.positionGeometry.xz), 0));
  mat.clearcoatNode = standing;
  mat.clearcoatRoughnessNode = TSL.float(0.08);
  mat.envNode = environment;
  const blacktop = new T.Mesh(surface, mat);
  blacktop.receiveShadow = true;
  root.add(blacktop);
  // Sloping gravel shoulders tie the raised pavement to the host terrain.
  const border: number[] = [],
    ix: number[] = [];
  const edge = (a: number, b: number) => {
    border.push(x + a, floor(x + a, z + b) - 0.002, z + b);
    const ox = x + a * 1.65,
      oz = z + b * 1.1;
    border.push(ox, bed(ox, oz) - 0.08, oz);
  };
  for (let i = 0; i < 18; i++) edge(-width / 2, -length / 2 + i);
  for (let i = 0; i < 6; i++) edge(-width / 2 + (i * width) / 6, length / 2);
  for (let i = 0; i < 18; i++) edge(width / 2, length / 2 - i);
  for (let i = 0; i < 6; i++) edge(width / 2 - (i * width) / 6, -length / 2);
  const count = border.length / 6;
  for (let i = 0; i < count; i++) {
    const a = 2 * i,
      b = 2 * ((i + 1) % count);
    ix.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const edgeGeom = new T.BufferGeometry();
  edgeGeom.setAttribute('position', new T.Float32BufferAttribute(border, 3));
  edgeGeom.setIndex(ix);
  edgeGeom.computeVertexNormals();
  root.add(
    new T.Mesh(
      edgeGeom,
      new T.MeshStandardMaterial({ color: '#927a63', roughness: 0.96, side: T.DoubleSide }),
    ),
  );
  // Beyond the measured section the abandoned road follows the relief and disappears around a bend.
  for (const sign of [-1, 1]) {
    const vertices: number[] = [],
      tri: number[] = [],
      shoulderTri: number[] = [];
    let cx = x,
      cz = z + (sign * length) / 2,
      angle = sign > 0 ? 0 : Math.PI;
    const initialAngle = angle;
    for (let i = 0; i <= 68; i++) {
      const d = i * 2.4;
      if (i > 0) {
        // Look ahead far enough to turn before an escarpment. Let an old road end on
        // its gravel shoulder when every reachable direction runs into a cliff.
        const y = bed(cx, cz);
        let best = Infinity,
          heading = angle;
        for (const turn of [-0.13, -0.065, 0, 0.065, 0.13]) {
          const side = angle + turn,
            look = angle + 3 * turn;
          const near = Math.abs(bed(cx + 2.4 * Math.sin(side), cz + 2.4 * Math.cos(side)) - y) / 2.4;
          const ahead = Math.abs(bed(cx + 18 * Math.sin(look), cz + 18 * Math.cos(look)) - y) / 18;
          const score =
            near + ahead + 0.21 * Math.abs(turn) + 0.025 * Math.abs(side - initialAngle - 0.23 * sign);
          if (score < best) {
            best = score;
            heading = side;
          }
        }
        if (best > 0.33) break;
        angle = heading;
        cx += 2.4 * Math.sin(angle);
        cz += 2.4 * Math.cos(angle);
      }
      for (const side of [-1.55, -1, 1, 1.55]) {
        const wx = cx + ((side * width) / 2) * Math.cos(angle) * sign,
          wz = cz - ((side * width) / 2) * Math.sin(angle) * sign;
        const h = T.MathUtils.lerp(
          floor(x + (side * width) / 2, z + (sign * length) / 2),
          bed(wx, wz) + 0.095,
          T.MathUtils.smoothstep(d, 0, 22),
        );
        vertices.push(wx, Math.abs(side) > 1 ? bed(wx, wz) - 0.13 : h, wz);
      }
      if (i) {
        const a = (i - 1) * 4;
        for (let k = 0; k < 3; k++) {
          const b = a + k;
          const dst = k === 1 ? tri : shoulderTri;
          dst.push(b, b + 4, b + 1, b + 1, b + 4, b + 5);
        }
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
    g.setIndex([...tri, ...shoulderTri]);
    g.addGroup(0, tri.length, 0);
    g.addGroup(tri.length, shoulderTri.length, 1);
    g.computeVertexNormals();
    const approach = new T.Mesh(g, [
      new T.MeshStandardNodeMaterial({ color: '#494741', roughness: 0.95, side: T.DoubleSide }),
      new T.MeshStandardMaterial({ color: '#927a63', roughness: 0.96, side: T.DoubleSide }),
    ]);
    approach.receiveShadow = true;
    root.add(approach);
  }
  const post = new T.Mesh(
    new T.BoxGeometry(0.13, 1.48, 0.12),
    new T.MeshStandardMaterial({ color: '#d6c3a1', roughness: 0.8 }),
  );
  post.position.set(x + 2.2, floor(x + 2.2, z + 2.4) + 0.74, z + 2.4);
  post.castShadow = true;
  root.add(post);
  for (const [height, color] of [
    [0.27, '#744738'],
    [0.48, '#413e39'],
  ] as const) {
    const band = new T.Mesh(
      new T.BoxGeometry(0.136, 0.09, 0.126),
      new T.MeshStandardMaterial({ color, roughness: 0.85 }),
    );
    band.position.copy(post.position);
    band.position.y += height;
    root.add(band);
  }
  return { x, z, root, floor, runoff, depth: () => runoff.depthAt(x + 0.94, z) };
}
