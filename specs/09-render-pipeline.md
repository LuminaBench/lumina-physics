# 09 · Render pipeline

Source: `engine/pipeline.ts`, `engine/frame.ts`, `engine/ssr.ts`.

```
off-screen (before the scene pass)
   ├─ atmosphere LUT 256×128
   ├─ cloud shadow map 256² over 24 km (every 4th frame)
   ├─ cloud buffer: ½-res raymarch, direction-reprojected history (α = 0.14), 12 % overscan
   └─ reflection environment (every 2nd frame)
scene pass  ── MRT: output (RGBA16F HDR) · normal (view space) · velocity (NDC delta) · depth
   │   internal scale = min(tier scale, pixel budget) ; < 1 → TAAU, else TRAA
   ├─ GTAO(depth, normal) @ ½ res   colour × mix(1, ao, 0.8)     temporally filtered
   ├─ TRAA | TAAU(colour, depth, velocity)   Halton jitter, neighbourhood clamp
   ├─ trauma fringe (radial RGB split) + additive HDR flash
   ├─ bloom(threshold = 1.15 scene units)                         only HDR highlights bloom
   ├─ AgX tone map + sRGB, look: saturation 1.16, contrast 1.14 about mid grey
   └─ sharpen (0.18–0.35 by tier)
```

Rules that keep it artefact-free:

1. **Vertex-animated geometry supplies its own motion vector.**
   `velocity = NDC(viewProj · P) − NDC(prevViewProj · P_prev)` with unjittered matrices
   (`screenVelocity`). The built-in node only knows object matrices.
2. **Auxiliary MRT attachments must use the material's blend mode**
   (`mrt.setBlendMode(name, new BlendMode(MaterialBlending))`). Blended sprites output
   `vec4(0)` there, leaving normals and motion vectors intact; otherwise every soft
   particle stamps a rectangle into GTAO and TRAA.
3. **Reflective surfaces trace their own SSR** in the transparent pass and mix the hit
   over the environment reflection (occlusion is correct; no extra G-buffer).
4. **Refraction of already-drawn transparents** (shockwaves, heat haze) samples
   `viewportTexture`, not the shared opaque copy, or water disappears behind the lens.
5. **`smoothstep` with reversed edges is undefined** in GLSL / WGSL; the TSL shim replaces
   it with an explicit Hermite so `smoothstep(1, 0, x)` falloffs are portable.
6. Raymarch jitter = per-pixel white noise + golden-ratio sequence (grain, never hatching).
7. **Clouds never march at full resolution.** The cloud buffer is looked up by view
   direction through its own (overscanned) view-projection matrix, so TRAA jitter, camera
   shake and panning cannot disturb the accumulated history; a camera cut (> 60° or > 400 m
   in one frame) resets it.
8. **Camera first, then matrices.** Rigs place the camera after physics and before the
   reprojection matrices are captured; camera shake is applied after the rig and undone at
   the start of the next frame so it never feeds back into orbit controllers.
9. **Effects that appear mid-game are pre-warmed** (`engine.prewarm`): drawn for a few
   frames far below the world so their pipelines exist before the first blast or strike.

Camera trauma: `shake = trauma² + 0.06·rumble`; rotation ±0.055 rad, offset ±0.55 m at 22 Hz
three-sine noise; decay 1.1/s; blast trauma `(38·yield/(d + 12))^1.25`.

## Additions in 1.0

**GPU time without timestamp queries.** `gpuMs` = delay between the end of render submission
and `queue.onSubmittedWorkDone()`. It includes a few milliseconds of process latency, so the
headroom `1 − gpuMs / 16.67` is conservative; when the GPU saturates the delay grows past
one frame before any vsync is missed, which is exactly the early warning a controller needs.

**Dynamic resolution** (`engine/drs.ts`). The canvas stays at display resolution; only the
scene pass scale `s ∈ [0.55, 1]` moves and TAAU reconstructs the output (a render-target
resize, never a graph rebuild).

```
load = gpuMs / budget
down: load > 0.93 (or > 10 % missed vsyncs) for 0.2 s → s ← max(0.8, √(0.76 / load)) · s
up:   load · ((s + 0.05)/s)² < 0.82 for 1.2 s        → s ← s + 0.05
```

Quantised to 0.05, 0.4 s between changes. Without a GPU time (WebGL 2) only missed frames
are visible: upward steps are probed with exponential back-off and capped at the static
pixel budget.

**Soft particle layer.** Mist, smoke, dust and fire sprites render off-screen at half the
internal resolution into one RGBA16F target (no normal / velocity attachments), depth-test
in the fragment stage against the scene depth and are composited as premultiplied colour
`lit ← lit·(1 − a) + rgb`. Emissive sprites blend `(SrcAlpha, One)` in colour and
`(Zero, One)` in alpha so fire adds light without adding coverage. Sprite noise comes from
one tap of a baked tileable texture instead of per-fragment hashing. Together: ~12× less
blend bandwidth, and a depth-charge geyser on Ultra costs 1 ms instead of 14 ms.

**Effect hooks** (`pipeline.addEffect`). `scene(input)` runs before the temporal resolve at
internal resolution with depth; `distort(uv, ndc)` offsets the resolve read; `lens(color)`
runs after it. All three are inlined into existing quad passes. Quad passes address
textures with v = 0 at the top on WebGPU and at the bottom on WebGL 2 render targets, so
effects receive NDC (y up) and `toNdc` / `toUv` instead of assuming a row order.

**Light shafts.** March N (6–16) steps from the pixel toward the sun's screen position:

```
lit   = Σ wᵢ · [depthᵢ at infinity] · cloudTransmittanceᵢ² / Σ wᵢ ,  wᵢ = 0.95ⁱ
shaft = sunColor · lit · e^{−2.6 d} · (0.06 + 0.94 (1 − e^{−z / 260 m})) · strength
```

`d` is the aspect-corrected screen distance to the sun; the last factor scales in-scattering
with the air in front of the surface, so near objects stay as silhouettes.

**Geometric specular anti-aliasing** (Tokuyoshi & Kaplanyan 2019):
`α² ← α² + min(2σ² (|∂N/∂x|² + |∂N/∂y|²), κ)` with σ² = 0.25, κ = 0.1–0.18, applied to the
ocean and the wet road on top of the cascade-variance roughness.

**Horizon.** The sky's base sinks into the same haze colour distant surfaces fade to, by the
fog factor reached at the geometric horizon `3.57 km · √h`: `sky ← mix(sky, haze,
e^{−max(dir.y, 0) / 0.05} · fogHorizon)`.


For a loading screen, stop the engine, add the scene, call `engine.warmSceneMaterials()`, then await `engine.pipeline.prepareScenePasses()` before `engine.start()`. Compilation uses the main and soft passes’ real render targets and MRT layouts. Some postprocessing, shadows and simulation setup still occur on the first frame. Use `await yieldToBrowser()` between large synchronous asset builds to let the browser dispatch input and paint.
