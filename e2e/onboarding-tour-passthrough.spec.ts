import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.33 F2 regression guard — the onboarding spotlight tour overlay
 * MUST NOT intercept clicks on elements outside the spotlight area.
 *
 * The original v1.4.15 tour rendered a single full-viewport `<button>`
 * with a `clip-path` punching a hole around the spotlight. The clip-path
 * only changed paint — the button's hit-box still captured every pixel,
 * so a new user could not click the header "Hinzufügen" dropdown
 * (or any other interactive element on the dashboard) without the dim
 * layer eating the click first.
 *
 * The first attempt at a fix split the dim into four panels around the
 * spotlight rect and gave each panel an `onClick={handleSkip}` with
 * `pointer-events: auto`. That made the spotlight area click-through
 * but kept blocking every other interactive element on the page: the
 * header sits ABOVE the tile-strip spotlight, so the TOP dim strip
 * still intercepted the click on the Hinzufügen button — exactly the
 * target the audit named. New users were still locked out.
 *
 * The shipped fix makes the dim purely visual. The whole tour layer is
 * `pointer-events: none`; only the tooltip card opts back into hit
 * testing. Tour state (Skip / Back / Next) lives entirely on the
 * tooltip's footer buttons — matching the spotlight-tour conventions
 * used by Joyride, Shepherd, and Intro.js. The page underneath stays
 * fully usable during the tour.
 *
 * This spec encodes both halves of that contract:
 *   1. Clicking the header Hinzufügen button mid-tour opens its
 *      dropdown menu (no element on top of it is `pointer-events:
 *      auto`).
 *   2. Clicking the tooltip's explicit Skip button dismisses the tour.
 *   3. Every dim panel computes `pointer-events: none`.
 */
test.describe("v1.4.33 F2 — onboarding tour passes clicks through to the page", () => {
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

    // The header "Hinzufügen" button lives ABOVE the spotlight on
    // step 1 (which spotlights the tile strip further down the page),
    // so a naive "dim everything outside the spotlight rect" overlay
    // covers it. The fix makes the entire tour layer pointer-events:
    // none — every dim panel and the spotlight ring are visual only.
    const quickAddButton = page.locator('[data-tour-id="dashboard-quick-add"]');
    await expect(quickAddButton).toBeVisible();

    // Forensic guard — at the quick-add button's centre, every element
    // returned by `elementsFromPoint` that belongs to the tour overlay
    // MUST be CSS-`pointer-events: none`. If any tour element above the
    // button has `pointer-events: auto`, the button's click will be
    // intercepted and the dropdown will not open. This assertion is the
    // tight version of the regression — it pinpoints WHICH element on
    // the stack is blocking, instead of just observing the symptom
    // ("button click did not toggle aria-expanded").
    const tourBlockers = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>(
        '[data-tour-id="dashboard-quick-add"]',
      );
      if (!btn) return ["no-button"];
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const stack = document.elementsFromPoint(x, y);
      const offenders: string[] = [];
      for (const el of stack) {
        const tour = (el as HTMLElement).closest(
          '[data-testid="onboarding-tour"]',
        );
        if (!tour) continue;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.pointerEvents !== "none") {
          offenders.push(
            `${(el as HTMLElement).tagName}#${(el as HTMLElement).id || "-"}.${
              (el as HTMLElement).className || "-"
            } pe=${style.pointerEvents}`,
          );
        }
      }
      return offenders;
    });
    expect(
      tourBlockers,
      "tour overlay must not place a pointer-events:auto element above the Hinzufügen button",
    ).toEqual([]);

    // Now the click — Radix's DropdownMenuTrigger flips aria-expanded
    // to "true" and renders the menu items into a portal as
    // role="menuitem". With the old single-backdrop overlay this click
    // hit the dim layer and called `handleSkip`; with the four-panel
    // overlay the TOP strip still intercepted it; with the shipped fix
    // the dim is pointer-events:none and the click reaches the button.
    await quickAddButton.click();

    await expect(quickAddButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menuitem").first()).toBeVisible();

    // The tour stays mounted — the click went to the underlying button,
    // not anything in the tour layer.
    await expect(tourRoot).toBeVisible();
  });

  test("explicit Skip button in the tooltip dismisses the tour", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const tourRoot = page.locator('[data-testid="onboarding-tour"]');
    await expect(tourRoot).toBeVisible({ timeout: 10_000 });

    // The tooltip's footer Skip button is the canonical skip surface.
    // The dim panels are purely visual (pointer-events: none) so the
    // page underneath stays usable; users skip by clicking the explicit
    // "Skip tour" control, which is also keyboard-accessible (Esc) and
    // matches industry-standard spotlight-tour patterns.
    const tooltip = page.locator('[data-testid="onboarding-tour-tooltip"]');
    await expect(tooltip).toBeVisible();
    await tooltip.getByRole("button", { name: /skip tour/i }).click();

    // Tour unmounts.
    await expect(tourRoot).toBeHidden({ timeout: 5_000 });
  });

  test("dim panels render as non-interactive visual layers", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    const tourRoot = page.locator('[data-testid="onboarding-tour"]');
    await expect(tourRoot).toBeVisible({ timeout: 10_000 });

    // Every dim panel must have computed `pointer-events: none`.
    // This is the load-bearing invariant — the F2 regression was that
    // these panels had pointer-events: auto and ate clicks aimed at
    // real interactive elements behind them.
    const dimPointerEvents = await page.evaluate(() => {
      const panels = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="onboarding-tour-dim"]',
        ),
      );
      return panels.map((el) => window.getComputedStyle(el).pointerEvents);
    });
    expect(dimPointerEvents.length).toBeGreaterThan(0);
    for (const pe of dimPointerEvents) {
      expect(pe).toBe("none");
    }
  });
});
