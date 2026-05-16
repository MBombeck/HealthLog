import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.33 F2 regression guard — the onboarding spotlight tour overlay
 * MUST NOT intercept clicks on elements outside the spotlight area.
 *
 * Before the fix the tour rendered a single full-viewport `<button>` with
 * a `clip-path` punching a visual hole around the spotlight target. The
 * clip-path only changed paint — the button's hit-box still captured
 * every click in the viewport, so a new user could not click the header
 * "Hinzufügen" dropdown (or any other interactive element on the
 * dashboard) without the dim layer eating the click first. The audit
 * (`.planning/round-v1433-audit-runtime.md` F2) flagged this as a
 * Critical block: new users were effectively locked out.
 *
 * The fix splits the dim backdrop into up to four rectangles around the
 * spotlight (top / bottom / left / right strips) and sets
 * `pointer-events: none` on the tour root so the spotlight area is
 * genuinely click-through. This spec proves the contract: with the
 * tour mid-step on the dashboard, clicking the header "Hinzufügen"
 * button opens its dropdown menu instead of skipping the tour.
 */
test.describe("v1.4.33 F2 — onboarding tour passes clicks through spotlight", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Force the spotlight tour to mount on the dashboard. The
    // storageState user has `onboarding_tour_completed = true` so we
    // override the auth payload to flip the flag back to `false`. The
    // analytics + widget routes return a minimal-but-valid payload so
    // the dashboard paints before the tour launcher's ready gate fires.
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
            dateOfBirth: "1985-06-15",
            gender: "MALE",
            timezone: "Europe/Berlin",
            onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
            // Critical for this spec — flips the spotlight tour back on.
            onboardingTourCompleted: false,
            gravatarUrl: null,
            glucoseUnit: "mg/dL",
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: 78,
                avg7: 78,
                avg30: 78,
                slope30: { slope: 0, direction: "flat" },
                count: 30,
              },
            },
            bpInTargetPct: null,
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
    await page.route("**/api/medications", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], error: null }),
      }),
    );
  });

  test("Hinzufügen dropdown opens with the tour mounted on the dashboard", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Confirm the tour is up — proves the regression's preconditions
    // (without the tour the test would be moot).
    const tourRoot = page.locator('[data-testid="onboarding-tour"]');
    await expect(tourRoot).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="onboarding-tour-tooltip"]'),
    ).toBeVisible();

    // The header "Hinzufügen" button lives outside the spotlight on
    // step 1 (which spotlights the tile strip). Clicking it must open
    // its dropdown menu, NOT dismiss the tour. With the old single-
    // backdrop overlay this click hit the dim layer and called
    // `handleSkip` instead.
    const quickAddButton = page.locator('[data-tour-id="dashboard-quick-add"]');
    await expect(quickAddButton).toBeVisible();
    await quickAddButton.click();

    // DropdownMenuTrigger toggles `aria-expanded` — Radix sets it to
    // "true" once the menu is open. The menu items themselves render
    // in a Radix portal as `role="menuitem"`.
    await expect(quickAddButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menuitem").first()).toBeVisible();

    // The tour stays mounted — the click went to the underlying button,
    // not the dim layer.
    await expect(tourRoot).toBeVisible();
  });

  test("clicking a dim strip outside the spotlight still skips the tour", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const tourRoot = page.locator('[data-testid="onboarding-tour"]');
    await expect(tourRoot).toBeVisible({ timeout: 10_000 });

    // The dim panels are the strips around the spotlight. Clicking any
    // of them must skip the tour (preserves the "tap backdrop to
    // dismiss" affordance the v1.4.15 design shipped with).
    const dimPanel = page.locator('[data-testid="onboarding-tour-dim"]').first();
    await expect(dimPanel).toBeVisible();
    await dimPanel.click();

    // Tour unmounts. Hinzufügen stays usable.
    await expect(tourRoot).toBeHidden({ timeout: 5_000 });
  });
});
