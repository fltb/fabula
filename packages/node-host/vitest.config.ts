import { defineConfig } from 'vitest/config';

/**
 * Node Host adapter tests use real temporary filesystem state but must remain
 * offline, like the Core suite. Keep them package-local so their deterministic
 * boundary can be invoked without sweeping Bench, CLI, or browser tests.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['../core/tests/network-deny.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
  // Plugin tests load user module files (index.js) from OS temp directories
  // via dynamic import(). Disable the fs serving allow-list so vite-node does
  // not reject those files; the suite is already network-isolated and local.
  server: {
    fs: {
      strict: false,
    },
  },
});
