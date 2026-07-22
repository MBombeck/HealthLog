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
  testIgnore: ["setup/**"],
  globalSetup: "./e2e/setup/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  // Two retries on CI: under a loaded shared runner, DOM-settle-gated
  // assertions (wizard step transitions, list refetch → card provenance,
  // disclosure toggles) intermittently sample a mid-transition frame. A
  // retry distinguishes transient contention from a persistent break, while
  // failOnFlakyTests keeps either outcome visible to CI. The default expect
  // timeout is lifted from 5s → 10s for the same settle headroom.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // v1.18.6 — block the service worker in the test context. The
    // production build registers `/sw.js`, whose v1.18.6 data branch
    // serves allowlisted `/api/*` GET reads network-first. A worker-
    // originated `fetch` is NOT subject to Playwright's `page.route`
    // interception, so the SW would re-fetch the real (empty) backend
    // and serve that — bypassing every per-spec `route.fulfill` mock and
    // breaking read-after-write assertions (a just-created row never
    // surfaced). Blocking the worker keeps the route mocks authoritative
    // without weakening the shipped SW behaviour. Real users keep the
    // offline data cache; only the test harness opts out.
    serviceWorkers: "block",
    // HealthLog ships dark mode as the default (Dracula theme) — `globals.css`
    // sets `color-scheme: dark` on the root and the `<ThemeProvider>` defaults
    // to "system". Playwright's stock context is `colorScheme: "light"`, which
    // means axe-core was scanning a layout users never actually see (Dracula
    // greens on a light card → 1.18 contrast). Forcing the test theme to dark
    // matches what real users render on first paint and is the only honest
    // a11y baseline for this app.
    colorScheme: "dark",
    // Issue #490 — pin the browser timezone. Without this the context
    // inherits the HOST zone (UTC on CI, Europe/Berlin on a local Mac),
    // so any surface that renders a clock or a day boundary could pass
    // locally and skew two hours / a calendar day on CI. Berlin matches
    // the app's own display fallback, so CI and local render identically.
    timezoneId: "Europe/Berlin",
  },

  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        colorScheme: "dark",
      },
    },
    {
      name: "chromium-mobile",
      use: {
        // Pixel 5 — Chromium-based mobile profile so CI only needs
        // `playwright install chromium` instead of also pulling
        // webkit. iPhone-13 is intentionally avoided here; the
        // mobile-Safari smoke is exercised by the iOS app suite.
        ...devices["Pixel 5"],
        colorScheme: "dark",
      },
    },
  ],

  // Spin up the production build for E2E. `pnpm build` is run
  // separately by CI before the suite — locally, set E2E_SKIP_WEB_SERVER=1
  // to point at an already-running dev server.
  webServer: process.env.E2E_SKIP_WEB_SERVER
    ? undefined
    : {
        command: `mkdir -p .next/standalone/.next/static .next/standalone/public && cp -R .next/static/. .next/standalone/.next/static && cp -R public/. .next/standalone/public && PORT=3000 HOSTNAME=127.0.0.1 ${JSON.stringify(process.execPath)} .next/standalone/server.js`,
        url: "http://localhost:3000/api/version",
        timeout: 60_000,
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          // Native document rendering is fail-soft and outside the browser
          // suite. Disable it here so queued local thumbnail jobs cannot
          // crash the shared server inside Skia during unrelated scenarios.
          NATIVE_CANVAS: "off",
          // The dashboard RSC wrapper server-prefetches the snapshot into
          // the first HTML (HydrationBoundary). Playwright's route mocks
          // only see CLIENT fetches, so an SSR-embedded snapshot would
          // bypass `mockDashboardSnapshot` and every dashboard spec would
          // assert against the seeded account instead of its fixture.
          // Disable the prefetch for the e2e server — the suite keeps the
          // deterministic client-fetch path; the SSR fast path is
          // verified by Lighthouse/manual passes.
          DASHBOARD_SSR_PREFETCH: "false",
        },
      },
});
