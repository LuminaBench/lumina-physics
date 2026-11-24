import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5183, strictPort: false },
  build: { rollupOptions: { input: { showcase: 'index.html', profiles: 'profiles.html', field: 'field.html' } }, target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
