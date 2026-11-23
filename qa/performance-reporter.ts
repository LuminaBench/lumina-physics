import fs from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** Collect samples in the coordinator, which survives test-worker restarts. */
export default class PerformanceReporter implements Reporter {
  private performance = new Map<string, object[]>();
  private telemetry = new Map<string, object[]>();

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const [type, table] of [['performance-sample', this.performance], ['telemetry-sample', this.telemetry]] as const) {
      const values = result.annotations.filter(a => a.type === type);
      if (values.length) table.set(test.id, values.map(a => JSON.parse(a.description!)));
    }
  }

  onEnd(): void {
    if (!this.performance.size && !this.telemetry.size) return;
    const output = new URL('./output/', import.meta.url);
    fs.mkdirSync(output, { recursive: true });
    if (this.performance.size) fs.writeFileSync(new URL('performance.json', output), JSON.stringify({ results: [...this.performance.values()].flat() }, null, 2));
    if (this.telemetry.size) fs.writeFileSync(new URL('telemetry.json', output), JSON.stringify({ budgetMs: 1000 / 60, rows: [...this.telemetry.values()].flat() }, null, 2));
  }
}
