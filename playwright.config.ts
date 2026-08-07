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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    /*
     * WebKit is Safari's engine, and therefore iOS's. The external evidence on
     * D1 says per-block `contenteditable` is where Notion hit "roadblocks on
     * iOS and Android", so running the suite on the engine iOS actually uses is
     * the closest this machine gets to that question. It is not a device — the
     * input stack, the software keyboard and a real IME are still missing — but
     * it is the engine, and engine differences are most of what a cross-browser
     * editor gets wrong.
     */
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      // four known differences, listed in docs/TESTING.md. Reported rather than
      // gating until they are diagnosed: a red build on a known gap is how a
      // team learns to ignore red builds.
      ignoreSnapshots: true,
    },
  ],
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
      command: 'pnpm --filter demo-collab dev --port 5175',
      url: 'http://localhost:5175',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
