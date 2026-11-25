# Improve an existing game

Start at the effect the player can see. For tire spray, follow one wheel from its contact query to the emitter and material. Record the crossing from the gameplay camera and keep the same speed, puddle and lighting for the comparison. Profile the frame with the effect active.

| Request | Where to make the change | What to verify |
| --- | --- | --- |
| Make a working effect look better | Tune its existing inputs. A spray fan can use the wheel’s local depth, rolling speed and lateral slip. | Compare the wet wheel with a dry wheel on the same axle. |
| Add a missing effect | Install the smallest matching module. Feed it the host’s coordinates, units and clock. | Check movement and the effect together, including spawn and unload. |
| Replace an effect | Keep its public trigger, saved settings and callers. Route the trigger to the replacement and disconnect the old emitter at the switch. | One trigger produces one effect, including after re-entering the level. |
| Change a landscape’s look | Adjust the relevant material, plant recipe or art direction. Retain seeds for objects the player must find again. | Restore the same save and check the landmarks from ground level and at distance. |

## Attach rain to a Three.js game

This example assumes an existing Three.js node-capable renderer, scene, camera and render loop. The skill includes a WebGPU implementation and a WebGL 2 backend for that renderer. In a classic WebGLRenderer project, use a CPU model or adapt a host material. Check the host’s installed Three.js version before changing dependencies.

From the installed skill directory, preview the files and dependencies, then install the module into the game.

```sh
node scripts/install-physics.mjs profile-rain --engine threejs --project /path/to/game --dry-run
node scripts/install-physics.mjs profile-rain --engine threejs --project /path/to/game
```

This helper belongs under the game’s `src/` directory. It attaches rain to the scene and camera supplied by the level.

```ts
import type { Camera, Scene } from 'three/webgpu';
import { attachWorldRain } from './lumina-physics';

export function createTrackRain(scene: Scene, camera: Camera) {
  return attachWorldRain(
    { profileVersion: 1, seed: 42, weather: 'squall', quality: 'medium' },
    { scene, camera },
  );
}
```

At level load, call `const rain = createTrackRain(scene, camera)`. Call `rain.update(dtSeconds)` from the existing frame loop and `rain.dispose()` at unload. When the storm clears, call `rain.patch({ weather: 'clear' })`. To replace existing rain, connect the game’s weather toggle to this attachment. Release the old rain mesh and its update callback once the replacement is working. Dispose resources owned by the old emitter and retain materials used by other effects.

## Update a project copy

After updating the global skill, run these commands from the skill directory. The first previews paths. The second refreshes the entries in the game’s manifest, including their dependencies and previously installed specs.

```sh
node scripts/install-physics.mjs --engine threejs --project /path/to/game --update --dry-run
node scripts/install-physics.mjs --engine threejs --project /path/to/game --update
```

An upstream-only change updates automatically. A game-only edit stays in the game. If both changed the same file, the command lists the conflict and exits with status 2 before writing the batch. Compare your copy with the incoming source. To use the incoming file, copy it into place and rerun the update. To keep a game edit or a manual merge, acknowledge that exact path from the manifest.

```sh
node scripts/install-physics.mjs --engine threejs --project /path/to/game --update --keep-local modules/weather/rain.ts
```

Repeat `--keep-local` for each reviewed file. An untracked collision requires moving or reconciling the host file first. To add a capability, pass its catalog ID in a separate install. Godot and Unity use the same update workflow with `--engine godot` or `--engine unity`. Use the game engine’s scene lifecycle to connect and disconnect the starter components.
