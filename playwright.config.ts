import { defineConfig, devices } from '@playwright/test';

/**
 * The real-browser harness §12.6 asked for.
 *
 * Vitest + happy-dom covers the model and anything that only needs a DOM
 * shape. It cannot cover what this project's hardest bugs actually live in:
 * a real caret, real `beforeinput`, real composition, real selection painting
 * across elements. Those need a browser, and every one of them has already
 * cost this codebase a regression.
 *
 * The demo is the fixture rather than a bespoke page, deliberately — a harness
 * with its own mounting code drifts from the product and stops catching its
 * bugs.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // a failed interaction test is unreadable without seeing it
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  /*
   * Two demos, two servers. The collaborative one is a separate app because it
   * demonstrates something the single-player demo must not grow — two peers in
   * one page — and a spec that has to reach it needs it running.
   */
  webServer: [
    {
      command: 'pnpm --filter demo-vanilla dev --port 5173',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter demo-collab dev --port 5174',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
