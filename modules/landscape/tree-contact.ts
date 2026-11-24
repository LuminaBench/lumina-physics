import { Matrix4, Object3D, Vector3, Quaternion } from 'three/webgpu';
import type { AuthoredLandscape } from './authored';
import type { LuminaEngine } from '../../engine/engine';
import type { BotanicalGrove } from '../vegetation/grove';

/** Promote one seeded tree to a real contact body. The instanced render tree stays
 * the same species and variant throughout the fall and after a saved-game reload. */
export function promoteGroveTree(
  world: { land?: AuthoredLandscape; engine: LuminaEngine; foliage: { grove: BotanicalGrove } },
  id: string,
) {
  const { land, engine, foliage } = world,
    physics = engine.physics;
  if (!land || !physics) throw new Error('Tree promotion requires an authored landscape and physics');
  const initial = new Matrix4(),
    grove = foliage.grove;
  if (!grove.poseFor(id, initial)) throw new Error('Unknown tree instance ' + id);
  const object = new Object3D(),
    position = new Vector3(),
    rotation = new Quaternion(),
    scale = new Vector3();
  initial.decompose(position, rotation, scale);
  const tree = grove.nearest(position.x, position.z, undefined, true);
  if (!tree || tree.id !== id) throw new Error('Promote a canopy tree instance');
  const species = land.library.get('plant', tree.recipe),
    h = species.height * scale.y,
    r = Math.max(0.08, h * 0.034);
  const R = physics.RAPIER,
    already = land.earth.fallen.has(id),
    saved = land.earth.fallenMatrices.get(id);
  if (saved) new Matrix4().fromArray(saved).decompose(position, rotation, scale);
  const body = physics.world.createRigidBody(
    R.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z).setRotation(rotation),
  );
  const collider = physics.world.createCollider(
    R.ColliderDesc.capsule(Math.max(0.1, h * 0.41 - r), r)
      .setTranslation(0, h * 0.41, 0)
      .setDensity(610),
    body,
  );
  object.scale.copy(scale);
  physics.bind(body, object);
  physics.snap(body);
  let fallen = already,
    disposed = false;
  function impact(strength = 1) {
    if (disposed || fallen || strength < 0.55) return;
    fallen = true;
    land!.earth.fallen.add(id);
    body.setBodyType(R.RigidBodyType.Dynamic, true);
    body.setLinearDamping(0.26);
    body.setAngularDamping(0.7);
    body.setAngvel({ x: 0.4, y: 0.03, z: -1.15 }, true);
    body.setLinvel({ x: 0.65, y: 0.05, z: 0.18 }, true);
    land!.earth.fallenMatrices.set(id, new Array<number>(16).fill(0));
    object.updateMatrix();
    object.matrix.toArray(land!.earth.fallenMatrices.get(id)!);
    grove.refresh();
  }
  const releaseContact = physics.onContactForce(collider, 1200, (force) => impact(force / (h * 720)));
  const releaseBlast = physics.onBlast((point, radius, amount) => {
    const d = position.distanceTo(point);
    if (d < radius) impact((1 - d / radius) * amount * 0.068);
  });
  const tracker = engine.add({
    update() {
      if (!fallen || already || body.isSleeping()) return;
      object.updateMatrix();
      object.matrix.toArray(land!.earth.fallenMatrices.get(id)!);
      grove.refresh();
    },
  });
  return {
    id,
    body,
    impact,
    get fallen() {
      return fallen;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      engine.remove(tracker);
      releaseContact();
      releaseBlast();
      physics.removeBody(body);
    },
  };
}
