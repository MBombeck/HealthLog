import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 R3d MB4 — Coach reachability on `/insights/{slug}` sub-pages
 * plus the Coach drawer bottom-sheet branch on `<sm`.
 *
 * Two contracts under test:
 *
 *   1. Every routed Insights sub-page mounts a `<CoachLaunchButton>`.
 *      The component renders BOTH a sticky-bottom FAB
 *      (`data-slot="coach-launch-fab"`, visible on `<lg`) and an
 *      inline action (`data-slot="coach-launch-inline"`, visible on
 *      `lg+`). The DOM carries both nodes; CSS picks the visible one.
 *      The spec asserts the FAB renders on Pixel-5 and the inline
 *      action renders on Desktop Chrome.
 *
 *   2. Opening the Coach drawer on `<sm` mounts it as a bottom-sheet
 *      (`data-variant="bottom-sheet"`). On `>=sm` it mounts as a
 *      right-side sheet (`data-variant="side-sheet"`).
 *
 * The three sub-pages covered (blutdruck, gewicht, schlaf) span the
 * empty-state branch (no data → CTA + Coach launch) and the populated
 * branch (with data → full chart + Coach launch beneath).
 */
test.describe("v1.4.27 — Coach reachability on insights sub-pages", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Populated analytics so each sub-page paints the data branch
    // (`hasMetricData` true) — the Coach button is mounted at the
    // bottom of the data tree.
    // v1.4.39.3 — regex form matches the slim slice the v1.4.39.2
    // dashboard split fires alongside the thick request.
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
              SLEEP_DURATION: {
                latest: 7.5,
                avg7: 7.2,
                avg30: 7.1,
                slope30: { slope: 0.0, direction: "flat" },
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

    await page.route("**/api/insights/**-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            text: null,
            hasProvider: false,
            cached: false,
            updatedAt: null,
          },
          error: null,
        }),
      }),
    );
  });

  for (const slug of ["blutdruck", "gewicht", "schlaf"] as const) {
    test(`/insights/${slug} mounts the Coach launch button on Pixel 5 (FAB branch)`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "Pixel 5 FAB branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // The FAB slot must be present and CSS-visible at Pixel 5.
      const fab = page
        .locator('[data-slot="coach-launch-fab"]')
        .first();
      await expect(fab).toBeVisible({ timeout: 10_000 });

      // The inline branch is in the DOM but hidden via `hidden lg:inline-flex`.
      const inline = page.locator('[data-slot="coach-launch-inline"]').first();
      await expect(inline).toBeHidden();
    });

    test(`/insights/${slug} mounts the Coach launch button on Desktop Chrome (inline branch)`, async ({
      page,
    }, testInfo) => {
      // Desktop Chrome viewport is 1280 — `lg` (1024) is matched so the
      // inline branch wins; the FAB is hidden by `lg:hidden`.
      test.skip(
        testInfo.project.name !== "chromium-desktop",
        "desktop inline branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      const inline = page
        .locator('[data-slot="coach-launch-inline"]')
        .first();
      await expect(inline).toBeVisible({ timeout: 10_000 });

      const fab = page.locator('[data-slot="coach-launch-fab"]').first();
      await expect(fab).toBeHidden();
    });
  }

  test("clicking the FAB opens the Coach drawer as a bottom-sheet on Pixel 5", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "drawer bottom-sheet branch is mobile-only",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const fab = page.locator('[data-slot="coach-launch-fab"]').first();
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await fab.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "bottom-sheet");
  });

  test("clicking the inline action opens the Coach drawer as a side-sheet on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "drawer side-sheet branch is desktop-only",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const inline = page
      .locator('[data-slot="coach-launch-inline"]')
      .first();
    await expect(inline).toBeVisible({ timeout: 10_000 });
    await inline.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "side-sheet");
  });
});
