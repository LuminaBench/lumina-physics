/**
 * Targeted substantive QA for the v2 physics modules:
 *   1. Fire lab: real UI clicks on all 8 artistic burst buttons, named events & world coupling.
 *   2. Thermo 3D: vertical wall heating, buoyant chimney climb, charring & quenching.
 *   3. Soft bodies & strands: finite real vertex/node displacement on WebGPU (via GPU storage-
 *      buffer readback when available) and WebGL 2 (CPU fallback), plus real UI controls.
 *   4. Cloth & ropes: oriented box collider pushout, cloth tearing/snap/heal & rope snapping
 *      verified in the actual solver buffers on both WebGL 2 and WebGPU.
 *   5. Inland river: actual current velocity, waterline elevation, parabolic channel profile,
 *      waterfall plunge surge, live boulder deflection/pillow wave & UI flow slider coupling.
 *
 * Every test asserts on genuine physical response (never tautologies) and zero console/shader errors.
 */
import { test, expect, type Page } from '@playwright/test';
import { changedFraction, clickPanelButton, openScene, watchConsole, type Backend, type PageLog } from './helpers';

const BACKENDS: readonly Backend[] = ['webgpu', 'webgl2'];

/** Open a scene with or without the showcase UI and confirm the expected backend booted cleanly. */
async function open(page: Page, scene: string, tier: string, backend: Backend, ui = true): Promise<PageLog> {
  const log = watchConsole(page);
  if (ui) {
    const query = new URLSearchParams({ scene, tier });
    if (backend === 'webgl2') query.set('webgl', '1');
    await page.goto(`/?${query}`);
    await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
    const booted = await page.evaluate(() => {
      const app = (window as any).lumina;
      return { id: app.sceneId, backend: app.engine.backend, errors: app.errors.slice(0, 3) };
    });
    expect(booted.id, JSON.stringify(booted.errors)).toBe(scene);
    expect(booted.backend, `expected the ${backend} backend`).toBe(backend);
  } else {
    await openScene(page, scene, tier, backend);
  }
  return log;
}

/** Verify a panel button is genuinely hittable (not occluded) and click it via a real pointer event. */
async function clickExactPanelButton(page: Page, label: string): Promise<void> {
  const button = page.locator('.panel .buttons button').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
  await button.scrollIntoViewIfNeeded();
  const occluded = await button.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === node || node.contains(top) ? null : `${top?.tagName}.${(top as HTMLElement)?.className}`;
  });
  expect(occluded, `panel button "${label}" is covered by another element`).toBeNull();
  await button.click();
}

/** Drag/click a labelled range slider in the showcase panel to a normalized fraction [0, 1]. */
async function setPanelSlider(page: Page, label: string, fraction: number): Promise<number> {
  const row = page.locator('.panel .row').filter({ has: page.locator('label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
  const slider = row.locator('input[type="range"]');
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const clamped = Math.max(0.04, Math.min(0.96, fraction));
  await page.mouse.click(box.x + box.width * clamped, box.y + box.height / 2);
  return Number(await slider.inputValue());
}

// ============================================================================
// 1. Fire Lab: real UI click on each of the 8 burst buttons & named events
// ============================================================================

const FIRE_BUTTONS = [
  { label: 'Petrol fireball', kind: 'petrol', surface: 'ground', waitMs: 550, heatsPier: true, expectPropOrDebris: true },
  { label: 'C4 shockwave', kind: 'c4', surface: 'ground', waitMs: 550, heatsPier: true, expectPropOrDebris: true },
  { label: 'Water geyser', kind: 'water', surface: 'water', waitMs: 2750, heatsPier: false, expectPropOrDebris: false },
  { label: 'Electrical arc', kind: 'electrical', surface: 'ground', waitMs: 600, heatsPier: true, expectPropOrDebris: true },
  { label: 'Vapour ignition', kind: 'thermobaric', surface: 'ground', waitMs: 850, heatsPier: true, expectPropOrDebris: true },
  { label: 'Incendiary trails', kind: 'incendiary', surface: 'ground', waitMs: 650, heatsPier: true, expectPropOrDebris: true },
  { label: 'Airburst', kind: 'airburst', surface: 'ground', waitMs: 550, heatsPier: true, expectPropOrDebris: true },
  { label: 'Volcanic burst', kind: 'magma', surface: 'ground', waitMs: 900, heatsPier: true, expectPropOrDebris: true },
] as const;

test.describe('fire lab: 8 artistic burst buttons & named events', () => {
  test('real UI click on every button emits its named event and produces physical world coupling', async ({ page }) => {
    test.setTimeout(180_000);
    const log = await open(page, 'fire', 'high', 'webgpu', true);

    // Install non-intrusive event + physics-blast + peak-trauma observers on the live engine.
    await page.evaluate(() => {
      const app = (window as any).lumina;
      const probe = {
        explosions: [] as Array<{ kind?: string; position?: number[]; intensity: number }>,
        splashes: [] as Array<{ position?: number[]; intensity: number }>,
        blasts: [] as Array<{ kind: string; radius: number; impulse: number; pos: number[] }>,
        peakTrauma: 0,
        peakWindBlasts: 0,
        active: true,
      };
      const offExp = app.engine.events.on('explosion', (ev: any) => {
        probe.explosions.push({ kind: ev.kind, position: ev.position ? [...ev.position] : undefined, intensity: ev.intensity });
      });
      const offSplash = app.engine.events.on('splash', (ev: any) => {
        probe.splashes.push({ position: ev.position ? [...ev.position] : undefined, intensity: ev.intensity });
      });
      const offBlast = app.engine.physics.onBlast((center: any, radius: number, impulse: number, kind: string) => {
        probe.blasts.push({ kind, radius, impulse, pos: [center.x, center.y, center.z] });
      });
      const sampleTrauma = () => {
        if (!probe.active) return;
        probe.peakTrauma = Math.max(probe.peakTrauma, app.engine.trauma.trauma);
        probe.peakWindBlasts = Math.max(probe.peakWindBlasts, app.engine.wind.blastCount);
        requestAnimationFrame(sampleTrauma);
      };
      requestAnimationFrame(sampleTrauma);
      (window as any).__fireProbe = probe;
      (window as any).__fireProbeDispose = () => { probe.active = false; offExp(); offSplash(); offBlast(); };
    });

    const seenKinds: string[] = [];

    for (const item of FIRE_BUTTONS) {
      // Reset pier props and thermal grid cleanly via the real UI button before each archetype.
      await clickExactPanelButton(page, 'Reset props');
      await page.waitForTimeout(220);

      const baseline = await page.evaluate(() => {
        const app = (window as any).lumina;
        const s = app.scene;
        const probe = (window as any).__fireProbe;
        probe.explosions.length = 0;
        probe.splashes.length = 0;
        probe.blasts.length = 0;
        app.engine.trauma.trauma = 0;
        probe.peakTrauma = 0;
        probe.peakWindBlasts = 0;

        const propPos = s.props.map((p: any) => {
          const t = p.body.translation();
          return [t.x, t.y, t.z];
        });
        let maxTemp = 0;
        for (let x = -4; x <= 4; x += 0.8) {
          for (let z = -4; z <= 4; z += 0.8) {
            maxTemp = Math.max(maxTemp, s.thermo.temperatureAt(x, z));
          }
        }
        return { propPos, maxTemp, count: s.explosions.count, debris: s.explosions.debris.mesh.count };
      });
      expect(baseline.maxTemp, `${item.label} starts near ambient`).toBeLessThan(40);

      const beforeShot = await page.screenshot();
      await clickExactPanelButton(page, item.label);

      // For water geyser, capture mid-column frame around 650 ms before waiting for fallback splash.
      let peakShot: Buffer;
      if (item.kind === 'water') {
        await page.waitForTimeout(650);
        peakShot = await page.screenshot();
        await page.waitForTimeout(item.waitMs - 650);
      } else {
        await page.waitForTimeout(item.waitMs);
        peakShot = await page.screenshot();
      }

      const after = await page.evaluate((beforeProps: number[][]) => {
        const app = (window as any).lumina;
        const s = app.scene;
        const probe = (window as any).__fireProbe;
        let maxPropDisp = 0;
        let maxPropSpeed = 0;
        for (let i = 0; i < Math.min(beforeProps.length, s.props.length); i++) {
          const t = s.props[i].body.translation();
          const v = s.props[i].body.linvel();
          maxPropDisp = Math.max(maxPropDisp, Math.hypot(t.x - beforeProps[i][0], t.y - beforeProps[i][1], t.z - beforeProps[i][2]));
          maxPropSpeed = Math.max(maxPropSpeed, Math.hypot(v.x, v.y, v.z));
        }
        let maxTemp = 0;
        for (let x = -5; x <= 5; x += 0.5) {
          for (let z = -5; z <= 5; z += 0.5) {
            maxTemp = Math.max(maxTemp, s.thermo.temperatureAt(x, z));
          }
        }
        return {
          explosions: probe.explosions,
          splashes: probe.splashes,
          blasts: probe.blasts,
          peakTrauma: probe.peakTrauma,
          peakWindBlasts: probe.peakWindBlasts,
          count: s.explosions.count,
          debris: s.explosions.debris.mesh.count,
          maxPropDisp,
          maxPropSpeed,
          maxTemp,
        };
      }, baseline.propPos);

      const visualDelta = changedFraction(beforeShot, peakShot, 0.04, 0.04, 0.96, 0.96, 18);
      console.log(
        `  fire [${item.label} -> ${item.kind}]: events=${after.explosions.length} blasts=${after.blasts.length} ` +
        `trauma=${after.peakTrauma.toFixed(2)} temp=${after.maxTemp.toFixed(0)}°C propDisp=${after.maxPropDisp.toFixed(2)}m ` +
        `debris=${after.debris} screen=${(visualDelta * 100).toFixed(1)}%`,
      );

      // 1. Named explosion event contract.
      expect(after.explosions, `${item.label} emits one explosion event`).toHaveLength(1);
      const ev = after.explosions[0];
      expect(ev.kind, `${item.label} event kind`).toBe(item.kind);
      expect(ev.intensity, `${item.label} positive intensity`).toBeGreaterThan(0);
      expect(ev.position?.length).toBe(3);
      for (const c of ev.position!) expect(Number.isFinite(c), `${item.label} finite position`).toBe(true);
      seenKinds.push(ev.kind!);

      // 2. Physical world-space staging & physics blast coupling.
      expect(after.count).toBe(baseline.count + 1);
      expect(after.blasts.length, `${item.label} coupled into Rapier blast callbacks`).toBeGreaterThanOrEqual(1);
      expect(after.blasts.some((b: any) => b.kind === item.kind && b.impulse > 0 && b.radius > 0), `${item.label} blast kind & impulse`).toBe(true);
      expect(after.peakTrauma, `${item.label} induced camera trauma`).toBeGreaterThan(0.02);
      expect(after.peakWindBlasts, `${item.label} injected a wind blast`).toBeGreaterThanOrEqual(1);

      if (item.kind === 'airburst') {
        expect(ev.position![1], 'airburst detonates elevated above the pier').toBeGreaterThan(5.0);
      } else if (item.kind === 'water') {
        expect(ev.position![0], 'water geyser fires out over open water').toBeGreaterThan(20);
        expect(Math.abs(ev.position![1]), 'water geyser originates near sea level').toBeLessThan(3.0);
        expect(after.splashes.length, 'water geyser emits a fallback splash event').toBeGreaterThanOrEqual(1);
      } else {
        expect(Math.abs(ev.position![0]), `${item.label} sits on the pier`).toBeLessThan(8);
        expect(Math.abs(ev.position![2]), `${item.label} sits on the pier`).toBeLessThan(8);
      }

      if (item.heatsPier) {
        expect(after.maxTemp, `${item.label} heated the pier thermal field`).toBeGreaterThan(100);
      }
      if (item.expectPropOrDebris) {
        expect(
          after.maxPropDisp > 0.01 || after.maxPropSpeed > 0.08 || after.debris > 0,
          `${item.label} moved pier props or spawned physical debris`,
        ).toBe(true);
      }
      expect(visualDelta, `${item.label} produced visible game FX on screen`).toBeGreaterThan(0.002);
    }

    expect(seenKinds).toEqual(FIRE_BUTTONS.map((b) => b.kind));
    await page.evaluate(() => (window as any).__fireProbeDispose?.());
    expect(log.errors).toEqual([]);
  });
});

// ============================================================================
// 2. Vertical wall heating (3D ThermalSurface chimney spread & charring)
// ============================================================================

test.describe('thermo 3D: vertical wall heating', () => {
  test('igniting timber cladding base drives upward chimney heating, charring, and quenching', async ({ page }) => {
    test.setTimeout(120_000);
    const log = await open(page, 'fire', 'high', 'webgpu', true);

    // Frame the timber cladding wall at (-7, 2.55, -2) so flames and char are directly visible.
    await page.evaluate(() => {
      const app = (window as any).lumina;
      const w = app.scene.wallHeat;
      app.engine.camera.position.set(w.origin.x + 1.2, w.origin.y + 0.3, w.origin.z + 6.4);
      app.engine.camera.lookAt(w.origin.x, w.origin.y, w.origin.z);
    });
    await page.waitForTimeout(300);

    const probeWall = async () => page.evaluate(() => {
      const THREE = (window as any).THREE;
      const s = (window as any).lumina.scene;
      const w = s.wallHeat;
      const th = s.thermo;
      const ox = w.origin.x, oy = w.origin.y, oz = w.origin.z;
      const baseY = oy - w.height * 0.5;
      const sampleAt = (yOffset: number) => {
        const pt = new THREE.Vector3(ox, baseY + yOffset, oz);
        return {
          tempWall: w.temperatureAtWorld(pt),
          temp3D: th.temperatureAt3D(pt.x, pt.y, pt.z),
          char: w.charAtWorld(pt),
          wet: w.wetnessAtWorld(pt),
          burning: w.isBurningAtWorld(pt),
        };
      };

      const tmp = new THREE.Vector3();
      let sumY = 0;
      let maxBurnY = -Infinity;
      for (const idx of w.burningList) {
        w.cellWorld(idx, tmp);
        sumY += tmp.y;
        if (tmp.y > maxBurnY) maxBurnY = tmp.y;
      }
      let charSum = 0;
      let maxChar = 0;
      let hotTexels = 0;
      const px: Uint8Array = w.texture.image.data;
      for (let i = 0; i < w.char.length; i++) {
        charSum += w.char[i];
        if (w.char[i] > maxChar) maxChar = w.char[i];
        if (px[i * 4] > 20) hotTexels++;
      }

      return {
        active: w.active,
        upwardV: w.upwardV,
        intensity: w.intensity,
        burningCells: w.burningList.length,
        surfaceBurningStat: th.stats.burningSurfaceCells,
        activeSurfacesStat: th.stats.activeSurfaces,
        steamEvents: th.stats.steamEvents,
        meanBurnY: w.burningList.length ? sumY / w.burningList.length : baseY,
        maxBurnY: Number.isFinite(maxBurnY) ? maxBurnY : baseY,
        charSum,
        maxChar,
        hotTexels,
        low: sampleAt(0.28),
        mid: sampleAt(1.55),
        upper: sampleAt(2.55),
      };
    });

    const initial = await probeWall();
    expect(initial.upwardV, 'wall tangentV points vertically upward').toBeGreaterThan(0.95);
    expect(initial.burningCells).toBe(0);
    expect(initial.low.tempWall).toBeLessThan(35);
    expect(initial.upper.tempWall).toBeLessThan(35);

    const beforeShot = await page.screenshot();
    await clickExactPanelButton(page, 'Ignite cladding');
    await page.waitForTimeout(350);
    const early = await probeWall();

    // Wait for buoyant chimney convection to climb up the 3.1 m vertical wall.
    await page.waitForTimeout(5200);
    const late = await probeWall();
    const afterShot = await page.screenshot();

    const visualDelta = changedFraction(beforeShot, afterShot, 0.15, 0.15, 0.85, 0.85, 22);
    console.log(
      `  wall heat: early low=${early.low.tempWall.toFixed(0)}°C mid=${early.mid.tempWall.toFixed(0)}°C upper=${early.upper.tempWall.toFixed(0)}°C ` +
      `(meanY=${early.meanBurnY.toFixed(2)}m) -> late low=${late.low.tempWall.toFixed(0)}°C mid=${late.mid.tempWall.toFixed(0)}°C ` +
      `upper=${late.upper.tempWall.toFixed(0)}°C (meanY=${late.meanBurnY.toFixed(2)}m, maxY=${late.maxBurnY.toFixed(2)}m, maxChar=${late.maxChar.toFixed(2)}, screen=${(visualDelta * 100).toFixed(1)}%)`,
    );

    // Base ignited immediately via 3D wall surface.
    expect(early.active).toBe(true);
    expect(early.low.tempWall, 'wall base ignited').toBeGreaterThan(350);
    expect(early.low.temp3D, '3D thermo query reflects wall heat').toBeGreaterThan(350);
    expect(early.burningCells, 'wall surface has burning cells').toBeGreaterThan(0);
    expect(early.surfaceBurningStat).toBeGreaterThan(0);
    expect(early.activeSurfacesStat).toBeGreaterThanOrEqual(1);

    // Buoyancy carried heat and flames vertically up the wall.
    expect(late.mid.tempWall, 'mid-wall heated strongly by chimney plume').toBeGreaterThan(Math.max(260, early.mid.tempWall + 80));
    expect(late.upper.tempWall, 'upper wall warmed above initial ambient').toBeGreaterThan(early.upper.tempWall + 25);
    expect(late.meanBurnY, 'burning centroid climbed vertically').toBeGreaterThan(early.meanBurnY + 0.2);
    expect(late.maxBurnY, 'top of the flame front rose vertically').toBeGreaterThan(early.maxBurnY + 0.35);

    // Charring & GPU DataTexture publication updated.
    expect(late.charSum, 'vertical wall accumulated char').toBeGreaterThan(early.charSum + 1.0);
    expect(late.maxChar, 'burnt timber reaches measurable char').toBeGreaterThan(0.12);
    expect(late.hotTexels, 'wall thermal DataTexture published hot texels').toBeGreaterThan(10);
    expect(late.intensity).toBeGreaterThan(0);
    expect(visualDelta, 'flames and charring visibly changed the wall region').toBeGreaterThan(0.004);

    // 3D quenching wets the hot wall and generates steam.
    const steamBefore = late.steamEvents;
    await page.evaluate(() => {
      const s = (window as any).lumina.scene;
      s.thermo.quench3D(s.wallHeat.origin, 2.6, 1.0);
    });
    await page.waitForTimeout(800);
    const quenched = await probeWall();
    expect(quenched.mid.wet + quenched.low.wet, '3D quench wetted the vertical wall').toBeGreaterThan(0.4);
    expect(quenched.steamEvents, 'quenching hot vertical wall produced steam').toBeGreaterThan(steamBefore);
    expect(log.errors).toEqual([]);
  });
});

// ============================================================================
// 3. SoftBody & Strand finite real displacement on WebGPU & WebGL2 (GPU readback)
// ============================================================================

test.describe('softbody & strands: finite real displacement on WebGPU and WebGL2', () => {
  for (const backend of BACKENDS) {
    test(`${backend}: softbody inflatables displace and deform finitely (real readback + UI buttons)`, async ({ page }) => {
      test.setTimeout(90_000);
      const log = await open(page, 'river', backend === 'webgl2' ? 'medium' : 'high', backend, true);

      const expectedSolver = backend === 'webgpu' ? 'gpu' : 'cpu';
      const meta = await page.evaluate(() => {
        const s = (window as any).lumina.scene;
        return {
          kind: s.soft.backend?.kind,
          vertexCount: s.soft.vertexCount,
          bodies: s.soft.bodies.length,
          hasReadback: typeof (window as any).lumina.engine.renderer.getArrayBufferAsync === 'function',
        };
      });
      expect(meta.kind).toBe(expectedSolver);
      expect(meta.vertexCount).toBeGreaterThan(60);
      expect(meta.bodies).toBeGreaterThanOrEqual(2);

      // Helper: reads ACTUAL live vertex positions (GPU storage-buffer readback on WebGPU, Float32Array on CPU).
      const captureSoftVertices = async () => page.evaluate(async () => {
        const app = (window as any).lumina;
        const soft = app.scene.soft;
        const backendObj = soft.backend;
        let data: Float32Array;
        let source: 'gpu-readback' | 'cpu' | 'proxy' = 'cpu';
        let gpuPressures: number[] = [];

        if (backendObj.kind === 'gpu') {
          if (typeof app.engine.renderer.getArrayBufferAsync === 'function' && backendObj.A?.value) {
            const ab: ArrayBuffer = await app.engine.renderer.getArrayBufferAsync(backendObj.A.value);
            data = new Float32Array(ab);
            source = 'gpu-readback';
            if (backendObj.bodyState?.value) {
              const bsAb: ArrayBuffer = await app.engine.renderer.getArrayBufferAsync(backendObj.bodyState.value);
              const bs = new Float32Array(bsAb);
              for (let b = 0; b < soft.bodies.length; b++) gpuPressures.push(bs[b * 4 + 3]);
            }
          } else {
            // Fallback only if runtime lacks GPU readback.
            source = 'proxy';
            data = new Float32Array(backendObj.vertexCount * 4);
            const v = new (window as any).THREE.Vector3();
            for (let i = 0; i < backendObj.vertexCount; i++) {
              backendObj.readVertex(i, v);
              data[i * 4] = v.x; data[i * 4 + 1] = v.y; data[i * 4 + 2] = v.z; data[i * 4 + 3] = 1;
            }
          }
        } else {
          data = backendObj.pos as Float32Array;
          source = 'cpu';
        }

        let nonFinite = 0;
        let maxAbs = 0;
        const bodies = soft.bodies.map((b: any, bi: number) => {
          const off = b.record.vertexOffset;
          const cnt = b.record.vertexCount;
          let cx = 0, cy = 0, cz = 0;
          const verts: number[] = new Array(cnt * 3);
          for (let k = 0; k < cnt; k++) {
            const gi = (off + k) * 4;
            const x = data[gi], y = data[gi + 1], z = data[gi + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
            maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
            cx += x; cy += y; cz += z;
            verts[k * 3] = x; verts[k * 3 + 1] = y; verts[k * 3 + 2] = z;
          }
          cx /= cnt; cy /= cnt; cz /= cnt;
          let meanR = 0;
          for (let k = 0; k < cnt; k++) {
            meanR += Math.hypot(verts[k * 3] - cx, verts[k * 3 + 1] - cy, verts[k * 3 + 2] - cz);
          }
          meanR /= cnt;
          return {
            id: bi,
            vertexCount: cnt,
            restRadius: b.record.restRadius,
            submersion: b.submersion,
            center: [cx, cy, cz],
            meanRadius: meanR,
            gpuPressure: gpuPressures[bi] ?? null,
            verts,
          };
        });

        return { source, nonFinite, maxAbs, bodies };
      });

      await page.waitForTimeout(700);
      const before = await captureSoftVertices();
      if (backend === 'webgpu' && meta.hasReadback) {
        expect(before.source, 'WebGPU used real storage-buffer readback').toBe('gpu-readback');
      }
      expect(before.nonFinite, 'all initial softbody vertices are finite').toBe(0);
      expect(before.maxAbs, 'all initial softbody vertices stay bounded').toBeLessThan(200);
      for (const b of before.bodies) {
        expect(b.meanRadius, `body ${b.id} holds inflated volume`).toBeGreaterThan(b.restRadius * 0.25);
        expect(b.meanRadius, `body ${b.id} has not exploded`).toBeLessThan(b.restRadius * 2.5);
        if (b.gpuPressure !== null) {
          expect(Number.isFinite(b.gpuPressure) && b.gpuPressure > 0, `body ${b.id} live GPU gas pressure`).toBe(true);
        }
      }

      // Real UI click: Push buoys (kicks buoy downward & applies localized impulse to ring).
      await clickExactPanelButton(page, 'Push buoys');
      const compressed = await captureSoftVertices();
      await page.waitForTimeout(450);
      const after = await captureSoftVertices();

      expect(after.nonFinite, 'all post-impulse softbody vertices are finite').toBe(0);
      expect(after.maxAbs, 'all post-impulse softbody vertices stay bounded').toBeLessThan(200);

      for (let bi = 0; bi < 2; bi++) {
        const a = before.bodies[bi];
        const b = after.bodies[bi];
        const centroidDisp = Math.hypot(
          b.center[0] - a.center[0],
          b.center[1] - a.center[1],
          b.center[2] - a.center[2],
        );
        let maxVertDisp = 0;
        let shapeDeformSq = 0, impactDeformSq = 0;
        const impact = compressed.bodies[bi];
        for (let k = 0; k < a.vertexCount; k++) {
          const i = k * 3;
          const d = Math.hypot(b.verts[i] - a.verts[i], b.verts[i + 1] - a.verts[i + 1], b.verts[i + 2] - a.verts[i + 2]);
          if (d > maxVertDisp) maxVertDisp = d;
          // Compare vertex offset from its body's centroid before vs after -> detects real elastic/rotational deformation.
          const ra = Math.hypot(a.verts[i] - a.center[0], a.verts[i + 1] - a.center[1], a.verts[i + 2] - a.center[2]);
          const rb = Math.hypot(b.verts[i] - b.center[0], b.verts[i + 1] - b.center[1], b.verts[i + 2] - b.center[2]);
          const ri = Math.hypot(impact.verts[i] - impact.center[0], impact.verts[i + 1] - impact.center[1], impact.verts[i + 2] - impact.center[2]);
          shapeDeformSq += (rb - ra) * (rb - ra);
          impactDeformSq += (ri - ra) * (ri - ra);
        }
        const rmsRadialDeform = Math.sqrt(Math.max(shapeDeformSq, impactDeformSq) / a.vertexCount);
        console.log(
          `  softbody [${backend}/${after.source}] body ${bi}: centroidDisp=${centroidDisp.toFixed(3)}m ` +
          `maxVertDisp=${maxVertDisp.toFixed(3)}m radialDeform=${(rmsRadialDeform * 1000).toFixed(2)}mm meanR=${b.meanRadius.toFixed(3)}m`,
        );

        expect(centroidDisp, `body ${bi} displaced physically after Push buoys`).toBeGreaterThan(0.06);
        expect(centroidDisp, `body ${bi} displacement stayed bounded`).toBeLessThan(20);
        expect(maxVertDisp, `body ${bi} vertices moved`).toBeGreaterThan(0.1);
        expect(rmsRadialDeform, `body ${bi} experienced elastic softbody deformation`).toBeGreaterThan(0.0005);
        expect(b.meanRadius, `body ${bi} preserved shell integrity`).toBeGreaterThan(b.restRadius * 0.25);
        expect(b.meanRadius, `body ${bi} did not blow up`).toBeLessThan(b.restRadius * 2.5);
      }

      // Real UI click: Restore buoys returns them cleanly near their start transforms.
      await clickExactPanelButton(page, 'Restore buoys');
      await page.waitForTimeout(300);
      const restored = await captureSoftVertices();
      expect(restored.nonFinite).toBe(0);
      const buoyDistHome = Math.hypot(restored.bodies[0].center[0] - 0.5, restored.bodies[0].center[2] - 0);
      const ringDistHome = Math.hypot(restored.bodies[1].center[0] + 1.95, restored.bodies[1].center[2] + 2.8);
      expect(buoyDistHome, 'buoy returned near start').toBeLessThan(1.8);
      expect(ringDistHome, 'ring returned near start').toBeLessThan(1.8);
      expect(log.errors).toEqual([]);
    });

    test(`${backend}: strands (grass & kelp) displace finitely under wind, gust button & current (real readback)`, async ({ page }) => {
      test.setTimeout(90_000);
      const log = await open(page, 'river', backend === 'webgl2' ? 'medium' : 'high', backend, true);

      const meta = await page.evaluate(() => {
        const s = (window as any).lumina.scene;
        return {
          kind: s.strands.backend?.kind,
          strandCount: s.strands.strandCount,
          nodeCount: s.strands.nodeCount,
          hasReadback: typeof (window as any).lumina.engine.renderer.getArrayBufferAsync === 'function',
        };
      });
      expect(meta.kind).toBe(backend === 'webgpu' ? 'gpu' : 'cpu');
      expect(meta.strandCount).toBeGreaterThan(300);

      // Snapshot the real live strand node buffer directly into page memory so we can diff all nodes with zero CDP bloat.
      const snapshotStrands = async (slot: 'before' | 'after') => page.evaluate(async (slotName: string) => {
        const app = (window as any).lumina;
        const strands = app.scene.strands;
        const backendObj = strands.backend;
        let pos: Float32Array;
        let source: 'gpu-readback' | 'cpu' | 'initial' = 'cpu';

        if (backendObj.kind === 'gpu') {
          if (typeof app.engine.renderer.getArrayBufferAsync === 'function' && backendObj.pos?.value) {
            const ab: ArrayBuffer = await app.engine.renderer.getArrayBufferAsync(backendObj.pos.value);
            pos = new Float32Array(ab);
            source = 'gpu-readback';
          } else {
            source = 'initial';
            pos = new Float32Array(backendObj.nodeCount * 4);
            const v = new (window as any).THREE.Vector3();
            for (let i = 0; i < backendObj.nodeCount; i++) {
              backendObj.readNode(i, v);
              pos[i * 4] = v.x; pos[i * 4 + 1] = v.y; pos[i * 4 + 2] = v.z; pos[i * 4 + 3] = 0.1;
            }
          }
        } else {
          pos = new Float32Array(backendObj.pos as Float32Array);
          source = 'cpu';
        }

        let nonFinite = 0;
        let maxAbs = 0;
        for (let i = 0; i < backendObj.nodeCount; i++) {
          const x = pos[i * 4], y = pos[i * 4 + 1], z = pos[i * 4 + 2];
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
          maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
        }

        const store = ((window as any).__strandSnaps ??= {});
        store[slotName] = pos;

        // Per-field geometry & buoyancy/inextensibility metrics.
        const fieldStats = strands.fields.map((f: any) => {
          const rec = f.record;
          const nps = rec.nodesPerStrand;
          const segs = nps - 1;
          let maxStretch = 0;
          let sumTipAboveRoot = 0;
          let maxTipY = -Infinity;
          for (let s = 0; s < rec.strandCount; s++) {
            const base = (rec.nodeOffset + s * nps) * 4;
            const tip = (rec.nodeOffset + s * nps + segs) * 4;
            const segLen = pos[base + 3];
            const totalLen = Math.max(segLen * segs, 1e-4);
            const reach = Math.hypot(pos[tip] - pos[base], pos[tip + 1] - pos[base + 1], pos[tip + 2] - pos[base + 2]);
            maxStretch = Math.max(maxStretch, reach / totalLen);
            sumTipAboveRoot += pos[tip + 1] - pos[base + 1];
            if (pos[tip + 1] > maxTipY) maxTipY = pos[tip + 1];
          }
          return {
            kind: rec.spec.kind,
            count: rec.strandCount,
            maxStretch,
            meanTipRise: sumTipAboveRoot / Math.max(rec.strandCount, 1),
            maxTipY,
          };
        });

        return { source, nonFinite, maxAbs, waterLevel: strands.waterLevel, fieldStats };
      }, slot);

      await page.waitForTimeout(800);
      const before = await snapshotStrands('before');
      if (backend === 'webgpu' && meta.hasReadback) {
        expect(before.source, 'WebGPU used real storage-buffer readback for strands').toBe('gpu-readback');
      }
      expect(before.nonFinite, 'all initial strand nodes are finite').toBe(0);
      expect(before.maxAbs, 'all initial strand nodes stay bounded').toBeLessThan(200);

      // Verify kelp buoyancy & waterline clamp from real node coordinates.
      const kelpBefore = before.fieldStats.find((f: any) => f.kind === 'kelp');
      expect(kelpBefore.meanTipRise, 'buoyant kelp fronds rise above their roots').toBeGreaterThan(0.05);
      expect(kelpBefore.maxTipY, 'kelp tips stay clamped under the waterline').toBeLessThanOrEqual(before.waterLevel + 0.02);

      // Drive real physical forcing: crank crosswind + real UI click "Gust through reeds".
      await page.evaluate(() => {
        const app = (window as any).lumina;
        app.scene.state.wind = 15;
        app.engine.wind.set(1.0, 15, 0.35);
      });
      await clickExactPanelButton(page, 'Gust through reeds');
      await page.waitForTimeout(450);

      const after = await snapshotStrands('after');
      expect(after.nonFinite, 'all post-gust strand nodes are finite').toBe(0);
      expect(after.maxAbs, 'all post-gust strand nodes stay bounded').toBeLessThan(200);

      const diff = await page.evaluate(() => {
        const strands = (window as any).lumina.scene.strands;
        const a: Float32Array = (window as any).__strandSnaps.before;
        const b: Float32Array = (window as any).__strandSnaps.after;
        const blast = { x: 4.7, y: 0.4, z: 2.0, r: 7.0 };

        return strands.fields.map((f: any) => {
          const rec = f.record;
          const nps = rec.nodesPerStrand;
          const segs = nps - 1;
          let maxRootDisp = 0;
          let maxTipDisp = 0;
          let sumTipDisp = 0;
          let nearCount = 0;
          let sumNearTipDisp = 0;
          let maxNearTipDisp = 0;

          for (let s = 0; s < rec.strandCount; s++) {
            const rootI = (rec.nodeOffset + s * nps) * 4;
            const tipI = (rec.nodeOffset + s * nps + segs) * 4;
            const rd = Math.hypot(b[rootI] - a[rootI], b[rootI + 1] - a[rootI + 1], b[rootI + 2] - a[rootI + 2]);
            const td = Math.hypot(b[tipI] - a[tipI], b[tipI + 1] - a[tipI + 1], b[tipI + 2] - a[tipI + 2]);
            if (rd > maxRootDisp) maxRootDisp = rd;
            if (td > maxTipDisp) maxTipDisp = td;
            sumTipDisp += td;
            if (Math.hypot(a[rootI] - blast.x, a[rootI + 2] - blast.z) < blast.r) {
              nearCount++;
              sumNearTipDisp += td;
              if (td > maxNearTipDisp) maxNearTipDisp = td;
            }
          }
          return {
            kind: rec.spec.kind,
            maxRootDisp,
            meanTipDisp: sumTipDisp / Math.max(rec.strandCount, 1),
            maxTipDisp,
            nearCount,
            meanNearTipDisp: sumNearTipDisp / Math.max(nearCount, 1),
            maxNearTipDisp,
          };
        });
      });

      const grassDiff = diff.find((d: any) => d.kind === 'grass');
      const kelpDiff = diff.find((d: any) => d.kind === 'kelp');
      console.log(
        `  strands [${backend}/${after.source}]: grass near=${grassDiff.nearCount} meanNearDisp=${(grassDiff.meanNearTipDisp * 100).toFixed(1)}cm ` +
        `maxNearDisp=${(grassDiff.maxNearTipDisp * 100).toFixed(1)}cm rootDisp=${(grassDiff.maxRootDisp * 1000).toFixed(2)}mm; ` +
        `kelp meanDisp=${(kelpDiff.meanTipDisp * 100).toFixed(1)}cm`,
      );

      // Grass blades stay anchored at their roots, bend substantially under wind/gust, and stay inextensible.
      expect(grassDiff.nearCount, 'grass blades exist near the reed gust origin').toBeGreaterThan(15);
      expect(grassDiff.maxRootDisp, 'grass roots stay anchored to terrain').toBeLessThan(0.005);
      expect(grassDiff.meanNearTipDisp, 'grass near the gust displaced measurably').toBeGreaterThan(0.008);
      expect(grassDiff.maxNearTipDisp, 'peak grass tip deflection under gust').toBeGreaterThan(0.03);
      for (const f of after.fieldStats) {
        expect(f.maxStretch, `${f.kind} remains inextensible`).toBeLessThan(1.18);
      }

      // Underwater kelp sways continuously in the river current while roots remain anchored.
      expect(kelpDiff.maxRootDisp, 'kelp holdfasts stay anchored').toBeLessThan(0.005);
      expect(kelpDiff.meanTipDisp, 'kelp tips sway in river current').toBeGreaterThan(0.005);
      expect(log.errors).toEqual([]);
    });
  }
});

// ============================================================================
// 4. Cloth & ropes: oriented box colliders, cloth tearing & rope snapping
// ============================================================================

test.describe('cloth & ropes: box colliders, tearing, and snapping', () => {
  for (const backend of BACKENDS) {
    test(`${backend}: oriented box collider pushes cloth out of its volume without blowup`, async ({ page }) => {
      test.setTimeout(90_000);
      const log = await open(page, 'playground', backend === 'webgl2' ? 'medium' : 'high', backend, false);

      // Frame flag 0 at (-6.6, 8.4, 8) so it runs at LOD 0 every frame; stream it along +X.
      await page.evaluate(() => {
        const app = (window as any).lumina;
        const s = app.scene;
        s.car.targetSpeed = 0;
        s.state.wind = 14;
        s.state.windDirection = 0;
        s.orbit.controls.target.set(-5.3, 7.6, 8);
        app.engine.camera.position.set(-5.3, 8.0, 14.5);
      });
      await page.waitForTimeout(1600);

      const readFlag = async () => page.evaluate(async () => {
        const app = (window as any).lumina;
        const cloth = app.scene.cloth;
        const flag = app.scene.flags[0];
        const rec = flag.record;
        const backendObj = cloth.backend;
        let pos: Float32Array;
        let source: 'gpu-readback' | 'cpu' = 'cpu';

        if (backendObj.kind === 'gpu') {
          const ab: ArrayBuffer = await app.engine.renderer.getArrayBufferAsync(backendObj.A.value);
          pos = new Float32Array(ab);
          source = 'gpu-readback';
        } else {
          pos = backendObj.pos as Float32Array;
          source = 'cpu';
        }

        const { cols, rows } = rec.spec;
        let nonFinite = 0;
        const pts: Array<[number, number, number, number, number]> = [];
        for (let iy = 0; iy < rows; iy++) {
          for (let ix = 0; ix < cols; ix++) {
            const gi = (rec.offset + iy * cols + ix) * 4;
            const x = pos[gi], y = pos[gi + 1], z = pos[gi + 2], invM = pos[gi + 3];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
            pts.push([x, y, z, invM, ix]);
          }
        }
        return { source, kind: backendObj.kind, cols, rows, nonFinite, pts };
      });

      const before = await readFlag();
      expect(before.kind).toBe(backend === 'webgpu' ? 'gpu' : 'cpu');
      expect(before.nonFinite).toBe(0);

      // Place a rotated box collider directly across the free mid/fly region of the streaming flag.
      const setupBox = await page.evaluate(() => {
        const THREE = (window as any).THREE;
        const s = (window as any).lumina.scene;
        const flag = s.flags[0];
        const { cols, rows } = flag.record.spec;
        const hoist = flag.point(0, Math.floor(rows / 2));
        const center = new THREE.Vector3(hoist.x + 1.45, hoist.y - 0.15, hoist.z);
        const halfExtents = new THREE.Vector3(0.55, 0.55, 0.55);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.52);
        s.cloth.addBoxCollider(center, halfExtents, quat, 0.03);
        return {
          center: [center.x, center.y, center.z],
          half: [halfExtents.x, halfExtents.y, halfExtents.z],
          quat: [quat.x, quat.y, quat.z, quat.w],
        };
      });

      // Helper to count free particles inside the oriented box.
      const measureBoxOverlap = (pts: Array<[number, number, number, number, number]>) => {
        const [cx, cy, cz] = setupBox.center;
        const [hx, hy, hz] = setupBox.half;
        const [qx, qy, qz, qw] = setupBox.quat;
        // Inverse unit quaternion = (-qx, -qy, -qz, qw).
        const iqx = -qx, iqy = -qy, iqz = -qz, iqw = qw;
        let inside = 0;
        let maxPen = 0;
        for (const [x, y, z, invM] of pts) {
          if (invM === 0) continue;
          const vx = x - cx, vy = y - cy, vz = z - cz;
          // Rotate v by inverse quaternion.
          const tx = 2 * (iqy * vz - iqz * vy);
          const ty = 2 * (iqz * vx - iqx * vz);
          const tz = 2 * (iqx * vy - iqy * vx);
          const lx = vx + iqw * tx + (iqy * tz - iqz * ty);
          const ly = vy + iqw * ty + (iqz * tx - iqx * tz);
          const lz = vz + iqw * tz + (iqx * ty - iqy * tx);
          const penX = hx - Math.abs(lx), penY = hy - Math.abs(ly), penZ = hz - Math.abs(lz);
          if (penX > 0 && penY > 0 && penZ > 0) {
            inside++;
            maxPen = Math.max(maxPen, Math.min(penX, penY, penZ));
          }
        }
        return { inside, maxPen };
      };

      const overlapBefore = measureBoxOverlap(before.pts);
      expect(overlapBefore.inside, 'flag initially occupies the box volume').toBeGreaterThan(5);

      await page.waitForTimeout(700);
      const after = await readFlag();
      expect(after.nonFinite, 'particles stay finite after box collision').toBe(0);
      const overlapAfter = measureBoxOverlap(after.pts);

      let sumDispSq = 0;
      let freeCount = 0;
      for (let i = 0; i < before.pts.length; i++) {
        if (before.pts[i][3] === 0) continue;
        const dx = after.pts[i][0] - before.pts[i][0];
        const dy = after.pts[i][1] - before.pts[i][1];
        const dz = after.pts[i][2] - before.pts[i][2];
        sumDispSq += dx * dx + dy * dy + dz * dz;
        freeCount++;
      }
      const rmsDisp = Math.sqrt(sumDispSq / Math.max(freeCount, 1));
      console.log(
        `  cloth box collider [${backend}/${after.source}]: inside ${overlapBefore.inside} -> ${overlapAfter.inside} ` +
        `(maxPen ${(overlapBefore.maxPen * 100).toFixed(1)}cm -> ${(overlapAfter.maxPen * 100).toFixed(1)}cm, rmsDisp ${(rmsDisp * 100).toFixed(1)}cm)`,
      );

      expect(overlapAfter.inside, 'oriented box collider expelled cloth from its interior').toBeLessThanOrEqual(Math.max(1, Math.floor(overlapBefore.inside * 0.1)));
      expect(overlapAfter.maxPen, 'no deep penetration remains inside box').toBeLessThan(0.05);
      expect(rmsDisp, 'cloth visibly deflected around the box').toBeGreaterThan(0.06);
      expect(log.errors).toEqual([]);
    });

    test(`${backend}: cloth tearing and rope snapping sever solver links and separate geometry physically`, async ({ page }) => {
      test.setTimeout(90_000);
      const log = await open(page, 'playground', backend === 'webgl2' ? 'medium' : 'high', backend, false);

      // Helper: reads live positions + link masks from CPU arrays or WebGPU storage buffers.
      const readPieceState = async (pieceIndex: number) => page.evaluate(async (idx: number) => {
        const app = (window as any).lumina;
        const cloth = app.scene.cloth;
        const piece = cloth.pieces[idx];
        const rec = piece.record;
        const backendObj = cloth.backend;
        let pos: Float32Array;
        let links: Float32Array;
        let source: 'gpu-readback' | 'cpu' = 'cpu';

        if (backendObj.kind === 'gpu') {
          const [abPos, abLinks] = await Promise.all([
            app.engine.renderer.getArrayBufferAsync(backendObj.A.value),
            app.engine.renderer.getArrayBufferAsync(backendObj.links.value),
          ]);
          pos = new Float32Array(abPos);
          links = new Float32Array(abLinks);
          source = 'gpu-readback';
        } else {
          pos = backendObj.pos as Float32Array;
          links = backendObj.links as Float32Array;
          source = 'cpu';
        }

        const { cols, rows, spacing } = rec.spec;
        let nonFinite = 0;
        let intactRight = 0;
        let intactDown = 0;
        const coords: number[] = new Array(rec.count * 3);
        const rightLink: number[] = new Array(rec.count);
        for (let k = 0; k < rec.count; k++) {
          const gi = (rec.offset + k) * 4;
          const x = pos[gi], y = pos[gi + 1], z = pos[gi + 2];
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++;
          coords[k * 3] = x; coords[k * 3 + 1] = y; coords[k * 3 + 2] = z;
          rightLink[k] = links[gi];
          if (links[gi] > 0.5) intactRight++;
          if (links[gi + 1] > 0.5) intactDown++;
        }
        return {
          source,
          cols,
          rows,
          spacing,
          nonFinite,
          intactRight,
          intactDown,
          tornCount: piece.tornCount,
          isTorn: piece.isTorn,
          coords,
          rightLink,
        };
      }, pieceIndex);

      // ---- Part A: Cloth tear (vertical snap across flag 0 detaches fly half from hoist) ----
      await page.evaluate(() => {
        const app = (window as any).lumina;
        const s = app.scene;
        s.car.targetSpeed = 0;
        s.state.wind = 13;
        s.state.windDirection = 0;
        s.orbit.controls.target.set(-5.3, 7.6, 8);
        app.engine.camera.position.set(-5.3, 8.0, 14.5);
      });
      await page.waitForTimeout(1400);

      const flagIdx = await page.evaluate(() => {
        const s = (window as any).lumina.scene;
        return s.cloth.pieces.indexOf(s.flags[0]);
      });
      const flagBefore = await readPieceState(flagIdx);
      const midCol = Math.floor((flagBefore.cols - 1) * 0.5);
      const seamGap = (st: typeof flagBefore, col: number) => {
        let sum = 0;
        for (let iy = 0; iy < st.rows; iy++) {
          const a = (iy * st.cols + col) * 3;
          const b = (iy * st.cols + col + 1) * 3;
          sum += Math.hypot(st.coords[b] - st.coords[a], st.coords[b + 1] - st.coords[a + 1], st.coords[b + 2] - st.coords[a + 2]);
        }
        return sum / st.rows;
      };
      const seamLinksIntact = (st: typeof flagBefore, col: number) => {
        let n = 0;
        for (let iy = 0; iy < st.rows; iy++) if (st.rightLink[iy * st.cols + col] > 0.5) n++;
        return n;
      };

      const flagGapBefore = seamGap(flagBefore, midCol);
      expect(seamLinksIntact(flagBefore, midCol), 'flag seam starts intact').toBe(flagBefore.rows);
      expect(flagBefore.isTorn).toBe(false);

      const flagShotBefore = await page.screenshot();
      const snappedFlag = await page.evaluate((col: number) => (window as any).lumina.scene.flags[0].snap(col), midCol);
      expect(snappedFlag).toBe(true);
      await page.waitForTimeout(1100);

      const flagAfter = await readPieceState(flagIdx);
      const flagShotAfter = await page.screenshot();
      const flagGapAfter = seamGap(flagAfter, midCol);
      const flagScreenDelta = changedFraction(flagShotBefore, flagShotAfter, 0.15, 0.1, 0.85, 0.9, 22);
      console.log(
        `  cloth tear [${backend}/${flagAfter.source}]: seamLinks ${seamLinksIntact(flagBefore, midCol)} -> ${seamLinksIntact(flagAfter, midCol)}, ` +
        `seamGap ${flagGapBefore.toFixed(2)}m -> ${flagGapAfter.toFixed(2)}m, screen=${(flagScreenDelta * 100).toFixed(1)}%`,
      );

      expect(flagAfter.nonFinite, 'torn cloth particles remain finite').toBe(0);
      expect(flagAfter.isTorn).toBe(true);
      expect(seamLinksIntact(flagAfter, midCol), 'all seam links severed in solver buffer').toBe(0);
      expect(flagAfter.intactRight).toBeLessThan(flagBefore.intactRight);
      expect(flagGapAfter, 'detached fly half physically separated from hoist half').toBeGreaterThan(flagGapBefore + 0.8);
      expect(flagScreenDelta, 'cloth tear changed rendered pixels').toBeGreaterThan(0.002);

      // Localized grid tear on flag 1 + heal restores solver links.
      const flag1Idx = await page.evaluate(() => {
        const s = (window as any).lumina.scene;
        return s.cloth.pieces.indexOf(s.flags[1]);
      });
      const f1Before = await readPieceState(flag1Idx);
      await page.evaluate(() => {
        const f1 = (window as any).lumina.scene.flags[1];
        f1.tearGrid(Math.floor(f1.record.spec.cols / 2), Math.floor(f1.record.spec.rows / 2), 2);
      });
      await page.waitForTimeout(300);
      const f1Torn = await readPieceState(flag1Idx);
      expect(f1Torn.intactRight + f1Torn.intactDown, 'tearGrid severed links in solver buffer').toBeLessThan(f1Before.intactRight + f1Before.intactDown);
      await page.evaluate(() => (window as any).lumina.scene.flags[1].heal());
      await page.waitForTimeout(300);
      const f1Healed = await readPieceState(flag1Idx);
      expect(f1Healed.intactRight + f1Healed.intactDown, 'heal restored all solver links').toBe(f1Before.intactRight + f1Before.intactDown);
      expect(f1Healed.isTorn).toBe(false);

      // ---- Part B: Rope snap (high-elevated power line snaps and both ends drop physically) ----
      const ropeIdx = await page.evaluate(() => {
        const app = (window as any).lumina;
        const s = app.scene;
        // Pick the center span power line running from x=-14 to x=+14 at y=9.9m, z=66m.
        const idx = s.cloth.pieces.findIndex((p: any) => {
          if (p.record.spec.kind !== 'rope') return false;
          const mid = p.point(Math.floor(p.record.spec.cols / 2), 0);
          return Math.abs(mid.x) < 3 && mid.y > 7;
        });
        s.orbit.controls.target.set(0, 7.5, 66);
        app.engine.camera.position.set(0, 8.2, 84);
        return idx;
      });
      expect(ropeIdx, 'found center high-span power line rope').toBeGreaterThanOrEqual(0);
      await page.waitForTimeout(450);

      const ropeBefore = await readPieceState(ropeIdx);
      const midSeg = Math.floor((ropeBefore.cols - 1) * 0.5);
      const ropeDist = (st: typeof ropeBefore) => {
        const a = midSeg * 3, b = (midSeg + 1) * 3;
        return Math.hypot(st.coords[b] - st.coords[a], st.coords[b + 1] - st.coords[a + 1], st.coords[b + 2] - st.coords[a + 2]);
      };
      const ropeMidY = (st: typeof ropeBefore) => 0.5 * (st.coords[midSeg * 3 + 1] + st.coords[(midSeg + 1) * 3 + 1]);

      const ropeDistBefore = ropeDist(ropeBefore);
      const ropeYBefore = ropeMidY(ropeBefore);
      expect(ropeBefore.rightLink[midSeg], 'rope middle link starts intact').toBeGreaterThan(0.5);

      const snappedRope = await page.evaluate(({ idx, seg }) => (window as any).lumina.scene.cloth.pieces[idx].snap(seg), { idx: ropeIdx, seg: midSeg });
      expect(snappedRope).toBe(true);
      await page.waitForTimeout(1050);

      const ropeAfter = await readPieceState(ropeIdx);
      const ropeDistAfter = ropeDist(ropeAfter);
      const ropeYAfter = ropeMidY(ropeAfter);
      console.log(
        `  rope snap [${backend}/${ropeAfter.source}]: link=${ropeBefore.rightLink[midSeg]} -> ${ropeAfter.rightLink[midSeg]}, ` +
        `endGap ${ropeDistBefore.toFixed(2)}m -> ${ropeDistAfter.toFixed(2)}m, midY ${ropeYBefore.toFixed(2)}m -> ${ropeYAfter.toFixed(2)}m`,
      );

      expect(ropeAfter.nonFinite, 'snapped rope particles remain finite').toBe(0);
      expect(ropeAfter.isTorn).toBe(true);
      expect(ropeAfter.rightLink[midSeg], 'rope middle link severed in solver buffer').toBeLessThan(0.5);
      expect(ropeDistAfter, 'snapped rope ends separated physically').toBeGreaterThan(ropeDistBefore + 1.5);
      expect(ropeYAfter, 'snapped rope ends fell under gravity').toBeLessThan(ropeYBefore - 1.5);
      // Both anchor endpoints stay pinned on their poles.
      const last = (ropeAfter.cols - 1) * 3;
      expect(Math.abs(ropeAfter.coords[1] - ropeBefore.coords[1]), 'left rope anchor stays pinned').toBeLessThan(0.05);
      expect(Math.abs(ropeAfter.coords[last + 1] - ropeBefore.coords[last + 1]), 'right rope anchor stays pinned').toBeLessThan(0.05);

      // Heal rope -> solver link returns to intact.
      await page.evaluate((idx: number) => (window as any).lumina.scene.cloth.pieces[idx].heal(), ropeIdx);
      await page.waitForTimeout(300);
      const ropeHealed = await readPieceState(ropeIdx);
      expect(ropeHealed.rightLink[midSeg], 'healed rope link is intact in solver buffer').toBeGreaterThan(0.5);
      expect(ropeHealed.isTorn).toBe(false);
      expect(log.errors).toEqual([]);
    });
  }
});

// ============================================================================
// 5. Actual river sampling: current velocity, waterline, boulder deflection & UI flow
// ============================================================================

test.describe('river sampling: current velocity, waterline & hydrodynamic coupling', () => {
  test('samples two-tier waterline, parabolic flow, plunge surge, boulder deflection, buoy drift & UI flow slider', async ({ page }) => {
    test.setTimeout(90_000);
    const log = await open(page, 'river', 'high', 'webgpu', true);

    // 1. Sample upper stream, lower rapids, banks, cross-channel profile, and waterfall plunge pool.
    const survey = await page.evaluate(() => {
      const THREE = (window as any).THREE;
      const s = (window as any).lumina.scene;
      const inland = s.inland;
      const falls = s.falls;
      const center = (z: number) => 2.4 * Math.sin(z * 0.052) + 0.05 * z;
      const sample = (x: number, z: number) => {
        const r = inland.sample(x, z);
        const h = inland.heightAt(x, z, -999);
        const f = inland.flowAt(x, z, new THREE.Vector3());
        return {
          inside: r.inside,
          height: r.height,
          heightAt: h,
          depth: r.depth,
          vx: r.velocity.x,
          vz: r.velocity.z,
          speed: r.speed,
          flowAtSpeed: f.length(),
          turbulence: r.turbulence,
          bankDistance: r.bankDistance,
          u: r.u,
        };
      };

      const upper = sample(center(-32), -32);
      const lower = sample(center(4), 4);
      const dryBank = sample(center(4) + 18, 4);

      // Average across multiple lower stations to verify parabolic thalweg-vs-bank profile cleanly.
      let centerSpeedSum = 0, bankSpeedSum = 0, centerDepthSum = 0, bankDepthSum = 0;
      const stations = [2, 10, 22, 34];
      for (const z of stations) {
        const cx = center(z);
        const mid = sample(cx, z);
        const edgeL = sample(cx - 5.4, z);
        const edgeR = sample(cx + 5.4, z);
        centerSpeedSum += mid.speed;
        bankSpeedSum += 0.5 * (edgeL.speed + edgeR.speed);
        centerDepthSum += mid.depth;
        bankDepthSum += 0.5 * (edgeL.depth + edgeR.depth);
      }

      // Waterfall plunge outflow right downstream of plungePosition.
      const plunge = sample(falls.plungePosition.x, falls.plungePosition.z + 1.0);
      const calm = sample(center(30), 30);

      return {
        upper,
        lower,
        dryBank,
        meanCenterSpeed: centerSpeedSum / stations.length,
        meanBankSpeed: bankSpeedSum / stations.length,
        meanCenterDepth: centerDepthSum / stations.length,
        meanBankDepth: bankDepthSum / stations.length,
        plunge,
        calm,
      };
    });

    console.log(
      `  river waterline: upper=${survey.upper.height.toFixed(2)}m (v=${survey.upper.speed.toFixed(2)}m/s) ` +
      `lower=${survey.lower.height.toFixed(2)}m (v=${survey.lower.speed.toFixed(2)}m/s) ` +
      `thalweg=${survey.meanCenterSpeed.toFixed(2)} vs bank=${survey.meanBankSpeed.toFixed(2)}m/s ` +
      `plunge=${survey.plunge.speed.toFixed(2)}m/s`,
    );

    // Two-tier elevation & channel boundaries.
    expect(survey.upper.inside, 'upper reach is inside channel').toBe(true);
    expect(survey.upper.height, 'upper stream waterline sits at the crest shelf').toBeGreaterThan(5.0);
    expect(survey.upper.vz, 'upper stream flows downstream (+Z)').toBeGreaterThan(0.5);
    expect(survey.lower.inside, 'lower rapids is inside channel').toBe(true);
    expect(Math.abs(survey.lower.height), 'lower river waterline sits near y = 0').toBeLessThan(0.6);
    expect(survey.upper.height - survey.lower.height, 'waterfall drop separates upper & lower waterlines').toBeGreaterThan(4.5);
    expect(survey.lower.vz, 'lower river flows downstream (+Z)').toBeGreaterThan(0.3);
    expect(survey.lower.speed, 'flowAt matches sample velocity magnitude').toBeCloseTo(survey.lower.flowAtSpeed, 3);

    // Outside the banks is dry.
    expect(survey.dryBank.inside).toBe(false);
    expect(survey.dryBank.heightAt, 'heightAt returns fallback outside channel').toBe(-999);
    expect(survey.dryBank.depth).toBe(0);
    expect(survey.dryBank.speed).toBe(0);
    expect(survey.dryBank.bankDistance).toBeLessThan(-5);

    // Parabolic channel physics: thalweg is faster and deeper than near-bank margins.
    expect(survey.meanCenterSpeed, 'thalweg current faster than bank margins').toBeGreaterThan(survey.meanBankSpeed * 1.3);
    expect(survey.meanCenterDepth, 'thalweg deeper than shallow banks').toBeGreaterThan(survey.meanBankDepth * 2.0);

    // Waterfall plunge pool boosts local outflow speed & whitewater turbulence.
    expect(survey.plunge.speed, 'waterfall plunge outflow boosts local current').toBeGreaterThan(survey.calm.speed * 1.2);
    expect(survey.plunge.turbulence, 'waterfall plunge boosts turbulence').toBeGreaterThan(0.7);

    // 2. Live boulder placement deflects flow around the flanks & raises upstream bow-pillow waterline.
    const rockCheck = await page.evaluate(() => {
      const s = (window as any).lumina.scene;
      const river = s.river;
      const cz = 20;
      const cx = 2.4 * Math.sin(cz * 0.052) + 0.05 * cz;
      const snap = () => ({
        up: { ...river.sample(cx, cz - 1.1), v: river.sample(cx, cz - 1.1).velocity.toArray() },
        flank: { ...river.sample(cx + 1.5, cz - 0.55), v: river.sample(cx + 1.5, cz - 0.55).velocity.toArray() },
        wake: { ...river.sample(cx, cz + 2.2), v: river.sample(cx, cz + 2.2).velocity.toArray() },
      });
      const before = snap();
      river.addRock({ x: cx, z: cz, radius: 1.4 });
      const after = snap();
      return { before, after };
    });

    expect(rockCheck.after.up.height, 'upstream bow-pillow wave lifts waterline').toBeGreaterThan(rockCheck.before.up.height + 0.05);
    expect(rockCheck.after.up.turbulence, 'upstream bow creates rapids turbulence').toBeGreaterThan(rockCheck.before.up.turbulence + 0.3);
    expect(Math.abs(rockCheck.after.flank.v[0] - rockCheck.before.flank.v[0]), 'potential-flow doublet deflects flow laterally around boulder').toBeGreaterThan(0.08);
    expect(rockCheck.after.wake.turbulence, 'downstream boulder wake boosts turbulence').toBeGreaterThan(rockCheck.before.wake.turbulence + 0.35);

    // 3. Real UI "River flow" slider updates live sampled current AND coupled strand waterCurrent.
    const lowSliderVal = await setPanelSlider(page, 'River flow', 0.08);
    await page.waitForTimeout(150);
    const lowFlow = await page.evaluate(() => {
      const THREE = (window as any).THREE;
      const s = (window as any).lumina.scene;
      const cx = 2.4 * Math.sin(2 * 0.052) + 0.05 * 2;
      return {
        optics: s.river.optics.flowScale,
        fallsFlow: s.falls.flow,
        riverSpeed: s.inland.flowAt(cx, 2, new THREE.Vector3()).length(),
        strandCurrent: s.strands.waterCurrent.length(),
      };
    });

    const highSliderVal = await setPanelSlider(page, 'River flow', 0.92);
    await page.waitForTimeout(150);
    const highFlow = await page.evaluate(() => {
      const THREE = (window as any).THREE;
      const s = (window as any).lumina.scene;
      const cx = 2.4 * Math.sin(2 * 0.052) + 0.05 * 2;
      return {
        optics: s.river.optics.flowScale,
        fallsFlow: s.falls.flow,
        riverSpeed: s.inland.flowAt(cx, 2, new THREE.Vector3()).length(),
        strandCurrent: s.strands.waterCurrent.length(),
      };
    });

    console.log(
      `  river flow slider: ${lowSliderVal.toFixed(2)} -> ${highSliderVal.toFixed(2)}, ` +
      `sampled speed ${lowFlow.riverSpeed.toFixed(2)} -> ${highFlow.riverSpeed.toFixed(2)}m/s, ` +
      `strand current ${lowFlow.strandCurrent.toFixed(2)} -> ${highFlow.strandCurrent.toFixed(2)}m/s`,
    );

    expect(highSliderVal).toBeGreaterThan(lowSliderVal * 4);
    expect(highFlow.optics).toBeGreaterThan(lowFlow.optics * 4);
    expect(highFlow.fallsFlow).toBeGreaterThan(lowFlow.fallsFlow * 4);
    expect(highFlow.riverSpeed, 'sampled river velocity scales with UI flow slider').toBeGreaterThan(lowFlow.riverSpeed * 4);
    expect(highFlow.strandCurrent, 'kelp strand current tracks sampled river flow').toBeGreaterThan(lowFlow.strandCurrent * 4);

    // 4. Floating buoy stays at the sampled waterline and drifts downstream (+Z) in the boosted current.
    await clickExactPanelButton(page, 'Restore buoys');
    await page.waitForTimeout(250);
    const driftStart = await page.evaluate(() => {
      const s = (window as any).lumina.scene;
      const c = s.buoy.getCenter();
      return { x: c.x, y: c.y, z: c.z, waterY: s.inland.heightAt(c.x, c.z), sub: s.buoy.submersion };
    });
    await page.waitForTimeout(1400);
    const driftEnd = await page.evaluate(() => {
      const s = (window as any).lumina.scene;
      const c = s.buoy.getCenter();
      return { x: c.x, y: c.y, z: c.z, waterY: s.inland.heightAt(c.x, c.z), sub: s.buoy.submersion };
    });
    console.log(
      `  buoy river drift: z ${driftStart.z.toFixed(2)} -> ${driftEnd.z.toFixed(2)}m, ` +
      `y=${driftEnd.y.toFixed(2)}m vs waterline=${driftEnd.waterY.toFixed(2)}m (sub ${(driftEnd.sub * 100).toFixed(0)}%)`,
    );

    expect(driftEnd.z - driftStart.z, 'buoy drifted downstream with sampled river current').toBeGreaterThan(0.5);
    expect(Math.abs(driftEnd.y - driftEnd.waterY), 'buoy floats near the sampled river waterline').toBeLessThan(0.65);
    expect(driftEnd.sub, 'buoy is partially submerged in the river').toBeGreaterThan(0.05);
    expect(log.errors).toEqual([]);
  });
});
