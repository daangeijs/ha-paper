import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone web console for the real device (served from flash at http://ha-paper.local/).
// Talks to /api/v1 with fetch (src/webconsole/httpApi.ts). Output: index.html + app.js + app.css + the IBM Plex woff2 files (#42).
export default defineConfig({
  root: fileURLToPath(new URL('./device-ui', import.meta.url)),
  base: './',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: fileURLToPath(new URL('./dist-device-ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: '',
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: true,
    rolldownOptions: {
      // fonts keep their name (src/fonts/plex.css); the one CSS file is app.css
      output: { entryFileNames: 'app.js', chunkFileNames: 'app-[name].js', assetFileNames: (a) => (a.names[0]?.endsWith('.woff2') ? '[name][extname]' : 'app[extname]') },
    },
  },
});
