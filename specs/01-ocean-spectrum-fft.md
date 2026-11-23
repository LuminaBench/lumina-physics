# 01 · Ocean spectrum and FFT cascades

Source: `modules/water/spectrum.ts`, `fft-gpu.ts`, `fft-cpu.ts`.

## Inputs

`windSpeed U₁₀ (m/s)`, `windDirection`, `fetch F (m)`, `swellHeight Hₛ (m)`,
`swellDirection`, `swellPeriod Tₛ (s)`, `chop λ`, `depth d (m)`, `seed`.

Intermediate WebGPU bands use a power-of-two grid with at least eight texels per
shortest retained wave, up to the preset limit. The finest band retains the full
resolution. The random phase depends on the signed wave index, so removing empty
outer bins preserves the populated Fourier coefficients and significant wave height.

## Directional spectrum

JONSWAP wind sea:

```
α   = 0.076 (U²/(F g))^0.22
ω_p = 22 (g² / (U F))^(1/3)
S(ω) = α g² ω⁻⁵ exp(−1.25 (ω_p/ω)⁴) · 3.3^r ,  r = exp(−(ω−ω_p)² / (2 σ² ω_p²)),  σ = 0.07 (ω ≤ ω_p) | 0.09
D(θ) = N(s) |cos((θ−θ_w)/2)|^(2s),   s = max(1.2, 14 (ω/ω_p)^(+5 | −2.5)),   N(s) = Γ(s+1) / (2√π Γ(s+½))
```

Swell: Gaussian in ω around `2π/Tₛ` (σ = 7.5 %), variance `(Hₛ/4)²`, spreading `s = 38`.

Dispersion `ω² = g k tanh(k d)`; wavenumber density
`Ψ(k) = S(ω) D(θ) (dω/dk) / k · exp(−(0.004 k)²)`.

## Cascades

Tile lengths `L_c = L₀ / ρᶜ`, `L₀ = clamp(4N − 3, 251, 1021)` m,
`ρ = min(0.115 N, {2: 9.1, 3: 7.93, 4: 6.07}[count])` (non-commensurate → no visible
repeat). Cascade `c` owns the exclusive band `k ∈ [8π/L_c, min(0.95 πN/L_c, 8π/L_{c+1}))`
(cascade 0 starts at 0), so no energy is counted twice.

## Initial spectrum

Grid index `(x, y)` ↔ `n = x − N/2`, `m = y − N/2`, `k = 2π(n, m)/L`, `Δk = 2π/L`.

```
h₀(k) = (ξ_r + i ξ_i)/√2 · √(Ψ(k) Δk² / 2)        ξ from hash(n, m, cascade, seed) via Box–Muller
texel  = (h₀(k), h₀(−k))                          4 floats
```

Two spectra A and B share the same ξ, so `mix(h₀A, h₀B, t)` is a valid live sea-state
morph (lagoon → swell) with no rebuild.

## Time evolution and packing

```
h(k,t) = h₀(k) e^{−iωt} + conj(h₀(−k)) e^{+iωt}       (component travels toward +k)
D̂x = i (k_x/k) h · λ ,  D̂z = i (k_z/k) h · λ
signal₁ = D̂x + i D̂z        → IFFT → Dx + i·Dz
signal₂ = h                 → IFFT → η + i·0
```

Evolution writes in bit-reversed order; `2·log₂N` radix-2 butterfly passes follow
(rows then columns): for half-size `H` at index `i`,
`out = top ? a + w·b : a − w·b`, `w = e^{+iπ (i mod H)/H}`, `top = (i mod 2H) < H`.
Because the origin sits at N/2 the result is multiplied by `(−1)^{x+y}`.

## Derived maps (assemble pass)

Central differences with texel `L/N`:

```
J      = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) − (∂Dx/∂z)(∂Dz/∂x)       Jacobian (< 1: surface folds)
slope  = (∂η/∂x / (1 + ∂Dx/∂x), ∂η/∂z / (1 + ∂Dz/∂z))
foam   = max(foam · e^{−0.35 dt}, clamp((bias − J) · 2.2))   bias = 0.42 + 0.36·whitecaps
```

Outputs: `displacement = (Dx, η, Dz)`, `derivatives = (slope.x, slope.z, J, foam)`.

## CPU twin

The central `≤ 64²` wavenumbers of each cascade are evaluated on the CPU from the same
`h₀`. `heightAt(x, z)` inverts the choppy displacement with two horizontal fixed-point iterations and one vertical lookup
(`p ← (x, z) − D_xz(p)`). On WebGL 2 the twin *is* the ocean (uploaded as half-float
textures when linear float filtering is unavailable, with slopes/Jacobian/foam updated each frame).

The two long-period bands interpolate displacement between analytical FFTs. Their time
interval is at most 1/15 s or 1/32 of the shortest wave period, whichever is smaller.
A change in blend, chop or spectrum immediately evaluates new endpoints. Hulls share the
same two inverse iterations across their sample points and accumulate only the horizontal or
vertical components required for that pass.

## Surface mesh and LOD

Camera-centred polar grid, ring radius `r_i = 0.4 · q^i` out to 42 km, alternate rings
offset half a segment. Vertex spacing `s(r) ≈ r (q − 1)`; cascade displacement fades
`1 − smoothstep(L/16, L/6, s)`, cascade normals fade with pixel footprint
`1 − smoothstep(1.5 t, 7 t, footprint)` (`t` = texel size), and the slope variance of the
faded cascades is added to GGX roughness (`α² += ½ Σ (1 − w_c) mss_c`) so glitter energy is
conserved at distance.
