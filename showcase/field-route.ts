import * as THREE from 'three/webgpu';
import { promoteGroveTree } from '../modules/landscape/tree-contact';
import { AquaplaningVehicle } from '../modules/wet-road/vehicle';
import { createSportsCoupe } from '../test-rigs/sports-coupe';
import { RegionalFlight } from '../modules/landscape/regional-flight';
import { soilSite, riverCenter, regionalRiver } from '../modules/landscape/earth';
import type { ProfileWorld } from '../modules/weather/outdoor-world';
import { fieldCrossing } from './field-crossing';
import { fieldCanoe } from './field-canoe';
export const VIEWS = ['ridge', 'walk', 'drive', 'overhead', 'flight'] as const;
export type FieldView = (typeof VIEWS)[number];
const bound = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function fieldRoute(world: ProfileWorld, start: FieldView) {
  const { engine, land, terrain, foliage } = world;
  if (!land) throw new Error('A field route requires a landscape');
  const earth = land.earth,
    form = land.region.form,
    bridge = fieldCrossing(world),
    ground = bridge.height;
  const soil = soilSite(),
    carry = new Float64Array(8),
    plume = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      radius: 0.12,
      spread: 0.55,
      size: 0.036,
      sizeEnd: 0.12,
      life: 0.52,
    };
  const cam = engine.camera,
    hub = new THREE.Vector2(
      form === 'street'
        ? 8 * Math.sin(-55 * 0.015)
        : form === 'wash'
          ? riverCenter(-40, land.seeds.terrain)
          : form === 'watershed'
            ? 15
            : form === 'fans'
              ? bridge.centre + 20
              : form === 'marsh'
                ? bridge.centre + 13
                : bridge.centre + 31,
      form === 'street' ? -55 : bridge.z,
    );
  const walker = hub.clone(),
    flying = hub.clone(),
    ahead = new THREE.Vector3(),
    keys = new Set<string>();
  const contacts = Array.from({ length: 4 }, () => land.contact(0.245));
  let runoff = 0;
  let view: FieldView = 'ridge',
    heading = form === 'street' ? 0 : form === 'wash' ? 0.23 : form === 'fans' ? 2.4 : -1.57,
    flyYaw = -1.67,
    altitude = 89,
    clock = 0,
    step = 0,
    foot = 1,
    actionIndex = 0;
  let vehicle: AquaplaningVehicle | undefined,
    rig: ReturnType<typeof createSportsCoupe> | undefined,
    tiles: RegionalFlight | undefined;
  const routeNames: Record<typeof form, string> = {
    wood: 'Willow Bridge',
    snowfield: 'Thaw Lane',
    marsh: 'Heron Channel',
    wash: 'Dry Wash',
    farm: 'Orchard Rows',
    mountain: 'Spruce Divide',
    street: 'Rain Garden Lane',
    fans: 'Lantern Fen',
    watershed: 'Two Rivers Flight',
    shore: 'Salt Head',
    uplands: 'Shale Steps',
  };
  if (form === 'fans') {
    const fan = foliage.grove.nearest(hub.x, hub.y, cam, true);
    if (fan) {
      walker.set(fan.x + 11.5, fan.z - 7.5);
      heading = Math.atan2(fan.x - walker.x + 1.8, fan.z - walker.y + 1.4);
    }
  }
  const reef = form === 'marsh';
  const canoe = reef ? fieldCanoe() : undefined,
    flow = new THREE.Vector3();
  if (canoe) engine.scene.add(canoe.root, canoe.silt);
  let paddling = false;
  const takeoff = hub.clone();
  const regionalStops = [
    { x: 55, z: regionalRiver(55, land.seeds.terrain), height: 75 },
    { x: -325, z: regionalRiver(-325, land.seeds.terrain), height: 84 },
    { x: -600, z: 280, height: 100 },
    { x: -815, z: regionalRiver(-815, land.seeds.terrain, 2), height: 72 },
    { x: -1250, z: regionalRiver(-1250, land.seeds.terrain, 2), height: 46 },
    { x: -730, z: regionalRiver(-730, land.seeds.terrain, 1), height: 74 },
    { x: -185, z: regionalRiver(-185, land.seeds.terrain), height: 62 },
    { x: takeoff.x, z: takeoff.y, height: 3 },
  ];
  let leg = -1;
  const runoffSource = bridge.runoffOutlet ?? { x: riverCenter(hub.y + 9, land.seeds.terrain), z: hub.y + 9 };
  const key = (e: KeyboardEvent, down: boolean) => {
    if (
      !(e.target instanceof HTMLCanvasElement || e.target === document.body) ||
      !(
        e.code.startsWith('Arrow') ||
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft'].includes(e.code)
      )
    )
      return;
    e.preventDefault();
    if (down) keys.add(e.code);
    else keys.delete(e.code);
  };
  const down = (e: KeyboardEvent) => key(e, true),
    up = (e: KeyboardEvent) => {
      keys.delete(e.code);
    },
    blur = () => keys.clear();
  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('blur', blur);
  const axis = (pos: string, alt: string, neg: string, other: string) =>
    Number(keys.has(pos) || keys.has(alt)) - Number(keys.has(neg) || keys.has(other));
  let interactiveTree: ReturnType<typeof promoteGroveTree>;
  function treeImpact() {
    if (!interactiveTree) {
      const t = foliage.grove.nearest(walker.x, walker.y, cam, true);
      if (t) interactiveTree = promoteGroveTree(world, t.id);
    }
    interactiveTree?.impact();
  }
  function car() {
    if (vehicle) return vehicle;
    rig = createSportsCoupe('#617369');
    const surface = {
      get wetness() {
        return earth.rain;
      },
      wetnessAt: (x: number, z: number) => bridge.contact(x, z)?.film ?? terrain.wetnessAt(x, z),
      grip: (x: number, z: number) => (bridge.overDeck(x, z) ? 0.94 : terrain.grip(x, z)),
      puddleDepth: (x: number, z: number) => (bridge.overDeck(x, z) ? 0 : terrain.puddleDepth(x, z)),
      partFoliage: terrain.partFoliage,
    };
    vehicle = engine.add(
      new AquaplaningVehicle(engine, rig, surface, {
        ground: false,
        groundY: -36,
        heading,
        start: new THREE.Vector3(walker.x, ground(walker.x, walker.y) + 0.61, walker.y),
      }),
    );
    vehicle.autopilot = false;
    return vehicle;
  }
  function setView(next: FieldView) {
    if (!VIEWS.includes(next)) throw new RangeError('Unknown field camera');
    if (view === 'drive' && vehicle) {
      walker.set(vehicle.root.position.x, vehicle.root.position.z);
      walker.x += 1.8;
      vehicle.input.brake = 1;
      vehicle.input.throttle = 0;
    }
    if (next === 'flight' && form === 'watershed') {
      tiles ??= new RegionalFlight(land!.seeds.terrain);
      engine.scene.add(tiles.root);
      tiles.root.visible = true;
    } else if (tiles) tiles.root.visible = false;
    const streamed = next === 'flight' && !!tiles;
    world.bed.mesh.visible =
      foliage.root.visible =
      world.dressing.root.visible =
      bridge.root.visible =
        !streamed;
    if (next !== 'flight') leg = -1;
    if (canoe) canoe.root.visible = paddling && next === 'walk';
    if (next === 'drive') car();
    if (vehicle) vehicle.root.visible = !streamed;
    view = next;
    update(0);
  }
  function update(dt: number) {
    const turn = axis('KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight'),
      move = axis('KeyW', 'ArrowUp', 'KeyS', 'ArrowDown');
    clock += dt;
    if (canoe) canoe.update(dt, terrain.waterLevel, flow);
    if (vehicle && rig) {
      vehicle.input.throttle = view === 'drive' ? move : 0;
      vehicle.input.steer = view === 'drive' ? turn : 0;
      vehicle.input.brake = view !== 'drive' || keys.has('Space') ? 1 : 0;
      rig.setHeadlights(world.weather.params.sunElevation < 2, 0.22);
      if (dt > 0)
        for (let i = 0; i < vehicle.wheels.length; i++) {
          const wheel = vehicle.wheels[i];
          if (!wheel.contact) continue;
          const { x, z } = wheel.position;
          const overlay = bridge.contact(x, z);
          const film = contacts[i].sample(x, z, wheel.rollingSpeed, wheel.loadRatio, dt, overlay);
          const speed = Math.abs(wheel.rollingSpeed);
          if (speed < 1) continue;
          earth.inspect(x, z, soil);
          const dryDust = !overlay && soil.moisture < 0.4 && soil.soil !== 'asphalt' && soil.snow < 0.1;
          const spray = Math.min(1, film * 170 + wheel.depth * 9),
            powder = soil.snow * (1 - soil.compaction);
          if (!dryDust && spray < 0.02 && powder < 0.04) continue;
          plume.position.copy(wheel.position);
          plume.position.y += 0.04;
          const side = (i % 2 ? 1 : -1) * (1.1 + speed * 0.13);
          plume.velocity
            .copy(wheel.velocity)
            .multiplyScalar(0.21)
            .addScaledVector(wheel.normal, 0.24 + 0.093 * speed);
          plume.velocity.x += vehicle.forward.z * side;
          plume.velocity.z -= vehicle.forward.x * side;
          plume.size = dryDust || powder > 0.1 ? 0.12 : 0.025;
          plume.sizeEnd = dryDust || powder > 0.1 ? 0.43 : 0.13;
          const pool = dryDust ? world.fx.dust : powder > 0.1 ? world.fx.mist : world.fx.spray;
          pool.emitRateAt(
            carry,
            i,
            Math.min(140, speed * (dryDust ? 1.3 : 1 + spray * 3.2 + powder * 2)),
            dt,
            plume,
          );
        }
    }
    if (runoff > 0 && dt > 0) {
      runoff -= dt;
      // The downpipe (or upstream wash) stays fixed. EarthState transports the water.
      earth.discharge(runoffSource.x, runoffSource.z, 0.035 * dt, form === 'wash' ? 2.4 : 1.2);
    }
    if (view === 'flight') {
      flyYaw += turn * dt * 0.85;
      const speed = leg >= 0 ? 124 : move < 0 ? 22 : move > 0 ? 134 : 59;
      altitude = bound(
        altitude + ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * 55 * dt,
        12,
        215,
      );
      if (turn || move || keys.has('KeyQ') || keys.has('KeyE')) leg = -1;
      if (leg >= 0) {
        const stop = regionalStops[leg],
          dx = stop.x - flying.x,
          dz = stop.z - flying.y,
          distance = Math.hypot(dx, dz);
        const advance = Math.min(speed * dt, distance);
        if (distance > 0.01) {
          flyYaw = Math.atan2(dx, dz);
          flying.x += (dx / distance) * advance;
          flying.y += (dz / distance) * advance;
        }
        altitude += (stop.height - altitude) * Math.min(1, advance / Math.max(advance, distance, 0.01));
        if (distance <= advance + 0.02 && ++leg === regionalStops.length) {
          leg = -1;
          walker.copy(takeoff);
          setView('walk');
          return;
        }
      } else {
        flying.x += Math.sin(flyYaw) * speed * dt;
        flying.y += Math.cos(flyYaw) * speed * dt;
      }
      if (!tiles) {
        flying.x = bound(flying.x, -208, 208);
        flying.y = bound(flying.y, -208, 208);
      }
      const origin = tiles?.updateAt(flying.x, flying.y);
      const y = (tiles ? tiles.height(flying.x, flying.y) : ground(flying.x, flying.y)) + altitude;
      cam.position.set(flying.x - (origin?.east ?? 0), y, flying.y - (origin?.north ?? 0));
      cam.lookAt(cam.position.x + Math.sin(flyYaw) * 135, y - 28, cam.position.z + Math.cos(flyYaw) * 135);
    } else if (view === 'drive' && vehicle) {
      const p = vehicle.root.position,
        f = vehicle.forward;
      cam.position.set(p.x - f.x * 7.8, p.y + 2.6, p.z - f.z * 7.8);
      cam.position.y = Math.max(cam.position.y, ground(cam.position.x, cam.position.z) + 1.05);
      cam.lookAt(p.x + f.x * 7, p.y + 1.35, p.z + f.z * 7);
    } else if (view === 'walk') {
      heading += turn * dt * 1.45;
      const afloat =
        paddling && canoe && world.ocean && terrain.waterLevel - ground(walker.x, walker.y) > 0.22;
      const speed = (afloat ? 3.8 : keys.has('ShiftLeft') ? 4.8 : 2.15) * move;
      walker.x = bound(walker.x + Math.sin(heading) * speed * dt, -244, 244);
      walker.y = bound(walker.y + Math.cos(heading) * speed * dt, -244, 244);
      step += Math.abs(speed) * dt;
      if (afloat && canoe && world.ocean) {
        world.ocean.flowAt(walker.x, walker.y, flow);
        walker.x += flow.x * dt;
        walker.y += flow.z * dt;
        const level = world.ocean.heightAt(walker.x, walker.y);
        canoe.root.position.set(walker.x, level, walker.y);
        canoe.root.rotation.set(0, heading, 0);
        canoe.root.rotateZ(0.035 * Math.sin(clock * 1.7));
        if (step > 0.74) {
          step = 0;
          foot = -foot;
          const px = walker.x + Math.cos(heading) * 0.62 * foot,
            pz = walker.y - Math.sin(heading) * 0.62 * foot;
          if (level - ground(px, pz) < 1.7) {
            canoe.stir(px, pz);
            earth.stamp(px, pz, 0.44, 0.12);
          }
        }
        cam.position.set(
          walker.x - Math.sin(heading) * 3.85,
          level + 1.42,
          walker.y - Math.cos(heading) * 3.85,
        );
        cam.lookAt(walker.x + Math.sin(heading) * 7, level + 0.38, walker.y + Math.cos(heading) * 7);
        canoe.root.visible = true;
        cam.updateMatrixWorld();
        return;
      }
      if (canoe) canoe.root.visible = false;
      if (step > 0.64) {
        step = 0;
        foot = -foot;
        const x = walker.x + Math.cos(heading) * 0.105 * foot,
          z = walker.y - Math.sin(heading) * 0.105 * foot;
        earth.stamp(x, z, 0.17, 0.24);
        terrain.partFoliage?.(x, ground(x, z), z, 0.3, 1);
      }
      cam.position.set(
        walker.x,
        Math.max(ground(walker.x, walker.y), reef ? terrain.waterLevel - 0.53 : -Infinity) + 1.58,
        walker.y,
      );
      cam.lookAt(walker.x + Math.sin(heading) * 20, cam.position.y - 1.05, walker.y + Math.cos(heading) * 20);
    } else if (view === 'overhead') {
      cam.position.set(
        walker.x + 18,
        ground(walker.x, walker.y) + (form === 'farm' ? 43 : 71),
        walker.y - 23,
      );
      cam.lookAt(walker.x, ground(walker.x, walker.y), walker.y);
    } else {
      const w = Math.sin(clock * 0.07) * 2.4,
        z = hub.y - 26;
      const x = form === 'street' ? hub.x - 10 : hub.x + 12 + w;
      ahead.set(form === 'street' ? 1 : riverCenter(hub.y + 18, land!.seeds.terrain), 0, hub.y + 17);
      ahead.y = ground(ahead.x, ahead.z) + 2.8;
      cam.position.set(x, Math.max(ground(x, z), 0) + 9, z);
      cam.lookAt(ahead);
    }
    cam.updateMatrixWorld();
  }
  const actions: Record<string, string> = {
    wood: 'Change season',
    snowfield: 'Thaw the crossing',
    marsh: 'Turn the tide',
    wash: 'Release runoff',
    farm: 'Mow a strip',
    mountain: 'Climb to treeline',
    street: 'Open the downspout',
    fans: 'Change art direction',
    watershed: 'Follow the watershed',
    shore: 'Turn the tide',
    uplands: 'Release runoff',
  };
  function act() {
    actionIndex++;
    if (form === 'wood') {
      const seasons = ['spring', 'summer', 'autumn', 'winter'] as const;
      world.setSeason(seasons[(seasons.indexOf(earth.season) + 1) % 4]);
    } else if (form === 'marsh' || form === 'shore') {
      world.ocean?.setTide({ amplitude: 1.18, periodSeconds: 92, phase: actionIndex % 2 ? 0.25 : 0.75 });
      if (reef) {
        paddling = actionIndex % 2 === 1;
        walker.set(riverCenter(hub.y, land!.seeds.terrain) + 2, hub.y);
        heading = 0;
        setView('walk');
      }
    } else if (form === 'fans') {
      const styles = ['lumina:painted', 'lumina:graphic', 'lumina:extraterrestrial'];
      world.setDirection(styles[(actionIndex - 1) % 3]);
    } else if (form === 'farm') {
      for (let i = 0; i < 32; i += 0.75) earth.stamp(walker.x, walker.y + i, 1.9, 1);
      setView('overhead');
    } else if (form === 'mountain') {
      // Pick a walkable summit overlooking the actual meltwater channel.
      let best = -Infinity,
        tx = walker.x,
        tz = walker.y;
      for (let z = -75; z <= 48; z += 8)
        for (let x = 35; x <= 120; x += 8) {
          const h = ground(x, z),
            s = earth.inspect(x, z, soil);
          if (s.slope < 0.74 && h > best) {
            best = h;
            tx = x;
            tz = z;
          }
        }
      walker.set(tx, tz);
      heading = Math.atan2(riverCenter(tz + 32, land!.seeds.terrain) - tx, 32);
      setView('walk');
    } else if (form === 'watershed') {
      if (leg >= 0) {
        leg = -1;
        walker.copy(takeoff);
        setView('walk');
      } else {
        takeoff.copy(walker);
        const last = regionalStops[regionalStops.length - 1];
        last.x = takeoff.x;
        last.z = takeoff.y;
        flying.copy(takeoff);
        leg = 0;
        setView('flight');
      }
    } else {
      if (form === 'snowfield') {
        world.patch({ time: 12, weather: 'clear' }, 0.6);
        earth.setRain(0.22);
        earth.discharge(walker.x - 4, walker.y, 0.04, 2.8);
      } else {
        earth.discharge(runoffSource.x, runoffSource.z, 0.1, form === 'wash' ? 2.4 : 1.2);
        if (form === 'street') {
          walker.set(runoffSource.x + 3.2, runoffSource.z - 2.8);
          heading = Math.atan2(-3.2, 2.8);
          setView('walk');
        }
        runoff = 8;
      }
    }
  }
  setView(start);
  return {
    name: routeNames[form],
    bridge,
    walker,
    flying,
    treeImpact,
    get view() {
      return view;
    },
    get vehicle() {
      return vehicle;
    },
    get tiles() {
      return tiles;
    },
    setView,
    update,
    act,
    get actionLabel() {
      return form === 'watershed' && leg >= 0 ? 'Land at the clearing' : actions[form];
    },
    get guidedLeg() {
      return leg;
    },
    inspect() {
      const p = view === 'drive' && vehicle ? vehicle.root.position : null,
        x = p?.x ?? walker.x,
        z = p?.z ?? walker.y;
      return { ...land.inspect(x, z), nearest: foliage.grove.nearest(x, z, cam) };
    },
    dispose() {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', blur);
      interactiveTree?.dispose();
      bridge.dispose();
      tiles?.dispose();
      canoe?.dispose();
      contacts.forEach((c) => c.reset());
      if (rig) {
        const materials = new Set<THREE.Material>(),
          geometries = new Set<THREE.BufferGeometry>();
        rig.object.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            geometries.add(o.geometry);
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
          }
        });
        for (const g of geometries) g.dispose();
        for (const m of materials) m.dispose();
      }
    },
  };
}
