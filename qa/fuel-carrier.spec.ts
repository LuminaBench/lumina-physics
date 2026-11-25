import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';

for (const backend of ['webgpu', 'webgl2']) {
  test(`${backend} replays fuel bursts at the moving vehicle and aircraft`, async ({ page }) => {
    const log = watchConsole(page);
    for (const [scene, trigger] of [['highway', 'Vehicle fuel burst'], ['jet', 'Airframe fuel burst']]) {
      await page.goto('/?scene=' + scene + '&tier=high' + (backend === 'webgl2' ? '&webgl=1' : ''));
      await page.waitForFunction('window.__luminaReady');
      await page.evaluate(() => {
        const host = window as any;
        host.carrierSamples = [];
        host.lumina.engine.events.on('explosion', (event: { position: number[]; kind: string }) => {
          const scene = host.lumina.scene;
          const source = scene.vehicle?.root.position ?? scene.jet.flight.state.position;
          host.carrierSamples.push({ kind: event.kind, distance: source.distanceTo(new host.THREE.Vector3(...event.position)) });
        });
      });
      const button = page.getByRole('button', { name: trigger, exact: true });
      await button.click();
      await page.waitForTimeout(600);
      await button.click();
      await page.waitForTimeout(400);
      const samples = await page.evaluate(() => (window as any).carrierSamples);
      expect(samples).toHaveLength(2);
      for (const sample of samples) {
        expect(sample.kind).toBe('petrol');
        expect(sample.distance).toBeLessThan(0.01);
      }
    }
    expect(log.errors).toEqual([]);
  });
}
