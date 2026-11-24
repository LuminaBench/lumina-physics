import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers';
for (const backend of ['webgpu', 'webgl']) {
  test(
    backend + ' skiff displaces its load, heels toward either rail and drifts with host current',
    async ({ page }) => {
      const log = watchConsole(page);
      await page.goto('/coast.html?shore=cay&view=skiff&tier=medium&backend=' + backend);
      await page.waitForFunction(() => ((window as any).coastDemo?.world.engine.stats.frames ?? 0) > 5);
      await page.getByRole('slider', { name: 'Load (kg)', exact: true }).fill('90');
      await page.getByRole('slider', { name: 'Load across keel (m)', exact: true }).fill('.3');
      const result = await page.evaluate(() => {
        const { world: w, skiff: b } = (window as any).coastDemo,
          keys = new Set<string>();
        w.engine.stop();
        const ui = { ...b.load },
          calm = { ...w.ocean.params, windSpeed: 0, swellHeight: 0, chop: 0 };
        w.ocean.setSeaStates(calm, calm);
        w.ocean.optics.breakerHeight = 0;
        w.ocean.setTide();
        w.ocean.update(1 / 60, w.engine.time);
        function settle(kg: number, side: number, current: number) {
          b.reset();
          b.setLoad(kg, side);
          w.ocean.surfaceCurrent = current
            ? (_x: number, _z: number, _rate: number, out: any) => out.set(current, 0, 0)
            : undefined;
          const start = b.mesh.position.clone();
          for (let i = 0; i < 580; i++) {
            b.drive(1 / 60, keys, false);
            w.engine.physics.step(1 / 60, 4);
          }
          return { ...b.reading, x: b.mesh.position.x - start.x, z: b.mesh.position.z - start.z };
        }
        const empty = settle(0, 0, 0),
          center = settle(90, 0, 0),
          left = settle(90, -0.3, 0),
          right = settle(90, 0.3, 0);
        const north = settle(0, 0, 0.85),
          south = settle(0, 0, -0.85);
        return { ui, empty, center, left, right, north, south };
      });
      console.log(backend, result);
      expect(result.ui).toEqual({ kg: 90, side: 0.3 });
      expect(result.center.draft - result.empty.draft).toBeGreaterThan(0.035);
      expect(result.center.draft - result.empty.draft).toBeLessThan(0.095);
      expect(Math.abs(result.center.displacedLitres - result.empty.displacedLitres - 90 / 1.025)).toBeLessThan(1);
      expect(result.left.heelDeg - result.center.heelDeg).toBeGreaterThan(2);
      expect(result.right.heelDeg - result.center.heelDeg).toBeLessThan(-2);
      expect(result.north.x - result.empty.x).toBeGreaterThan(1.5);
      expect(result.south.x - result.empty.x).toBeLessThan(-1.5);
      expect(log.errors).toEqual([]);
    },
  );
}
