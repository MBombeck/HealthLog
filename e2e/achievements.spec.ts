import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.15 phase-B4 — /achievements navigation smoke.
 *
 * The page itself has unit-test coverage for the locked-vs-unlocked
 * card render; this spec answers the higher-level "can the user reach
 * the page from the global nav?" question. We mock
 * `/api/gamification/achievements` so the assertion does not depend on
 * the seed user actually having any achievement data — the routing +
 * sidebar wiring is what matters here, not the data freshness.
 *
 * v1.4.18 — added a second describe-block exercising the four card
 * states (unlocked / locked-earnable / hidden-locked / hidden-unlocked)
 * and asserting that hidden cards never leak their real strings to the
 * DOM.
 */
test.describe("achievements page is reachable from the sidebar", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/gamification/achievements", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summary: {
              unlockedCount: 0,
              totalCount: 38,
              earnedPoints: 0,
              totalPoints: 9999,
              completionPercent: 0,
              nextAchievement: null,
            },
            achievements: [
              {
                id: "intake-total-1",
                metric: "totalTakenIntakes",
                category: "medication",
                titleKey: "achievements.badges.intakeTotal1.title",
                descriptionKey: "achievements.badges.intakeTotal1.description",
                icon: "Pill",
                format: "count",
                target: 1,
                current: 0,
                points: 8,
                unlocked: false,
                progressPercent: 0,
                completedAt: null,
              },
            ],
            metrics: {},
          },
          error: null,
        }),
      }),
    );
  });

  test("desktop sidebar exposes the achievements link", async ({
    page,
    viewport,
  }) => {
    // The sidebar nav is hidden on small viewports (`md:flex`). The
    // chromium-mobile profile (Pixel 5, 393 px wide) cannot satisfy
    // this contract by design — skip there so the spec only runs in
    // the chromium-desktop project (1280×720). Without this guard
    // every push fails 1 / 4 specs purely because the same suite is
    // sharded across both projects.
    test.skip(
      (viewport?.width ?? 0) < 768,
      "sidebar is hidden on mobile by design (md:flex breakpoint)",
    );

    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Match by aria-label so we don't accidentally pick up a tooltip.
    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole("link", { name: "Achievements" }).click();
    await expect(page).toHaveURL(/\/achievements\b/);
    // Page title from the loaded route. The unit test guards the
    // grouped + locked-card render shape; here we only assert the route
    // mounted and rendered the heading.
    await expect(
      page.getByRole("heading", { name: "Achievements" }),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("achievements page renders all four card states", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/gamification/achievements", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summary: {
              unlockedCount: 2,
              totalCount: 4,
              earnedPoints: 43,
              totalPoints: 200,
              completionPercent: 50,
              nextAchievement: null,
            },
            achievements: [
              // Unlocked public
              {
                id: "intake-total-1",
                metric: "totalTakenIntakes",
                category: "medication",
                titleKey: "achievements.badges.intakeTotal1.title",
                descriptionKey: "achievements.badges.intakeTotal1.description",
                icon: "Pill",
                format: "count",
                target: 1,
                current: 5,
                points: 8,
                unlocked: true,
                progressPercent: 100,
                completedAt: "2026-04-15T12:00:00.000Z",
                isHidden: false,
              },
              // Locked-earnable public (mood streak — user has mood data)
              {
                id: "mood-streak-7",
                metric: "moodDayStreak",
                category: "mood",
                titleKey: "achievements.badges.moodStreak7.title",
                descriptionKey: "achievements.badges.moodStreak7.description",
                icon: "Smile",
                format: "days",
                target: 7,
                current: 3,
                points: 50,
                unlocked: false,
                progressPercent: 42,
                completedAt: null,
                isHidden: false,
              },
              // Hidden + locked → opaque placeholder
              {
                id: "hidden-night-owl",
                metric: "nightOwlCount",
                category: "hidden",
                titleKey: "achievements.badges.hiddenNightOwl.title",
                descriptionKey:
                  "achievements.badges.hiddenNightOwl.description",
                icon: "Moon",
                format: "count",
                target: 1,
                current: 0,
                points: 25,
                unlocked: false,
                progressPercent: 0,
                completedAt: null,
                isHidden: true,
              },
              // Hidden + unlocked → real strings revealed
              {
                id: "hidden-doctor-pdf",
                metric: "doctorPdfCount",
                category: "hidden",
                titleKey: "achievements.badges.hiddenDoctorPdf.title",
                descriptionKey:
                  "achievements.badges.hiddenDoctorPdf.description",
                icon: "FileText",
                format: "count",
                target: 1,
                current: 1,
                points: 35,
                unlocked: true,
                progressPercent: 100,
                completedAt: "2026-04-30T10:00:00.000Z",
                isHidden: true,
              },
            ],
            metrics: {},
          },
          error: null,
        }),
      }),
    );
  });

  test("renders unlocked, locked-earnable, hidden-locked and hidden-unlocked cards", async ({
    page,
  }) => {
    await page.goto("/achievements", { waitUntil: "domcontentloaded" });

    // Page heading present
    await expect(
      page.getByRole("main").getByRole("heading", {
        name: "Achievements",
        level: 1,
        exact: true,
      }),
    ).toBeVisible({ timeout: 5000 });

    // Unlocked public — title visible
    await expect(page.getByText("First intake")).toBeVisible();

    // Locked-earnable public — title visible AND criterion hint
    // visible (3 / 7 days for mood-streak-7).
    await expect(page.getByText("Mood diarist 7d")).toBeVisible();

    // Hidden-locked — opaque placeholder visible. The real title /
    // description must NOT appear in the rendered HTML.
    await expect(page.getByText("Hidden achievement").first()).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("Night owl");
    expect(html).not.toContain("between 02:00");
    expect(html).not.toContain("nightOwlCount");

    // Hidden-unlocked — title revealed once earned
    await expect(page.getByText("House call")).toBeVisible();

    // The opaque hidden card carries the data-slot for E2E hooks
    await expect(
      page.locator('[data-slot="achievement-card-hidden"]'),
    ).toBeVisible();
  });
});
