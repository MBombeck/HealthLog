import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Coach launch surfaces on `/insights/{slug}` sub-pages.
 *
 * Contracts under test (v1.18.6, CCH-04):
 *
 *   1. The floating Coach FAB (`data-slot="coach-fab"`) is the single
 *      Coach launcher on every authenticated page. The per-metric inline
 *      launch icon the sub-page header used to mount was retired in
 *      CCH-04 — the FAB is now the only entry. An unread Coach-initiated
 *      nudge (`GET /api/insights/coach/nudge-status`) paints an unread
 *      dot (`data-slot="coach-fab-unread"`) on its corner; with nothing
 *      unread the FAB renders without the dot.
 *
 *   2. Clicking the FAB opens the Coach drawer in place — as a
 *      bottom-sheet (`data-variant="bottom-sheet"`) on `<sm`, as a
 *      right-side sheet (`data-variant="side-sheet"`) on `>=sm`.
 *
 *   3. With an unread nudge the FAB carries the dot; clicking the FAB
 *      opens the Coach drawer in place (v1.16.11 — no navigation, the
 *      page underneath stays) and the dot clears.
 *
 *   4. The drawer's "Conversations" button no longer opens an in-panel
 *      tray; it hands off to the full-page route `/coach`.
 *
 * The three sub-pages covered (blutdruck, gewicht, schlaf) span the
 * empty-state branch (no data → CTA) and the populated branch (with
 * data → full chart). The FAB launcher is present on both.
 */
test.describe("Coach launch surfaces on insights sub-pages", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Populated analytics so each sub-page paints the data branch
    // (`hasMetricData` true). The Coach FAB is the launcher on every
    // authenticated page regardless of the data branch.
    // Regex form matches the slim slice the dashboard split fires
    // alongside the thick request.
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

    // Default nudge state: nothing unread. Registered AFTER the
    // generic `**-status*` mock so it wins for the nudge endpoint
    // (Playwright matches routes in reverse registration order).
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: null, unread: false },
          error: null,
        }),
      }),
    );
  });

  for (const slug of ["blutdruck", "gewicht", "schlaf"] as const) {
    test(`/insights/${slug} mounts the dot-free Coach FAB on Pixel 5`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "mobile FAB-launcher branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // The FAB is the permanent launcher, and it is also the proof that the
      // shell got past its hydration gate: nothing — header, FAB, page body —
      // exists until `/api/auth/me` resolves, so an absence asserted above
      // this line is a statement about the gate. With no unread nudge the FAB
      // renders without the unread dot.
      const fab = page.locator('[data-slot="coach-fab"]');
      await expect(fab).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-slot="coach-fab-unread"]')).toHaveCount(
        0,
      );

      // The per-metric inline launch icon is retired; no header launcher
      // renders on the sub-page.
      await expect(page.locator('[data-slot="coach-launch-icon"]')).toHaveCount(
        0,
      );
    });

    test(`/insights/${slug} mounts the dot-free Coach FAB on Desktop Chrome`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-desktop",
        "desktop FAB-launcher branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // Same order as the mobile branch, for the same reason: the FAB is the
      // marker that the shell finished hydrating, so the retired header
      // launcher is claimed absent only after something has rendered.
      const fab = page.locator('[data-slot="coach-fab"]');
      await expect(fab).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-slot="coach-fab-unread"]')).toHaveCount(
        0,
      );

      await expect(page.locator('[data-slot="coach-launch-icon"]')).toHaveCount(
        0,
      );
    });
  }

  test("clicking the Coach FAB opens the drawer as a bottom-sheet on Pixel 5", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "drawer bottom-sheet branch is mobile-only",
    );

    // Hydration gate — the nudge-status query is fired by the FAB
    // component itself, so its response proves the FAB's click handler
    // is attached. Clicking the SSR-painted FAB any earlier is silently
    // lost (CI flake).
    const fabHydrated = page.waitForResponse(
      /\/api\/insights\/coach\/nudge-status/,
    );
    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });
    await fabHydrated;

    const fab = page.locator('[data-slot="coach-fab"]');
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await fab.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "bottom-sheet");
  });

  test("clicking the Coach FAB opens the drawer as a side-sheet on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "drawer side-sheet branch is desktop-only",
    );

    // Hydration gate — see the bottom-sheet branch above.
    const fabHydrated = page.waitForResponse(
      /\/api\/insights\/coach\/nudge-status/,
    );
    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });
    await fabHydrated;

    const fab = page.locator('[data-slot="coach-fab"]');
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await fab.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "side-sheet");
  });

  test("an unread Coach nudge paints the FAB dot and clicking the FAB opens the Coach drawer in place", async ({
    page,
  }, testInfo) => {
    // The FAB contract is viewport-independent — the test runs on
    // both projects. Override the default nudge mock with an unread
    // one (later registration wins).
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: "2026-06-09T06:00:00.000Z", unread: true },
          error: null,
        }),
      }),
    );

    // Hydration gate — the nudge-status query is fired by the FAB
    // component itself, so its response proves the FAB's click handler
    // is attached (the button paints from SSR HTML long before that).
    const fabHydrated = page.waitForResponse(
      /\/api\/insights\/coach\/nudge-status/,
    );
    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });
    await fabHydrated;

    const fab = page.locator('[data-slot="coach-fab"]');
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await expect(fab).toHaveAttribute("data-unread", "true", {
      timeout: 10_000,
    });
    await expect(page.locator('[data-slot="coach-fab-unread"]')).toBeVisible();
    await fab.click();

    // v1.16.11 — the FAB opens the side drawer in place instead of
    // navigating to `/coach`; the page underneath stays.
    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute(
      "data-variant",
      testInfo.project.name === "chromium-mobile"
        ? "bottom-sheet"
        : "side-sheet",
    );
    expect(new URL(page.url()).pathname).not.toContain("/coach");

    // Opening the Coach counts as reading the nudge on this device —
    // the dot clears and the unread flag drops off the FAB.
    await expect(page.locator('[data-slot="coach-fab-unread"]')).toHaveCount(0);
    await expect(fab).not.toHaveAttribute("data-unread", "true");
  });

  test("the drawer's Conversations button hands off to the full-page chat on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    // The in-panel history tray is gone from the drawer; the button
    // navigates to the dedicated `/coach/conversations` page, which renders
    // the search + recency-grouped conversation list.
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "exercises the desktop drawer layout",
    );

    // Hydration gate — see the bottom-sheet test above.
    const fabHydrated = page.waitForResponse(
      /\/api\/insights\/coach\/nudge-status/,
    );
    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });
    await fabHydrated;

    const fab = page.locator('[data-slot="coach-fab"]');
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await fab.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // The drawer renders no inline history column.
    await expect(
      page.locator('[data-slot="coach-drawer-history"]'),
    ).toHaveCount(0);

    const historyButton = page.locator(
      '[data-slot="coach-drawer-history-tray-trigger"]',
    );
    await expect(historyButton).toBeVisible({ timeout: 10_000 });
    await historyButton.click();

    // No in-panel tray opens — the click navigates to the dedicated
    // conversation-history page, which renders the search field + list.
    await page.waitForURL(/\/coach\/conversations(\?|$)/, { timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-conversations-page"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-conversations-search"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-conversations-list"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-drawer-history-tray"]'),
    ).toHaveCount(0);
  });
});
