import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the HealthLog E2E suite.
 *
 * The suite covers the smoke-level user paths (auth redirect, login
 * form, public version endpoint, locale switch, axe-core) without
 * needing seeded data — every spec either runs against an unauthed
 * surface or uses route interception to stub out the API. Specs that
 * need a logged-in user are kept narrow and flagged in their describe
 * block; CI runs them against a worker that seeds a deterministic test
 * user on startup.
 *
 * To run locally: `pnpm dlx playwright install --with-deps chromium`
 * once, then `pnpm e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["iPhone 13"],
      },
    },
  ],

  // Spin up the production build for E2E. `pnpm build` is run
  // separately by CI before the suite — locally, set E2E_SKIP_WEB_SERVER=1
  // to point at an already-running dev server.
  webServer: process.env.E2E_SKIP_WEB_SERVER
    ? undefined
    : {
        command: "pnpm exec next start --port 3000",
        url: "http://localhost:3000/api/version",
        timeout: 60_000,
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
        stderr: "pipe",
      },
});
