import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.19 A2 — mobile-viewport regression spec for chart cards.
 *
 * Two assertions per chart visible in the dashboard's initial paint:
 *
 *   1. Header layout integrity — the range tabs (`7 pts / 30 pts /
 *      90 pts / All`) and the cog dropdown sit on a SINGLE horizontal
 *      row inside the chart card. Pre-fix the bucket-aggregation chip
 *      ("Weekly avg" / "Monthly avg") + comparison caption pushed the
 *      tabs onto a second row on Pixel 5 (and 3-4 rows on Galaxy Fold
 *      compact). The fix stacks title + chips above tabs + cog on
 *      mobile so the tabs always own the full controls row.
 *
 *   2. X-axis tick density — Recharts' default rendered ONE tick per
 *      data point, so a 30-day Pixel 5 window painted 30 overlapping
 *      labels. The universal helper `chooseTickInterval` caps that at
 *      6 ticks for ≤ 480px viewports.
 *
 * The spec runs only on the `chromium-mobile` project (Pixel 5,
 * 393×851). Desktop sizes are exercised separately by the unit-test
 * suite for the helper.
 */

test.describe("charts — mobile-viewport regression", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");

    // Mock analytics + measurements so the chart wrappers all clear
    // their data-floor gates. Same pattern as `dashboard.spec.ts`.
    //
    // v1.4.39.3 — match `/api/analytics` AND any sliced variant
    // (`?slice=summaries`). The v1.4.39.2 dashboard split mounts the
    // slim slice in parallel; the literal `**/api/analytics` glob
    // misses the query-string form and dropped the request through to
    // the real route, blanking the tile strip + chart cards.
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
                count: 30,
              },
              BLOOD_PRESSURE_DIA: {
                latest: 80,
                avg7: 79,
                avg30: 78,
                slope30: { slope: 0.05, direction: "flat" },
                count: 30,
              },
              PULSE: {
                latest: 68,
                avg7: 70,
                avg30: 71,
                slope30: { slope: -0.2, direction: "down" },
                count: 30,
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

    // Return 30 days of measurements per type so each chart paints a
    // line with enough points that tick-density actually matters.
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
      const measurements = Array.from({ length: 30 }, (_, i) => ({
        id: `m_${type}_${i}`,
        type,
        value: baseValue + (i % 5) - 2,
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

    // Medication compliance — return 30 days of mostly-perfect
    // compliance so the chart clears the sparse-data threshold and
    // paints a line with the full window.
    await page.route("**/api/medications/intake*", (route) => {
      const points = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(Date.now() - i * 86_400_000);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        return {
          date: `${yyyy}-${mm}-${dd}`,
          scheduled: 2,
          taken: i % 7 === 0 ? 1 : 2,
        };
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: points, error: null }),
      });
    });
  });

  test("chart header keeps range tabs on a single row at Pixel 5", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Wait for at least one chart-range-tab to mount.
    await page
      .locator("[data-slot=chart-range-tab]")
      .first()
      .waitFor({ timeout: 10_000 });

    // Group the visible range tabs by their card and assert each
    // card's tabs share a single Y coordinate (== one row).
    const findings = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("div.bg-card")).filter(
        (c) => c.querySelector("[data-slot=chart-range-tab]") !== null,
      );
      return cards.map((card) => {
        const title =
          card
            .querySelector("h3, [data-slot=card-title]")
            ?.textContent?.trim() ?? "(unknown)";
        const tabs = Array.from(
          card.querySelectorAll("[data-slot=chart-range-tab]"),
        );
        const tops = tabs.map((t) => Math.round(t.getBoundingClientRect().top));
        const uniqueRows = new Set(tops).size;
        const rect = card.getBoundingClientRect();
        return {
          title,
          tabCount: tabs.length,
          uniqueRows,
          overflow: card.scrollWidth > card.clientWidth + 1,
          width: rect.width,
        };
      });
    });

    // We must find at least one charted card.
    expect(findings.length, "no chart cards detected").toBeGreaterThan(0);

    for (const f of findings) {
      expect(
        f.uniqueRows,
        `${f.title}: tabs split across ${f.uniqueRows} rows (expected 1)`,
      ).toBe(1);
      expect(f.overflow, `${f.title} card overflows horizontally`).toBe(false);
    }
  });

  test("chart x-axis paints ≤ 7 ticks at Pixel 5 with a 30-day window", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Wait for at least one chart card to mount, then scroll it into
    // view so Recharts' ResponsiveContainer measures its parent and
    // paints the SVG. On Pixel 5 the dashboard ships several stacked
    // tiles above the first chart card; the bottom-positioned axis
    // sits below the initial fold and reports as `hidden` to a raw
    // `.recharts-xAxis` visibility probe before scroll.
    const firstChartCard = page
      .locator("div.bg-card")
      .filter({ has: page.locator("[data-slot=chart-range-tab]") })
      .first();
    await firstChartCard.waitFor({ state: "visible", timeout: 10_000 });
    await firstChartCard.scrollIntoViewIfNeeded();
    // After scroll, give the chart a beat to lay out under the new
    // measured size before counting ticks. The chart card on Pixel-5
    // is taller than the 851-px viewport, so `scrollIntoViewIfNeeded`
    // brings the card's TOP into view but the bottom-anchored x-axis
    // labels can remain below the fold — `state: "attached"` is
    // sufficient and stable against viewport overflow.
    //
    // Recharts 3.x DOM shift (v1.4.25): tick labels are no longer
    // nested inside `.recharts-xAxis`. They render in a separate
    // ZIndexLayer container `.recharts-xAxis-tick-labels` that sits
    // as a sibling of the axis-line layer. Each label is a
    // `.recharts-cartesian-axis-tick-label` <g> wrapping a
    // <text class="recharts-text recharts-cartesian-axis-tick-value">.
    // Wait on the label container's text node so the assertion is
    // class-position-independent.
    await page
      .locator(".recharts-xAxis-tick-labels text")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 });

    // Count rendered x-axis tick labels per wrapper. We scope to
    // `.recharts-wrapper` so each chart is counted once, and read
    // labels from `.recharts-xAxis-tick-labels` — the new (3.x)
    // sibling container that holds the visible tick text. Empty
    // structural ticks live in `.recharts-xAxis-tick-lines` and
    // never carry text, so the labels-container is the right axis
    // for legibility.
    const tickCounts = await page.evaluate(() => {
      const wrappers = Array.from(
        document.querySelectorAll(".recharts-wrapper"),
      );
      return wrappers
        .map((wrapper) => {
          const labels = Array.from(
            wrapper.querySelectorAll(
              ".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label",
            ),
          );
          const visibleLabels = labels.filter(
            (l) => (l.textContent?.trim() ?? "").length > 0,
          );
          return visibleLabels.length;
        })
        .filter((n) => n > 0);
    });

    expect(tickCounts.length, "no recharts axes detected").toBeGreaterThan(0);

    for (const count of tickCounts) {
      // Pixel 5 = 393 px → max 6 ticks per the helper. Allow 7 for
      // Recharts' preserveStartEnd interaction.
      expect(
        count,
        `axis paints ${count} ticks (max 7 allowed)`,
      ).toBeLessThanOrEqual(7);
    }
  });
});
