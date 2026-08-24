import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * Phase 1 delivers the harness and a smoke suite — there are no user journeys
 * yet, and writing fake ones would be theatre. Phase 2 adds the three that
 * matter: scan -> submit -> approve -> appears, the keyboard moderation queue,
 * and the projector live update.
 *
 * Playwright starts both servers itself, so `pnpm test:e2e` works from a cold
 * checkout without a documented "first run these two commands in two terminals"
 * ritual that people inevitably get wrong.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // A test that only passes on a retry is a flaky test. Failing the build on a
  // stray `.only` keeps that honest.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      // Attendees arrive by scanning a QR code with a phone. If it does not
      // work at this width it does not work at all.
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @eventq/api start',
      url: 'http://localhost:4000/health/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @eventq/web start',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
