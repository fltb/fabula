import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const hostPort =
  process.env.WORKBENCH_PORT?.trim() || process.env.WORKBENCH_HOST_PORT?.trim() || '8787';
const hostTarget = `http://127.0.0.1:${hostPort}`;
const vitePort = Number(process.env.WORKBENCH_VITE_PORT?.trim() || '5173');

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  // micromark's dev entry imports debug as a CJS default export; served raw
  // via @fs it loses the interop `default` and vite throws "doesn't provide an
  // export named: 'default'". Pre-bundling gives esbuild the interop shim.
  optimizeDeps: {
    // CJS deps that automatic discovery cannot see get served raw via @fs
    // and lose the interop `default` (vite docs: "Dependency Pre-Bundling").
    // - debug: imported by micromark's `development` entry (dev/lib), which
    //   the production-condition scan does not follow.
    // - gaxios/extend: CJS require chain under @google/genai (pi-ai google
    //   provider, dynamic import in SettingsView); extend is extraneous.
    // Include recursively pre-bundles each entry's whole dependency tree.
    include: ['debug', 'extend', 'gaxios'],
  },
  server: {
    host: '127.0.0.1',
    port: vitePort,
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
