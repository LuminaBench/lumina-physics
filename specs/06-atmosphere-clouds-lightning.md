# 06 · Atmosphere, volumetric clouds, lightning, rain

Source: `modules/weather/*`.

## Atmosphere (single scattering + cheap multiple scattering)

Planet 6360 km, top 6440 km. `β_R = (5.802, 13.558, 33.1)·10⁻⁶`, `H_R = 8000 m`;
`β_M = 3.996·10⁻⁶ · turbidity` (extinction ÷ 0.9), `H_M = 1200 m`, `g = 0.8`;
ozone `(0.65, 1.881, 0.085)·10⁻⁶` tent at 25 ± 15 km.

16 view steps with quadratic spacing `t_i = t_max (i/16)²`, 6 light steps. Each step is
integrated analytically:

```
w_i   = e^{−τ_view} (1 − e^{−σ Δt}) / σ           exact for a homogeneous slab
L    += E (β_R ρ_R P_R + β_M ρ_M P_M) e^{−0.45 τ_light} w_i  +  0.042 E (β_R ρ_R + β_M ρ_M) w_i
```

The `0.45` on the light-path optical depth and the isotropic term stand in for multiple
scattering: without them long horizon paths turn dim yellow instead of pale blue-white.
Baked when the sky or observer altitude changes into a 256×128 LUT (`u` = azimuth from sun / π, `v` = √(elevation/90°)).
A JS mirror supplies sun colour and hemisphere ambient without readback.

## Clouds

Tileable volumes baked on the CPU: 64³ Perlin–Worley + three Worley octaves, 32³ detail
Worley, 256² weather map (coverage, cell type, breakup). Earth curvature:
`altitude(t) = y₀ + d_y t + (1 − d_y²) t²/(2R)`.

```
w       = weather.r + 0.18 (weather.b − ½)
cov     = mix(0.88 smoothstep(0.74 − C, 1.2 − C, w), 1, smoothstep(0.72, 1, C))      C = coverage
topH    = mix(0.5, 1, max(0.7 weather.g + 0.3 C, storm))
grad    = smoothstep(0, 0.06, h) smoothstep(1, 0.7, h/topH)
covH    = cov · mix(1, 0.2, (h/topH)^0.75) + 0.35 storm smoothstep(0.72, 0.95, h) cov   (dome → anvil)
shape   = remap(PW, 0.42 (1 − lowFbm), 1) · grad
ρ       = remap(shape, 1 − covH, 1 − 0.45 covH)
ρ       = remap(ρ, erosion · mix(hf, 1 − hf, 4h), 1) · (½ρ + ½)        detail erosion
density = ρ · densityScale · mix(1, 2.4, storm)
```

Lighting per sample (extinction `0.024 /m`):

```
τ_L    = Σ density(q + sun·l_i) · step_i          l: 35 m start, step ×1.75
beer   = e^{−τ} + 0.30 e^{−0.42 τ} + 0.10 e^{−0.15 τ}
powder = 0.45 + 0.55 (1 − e^{−2.6 ρ})
phase  = 4π [mix(HG(0.78), HG(−0.22), 0.42) + 0.035 HG(0.965)]     silver lining
L_sun  = E_sun · beer · powder · (0.2 phase + 0.085)
L_amb  = sky(h) × height and optical-depth attenuation × storm-base attenuation
L_flash= flashColor · e^{−r/1900} / (1 + (r/900)²)
```

Thin backlit edges receive warm forward scattering. The world field clears the aircraft path and rolls condensate into its rim.

Energy-conserving accumulation, early-out below 1.5 % transmittance, aerial perspective
from the transmittance-weighted mean distance.

**Cloud buffer.** Volumetric tiers march off-screen at the tier’s cloud scale (Low uses an analytic sky) with a 12 %
overscan, jittered by a per-pixel hash + golden-ratio sequence, and blended with history:

```
dir     = unproject(uv) − camera                       (buffer's own view-projection)
prevUV  = project_prev(camera + estimated_layer_distance · dir)
history confidence fades over four edge texels and rejects points behind the previous camera
```

The sky dome looks the buffer up by direction. This removes ~85 % of the cloud cost and
the grain that full-resolution jittered marching shows during fast pans.

**Cloud shadow map.** Three density taps along the sun ray through the lower deck →
`max(e^{−0.16 τ}, 0.07)`, baked every 4th frame into a 256² top-down map covering 24 km
around the camera. `cloudShadow(p)` is one bilinear tap; it is applied to the sun light's
colour node so every lit material receives drifting cloud shadows for free.

## Lightning

Leader: midpoint displacement (`levels = log₂(len/6) + 2`, offset `0.2·len`, ×0.52 per
level, vertical ×0.35). Forks: probability per segment, length 25–70 % of the remaining
path, power 30–55 % of the parent, depth 3. Rendered as camera-facing ribbons: opaque HDR
core (visible to SSR) + additive glow. 2–4 return strokes 45–135 ms apart, each
`e^{−t/50 ms}`. A strike sets the cloud flash position/colour, a point light
(`I = 3 d²`), a screen flash and boosts the ambient uniforms; `lightning-crack` and
`thunder` are emitted with delay `d / 343 s`.

## Rain

Closed form in the vertex shader (no buffers): streak `i` sits at
`wrap(seed_i·box + (drift_x, −fall_i t, drift_z))` in a 70×40×70 m camera box, `fall`
7.5–11.5 m/s, horizontal drift integrated on the CPU from the wind field, length
`0.03 |v|`, width `5.5 mm + 0.85 mm/m`.

## Two moving cloud decks in Three.js

Use `new Weather(engine, { upperClouds: CLOUD_LAYERS.highBank })` for a broken lower deck beneath taller formations. The ordinary constructor renders one deck. The optional second deck has its own `base` and `top` in world metres, horizontal `windX` and `windZ` in m/s, `coverage` and `storm` in 0–1, `density` and horizontal size multiplier `scale`. Mutate `weather.upperClouds` to transition live. When the lower top rises into the upper layer, only the part of the upper deck above that top contributes. Zero coverage clears a deck.

Both layers use the same sun, fire bounce and world-space wake fields. Sky and reflections composite scattered light in viewing order. High tiers divide the ray samples between decks when looking through both. Low projects each deck analytically. Each shadow attenuates the light reaching the ground. Volumetric history uses the scattering-weighted distance to reproject nearby clouds as the camera moves. The space between the two decks stays clear and aircraft stop publishing wake capsules there.

For small hot-climate clouds start with `WEATHER_PRESETS.hotFair`, then adjust horizontal `cloudScale`, vertical depth and sky coverage separately. For a rain front combine the `storm` weather preset with `CLOUD_LAYERS.rainBank`. Use `weather.sampleCloudDensity(point)` for undisturbed local condensate in either layer and sample the world field for the current cavity strength.

Use `weather.sampleCloudDensity(position)` for undisturbed CPU condensate. In a material, `weather.cloudDensityNode(worldPosition)` samples the deck at that altitude including active cavities. Pass `false` as the second argument for the original density.

Set `weather.params.convection` or `weather.upperClouds.convection` to bias vertical development from −1 (shallow cloudlets) to +1 (towers). Zero preserves the weather-map profile. Coverage controls the extent of the banks separately. The draw, reflection and CPU density paths share this control. The volumetric light march concentrates its existing samples along the sunward path to the top of the deck, within the horizontal scale of a cell.

When flying above the lower cloud deck, opaque terrain and water receive the intervening cloud radiance. Objects between the camera and the cloud top stay clear. A surface entering the deck uses a column-weighted estimate of optical depth.


## Twilight and clear nights

Use `WEATHER_PRESETS.goldenHour`, `blueHour` or `clearNight` for a starting exposure and cloud deck. Animate `sunElevation` through zero for a continuous sunset. The sky-view LUT and CPU hemisphere lighting include a bounded multiple-scattering approximation for the pink antisolar arch and blue Earth shadow. The sky and reflection environment use the same angular pattern. Its strongest direction faces away from the sun. [US National Weather Service](https://www.weather.gov/owlie/weird-weather)

Set `weather.params.moonlight` to 0–1 and `weather.moonDirection` to a unit vector in world coordinates. The default is a fixed moon with unit brightness. Below the horizon, sunlight fades and the directional light and shadow map can illuminate opaque geometry from the lunar direction. The sky and environment share cloud-attenuated lunar radiance, with a broader disc in the lower-resolution reflection map. A calendar-driven game can supply a lunar orbital direction and choose a phase below.

## Lunar phase

Set `weather.moonDirection` to a world-space unit vector and choose `params.moonIllumination = 'fromDirections'` when the game provides both celestial directions. The illuminated fraction is half of one minus their dot product. For art direction, supply a fraction from 0 (new moon) to 1 (full moon). The visible crescent faces the sun. The environment map filters the disc by illuminated area so a narrow crescent does not sparkle or vanish between texels. The same fraction drives the HDR sky fill and the directional light on opaque objects. `moonlight` is a separate overall intensity. The default illuminated fraction is 1.

### Sunlight from a game clock

The Three.js `weather` install exports `setSolarTime`. It writes the sun's geometric elevation and azimuth into an existing parameter object. Call it after blending weather presets and before the weather update. The same input lights terrain, cloud decks, sea and road reflections. The renderer controls twilight scattering and exposure.

```ts
const clock = { latitudeDeg: 51.5, dayOfYear: 172, solarHour: 19 };
setSolarTime(weather.params, clock);
```

Use apparent solar hours, with noon at 12. Day 1 is January 1. Hours can roll past midnight or run backward and the season follows. `daysInYear` accepts 365 or 366. World north defaults to −Z, with east at +X. To rotate the map, supply `northAzimuthDeg` measured from +X toward +Z. A host with civil timestamps, longitude and time zones must first convert its wall clock to apparent solar time. Polar day and night follow from latitude and season. The moon has its own direction and phase. [NOAA solar position equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF)

For a reproducible road comparison, use latitude 33° north, day 270, map north at 20°, and solar times 17:43, 18:12 and 20:00. Keep the camera and exposure fixed. Aiming toward the setting sun shows its narrow reflection in a smooth puddle, followed by the reflected sky and headlamps.

### Sunlight above the horizon shadow

The Three.js sky calculates direct RGB irradiance through Rayleigh, aerosol and ozone extinction at ground level and at 2, 6 and 12 km. Clouds on both rendering paths, reflected cloud banks, aircraft trails and sunlit opaque materials interpolate this profile at their own elevation. The curved planetary horizon cuts off direct light where the sun is hidden. Upper air uses the 12 km colour above the last sample. Turbidity and solar elevation drive the colour. The profile updates when lighting inputs change and adds no atmospheric raymarch per fragment.

For coastal twilight, start with a solar elevation between −2° and 0°, use a low deck around 1–2 km, and leave gaps below an upper bank around 5–7 km. Lower the sun further to move Earth's shadow up through the upper deck. Camera exposure controls the displayed brightness. The clouds and trails sample the same lighting that reaches reflected clouds on water.

### Cloud history in motion

The volumetric tiers rebuild view rays from camera rotation and reproject the distance where the cloud scattered most light. Each deck contributes its own wind displacement. Groups of four neighbouring rays sample different depths within a march interval. History accumulates half-path transmission before reconstructing the full optical path. This reduces the bright, speckled bias where a sparse ray grazes a cloud edge. A newly cut shot briefly filters neighbouring cloud texels while its own samples accumulate. Inside a deck, each occupied view sample still resolves carved density. Two sunward samples estimate the broader shadow, which neighbouring points reuse for up to 50 m while their density stays within 0.16 of the last lighting sample.

For a game-controlled camera cut, call `weather.resetCloudHistory()` before the next update. The renderer also detects long teleports, abrupt changes in the sun and large edits to the cloud field. Slow transitions preserve history. The reflection map reuses visible cloud radiance inside the camera's overscan and crossfades to its independent spherical march at the view boundary. Wet roads, ocean and PBR lighting consume the same map. Low continues to use its analytic sky.

[Cloud motion, camera-cut and mirror checks](../qa/cloud-history.spec.ts)

### Cloud edges and condensate probes

Set `weather.params.cloudErosion` for the lower deck or `weather.upperClouds.erosion` for a second deck. Both accept 0–1 and default to 0.62. A low value preserves a continuous envelope. Increase it to cut small openings into the edges while keeping dense cores. Use coverage to choose where banks form, convection for their depth and erosion for the breakup of their boundaries.

Cells within a bank grow to different heights. The volumetric shader rotates and bends its detail coordinates within the parent cell using the existing noise volumes. Gameplay condensate probes, cloud carving and lens wetness use the same detailed shape. The analytic tier approximates the fringe with the existing 2D weather channels. [GPU and gameplay density checks](../qa/cloud-shape.spec.ts)


### What a flying camera sees at sunset

Set the camera height in metres above the sea-level datum. The direct solar spectrum at the eye uses that altitude, the sun elevation and turbidity. The dome clips each ray against the planetary limb. `weather.solarDiscVisibility` gives the fraction of the disc above that limb before cloud or terrain occlusion. A camera on a mountain can still see a warm sun after the coast below enters shadow.

Bind Weather to SunFx for the same horizon, cloud and geometry occlusion in flare and shafts. Analytic cloud samples use each aperture tap’s own view ray. The distant ocean rings converge to the sky’s airlight below the curved horizon on high flights. [Altitude and cloud checks](../qa/engine-out-sunset.spec.ts)
