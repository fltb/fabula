import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// Load .env from project root so tests and CLI have OPENCODE_ZEN_API_KEY etc.
loadDotenv({ path: resolve(__dirname, '.env'), quiet: true });

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/bench/**/*.test.ts'],
    env: {
      // Pass through; dotenv has already populated process.env above.
      ...process.env,
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
