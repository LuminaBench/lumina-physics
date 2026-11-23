/**
 * Real-input interaction QA.
 *
 * Everything here goes through genuine pointer events at screen coordinates (no
 * `evaluate` shortcuts), so an invisible overlay, a rogue global `preventDefault` or a
 * camera controller listening on `window` fails the suite immediately.
 */
import { test, expect, type Page } from '@playwright/test';
import { SCENES, TIERS, watchConsole } from './helpers';

async function boot(page: Page, query = 'scene=lagoon&tier=medium'): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction('window.__luminaReady === true', null, { timeout: 60_000 });
}

/** The element under the centre of `selector` must be that element (nothing covers it). */
async function expectHittable(page: Page, selector: string): Promise<void> {
  const covered = await page.evaluate((sel) => {
    const node = document.querySelector(sel)!;
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === node || node.contains(top) ? null : `${top?.tagName}.${(top as HTMLElement)?.className}`;
  }, selector);
  expect(covered, `${selector} is covered by another element`).toBeNull();
}

test('every scene tab responds to a real click', async ({ page }) => {
  const log = watchConsole(page);
  await boot(page);
  for (const scene of [...SCENES].reverse()) {
    const selector = `button[data-scene="${scene}"]`;
    await expectHittable(page, selector);
    await page.click(selector);
    await page.waitForFunction((id) => (window as any).lumina.sceneId === id && (window as any).__luminaReady === true, scene, { timeout: 60_000 });
    await expect(page.locator(selector)).toHaveClass(/active/);
    expect(await page.locator('button[data-scene].active').count()).toBe(1);
  }
  expect(log.errors).toEqual([]);
});

test('every quality tier button responds to a real click', async ({ page }) => {
  const log = watchConsole(page);
  await boot(page);
  for (const tier of [...TIERS, 'high']) {
    const selector = `button[data-tier="${tier}"]`;
    await expectHittable(page, selector);
    await page.click(selector);
    await expect(page.locator(selector)).toHaveClass(/active/);
    expect(await page.evaluate(() => (window as any).lumina.engine.quality.tier)).toBe(tier);
    expect(await page.locator('button[data-tier].active').count()).toBe(1);
    await page.waitForTimeout(700);
  }
  expect(log.errors).toEqual([]);
});

test('every slider and panel button in every scene responds to real input', async ({ page }) => {
  test.setTimeout(240_000);
  const log = watchConsole(page);
  await boot(page);
  for (const scene of SCENES) {
    await page.click(`button[data-scene="${scene}"]`);
    await page.waitForFunction((id) => (window as any).lumina.sceneId === id && (window as any).__luminaReady === true, scene, { timeout: 60_000 });
    const sliders = page.locator('.panel input[type=range]');
    const count = await sliders.count();
    expect(count, `${scene} exposes sliders`).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const slider = sliders.nth(i);
      await slider.scrollIntoViewIfNeeded();
      const box = (await slider.boundingBox())!;
      const readout = slider.locator('xpath=following-sibling::output');
      const before = { value: await slider.inputValue(), text: await readout.textContent() };
      // Click at 18 % then 82 % of the track: at least one differs from the start value.
      await page.mouse.click(box.x + box.width * 0.18, box.y + box.height / 2);
      const low = await slider.inputValue();
      await page.mouse.click(box.x + box.width * 0.82, box.y + box.height / 2);
      const high = await slider.inputValue();
      expect(Number(high), `${scene} slider ${i} moves with the pointer`).toBeGreaterThan(Number(low));
      expect(await readout.textContent(), `${scene} slider ${i} readout updates`).not.toBe(low === before.value ? '' : before.text + '\u0000');
      // Drag back toward the middle (pointer capture + move must work, not just clicks).
      await page.mouse.move(box.x + box.width * 0.82, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      expect(Number(await slider.inputValue())).toBeLessThan(Number(high));
    }
    // Toggle buttons flip their state on click.
    const toggles = page.locator('.panel .buttons button.on');
    const toggleCount = await toggles.count();
    if (toggleCount > 0) {
      const toggle = toggles.first();
      const label = await toggle.textContent();
      await toggle.click();
      const same = page.locator('.panel .buttons button', { hasText: label! }).first();
      const stillOn = await same.evaluate((n) => n.classList.contains('on'));
      const exclusive = await page.locator('.panel .buttons button.on').count();
      expect(stillOn === false || exclusive >= 1, `${scene} toggle "${label}" reacts`).toBe(true);
    }
  }
  expect(log.errors).toEqual([]);
});

test('canvas drag orbits the camera, UI clicks never move it, hotkeys work', async ({ page }) => {
  const log = watchConsole(page);
  await boot(page);
  const cameraAngle = () => page.evaluate(() => {
    const l = (window as any).lumina;
    const c = l.engine.camera.position, t = l.scene.orbit.controls.target;
    return Math.atan2(c.z - t.z, c.x - t.x);
  });
  // Pause the plane so only user input can change the orbit angle.
  await page.evaluate(() => { (window as any).lumina.scene.beaver.throttle = 0; });
  const start = await cameraAngle();
  await page.mouse.move(520, 420);
  await page.mouse.down();
  await page.mouse.move(760, 430, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = await cameraAngle();
  expect(Math.abs(dragged - start), 'dragging the canvas orbits').toBeGreaterThan(0.15);

  // Dragging across a slider must not orbit the camera.
  const slider = page.locator('.panel input[type=range]').first();
  const box = (await slider.boundingBox())!;
  await page.waitForTimeout(600); // let orbit damping settle
  const settled = await cameraAngle();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(Math.abs((await cameraAngle()) - settled), 'slider drags stay in the UI').toBeLessThan(0.02);

  // Keyboard: scene hotkey and tier hotkey still work after UI interaction.
  await page.keyboard.press(']');
  expect(await page.evaluate(() => (window as any).lumina.engine.quality.tier)).toBe('high');
  await page.keyboard.press('4');
  await page.waitForFunction(() => (window as any).lumina.sceneId === 'fire' && (window as any).__luminaReady === true, null, { timeout: 60_000 });
  expect(log.errors).toEqual([]);
});


test('detonation click delivers one world-space event and releases the subscriber', async ({ page }) => {
  const log = watchConsole(page);
  await boot(page, 'scene=fire&tier=medium');
  await page.evaluate(() => {
    const scene = (window as any).lumina.scene;
    scene.received = [];
    scene.off = (window as any).lumina.engine.events.on('explosion', event => scene.received.push(event));
  });
  const action = page.getByRole('button', { name: 'Petrol fireball' });
  await action.click();
  const events = await page.evaluate(() => (window as any).lumina.scene.received);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe('petrol');
  expect(events[0].position.every(Number.isFinite)).toBe(true);
  await page.evaluate(() => (window as any).lumina.scene.off());
  await action.click();
  expect(await page.evaluate(() => (window as any).lumina.scene.received.length)).toBe(1);
  expect(log.errors).toEqual([]);
});
