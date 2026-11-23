import { test, expect } from '@playwright/test';
import { Vector3 } from 'three/webgpu';
import { WorldBus, WorldSource, FieldReading } from '../engine/world-bus';
import { PhysicsWorld } from '../engine/physics';
import { QualityManager } from '../engine/quality';
import { CloudTrail } from '../modules/aero/cloud-trail';
import { FireVolume } from '../modules/fire/fire-volume';
import { buildBuoy, SceneryRegistry } from '../showcase/scenery';
import type { LuminaEngine } from '../engine/engine';

test('a moored navigation buoy follows the mean and both slopes of its waterline', () => {
  const scenery = new SceneryRegistry();
  try {
    const buoy = buildBuoy(scenery, {x:12,z:-7,kind:'channel'});
    const camera = new Vector3(1000,8,1000);
    let calls = 0, sx = 0.11, sz = -0.24;
    const surface: Parameters<typeof buoy.followSurface>[0] = {
      heightsAt(points,batch) {
        calls++;
        for (let i=0;i<points.length;i++)
          batch.heights[i] = 2.5+sx*(points[i].x-12)+sz*(points[i].z+7);
      },
    };
    for (let i=0;i<120;i++) buoy.followSurface(surface,camera,1/60,0.25);
    expect(buoy.group.position.y).toBeCloseTo(2.25,8);
    const up = new Vector3(0,1,0);
    expect(up.clone().applyQuaternion(buoy.group.quaternion).distanceTo(new Vector3(-sx,1,-sz).normalize())).toBeLessThan(1e-8);
    expect(calls).toBeLessThan(30);
    sx = 0; sz = 0;
    camera.set(12,1,-7);
    for (let i=0;i<180;i++) buoy.followSurface(surface,camera,1/60,0.25);
    expect(up.clone().applyQuaternion(buoy.group.quaternion).distanceTo(up)).toBeLessThan(1e-8);
  } finally { scenery.dispose(); }
});

test('cloud clearance follows the aircraft between history knots and fades after exit', () => {
  const world = new WorldBus(), p = new Vector3(0, 20, 0), out = new FieldReading();
  world.cloudBase = 10;
  world.cloudTop = 50;
  const trail = new CloudTrail({ world } as LuminaEngine, 20, 2);
  trail.update(p);
  trail.update(p.set(25, 20, 0));
  expect(trail.segments).toBe(0);
  expect(world.disturbance(p, out).cloudCut).toBeCloseTo(1, 8);
  trail.update(p.set(32, 20, 0));
  expect(trail.segments).toBe(1);
  trail.update(p.set(54, 20, 0));
  expect(world.disturbance(p, out).cloudCut).toBeCloseTo(1, 8);
  trail.update(p.set(56, 90, 0));
  expect(world.disturbance(p.set(54, 20, 0), out).cloudCut).toBe(0);
  expect(world.disturbance(p.set(15, 20, 0), out).cloudCut).toBeCloseTo(1, 8);
  world.update(2.1);
  expect(world.disturbance(p, out).cloudCut).toBe(0);
});

test('an aircraft wake rolls about its flight path and a stationary vortex retains its vertical axis', () => {
  const bus = new WorldBus(), source = new WorldSource().at(-10,5,0), point = new Vector3(0,5,2);
  const out = new FieldReading();
  source.end.x=10; source.radius=4; source.swirl=8; source.axialSwirl=true;
  bus.publish(source);
  expect(bus.disturbance(point, out).wind.distanceTo(new Vector3(0, 4.5, 0))).toBeLessThan(1e-10);
  expect(bus.disturbance(point.set(0, 7, 0), out).wind.distanceTo(new Vector3(0, 0, -4.5))).toBeLessThan(1e-6);
  source.end.copy(source.start);
  bus.publish(source);
  expect(bus.disturbance(point.set(-10, 5, 2), out).wind.distanceTo(new Vector3(-4.5, 0, 0))).toBeLessThan(1e-10);
});

test('the four world fields share capsule boundaries, independent owners and lifetimes', () => {
  const bus = new WorldBus(),
    p = new Vector3(),
    out = new FieldReading(),
    air = new Vector3();
  bus.set(0, 0, 0);
  const a = new WorldSource().at(-4, 2, 0);
  a.end.x = 4;
  a.radius = 2;
  a.heat = 100;
  a.pressure = 2;
  a.wetness = 0.7;
  a.radial = 4;
  a.swirl = 2;
  a.cloudCut = 0.9;
  expect(bus.publish(a, 1)).toBe(true);
  bus.read(p.set(0, 2, 1), 0, out);
  expect(out.temperature).toBeCloseTo(18 + 100 * 0.5625);
  expect(out.pressure).toBeCloseTo(1.125);
  expect(out.wetness).toBeCloseTo(0.7 * 0.5625);
  expect(out.cloudCut).toBeCloseTo(0.9 * 0.5625);
  expect(out.wind.x).toBeCloseTo(-2 * 0.5625);
  expect(out.wind.z).toBeCloseTo(4 * 0.5625);
  expect(bus.sample(p, 0, air).distanceTo(out.wind)).toBeLessThan(1e-8);
  bus.read(p.set(6, 2, 0), 0, out);
  expect(out.temperature).toBe(18);
  expect(out.wind.length()).toBe(0);
  a.start.x = 20;
  a.end.x = 22;
  bus.publish(a, 1);
  expect(bus.sourceCount).toBe(1);
  const pulse = new WorldSource().at(0, 0, 0);
  pulse.radius = 3;
  pulse.wetness = 0.8;
  bus.publish(pulse, 0.4, true);
  bus.update(0.2);
  expect(bus.disturbance(p.set(0, 0, 0), out).wetness).toBeCloseTo(0.4);
  bus.removeSource(a);
  expect(bus.sourceCount).toBe(1);
  bus.update(0.21);
  expect(bus.sourceCount).toBe(0);
  bus.rainfall = 1;
  bus.update(1);
  expect(bus.surfaceWetness).toBeGreaterThan(0);
  bus.clearWorld();
  expect(bus.surfaceWetness).toBe(0);
  expect(bus.bodyForcing).toBe(false);
});

test('a current belongs to the highest water surface at the sampling point', () => {
  const bus = new WorldBus(),
    flow = new Vector3();
  bus.addWater({
    heightAt: (_x, _z, out) => {
      out?.set(2, 0, -3);
      return 3;
    },
  });
  const remove = bus.addWater({
    heightAt: (x, _z, out) => {
      out?.set(-1, 0, 0.5);
      return x >= 0 ? 5 : NaN;
    },
  });
  expect(bus.waterHeight(4, 0, flow)).toBe(5);
  expect(flow.toArray()).toEqual([-1, 0, 0.5]);
  expect(bus.waterHeight(-4, 0, flow)).toBe(3);
  expect(flow.toArray()).toEqual([2, 0, -3]);
  remove();
  expect(bus.waterHeight(4, 0, flow)).toBe(3);
  expect(flow.toArray()).toEqual([2, 0, -3]);
});

test('Rapier debris responds to a moving airflow volume only inside its footprint', async () => {
  const physics = await PhysicsWorld.create(),
    bus = new WorldBus();
  physics.fields = bus;
  try {
    const s = new WorldSource().at(0, 0, 0);
    s.end.y = 10;
    s.radius = 5;
    s.swirl = 22;
    s.lift = 24;
    s.radial = -3;
    const R = physics.RAPIER;
    const body = (x: number) => {
      const b = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, 2, 0));
      physics.world.createCollider(R.ColliderDesc.ball(0.2).setMass(0.5), b);
      return b;
    };
    const near = body(1.3),
      far = body(14);
    for (let i = 0; i < 30; i++) {
      bus.publish(s);
      bus.update(1 / 60);
      physics.step(1 / 60);
    }
    expect(near.translation().y).toBeGreaterThan(3);
    expect(near.translation().z).toBeGreaterThan(0.5);
    expect(far.translation().y).toBeLessThan(1.5);
    expect(far.translation().z).toBeCloseTo(0);
  } finally {
    physics.dispose();
  }
});

import * as THREE from 'three/webgpu';
import { ThermoField } from '../modules/thermo/thermo';
import { WeatherVortex } from '../modules/weather/vortex';
import type { EffectsKit } from '../engine/fx';
import { FloodableVessel } from '../modules/water/floodable-vessel';
import { AquaplaningVehicle } from '../modules/wet-road/vehicle';
import { StreetFlowGrid } from '../modules/wet-road/street-fluid';
import { FlexibleTree } from '../modules/strands/sapling';
import { ActiveRagdoll } from '../modules/ragdoll/active';
import { PhysicsEvents } from '../engine/events';

test('a sheltered surface film and exposed film respond differently to rain in the same grid', () => {
  const g = new StreetFlowGrid(11, 5, 1), world = new WorldBus();
  const release = world.shelters.add({center:new Vector3(37,4,20),width:3,depth:5,groundY:0});
  try {
    g.film.fill(0.5);
    const sheltered = 2*g.nx+2, exposed = 2*g.nx+8;
    g.flame[sheltered] = g.flame[exposed] = 0.4;
    g.step(1/30, -1e3, 1, world.shelters, 40, 20);
    expect(g.flame[sheltered]).toBeGreaterThan(.4);
    expect(g.flame[exposed]).toBeLessThan(.4);
  } finally { release(); world.shelters.dispose(); }
});

test('a downhill liquid film conserves inventory and carries its burning front to adjacent cells', () => {
  const g = new StreetFlowGrid(20, 12, 0.7);
  for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) g.floor[z * g.nx + x] = 0.8 - x * 0.06;
  const start = 6 * g.nx + 4;
  g.film[start] = 4;
  for (let i = 0; i < 144; i++) g.step(1 / 24, -1000, 0);
  expect(g.stats.film).toBeCloseTo(4, 4);
  const moment = g.film.reduce((total, v, i) => total + v * (i % g.nx), 0) / g.stats.film;
  expect(moment).toBeGreaterThan(5.5);
  let first = g.film.findIndex((v) => v > 0.045);
  expect(first).toBeGreaterThanOrEqual(0);
  g.flame[first] = 1;
  for (let i = 0; i < 140; i++) g.step(1 / 24, -1000, 0);
  expect(g.stats.burning).toBeGreaterThan(1);
  expect(g.stats.film).toBeLessThan(3.9);
});

test('a shared pressure pulse, heat and spray act on a street at its actual elevation', () => {
  const grid = new StreetFlowGrid(17, 17, 0.5);
  grid.floor.fill(112);
  grid.film.fill(0.1);
  const bus = new WorldBus(),
    source = new WorldSource().at(0, 112.5, 0);
  source.radius = 3;
  source.pressure = 4;
  source.heat = 270;
  bus.publish(source);
  grid.couple(bus, 0, 0, 112.5, 0.15);
  const centre = 8 * 17 + 8;
  expect(grid.flame[centre]).toBeGreaterThan(0.1);
  expect(grid.velocity[centre]).toBeLessThan(0);
  expect(grid.velocity[centre + 4]).toBeGreaterThan(0);
  expect(grid.velocity[0]).toBe(0);
  source.heat = 0;
  source.pressure = 0;
  source.wetness = 1;
  bus.publish(source);
  grid.couple(bus, 0, 0, 112.5, 0.5);
  expect(grid.flame[centre]).toBe(0);
  grid.step(1 / 30, 112.5, 0);
  expect(grid.stats.peakWave).toBeGreaterThan(0);
});

test('scrolling street cells retain the world position of water, oil and fire', () => {
  const g = new StreetFlowGrid(8, 10, 1),
    i = 5 * g.nx + 4;
  g.wave[i] = 0.25;
  g.velocity[i] = 2;
  g.film[i] = 0.75;
  g.flame[i] = 0.5;
  g.shift(2, -1);
  const j = 6 * g.nx + 2;
  expect([g.wave[j], g.velocity[j], g.film[j], g.flame[j]]).toEqual([0.25, 2, 0.75, 0.5]);
  expect(g.film.reduce((a, b) => a + b, 0)).toBe(0.75);
  g.shift(30, 0);
  expect(g.film[j]).toBe(0);
});

async function testWorld() {
  const physics = await PhysicsWorld.create(),
    world = new WorldBus();
  physics.fields = world;
  const engine = {
    physics,
    world,
    quality: new QualityManager('high'),
    wind: world,
    scene: new THREE.Scene(),
    pipeline: { softScene: new THREE.Scene() },
    events: new PhysicsEvents(),
    time: 0,
  } as unknown as LuminaEngine;
  return engine;
}

test('a combustion plume entrains local rotor air and starts at its new origin when reused', async () => {
  const engine = await testWorld();
  engine.prewarm = () => {};
  engine.world.set(0, 0, 0);
  const plume = new FireVolume(engine), mesh = engine.pipeline.softScene.children[0];
  const origin = new Vector3(30, 4, 15);
  const run = () => {
    plume.start(origin, 1, 0, 21);
    for (let frame = 0; frame < 90; frame++) plume.update(1/60);
    return mesh.position.y;
  };
  try {
    const calm = run(), wash = new WorldSource().at(30, 8, 15);
    wash.radius = 45; wash.lift = -12;
    engine.world.publish(wash);
    expect(run()).toBeLessThan(calm - 2);
    engine.world.removeSource(wash);
    expect(run()).toBeCloseTo(calm, 8);
    const other = new Vector3(-40, 2, -30);
    plume.start(other, 1, 0, 22);
    expect(mesh.position.x).toBe(other.x);
    expect(mesh.position.z).toBe(other.z);
  } finally { plume.dispose(); engine.physics.dispose(); }
});

test('vehicle tires share a loaded chassis with host forces and release their own ground on removal', async () => {
  const e = await testWorld(), p = e.physics;
  const rig = {object:new THREE.Group(), wheels:Array.from({length:4}, () => new THREE.Group()),
    wheelRadius:0.335, hardPoints:[new Vector3(-0.8,0.335,-1.4),new Vector3(0.8,0.335,-1.4),
      new Vector3(-0.8,0.335,1.33),new Vector3(0.8,0.335,1.33)],
    halfExtents:new Vector3(0.9,0.34,2.15), mass:1400, setBrake(){}};
  const vehicle = new AquaplaningVehicle(e, rig, {wetness:1,puddleDepth:() => 0.015});
  vehicle.autopilot = false;
  try {
    for (let i=0;i<90;i++) p.step(1/60);
    expect(vehicle.wheels.every(w => w.contact)).toBe(true);
    const hostForce = new Vector3(240,0,0), out = new Vector3();
    vehicle.chassis.addForce(hostForce,true);
    for (let i=0;i<12;i++) p.step(1/60);
    vehicle.chassis.userForce(out);
    expect(out.toArray()).toEqual(hostForce.toArray());
  } finally {
    vehicle.dispose();
    try { expect(p.world.bodies.len()).toBe(0); } finally { p.dispose(); }
  }
});

test('a port-side leak lists a floating vessel, then loss of all reserves sinks it', async () => {
  const e = await testWorld(),
    p = e.physics,
    R = p.RAPIER;
  e.world.addWater({ heightAt: () => 0 });
  const body = p.world.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(0, 0.22, 0).setAngularDamping(1.3)
  );
  p.world.createCollider(R.ColliderDesc.cuboid(0.88, 0.32, 2.2).setMass(1200), body);
  const compartments: { center: Vector3; volume: number }[] = [];
  for (const x of [-0.67, 0.67])
    for (const z of [-1.28, 1.28]) compartments.push({ center: new Vector3(x, -0.16, z), volume: 0.51 });
  const boat = new FloodableVessel(e, body, { draft: 0.78, compartments });
  let bubbles = 0,
    heel = 0;
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      p.step(1 / 60);
      boat.update(1 / 60);
      bubbles = Math.max(bubbles, boat.stats.bubbles);
      heel = Math.max(heel, Math.abs(boat.stats.list));
    }
  };
  try {
    run(240);
    const afloat = body.translation().y;
    expect(Math.abs(afloat)).toBeLessThan(0.5);
    boat.damage(0, 0.17);
    boat.damage(1, 0.12);
    run(150);
    expect(heel).toBeGreaterThan(0.1);
    expect(boat.fill[0]).toBeGreaterThan(boat.fill[2] + 0.25);
    expect(bubbles).toBeGreaterThan(0);
    boat.damage(2, 0.35);
    boat.damage(3, 0.35);
    run(360);
    expect(boat.stats.flooded).toBeGreaterThan(0.88);
    expect(body.translation().y).toBeLessThan(afloat - 1.5);
  } finally {
    boat.dispose();
    p.dispose();
  }
});

test('a rolling vessel fits a sloped waterline and displaces water on opposing sides', async () => {
  const engine = await testWorld(), physics = engine.physics, R = physics.RAPIER;
  const heightAt = (x: number, z: number) => 1.2 + 0.06 * x - 0.08 * z;
  engine.world.addWater({ heightAt });
  const x = 20, z = -10, surface = heightAt(x, z);
  const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, surface, z)
    .setAngvel({ x: 0, y: 0, z: 1.4 }));
  physics.world.createCollider(R.ColliderDesc.cuboid(0.65, 0.2, 1.3).setMass(900), body);
  const compartments = [-0.6, 0.6].flatMap(side => [-1.2, 1.2].map(station => ({
    center: new Vector3(side, 0, station), volume: 0.5,
  })));
  const boat = new FloodableVessel(engine, body, { draft: 0.8, compartments });
  try {
    physics.step(1/60);
    const plane = boat.waterline, sample = new FieldReading();
    for (const { center } of compartments) {
      const px = x + center.x, pz = z + center.z;
      expect(plane.x * px + plane.y * heightAt(px, pz) + plane.z * pz + plane.w).toBeCloseTo(0, 7);
    }
    expect(engine.world.sourceCount).toBe(2);
    const point = new Vector3(x - 0.6, surface, z);
    expect(engine.world.disturbance(point, sample).pressure).toBeGreaterThan(0.2);
    point.x += 1.2;
    expect(engine.world.disturbance(point, sample).pressure).toBeLessThan(-0.2);
  } finally {
    boat.dispose();
    try { expect(engine.world.sourceCount).toBe(0); } finally { physics.dispose(); }
  }
});

test('a bounded tree impact bends the joints and a larger impact releases a colliding crown', async () => {
  const e = await testWorld(),
    p = e.physics;
  const tree = new FlexibleTree(e, new Vector3());
  try {
    tree.impact(0.25);
    for (let i = 0; i < 12; i++) tree.update(1 / 60, i / 60);
    expect(tree.stats.peakStrain).toBeGreaterThan(0.025);
    expect(tree.stats.brokenAt).toBe(-1);
    tree.impact(1.1);
    const before = tree.joints[1].getWorldPosition(new Vector3());
    for (let i = 0; i < 100; i++) {
      p.step(1 / 60);
      tree.update(1 / 60, i / 60);
    }
    expect(tree.stats.brokenAt).toBe(1);
    expect(tree.joints[1].parent).toBe(e.scene);
    expect(tree.joints[1].position.y).toBeLessThan(before.y - 0.25);
  } finally {
    tree.dispose();
    p.dispose();
  }
});

test('the active dry stance bears weight through the feet and yields to a lateral impulse', async () => {
  const e = await testWorld(), physics = e.physics, R = physics.RAPIER;
  e.world.set(0,0,0);
  physics.world.createCollider(R.ColliderDesc.cuboid(6, 0.25, 6).setTranslation(0, -0.25, 0));
  const worker = new ActiveRagdoll(e, new Vector3(0, 0.035, 0));
  const advance = (n: number) => {
    for (let i = 0; i < n; i++) { e.time += 1 / 60; physics.step(1 / 60); }
  };
  try {
    advance(720);
    const height = worker.torso.body.translation().y;
    const tilt = worker.stats.torsoTilt;
    const pos = worker.torso.body.translation(), drift = Math.hypot(pos.x, pos.z);
    const feet = worker.stats.groundedFeet;
    worker.stumble(new Vector3(12, 0.5, 3));
    advance(18);
    console.log('dry stance', { height, tilt, drift, feet, response: worker.stats.strength });
    expect(height).toBeGreaterThan(1.04);
    expect(tilt).toBeLessThan(0.5);
    expect(drift).toBeLessThan(0.35);
    expect(feet).toBeGreaterThan(0);
    expect(worker.stats.strength).toBeLessThan(0.45);
    expect(worker.stats.immersion).toBe(0);
  } finally { worker.dispose(); physics.dispose(); }
});

test('planted boots ride a moving platform and release as it falls away', async () => {
  const e = await testWorld(), physics = e.physics, R = physics.RAPIER;
  e.world.set(0, 0, 0);
  const platform = physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0,0,0));
  physics.world.createCollider(R.ColliderDesc.cuboid(4,0.2,4).setTranslation(0,-0.2,0), platform);
  const actor = new ActiveRagdoll(e, new Vector3(0,0.035,0));
  const move = new Vector3();
  try {
    for (let i = 0; i < 300; i++) {
      move.x = Math.max(0, i - 119) * 0.005;
      platform.setNextKinematicTranslation(move);
      e.time += 1 / 60; physics.step(1 / 60);
    }
    const torso = actor.torso.body.translation(), height = torso.y;
    expect(Math.abs(torso.x - move.x)).toBeLessThan(0.35);
    expect(height).toBeGreaterThan(1.04);
    expect(actor.stats.groundedFeet).toBeGreaterThan(0);
    physics.world.removeRigidBody(platform);
    for (let i = 0; i < 18; i++) { e.time += 1 / 60; physics.step(1 / 60); }
    expect(actor.stats.groundedFeet).toBe(0);
    expect(actor.torso.body.translation().y).toBeLessThan(height - 0.22);
  } finally { actor.dispose(); physics.dispose(); }
});

test('river rescue begins face up and afloat within reach of the water', async () => {
  const e = await testWorld(), physics = e.physics, surface = 2.75;
  e.world.addWater({ heightAt: () => surface });
  physics.world.createCollider(physics.RAPIER.ColliderDesc.cuboid(4, 0.1, 4).setTranslation(0, surface - 1.1, 0));
  const actor = new ActiveRagdoll(e, new Vector3(0, surface, 0), 'afloat');
  try {
    const head = actor.limbs[2].mesh;
    expect(head.position.y).toBeGreaterThan(surface + 0.1);
    expect(new Vector3(0,0,-1).applyQuaternion(head.quaternion).y).toBeGreaterThan(0.8);
    for (let i = 0; i < 60; i++) {
      e.time += 1 / 60;
      physics.step(1 / 60);
      expect(actor.stats.immersion).toBeGreaterThan(0.4);
    }
    expect(actor.stats.groundedFeet).toBe(0);
    expect(Math.abs(actor.torso.body.translation().y - surface)).toBeLessThan(0.45);
  } finally { actor.dispose(); physics.dispose(); }
});

test('articulated rescue worker absorbs an impulse and achieves buoyant equilibrium', async () => {
  const e = await testWorld(),
    p = e.physics;
  e.world.addWater({ heightAt: () => 0 });
  const actor = new ActiveRagdoll(e, new Vector3(0, -0.7, 0));
  try {
    expect(p.world.impulseJoints.len()).toBe(actor.limbs.length - 1);
    actor.stumble(new Vector3(9, 0, 2));
    p.step(1 / 60);
    expect(actor.stats.strength).toBeLessThan(0.2);
    for (let i = 0; i < 480; i++) {
      e.time += 1 / 60;
      p.step(1 / 60);
    }
    expect(actor.stats.immersion).toBeGreaterThan(0.3);
    expect(actor.stats.immersion).toBeLessThan(1);
    expect(Math.abs(actor.torso.body.translation().y)).toBeLessThan(1.25);
    const spread = Math.max(...actor.limbs.map((l) => l.mesh.position.distanceTo(actor.torso.mesh.position)));
    expect(spread).toBeLessThan(1.8);
    expect(actor.stats.strength).toBe(1);
  } finally {
    actor.dispose();
    p.dispose();
  }
});

test('a moving tornado lifts and turns a loaded chassis off firm ground', async () => {
  const engine = await testWorld(),
    physics = engine.physics,
    R = physics.RAPIER;
  const dust = { burstBudget: 200, emitRateAt() {} };
  const tornado = new WeatherVortex(engine, { dust } as unknown as EffectsKit, { radius: 7, height: 42 });
  physics.world.createCollider(R.ColliderDesc.cuboid(50, 1, 50).setTranslation(0, -1, 0));
  const chassis = (x: number) => {
    const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, 0.52, 0));
    physics.world.createCollider(R.ColliderDesc.cuboid(0.94, 0.5, 2.08).setMass(1200), body);
    return body;
  };
  const near = chassis(1.7),
    far = chassis(31);
  try {
    tornado.start(0, 0, 0.6, 0.25);
    let peak = 0;
    for (let i = 0; i < 135; i++) {
      tornado.update(1 / 60);
      engine.world.update(1 / 60);
      physics.step(1 / 60);
      peak = Math.max(peak, near.translation().y);
    }
    expect(peak).toBeGreaterThan(1.4);
    expect(Math.abs(near.translation().z)).toBeGreaterThan(1);
    expect(far.translation().y).toBeCloseTo(0.5, 1);
    expect(Math.abs(far.translation().z)).toBeLessThan(0.05);
  } finally {
    tornado.dispose();
    physics.dispose();
  }
});

test('a swept source heats a remote elevated deck and local spray cools it', async () => {
  const e = await testWorld();
  const pool = { capacity: 80, emitRate() {}, emit() {} };
  const fx = {
    fire: pool,
    smoke: pool,
    mist: pool,
    heatHaze() {},
    addFireLight() {
      return { setIntensity() {}, setRadius() {}, setPosition() {}, remove() {} };
    },
  } as unknown as EffectsKit;
  const thermo = new ThermoField(e, fx, { resolution: 24, size: 16, surfaceY: 20 });
  const shelf = thermo.addDeck({
    position: new Vector3(0, 24, 0),
    width: 9,
    depth: 4,
    resolution: 16,
    fuel: 1.8,
  });
  const source = new WorldSource().at(-6, 24, 0);
  source.end.x = 4;
  source.radius = 1.4;
  source.heat = 980;
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      e.time += 1 / 60;
      e.world.publish(source);
      e.world.update(1 / 60);
      thermo.update(1 / 60, e.time);
    }
  };
  try {
    // The same rainfall crosses the edge of the shelter on the ground and elevated deck.
    const release = e.world.shelters.add({ center: new Vector3(-3, 26, 0), width: 5, depth: 8, groundY: 20 });
    thermo.rain = 1;
    for (let i = 0; i < 18; i++) thermo.update(1 / 60, e.time += 1 / 60);
    const dry = new Vector3(-3,24,0);
    expect(thermo.wetnessAt(-3,0)).toBe(0);
    expect(thermo.wetnessAt(3,0)).toBeGreaterThan(0.09);
    expect(shelf.wetnessAtWorld(dry)).toBe(0);
    expect(shelf.wetnessAtWorld(new Vector3(3,24,0))).toBeGreaterThan(0.09);
    thermo.quench3D(dry, 1.5, 1);
    expect(shelf.wetnessAtWorld(dry)).toBeGreaterThan(0.4);
    release();
    thermo.rain = 0;
    run(100);
    const p = new Vector3(3.5, 24, 0),
      hot = shelf.temperatureAtWorld(p);
    expect(hot).toBeGreaterThan(230);
    expect(thermo.temperatureAt(3.5, 0)).toBeLessThan(70);
    source.heat = -450;
    source.wetness = 1;
    run(150);
    expect(shelf.temperatureAtWorld(p)).toBeLessThan(hot * 0.55);
    expect(Math.max(...shelf.wet)).toBeGreaterThan(0.14);
  } finally {
    thermo.dispose();
    e.physics.dispose();
  }
});
