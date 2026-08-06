import { defineConfig } from '@playwright/test';

// E2E specs boot the composed Host through the harness-in-spec fixture
// (`tests/e2e/harness/host-fixture.ts`): each spec calls `startHostFixture()`
// with its own temp home/project/port, so there is no shared webServer and
// no fixed base URL. `workers: 1` is intentional — E2E runs must stay
// deterministic and never contend for ports or project authority.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    // Placeholder; the harness fixture overrides the real endpoint per run.
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
