import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const hostPort =
  process.env.WORKBENCH_PORT?.trim() || process.env.WORKBENCH_HOST_PORT?.trim() || '8787';
const hostTarget = `http://127.0.0.1:${hostPort}`;

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: hostTarget, changeOrigin: false },
      '/health': { target: hostTarget, changeOrigin: false },
      '/status': { target: hostTarget, changeOrigin: false },
      '/mcp': { target: hostTarget, changeOrigin: false },
      '/yjs': { target: hostTarget, changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: false,
  },
});
