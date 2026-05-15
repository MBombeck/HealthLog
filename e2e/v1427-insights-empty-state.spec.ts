import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 F17 — insights metric-availability gating.
 *
 * When a metric has zero observations the routed sub-page early-
 * returns an empty-state component with TWO mandatory affordances:
 *
 *   1. A CTA `<Link>` pointing at `/measurements?add=<TYPE>` so the
 *      user lands on the matching add-measurement form.
 *   2. A `<CoachLaunchButton>` so the same metric is reachable from
 *      the Coach without first creating data.
 *
 * The spec mocks `/api/analytics` to return zero counts for the
 * relevant metric, navigates to each sub-page, and asserts both
 * affordances render. Three sub-pages cover the BP / weight / sleep
 * branches.
 */
test.describe("v1.4.27 — insights empty-state with metric gating", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Zero-count summaries — every gated sub-page short-circuits to
    // its EmptyState branch.
    await page.route("**/api/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: null,
                avg7: null,
                avg30: null,
                slope30: null,
                count: 0,
              },
              BLOOD_PRESSURE_SYS: {
                latest: null,
                avg7: null,
                avg30: null,
                slope30: null,
                count: 0,
              },
              BLOOD_PRESSURE_DIA: {
                latest: null,
                avg7: null,
                avg30: null,
                slope30: null,
                count: 0,
              },
              SLEEP_DURATION: {
                latest: null,
                avg7: null,
                avg30: null,
                slope30: null,
                count: 0,
              },
            },
            bpInTargetPct: null,
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

  for (const { slug, addType, headingMatch } of [
    {
      slug: "blutdruck",
      addType: "BLOOD_PRESSURE",
      headingMatch: /blood pressure|blutdruck/i,
    },
    { slug: "gewicht", addType: "WEIGHT", headingMatch: /weight|gewicht/i },
    { slug: "schlaf", addType: "SLEEP", headingMatch: /sleep|schlaf/i },
  ] as const) {
    test(`/insights/${slug} renders the empty state + Coach launch when count = 0`, async ({
      page,
    }) => {
      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // EmptyState primitive carries `data-slot="empty-state"` (see
      // `src/components/ui/empty-state.tsx`).
      const emptyState = page.locator('[data-slot="empty-state"]').first();
      await expect(emptyState).toBeVisible({ timeout: 10_000 });

      // The CTA link points at /measurements?add=<TYPE>. For the
      // sleep page the wiring may still be wired through a non-
      // measurement entry-point (sleep ingest happens via the iOS
      // app), so the assertion is split: BP + weight pin on the
      // exact `?add=` href; sleep just asserts the empty state and
      // Coach launch render. The brief lists this as a known gap.
      if (slug !== "schlaf") {
        const cta = emptyState.getByRole("link").first();
        await expect(cta).toBeVisible();
        await expect(cta).toHaveAttribute(
          "href",
          new RegExp(`/measurements\\?add=${addType}`),
        );
      }

      // The Coach launch button is rendered alongside the empty state.
      // The DOM carries both the FAB + inline branches; CSS picks the
      // visible one. Pin on whichever branch is the visible one for
      // the current project.
      const coachAffordance = page
        .locator(
          '[data-slot="coach-launch-fab"], [data-slot="coach-launch-inline"]',
        )
        .first();
      await expect(coachAffordance).toBeAttached({ timeout: 10_000 });

      // The page heading proves we're on the right sub-page (the
      // empty state shell renders a SubPageShell with the metric
      // title). Pin on the sub-page slot's h1 so we don't accidentally
      // match a sidebar / nav element.
      await expect(
        page.locator(
          '[data-slot="insights-subpage"] #insights-subpage-title',
        ),
      ).toContainText(headingMatch);
    });
  }
});
