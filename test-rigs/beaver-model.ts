// @ts-nocheck
/**
 * DHC-2 Beaver floatplane test rig.
 *
 * Procedural fuselage, cambered wings, radial engine, cockpit and stepped floats.
 * Physical glazing works on WebGPU and WebGL 2.
 *
 * Model space: metres, nose along -X, starboard +Z, floats' keels near y ≈ 0.
 * Use `createBeaverRig()` (below) for a +Z-forward, origin-at-waterline wrapper.
 */
import * as THREE from 'three/webgpu';
import { TSL } from '../engine/tsl';
import { auxPassthrough } from '../engine/frame';

const {
  Fn, float, vec2, vec3, vec4, uniform, uv, positionLocal, normalView, positionViewDirection,
  abs: tAbs, dot, normalize, mix: tMix, smoothstep, pow, sin: tSin, cos: tCos, fract, floor, length, atan, mod,
} = TSL;

export interface BeaverModel {
  /** Root group in original model space (nose -X). */
  air: THREE.Group;
  /** Propeller group: spin with `prop.rotation.x`. */
  prop: THREE.Group;
  /** Static blade materials + motion-blur disc for the spinning/idle swap. */
  movingBlades: THREE.Material[];
  blur: THREE.Mesh;
  /** Optional RPM uniform (0..1) driving the sunlit prop-sweep highlight disc. */
  blurRpm?: { value: number };
}

export function buildBeaverModel(): BeaverModel {
  // Scene coordinates use metres. The nose points along local -X and starboard is +Z.
  const T = THREE,
    PI = Math.PI,
    TAU = PI * 2,
    sin = Math.sin,
    cos = Math.cos,
    abs = Math.abs;
  const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n)),
    mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  const C = (h) => new T.Color(h);
  let seed = 874123;
  function random() {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  const between = (a, b) => mix(a, b, random());
  const air = new T.Group(),
    fixed = new T.Group(),
    prop = new T.Group();
  air.rotation.order = 'YXZ';
  air.add(fixed, prop);

  const geoms = {
    sphere: new T.SphereGeometry(1, 20, 12),
    cube: new T.BoxGeometry(1, 1, 1),
    cyl: new T.CylinderGeometry(1, 1, 1, 14),
  };
  const std = (color, roughness = 0.47, metalness = 0.1, extra = {}) =>
    new T.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  // Aviation polyurethane clearcoat enamel over aluminum skin: subtle local-space panel sheen
  // variation breaks up flat uniform faces without adding extra textures or draw calls.
  const enamel = (color, roughness = 0.34, metalness = 0.28, clearcoat = 0.65, ccRough = 0.13, extra = {}) => {
    const m = new T.MeshPhysicalNodeMaterial({
      color,
      roughness,
      metalness,
      clearcoat,
      clearcoatRoughness: ccRough,
      ior: 1.5,
      envMapIntensity: 1.45,
      ...extra,
    });
    const p = positionLocal;
    const wave = TSL.sin(p.x.mul(1.8)).mul(TSL.cos(p.z.mul(2.1))).mul(0.032)
      .add(TSL.sin(p.y.mul(3.4).add(p.x.mul(1.2))).mul(0.018));
    const micro = TSL.sin(p.x.mul(14)).mul(TSL.cos(p.z.mul(16))).mul(0.014);
    m.roughnessNode = float(roughness).add(wave).add(micro).clamp(0.14, 0.72);
    return m;
  };
  // Marine brushed aluminum for floats, struts and hardware (longitudinal brushed grain + waterline wet sheen).
  const marineAlloy = (color, roughness = 0.30, metalness = 0.78, extra = {}) => {
    const m = new T.MeshPhysicalNodeMaterial({
      color,
      roughness,
      metalness,
      clearcoat: 0.28,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1.65,
      ...extra,
    });
    const p = positionLocal;
    const brush = fract(TSL.sin(dot(floor(vec2(p.x.mul(6), p.y.mul(55).add(p.z.mul(55)))), vec2(41.3, 289.1))).mul(19341.7));
    const wetLine = float(1).sub(smoothstep(0.05, 0.48, p.y));
    m.roughnessNode = TSL.mix(float(roughness).add(brush.sub(0.5).mul(0.09)), float(0.10), wetLine.mul(0.7)).clamp(0.08, 0.65);
    return m;
  };
  const paint = enamel(0xeee8d3, 0.32, 0.26, 0.68, 0.13),
    ivory = enamel(0xf1ecdb, 0.34, 0.24, 0.65, 0.14),
    orange = enamel(0xe95720, 0.26, 0.28, 0.82, 0.10),
    blue = enamel(0x16313d, 0.30, 0.38, 0.75, 0.12),
    rubber = std(0x182124, 0.80, 0.03),
    steel = marineAlloy(0xb0b8b5, 0.22, 0.86),
    darkmetal = marineAlloy(0x3a4649, 0.34, 0.76),
    black = std(0x182022, 0.46, 0.44);
  function mesh(g, m, group = fixed) {
    const o = new T.Mesh(g, m);
    o.castShadow = true;
    o.receiveShadow = true;
    group.add(o);
    return o;
  }
  function oval(x, y, z, sx, sy, sz, m, group = fixed) {
    const o = mesh(geoms.sphere, m, group);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    return o;
  }
  function box(x, y, z, sx, sy, sz, m, group = fixed) {
    const o = mesh(geoms.cube, m, group);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    return o;
  }
  const yaxis = V(0, 1, 0);
  function rod(a, b, r, m, group = fixed, r2 = r) {
    const v = V().subVectors(b, a),
      o = mesh(r2 === r ? geoms.cyl : new T.CylinderGeometry(r2, r, 1, 12), m, group);
    o.position.copy(a).lerp(b, 0.5);
    o.quaternion.setFromUnitVectors(yaxis, v.clone().normalize());
    o.scale.set(r === r2 ? r : 1, v.length(), r === r2 ? r : 1);
    return o;
  }
  function wire(points, r, m, group = fixed) {
    const curve = new T.CatmullRomCurve3(points);
    return mesh(new T.TubeGeometry(curve, Math.max(6, points.length * 3), r, 6, false), m, group);
  }
  function foilStrut(a, b, width, thick, m = paint, group = fixed) {
    const ax = b.clone().sub(a).normalize(),
      u = abs(ax.x) > 0.996 ? V(0, 0, 1) : V(1, 0, 0),
      v = V().crossVectors(ax, u).normalize(),
      P = [],
      I = [],
      uv = [];
    u.crossVectors(v, ax).normalize();
    for (let j = 0; j < 2; j++) {
      const c = j ? b : a;
      for (let i = 0; i <= 16; i++) {
        const k = (i * TAU) / 16,
          co = cos(k);
        const pt = c
          .clone()
          .addScaledVector(u, width * 0.5 * co)
          .addScaledVector(v, thick * 0.5 * sin(k) * (1 - 0.24 * co));
        P.push(...pt.toArray());
        uv.push(i / 16, j);
        if (j && i) {
          const n = 17 + i;
          I.push(n - 18, n - 17, n - 1, n - 17, n, n - 1);
        }
      }
    }
    for (let i = 1; i < 15; i++) {
      I.push(0, i + 1, i, 17, 17 + i, 18 + i);
    }
    return mesh(geometry(P, I, uv), m, group);
  }
  function geometry(P, I, uv, colors) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    if (I) g.setIndex(I);
    if (uv) g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    if (colors) g.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }
  function canvasMap(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }
  function poly(ctx, pts, fill, stroke, lw = 1) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }
  function line(ctx, pts, style, w = 1) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.stroke();
  }
  function emblem(ctx, x, y, w, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(w / 70, w / 70);
    poly(
      ctx,
      [
        [0, 0],
        [22, 0],
        [33, 13],
        [44, 0],
        [66, 0],
        [52, 9],
        [42, 9],
        [33, 20],
        [23, 9],
        [14, 9],
      ],
      color,
    );
    poly(
      ctx,
      [
        [11, 13],
        [24, 13],
        [33, 23],
        [42, 13],
        [55, 13],
        [45, 20],
        [41, 20],
        [33, 29],
        [25, 20],
        [21, 20],
      ],
      color,
    );
    poly(
      ctx,
      [
        [22, 25],
        [33, 34],
        [44, 25],
        [33, 39],
      ],
      color,
    );
    ctx.restore();
  }
  function batch(group) {
    group.updateWorldMatrix(true, true);
    const inv = group.matrixWorld.clone().invert(),
      packs = new Map(),
      rm = [];
    group.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      const id = o.material.uuid + '|' + o.castShadow + '|' + o.receiveShadow;
      let p = packs.get(id);
      if (!p) {
        p = {
          P: [],
          N: [],
          U: [],
          K: [],
          I: [],
          m: o.material,
          cast: o.castShadow,
          receive: o.receiveShadow,
        };
        packs.set(id, p);
      }
      const g = o.geometry,
        mat = new T.Matrix4().multiplyMatrices(inv, o.matrixWorld),
        nm = new T.Matrix3().getNormalMatrix(mat),
        a = g.attributes,
        n = a.position.count,
        offset = p.P.length / 3,
        vec = V();
      for (let i = 0; i < n; i++) {
        vec.fromBufferAttribute(a.position, i).applyMatrix4(mat);
        p.P.push(vec.x, vec.y, vec.z);
        if (a.normal) {
          vec.fromBufferAttribute(a.normal, i).applyNormalMatrix(nm);
          p.N.push(vec.x, vec.y, vec.z);
        }
        p.U.push(a.uv ? a.uv.getX(i) : 0, a.uv ? a.uv.getY(i) : 0);
        if (a.color) p.K.push(a.color.getX(i), a.color.getY(i), a.color.getZ(i));
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) p.I.push(offset + g.index.getX(i));
      } else for (let i = 0; i < n; i++) p.I.push(offset + i);
      rm.push(o);
    });
    for (const o of rm) o.removeFromParent();
    for (const p of packs.values()) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(p.P, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(p.N, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(p.U, 2));
      if (p.K.length) g.setAttribute('color', new T.Float32BufferAttribute(p.K, 3));
      g.setIndex(p.I);
      g.computeBoundingSphere();
      const o = mesh(g, p.m, group);
      o.castShadow = p.cast;
      o.receiveShadow = p.receive;
    }
  }
  // Monotone station interpolation keeps the fuselage continuous through the cabin and tail cone.
  function station(table, x, col) {
    let i = 0;
    while (i < table.length - 2 && x > table[i + 1][0]) i++;
    const a = table[i],
      b = table[i + 1],
      dx = b[0] - a[0],
      t = clamp((x - a[0]) / dx),
      d = (b[col] - a[col]) / dx;
    const slope = (l, r) => (l * r <= 0 ? 0 : (2 * l * r) / (l + r));
    const lo = i ? slope((a[col] - table[i - 1][col]) / (a[0] - table[i - 1][0]), d) : d;
    const hi =
      i + 2 < table.length ? slope(d, (table[i + 2][col] - b[col]) / (table[i + 2][0] - b[0])) : d;
    return mix(a[col], b[col], t * t * (3 - 2 * t)) + dx * t * (1 - t) * ((1 - t) * lo - t * hi);
  }
  const bodyStations = [
    [-3.12, 0.53, 2.02, 3.09],
    [-2.74, 0.65, 1.87, 3.19],
    [-2.35, 0.713, 1.75, 3.115],
    [-2.18, 0.748, 1.71, 3.115],
    [-1.47, 0.825, 1.596, 3.636],
    [-0.81, 0.854, 1.56, 3.706],
    [0.48, 0.833, 1.57, 3.685],
    [1.02, 0.768, 1.63, 3.57],
    [1.55, 0.669, 1.714, 3.37],
    [2.25, 0.51, 1.87, 3.106],
    [3.12, 0.36, 2.03, 2.87],
    [4.12, 0.217, 2.15, 2.685],
    [4.83, 0.12, 2.23, 2.56],
    [5.19, 0.018, 2.36, 2.43],
  ];
  const sideR = [
    [0, 0],
    [0.018, 0.39],
    [0.051, 0.61],
    [0.11, 0.79],
    [0.2, 0.922],
    [0.31, 0.987],
    [0.44, 1],
    [0.59, 0.997],
    [0.78, 0.975],
    [0.882, 0.94],
    [0.925, 0.896],
    [0.957, 0.811],
    [0.98, 0.674],
    [0.994, 0.427],
    [1, 0],
  ];
  function sidePoint(x, h, side) {
    const low = station(bodyStations, x, 2),
      top = station(bodyStations, x, 3);
    return V(x, mix(low, top, h), side * station(bodyStations, x, 1) * station(sideR, h, 1));
  }
  function gridSurface(n, m, point, reverse = false) {
    const P = [],
      U = [],
      I = [];
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i <= n; i++) {
        const p = point(i / n, j / m);
        P.push(p.x, p.y, p.z);
        U.push(i / n, j / m);
        if (j && i) {
          const k = j * (n + 1) + i,
            a = k - n - 2,
            b = k - n - 1,
            c = k - 1;
          reverse ? I.push(a, c, b, b, c, k) : I.push(a, b, c, b, k, c);
        }
      }
    }
    return geometry(P, I, U);
  }
  function fuselagePaint(side) {
    return canvasMap(3072, 640, (c, w, h) => {
      const xmin = -3.12,
        xmax = 5.19,
        X = (x) => ((x - xmin) / (xmax - xmin)) * w,
        Y = (y) => (1 - y) * h,
        P = (pts) => pts.map(([x, y]) => [X(x), Y(y)]);
      c.fillStyle = '#eee9d7';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const a = between(0.012, 0.07);
        c.fillStyle = 'rgba(80,69,45,' + a + ')';
        c.fillRect(random() * w, random() * h, between(0.3, 1.7), 1);
      }
      const curve = (x) => 0.255 + 0.2 * smooth(-2.5, 5, x) + 0.065 * smooth(2.15, 4.8, x);
      function stripe(d1, d2, color) {
        const pts = [];
        for (let i = 0; i <= 100; i++) {
          let x = mix(xmin, xmax, i / 100);
          pts.push([x, curve(x) + d1]);
        }
        for (let i = 100; i >= 0; i--) {
          let x = mix(xmin, xmax, i / 100);
          pts.push([x, curve(x) + d2]);
        }
        poly(c, P(pts), color);
      }
      stripe(-0.85, 0, '#1a3542');
      stripe(0.006, 0.016, '#9ba6a4');
      stripe(0.04, 0.087, '#eb612b');
      stripe(0.097, 0.111, '#b98759');
      for (const x of [-2.72, -2.27, -1.56, -0.39, 0.68, 1.57, 2.27, 3.08, 3.81, 4.42, 4.9]) {
        line(
          c,
          P([
            [x, 0],
            [x + 0.012, 0.28],
            [x, 0.6],
            [x - 0.008, 1],
          ]),
          'rgba(52,58,55,.28)',
          1.35,
        );
        for (let v = 0.027; v < 1; v += 0.031) {
          c.beginPath();
          c.arc(X(x) + 3.3, Y(v), 1.24, 0, TAU);
          c.fillStyle = 'rgba(51,58,56,.38)';
          c.fill();
          c.fillStyle = 'rgba(255,255,237,.6)';
          c.fillRect(X(x) + 3, Y(v) - 1.4, 1.3, 0.8);
        }
      }
      for (const v of [0.16, 0.455, 0.962]) {
        line(
          c,
          P([
            [xmin, v],
            [xmax, v],
          ]),
          'rgba(65,70,61,.17)',
          1,
        );
        for (let x = xmin; x < xmax; x += 0.068) {
          c.fillStyle = 'rgba(62,64,59,.32)';
          c.fillRect(X(x), Y(v) - 2, 1.85, 1.3);
        }
      }
      const doors = [
        [
          [-1.5, 0.87],
          [-1.56, 0.54],
          [-1.51, 0.23],
          [-1.42, 0.175],
          [-0.52, 0.175],
          [-0.398, 0.224],
          [-0.398, 0.87],
        ],
        [
          [-0.32, 0.898],
          [-0.32, 0.205],
          [-0.25, 0.173],
          [0.56, 0.18],
          [0.645, 0.225],
          [0.645, 0.89],
        ],
      ];
      for (const door of doors) {
        const a = P(door);
        poly(c, a, null, 'rgba(55,59,52,.69)', 3.6);
        line(
          c,
          a.map(([x, y]) => [x + 2, y + 2]),
          'rgba(255,255,243,.55)',
          1.3,
        );
      }
      const sideWindow = (x1, x2, lower, upper, lean = 0) => {
        const b = 0.042;
        return [
          [x1 + b, lower],
          [x2 - b, lower],
          [x2, lower + 0.025],
          [x2, upper - 0.024],
          [x2 - b, upper],
          [x1 + b + lean, upper],
          [x1 + lean, upper - 0.035],
          [x1, lower + 0.03],
        ];
      };
      const windows = [
        sideWindow(-1.465, -0.455, 0.536, 0.91, 0.045),
        sideWindow(-0.265, 0.564, 0.54, 0.909, 0.012),
        sideWindow(0.708, 1.402, 0.553, 0.881, 0.012),
        [
          [-2.181, 0.78],
          [-2.14, 0.725],
          [-1.591, 0.547],
          [-1.55, 0.563],
          [-1.511, 1.022],
          [-2.156, 1.022],
        ],
      ];
      for (const pts of windows) {
        const a = P(pts);
        c.lineJoin = 'round';
        poly(c, a, '#21383c', '#b4bbb3', 10);
        poly(c, a, null, '#263435', 5.5);
        c.save();
        c.globalCompositeOperation = 'destination-out';
        poly(c, a, '#000');
        c.restore();
        poly(c, a, null, '#31434a', 4);
      }
      // Lettering is painted directly on each side so the far side reads correctly.
      function label(s, x, y, px, col, weight = '700', font = 'Arial') {
        c.save();
        c.translate(X(x), Y(y));
        c.scale(side, 1);
        c.font = weight + ' ' + px + 'px ' + font;
        c.fillStyle = col;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(s, 0, 0);
        c.restore();
      }
      label('F-OPLG', 2.62, 0.733, 113, '#203a44', '700');
      label('P E L A G I C', -0.735, 0.435, 22, '#243e46');
      label('AIR   SERVICE', -0.735, 0.404, 10, '#344b51');
      label('DHC - 2', -2.17, 0.486, 14, '#334a4e');
      label('LIFT  HERE', 3.62, 0.545, 8, '#414c4a');
      for (const x of [-0.52, 0.525]) {
        line(
          c,
          P([
            [x - 0.08, 0.5],
            [x + 0.03, 0.5],
          ]),
          '#63716d',
          4,
        );
        line(
          c,
          P([
            [x - 0.08, 0.504],
            [x + 0.03, 0.504],
          ]),
          '#f6f2db',
          1.3,
        );
      }
      for (const x of [-1.29, -0.05]) {
        c.fillStyle = '#c7b885';
        c.fillRect(X(x), Y(0.19), 24, 6);
        c.fillStyle = '#323b3b';
        c.fillRect(X(x) + 3, Y(0.19) + 2, 18, 1);
      }
    });
  }
  // View-dependent Fresnel aviation plexiglass: clear enough straight-on to read the cockpit
  // interior, ramping smoothly to crisp sky-reflecting tinted glass at grazing angles.
  const glazing = new T.MeshPhysicalNodeMaterial({
    color: 0x0c2832,
    roughness: 0.028,
    metalness: 0.06,
    transparent: true,
    opacity: 0.55,
    clearcoat: 1.0,
    clearcoatRoughness: 0.018,
    ior: 1.52,
    envMapIntensity: 2.3,
    depthWrite: false,
  });
  {
    const NdotV = tAbs(dot(normalize(normalView), normalize(positionViewDirection))).clamp(0, 1);
    const fres = pow(float(1).sub(NdotV), 2.8);
    glazing.colorNode = tMix(vec3(0.05, 0.14, 0.18), vec3(0.26, 0.42, 0.48), fres);
    glazing.opacityNode = tMix(float(0.28), float(0.88), fres);
  }
  for (const s of [1, -1]) {
    const tx = fuselagePaint(s),
      m = enamel(0xffffff, 0.34, 0.26, 0.68, 0.14, { map: tx, alphaTest: 0.41, side: T.DoubleSide });
    const g = gridSurface(119, 67, (u, v) => sidePoint(mix(-3.12, 5.19, u), v, s), s < 0);
    mesh(g, m);
    const innerG = gridSurface(
      57,
      37,
      (u, v) => {
        const p = sidePoint(mix(-2.2, 1.44, u), mix(0.5, 1, v), s);
        p.z *= 0.989;
        p.y -= 0.012;
        return p;
      },
      s < 0,
    );
    const glass = mesh(innerG, glazing);
    glass.castShadow = false;
    glass.renderOrder = 2;
    for (const x of [-1.487, -0.301])
      for (const h of [0.355, 0.484]) {
        const p = sidePoint(x, h, s);
        box(x, p.y, p.z + s * 0.014, 0.085, 0.036, 0.042, steel);
      }
    for (const x of [-0.54, 0.51]) {
      const p = sidePoint(x, 0.507, s);
      oval(x, p.y, p.z + s * 0.019, 0.086, 0.019, 0.022, steel);
    }
    // Windscreen center post and exterior wiper arm.

    const wa = sidePoint(-2.13, 0.92, s),
      wb = sidePoint(-1.83, 0.976, s);
    wire(
      [
        wa,
        wa
          .clone()
          .lerp(wb, 0.57)
          .add(V(-0.012, 0.015, 0)),
        wb,
      ],
      0.009,
      black,
    );
    const c = sidePoint(-1.941, 0.955, s),
      d = sidePoint(-1.76, 0.987, s);
    rod(c, d, 0.012, black);
  }
  const centrePost = [];
  for (let i = 0; i <= 10; i++)
    centrePost.push(sidePoint(mix(-2.184, -1.508, i / 10), 1, 1).add(V(0, 0.009, 0)));
  wire(centrePost, 0.022, ivory);
  // Cockpit furnishings are visible through the cut-out glazing.
  const leather = std(0x765a3d, 0.81, 0.02),
    cloth = std(0x394a46, 0.92, 0.01),
    seatDark = std(0x29383a, 0.8, 0.02);
  box(-0.62, 1.98, 0, 2.76, 0.09, 1.33, seatDark);
  const lining = std(0x4c5854, 0.87, 0.06);
  const partition = oval(1.36, 2.55, 0, 0.058, 0.731, 0.637, lining);
  for (const s of [-1, 1]) {
    const liner = mesh(
      gridSurface(
        45,
        14,
        (u, v) => {
          const p = sidePoint(mix(-1.51, 1.43, u), mix(0.18, 0.52, v), s);
          p.z *= 0.973;
          return p;
        },
        s > 0,
      ),
      lining,
    );
    liner.castShadow = false;
    const ceiling = mesh(
      gridSurface(
        32,
        12,
        (u, v) => {
          const p = sidePoint(mix(-1.485, 1.43, u), mix(0.922, 1, v), s);
          p.y -= 0.026;
          p.z *= 0.974;
          return p;
        },
        s > 0,
      ),
      lining,
    );
    ceiling.castShadow = false;
  }
  for (const x of [-0.9, 0.42])
    for (const s of [-1, 1]) {
      const z = s * 0.395;
      oval(x, 2.15, z, 0.33, 0.105, 0.278, leather);
      const back = oval(x + 0.234, 2.425, z, 0.093, 0.327, 0.285, leather);
      back.rotation.z = -0.09;
      oval(x + 0.24, 2.71, z, 0.081, 0.117, 0.167, leather);
      for (let j = -2; j <= 2; j++) {
        rod(V(x + 0.14, 2.28, z + j * 0.09), V(x + 0.16, 2.54, z + j * 0.09), 0.006, seatDark);
      }
    }
  const panelmap = canvasMap(640, 224, (c, w, h) => {
    c.fillStyle = '#292e2c';
    c.fillRect(0, 0, w, h);
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 7; i++) {
        const x = 41 + i * 86,
          y = 55 + j * 91,
          r = i > 4 ? 25 : 34;
        c.fillStyle = '#89918a';
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();
        c.fillStyle = '#14252a';
        c.beginPath();
        c.arc(x, y, r - 3, 0, TAU);
        c.fill();
        for (let k = 0; k < 11; k++) {
          const a = k * 0.48 + 2.1;
          line(
            c,
            [
              [x + cos(a) * (r - 6), y + sin(a) * (r - 6)],
              [x + cos(a) * (r - 10), y + sin(a) * (r - 10)],
            ],
            '#f5eac5',
            2,
          );
        }
        line(
          c,
          [
            [x, y],
            [x + cos(i * 1.7 + j) * (r - 10), y + sin(i * 1.7 + j) * (r - 10)],
          ],
          '#efcf99',
          2.6,
        );
      }
  });
  const ip = box(-1.732, 2.73, 0, 0.28, 0.41, 1.27, black);
  ip.rotation.z = -0.1;
  const ipFace = mesh(new T.PlaneGeometry(1.21, 0.37), std(0xffffff, 0.5, 0.15, { map: panelmap }));
  ipFace.rotation.y = PI / 2;
  ipFace.position.set(-1.57, 2.731, 0);
  for (const s of [-1, 1]) {
    const z = 0.39 * s;
    rod(V(-1.62, 2.65, z), V(-1.31, 2.51, z), 0.027, darkmetal);
    wire(
      [
        V(-1.3, 2.6, z - 0.12),
        V(-1.29, 2.48, z - 0.1),
        V(-1.3, 2.51, z),
        V(-1.29, 2.48, z + 0.1),
        V(-1.3, 2.6, z + 0.12),
      ],
      0.022,
      black,
    );
  }
  const skin = std(0xba8d6b, 0.78, 0),
    shirt = std(0xc6be9d, 0.86, 0);
  oval(-0.98, 2.47, -0.39, 0.167, 0.29, 0.218, shirt);
  oval(-1.035, 2.9, -0.396, 0.127, 0.176, 0.12, skin);
  oval(-1.152, 2.9, -0.396, 0.055, 0.047, 0.044, skin);
  oval(-1.021, 3.014, -0.398, 0.139, 0.081, 0.132, blue);
  oval(-1.15, 2.99, -0.399, 0.102, 0.014, 0.114, blue);
  for (const s of [-1, 1]) {
    oval(-1.017, 2.905, -0.396 + 0.121 * s, 0.058, 0.074, 0.025, black);
    rod(V(-1.0, 2.57, -0.396 + 0.185 * s), V(-1.14, 2.39, -0.396 + 0.218 * s), 0.068, shirt);
    rod(V(-1.14, 2.39, -0.396 + 0.218 * s), V(-1.29, 2.55, -0.396 + 0.121 * s), 0.046, skin);
  }
  // Wing skin uses a continuous cambered airfoil and a rounded, tapering tip.
  function wingPaint(tail = false, under = false) {
    return canvasMap(tail ? 1536 : 4096, tail ? 384 : 640, (c, w, h) => {
      c.fillStyle = under ? '#dfdfd0' : '#f1edda';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 3100; i++) {
        c.fillStyle = 'rgba(110,96,67,.035)';
        c.fillRect(random() * w, random() * h, between(1, 3), 1);
      }
      for (const sign of [-1, 1]) {
        const outer = sign === -1 ? 0 : w;
        function mark(f, g, col) {
          const a = outer - sign * w * f,
            b = outer - sign * w * g;
          c.fillStyle = col;
          c.fillRect(Math.min(a, b), 0, Math.abs(a - b), h);
        }
        mark(0, tail ? 0.083 : 0.066, '#e96229');
        mark(tail ? 0.091 : 0.074, tail ? 0.101 : 0.083, '#233f48');
        mark(tail ? 0.106 : 0.089, tail ? 0.112 : 0.095, '#df692f');
      }
      const spans = tail ? 16 : 42;
      for (let i = 1; i < spans; i++) {
        const x = (i * w) / spans,
          heavy = i % 3 === 1;
        line(
          c,
          [
            [x, h * 0.025],
            [x, h * 0.99],
          ],
          'rgba(69,75,69,' + (heavy ? 0.29 : 0.14) + ')',
          heavy ? 1.55 : 0.9,
        );
        line(
          c,
          [
            [x + 2, h * 0.035],
            [x + 2, h * 0.985],
          ],
          'rgba(255,255,246,.57)',
          1.2,
        );
        for (let y = 9; y < h; y += 13) {
          c.fillStyle = 'rgba(75,79,66,.36)';
          c.fillRect(x + 3.4, y, 1.6, 1.4);
        }
      }
      for (const v of [0.06, 0.22, 0.47, 0.692, 0.754, 0.951]) {
        line(
          c,
          [
            [0, v * h],
            [w, v * h],
          ],
          'rgba(50,65,66,' + (v === 0.754 ? 0.47 : 0.14) + ')',
          v === 0.754 ? 3.4 : 1.0,
        );
        for (let x = 2; x < w; x += 19) {
          c.fillStyle = 'rgba(65,66,57,.30)';
          c.fillRect(x, v * h - 2.6, 1.5, 1.5);
        }
      }
      for (const s of [-1, 1]) {
        const a = w * (s < 0 ? 0.034 : 0.54),
          b = w * (s < 0 ? 0.46 : 0.966);
        line(
          c,
          [
            [a, h * 0.987],
            [a, h * 0.734],
            [b, h * 0.734],
            [b, h * 0.986],
          ],
          'rgba(45,56,52,.45)',
          2,
        );
        const gap = w * (s < 0 ? 0.232 : 0.768);
        line(
          c,
          [
            [gap, h * 0.735],
            [gap, h],
          ],
          '#66726d',
          2.6,
        );
        for (let x = a + 8; x < b; x += w / (tail ? 62 : 125)) {
          line(
            c,
            [
              [x, h * 0.783],
              [x + 1, h * 0.967],
            ],
            'rgba(138,134,110,.31)',
            2.2,
          );
          line(
            c,
            [
              [x + 2, h * 0.78],
              [x + 3, h * 0.966],
            ],
            'rgba(255,255,248,.72)',
            2,
          );
        }
      }
      if (!tail) {
        c.save();
        c.translate(w * (under ? 0.272 : 0.745), h * 0.49);
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = '#263d45';
        c.font = '600 130px Arial';
        c.scale(1.2, 1);
        c.fillText('F-OPLG', 0, 0);
        c.restore();
        if (!under) {
          emblem(c, w * 0.255, h * 0.28, w * 0.052, '#28444b');
          for (const s of [-1, 1]) {
            const x = w * (0.5 + s * 0.124),
              y = h * 0.39;
            c.fillStyle = '#89928a';
            c.beginPath();
            c.arc(x, y, 12, 0, TAU);
            c.fill();
            c.strokeStyle = '#555e58';
            c.lineWidth = 2;
            c.stroke();
            line(
              c,
              [
                [x - 6, y],
                [x + 6, y],
              ],
              '#e6e7d8',
              2,
            );
            c.fillStyle = '#485653';
            c.font = '10px Arial';
            c.fillText('FUEL', x + 16, y + 3);
            c.font = '12px Arial';
            c.fillText('NO STEP', x - 22, h * 0.71);
          }
        }
      }
    });
  }
  function foilShape(u, tail = false) {
    const k = clamp(u, 0.00001, 1);
    return (
      (tail ? 0.105 : 0.142) *
      5 *
      (0.2969 * Math.sqrt(k) - 0.126 * k - 0.3516 * k * k + 0.2843 * k ** 3 - 0.1036 * k ** 4)
    );
  }
  function wingPosition(t, u, upper, tail = false) {
    const span = tail ? 2.255 : 7.315,
      z = (2 * t - 1) * span,
      b = abs(z) / span,
      tip = smooth(0.922, 1, b);
    let chord = tail ? mix(1.46, 0.82, b) : mix(2.08, 1.64, smooth(0.33, 0.99, b)),
      lead = tail ? 3.08 + 0.68 * b * b : -1.653 + 0.19 * b + 0.105 * b * b;
    const rounding = Math.sqrt(Math.max(0.001, 1 - Math.pow(clamp((b - 0.936) / 0.064), 2)));
    lead += chord * (1 - rounding) * 0.49;
    chord *= rounding;
    const base = tail ? 2.515 + 0.046 * b : 3.615 + 0.176 * b * b;
    return V(
      lead + u * chord,
      base + chord * ((tail ? 0.007 : 0.019) * sin(PI * u) + (upper ? 1 : -1) * foilShape(u, tail)),
      z,
    );
  }
  for (const tail of [false, true]) {
    for (const up of [true, false]) {
      const wing = gridSurface(
        140,
        34,
        (t, v) => wingPosition(t, (1 - cos(v * PI)) * 0.5, up, tail),
        !up,
      );
      const uv = wing.attributes.uv;
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, up ? 1 - uv.getX(i) : uv.getX(i), 1 - (1 - cos(uv.getY(i) * PI)) * 0.5);
      mesh(wing, enamel(0xffffff, 0.34, 0.25, 0.62, 0.15, { map: wingPaint(tail, !up), side: T.DoubleSide }));
    }
  }
  for (const s of [-1, 1]) {
    for (const z of [2.02, 3.41, 4.87, 6.26]) {
      const q = wingPosition(((z * s) / 7.315 + 1) * 0.5, 0.765, false);
      oval(q.x, q.y - 0.043, q.z, 0.128, 0.063, 0.04, darkmetal);
      rod(V(q.x - 0.14, q.y - 0.016, q.z), V(q.x + 0.137, q.y - 0.077, q.z), 0.017, steel);
    }
    const t = s < 0 ? 0.003 : 0.997,
      pt = wingPosition(t, 0.32, true);
    oval(pt.x, pt.y, pt.z, 0.12, 0.052, 0.054, steel);
    const nav = std(s > 0 ? 0x64bfa4 : 0xdd4f37, 0.18, 0.22, {
      emissive: s > 0 ? 0x26876b : 0x943320,
      emissiveIntensity: 0.47,
    });
    oval(pt.x - 0.017, pt.y + 0.014, pt.z + 0.026 * s, 0.086, 0.043, 0.051, nav);
  }
  const landingLight = std(0xf3ebc6, 0.13, 0.49, { emissive: 0x938e63, emissiveIntensity: 0.24 });
  for (const s of [-1, 1]) {
    const p = wingPosition(((s * 5.12) / 7.315 + 1) * 0.5, 0.007, true);
    oval(p.x + 0.028, p.y - 0.016, p.z, 0.051, 0.086, 0.189, steel);
    oval(p.x - 0.013, p.y - 0.017, p.z, 0.037, 0.062, 0.146, landingLight);
  }
  // Fin and rudder share an airfoil section but have a separate painted hinge line.
  const finTable = [
    [2.386, 2.7, 5.16, 0.131],
    [2.55, 2.85, 5.18, 0.138],
    [2.83, 3.35, 5.19, 0.123],
    [3.19, 3.725, 5.177, 0.113],
    [3.61, 3.947, 5.129, 0.097],
    [4.02, 4.137, 5.094, 0.079],
    [4.32, 4.266, 5.031, 0.06],
    [4.427, 4.38, 4.949, 0.047],
    [4.489, 4.607, 4.795, 0.019],
    [4.497, 4.69, 4.711, 0.003],
  ];
  function tailPaint(sign) {
    return canvasMap(1024, 896, (c, w, h) => {
      const X = (x) => ((x - 2.68) / 2.55) * w,
        Y = (y) => ((4.505 - y) / 2.13) * h;
      c.fillStyle = '#eee9d6';
      c.fillRect(0, 0, w, h);
      poly(
        c,
        [
          [0, 0],
          [w, 0],
          [w, Y(4.035)],
          [0, Y(3.777)],
        ],
        '#e95822',
      );
      poly(
        c,
        [
          [0, Y(3.729)],
          [w, Y(3.992)],
          [w, Y(3.944)],
          [0, Y(3.68)],
        ],
        '#223e48',
      );
      for (const y of [2.7, 2.99, 3.26, 3.57, 3.88, 4.17]) {
        line(
          c,
          [
            [0, Y(y)],
            [w, Y(y)],
          ],
          'rgba(70,73,63,.24)',
          1.35,
        );
        for (let x = 4; x < w; x += 13) {
          c.fillStyle = 'rgba(62,64,56,.33)';
          c.fillRect(x, Y(y) + 2, 1.7, 1.6);
        }
      }
      const hinge = [
        [4.718, 2.38],
        [4.77, 2.97],
        [4.791, 3.43],
        [4.81, 3.91],
        [4.825, 4.44],
      ].map(([x, y]) => [X(x), Y(y)]);
      line(c, hinge, '#66716b', 3.3);
      line(
        c,
        hinge.map(([x, y]) => [x + 2, y]),
        '#fffae9',
        1.4,
      );
      emblem(c, X(4.145), Y(3.796), X(4.718) - X(4.145), '#213c48');
      c.save();
      c.translate(X(4.44), Y(3.36));
      c.scale(sign, 1);
      c.font = '600 20px Arial';
      c.textAlign = 'center';
      c.fillStyle = '#27454c';
      c.fillText('COASTAL', 0, 0);
      c.font = '12px Arial';
      c.fillText('AIR SERVICE', 0, 19);
      c.restore();
    });
  }
  for (const s of [-1, 1]) {
    const g = gridSurface(
      38,
      57,
      (u, v) => {
        const y = mix(2.386, 4.497, v);
        return V(
          mix(station(finTable, y, 1), station(finTable, y, 2), u),
          y,
          s * station(finTable, y, 3) * Math.pow(Math.max(0, sin(PI * u)), 0.59),
        );
      },
      s < 0,
    );
    const uv = g.attributes.uv,
      pos = g.attributes.position;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, (pos.getX(i) - 2.68) / 2.55, (pos.getY(i) - 2.375) / 2.13);
    mesh(g, enamel(0xffffff, 0.35, 0.24, 0.65, 0.14, { map: tailPaint(s), side: T.DoubleSide }));
  }
  const tailLamp = std(0xc83e27, 0.15, 0.15, { emissive: 0x98180c, emissiveIntensity: 0.45 });
  oval(4.71, 4.494, 0, 0.076, 0.021, 0.033, steel);
  oval(4.709, 4.516, 0, 0.045, 0.026, 0.026, tailLamp);
  oval(5.164, 2.47, 0, 0.076, 0.054, 0.053, steel);
  oval(5.22, 2.47, 0, 0.031, 0.032, 0.033, landingLight);

  // The cowl has a rolled inlet lip, a recessed engine bay and a visible nine-cylinder radial.
  const engineY = 2.587;
  function axialRing(profile, m, cy = engineY, group = fixed) {
    const P = [],
      I = [],
      U = [];
    profile.forEach(([x, r], j) => {
      for (let i = 0; i <= 80; i++) {
        const a = (TAU * i) / 80;
        P.push(x, cy + r * cos(a), r * sin(a));
        U.push(i / 80, j / (profile.length - 1));
        if (i && j) {
          const b = j * 81 + i;
          I.push(b - 82, b - 81, b - 1, b - 81, b, b - 1);
        }
      }
    });
    return mesh(geometry(P, I, U), m, group);
  }
  const cowlPaint = enamel(0xf06226, 0.24, 0.30, 0.86, 0.09, { side: T.DoubleSide });
  axialRing(
    [
      [-3.628, 0.519],
      [-3.682, 0.531],
      [-3.713, 0.578],
      [-3.71, 0.634],
      [-3.674, 0.68],
      [-3.607, 0.71],
      [-3.46, 0.727],
      [-3.14, 0.736],
      [-2.89, 0.724],
      [-2.829, 0.703],
    ],
    cowlPaint,
  );
  axialRing(
    [
      [-3.622, 0.516],
      [-3.5, 0.506],
      [-3.33, 0.508],
    ],
    darkmetal,
  );
  axialRing(
    [
      [-2.834, 0.705],
      [-2.81, 0.716],
      [-2.766, 0.721],
      [-2.746, 0.709],
    ],
    steel,
  );
  axialRing(
    [
      [-2.745, 0.707],
      [-2.729, 0.72],
      [-2.631, 0.718],
      [-2.61, 0.701],
    ],
    blue,
  );
  axialRing(
    [
      [-2.61, 0.703],
      [-2.581, 0.708],
      [-2.49, 0.701],
      [-2.408, 0.688],
    ],
    ivory,
  );
  axialRing(
    [
      [-3.721, 0.585],
      [-3.721, 0.594],
    ],
    steel,
  );
  oval(-3.31, engineY, 0, 0.119, 0.531, 0.531, black);
  for (let i = 0; i < 9; i++) {
    const a = (TAU * i) / 9 + 0.055,
      dir = V(0, cos(a), sin(a)),
      off = V(0, -sin(a), cos(a));
    const ep = (x, r, t = 0) => V(x, engineY, 0).addScaledVector(dir, r).addScaledVector(off, t);
    rod(ep(-3.516, 0.173), ep(-3.509, 0.469), 0.072, black, fixed, 0.1);
    for (let j = 0; j < 9; j++) {
      const r = 0.27 + j * 0.022;
      rod(ep(-3.516, r), ep(-3.516, r + 0.009), 0.086 + j * 0.0028, darkmetal);
    }
    oval(...ep(-3.501, 0.48).toArray(), 0.096, 0.081, 0.089, steel);
    for (const s of [-1, 1]) rod(ep(-3.677, 0.201, s * 0.048), ep(-3.575, 0.44, s * 0.04), 0.011, steel);
  }
  oval(-3.63, engineY, 0, 0.169, 0.211, 0.211, darkmetal);
  oval(-3.738, engineY, 0, 0.104, 0.166, 0.166, steel);
  for (let i = 0; i < 12; i++) {
    const a = (TAU * i) / 12;
    oval(-3.697, engineY + 0.196 * cos(a), 0.196 * sin(a), 0.018, 0.018, 0.018, steel);
  }
  for (let i = 0; i < 36; i++) {
    const a = (i * TAU) / 36;
    for (const [x, r] of [
      [-3.552, 0.721],
      [-2.898, 0.726],
    ]) {
      oval(x, engineY + r * cos(a), r * sin(a), 0.01, 0.01, 0.01, steel);
    }
  }
  for (let i = 0; i < 6; i++) {
    let a = (i * TAU) / 6 + 0.19;
    wire(
      [
        V(-3.56, engineY + 0.722 * cos(a), 0.722 * sin(a)),
        V(-3.16, engineY + 0.739 * cos(a), 0.739 * sin(a)),
        V(-2.851, engineY + 0.714 * cos(a), 0.714 * sin(a)),
      ],
      0.005,
      darkmetal,
    );
    const p = V(-2.967, engineY + 0.735 * cos(a), 0.735 * sin(a));
    const l = box(p.x, p.y, p.z, 0.101, 0.016, 0.041, steel);
    l.rotation.x = a;
  }
  const exhaust = new T.MeshPhysicalMaterial({
    color: 0x6e5b4b, roughness: 0.46, metalness: 0.78, iridescence: 0.55, iridescenceIOR: 1.75, envMapIntensity: 1.4,
  });
  for (const s of [-1, 1]) {
    const end = V(-2.49, 2.042, s * 0.675);
    wire([V(-2.85, 2.28, s * 0.529), V(-2.71, 2.1, s * 0.62), end], 0.083, exhaust);
    const e = oval(end.x + 0.009, end.y - 0.008, end.z + s * 0.006, 0.021, 0.06, 0.066, black);
    e.rotation.z = -0.33;
  }
  const intake = oval(-2.94, 1.951, 0, 0.383, 0.135, 0.225, ivory);
  oval(-3.206, 1.941, 0, 0.072, 0.085, 0.176, darkmetal);
  for (let i = -3; i <= 3; i++)
    rod(V(-3.258, 1.896, i * 0.038), V(-3.277, 1.981, i * 0.038), 0.006, steel);
  // Propeller blades twist and widen from their bolt collars before tapering to painted tips.
  prop.position.set(-3.855, engineY, 0);
  const bladeTable = [
    [0.105, 0.052, 0.0, 0.051],
    [0.223, 0.071, 0.006, 0.06],
    [0.41, 0.12, 0.014, 0.05],
    [0.67, 0.139, 0.033, 0.033],
    [0.92, 0.115, 0.065, 0.023],
    [1.14, 0.079, 0.082, 0.014],
    [1.245, 0.056, 0.075, 0.01],
    [1.293, 0.006, 0.064, 0.004],
  ];
  const bladeMat = new T.MeshPhysicalMaterial({ color: 0x2a3335, roughness: 0.24, metalness: 0.72, clearcoat: 0.75, clearcoatRoughness: 0.12 }),
    propIvory = new T.MeshPhysicalMaterial({ color: 0xf4efde, roughness: 0.26, metalness: 0.22, clearcoat: 0.72, clearcoatRoughness: 0.12 }),
    propOrange = new T.MeshPhysicalMaterial({ color: 0xf45f1e, roughness: 0.22, metalness: 0.24, clearcoat: 0.80, clearcoatRoughness: 0.10 });
  const movingBlades = [bladeMat, propIvory, propOrange];
  for (const m of movingBlades) {
    m.transparent = true;
    m.opacity = 1.0;
    m.depthWrite = true;
  }
  for (const s of [-1, 1]) {
    for (const [a, b, m] of [
      [0.105, 0.257, steel],
      [0.257, 1.118, bladeMat],
      [1.118, 1.144, propIvory],
      [1.144, 1.293, propOrange],
    ]) {
      const g = gridSurface(22, 20, (i, j) => {
        const r = mix(a, b, i),
          ang = j * TAU,
          chord = station(bladeTable, r, 1),
          off = station(bladeTable, r, 2),
          twist = 0.63 * (1 - r / 1.4) + 0.1;
        const z = chord * cos(ang),
          x = station(bladeTable, r, 3) * sin(ang);
        return V(x * cos(twist) - z * sin(twist), s * r, s * (off + z * cos(twist) + x * sin(twist)));
      });
      m.side = T.DoubleSide;
      mesh(g, m, prop);
    }
    oval(0, s * 0.132, 0, 0.112, 0.108, 0.09, steel, prop);
  }
  oval(-0.04, 0, 0, 0.176, 0.151, 0.151, steel, prop);
  oval(-0.171, 0, 0, 0.063, 0.078, 0.078, darkmetal, prop);
  // Speed-driven sunlit metallic prop-sweep highlight & bright safety-tip ring (rotates with prop).
  const uBlurRpm = uniform(0);
  const blurMat = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: T.DoubleSide,
    fog: false,
  });
  blurMat.colorNode = Fn(() => {
    const c = uv().mul(2).sub(1);
    const r = length(c);
    const ang = atan(c.y, c.x);
    const sec = mod(ang.add(PI * 4), PI);
    // Swept pitch-glint streaks behind each blade + continuous vivid safety-tip ring at high RPM
    const streak = pow(float(1).sub(sec.div(PI)), TSL.mix(float(4.5), float(1.4), uBlurRpm));
    const discMask = smoothstep(0.14, 0.26, r).mul(smoothstep(1.0, 0.96, r));
    const tipBand = smoothstep(0.84, 0.90, r).mul(smoothstep(1.0, 0.97, r));
    const ivoryBand = smoothstep(0.81, 0.84, r).mul(smoothstep(0.87, 0.845, r));
    const baseTip = TSL.mix(vec3(0.24, 0.29, 0.31), vec3(0.96, 0.94, 0.86), ivoryBand.mul(0.85));
    const col = TSL.mix(baseTip, vec3(0.98, 0.40, 0.14), tipBand);
    // Sunlit metallic flash along two opposing pitch lobes
    const glint = pow(TSL.abs(TSL.sin(ang.mul(2.0).add(0.4))), 4.0).mul(0.28);
    const alpha = discMask.mul(streak.mul(0.28).add(tipBand.mul(0.22)).add(glint.mul(0.22))).mul(uBlurRpm).clamp(0, 0.56);
    return vec4(col.mul(float(1.0).add(glint.mul(1.4))), alpha);
  })();
  blurMat.mrtNode = auxPassthrough();
  const blur = mesh(
    new T.PlaneGeometry(2.61, 2.61),
    blurMat,
    prop,
  );
  blur.rotation.y = PI / 2;
  blur.position.x = -0.025;
  blur.receiveShadow = blur.castShadow = false;
  blur.renderOrder = 15;
  // Stepped, hard-chine floats. Each strip has its own physically distinct finish.
  const floatStations = [
    [-4.32, 0.015, 0.569, 0.516],
    [-4.2, 0.119, 0.592, 0.38],
    [-3.94, 0.255, 0.613, 0.201],
    [-3.54, 0.356, 0.625, -0.008],
    [-2.924, 0.414, 0.635, -0.188],
    [-1.88, 0.442, 0.646, -0.282],
    [-0.64, 0.449, 0.648, -0.338],
    [0.318, 0.445, 0.631, -0.351],
    [0.35, 0.443, 0.63, -0.16],
    [1.18, 0.408, 0.599, -0.09],
    [2.11, 0.329, 0.538, 0.05],
    [2.78, 0.238, 0.464, 0.163],
    [3.035, 0.171, 0.424, 0.228],
    [3.095, 0.152, 0.411, 0.257],
  ];
  const floatZ = 1.225;
  function flSection(x) {
    let k = 0;
    while (k < floatStations.length - 2 && x > floatStations[k + 1][0]) k++;
    const a = floatStations[k],
      b = floatStations[k + 1],
      u = clamp((x - a[0]) / (b[0] - a[0]));
    return [mix(a[1], b[1], u), mix(a[2], b[2], u), mix(a[3], b[3], u)];
  }
  function flPoint(x, s, c) {
    const [w, d, k] = flSection(x),
      v = [
        [0, d + 0.031],
        [0.69, d + 0.021],
        [0.925, d],
        [1, d - 0.048],
        [0.985, d - 0.12],
        [0.93, d - 0.197],
        [0.845, mix(k, d, 0.36)],
        [0.62, mix(k, d, 0.19)],
        [0.08, k + 0.012],
        [0, k],
      ][c];
    return V(x, v[1], s * w * v[0]);
  }
  const floatMark = canvasMap(768, 128, (c, w, h) => {
    c.fillStyle = '#223e46';
    c.font = 'italic 700 41px Arial';
    c.fillText('COASTAL', 23, 56);
    c.font = '600 14px Arial';
    c.fillText('F L O A T   D I V I S I O N', 24, 87);
    poly(
      c,
      [
        [218, 26],
        [254, 26],
        [232, 56],
        [196, 56],
      ],
      '#e2622d',
    );
    c.fillStyle = '#384b4f';
    c.font = '500 21px monospace';
    c.fillText('F-OPLG', 512, 62);
    c.font = '14px monospace';
    c.fillText('WATER  LINE', 511, 84);
    line(
      c,
      [
        [512, 98],
        [657, 98],
      ],
      '#485353',
      2,
    );
  });
  const floatStamp = std(0xffffff, 0.44, 0.3, {
    map: floatMark,
    transparent: true,
    alphaTest: 0.28,
    depthWrite: false,
    side: T.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const floatTop = marineAlloy(0xc2cecb, 0.30, 0.68),
    floatAlloy = marineAlloy(0xabb9b7, 0.27, 0.78),
    bootTop = enamel(0x1d343d, 0.22, 0.44, 0.85, 0.09);
  const deckTread = std(0x475553, 0.77, 0.2);
  const strips = [floatTop, floatTop, steel, blue, floatAlloy, floatAlloy, bootTop, bootTop, darkmetal];
  for (const sz of [-1, 1]) {
    const z = sz * floatZ;
    for (const s of [-1, 1])
      for (let j = 0; j < 9; j++) {
        const xs = [];
        floatStations.forEach((r, k) => {
          if (k) {
            const a = floatStations[k - 1][0];
            for (let d = 1; d < 4; d++) xs.push(mix(a, r[0], d / 4));
          }
          xs.push(r[0]);
        });
        const P = [],
          I = [],
          U = [];
        xs.forEach((x, k) => {
          for (let v = 0; v < 2; v++) {
            const p = flPoint(x, s, j + v);
            P.push(p.x, p.y, p.z + z);
            U.push(k / (xs.length - 1), v);
          }
          if (k) {
            const a = k * 2 - 2;
            if (s > 0) I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            else I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        });
        mesh(geometry(P, I, U), strips[j]);
      }
    for (const ds of [-1, 1]) {
      const g = gridSurface(36, 2, (u, v) => {
        const x = mix(-2.9, 0.23, ds === 1 ? u : 1 - u),
          top = flPoint(x, ds, 4),
          low = flPoint(x, ds, 6);
        const p = low.lerp(top, 0.22 + v * 0.59);
        p.z += z + ds * 0.006;
        return p;
      });
      const stamp = mesh(g, floatStamp);
      stamp.castShadow = false;
    }
    for (const x of [-4.32, 3.095]) {
      const P = [],
        I = [];
      for (const s of [1, -1])
        for (let j = 0; j < 10; j++) {
          const p = flPoint(x, s, s === 1 ? j : 9 - j);
          P.push(x, p.y, p.z + z);
        }
      for (let j = 1; j < 19; j++) I.push(0, j + 1, j);
      mesh(geometry(P, I), floatAlloy);
    }
    for (const x of [-3.56, -2.91, -2.0, -1.16, -0.26, 0.59, 1.55, 2.35, 2.83]) {
      for (const s of [-1, 1]) {
        const points = [];
        for (let j = 0; j <= 6; j++) {
          const p = flPoint(x, s, j);
          p.z += z;
          points.push(p);
        }
        wire(points, 0.0034, darkmetal);
      }
    }
    for (const s of [-1, 1]) {
      const rub = [];
      for (const [x] of floatStations) {
        const p = flPoint(x, s, 3);
        p.z += z;
        rub.push(p);
      }
      wire(rub, 0.013, steel);
    }
    for (const x of [-2.2, -0.69, 0.85, 2.09]) {
      const [w, d] = flSection(x);
      const width = w * 1.15;
      box(x, d + 0.041, z, 0.57, 0.02, width, blue);
      box(x, d + 0.054, z, 0.541, 0.013, width - 0.024, floatTop);
      box(x + 0.16, d + 0.064, z, 0.065, 0.011, 0.114, darkmetal);
      for (const k of [-1, 1])
        for (const j of [-1, 1])
          oval(x + k * 0.233, d + 0.062, z + j * (width * 0.41), 0.012, 0.006, 0.012, steel);
    }
    for (const x of [-1.39, 0.1]) {
      const [w, d] = flSection(x);
      box(x, d + 0.047, z + sz * w * 0.37, 0.6, 0.018, 0.155, deckTread);
      for (let k = -4; k <= 4; k++)
        box(x + k * 0.063, d + 0.06, z + sz * w * 0.37, 0.016, 0.01, 0.141, darkmetal);
    }
    for (const x of [-3.367, 2.53]) {
      const [w, d] = flSection(x);
      box(x, d + 0.04, z, 0.21, 0.024, 0.087, steel);
      rod(V(x - 0.052, d + 0.048, z), V(x - 0.077, d + 0.103, z), 0.016, steel);
      rod(V(x + 0.052, d + 0.048, z), V(x + 0.077, d + 0.103, z), 0.016, steel);
      rod(V(x - 0.12, d + 0.104, z), V(x + 0.12, d + 0.104, z), 0.018, steel);
    }
    const bowEye = new T.TorusGeometry(0.057, 0.013, 7, 18);
    const eye = mesh(bowEye, steel);
    eye.position.set(-4.15, 0.43, z);
    eye.rotation.y = PI / 2;
    for (const s of [-1, 1]) {
      const pts = [];
      for (const x of [-3.76, -3.36, -2.71, -1.85, -0.74, 0.28]) {
        const p = flPoint(x, s, 7);
        p.y -= 0.025;
        p.z += z;
        pts.push(p);
      }
      wire(pts, 0.02, darkmetal);
    }
    // Water rudder blade, pivot cheeks, tiller arm and steering cable.
    const rud = new T.Shape();
    rud.moveTo(3.03, 0.39);
    rud.lineTo(3.33, 0.4);
    rud.bezierCurveTo(3.45, 0.33, 3.49, 0.02, 3.46, -0.017);
    rud.lineTo(3.24, -0.21);
    rud.quadraticCurveTo(3.15, -0.24, 3.15, -0.08);
    rud.lineTo(3.12, 0.21);
    rud.closePath();
    const blade = mesh(
      new T.ExtrudeGeometry(rud, {
        depth: 0.037,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.008,
        bevelThickness: 0.007,
      }),
      darkmetal,
    );
    blade.position.z = z - 0.0185;
    rod(V(3.103, 0.205, z), V(3.128, 0.542, z), 0.028, steel);
    rod(V(3.104, 0.462, z - sz * 0.12), V(3.188, 0.485, z + sz * 0.206), 0.02, steel);
    wire(
      [
        V(3.175, 0.492, z + sz * 0.195),
        V(2.65, 0.594, z + sz * 0.154),
        V(0.24, 0.716, z + sz * 0.112),
        V(0.15, 1.59, sz * 0.69),
      ],
      0.007,
      black,
    );
  }
  for (const x of [-1.77, 0.62]) {
    foilStrut(V(x, 0.565, -floatZ), V(x, 0.565, floatZ), 0.13, 0.068, floatAlloy);
    for (const s of [-1, 1]) {
      const p = V(x, 0.616, floatZ * s);
      oval(p.x, p.y, p.z, 0.126, 0.065, 0.093, steel);
    }
  }
  for (const s of [-1, 1]) {
    const a = V(-1.96, 0.658, floatZ * s),
      b = V(-1.504, 1.909, 0.626 * s),
      c = V(0.103, 1.773, 0.69 * s),
      d = V(0.786, 0.638, floatZ * s);
    for (const [p, q, w] of [
      [a, b, 0.16],
      [a, c, 0.143],
      [d, c, 0.156],
      [d, V(0.812, 1.817, 0.626 * s), 0.128],
    ]) {
      foilStrut(p, q, w, 0.072, floatAlloy);
      for (const t of [0.028, 0.968]) {
        const u = p.clone().lerp(q, t - 0.018),
          v = p.clone().lerp(q, t + 0.018);
        foilStrut(u, v, w + 0.016, 0.085, darkmetal);
      }
    }
    const e = V(-0.775, 1.839, 0.727 * s),
      f = V(-0.435, 3.627, 4.42 * s);
    foilStrut(e, f, 0.164, 0.078, paint);
    foilStrut(e, e.clone().lerp(f, 0.063), 0.182, 0.087, darkmetal);
    foilStrut(e.clone().lerp(f, 0.953), f, 0.177, 0.084, steel);
    const wingJoint = V(-0.44, 3.618, 4.412 * s);
    oval(...wingJoint.toArray(), 0.154, 0.049, 0.077, ivory);
    wire([a.clone().add(V(0.1, 0, -0.035 * s)), V(0.63, 0.629, -floatZ * s)], 0.009, darkmetal);
    wire([V(0.48, 1.66, 0.62 * s), V(-1.74, 0.612, -floatZ * s)], 0.009, darkmetal);
    for (const x of [-0.922, -0.462]) {
      wire(
        [V(x, 1.626, 0.59 * s), V(x, 1.355, 0.885 * s), V(x, 1.06, 1.03 * s), V(x, 0.697, 1.13 * s)],
        0.023,
        steel,
      );
    }
    for (const [y, z] of [
      [1.332, 0.884],
      [1.055, 1.032],
      [0.838, 1.108],
    ]) {
      foilStrut(V(-0.939, y, z * s), V(-0.441, y + 0.001, z * s), 0.04, 0.04, steel);
      box(-0.69, y, z * s, 0.506, 0.032, 0.084, darkmetal);
    }
    const grip = [];
    for (const p of [
      [-1.46, 2.14, 0.788],
      [-1.46, 2.16, 0.855],
      [-1.46, 2.39, 0.857],
      [-1.46, 2.414, 0.801],
    ])
      grip.push(V(p[0], p[1], p[2] * s));
    wire(grip, 0.014, steel);
  }
  const ant = new T.Shape();
  ant.moveTo(0.51, 3.676);
  ant.lineTo(0.68, 3.986);
  ant.quadraticCurveTo(0.72, 4.003, 0.716, 3.959);
  ant.lineTo(0.7, 3.657);
  ant.closePath();
  const aerial = mesh(new T.ExtrudeGeometry(ant, { depth: 0.03, bevelEnabled: false }), ivory);
  aerial.position.z = -0.015;
  wire([V(1.31, 3.45, 0), V(1.421, 3.78, 0), V(1.56, 4.045, 0)], 0.008, darkmetal);
  batch(fixed);
  batch(prop);
  return { air, prop, movingBlades, blur, blurRpm: uBlurRpm };
}
