import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/bench/**/*.test.ts'],
    exclude: [
      // Vitest default excludes (exclude replaces defaults, so restated here).
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // Workbench Host tests run in a package-local config that permits
      // loopback sockets; they must never execute under network denial.
      'packages/workbench/**/*.test.ts',
    ],
    setupFiles: ['packages/core/tests/network-deny.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
    },
  },
  // Plugin tests (node-host) load user module files (index.js) from OS temp
  // directories via dynamic import(). Disable the fs serving allow-list so
  // vite-node does not reject those files (mirrors the node-host package
  // vitest.config.ts); the suite is already network-isolated and local.
  server: {
    fs: {
      strict: false,
    },
  },
});
