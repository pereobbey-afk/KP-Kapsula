import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('src/web'),
  plugins: [react()],
  build: {
    outDir: path.resolve('dist-web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // В разработке интерфейс и API живут на разных портах.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
