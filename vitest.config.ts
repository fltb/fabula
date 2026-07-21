import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/bench/**/*.test.ts'],
    setupFiles: ['packages/core/tests/network-deny.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
