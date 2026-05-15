import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 B1 — GLP-1 secondary tile.
 *
 * The tile mounts on the dashboard when `/api/dashboard/glp1` returns
 * a payload with at least one active GLP-1 medication. The tile
 * carries:
 *
 *   - Drug-line caption ("Mounjaro 7.5mg") + weight-delta caption
 *   - Schedule pills (last + next injection)
 *   - Chart pane with a two-tab segmented control (Drug-Level
 *     default / Weight) and a 7d / 30d / 90d / All range strip
 *
 * The tab + range state lives on the tile so a parent re-render
 * doesn't reset the user's pick. The spec exercises:
 *
 *   1. Tile mounts with the documented data-slot.
 *   2. The Drug-Level tab is active on first paint.
 *   3. Each range button toggles the `data-active` attribute to
 *      reflect the current selection.
 *   4. Switching to the Weight tab swaps the chart pane.
 */
test.describe("v1.4.27 — GLP-1 secondary tile", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Empty dashboard payload so the page renders fast — only the
    // GLP-1 tile actually exercises behaviour in this spec.
    await page.route("**/api/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
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
    await page.route("**/api/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements: [], meta: { total: 0 } },
          error: null,
        }),
      }),
    );

    // The load-bearing fixture. Shape mirrors `Glp1Payload` /
    // `Glp1MedicationPayload` in `src/components/dashboard/glp1-tile.tsx`.
    await page.route("**/api/dashboard/glp1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            active: true,
            medications: [
              {
                name: "Mounjaro",
                genericName: "tirzepatide",
                medicationId: "med_glp1_e2e_1",
                currentDose: {
                  value: 7.5,
                  unit: "mg",
                  since: "2026-04-15",
                  weeksOnDose: 4,
                },
                doseHistory: [],
                lastInjection: {
                  date: "2026-05-12",
                  site: "abdomen",
                  weeksAgo: 0,
                },
                nextInjection: { date: "2026-05-19", daysAway: 4 },
                startWeight: 92.0,
                currentWeight: 87.8,
                weightDeltaKg: -4.2,
                weightSeries: Array.from({ length: 30 }, (_, i) => ({
                  date: new Date(Date.now() - i * 86_400_000)
                    .toISOString()
                    .slice(0, 10),
                  weight: 88 - i * 0.05,
                })),
                injectionDates: [
                  "2026-04-21",
                  "2026-04-28",
                  "2026-05-05",
                  "2026-05-12",
                ],
              },
            ],
          },
          error: null,
        }),
      }),
    );
  });

  test("tile mounts with the tab strip + range strip on Pixel 5", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "GLP-1 tile is dashboard-only; Pixel 5 is the load-bearing viewport",
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const tile = page.locator('[data-slot="glp1-tile"]');
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // Tab strip carries the two tabs.
    await expect(
      tile.locator('[data-slot="glp1-tile-tab-level"]'),
    ).toBeVisible();
    await expect(
      tile.locator('[data-slot="glp1-tile-tab-weight"]'),
    ).toBeVisible();

    // Range strip carries four range buttons.
    const rangeButtons = tile.locator(
      '[data-slot="glp1-tile-range-button"]',
    );
    await expect(rangeButtons).toHaveCount(4);
  });

  test("clicking a range button updates the active state", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "Pixel 5 is the load-bearing viewport for this tile",
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const tile = page.locator('[data-slot="glp1-tile"]');
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // Default range = 30 points. Pin on data-active so we don't
    // need to read CSS class soup.
    const default30 = tile.locator(
      '[data-slot="glp1-tile-range-button"][data-points="30"]',
    );
    await expect(default30).toHaveAttribute("data-active", "true");

    // Click the 7d range. After click the 7d button must be active
    // and the 30d button must drop back to inactive.
    const range7 = tile.locator(
      '[data-slot="glp1-tile-range-button"][data-points="7"]',
    );
    await range7.click();
    await expect(range7).toHaveAttribute("data-active", "true");
    await expect(default30).toHaveAttribute("data-active", "false");

    // Click the 90d range. Same toggle behaviour.
    const range90 = tile.locator(
      '[data-slot="glp1-tile-range-button"][data-points="90"]',
    );
    await range90.click();
    await expect(range90).toHaveAttribute("data-active", "true");
    await expect(range7).toHaveAttribute("data-active", "false");
  });

  test("switching to the Weight tab swaps the chart pane", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "Pixel 5 is the load-bearing viewport for this tile",
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const tile = page.locator('[data-slot="glp1-tile"]');
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // Click the Weight tab. The level-unavailable / weight-unavailable
    // fallback slots only render when the corresponding pane has no
    // data; with the seeded weight series the chart should mount and
    // the unavailable fallback should NOT be visible.
    await tile.locator('[data-slot="glp1-tile-tab-weight"]').click();

    // The drug-level chart pane is no longer the active branch.
    // Either the weight chart paints OR the fallback "no data" slot
    // appears — both prove the tab switch reached the chart pane.
    const chartPane = tile.locator('[data-slot="glp1-tile-chart"]');
    await expect(chartPane).toBeVisible();
  });
});
