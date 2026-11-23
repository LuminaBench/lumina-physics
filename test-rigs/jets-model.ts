// @ts-nocheck
/**
 * Fighter-jet test rigs: F-15E, F-16C, F-22A, F/A-18E and Su-57.
 *
 * Lofted fuselages, airfoil wings, procedural PBR skins and animated nozzles.
 * The exhaust and vapor cone use TSL node materials.
 *
 * Model space: metres, nose along -Z, +Y up (three.js "forward").
 */
import * as THREE from 'three/webgpu';
import { JetExhaust } from '../modules/aero/exhaust';
import { TSL } from '../engine/tsl';

const { Fn, uniform, uv, vec3, vec4, float, sin, pow, mix, smoothstep, abs, dot, normalize, normalView, positionViewDirection, max, clamp } = TSL;

export const JET_CATALOG = [
  {
    id: 'f15e',
    name: 'F-15E Strike Eagle',
    role: 'Heavy Twin-Engine Air Superiority',
    tag: 'MACH 2.5',
    squadron: 'USAF • SJ AF-0506',
    style: 'f15',
    nozzles: 2,
    nozzleShape: 'round',
    burnerColor: [1.0, 0.56, 0.24],
    burnerOuter: [0.65, 0.35, 1.0],
    baseColor: '#7b848c',
    camoColor: '#5c646c',
    accentColor: '#2ea85d',
    tailCode: 'SJ',
    tailSerial: '0506',
    stats: { speed: 98, agility: 84, accel: 92, armor: 92 },
    flight: {
      maxSpeed: 560, cruiseSpeed: 235, minSpeed: 76,
      accel: 120, abAccel: 215,
      pitchRate: 1.72, rollRate: 3.1, yawRate: 0.85,
      maxHp: 135, maxMissiles: 10, maxFlares: 14,
    }
  },
  {
    id: 'f16c',
    name: 'F-16C Fighting Falcon',
    role: 'Agile Lightweight Dogfighter',
    tag: '9G VIPER',
    squadron: 'USAF • NV 3498',
    style: 'f16',
    nozzles: 1,
    nozzleShape: 'round',
    burnerColor: [1.0, 0.58, 0.92],
    burnerOuter: [0.58, 0.25, 1.0],
    baseColor: '#4e555e',
    camoColor: '#3a4048',
    accentColor: '#cfd8e0',
    tailCode: 'NV',
    tailSerial: '3498',
    stats: { speed: 88, agility: 96, accel: 94, armor: 76 },
    flight: {
      maxSpeed: 515, cruiseSpeed: 220, minSpeed: 70,
      accel: 132, abAccel: 225,
      pitchRate: 2.02, rollRate: 3.85, yawRate: 0.95,
      maxHp: 105, maxMissiles: 6, maxFlares: 12,
    }
  },
  {
    id: 'f22',
    name: 'F-22A Raptor',
    role: '5th-Gen Stealth Dominance',
    tag: 'STEALTH',
    squadron: 'USAF • TY 098',
    style: 'f22',
    nozzles: 2,
    nozzleShape: 'rect',
    burnerColor: [1.0, 0.65, 0.38],
    burnerOuter: [0.48, 0.44, 1.0],
    baseColor: '#6b727a',
    camoColor: '#4c535b',
    accentColor: '#8d96a0',
    tailCode: 'TY',
    tailSerial: '098',
    stats: { speed: 95, agility: 97, accel: 96, armor: 88 },
    flight: {
      maxSpeed: 545, cruiseSpeed: 240, minSpeed: 68,
      accel: 138, abAccel: 235,
      pitchRate: 2.08, rollRate: 3.55, yawRate: 1.02,
      maxHp: 125, maxMissiles: 8, maxFlares: 14,
    }
  },
  {
    id: 'fa18',
    name: 'F/A-18E Super Hornet',
    role: 'Carrier Multi-Role Strike Fighter',
    tag: 'NAVY CVN',
    squadron: 'USN • VF-103',
    style: 'fa18',
    nozzles: 2,
    nozzleShape: 'round',
    burnerColor: [1.0, 0.60, 0.25],
    burnerOuter: [0.60, 0.30, 0.95],
    baseColor: '#869098',
    camoColor: '#69747e',
    accentColor: '#f0b830',
    tailCode: 'AG',
    tailSerial: '201',
    stats: { speed: 85, agility: 92, accel: 88, armor: 90 },
    flight: {
      maxSpeed: 495, cruiseSpeed: 215, minSpeed: 64,
      accel: 118, abAccel: 200,
      pitchRate: 1.94, rollRate: 3.4, yawRate: 0.96,
      maxHp: 130, maxMissiles: 8, maxFlares: 14,
    }
  },
  {
    id: 'su57',
    name: 'Su-57 Felon',
    role: 'Super-Maneuverable Stealth Rival',
    tag: 'COBRA',
    squadron: 'VKS • BLUE 054',
    style: 'su57',
    nozzles: 2,
    nozzleShape: 'round',
    burnerColor: [1.0, 0.48, 0.65],
    burnerOuter: [0.42, 0.32, 1.0],
    baseColor: '#6c7c88',
    camoColor: '#364654',
    accentColor: '#3da5ff',
    tailCode: '054',
    tailSerial: 'RF',
    stats: { speed: 94, agility: 99, accel: 93, armor: 86 },
    flight: {
      maxSpeed: 540, cruiseSpeed: 232, minSpeed: 66,
      accel: 130, abAccel: 225,
      pitchRate: 2.18, rollRate: 3.6, yawRate: 1.1,
      maxHp: 120, maxMissiles: 8, maxFlares: 14,
    }
  }
];

/** Soft transonic shock curtain (TSL port). The aero module drives a richer Prandtl–Glauert cone. */
function createVaporConeMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fog = false;
  const uTime = uniform(0), uIntensity = uniform(0);
  material.colorNode = Fn(() => {
    const st = uv();
    const band = smoothstep(0.02, 0.34, st.y).mul(smoothstep(0.98, 0.56, st.y));
    const rim = float(1).sub(abs(dot(normalize(normalView), normalize(positionViewDirection))));
    const edge = pow(max(rim, 0.0001), 0.72).mul(0.65).add(0.35);
    const wisp = sin(st.x.mul(38).add(uTime.mul(18))).mul(sin(st.y.mul(14).sub(uTime.mul(24)))).mul(0.22).add(0.78);
    return vec4(mix(vec3(0.86, 0.93, 0.99), vec3(0.98, 0.99, 1.0), band), band.mul(edge).mul(wisp).mul(uIntensity).mul(0.52).clamp(0, 0.62));
  })();
  material.mrtNode = TSL.mrt({ normal: vec4(0), velocity: vec4(0) });
  material.uniforms = { uTime, uIntensity };
  return material;
}

const textureCache = new Map();

function createJetTextures(jet, isEnemy = false) {
  const key = jet.id + (isEnemy ? '_enemy' : '_player');
  if (textureCache.has(key)) return textureCache.get(key);

  const physSize = isEnemy ? 512 : 1024;
  const size = 1024;
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = physSize;
  const ctx = albedoCanvas.getContext('2d');

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = bumpCanvas.height = physSize;
  const bctx = bumpCanvas.getContext('2d');

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = roughCanvas.height = physSize;
  const rctx = roughCanvas.getContext('2d');

  const metalCanvas = document.createElement('canvas');
  metalCanvas.width = metalCanvas.height = physSize;
  const mctx = metalCanvas.getContext('2d');

  if (physSize !== size) {
    const s = physSize / size;
    ctx.scale(s, s);
    bctx.scale(s, s);
    rctx.scale(s, s);
    mctx.scale(s, s);
  }

  const base = isEnemy ? '#3d424b' : jet.baseColor;
  const camo = isEnemy ? '#22262e' : jet.camoColor;

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, size, size);
  rctx.fillStyle = '#6e6e6e';
  rctx.fillRect(0, 0, size, size);
  mctx.fillStyle = 'rgb(58,58,58)';
  mctx.fillRect(0, 0, size, size);

  // Authentic military camouflage pattern (splinter for Su-57, Have Glass stealth for F-22, Mod Eagle for F-15)
  ctx.save();
  ctx.fillStyle = camo;
  ctx.globalAlpha = jet.style === 'su57' ? 0.72 : 0.45;
  const patches = jet.style === 'su57'
    ? [[0, 0, 380, 290], [490, 140, 440, 320], [120, 520, 460, 340], [640, 620, 380, 360]]
    : [[0, 60, 420, 280], [520, 180, 480, 310], [110, 510, 460, 340], [610, 620, 390, 350]];
  for (const [x, y, w, h] of patches) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + (jet.style === 'su57' ? 88 : 38));
    ctx.lineTo(x + w - (jet.style === 'su57' ? 95 : 52), y + h);
    ctx.lineTo(x + 36, y + h - 42);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Staggered realistic aircraft fuselage & wing skin panels (non-checkerboard!)
  const rows = 12;
  const rowH = size / rows;
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round(r * rowH);
    const cols = 6 + ((r * 5) % 4);
    const colW = size / cols;
    const xOffset = (r % 2) * (colW * 0.42);
    for (let c = -1; c <= cols; c++) {
      const x0 = Math.round(c * colW + xOffset);
      const pw = Math.round(colW);
      const ph = Math.round(rowH);

      // Panel-by-panel tonal & genuine tactile roughness contrast (satin metallic vs matte RAM)
      const hash = ((r * 73 + c * 139 + 17) & 31) - 15;
      ctx.fillStyle = hash > 0 ? `rgba(255,255,255,${hash * 0.0038})` : `rgba(0,0,0,${-hash * 0.0044})`;
      ctx.fillRect(x0 + 1, y0 + 1, pw - 2, ph - 2);

      const roughVal = 92 + ((r * 37 + c * 61 + 11) % 108);
      rctx.fillStyle = `rgb(${roughVal},${roughVal},${roughVal})`;
      rctx.fillRect(x0 + 1, y0 + 1, pw - 2, ph - 2);

      // Subtle composite vs bare titanium/Have-Glass panel metalness variation
      const isStealth = jet.style === 'f22' || jet.style === 'su57';
      const mVal = ((r * 41 + c * 67) % 9 === 0) ? 176 : (isStealth ? 98 : 66) + ((r * 19 + c * 31) % 34);
      mctx.fillStyle = `rgb(${mVal},${mVal},${mVal})`;
      mctx.fillRect(x0 + 2, y0 + 2, pw - 4, ph - 4);
      mctx.strokeStyle = 'rgb(208,208,208)';
      mctx.lineWidth = 1.6;
      mctx.strokeRect(x0 + 1, y0 + 1, pw - 2, ph - 2);

      // Stealth RAM tape along panel edges (iconic lighter satin seam strips on F-22 / Su-57)
      if (isStealth) {
        ctx.strokeStyle = 'rgba(182, 192, 204, 0.24)';
        ctx.lineWidth = 5.0;
        ctx.strokeRect(x0 + 2.5, y0 + 2.5, pw - 5, ph - 5);
        rctx.strokeStyle = 'rgb(168,168,168)';
        rctx.lineWidth = 5.0;
        rctx.strokeRect(x0 + 2.5, y0 + 2.5, pw - 5, ph - 5);
      }

      // Subtle dark panel-edge grime halo
      ctx.strokeStyle = 'rgba(10, 14, 20, 0.42)';
      ctx.lineWidth = 2.0;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw, ph);

      // Crisp bump groove
      bctx.strokeStyle = '#363636';
      bctx.lineWidth = 2.0;
      bctx.strokeRect(x0 + 0.5, y0 + 0.5, pw, ph);

      // Rivet lines parallel to seam (glossy bare metal fasteners)
      ctx.fillStyle = 'rgba(18, 22, 28, 0.32)';
      bctx.fillStyle = '#a4a4a4';
      mctx.fillStyle = 'rgb(220,220,220)';
      for (let rx = x0 + 8; rx < x0 + pw - 6; rx += 14) {
        ctx.fillRect(rx, y0 + 4, 1.8, 1.8);
        bctx.fillRect(rx, y0 + 4, 1.8, 1.8);
        mctx.fillRect(rx, y0 + 4, 1.8, 1.8);
      }
      for (let ry = y0 + 10; ry < y0 + ph - 6; ry += 14) {
        ctx.fillRect(x0 + 4, ry, 1.8, 1.8);
        bctx.fillRect(x0 + 4, ry, 1.8, 1.8);
        mctx.fillRect(x0 + 4, ry, 1.8, 1.8);
      }
    }
  }

  // Stealth sawtooth RAM access hatches (F-22 / Su-57) or standard avionics doors
  for (let i = 0; i < 34; i++) {
    const hx = ((i * 193 + 47) % (size - 90)) + 28;
    const hy = ((i * 271 + 83) % (size - 90)) + 28;
    const hw = 26 + (i % 4) * 14;
    const hh = 20 + (i % 3) * 12;

    if (jet.style === 'f22' || jet.style === 'su57') {
      ctx.strokeStyle = 'rgba(210, 220, 232, 0.28)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(hx, hy + hh * 0.5);
      ctx.lineTo(hx + hw * 0.25, hy);
      ctx.lineTo(hx + hw * 0.75, hy);
      ctx.lineTo(hx + hw, hy + hh * 0.5);
      ctx.lineTo(hx + hw * 0.75, hy + hh);
      ctx.lineTo(hx + hw * 0.25, hy + hh);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
      ctx.fillRect(hx, hy, hw, hh);
      ctx.strokeStyle = 'rgba(14, 18, 24, 0.52)';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(hx, hy, hw, hh);
      bctx.strokeStyle = '#383838';
      bctx.strokeRect(hx, hy, hw, hh);
    }

    // Bare titanium/steel fastener sheen around access bay
    mctx.fillStyle = i % 3 === 0 ? 'rgb(212,212,212)' : 'rgb(165,165,165)';
    mctx.fillRect(hx, hy, hw, hh);
    mctx.strokeStyle = 'rgb(232,232,232)';
    mctx.lineWidth = 2;
    mctx.strokeRect(hx, hy, hw, hh);

    // Airstream hydraulic/soot weathering streak trailing aft (+Y on texture)
    const streakLen = 44 + (i % 5) * 18;
    const grad = ctx.createLinearGradient(hx, hy + hh, hx, hy + hh + streakLen);
    grad.addColorStop(0, 'rgba(14, 16, 20, 0.24)');
    grad.addColorStop(1, 'rgba(14, 16, 20, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(hx + 3, hy + hh, hw - 6, streakLen);
  }

  // Low-vis military national insignia / service stencils
  const drawRoundel = (cx, cy, r) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = isEnemy ? '#c8343e' : '#222a34';
    ctx.fillStyle = isEnemy ? '#c8343e' : '#222a34';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillRect(-r * 1.9, -r * 0.34, r * 0.9, r * 0.68);
    ctx.fillRect(r * 1.0, -r * 0.34, r * 0.9, r * 0.68);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a1 = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      const a2 = a1 + Math.PI / 5;
      if (k === 0) ctx.moveTo(Math.cos(a1) * r * 0.88, Math.sin(a1) * r * 0.88);
      else ctx.lineTo(Math.cos(a1) * r * 0.88, Math.sin(a1) * r * 0.88);
      ctx.lineTo(Math.cos(a2) * r * 0.38, Math.sin(a2) * r * 0.38);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  drawRoundel(260, 480, 26);
  drawRoundel(760, 480, 26);

  // Leading-edge titanium erosion guard strip & subtle airframe stencil decals
  ctx.fillStyle = 'rgba(218, 224, 232, 0.20)';
  ctx.fillRect(0, 122, size, 12);
  ctx.fillRect(0, 636, size, 10);

  // DANGER EJECTION SEAT triangles & RESCUE arrows
  const drawWarningTri = (cx, cy) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(210, 48, 36, 0.78)';
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(13, 10);
    ctx.lineTo(-13, 10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(245, 200, 45, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(245, 210, 60, 0.92)';
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DANGER', 0, 20);
    ctx.restore();
  };
  drawWarningTri(168, 218);
  drawWarningTri(856, 218);

  // Crisp low-vis military service stencils & "NO STEP" markings matching the airframe's squadron
  ctx.fillStyle = 'rgba(28, 34, 42, 0.56)';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(jet.squadron || 'USAF // TY-098', 320, 312);
  ctx.fillText(jet.squadron || 'USAF // TY-098', 704, 312);
  ctx.font = 'bold 11px monospace';
  ctx.fillText('NO STEP', 260, 540);
  ctx.fillText('NO STEP', 760, 540);

  // Subtle brushed aluminum micro-grain
  for (let i = 0; i < 6500; i++) {
    const x = (i * 137) % size;
    const y = (i * 89 + Math.floor(i / 64) * 19) % size;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.024)' : 'rgba(0,0,0,0.028)';
    ctx.fillRect(x, y, 2, 5);
  }

  const albedo = new THREE.CanvasTexture(albedoCanvas);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = 8;

  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 8;

  const rough = new THREE.CanvasTexture(roughCanvas);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;

  const metal = new THREE.CanvasTexture(metalCanvas);
  metal.wrapS = metal.wrapT = THREE.RepeatWrapping;
  metal.anisotropy = 8;

  // High-Res 512x512 Vertical Stabilizer Squadron Livery
  const tailCanvas = document.createElement('canvas');
  tailCanvas.width = 512; tailCanvas.height = 512;
  const tctx = tailCanvas.getContext('2d');
  tctx.drawImage(albedoCanvas, 0, 0, 512, 512);

  // Rudder hinge vertical seam
  tctx.strokeStyle = 'rgba(12, 16, 22, 0.65)';
  tctx.lineWidth = 4;
  tctx.beginPath(); tctx.moveTo(378, 36); tctx.lineTo(398, 512); tctx.stroke();

  // Top squadron command flash band (Green on F-15E SJ, Gold on USN VF-103, Red on Aggressor)
  tctx.fillStyle = isEnemy ? '#d93240' : jet.accentColor;
  tctx.fillRect(0, 22, 512, 28);
  tctx.fillStyle = '#f2f5f8';
  tctx.fillRect(0, 50, 512, 7);
  tctx.fillStyle = 'rgba(0,0,0,0.5)';
  tctx.fillRect(0, 57, 512, 3);

  // Squadron Crest Badge
  tctx.save();
  tctx.translate(230, 118);
  tctx.fillStyle = isEnemy ? '#cc2b38' : '#d8b448';
  tctx.beginPath();
  tctx.moveTo(-22, -24); tctx.lineTo(22, -24); tctx.lineTo(20, 8); tctx.lineTo(0, 28); tctx.lineTo(-20, 8);
  tctx.closePath();
  tctx.fill();
  tctx.strokeStyle = '#1d242c'; tctx.lineWidth = 3; tctx.stroke();
  tctx.restore();

  // Bold Military Tail Letters & Serial Number
  tctx.fillStyle = isEnemy ? '#ff4455' : 'rgba(22, 26, 32, 0.88)';
  tctx.font = '800 128px "Arial Narrow", sans-serif';
  tctx.textAlign = 'center';
  tctx.fillText(isEnemy ? 'RED' : jet.tailCode, 232, 290);

  tctx.font = '700 46px monospace';
  tctx.fillText(isEnemy ? ('0' + ((jet.id.length * 7) % 90 + 10)) : ('AF ' + jet.tailSerial), 232, 376);

  // Subtle weathered clearcoat over markings
  tctx.fillStyle = 'rgba(130, 145, 160, 0.08)';
  tctx.fillRect(0, 0, 512, 512);

  const tailTex = new THREE.CanvasTexture(tailCanvas);
  tailTex.colorSpace = THREE.SRGBColorSpace;
  tailTex.anisotropy = 8;

  const res = { albedo, bump, rough, metal, tailTex };
  textureCache.set(key, res);
  return res;
}

function createTitaniumNozzleTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  // Iridescent heat-tempered titanium & inconel gradient (straw gold → violet → cobalt → carbon lip)
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#a68d68');
  g.addColorStop(0.18, '#7c6b74');
  g.addColorStop(0.40, '#445276');
  g.addColorStop(0.64, '#34354c');
  g.addColorStop(0.84, '#20212a');
  g.addColorStop(1.0, '#101116');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  // Crisp turbine feather actuator ribs
  for (let x = 0; x < 512; x += 24) {
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(x, 0, 3, 256);
    ctx.fillStyle = 'rgba(255,228,196,0.22)';
    ctx.fillRect(x + 3, 0, 4, 256);
    ctx.fillStyle = 'rgba(180,200,255,0.12)';
    ctx.fillRect(x + 12, 20, 5, 210);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function createFlareStarTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  // Tight radial halo
  const halo = ctx.createRadialGradient(64, 64, 1, 64, 64, 58);
  halo.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  halo.addColorStop(0.18, 'rgba(255, 240, 185, 0.92)');
  halo.addColorStop(0.45, 'rgba(255, 180, 75, 0.35)');
  halo.addColorStop(1.0, 'rgba(255, 120, 20, 0.0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 128, 128);
  // Diffraction starburst spikes
  const drawSpike = (angle, len, width, alpha) => {
    ctx.save();
    ctx.translate(64, 64);
    ctx.rotate(angle);
    const sg = ctx.createLinearGradient(-len, 0, len, 0);
    sg.addColorStop(0.0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, `rgba(255,252,235,${alpha})`);
    sg.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -width, len, 0);
    ctx.quadraticCurveTo(0, width, -len, 0);
    ctx.fill();
    ctx.restore();
  };
  drawSpike(0, 62, 5.0, 0.95);
  drawSpike(Math.PI / 2, 62, 5.0, 0.95);
  drawSpike(Math.PI / 4, 42, 2.8, 0.65);
  drawSpike(-Math.PI / 4, 42, 2.8, 0.65);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let TITANIUM_TEX = null;
let FLARE_STAR_TEX = null;

function nacaThickness(t) {
  const ct = Math.max(0, Math.min(1, t));
  return 5.0 * (0.2969 * Math.sqrt(ct) - 0.1260 * ct - 0.3516 * ct * ct + 0.2843 * ct * ct * ct - 0.1015 * ct * ct * ct * ct);
}

function createLoftedFuselage(stations, radialSegs = 32) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const stride = radialSegs + 1;
  const zMin = stations[0].z;
  const zMax = stations[stations.length - 1].z;

  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const vCoord = ((s.z - zMin) / Math.max(0.01, zMax - zMin)) * 2.2;

    for (let j = 0; j <= radialSegs; j++) {
      const uFrac = j / radialSegs;
      const a = uFrac * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);

      // Chine shaping (pinches left/right edges into razor-sharp stealth chines on F-22/Su-57)
      const chine = s.chine || 0;
      const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 1.0 + chine * 0.85);
      let x = ca * s.rx;
      let ry = sa >= 0 ? s.ryTop : s.ryBot;
      let y = sy * ry;

      // Flattened stealth/lifting belly
      if (sa < 0 && s.bellyFlat) {
        y = THREE.MathUtils.lerp(y, Math.max(y, -s.ryBot * (1.0 - s.bellyFlat * 0.38)), s.bellyFlat);
      }

      // Twin-engine nacelle sculpting (smooth central valley between twin engine barrels!)
      if (s.twinSplit && s.twinSplit > 0) {
        const centerValley = Math.exp(-(x * x) / (0.34 * s.rx * s.rx + 0.05));
        const barrelBulge = Math.exp(-Math.pow(Math.abs(x) - s.rx * 0.52, 2) / (0.14 * s.rx * s.rx + 0.04));
        y *= (1.0 - s.twinSplit * 0.42 * centerValley + s.twinSplit * 0.14 * barrelBulge);
      }

      // Dorsal spine fairing ridge along top centerline
      if (sa > 0.35 && s.spine) {
        const ridge = Math.pow(Math.max(0, sa - 0.35) / 0.65, 2.2);
        y += ridge * s.spine;
      }

      positions.push(x, y + (s.yOff || 0), s.z);
      uvs.push(uFrac * 2.0, vCoord);
    }
  }

  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a0 = i * stride + j;
      const a1 = a0 + 1;
      const b0 = (i + 1) * stride + j;
      const b1 = b0 + 1;
      indices.push(a0, a1, b1, a0, b1, b0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createLoftedAirfoilWing(sections, side = 1, chordSegs = 12) {
  const loopCount = chordSegs * 2;
  const stride = loopCount + 1;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const uSpan = i / Math.max(1, sections.length - 1);
    for (let j = 0; j <= loopCount; j++) {
      let t, isUpper;
      if (j <= chordSegs) {
        t = j / chordSegs;
        isUpper = true;
      } else {
        t = 1.0 - (j - chordSegs) / chordSegs;
        isUpper = false;
      }
      // Cosine clustering near leading edge for silky-smooth nose curvature
      const tc = 0.5 * (1.0 - Math.cos(t * Math.PI));
      const halfT = nacaThickness(tc) * sec.thick;
      const camber = Math.sin(tc * Math.PI) * sec.thick * 0.08;
      const yOff = isUpper ? (halfT + camber) : (-halfT * 0.78 + camber);
      const zLocal = sec.zLead + tc * sec.chord;

      positions.push(sec.x * side, sec.y + yOff, zLocal);
      uvs.push(uSpan * 1.35, tc * 1.15);
    }
  }

  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < loopCount; j++) {
      const a0 = i * stride + j;
      const a1 = a0 + 1;
      const b0 = (i + 1) * stride + j;
      const b1 = b0 + 1;
      if (side === 1) {
        indices.push(a0, a1, b1, a0, b1, b0);
      } else {
        indices.push(a0, b1, a1, a0, b0, b1);
      }
    }
  }

  // Close wingtip cleanly
  const tipStart = (sections.length - 1) * stride;
  const tipSec = sections[sections.length - 1];
  const tipCenterIdx = positions.length / 3;
  positions.push(tipSec.x * side, tipSec.y, tipSec.zLead + tipSec.chord * 0.5);
  uvs.push(1.0, 0.5);
  for (let j = 0; j < loopCount; j++) {
    if (side === 1) indices.push(tipCenterIdx, tipStart + j, tipStart + j + 1);
    else indices.push(tipCenterIdx, tipStart + j + 1, tipStart + j);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createLoftedVerticalFin(sections, chordSegs = 10) {
  const loopCount = chordSegs * 2;
  const stride = loopCount + 1;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const vH = i / Math.max(1, sections.length - 1);
    for (let j = 0; j <= loopCount; j++) {
      let t, isRight;
      if (j <= chordSegs) {
        t = j / chordSegs;
        isRight = true;
      } else {
        t = 1.0 - (j - chordSegs) / chordSegs;
        isRight = false;
      }
      const tc = 0.5 * (1.0 - Math.cos(t * Math.PI));
      const halfT = nacaThickness(tc) * sec.thick;
      const xLocal = isRight ? halfT : -halfT;
      const zLocal = sec.zLead + tc * sec.chord;

      positions.push(xLocal, sec.y, zLocal);
      // Forward-reading UV on both +X and -X faces (nose of fin = left side of text!)
      uvs.push(isRight ? (1.0 - tc) : tc, vH);
    }
  }

  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < loopCount; j++) {
      const a0 = i * stride + j;
      const a1 = a0 + 1;
      const b0 = (i + 1) * stride + j;
      const b1 = b0 + 1;
      indices.push(a0, b1, a1, a0, b0, b1);
    }
  }

  // Cap top of fin
  const topStart = (sections.length - 1) * stride;
  const topSec = sections[sections.length - 1];
  const topCenter = positions.length / 3;
  positions.push(0, topSec.y, topSec.zLead + topSec.chord * 0.5);
  uvs.push(0.5, 1.0);
  for (let j = 0; j < loopCount; j++) {
    indices.push(topCenter, topStart + j + 1, topStart + j);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildDetailedNozzle(shapeType, radius, nozzleMat, darkMat, jetCfg, coreMat) {
  const nGroup = new THREE.Group();
  const burnerMeshes = [];
  let nozzleCone = null;

  if (shapeType === 'rect') {
    // Authentic F-22A 2D Stealth Thrust-Vectoring Rectangular Nozzle
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.72, 1.25), nozzleMat);
    shroud.position.z = 0.25;
    nGroup.add(shroud);
    // Upper & lower beveled vectoring wedges inside an articulated jaw group so NozzleAnimator dilates them
    const jawGroup = new THREE.Group();
    jawGroup.position.z = 0.98;
    [-1, 1].forEach((vy) => {
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.12, 0.95), nozzleMat);
      paddle.position.set(0, vy * 0.30, 0);
      paddle.rotation.x = vy * 0.14;
      jawGroup.add(paddle);
    });
    nGroup.add(jawGroup);
    nozzleCone = jawGroup;
    // Side titanium cheeks
    [-1, 1].forEach((vx) => {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.62, 1.05), darkMat);
      cheek.position.set(vx * 0.56, 0, 0.85);
      nGroup.add(cheek);
    });
    // Glowing inner rectangular flameholder throat (intensity scales with afterburner)
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.38, 0.18), coreMat);
    core.position.z = 0.72;
    nGroup.add(core);
  } else {
    // Authentic 16-Petal Feathered Pratt & Whitney / GE Convergent-Divergent Nozzle!
    // Base titanium shroud collar
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.06, radius * 1.12, 0.65, 24),
      nozzleMat
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.z = -0.05;
    nGroup.add(collar);

    // Hydraulic actuator ring
    const actRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.04, 0.045, 8, 24),
      darkMat
    );
    actRing.position.z = 0.24;
    nGroup.add(actRing);

    // Single-Draw-Call Corrugated 16-Petal Feathered Titanium Nozzle Cone (Ultra-Fast + Razor-Sharp!)
    const fluteSegs = 64;
    const petalGeo = new THREE.CylinderGeometry(radius * 0.84, radius * 1.03, 1.32, fluteSegs, 3, true);
    const pPos = petalGeo.attributes.position;
    for (let i = 0; i < pPos.count; i++) {
      const x = pPos.getX(i);
      const z = pPos.getZ(i);
      const y = pPos.getY(i);
      const ang = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      // Physical 16-petal turkey-feather corrugation ridges!
      const flute = Math.cos(ang * 16.0) * 0.042 * (0.55 + (y + 0.66) * 0.4);
      const nr = r + flute;
      pPos.setX(i, Math.cos(ang) * nr);
      pPos.setZ(i, Math.sin(ang) * nr);
    }
    petalGeo.computeVertexNormals();
    petalGeo.rotateX(Math.PI / 2);
    const petalMesh = new THREE.Mesh(petalGeo, nozzleMat);
    petalMesh.position.z = 0.78;
    nGroup.add(petalMesh);
    nozzleCone = petalMesh;

    // Recessed dark carbon exhaust barrel interior
    const innerBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.80, radius * 0.86, 1.15, 18, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x101014, roughness: 0.85, side: THREE.BackSide })
    );
    innerBarrel.rotation.x = Math.PI / 2;
    innerBarrel.position.z = 0.72;
    nGroup.add(innerBarrel);

    // Glowing afterburner flameholder ring & radial turbine blades deep inside
    const flameRing = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.52, 0.055, 8, 18), coreMat);
    flameRing.position.z = 0.38;
    nGroup.add(flameRing);
    const turbineHub = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 0.28, 0.55, 12),
      darkMat
    );
    turbineHub.rotation.x = Math.PI / 2;
    turbineHub.position.z = 0.45;
    nGroup.add(turbineHub);
  }

  const flat = shapeType === 'rect';
  const plume = new JetExhaust(flat ? 0.54 : radius * 0.83, 4.8,
    new THREE.Color(...jetCfg.burnerColor), new THREE.Color(...jetCfg.burnerOuter), flat ? 0.55 : 1);
  plume.position.z = 1.38;
  nGroup.add(plume);
  burnerMeshes.push(plume);

  return { nGroup, burnerMeshes, nozzleCone };
}

export function buildFighterJet(jetCfg, isEnemy = false, isPlayer = false) {
  if (!TITANIUM_TEX) { TITANIUM_TEX = createTitaniumNozzleTexture(); FLARE_STAR_TEX = createFlareStarTexture(); }
  const root = new THREE.Group();
  const tex = createJetTextures(jetCfg, isEnemy);
  const style = jetCfg.style;
  const isTwin = jetCfg.nozzles === 2;

  const isStealth = style === 'f22' || style === 'su57';

  // Nuanced military airframe coatings: stealth jets get authentic Have Glass / metallic RAM
  // sheen (view-dependent gunmetal-silver flop + satin clearcoat), 4th-gen jets get satin tactical enamel.
  const makeAirframeMat = (albedoMap, bumpScale) => {
    const mat = new THREE.MeshPhysicalNodeMaterial({
      map: albedoMap,
      bumpMap: tex.bump,
      bumpScale,
      roughnessMap: tex.rough,
      roughness: isStealth ? 0.54 : 0.60,
      metalnessMap: tex.metal,
      metalness: 1.0,
      clearcoat: isStealth ? 0.38 : 0.24,
      clearcoatRoughness: isStealth ? 0.24 : 0.34,
      iridescence: isStealth ? 0.28 : 0.0,
      iridescenceIOR: 1.6,
      envMapIntensity: isStealth ? 1.85 : 1.55,
    });
    if (isStealth) {
      // Subtle Have Glass grazing metallic sheen on chined stealth surfaces
      const NdotV = abs(dot(normalize(normalView), normalize(positionViewDirection))).clamp(0, 1);
      const sheen = pow(float(1).sub(NdotV), 2.4).mul(0.22);
      mat.sheen = 0.55;
      mat.sheenRoughness = 0.38;
      mat.sheenColor = new THREE.Color(0x9fb0c4);
      mat.roughnessNode = TSL.texture(tex.rough, uv()).r.mul(0.54).sub(sheen.mul(0.14)).clamp(0.18, 0.68);
    }
    return mat;
  };
  const hullMat = makeAirframeMat(tex.albedo, 0.048);
  const darkMat = new THREE.MeshPhysicalMaterial({
    color: isEnemy ? 0x20242c : 0x28303b,
    roughness: 0.44,
    metalness: 0.68,
    clearcoat: 0.22,
    clearcoatRoughness: 0.32,
    envMapIntensity: 1.5,
  });
  // Dielectric composite radome contrasts clearly with the metallic-satin airframe
  const radomeMat = new THREE.MeshPhysicalMaterial({
    color: isEnemy ? 0x222730 : (style === 'f15' ? 0x586069 : 0x414a55),
    roughness: 0.58,
    metalness: 0.06,
    clearcoat: 0.14,
    clearcoatRoughness: 0.42,
    envMapIntensity: 1.15,
  });
  const tailMat = makeAirframeMat(tex.tailTex, 0.040);
  // Heat-tempered iridescent titanium/inconel exhaust nozzle metal
  const nozzleMat = new THREE.MeshPhysicalMaterial({
    map: TITANIUM_TEX,
    roughness: 0.20,
    metalness: 0.95,
    clearcoat: 0.35,
    clearcoatRoughness: 0.16,
    iridescence: 0.82,
    iridescenceIOR: 1.85,
    envMapIntensity: 2.0,
  });
  // High-craft view-dependent Fresnel canopy glazing: gold ITO stealth coating on F-22/Su-57,
  // smoked optical polycarbonate with sky reflections on F-15/F-16/F/A-18 (always physical for non-enemy rigs).
  const canopyMat = new THREE.MeshPhysicalNodeMaterial({
    color: isStealth ? 0x6b5620 : 0x162634,
    // The thin conductive coating tints the grazing reflection; most normal-incidence
    // light passes through to the seat and instrument glare shield.
    metalness: isStealth ? 0.075 : 0,
    roughness: 0.035,
    clearcoat: 1.0,
    clearcoatRoughness: 0.015,
    ior: 1.54,
    iridescence: isStealth ? 0.85 : 0.22,
    iridescenceIOR: isStealth ? 1.78 : 1.48,
    transparent: true,
    opacity: 0.62,
    envMapIntensity: 1.05,
    depthWrite: false,
  });
  {
    const NdotV = abs(dot(normalize(normalView), normalize(positionViewDirection))).clamp(0, 1);
    const fres = pow(float(1).sub(NdotV), 2.5);
    const baseTint = isStealth ? vec3(0.075, 0.056, 0.025) : vec3(0.025, 0.042, 0.058);
    const rimTint = isStealth ? vec3(0.32, 0.24, 0.10) : vec3(0.14, 0.20, 0.26);
    canopyMat.colorNode = mix(baseTint, rimTint, fres);
    canopyMat.opacityNode = mix(float(isStealth ? 0.22 : 0.17), float(0.80), fres);
  }

  // 1) SCULPTED PARAMETRIC LOFTED FUSELAGE (Unique real-world anatomical profiles per jet!)
  const fuselageProfiles = {
    f15: [
      { z: -10.5, rx: 0.015, ryTop: 0.015, ryBot: 0.015, yOff: -0.05 },
      { z: -9.8,  rx: 0.24,  ryTop: 0.22,  ryBot: 0.20,  yOff: -0.04 },
      { z: -8.6,  rx: 0.52,  ryTop: 0.48,  ryBot: 0.44,  yOff: -0.02 },
      { z: -7.1,  rx: 0.76,  ryTop: 0.68,  ryBot: 0.56,  yOff: 0.02 },
      { z: -5.4,  rx: 0.88,  ryTop: 0.76,  ryBot: 0.62,  yOff: 0.06, spine: 0.08 },
      { z: -3.5,  rx: 1.12,  ryTop: 0.78,  ryBot: 0.64,  yOff: 0.08, spine: 0.28, bellyFlat: 0.4 },
      { z: -1.4,  rx: 1.65,  ryTop: 0.78,  ryBot: 0.64,  yOff: 0.08, spine: 0.34, bellyFlat: 0.55 },
      { z:  1.4,  rx: 1.72,  ryTop: 0.76,  ryBot: 0.62,  yOff: 0.08, spine: 0.26, bellyFlat: 0.55, twinSplit: 0.25 },
      { z:  4.2,  rx: 1.66,  ryTop: 0.72,  ryBot: 0.58,  yOff: 0.06, spine: 0.14, twinSplit: 0.62 },
      { z:  6.4,  rx: 1.54,  ryTop: 0.66,  ryBot: 0.54,  yOff: 0.04, twinSplit: 0.85 },
      { z:  7.05, rx: 1.44,  ryTop: 0.60,  ryBot: 0.50,  yOff: 0.04, twinSplit: 0.92 },
    ],
    f16: [
      { z: -9.6,  rx: 0.015, ryTop: 0.015, ryBot: 0.015, yOff: -0.04 },
      { z: -8.9,  rx: 0.22,  ryTop: 0.20,  ryBot: 0.19,  yOff: -0.03 },
      { z: -7.7,  rx: 0.48,  ryTop: 0.44,  ryBot: 0.40,  yOff: 0.00 },
      { z: -6.2,  rx: 0.70,  ryTop: 0.62,  ryBot: 0.50,  yOff: 0.04, chine: 0.32 },
      { z: -4.4,  rx: 0.88,  ryTop: 0.66,  ryBot: 0.54,  yOff: 0.06, chine: 0.45 },
      { z: -2.2,  rx: 1.18,  ryTop: 0.68,  ryBot: 0.62,  yOff: 0.06, chine: 0.55, spine: 0.24 },
      { z:  0.6,  rx: 1.24,  ryTop: 0.68,  ryBot: 0.66,  yOff: 0.05, chine: 0.52, spine: 0.28 },
      { z:  3.4,  rx: 1.06,  ryTop: 0.64,  ryBot: 0.62,  yOff: 0.05, chine: 0.35, spine: 0.22 },
      { z:  5.6,  rx: 0.82,  ryTop: 0.60,  ryBot: 0.58,  yOff: 0.04, spine: 0.10 },
      { z:  6.7,  rx: 0.68,  ryTop: 0.64,  ryBot: 0.60,  yOff: 0.04 },
    ],
    f22: [
      { z: -10.4, rx: 0.015, ryTop: 0.015, ryBot: 0.015, yOff: -0.04 },
      { z: -9.6,  rx: 0.30,  ryTop: 0.20,  ryBot: 0.16,  yOff: -0.02, chine: 0.85 },
      { z: -8.1,  rx: 0.66,  ryTop: 0.42,  ryBot: 0.30,  yOff: 0.02,  chine: 0.92, bellyFlat: 0.75 },
      { z: -6.3,  rx: 0.96,  ryTop: 0.60,  ryBot: 0.42,  yOff: 0.06,  chine: 0.95, bellyFlat: 0.85 },
      { z: -4.2,  rx: 1.26,  ryTop: 0.68,  ryBot: 0.48,  yOff: 0.08,  chine: 0.90, bellyFlat: 0.85 },
      { z: -1.6,  rx: 1.82,  ryTop: 0.74,  ryBot: 0.52,  yOff: 0.08,  chine: 0.82, spine: 0.22, bellyFlat: 0.88 },
      { z:  1.4,  rx: 1.92,  ryTop: 0.74,  ryBot: 0.52,  yOff: 0.08,  chine: 0.78, spine: 0.20, bellyFlat: 0.88, twinSplit: 0.25 },
      { z:  4.4,  rx: 1.78,  ryTop: 0.68,  ryBot: 0.48,  yOff: 0.06,  chine: 0.72, bellyFlat: 0.80, twinSplit: 0.55 },
      { z:  6.7,  rx: 1.56,  ryTop: 0.56,  ryBot: 0.42,  yOff: 0.05,  chine: 0.65, twinSplit: 0.75 },
    ],
    fa18: [
      { z: -9.8,  rx: 0.015, ryTop: 0.015, ryBot: 0.015, yOff: -0.04 },
      { z: -9.0,  rx: 0.23,  ryTop: 0.21,  ryBot: 0.20,  yOff: -0.02 },
      { z: -7.6,  rx: 0.50,  ryTop: 0.46,  ryBot: 0.42,  yOff: 0.01 },
      { z: -5.8,  rx: 0.78,  ryTop: 0.64,  ryBot: 0.54,  yOff: 0.05 },
      { z: -3.6,  rx: 1.10,  ryTop: 0.72,  ryBot: 0.58,  yOff: 0.06, spine: 0.22 },
      { z: -1.0,  rx: 1.48,  ryTop: 0.74,  ryBot: 0.60,  yOff: 0.06, spine: 0.26, bellyFlat: 0.45 },
      { z:  2.0,  rx: 1.56,  ryTop: 0.72,  ryBot: 0.58,  yOff: 0.06, spine: 0.20, twinSplit: 0.35 },
      { z:  4.8,  rx: 1.44,  ryTop: 0.64,  ryBot: 0.54,  yOff: 0.05, twinSplit: 0.70 },
      { z:  6.7,  rx: 1.32,  ryTop: 0.58,  ryBot: 0.50,  yOff: 0.04, twinSplit: 0.85 },
    ],
    su57: [
      { z: -10.6, rx: 0.015, ryTop: 0.015, ryBot: 0.015, yOff: -0.06 },
      { z: -9.7,  rx: 0.32,  ryTop: 0.22,  ryBot: 0.16,  yOff: -0.04, chine: 0.88 },
      { z: -8.1,  rx: 0.72,  ryTop: 0.44,  ryBot: 0.30,  yOff: 0.02,  chine: 0.92, bellyFlat: 0.8 },
      { z: -6.0,  rx: 1.10,  ryTop: 0.62,  ryBot: 0.40,  yOff: 0.06,  chine: 0.95, bellyFlat: 0.85 },
      { z: -3.2,  rx: 1.65,  ryTop: 0.66,  ryBot: 0.44,  yOff: 0.06,  chine: 0.92, spine: 0.22, bellyFlat: 0.9 },
      { z:  0.2,  rx: 2.15,  ryTop: 0.66,  ryBot: 0.46,  yOff: 0.06,  chine: 0.85, spine: 0.18, bellyFlat: 0.9, twinSplit: 0.45 },
      { z:  3.6,  rx: 2.12,  ryTop: 0.62,  ryBot: 0.46,  yOff: 0.05,  chine: 0.75, bellyFlat: 0.85, twinSplit: 0.78 },
      { z:  6.7,  rx: 1.92,  ryTop: 0.56,  ryBot: 0.44,  yOff: 0.04,  twinSplit: 0.95 },
    ],
  };

  const fStations = fuselageProfiles[style] || fuselageProfiles.f22;
  const fuseGeo = createLoftedFuselage(fStations, 34);
  const fuseMesh = new THREE.Mesh(fuseGeo, hullMat);
  fuseMesh.castShadow = !isEnemy;
  fuseMesh.receiveShadow = !isEnemy;
  root.add(fuseMesh);

  // Separate darker dielectric nose radome cone cap (smoothly matching forward stations!)
  const radomeGeo = createLoftedFuselage(fStations.slice(0, 4), 28);
  radomeGeo.scale(1.012, 1.012, 1.0);
  const radomeMesh = new THREE.Mesh(radomeGeo, radomeMat);
  root.add(radomeMesh);

  // Matte charcoal anti-glare upper nose panel ahead of windscreen
  const agPrev = fStations[Math.min(1, fStations.length - 1)];
  const agSt = fStations[Math.min(2, fStations.length - 1)];
  const antiGlare = new THREE.Mesh(
    new THREE.CylinderGeometry(agPrev.rx * 0.42, agSt.rx * 0.50, Math.abs(agSt.z - agPrev.z) * 0.85, 14),
    darkMat
  );
  antiGlare.rotation.x = Math.PI / 2;
  antiGlare.scale.set(1.0, 1.0, 0.26);
  antiGlare.position.set(0, (agPrev.yOff + agPrev.ryTop + agSt.yOff + agSt.ryTop) * 0.5 - 0.08, (agPrev.z + agSt.z) * 0.5);
  root.add(antiGlare);

  // Needle nose pitot boom
  const noseZ = fStations[0].z;
  const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.032, 0.92, 8), nozzleMat);
  pitot.rotation.x = Math.PI / 2;
  pitot.position.set(0, -0.04, noseZ - 0.42);
  root.add(pitot);

  // Central rear ECM tailcone stinger (between twin engines on F-15/Su-57/F/A-18)
  if (isTwin) {
    const sting = new THREE.Mesh(new THREE.ConeGeometry(0.24, 2.2, 10), hullMat);
    sting.rotation.x = Math.PI / 2;
    sting.position.set(0, 0.05, 7.6);
    root.add(sting);
  }

  // 2) SCULPTED RECESSED SUPERSONIC AIR INTAKES (Zero boxy bricks!)
  const darkDuctMat = new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.92, metalness: 0.2 });
  if (style === 'f16') {
    // Iconic F-16C sculpted oval smiling chin intake scoop
    const chinStations = [
      { z: -4.95, rx: 0.56, ryTop: 0.24, ryBot: 0.30, yOff: -0.58, bellyFlat: 0.2 },
      { z: -4.35, rx: 0.62, ryTop: 0.30, ryBot: 0.34, yOff: -0.55, bellyFlat: 0.3 },
      { z: -2.0,  rx: 0.68, ryTop: 0.32, ryBot: 0.34, yOff: -0.48, bellyFlat: 0.4 },
      { z:  0.8,  rx: 0.52, ryTop: 0.24, ryBot: 0.24, yOff: -0.34 },
    ];
    const chinMesh = new THREE.Mesh(createLoftedFuselage(chinStations, 20), hullMat);
    chinMesh.castShadow = !isEnemy;
    root.add(chinMesh);
    const chinMouth = new THREE.Mesh(new THREE.CircleGeometry(0.46, 18), darkDuctMat);
    chinMouth.scale.set(1.12, 0.58, 1);
    chinMouth.rotation.y = Math.PI;
    chinMouth.position.set(0, -0.59, -4.96);
    root.add(chinMouth);
  } else {
    const iX = style === 'f15' ? 1.38 : (style === 'su57' ? 1.18 : 1.24);
    const iY = style === 'su57' ? -0.32 : (style === 'f15' ? 0.02 : -0.08);
    const iCant = (style === 'f22' || style === 'su57') ? 0.30 : (style === 'fa18' ? 0.16 : 0.04);
    [-1, 1].forEach((side) => {
      const iGroup = new THREE.Group();
      iGroup.position.set(side * iX, iY, 0);
      iGroup.rotation.z = side * iCant;

      // Sculpted aerodynamic intake cowl fairing tapering smoothly into fuselage
      const cowlStations = [
        { z: -4.15, rx: 0.44, ryTop: 0.40, ryBot: 0.34, yOff: 0.0, chine: 0.35 },
        { z: -3.20, rx: 0.49, ryTop: 0.44, ryBot: 0.38, yOff: 0.0, chine: 0.35 },
        { z: -0.60, rx: 0.52, ryTop: 0.44, ryBot: 0.38, yOff: 0.0, chine: 0.30 },
        { z:  2.80, rx: 0.38, ryTop: 0.36, ryBot: 0.30, yOff: 0.02 },
      ];
      const cowl = new THREE.Mesh(createLoftedFuselage(cowlStations, 16), hullMat);
      cowl.castShadow = !isEnemy;
      iGroup.add(cowl);

      // Slanted supersonic intake upper ramp lip (iconic F-15 / F-22 look!)
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.08, 0.65), hullMat);
      lip.position.set(0, 0.38, -4.32);
      lip.rotation.x = 0.16;
      iGroup.add(lip);

      // Dark recessed intake aperture
      const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 0.62), darkDuctMat);
      mouth.rotation.y = Math.PI;
      mouth.position.set(0, 0.0, -4.16);
      iGroup.add(mouth);

      // Boundary-layer splitter plate
      const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.72, 1.05), darkMat);
      splitter.position.set(-side * 0.46, 0.02, -4.15);
      iGroup.add(splitter);

      root.add(iGroup);
    });
  }

  // 3) SCULPTED TEARDROP BUBBLE CANOPY + ACES II EJECTION SEAT + PILOT
  const canopyGroup = new THREE.Group();
  canopyGroup.position.set(0, 0.62, -4.25);

  // Raised metallic canopy sill fairing
  const sillGeo = new THREE.TorusGeometry(0.56, 0.055, 10, 24);
  sillGeo.rotateX(Math.PI / 2);
  sillGeo.scale(0.95, 1.0, 3.65);
  const sill = new THREE.Mesh(sillGeo, darkMat);
  sill.position.set(0, 0.02, 0.1);
  canopyGroup.add(sill);

  const cockpitTub = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.34, 3.5), darkDuctMat);
  cockpitTub.position.set(0, -0.06, 0.1);
  canopyGroup.add(cockpitTub);

  // Pilot + ACES II Ejection Seat (hidden in 1st-person cockpit view)
  const pilotGroup = new THREE.Group();
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.70, 0.22), darkMat);
  seatBack.position.set(0, 0.30, 0.62);
  seatBack.rotation.x = -0.22;
  pilotGroup.add(seatBack);
  // Yellow/black ejection pull handle on headrest
  const ejHandle = new THREE.Mesh(
    new THREE.TorusGeometry(0.065, 0.016, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xf2c220, roughness: 0.4 })
  );
  ejHandle.position.set(0, 0.64, 0.56);
  pilotGroup.add(ejHandle);

  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0xdce4ee, roughness: 0.22, metalness: 0.35 })
  );
  helmet.position.set(0, 0.42, 0.18);
  pilotGroup.add(helmet);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.228, 14, 10, 0, Math.PI, 0, Math.PI * 0.56),
    new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.08, metalness: 0.96, envMapIntensity: 1.8 })
  );
  visor.position.copy(helmet.position);
  visor.rotation.x = -0.35;
  visor.rotation.y = Math.PI;
  pilotGroup.add(visor);
  canopyGroup.add(pilotGroup);

  // Glowing green holographic HUD combiner glass & emerald MFD instrument screens
  const hudGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.28),
    new THREE.MeshBasicMaterial({ color: 0x4cff9f, transparent: true, opacity: 0.38, side: THREE.DoubleSide })
  );
  hudGlass.position.set(0, 0.42, -0.98);
  hudGlass.rotation.x = -0.48;
  canopyGroup.add(hudGlass);

  const glareshield = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.24), darkMat);
  glareshield.position.set(0, 0.26, -0.96);
  canopyGroup.add(glareshield);
  const mfdMat = new THREE.MeshBasicMaterial({ color: 0x2cff8f });
  [-0.14, 0.14].forEach((mx) => {
    const mfd = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.13), mfdMat);
    mfd.position.set(mx, 0.18, -0.84);
    mfd.rotation.x = -0.32;
    canopyGroup.add(mfd);
  });

  // Aerodynamic teardrop lofted canopy glass
  const canopyStations = [
    { z: -1.95, rx: 0.06, ryTop: 0.06, ryBot: 0.02, yOff: 0.02 },
    { z: -1.35, rx: 0.40, ryTop: 0.44, ryBot: 0.05, yOff: 0.02 },
    { z: -0.45, rx: 0.56, ryTop: 0.68, ryBot: 0.05, yOff: 0.02 },
    { z:  0.55, rx: 0.55, ryTop: 0.66, ryBot: 0.05, yOff: 0.02 },
    { z:  1.55, rx: 0.44, ryTop: 0.44, ryBot: 0.05, yOff: 0.02 },
    { z:  2.35, rx: 0.14, ryTop: 0.12, ryBot: 0.02, yOff: 0.02 },
  ];
  const bubbleMesh = new THREE.Mesh(createLoftedFuselage(canopyStations, 24), canopyMat);
  canopyGroup.add(bubbleMesh);

  // Sleek forward canopy arch frame (except frameless F-16 / F-22 bubble!)
  if (style === 'f15' || style === 'fa18' || style === 'su57') {
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.030, 10, 24, Math.PI), darkMat);
    bow.position.set(0, 0.06, -0.62);
    bow.scale.set(1.0, 1.18, 1.0);
    canopyGroup.add(bow);
  }
  root.add(canopyGroup);

  // 4) GENUINE NACA AIRFOIL LOFTED MAIN WINGS + ARTICULATED AILERONS
  const wingProfiles = {
    f15: [
      { x: 1.45, y: 0.26, zLead: -2.9, chord: 6.9, thick: 0.44 },
      { x: 3.40, y: 0.22, zLead: -1.1, chord: 4.9, thick: 0.30 },
      { x: 6.75, y: 0.14, zLead:  1.5, chord: 2.0, thick: 0.13 },
    ],
    f16: [
      { x: 0.95, y: 0.06, zLead: -2.4, chord: 5.5, thick: 0.36 },
      { x: 2.85, y: 0.04, zLead: -0.6, chord: 3.7, thick: 0.24 },
      { x: 5.35, y: 0.02, zLead:  1.5, chord: 1.5, thick: 0.11 },
    ],
    f22: [
      { x: 1.55, y: 0.08, zLead: -3.1, chord: 7.4, thick: 0.42 },
      { x: 4.10, y: 0.05, zLead: -0.8, chord: 4.6, thick: 0.26 },
      { x: 6.95, y: 0.01, zLead:  1.8, chord: 1.6, thick: 0.11 },
    ],
    fa18: [
      { x: 1.30, y: 0.10, zLead: -1.9, chord: 5.0, thick: 0.38 },
      { x: 3.70, y: 0.04, zLead: -0.6, chord: 3.5, thick: 0.25 },
      { x: 6.45, y: -0.02, zLead: 0.9, chord: 1.65, thick: 0.12 },
    ],
    su57: [
      { x: 1.75, y: 0.08, zLead: -3.5, chord: 8.0, thick: 0.42 },
      { x: 4.40, y: 0.04, zLead: -0.8, chord: 4.9, thick: 0.26 },
      { x: 7.25, y: 0.00, zLead:  2.0, chord: 1.7, thick: 0.11 },
    ],
  };
  const wSecs = wingProfiles[style] || wingProfiles.f22;
  const tipX = wSecs[wSecs.length - 1].x;
  const tipY = wSecs[wSecs.length - 1].y;
  const tipZ = wSecs[wSecs.length - 1].zLead + wSecs[wSecs.length - 1].chord * 0.45;

  const ailerons = [];
  [-1, 1].forEach((side) => {
    const wingGeo = createLoftedAirfoilWing(wSecs, side, 12);
    const wing = new THREE.Mesh(wingGeo, hullMat);
    wing.castShadow = !isEnemy;
    wing.receiveShadow = !isEnemy;
    root.add(wing);

    // Flush articulated aileron on trailing edge
    const ailPivot = new THREE.Group();
    const midSec = wSecs[1];
    ailPivot.position.set(side * (midSec.x + 1.0), midSec.y, midSec.zLead + midSec.chord - 0.35);
    const ailSecs = [
      { x: 0.0, y: 0, zLead: 0, chord: 0.62, thick: 0.12 },
      { x: 1.95, y: -0.04, zLead: 0.15, chord: 0.45, thick: 0.08 },
    ];
    const ailMesh = new THREE.Mesh(createLoftedAirfoilWing(ailSecs, side, 6), hullMat);
    ailPivot.add(ailMesh);
    root.add(ailPivot);
    ailerons.push({ pivot: ailPivot, side });

    // Wingtip Sidewinder launch rail on F-16 & F/A-18!
    if (style === 'f16' || style === 'fa18') {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.14, 2.35), darkMat);
      rail.position.set(side * (tipX + 0.06), tipY, tipZ);
      root.add(rail);
    }
  });

  // Sculpted Sweeping LEX / LERX Strakes (F/A-18, F-16, Su-57, F-22)
  if (style !== 'f15') {
    const lexSecs = style === 'fa18'
      ? [{ x: 0.65, y: 0.16, zLead: -6.2, chord: 4.8, thick: 0.18 }, { x: 1.55, y: 0.12, zLead: -3.2, chord: 2.2, thick: 0.10 }]
      : [{ x: 0.72, y: 0.12, zLead: -5.5, chord: 3.9, thick: 0.16 }, { x: 1.52, y: 0.08, zLead: -3.0, chord: 1.8, thick: 0.09 }];
    [-1, 1].forEach((side) => {
      const lex = new THREE.Mesh(createLoftedAirfoilWing(lexSecs, side, 8), hullMat);
      lex.castShadow = !isEnemy;
      root.add(lex);
    });
  }

  // 5) LOFTED ALL-MOVING HORIZONTAL STABILATORS (Articulated Pitch!)
  const elevators = [];
  [-1, 1].forEach((side) => {
    const elPivot = new THREE.Group();
    elPivot.position.set(side * (isTwin ? 1.38 : 0.78), 0.04, 5.55);
    const eSecs = [
      { x: 0.0,  y: 0.0, zLead: -1.15, chord: 2.65, thick: 0.18 },
      { x: 1.45, y: -0.02, zLead: -0.20, chord: 1.85, thick: 0.12 },
      { x: 2.68, y: -0.05, zLead:  0.65, chord: 0.95, thick: 0.07 },
    ];
    const eMesh = new THREE.Mesh(createLoftedAirfoilWing(eSecs, side, 8), hullMat);
    eMesh.castShadow = !isEnemy;
    elPivot.add(eMesh);
    root.add(elPivot);
    elevators.push({ pivot: elPivot, side });
  });

  // 6) LOFTED AIRFOIL VERTICAL TAIL FINS + ECM BULLET PODS + ARTICULATED RUDDERS
  const rudders = [];
  const finConfig = {
    f15:  { count: 2, x: 1.44, cant: 0.03, h: 3.35, z: 5.05, rootChord: 3.25, tipChord: 1.05, sweep: 1.65 },
    f16:  { count: 1, x: 0.0,  cant: 0.0,  h: 3.45, z: 4.90, rootChord: 3.45, tipChord: 1.00, sweep: 1.95 },
    f22:  { count: 2, x: 1.48, cant: 0.48, h: 2.95, z: 5.15, rootChord: 3.30, tipChord: 1.10, sweep: 1.75 },
    fa18: { count: 2, x: 1.26, cant: 0.34, h: 2.95, z: 4.75, rootChord: 3.05, tipChord: 1.00, sweep: 1.55 },
    su57: { count: 2, x: 1.72, cant: 0.48, h: 2.45, z: 5.35, rootChord: 3.15, tipChord: 1.15, sweep: 1.65 },
  }[style];

  const finSides = finConfig.count === 1 ? [0] : [-1, 1];
  for (const s of finSides) {
    const finGroup = new THREE.Group();
    finGroup.position.set(s * finConfig.x, 0.42, finConfig.z);
    finGroup.rotation.z = -s * finConfig.cant;

    const fSecs = [
      { y: 0.0,               zLead: -finConfig.rootChord * 0.5,                       chord: finConfig.rootChord, thick: 0.24 },
      { y: finConfig.h * 0.5, zLead: -finConfig.rootChord * 0.5 + finConfig.sweep * 0.5, chord: (finConfig.rootChord + finConfig.tipChord) * 0.5, thick: 0.16 },
      { y: finConfig.h,       zLead: -finConfig.rootChord * 0.5 + finConfig.sweep,       chord: finConfig.tipChord,  thick: 0.09 },
    ];
    const finMesh = new THREE.Mesh(createLoftedVerticalFin(fSecs, 10), tailMat);
    finMesh.castShadow = !isEnemy;
    finGroup.add(finMesh);

    // Sculpted ECM radar warning pod fairing on fin tip (iconic F-15E twin bullet pods!)
    if (style === 'f15' || style === 'fa18') {
      const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.92, 6, 10), hullMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(0, finConfig.h + 0.02, -finConfig.rootChord * 0.5 + finConfig.sweep + finConfig.tipChord * 0.45);
      finGroup.add(pod);
    }

    // Articulated rudder trailing tab
    const rudPivot = new THREE.Group();
    rudPivot.position.set(0, finConfig.h * 0.42, finConfig.rootChord * 0.48);
    const rudMesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, finConfig.h * 0.62, 0.42), hullMat);
    rudMesh.position.set(0, 0, 0.18);
    rudPivot.add(rudMesh);
    finGroup.add(rudPivot);
    rudders.push(rudPivot);

    root.add(finGroup);
  }

  // Twin ventral stability strakes under rear fuselage (iconic F-16C & Su-57 detail!)
  if (style === 'f16' || style === 'su57') {
    [-1, 1].forEach((side) => {
      const vFin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.58, 1.95), hullMat);
      vFin.position.set(side * 0.62, -0.58, 4.9);
      vFin.rotation.z = side * 0.35;
      root.add(vFin);
    });
  }

  // 7) 16-PETAL FEATHERED TITANIUM EXHAUST NOZZLES + HEAT-BLUED AFT ENGINE BAY + MACH PLUMES
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x261208,
    emissive: new THREE.Color(jetCfg.burnerColor[0], jetCfg.burnerColor[1], jetCfg.burnerColor[2]),
    emissiveIntensity: 0.8,
    roughness: 0.4,
  });
  const coreMaterials = [];
  const burnerMeshes = [];
  const nozzleCones = [];
  const nozzleOffsets = isTwin ? (style === 'su57' ? [-1.06, 1.06] : [-0.76, 0.76]) : [0];
  const nozzleRadius = isTwin ? 0.58 : 0.64;

  for (const nx of nozzleOffsets) {
    // Bare heat-blued titanium aft engine bay cowling leading into the nozzle
    const isRectNozzle = jetCfg.nozzleShape === 'rect';
    const aftBayGeo = isRectNozzle
      ? new THREE.BoxGeometry(1.18, 0.74, 1.35)
      : new THREE.CylinderGeometry(nozzleRadius * 1.12, nozzleRadius * 1.18, 1.42, 22);
    const aftBay = new THREE.Mesh(aftBayGeo, nozzleMat);
    if (!isRectNozzle) aftBay.rotation.x = Math.PI / 2;
    aftBay.position.set(nx, 0.04, 6.26);
    root.add(aftBay);

    const core = coreMaterials.length ? coreMat.clone() : coreMat;
    coreMaterials.push(core);
    const built = buildDetailedNozzle(jetCfg.nozzleShape, nozzleRadius, nozzleMat, darkMat, jetCfg, core);
    built.nGroup.position.set(nx, 0.04, 6.92);
    root.add(built.nGroup);
    burnerMeshes.push(...built.burnerMeshes);
    if (built.nozzleCone) nozzleCones.push(built.nozzleCone);
  }

  // Dynamic point light on player tail only (keeps total scene PointLights <= 2 for 150+ FPS!)
  let burnerLight = null;
  if (isPlayer) {
    burnerLight = new THREE.PointLight(
      new THREE.Color(jetCfg.burnerColor[0], jetCfg.burnerColor[1], jetCfg.burnerColor[2]),
      0, 28, 1.5
    );
    burnerLight.position.set(0, 0.6, 9.6);
    root.add(burnerLight);
  }

  // 8) DETAILED ORDNANCE (AIM-9X SIDEWINDERS, AIM-120 AMRAAMS + CENTERLINE DROP TANK)
  const missileVisuals = [];
  const pylonSpecs = style === 'f16'
    ? [
        { x: -tipX - 0.08, y: tipY, z: tipZ, type: 'aim9', wingtip: true },
        { x:  tipX + 0.08, y: tipY, z: tipZ, type: 'aim9', wingtip: true },
        { x: -3.25, y: -0.34, z: 1.15, type: 'aim120', wingtip: false },
        { x:  3.25, y: -0.34, z: 1.15, type: 'aim120', wingtip: false },
      ]
    : [
        { x: -4.45, y: -0.26, z: 1.35, type: 'aim9', wingtip: false },
        { x:  4.45, y: -0.26, z: 1.35, type: 'aim9', wingtip: false },
        { x: -2.85, y: -0.34, z: 0.75, type: 'aim120', wingtip: false },
        { x:  2.85, y: -0.34, z: 0.75, type: 'aim120', wingtip: false },
      ];

  const mBodyMat = new THREE.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.30, metalness: 0.25 });
  const mTipMat = new THREE.MeshStandardMaterial({ color: 0x1d2128, roughness: 0.35, metalness: 0.75 });
  const mBandYellow = new THREE.MeshBasicMaterial({ color: 0xf0c028 });
  const mBandBrown = new THREE.MeshBasicMaterial({ color: 0x7a4822 });

  pylonSpecs.forEach((ps) => {
    if (!ps.wingtip) {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.44, 1.75), hullMat);
      pylon.position.set(ps.x, ps.y + 0.24, ps.z);
      root.add(pylon);
    }

    const mGroup = new THREE.Group();
    mGroup.position.set(ps.x, ps.y - (ps.wingtip ? 0 : 0.14), ps.z);
    const len = ps.type === 'aim120' ? 3.35 : 2.85;
    const rad = ps.type === 'aim120' ? 0.088 : 0.074;

    const body = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10), mBodyMat);
    body.rotation.x = Math.PI / 2;
    mGroup.add(body);
    const noseCone = new THREE.Mesh(new THREE.ConeGeometry(rad, 0.38, 10), mTipMat);
    noseCone.rotation.x = -Math.PI / 2;
    noseCone.position.z = -len * 0.5 - 0.19;
    mGroup.add(noseCone);
    // Authentic yellow HE warhead stripe & brown rocket motor band!
    const yBand = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.03, rad * 1.03, 0.14, 10), mBandYellow);
    yBand.rotation.x = Math.PI / 2;
    yBand.position.z = -len * 0.28;
    mGroup.add(yBand);
    const bBand = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.03, rad * 1.03, 0.14, 10), mBandBrown);
    bBand.rotation.x = Math.PI / 2;
    bBand.position.z = len * 0.10;
    mGroup.add(bBand);

    // Cruciform rear + forward steering fins
    [len * 0.42, -len * 0.32].forEach((fz, fIdx) => {
      const span = fIdx === 0 ? 0.48 : 0.34;
      const fh = new THREE.Mesh(new THREE.BoxGeometry(span, 0.025, 0.32), mTipMat);
      fh.position.z = fz;
      mGroup.add(fh);
      const fv = new THREE.Mesh(new THREE.BoxGeometry(0.025, span, 0.32), mTipMat);
      fv.position.z = fz;
      mGroup.add(fv);
    });

    root.add(mGroup);
    missileVisuals.push(mGroup);
  });

  // Underbelly Centerline Fuel Drop Tank (like Reference Image #1's F-15E!)
  if (style === 'f15' || style === 'f16' || style === 'fa18') {
    const tankStations = [
      { z: -2.2, rx: 0.02, ryTop: 0.02, ryBot: 0.02, yOff: -0.92 },
      { z: -1.3, rx: 0.30, ryTop: 0.30, ryBot: 0.30, yOff: -0.92 },
      { z:  1.4, rx: 0.32, ryTop: 0.32, ryBot: 0.32, yOff: -0.92 },
      { z:  2.7, rx: 0.03, ryTop: 0.03, ryBot: 0.03, yOff: -0.92 },
    ];
    const tankMat = style === 'f15'
      ? new THREE.MeshStandardMaterial({ color: 0x8a7d4c, roughness: 0.45, metalness: 0.35 })
      : hullMat;
    const tank = new THREE.Mesh(createLoftedFuselage(tankStations, 16), tankMat);
    root.add(tank);
  }

  // Dorsal UHF blade antennas + spine aerial refueling slipway panel
  const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.38, 0.42), darkMat);
  blade1.position.set(0, 0.96, -1.35);
  blade1.rotation.x = -0.35;
  root.add(blade1);

  const refuelDoor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.06, 0.92), nozzleMat);
  refuelDoor.position.set(0, 0.72, -0.35);
  root.add(refuelDoor);
  const refuelSlot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.075, 0.42), darkMat);
  refuelSlot.position.set(0, 0.72, -0.35);
  root.add(refuelSlot);

  // 9) DETAILED RETRACTABLE TRICYCLE LANDING GEAR (Oleo Struts, Bay Doors, Alloy Rims & Taxi Light)
  const gearGroup = new THREE.Group();
  const strutMat = new THREE.MeshStandardMaterial({ color: 0xdce2e8, roughness: 0.25, metalness: 0.85 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xbac4ce, roughness: 0.25, metalness: 0.9 });
  [
    { x: 0, z: -5.45, h: 1.48, r: 0.30, nose: true },
    { x: -1.88, z: 1.55, h: 1.48, r: 0.42, nose: false },
    { x:  1.88, z: 1.55, h: 1.48, r: 0.42, nose: false },
  ].forEach((g) => {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.058, g.h, 10), strutMat);
    strut.position.set(g.x, -g.h * 0.5 - 0.14, g.z);
    gearGroup.add(strut);
    // Open landing gear bay door
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.56, 0.78), hullMat);
    door.position.set(g.x + (g.nose ? 0.24 : Math.sign(g.x) * 0.32), -0.45, g.z);
    gearGroup.add(door);
    // Rubber tire + metallic wheel hub
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(g.r, g.r, 0.24, 18), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(g.x, -g.h - 0.10, g.z);
    gearGroup.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(g.r * 0.52, g.r * 0.52, 0.26, 12), hubMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(wheel.position);
    gearGroup.add(hub);
    if (g.nose) {
      const taxiLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 8, 8),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.2) })
      );
      taxiLight.position.set(0, -0.95, g.z - 0.12);
      gearGroup.add(taxiLight);
    }
  });
  root.add(gearGroup);

  // Crisp wingtip navigation strobe lights
  const navRed = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 8, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.25, 0.25) })
  );
  navRed.position.set(-tipX, tipY + 0.04, tipZ);
  root.add(navRed);
  const navGreen = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 8, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 2.6, 0.55) })
  );
  navGreen.position.set(tipX, tipY + 0.04, tipZ);
  root.add(navGreen);

  // Tactical Formation "Slime Lights" (electroluminescent green strips on nose flanks & vertical fins)
  if (!isEnemy) {
    const slimeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.17, 0.41, 0.22) });
    [-1, 1].forEach((side) => {
      const noseSlime = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 1.35), slimeMat);
      noseSlime.position.set(side * 0.86, 0.14, -5.6);
      noseSlime.rotation.y = side * -0.06;
      root.add(noseSlime);
    });
    for (const s of finSides) {
      const finSlime = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.95, 0.06), slimeMat);
      const sx = s * finConfig.x + Math.sin(s * finConfig.cant) * (finConfig.h * 0.72);
      const sy = 0.42 + Math.cos(s * finConfig.cant) * (finConfig.h * 0.72);
      finSlime.position.set(sx, sy, finConfig.z + finConfig.sweep * 0.65);
      finSlime.rotation.z = -s * finConfig.cant;
      root.add(finSlime);
    }
  }

  // 20mm Vulcan Cannon 3D Muzzle Flash Star + Warm Illumination Light (Player only)
  let muzzleFlash = null;
  let muzzleLight = null;
  if (isPlayer) {
    muzzleFlash = new THREE.Group();
    const gunX = style === 'f15' ? 1.12 : (style === 'f16' ? -0.78 : 0.95);
    muzzleFlash.position.set(gunX, 0.25, -3.2);
    const flashMat = new THREE.MeshBasicMaterial({
      map: FLARE_STAR_TEX,
      color: new THREE.Color(4.5, 2.6, 0.85),
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let fi = 0; fi < 3; fi++) {
      const fp = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 2.45), flashMat);
      fp.rotation.x = Math.PI / 2;
      fp.rotation.y = (fi * Math.PI) / 3;
      muzzleFlash.add(fp);
    }
    muzzleFlash.visible = false;
    root.add(muzzleFlash);

    muzzleLight = new THREE.PointLight(0xffb44c, 0, 22, 1.6);
    muzzleLight.position.set(gunX, 0.45, -3.8);
    root.add(muzzleLight);
  }

  // Dual high-visibility anti-collision strobes (red dorsal + white ventral, zero extra PointLights!)
  const strobes = [];
  const makeStrobe = (yPos, zPos, hexCol, glowScale) => {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 8, 8),
      new THREE.MeshStandardMaterial({ color: hexCol, emissive: hexCol, emissiveIntensity: 0.02, roughness: 0.24 })
    );
    bulb.position.set(0, yPos, zPos);
    const glint = new THREE.Sprite(new THREE.SpriteMaterial({
      map: FLARE_STAR_TEX,
      color: new THREE.Color(hexCol).multiplyScalar(2.4),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    glint.scale.set(glowScale, glowScale, 1);
    bulb.add(glint);
    root.add(bulb);
    strobes.push(bulb);
  };
  makeStrobe(0.76, 1.85, 0xff2b22, 1.55);
  makeStrobe(-0.46, 0.65, 0xeef6ff, 1.45);

  // Transonic / High-G Prandtl-Glauert Vapor Cone (Player jet only)
  let vaporMat = null;
  let vaporCone = null;
  if (isPlayer) {
    vaporMat = createVaporConeMaterial();
    const vaporGeo = new THREE.ConeGeometry(4.15, 6.2, 36, 12, true);
    vaporGeo.rotateX(-Math.PI / 2);
    vaporCone = new THREE.Mesh(vaporGeo, vaporMat);
    vaporCone.position.set(0, 0.14, 0.55);
    vaporCone.visible = false;
    root.add(vaporCone);
  }

  // Wingtip positions for smooth continuous condensation ribbons
  const wingTips = [
    new THREE.Vector3(-tipX, tipY + 0.02, tipZ + 0.45),
    new THREE.Vector3(tipX, tipY + 0.02, tipZ + 0.45),
  ];

  return {
    root,
    pilotGroup,
    canopyGroup,
    ailerons,
    elevators,
    rudders,
    coreMat,
    coreMaterials,
    burnerMeshes,
    burnerLight,
    nozzleCones,
    strobes,
    vaporMat,
    vaporCone,
    muzzleFlash,
    muzzleLight,
    missileVisuals,
    gearGroup,
    wingTips,
  };
}
