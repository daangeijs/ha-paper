/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Emulator app (device + laptop terminal + side panel + web console).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: { fs: { allow: ['.', '../firmware/assets/fonts'] } },  // src/fonts/dashboard.css
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
