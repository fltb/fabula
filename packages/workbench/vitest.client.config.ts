import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [solid()],
  test: {
    root: import.meta.dirname,
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    setupFiles: ['tests/client/setup.ts'],
    include: ['tests/client/**/*.test.ts', 'tests/client/**/*.test.tsx'],
    // Keep client component tests independent from Core's network-denial setup.
    pool: 'threads',
  },
});
