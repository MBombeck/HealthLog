import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The workouts page at phone width (domain page template): the activity
 * calendar renders a whole-week grid and pages back, "Seite anpassen" turns
 * it off and on again, and the goals editor on the sheet's second level
 * saves a goal it then reports as set.
 */
test.describe("workouts page", () => {
  test.use({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 390, height: 844 },
  });

  test("draws the month and pages back", async ({ page }) => {
    await page.goto("/insights/workouts");
    const card = page.locator('[data-slot="activity-calendar"]');
    await expect(card).toBeVisible();
    const label = page.locator('[data-slot="activity-calendar-label"]');
    await expect(label).not.toHaveText("");

    const days = page.locator('[data-slot="activity-calendar-day"]');
    const monthCount = await days.count();
    if (monthCount > 0) expect(monthCount % 7).toBe(0);

    const before = await label.textContent();
    await page.locator('[data-slot="activity-calendar-previous"]').click();
    await expect(label).not.toHaveText(before ?? "");

    // No week switch any more: the month grid contains the week.
    await expect(
      page.locator('[data-slot="activity-calendar-period"]'),
    ).toHaveCount(0);
    // The phone header carries the wrench and no add button.
    await expect(page.locator('[data-slot="page-customize"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="workout-log-manual"]')).toBeHidden();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("turns the calendar off and on in Seite anpassen", async ({ page }) => {
    await page.goto("/insights/workouts");
    await expect(page.locator('[data-slot="activity-calendar"]')).toBeVisible();
    await page.locator('[data-slot="page-customize"]').click();
    const toggle = page.locator('[data-slot="workouts-customize-calendar"]');
    await toggle.click();
    await expect(page.locator('[data-slot="activity-calendar"]')).toHaveCount(
      0,
    );
    await toggle.click();
    await expect(page.locator('[data-slot="activity-calendar"]')).toHaveCount(
      1,
    );
  });

  test("saves a goal on the sheet's second level", async ({ page }) => {
    await page.goto("/insights/workouts");
    await page.locator('[data-slot="page-customize"]').click();
    const goalsRow = page.locator(
      '[data-slot="activity-calendar-set-goals"] [data-slot="list-item-action"]',
    );
    await goalsRow.click();
    const field = page.locator(
      '[data-slot="activity-goals-form"] input[data-goal-key="stepsPerMonth"]',
    );
    await field.fill("150000");
    await page.locator('[data-slot="activity-goals-save"]').click();
    // Back on the first level, the row reports the goal.
    await expect(
      page.locator('[data-slot="page-customize-sheet"][data-level="1"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="activity-calendar-set-goals"]'),
    ).toContainText("1");

    // Clear it again so the account is left as it was found.
    await goalsRow.click();
    await field.fill("");
    await page.locator('[data-slot="activity-goals-save"]').click();
    await expect(
      page.locator('[data-slot="page-customize-sheet"][data-level="1"]'),
    ).toBeVisible();
  });
});
