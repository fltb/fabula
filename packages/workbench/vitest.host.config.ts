import { defineConfig } from 'vitest/config';

// Workbench Host tests exercise real loopback listeners (WebSocket upgrades,
// HTTP) and the persistence worker, so they must NOT load the Core
// network-deny setup. They run only from this package-local config; the root
// default config excludes packages/workbench entirely.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/client/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
