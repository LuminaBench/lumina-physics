/**
 * Kajiya–Kay dual-lobe anisotropic strand shading (TSL).
 *
 * Implements cylindrical fiber diffuse (`sin(T, L)`), shifted-cuticle primary and secondary
 * anisotropic specular lobes (`pow(sin(T_shifted, H), exp)`), hemisphere sky ambient with
 * root-to-tip ambient occlusion, and backlit sun translucency. Integrates cleanly with
 * Lumina's HDR sun/sky uniforms (`frame`) and MRT normal/velocity buffers (`auxSurface`).
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame, auxSurface, screenVelocity } from '../../engine/frame';
import type { KajiyaKayLook, StrandKind } from './types';

const {
  Fn, vec3, vec4, float, normalize, dot, max, min, pow, sqrt, mix, cameraPosition, cameraViewMatrix, uniform, sin,
} = TSL;

/**
 * Shift a strand tangent along the surface normal (Marschner / Kajiya–Kay cuticle shift).
 */
export const shiftTangent = Fn(([T, Nrm, shift]: N[]) => {
  return normalize(T.add(Nrm.mul(shift)));
});

/**
 * Kajiya–Kay anisotropic specular lobe: `pow(sqrt(max(0, 1 - (T·H)²)), exponent)`.
 */
export const kajiyaKaySpecular = Fn(([T, V, L, exponent]: N[]) => {
  const H = normalize(L.add(V));
  const dotTH = dot(T, H);
  const sinTH = sqrt(max(float(0), float(1).sub(dotTH.mul(dotTH))));
  const dirAtten = max(float(0), dotTH.add(1.0)).min(1.0);
  return dirAtten.mul(pow(sinTH, exponent));
});

export interface KajiyaKayInputs {
  worldPos: N;
  previousWorldPos: N;
  tangent: N;
  normal: N;
  /** 0 at root, 1 at tip. */
  strandT: N;
  /** -1..+1 across ribbon width. */
  side: N;
  /** Per-strand random tint 0..1. */
  tint: N;
  /** Per-strand random seed 0..1. */
  seed: N;
  kind: StrandKind;
  look: KajiyaKayLook;
}

/**
 * Build a custom-lit Kajiya–Kay `MeshBasicNodeMaterial` driven by the strand solver nodes.
 */
export function createKajiyaKayMaterial(inputs: KajiyaKayInputs): THREE.MeshBasicNodeMaterial {
  const { look, kind } = inputs;
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.DoubleSide;

  const rootCol = new THREE.Color(look.rootColor);
  const tipCol = new THREE.Color(look.tipColor);
  const varCol = new THREE.Color(look.variationColor ?? look.tipColor);
  const specCol = new THREE.Color(look.specularColor ?? 0xfff8ec);

  const uRoot = uniform(rootCol);
  const uTip = uniform(tipCol);
  const uVar = uniform(varCol);
  const uSpec = uniform(specCol);

  const primaryShift = float(look.primaryShift ?? (kind === 'hair' ? -0.14 : -0.08));
  const secondaryShift = float(look.secondaryShift ?? (kind === 'hair' ? 0.16 : 0.12));
  const primaryExp = float(look.primaryExponent ?? (kind === 'hair' ? 110 : kind === 'kelp' ? 42 : 34));
  const secondaryExp = float(look.secondaryExponent ?? (kind === 'hair' ? 32 : 16));
  const primaryInt = float(look.primaryIntensity ?? (kind === 'hair' ? 0.55 : kind === 'kelp' ? 0.38 : 0.24));
  const secondaryInt = float(look.secondaryIntensity ?? (kind === 'hair' ? 0.32 : 0.18));
  const translucency = float(look.translucency ?? (kind === 'grass' ? 0.65 : kind === 'kelp' ? 0.72 : 0.35));
  const rootAO = float(look.rootAO ?? (kind === 'grass' ? 0.24 : 0.32));

  // Vertex varyings into fragment stage.
  const vWorld = inputs.worldPos.toVarying('kkWorld');
  const vPrev = inputs.previousWorldPos.toVarying('kkPrev');
  const vTan = normalize(inputs.tangent).toVarying('kkTan');
  const vNorm = normalize(inputs.normal).toVarying('kkNorm');
  const vT = inputs.strandT.toVarying('kkT');
  const vSide = inputs.side.toVarying('kkSide');
  const vTint = inputs.tint.toVarying('kkTint');
  const vSeed = inputs.seed.toVarying('kkSeed');

  material.positionNode = inputs.worldPos;

  const shaded = Fn(() => {
    const T = normalize(vTan);
    const Nrm = normalize(vNorm);
    const V = normalize(cameraPosition.sub(vWorld));
    const L = normalize(frame.sunDirection);

    // Base root-to-tip gradient with subtle per-strand color variation.
    const grad = mix(uRoot, uTip, pow(vT.clamp(0, 1), float(0.85)));
    const albedo = mix(grad, grad.mul(uVar).mul(1.25), vTint.mul(0.32));

    // Kajiya–Kay cylindrical diffuse: sin(T, L) blended softly with wrap Lambertian.
    const dotTL = dot(T, L);
    const sinTL = sqrt(max(float(0), float(1).sub(dotTL.mul(dotTL))));
    const wrapN = max(float(0), dot(Nrm, L).mul(0.5).add(0.5));
    const kkDiffuse = mix(sinTL, wrapN, float(kind === 'grass' ? 0.38 : 0.22));

    // Cuticle shift noise breaks up uniform specular ribbons across neighbouring strands.
    const shiftJitter = sin(vSeed.mul(43.7).add(vT.mul(9.2))).mul(0.06);
    const T1 = shiftTangent(T, Nrm, primaryShift.add(shiftJitter));
    const T2 = shiftTangent(T, Nrm, secondaryShift.add(shiftJitter));

    // Dual anisotropic specular lobes (Kajiya–Kay).
    const spec1 = kajiyaKaySpecular(T1, V, L, primaryExp).mul(primaryInt);
    const spec2 = kajiyaKaySpecular(T2, V, L, secondaryExp).mul(secondaryInt);
    const specular = uSpec.mul(spec1).add(albedo.mul(spec2));

    // Back-lit subsurface transmission through sunlit grass blades, kelp fronds, and hair halos.
    const backDot = max(float(0), dot(V, L.negate()));
    const rimBack = pow(backDot, float(3.0)).mul(0.65).add(max(float(0), dot(Nrm.negate(), L)).mul(0.35));
    const transmitted = albedo.mul(rimBack).mul(translucency).mul(vT.mul(0.75).add(0.25));

    // Root-to-tip self-shadowing (ambient occlusion) + subtle center ridge shading across ribbon.
    const ao = mix(rootAO, float(1.0), pow(vT.clamp(0, 1), float(0.65)));
    const ribbonProfile = float(1.0).sub(vSide.mul(vSide).mul(0.14));

    const sunLit = frame.sunColor.mul(frame.sunVisibility);
    const direct = albedo.mul(kkDiffuse.div(Math.PI)).add(specular.mul(0.45)).add(transmitted.div(Math.PI)).mul(sunLit);

    // Hemispherical sky ambient (with cyan-green underwater attenuation feel for kelp).
    const skyMix = Nrm.y.mul(0.5).add(0.5).clamp(0, 1);
    const skyIrr = mix(frame.skyHorizon, frame.skyZenith, skyMix).mul(kind === 'kelp' ? 0.28 : 0.42);
    const ambient = albedo.mul(skyIrr);

    const color = direct.add(ambient).mul(ao).mul(ribbonProfile);
    return vec4(color, 1.0);
  })();

  material.colorNode = shaded;

  // View-space normal and screen velocity for TRAA/TAAU and GTAO.
  const viewNormal = normalize(cameraViewMatrix.mul(vec4(normalize(vNorm), 0)).xyz);
  material.mrtNode = auxSurface(viewNormal, screenVelocity(vWorld, vPrev));

  return material;
}

export { min as _min };
