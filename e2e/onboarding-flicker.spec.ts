import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  mockDashboardSnapshot,
  WEIGHT_ONLY_SUMMARIES,
} from "./utils/mock-dashboard-snapshot";

/**
 * v1.4.15 phase-A3 fix #3 — onboarding card flicker on dashboard load.
 *
 * The previous version of `<GettingStartedChecklist>` rendered against a
 * default-true `shouldShowChecklist` decision while `measurementCount`
 * was still 0 (analytics query in flight). For a fully-onboarded user
 * (`onboardingCompletedAt != null` AND `measurementCount >= 5`), the
 * card briefly flashed before tanstack-query wrote the real value and
 * `show` flipped to false on the next render.
 *
 * This spec asserts the card is NEVER visible — at any sampled instant
 * during page load — when both:
 *   - the auth user has `onboardingCompletedAt != null`, AND
 *   - `/api/analytics` returns ≥5 measurements.
 *
 * We slow `/api/analytics` deliberately so any "render-before-data"
 * race condition would be fully visible to a Playwright `isVisible()`
 * probe; with the fix in place, the card stays unmounted because the
 * component refuses to render until `analyticsQuery.data !== undefined`.
 */
test.describe("dashboard onboarding card flicker guard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("complete-onboarding user never sees the card during load", async ({
    page,
  }) => {
    // Set the seed user to onboarding-complete BEFORE navigation. The
    // global setup leaves `onboardingCompletedAt` null by default so we
    // intercept `/api/auth/me` and pin a non-null timestamp.
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "user_e2e",
            username: "e2e-tester",
            email: "e2e@healthlog.test",
            role: "ADMIN",
            heightCm: 180,
            dateOfBirth: "1990-01-01",
            gender: "MALE",
            timezone: "Europe/Berlin",
            onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
            onboardingTourCompleted: true,
            gravatarUrl: null,
            glucoseUnit: "mg/dL",
          },
          error: null,
        }),
      }),
    );

    // Slow the analytics endpoint by ~250 ms so a race-condition flash
    // would be unmistakable to the visibility probes below; the fix
    // works by NOT rendering until this resolves, so even with the
    // delay the card stays invisible the whole time.
    //
    // v1.4.37 W-CI — match `/api/analytics` AND any sliced variant
    // (`?slice=summaries`). The previous string glob `**/api/analytics`
    // missed the IW1 slim-slice URL so the checklist hook's analytics
    // query fell through to the real route in CI; on a fresh seed user
    // the real route returns 0 measurements which flipped the
    // `stillInSetup` branch true and made the card visible — exactly
    // the regression this spec exists to catch.
    await page.route(/\/api\/analytics(\?|$)/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              // ≥5 readings → past the `measurementCount < 5` setup gate.
              WEIGHT: {
                latest: 80,
                avg7: 80,
                avg30: 80,
                slope30: { slope: 0, direction: "stable" },
                count: 30,
              },
            },
            bpInTargetPct: null,
            glucoseByContext: {},
          },
          error: null,
        }),
      });
    });

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
    // v1.7.2 — snapshot flag default-ON. The dashboard tile strip reads
    // the snapshot cell; mock it with the populated WEIGHT summary
    // (count 30 >= the 5-reading setup gate) and the same ~250 ms delay
    // so the page's snapshot-driven tiles resolve on the same race
    // window as the slowed analytics query the checklist reads. (The
    // `GettingStartedChecklist` itself reads `/api/analytics?slice=...`
    // unconditionally, so its flicker gate is unchanged.)
    await mockDashboardSnapshot(page, {
      summaries: WEIGHT_ONLY_SUMMARIES,
      delayMs: 250,
    });
    // Same `/api/dashboard/widgets` stub as the incomplete-onboarding
    // test below — keeps the dashboard from error-boundary-bailing
    // when this query 500s in CI without a real session.
    await page.route("**/api/dashboard/widgets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { tilesVisible: { weight: true, bp: true, pulse: true } },
          error: null,
        }),
      }),
    );

    const card = page.locator('[data-testid="onboarding-card"]');

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The card must stay hidden through the 250 ms analytics delay and
    // the render commit that follows. Playwright's auto-retrying
    // assertion re-evaluates every animation frame, so a 700 ms window
    // covers the delay + buffer while keeping the intent ("user never
    // sees it") explicit. The previous 50-ms poll loop had a 1-2 ms
    // race window where the analytics-pending shell could paint before
    // `useAuth().user` resolved `onboardingCompletedAt`; the auto-
    // retrying assertion collapses that window.
    await expect(card).toBeHidden({ timeout: 700 });

    // After the network has settled the card is still hidden — the
    // user is past the setup gate, so `shouldShowChecklist` returns
    // false even with real data.
    await page.waitForLoadState("networkidle");
    await expect(card).toBeHidden();
  });

  test("incomplete-onboarding user sees the card collapsed by default", async ({
    page,
  }) => {
    // Profile fields are missing AND `measurementCount < 5` so the
    // `shouldShowChecklist` gate is true (its `stillInSetup` branch is
    // satisfied by the measurement-count condition). With the fix, the
    // card mounts collapsed: header + progress meter visible, full row
    // list hidden until the user clicks the chevron.
    //
    // v1.4.22 C4 — the onboarding redirect now lives in `proxy.ts`,
    // not in `<AuthShell>`. The proxy reads the `hl_onboarding` cookie
    // (which the auth routes mirror from the DB). Our storageState
    // belongs to a fully-onboarded user (no `hl_onboarding` cookie),
    // so the proxy passes the dashboard through even when the mocked
    // `/api/auth/me` reports `onboardingCompletedAt: null`. That's the
    // exact case this test wants to cover — the checklist mounts
    // because `measurementCount < 5` AND `onboardingCompletedAt` is
    // null, but the page itself still paints.
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "user_e2e",
            username: "e2e-tester",
            email: "e2e@healthlog.test",
            role: "ADMIN",
            heightCm: null,
            dateOfBirth: null,
            gender: null,
            timezone: "Europe/Berlin",
            onboardingCompletedAt: null,
            // Suppress the spotlight tour overlay during this spec so
            // the onboarding-card visibility probe is not occluded by
            // the tour's z-200 dialog. The tour itself is exercised by
            // a dedicated spec — not in scope here.
            onboardingTourCompleted: true,
            gravatarUrl: null,
            glucoseUnit: "mg/dL",
          },
          error: null,
        }),
      }),
    );
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
          error: null,
        }),
      }),
    );
    // v1.7.2 — snapshot flag default-ON. Empty snapshot summaries keep
    // the tile strip blank (the user is still in setup) so the page
    // renders the onboarding card path deterministically.
    await mockDashboardSnapshot(page, { summaries: {} });
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
    await page.route("**/api/medications", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], error: null }),
      }),
    );
    await page.route("**/api/withings/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { connected: false }, error: null }),
      }),
    );
    await page.route("**/api/notifications/preferences", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { channels: [] }, error: null }),
      }),
    );
    // v1.4.16 Wave-C — the dashboard added `/api/dashboard/widgets`
    // (A5 tile-strip persistence) since this spec was written. Without
    // a stub the unauthenticated layout query 500s in CI and React
    // Query's error boundary swallows the page render before
    // `<GettingStartedChecklist>` can mount.
    await page.route("**/api/dashboard/widgets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { tilesVisible: { weight: true, bp: true, pulse: true } },
          error: null,
        }),
      }),
    );

    // Make sure no localStorage carries an `expanded=1` from a previous
    // session — the spec asserts the *default* is collapsed.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("healthlog-getting-started-expanded");
      } catch {
        /* storage unavailable */
      }
    });

    const card = page.locator('[data-testid="onboarding-card"]');

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await expect(card).toBeVisible({ timeout: 10_000 });

    // The collapsed shell exposes the toggle as `aria-expanded=false`;
    // the row list (`#getting-started-body`) is unmounted, not just
    // hidden, so a `count()` query returns 0 in the collapsed state.
    const toggle = card.getByRole("button", { expanded: false });
    await expect(toggle).toBeVisible();
    await expect(card.locator("#getting-started-body")).toHaveCount(0);
  });
});
