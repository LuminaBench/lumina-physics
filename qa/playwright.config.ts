import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.LUMINA_QA_PORT ?? 5183);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: './test-results',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['./performance-reporter.ts'], ['json', { outputFile: './output/report.json' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // Real GPU in headless Chromium: WebGPU via Metal / Vulkan / D3D12, WebGL 2 via ANGLE.
      args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU,Vulkan', '--ignore-gpu-blocklist', '--use-angle=default'],
    },
  },
  webServer: {
    command: `npx vite ${process.env.LUMINA_QA_PRODUCTION === '1' ? 'preview' : ''} --port ${PORT} --strictPort`,
    cwd: '..',
    port: PORT,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
