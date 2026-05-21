import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Authenticated dashboard render — proves the seed user can reach the
 * home dashboard and the core widgets paint without uncaught client
 * errors.
 *
 * The dashboard self-gates each tile on (visible AND has data), so a
 * fresh seed user with zero measurements would render an empty strip
 * and skip all charts. Rather than seed measurements before this spec
 * runs (which couples the spec to a particular signature of the
 * `/api/measurements` shape), we mock `/api/analytics` and
 * `/api/dashboard/widgets` to return a deterministic dataset. The
 * widget layout + chart wrappers are pure enough that asserting on the
 * mocked-data render exercises the same code paths as a real session.
 */
test.describe("authenticated dashboard render", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Mock analytics with a populated weight summary so the weight tile
    // and chart render. `count` must be >0 for the tile to clear the
    // data-floor gate in `src/app/page.tsx`.
    //
    // v1.4.39.3 — match `/api/analytics` AND any sliced variant
    // (`?slice=summaries`). The v1.4.39.2 dashboard split mounts two
    // parallel `useAnalyticsQuery` calls; the slim variant carries a
    // `?slice=summaries` query string that the literal string glob
    // `**/api/analytics` (Playwright minimatch) refuses to match,
    // dropping the request to the real route. The seeded test user has
    // no measurements so the real route returns empty summaries, and
    // the dashboard's slim-first merge then blanked the tile strip.
    // The same trap bit `onboarding-flicker` and `mobile-viewport` in
    // v1.4.37 W-CI; the regex form is the durable fix.
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: 78.5,
                avg7: 78.2,
                avg30: 77.9,
                slope30: { slope: -0.05, direction: "down" },
                count: 30,
              },
              BLOOD_PRESSURE_SYS: {
                latest: 124,
                avg7: 122,
                avg30: 121,
                slope30: { slope: 0.1, direction: "flat" },
                count: 25,
              },
              BLOOD_PRESSURE_DIA: {
                latest: 80,
                avg7: 79,
                avg30: 78,
                slope30: { slope: 0.05, direction: "flat" },
                count: 25,
              },
              PULSE: {
                latest: 68,
                avg7: 70,
                avg30: 71,
                slope30: { slope: -0.2, direction: "down" },
                count: 25,
              },
            },
            bpInTargetPct: 78,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/mood/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], summary: { count: 0 } },
          error: null,
        }),
      }),
    );

    // The chart's per-type fetch reads `json.data.measurements` and
    // expects a `meta.total`. Return a small dataset so the chart has
    // points to plot — otherwise Recharts mounts a placeholder instead
    // of the recharts-wrapper SVG and the assertion below times out.
    await page.route("**/api/measurements*", (route) => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get("type") ?? "WEIGHT";
      const baseValue =
        type === "BLOOD_PRESSURE_SYS"
          ? 124
          : type === "BLOOD_PRESSURE_DIA"
            ? 80
            : type === "PULSE"
              ? 70
              : 78.5;
      const measurements = Array.from({ length: 10 }, (_, i) => ({
        id: `m_${type}_${i}`,
        type,
        value: baseValue + (i % 3) - 1,
        measuredAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        notes: null,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements, meta: { total: measurements.length } },
          error: null,
        }),
      });
    });

    // v1.4.28 retired the InsightAdvisorCard surface. Coach drawer
    // remains the conversational entry point on /insights, but the
    // bottom-of-page card with its own summary container is gone. The
    // dashboard render assertion below no longer touches /insights, so
    // we don't need to mock /api/insights/comprehensive or
    // /api/insights/generate any more (the iOS-consumed POST endpoint
    // is preserved server-side; only the web mount retired).
  });

  test("dashboard tile strip + chart + insight card render", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Tile strip — `data-slot="dashboard-tile-strip"` is the stable hook
    // the dashboard exposes. The component sets `data-tile-count` to the
    // active tile count; assert it's >0 so we know at least one tile
    // cleared the visibility + data-floor gate.
    const strip = page.locator('[data-slot="dashboard-tile-strip"]');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    const tileCount = Number(await strip.getAttribute("data-tile-count"));
    expect(tileCount).toBeGreaterThan(0);

    // At least one chart must render. Recharts mounts a `<svg>` with
    // `class="recharts-surface"` (or a `<div class="recharts-wrapper">`
    // around it). Use the recharts class so we don't accidentally match
    // an aria-hidden lucide-react icon.
    await expect(
      page.locator(".recharts-wrapper, .recharts-surface").first(),
    ).toBeVisible({ timeout: 10_000 });

    // v1.4.28 — the bottom-of-page InsightAdvisorCard retired; the
    // dashboard spec no longer asserts on its summary slot. The hero
    // strip and the Coach drawer carry the differentiator on /insights
    // and are covered by their own specs.

    // Filter out a small set of known-noise messages — we care about
    // real React/JS uncaught errors only. 404s from optional assets
    // (manifest icons, prefetched chunks for unrendered routes) are
    // explicitly tolerated; they don't affect the dashboard render.
    const significant = consoleErrors.filter(
      (msg) =>
        !/ResizeObserver loop|Download the React DevTools|Warning: |\[Fast Refresh\]|Failed to load resource|net::ERR_/i.test(
          msg,
        ),
    );
    expect(significant, significant.join("\n")).toEqual([]);
  });
});
