# After the cloudburst

Run `npm run preview` from the checkout and open `/examples/dry-lake/`. The **Salt basin** link in the landscape field guide opens the same scene.

Roll the empty 29 kg cart across the pale crust. Add ballast and roll it again along the same 11.4 m route. The cart’s solid-wheel witness uses a fixed contact ellipse on each wheel. The case rack puts 56% of the ballast on the front axle. A game with pneumatic tires can supply its own contact area and loads. The route is guided, and its wheel heights, pitch and roll follow the changing ground.

**Ground view** takes you to the sole print. **Press boot** applies the peak heel, outer edge, forefoot and toe contacts in turn. Drag to orbit. **Waterline view** looks across a shallow brine patch toward the pump house. At solar hour 19.2, switch the **Pump-house light** off and on to see the doorway and its reflection separately against the sky. Open **Inspect the surface** to save and restore a survey. **Fresh crust** resets the live terrain and cart.

The local brine stage is maintained at +9 mm relative to the game datum. Terrain above the stage stays exposed. Pressed hollows below it can show the water surface. The regional rain catchment and salt dissolution in the larger development plan are future additions.

Change the host bed, cover and escarpments in [place.ts](place.ts). Adjust the crust strength, skin thickness, brine level, wheel loads and solar clock in [main.ts](main.ts). A game can install `salt-crust` on its own for the pressure response and surface shading. The example also uses the weather sky, finite terrain horizon, mineral facets and a local reflection probe. [Units and integration](../../specs/13-surface-deform.md#salt-plates-over-mud)

## Rain beyond the ridge

Open [the rain survey](./rain.html) or choose **Rain beyond the ridge** in the landscape field guide. The east and west showers release the same 36 mm/h. In the drier east column the drops evaporate in transit. The west column sends surviving rain onto a short cambered asphalt catchment with two worn wheel paths. Select a gauge to see the ruts at road level. Drag to look around.

**Advance one minute** moves the local rainfall and road drainage forward by 60 seconds. **Empty both roads** clears their stored water. Raise the east lower-air humidity and run the same comparison again. The gauges report incoming mm/h and a measured rut depth in mm. Each catchment uses its own ground-level gauge over a 5.2 × 18 m patch. The regional wash has a separate catchment planned. [Physical parameters and integration](../../specs/06-atmosphere-clouds-lightning.md#rain-shafts-and-virga)
