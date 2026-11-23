# Three.js adapter (WebGPU + TSL, WebGL 2 fallback)

Requirements: `three >= 0.187`, `@dimforge/rapier3d-compat >= 0.21`, a bundler that
understands TypeScript (Vite, esbuild, Rspack…), ES2022 (top-level await).

```sh
node scripts/install-physics.mjs --engine threejs --project /absolute/path/to/game            # everything
node scripts/install-physics.mjs --engine threejs ocean weather --project /absolute/path/to/game
```

Files land in `<project>/src/lumina-physics/` (override with `--dest`). The game owns the
copy; re-running the installer reports files you have edited instead of overwriting them.

```ts
import { createLuminaWorld, BuoyantBody, Explosions } from './lumina-physics';

const { engine, weather, ocean, fx } = await createLuminaWorld({
  canvas: document.querySelector('canvas')!,
  tier: 'high',            // 'low' | 'medium' | 'high' | 'xhigh' | 'ultra' | 'auto'
  weather: 'tropical',
  ocean: 'breeze',
});
engine.camera.position.set(0, 6, 20);
engine.camera.lookAt(0, 0, 0);
engine.start();

// Live tuning – no rebuilds:
weather.params.sunElevation = 12;
ocean!.targetParams.windSpeed = 20; ocean!.rebuildSpectrum(1); ocean!.morph = 1;
engine.setQuality('ultra');
```

Rules of the road:

- Render through `engine.pipeline` (already wired). Do **not** add `EffectComposer`,
  `ShaderMaterial` or `onBeforeCompile`; write materials with node materials + TSL.
- Custom vertex-animated materials must set
  `material.mrtNode = auxSurface(normalView, screenVelocity(positionWorld, previousWorldPosition))`;
  blended sprites use `auxPassthrough()`.
- Per-frame order: `engine.onUpdate` (your game + queue field sources + `ocean.updateField`)
  → fixed-step physics (bound objects get interpolated poses) → `engine.onBeforeRender`
  (place the camera here) → modules → render. Read poses from the bound `Object3D`.
- Buoyancy / gameplay read the sea with `ocean.heightAt(x, z)`; effects write to it with
  `ocean.field.addSource({ x, z, radius, push | impulse, foam })`.
- Events: subscribe with `engine.events.on('explosion', listener)` and call the returned function to unsubscribe.
  Without either the bridge is a silent no-op.
- `tier: 'high'` is the safe default; `await engine.calibrateTier(58)` picks the best tier
  for the player's window by measuring frame pacing.
