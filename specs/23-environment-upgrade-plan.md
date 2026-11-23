# Game environment upgrade plan

Build each response where a game supplies its physical inputs. A character controller owns its shoe contacts, a vehicle owns its wheels, and the lighting system owns the sun. All dimensions below use metres and seconds. Keep the Three.js WebGPU and WebGL 2 paths usable through the selective installer.

| Order | Work | Evidence to collect |
| --- | --- | --- |
| 1. Puddles under feet and wheels | Couple sole entry and rolling contact to depth-dependent, centimetre-scale ripples. Let those waves displace reflected sky, sunlight and the view of the submerged substrate. Accept contacts from game animation or a physics controller. | A planted foot settles, a narrow tire leaves a moving train, the pool edge stays dry, and the same track sampled at different frame rates produces the same response. Read the shader on both backends. |
| 2. Sun, materials and local reflections | Compare submerged paint, porous stone, shallow films and pooled water at overhead and grazing angles. Follow a bright object off screen into the reflection probe; test cloud occlusion at sunset. | Inspect each reflected silhouette and its roughness, horizon continuity, highlight clipping and stationary-camera shimmer. |
| 3. Coast and flowing water | Carry the local waterline and breaker energy into swash, foam deposition, beach damping and exposed sand. Keep the long tide and individual waves independently controllable. | Compare sheltered still water, periodic breakers and falling tide at the same beach. Check the gameplay height against the visible crest. |
| 4. Wind and character animation | Drive attached hair, cloth, grass and trees from the same gust. Keep roots on animated or rotated parents; handle fast motion, teleportation and transitions in visibility. | Check pinned roots, tip lag, preservation of length, recovery, and world-space gust direction on both solvers. |
| 5. Tires and airborne material | Derive dust, rubber smoke and water pickup from loaded contact, surface moisture and slip work. Carry hot rubber after a skid and let water cool it. | Compare standing burnout, sliding, coasting, airborne wheels and crossing a puddle. Inspect timing and ensure the particle cost stays bounded. |
| 6. Fire and explosion visuals | Couple visual fire, smoke, debris lighting and steam to local shelter, humidity, flow and visible surfaces. Keep distant effects legible under tier reductions. | Capture the same game event on wet and dry ground, from above and below the sun, and watch the complete decay. |
| 7. Integration and cost | Publish input units, update order, scene ownership and fallback costs in the catalog and skill. Profile cold startup, individual effects, and interacting systems. | Install into an empty game; run functional and shader checks, then the 1080p scene, tier and backend matrix. Record actual render scale and frame times. |

Use Rockstar's released imagery to choose camera angles for comparisons. A reproducible shader reference for this work is Lagarde's treatment of the two interfaces of wet surfaces. [Rockstar launch gallery](https://www.rockstargames.com/VI/launch-gallery) · [Physically based wet surfaces](https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/)

## Local verification

- Puddle contacts, transmitted pavement sampling and moving scalp roots have shader or solver readback coverage on WebGPU and WebGL 2 in [puddle-contact.spec.ts](../qa/puddle-contact.spec.ts). It covers foot contact, bicycle wheel sampling, normal and oblique views, and a head travelling with the wind.
- [surf-tread.spec.ts](../qa/surf-tread.spec.ts) checks the nearshore height against the shader, measures tread heating and cooling, and verifies that a submerged fire releases its remaining condensate at the surface. [terrain-weather.spec.ts](../qa/terrain-weather.spec.ts) checks coarse and fine material on adjacent dry and sprayed strips.
- The tire waterline and discontinuous wing-trail checks below cover two earlier gaps. Remaining comparisons include a bicycle crossing from dry ground onto a partial puddle, reflective objects passing behind the camera and uprooted vegetation. Re-run warm frame pacing and cold first-interaction measurements separately.

## Aircraft, twilight and contact detail

| Game situation | Implemented in the Three.js runtime | Acceptance check |
| --- | --- | --- |
| A jet turns out of humid air at dusk | Independent liquid-water and ice humidity, per-sample wing vapor, settling and crosswind drift, smooth burner response and a nozzle-axis exhaust volume | Compare a straight dry pass, a humid loaded turn, a throttle cut and an aircraft teleport. The old vapor ages where it was shed. |
| The sun sets behind the camera | An antisolar pink arch above the blue Earth shadow, reflected sky, an author-positioned moon and a moonless setting | At one coast compare golden hour, blue hour and full darkness. Check the water and a lit opaque mesh from the same camera. |
| A wheel enters standing water | A world-anchored road grid follows the crown, ruts and liquid level, with tighter near-contact SSR | Hold the camera near the axle. The visible tire crosses the liquid interface and its reflection meets it there. |
| A vehicle grazes a barrier or a wall sheds a chip | Contact orientation drives panel crush. Sliding motion spreads the dent. Small rest-space masonry and timber chips persist on released geometry | Compare a head-on dent to the same intensity side swipe, repair, then repeat. Mark an intact wall without releasing a body. |
| A game opens on dense coast scenery | Cached exact terrain gradients, browser yields between expensive construction phases, asynchronous compilation against the actual scene and soft passes | Measure fresh browser startup and longest main-thread tasks separately from sustained frame time. |

On the local Mac, the production Chromium matrix for this pass covered eight scenes, five tiers and both rendering backends at 1920 × 1080. All 80 cases passed, with 59.87–60.13 fps mean and a worst-case 95th-percentile frame interval of 16.8 ms. Low and Medium rendered internally at 0.65× and 0.75×. High through Ultra rendered at 1×. Across three fresh browser launches per build, the median longest main-thread task fell from 301 to 136 ms on the highway and from 377 to 185 ms in the lagoon.

## Flight, road water and night lighting

| Shipped locally | Reusable inputs and checks |
| --- | --- |
| Layered nozzle exhaust and separate vapor trails | The renderer integrates hot gas and cooler gas along the view ray. Each vapor sample keeps its release wind. A return to humid air starts a separate indexed strip. Check cutoff, crosswind and a moving emitter with [flight lighting](../qa/flight-light-impact.spec.ts) and [wake continuity](../qa/wheel-water.spec.ts). |
| Thin tire spray, tread carry and reverse wading | A rotating wet wheel lifts drops. A sliding contact displaces a lateral sheet. After release, a sampled return pulse disturbs the local surface. Use **Curbside puddle** and **Reverse through flood** in Storm Highway. |
| Wear and repair on moving parts | Feed contact position and sliding direction to a painted mesh or a single instance. Bind door liners and rigid trim to the crumple field. A released wall fragment can receive another chip on its newly exposed face. Check motion, colour, lighting normals and repair in [surface wear](../qa/surface-wear.spec.ts). |
| Lunar phase and night exposure | Set the sun and moon directions for a game clock, or author the illuminated fraction for a shot. Check the terminator faces the sun and verify quarter-moon reflected energy against full moon on both backends. |

On the development Mac, 30 production Chromium runs of jet flight, highway driving and active flood wading across five tiers and both render backends averaged 60.06–60.19 fps at 1920×1080 output. The 95th-percentile frame interval was 16.7–16.8 ms. Low used 0.65× internal scale, Medium 0.75× and High through Ultra 1×. These are steady-playback measurements.

The highway sideswipe and the chipped pier wall held 60.03–60.21 fps across 20 more runs at the same output size and tier scales. The worst 95th-percentile frame interval was 16.8 ms. In three fresh highway launches per build, the median time to the fourth rendered frame was 1.17 s with paint wear, up from 1.15 s. Prebinding the material kept the four measured sideswipe windows on each backend within 16.8 ms.

### Next integration work

- **Air changing around an old trail.** Follow a previously shed ice trail as wind carries it into drier air. Sample humidity along the old path at a reduced cadence and compare its evaporation with the current fixed maximum lifetime.
- **Wear on moving parts.** Compare dirt transfer between a scraped door and a painted post. Current marks follow the deformed mesh, while transferring the other surface’s pigment and grime remains separate work.
- **Ground and moving attachments.** Compare drying soleprints on stone with impressions on damp sand. Verify hair and clothing when a character mounts a moving vehicle or changes world origin.
- **Water on characters and props.** Use per-region immersion, drainage time and the material’s absorption to reconnect the wet line, glossy film and drips when an object leaves water. Compare cloth and painted metal at the same location and time.
- **Water entering shelter.** Follow gutter discharge and wheel-carried water across a drying rain shadow. Compare the moving wet edge against the existing sheltered rut before and after the rain stops.
- **Thin high cloud and dense storm interiors.** Compare ice-cloud veils with compact liquid-water towers under the same sun. Check whether a thin layer preserves the sharp solar disc and how much light reaches a lower bank. Interactive decks currently use one liquid-cloud scattering model. Guerrilla’s fly-through cloud work discusses the lighting and sampling problems encountered up close. [Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved)
- **Vehicle impact aftermath.** Make hanging trim swing on its fasteners after a fender strike. Use contact onset, rest transform and a bounded hinge constraint. Compare a scrape, a sharp jolt and a repaired car.
- **Snow and dust in vehicle lights.** Light the material already ejected from tires in the headlamp volume and test the same skid at midday, sunset and night.
- **Moving lights in road water.** Drive two cars past the same puddle at night. Follow a headlamp into and out of the reflected view, across a rough wet film and then a deep rut. Check the footprint and the handoff from on-screen reflections to nearby captured geometry. Frostbite describes how it reconciles direct light, local probes and screen-space reflections. [Frostbite lighting course, section 4](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/course-notes-moving-frostbite-to-pbr-v2.pdf)


### Local rain shelter and flight at sunset

- Register finite roofs for a street, garage or walkway. Cars and ordinary PBR materials use the same rain film. A flooded rut keeps its open-sky reflection beneath an overpass. Ground fires, thermal surfaces and metal props can stay dry while rain falls nearby. [Shelter and stacked-deck tests](../qa/rain-shelters.spec.ts)
- Supply the release orientation, wind and signed load of a wingtip. Ice trails retain the continuous flight history as sample spacing adapts to speed. Core heat outlasts the visible exhaust after a power cut. [Flight checks](../qa/flight-light-impact.spec.ts)
- High clouds, ice trails and aircraft receive the sunlight that reaches their altitude at dusk. The reflected environment uses the same deck lighting as the sky. [Renderer and authoring details](06-atmosphere-clouds-lightning.md#sunlight-above-the-horizon-shadow)
- Drive daylight from a host game clock with latitude, day of year and local solar hour. The weather install exposes the same function used by the calendar checks for both hemispheres, polar seasons, leap years and map rotation. [Game clock inputs](06-atmosphere-clouds-lightning.md#sunlight-from-a-game-clock)

This production Chromium run on the development Mac covered 100 cases at 1920 × 1080 output. The eight ordinary scenes across five tiers and both backends averaged 59.48–60.13 fps. The 20 runs with the high-altitude flight or the sheltered puddle active averaged 60.08–60.17 fps. The slowest 95th-percentile frame interval was 16.8 ms. Low used 0.65× internal resolution, Medium 0.75× and High through Ultra 1×.

In three fresh High/WebGPU launches per build, median time to ready changed from 1.221 to 1.287 seconds on the highway and from 1.338 to 1.405 seconds in flight. The median longest main-thread task was 146 ms on the highway in both builds and 242 vs. 251 ms in flight. After preparing the reflection materials during loading, the longest frame at first use of the underpass on WebGL 2 was 66.6 ms in one fresh page and 16.7 ms in a repeat. The other first-use samples for the underpass and high-altitude flight were at most 16.8 ms. The functional suite passed all 88 checks, including shader readbacks and interaction tests.

### Cloud motion and flight through changing air

In the held coastal shot, the RMS change in cloud transmission between frames dropped from 0.156–0.157 to 0.011. During the camera bank the RMS error against the higher-sample reference fell from about 0.112 to 0.060 on both renderers. The sky and its reflection now share the current visible bank, and the reflection continues to sample the environment behind the camera. [Camera and mirror checks](../qa/cloud-history.spec.ts)

Cloud erosion can be authored independently for each layer. Both renderers kept gameplay density within 0.005 of 512 shader samples per backend across two layers and both control extremes. The jet uses wind-relative airspeed, temperature and liquid-water humidity for the visible transonic cone. Ice begins forming behind a nozzle after a short mixing interval. [Density probes](../qa/cloud-shape.spec.ts) · [Flight inputs and checks](../qa/flight-light-impact.spec.ts)

The first 100-case 1080p run found two misses during active cloud carving. On this Mac the Ultra WebGPU tunnel averaged 58.76 fps and 17.9 ms of GPU time. After sharing sun-shadow estimates between nearby samples, it averaged 60.13 fps and 9.62 ms GPU time. All ten tunnel runs passed on the revised build. A fixed-camera in-cloud comparison showed a slightly brighter mist with the revised lighting.

Across the eight-scene matrix, twilight flight, active tunnel and sideswipe, the latest samples for 110 distinct scene/tier/backend combinations averaged 60.05–60.21 fps at 1920 × 1080 output. The highest 95th-percentile frame interval was 16.8 ms. Low and Medium rendered at 0.65× and 0.75× internally. High through Ultra used 1×. The final lighting retest covered all tunnel cases and the Ultra WebGPU lagoon and chaos scenes.

Rendered contacts now accept a triangle index for painted skinned and morphed props. In the animated-plate check, shader roughness at the scuff stayed at 0.407 through a pose change. The old location and repaired finish both measured 0.090. [Animated surface checks](../qa/surface-wear.spec.ts)

### Engine-out flight, sunset and sliding contacts

One aircraft now supports independently commanded engine outlets, cooling nozzle metal, separately released exhaust ice and a collective-rig fallback. A pressure pulse affects nearby world objects while the emitter measures undisturbed incoming air. At altitude the solar disc and its optics use the camera’s geometric horizon. Opaque terrain and local cloud still occlude the sun. [Flight and optics checks](../qa/engine-out-sunset.spec.ts)

Concrete, brick and wood accept a swept contact in material coordinates. A scrape can cross a rotating loose facet and retain the original groove after motion. The same eight slots hold individual chips or continuous strokes. [Surface contact checks](../qa/surface-wear.spec.ts)


In a fixed 79-frame lower-deck replay, nine pressure shells fell to one. With camera and exposure fixed, enabling lens optics added about 25 display levels around a clear solar disc. Inside a dense intervening bank the increase was 0.13 levels on both backends. The short sunward cloud segment uses the already measured local density before the first shadow tap. This preserves a little more contrast inside a bank without adding a texture fetch. On the local Mac, 20 dusk-flight and cloud-pass runs covered all five tiers and both backends at 1920 × 1080 output. After the near-cloud lighting and cosmetic wall changes, 18 follow-up runs covered all tunnel tiers plus the Low and Ultra dusk-flight and marked-concrete cases. Those follow-ups averaged 60.09–60.17 fps with a worst 95th-percentile interval of 16.8 ms. Low rendered at 0.65×, Medium at 0.75× and High through Ultra at 1×.


### Tire carryover and lower-bank contrast

Storm Highway samples loose sediment and rain film at each wheel. Its material uses the resulting water, soil and cleared-film map for roughness and colour. **Cross muddy shoulder** leaves one-sided prints on the next stretch of asphalt. **Curbside puddle** uses the same retained water for the tire mist and the wet print. Standalone contact, scroll-boundary and bicycle drying checks live in [tread-transfer.spec.ts](../qa/tread-transfer.spec.ts).

A near object inside a cloud receives light scattered by the short air column in front of it. The lower bank includes attenuation by an active upper deck, and the direct and multiply-scattered sunlight have different phase lobes. The glazing exposes the dark cockpit interior at normal incidence and reflects more of the bank at a grazing angle.
