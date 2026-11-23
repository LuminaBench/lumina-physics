import { expect, test } from '@playwright/test';
import * as THREE from 'three/webgpu';
import { PaintWear } from '../modules/destruction/paint-wear';
import { openScene, watchConsole } from './helpers';

test('a single-material painted box accepts contacts on every geometry group', () => {
  const original = new THREE.MeshStandardNodeMaterial(), geometry = new THREE.BoxGeometry();
  const wear = new PaintWear(original), mesh = new THREE.Mesh(geometry, wear.material);
  const point = new THREE.Vector3(), slide = new THREE.Vector3(1, 0, 0);
  try {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      point.set(0,0,0).setComponent(axis, 0.5 * sign);
      expect(wear.stamp(mesh, point, slide, { lengthM: 0.1, widthM: 0.04, strength: 0.5 })).toBe(true);
    }
    expect(wear.count).toBe(6);
    wear.material.visible = false;
    expect(wear.stamp(mesh, point, slide, { lengthM: 0.1, widthM: 0.04, strength: 0.5 })).toBe(false);
  } finally { wear.dispose(); original.dispose(); geometry.dispose(); }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' paint layers stick to a deformed scaled instance and repair clears its finish', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: { damage } } = (window as any).lumina, T = (window as any).THREE, t = T.TSL;
      engine.stop();
      const geometry = new T.PlaneGeometry(1, 1, 4, 4);
      geometry.setAttribute('rest', geometry.attributes.position.clone());
      const original = new T.MeshPhysicalNodeMaterial({ roughness: 0.18, clearcoat: 1, metalness: 0.65 });
      const wear = new damage.paintWear.constructor(original, 'rest');
      const mat = wear.material;
      mat.fragmentNode = t.vec4(mat.roughnessNode, mat.metalnessNode, mat.clearcoatNode, 1);
      const mesh = new T.InstancedMesh(geometry, mat, 2);
      const transform = new T.Matrix4().makeScale(1.7, 0.65, 0.92);
      mesh.setMatrixAt(0, transform.setPosition(-1.3, 0, 0));
      mesh.setMatrixAt(1, transform.setPosition(1.3, 0, 0));
      mesh.rotation.y = 0.37;
      const scene = new T.Scene(); scene.add(mesh); mesh.updateWorldMatrix(true, false);
      const toWorld = (i: number, x: number, y: number) => {
        mesh.getMatrixAt(i, transform);
        return new T.Vector3(x, y, 0).applyMatrix4(transform).applyMatrix4(mesh.matrixWorld);
      };
      const contact = { lengthM: 0.42, widthM: 0.12, strength: 1, instanceId: 1, reachM: 0.04 };
      const hit = toWorld(1, 0, 0), slide = new T.Vector3(1, 0, 0).transformDirection(mesh.matrixWorld);
      const stamped = wear.stamp(mesh, hit, slide, contact);
      const rejected = wear.stamp(mesh, hit, slide, { ...contact, materialIndex: 8 });
      const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: true });
      const renderer = engine.renderer, previous = renderer.getRenderTarget();
      const camera = new T.OrthographicCamera(-0.001, 0.001, 0.001, -0.001, 0.1, 8);
      const sample = async (i: number, x: number, y: number) => {
        const point = toWorld(i, x, y);
        camera.position.copy(point).addScaledVector(new T.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld), 2);
        camera.lookAt(point); camera.updateMatrixWorld();
        renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(previous);
        return Array.from(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)) as number[];
      };
      try {
        const centre = await sample(1, 0, 0), neighbour = await sample(0, 0, 0);
        const along = await sample(1, 0.064, 0), across = await sample(1, 0, 0.16);
        mat.fragmentNode = null;
        mat.outputNode = t.vec4(t.diffuseColor.rgb, 1);
        mesh.setColorAt(0, new T.Color(1, 0.01, 0.01)); mesh.setColorAt(1, new T.Color(1, 0.01, 0.01));
        mat.needsUpdate = true;
        const tinted = await sample(0, 0, 0);
        // The stroke contains intact pigment, primer and narrow metallic lines.
        // Sample across the lines so a single partially rubbed pixel is not treated as bare steel.
        const exposed: number[][] = [];
        for (let j = -6; j <= 6; j++) exposed.push(await sample(1, 0, j * 0.007));
        mat.outputNode = null;
        mat.fragmentNode = t.vec4(mat.roughnessNode, mat.metalnessNode, mat.clearcoatNode, 1);
        mat.needsUpdate = true;
        const positions = geometry.attributes.position;
        for (let j = 0; j < positions.count; j++) positions.setX(j, positions.getX(j) + 0.26);
        positions.needsUpdate = true;
        mesh.position.set(23, 4, -11); mesh.rotation.y = -0.74; mesh.updateWorldMatrix(true, false);
        mesh.frustumCulled = false;
        const moved = await sample(1, 0.26, 0), old = await sample(1, 0, 0);
        for (let j = 0; j < 10; j++) wear.stamp(mesh, toWorld(1, 0.26, 0), slide, contact);
        const saturated = wear.count;
        wear.clear();
        return { stamped, rejected, exposed, tinted, centre, neighbour, along, across, moved, old, saturated, clear: await sample(1, 0.26, 0) };
      } finally { renderer.setRenderTarget(previous); target.dispose(); geometry.dispose(); original.dispose(); wear.dispose(); mesh.dispose(); }
    });
    expect(result.stamped).toBe(true); expect(result.rejected).toBe(false); expect(result.saturated).toBe(8);
    expect(result.centre[2]).toBeLessThan(0.2); expect(result.centre[0]).toBeGreaterThan(0.30);
    expect(result.tinted[1]).toBeLessThan(result.tinted[0]*0.05);
    expect(Math.max(...result.exposed.map(pixel => pixel[1] / pixel[0]))).toBeGreaterThan(0.8);
    expect(result.along[2]).toBeLessThan(0.45);
    for (const unchanged of [result.neighbour, result.across, result.old, result.clear]) {
      expect(unchanged[0]).toBeCloseTo(0.18, 3); expect(unchanged[2]).toBeCloseTo(1, 3);
    }
    for (let c = 0; c < 3; c++) expect(result.moved[c]).toBeCloseTo(result.centre[c], 2);
    expect(log.errors).toEqual([]);
  });

  test(backend + ' a wall chip changes the lighting normal and accepts new marks on a detached piece', async ({ page }) => {
    const log = watchConsole(page);
    await openScene(page, 'playground', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: { targets } } = (window as any).lumina, T = (window as any).THREE, t = T.TSL;
      engine.stop();
      const wall = targets[0], scene = new T.Scene();
      const material = new T.NodeMaterial(), source = wall.mesh.material;
      material.positionNode = source.positionNode;
      material.fragmentNode = t.vec4(source.normalNode.mul(0.5).add(0.5), 1);
      const mesh = new T.Mesh(wall.mesh.geometry, material); mesh.frustumCulled = false; scene.add(mesh);
      const pivot = new T.Vector3(0.1, 0.1, wall.size.z / 2).applyQuaternion(wall.quaternion).add(wall.position);
      const normal = new T.Vector3(0,0,1).applyQuaternion(wall.quaternion);
      const camera = new T.OrthographicCamera(-0.1, 0.1, 0.1, -0.1, 0.1, 5);
      camera.position.copy(pivot).addScaledVector(normal, 1.5); camera.lookAt(pivot);
      const renderer = engine.renderer, previous = renderer.getRenderTarget();
      const target = new T.RenderTarget(64, 64, { type: T.FloatType });
      const sample = async () => {
        renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(previous);
        return await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);
      };
      try {
        const before = await sample(); wall.markSurface(pivot, 0.065); const marked = await sample();
        const initialStrokes = wall.chips.strokeCount.value;
        wall.clearSurfaceMarks(); const cleared = await sample();
        let changed = 0, residue = 0;
        for (let i=0; i<before.length; i+=4) {
          if (Math.hypot(marked[i]-before[i],marked[i+1]-before[i+1]) > 0.025) changed++;
          residue = Math.max(residue, Math.abs(cleared[i]-before[i]));
        }
        const tangent = new T.Vector3(1,0,0).applyQuaternion(wall.quaternion);
        const start = pivot.clone().addScaledVector(tangent,-0.086), end = pivot.clone().addScaledVector(tangent,0.086);
        end.addScaledVector(normal,0.035);
        wall.markScrape(start,end,0.014);
        const strokeImage = await sample();
        let left = 0, right = 0, outside = 0;
        for (let y=0; y<64; y++) for (let x=0; x<64; x++) {
          const i=(y*64+x)*4;
          if (Math.hypot(strokeImage[i]-before[i],strokeImage[i+1]-before[i+1]) < 0.025) continue;
          if (x<18) left++;
          if (x>46) right++;
          if (Math.abs(y-31.5)>9) outside++;
        }
        wall.clearSurfaceMarks();
        const index = wall.cells.findIndex((cell: any) => cell.faces.some((f: any) => f.neighbour === -1 && f.normal.z > 0.95));
        const cell = wall.cells[index], face = cell.faces.find((f: any) => f.neighbour === -1 && f.normal.z > 0.95);
        const rest = new T.Vector3();
        for (const vertex of face.points) rest.add(vertex);
        rest.divideScalar(face.points.length);
        wall.loosen(index, new T.Vector3());
        const piece = wall.loose.get(index).body, location = new T.Vector3(137, 2, -127);
        const orientation = new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0), 1.17);
        piece.setTranslation(location, true); piece.setRotation(orientation, true);
        const world = rest.clone().sub(cell.centroid).applyQuaternion(orientation).add(location);
        const accepted = wall.markSurface(world, 0.028), owner = wall.chips.faces.array[0].w;
        const slot = wall.chips.slots[0];
        const error = Math.hypot(slot.x-rest.x,slot.y-rest.y,slot.z-rest.z);
        const wrong = wall.markSurface(world, 0.028, (index+1)%wall.cells.length);
        // A new contact inside the original box can strike the newly exposed cut
        // plane. Its normal and rest position must match that facet after rotation.
        const cut = cell.faces.find((f: any) => f.neighbour >= 0);
        const cutRest = new T.Vector3();
        for (const vertex of cut.points) cutRest.add(vertex);
        cutRest.divideScalar(cut.points.length);
        const cutWorld = cutRest.clone().sub(cell.centroid).applyQuaternion(orientation).add(location);
        const outward = cut.normal.clone();
        if (cutRest.clone().sub(cell.centroid).dot(outward) < 0) outward.negate();
        camera.position.copy(cutWorld).addScaledVector(outward.applyQuaternion(orientation), 1);
        camera.lookAt(cutWorld); wall.update(0, 1);
        const uncut = await sample();
        const fresh = wall.markSurface(cutWorld, 0.018, index), cutSlot = wall.chips.slots[1];
        const recut = await sample();
        let cutPixels = 0;
        for (let i = 0; i < recut.length; i += 4)
          if (Math.hypot(recut[i]-uncut[i], recut[i+1]-uncut[i+1]) > 0.025) cutPixels++;
        const cutFace = wall.chips.faces.array[1], cutNormal = new T.Vector3(cutFace.x, cutFace.y, cutFace.z);
        const cutError = Math.hypot(cutSlot.x-cutRest.x, cutSlot.y-cutRest.y, cutSlot.z-cutRest.z);
        const slideWorld = new T.Vector3(.08,0,.025).applyQuaternion(orientation).add(world);
        const dragged = wall.markScrape(world,slideWorld,.015,index);
        const stored = wall.chips.strokes.array[2];
        return { initialStrokes, left, right, outside, dragged, localSlide:[stored.x,stored.y,stored.z], changed, residue, index, owner, accepted, wrong, error, fresh, cutError, cutPixels, normalFit: Math.abs(cutNormal.dot(cut.normal)) };
      } finally { renderer.setRenderTarget(previous); target.dispose(); material.dispose(); }
    });
    expect(result.initialStrokes).toBe(0);
    expect(result.left).toBeGreaterThan(10); expect(result.right).toBeGreaterThan(10);
    expect(result.outside).toBe(0); expect(result.dragged).toBe(true);
    expect(result.localSlide[0]).toBeCloseTo(.08, 5); expect(result.localSlide[2]).toBeCloseTo(0, 5);
    expect(result.changed).toBeGreaterThan(110); expect(result.residue).toBeLessThan(0.001);
    expect(result.accepted).toBe(true); expect(result.wrong).toBe(false); expect(result.owner).toBe(result.index);
    expect(result.error).toBeLessThan(0.0001);
    expect(result.cutPixels).toBeGreaterThan(10); expect(result.fresh).toBe(true); expect(result.cutError).toBeLessThan(0.0001); expect(result.normalFit).toBeCloseTo(1, 4);
    expect(log.errors).toEqual([]);
  });
  test(backend + ' brick mortar fills the actual joint and leaves with its block', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'playground', 'high', backend);
    const result = await page.evaluate(async () => {
      const { engine, scene: { targets } } = (window as any).lumina, T = (window as any).THREE, t = T.TSL;
      engine.stop();
      const wall = targets.find((target: any) => target.material === 'brick');
      const index = wall.cells.findIndex((cell: any) => Math.abs(cell.centroid.x) < 0.5 && Math.abs(cell.centroid.y) < 0.4);
      const cell = wall.cells[index];
      const right = cell.faces.find((face: any) => face.normal.x > 0.99).points[0].x;
      const source = wall.mesh.material, mat = new T.NodeMaterial();
      mat.positionNode = source.positionNode; mat.fragmentNode = t.vec4(source.colorNode, 1);
      const scene = new T.Scene(), mesh = new T.Mesh(wall.mesh.geometry, mat);
      mesh.frustumCulled = false; scene.add(mesh); scene.background = new T.Color(0);
      const camera = new T.OrthographicCamera(-0.0004, 0.0004, 0.0004, -0.0004, 0.05, 3);
      const renderer = engine.renderer, prev = renderer.getRenderTarget();
      const target = new T.RenderTarget(1, 1, {type:T.FloatType});
      async function sample(x: number) {
        const at = new T.Vector3(x, cell.centroid.y, wall.size.z/2).add(wall.position);
        camera.position.copy(at); camera.position.z += 0.85; camera.lookAt(at);
        renderer.setRenderTarget(target); renderer.render(scene,camera); renderer.setRenderTarget(prev);
        return Array.from(await renderer.readRenderTargetPixelsAsync(target,0,0,1,1)) as number[];
      }
      try {
        const body = await sample(cell.centroid.x), mortar = await sample(right+0.0015);
        wall.loosen(index, new T.Vector3());
        wall.loose.get(index).body.setTranslation({x:50,y:3,z:65},true); wall.update(0,1);
        return {body, mortar, gap:await sample(right+0.0015)};
      } finally {renderer.setRenderTarget(prev); target.dispose(); mat.dispose();}
    });
    expect(result.mortar[2]).toBeGreaterThan(0.06);
    expect(result.mortar[2]/result.mortar[0]).toBeGreaterThan(2*result.body[2]/result.body[0]);
    expect(Math.max(...result.gap.slice(0,3))).toBeLessThan(0.001);
    expect(log.errors).toEqual([]);
  });
}

test('a raycast face stamps only that triangle on the selected morphed instance', () => {
  const geometry = new THREE.PlaneGeometry(3, 2, 80, 20);
  const displacement = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 2; i < displacement.length; i += 3) displacement[i] = .75;
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(displacement, 3)];
  const original = new THREE.MeshStandardNodeMaterial(), wear = new PaintWear(original);
  const mesh = new THREE.InstancedMesh(geometry, wear.material, 2), proxy = new THREE.Mesh(geometry, original);
  mesh.setMorphAt(0, proxy);
  proxy.morphTargetInfluences![0] = 1; mesh.setMorphAt(1, proxy);
  const face = 1601, index = geometry.index!, p = new THREE.Vector3(), vertex = new THREE.Vector3();
  for (let i = 0; i < 3; i++) p.add(proxy.getVertexPosition(index.getX(face * 3 + i), vertex));
  p.multiplyScalar(1 / 3);
  const slide = new THREE.Vector3(1,0,0);
  const contact = { lengthM:.2, widthM:.08, strength:1, reachM:.005, faceIndex:face, instanceId:1 };
  try {
    expect(wear.stamp(mesh, p, slide, contact)).toBe(true);
    expect(wear.stamp(mesh, p, slide, {...contact, instanceId:0})).toBe(false);
    expect(wear.stamp(mesh, p, slide, {...contact, faceIndex:50})).toBe(false);
    expect(wear.stamp(mesh, p, slide, {...contact, faceIndex:2.4})).toBe(false);
    geometry.setDrawRange(0, 60);
    expect(wear.stamp(mesh, p, slide, contact)).toBe(false);
    expect(wear.count).toBe(1);
    geometry.setDrawRange(0, Infinity);
    expect(wear.stamp(mesh, p, slide, {...contact, faceIndex:null})).toBe(true);
  } finally { mesh.dispose(); geometry.dispose(); wear.dispose(); original.dispose(); }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(backend + ' a scuff on an animated plate follows its bone through a second pose', async ({page}) => {
    const log = watchConsole(page);
    await openScene(page, 'highway', 'high', backend);
    const result = await page.evaluate(async () => {
      const {engine, scene:{damage}} = (window as any).lumina, T=(window as any).THREE, t=T.TSL;
      engine.stop();
      const original = new T.MeshStandardNodeMaterial({roughness:.09}), wear = new damage.paintWear.constructor(original);
      const geometry = new T.PlaneGeometry(4, 2, 60, 12), n = geometry.attributes.position.count;
      geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Uint16Array(n*4), 4));
      const weights = new Float32Array(n*4);
      for (let i = 0; i < n; i++) weights[i*4] = 1;
      geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));
      const mat = wear.material; mat.fragmentNode = t.vec4(mat.roughnessNode, 0, 0, 1);
      const mesh = new T.SkinnedMesh(geometry, mat), bone = new T.Bone(), skeleton = new T.Skeleton([bone]);
      mesh.add(bone); mesh.bind(skeleton); mesh.frustumCulled=false;
      const scene = new T.Scene(); scene.add(mesh);
      const camera = new T.OrthographicCamera(-.002,.002,.002,-.002,.1,6);
      const renderer = engine.renderer, saved = renderer.getRenderTarget(), target = new T.RenderTarget(1,1,{type:T.FloatType});
      const point = new T.Vector3(-.59,.19,0);
      async function roughness(at:any) {
        camera.position.copy(at); camera.position.z+=2; camera.lookAt(at); camera.updateMatrixWorld();
        renderer.setRenderTarget(target); renderer.render(scene,camera); renderer.setRenderTarget(saved);
        return (await renderer.readRenderTargetPixelsAsync(target,0,0,1,1))[0];
      }
      try {
        bone.position.set(.78,.12,.7); bone.rotation.z=.21; mesh.updateMatrixWorld(true);
        const hit = point.clone().applyMatrix4(bone.matrixWorld);
        const ray = new T.Raycaster(hit.clone().add(new T.Vector3(0,0,1)), new T.Vector3(0,0,-1));
        const intersection = ray.intersectObject(mesh,false)[0];
        let calls=0;
        const getVertex=mesh.getVertexPosition;
        mesh.getVertexPosition=function(index:number, out:any) {calls++; return getVertex.call(this,index,out);};
        const stroke = {lengthM:.44,widthM:.14,strength:.52,reachM:.002,faceIndex:intersection.faceIndex};
        const stamped = wear.stamp(mesh, hit, new T.Vector3(1,0,0), stroke);
        const reads = calls, first = await roughness(hit);
        bone.position.set(-.12,.21,.45); bone.rotation.z=-.32; mesh.updateMatrixWorld(true);
        const next = point.clone().applyMatrix4(bone.matrixWorld);
        const moved = await roughness(next), previous = await roughness(hit);
        wear.clear(); const repaired = await roughness(next);
        return {stamped,reads,first,moved,previous,repaired};
      } finally {renderer.setRenderTarget(saved);target.dispose();wear.dispose();original.dispose();geometry.dispose();skeleton.dispose();}
    });
    console.log(backend,'animated contact',result);
    expect(result.stamped).toBe(true);
    expect(result.reads).toBeLessThanOrEqual(6);
    expect(result.first).toBeGreaterThan(.20);
    expect(result.moved).toBeCloseTo(result.first, 2);
    expect(result.previous).toBeCloseTo(.09, 2); expect(result.repaired).toBeCloseTo(.09, 2);
    expect(log.errors).toEqual([]);
  });
}
