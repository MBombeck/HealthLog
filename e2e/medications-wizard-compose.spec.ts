import { expect, test, type Route } from "@playwright/test";

import {
  STUB_MEDICATION_ID,
  clickNext,
  clickSave,
  expectMedicationOnList,
  expectRedirectToMedication,
  expectStep,
  fillStep1Name,
  fillStep3Dose,
  openCreateWizard,
  pickCadenceRow,
  pickTreatmentRow,
  stubDashboardAnalytics,
} from "./medications-wizard-helpers";
import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.5.4 — Medication wizard end-to-end — compose-mode.
 *
 * Walks the create flow through to Step 8, then taps
 * "Weiteren Zeitplan hinzufügen" to append a second weekly Wednesday
 * schedule on the same medication. The list view surfaces both
 * summary cards before save, and the POST body carries both
 * schedules so the route can persist them in parallel.
 *
 * Use case the maintainer cares about: short-acting + long-acting
 * insulin on a single medication. Today the wizard collapses to one
 * schedule on save; compose-mode closes that data-loss gap.
 */
test.describe("medication wizard — compose-mode", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a 2-schedule medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);

    const listEntry = {
      id: STUB_MEDICATION_ID,
      name: "Insulin",
      dose: "10 IE",
      category: "DIABETES",
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sch_e2e_1",
          windowStart: "08:00",
          windowEnd: "09:00",
          label: null,
          dose: null,
          daysOfWeek: null,
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
        },
        {
          id: "sch_e2e_2",
          windowStart: "20:00",
          windowEnd: "21:00",
          label: null,
          dose: null,
          daysOfWeek: null,
          timesOfDay: ["20:00"],
          rrule: "FREQ=WEEKLY;BYDAY=WE",
          rollingIntervalDays: null,
          reminderGraceMinutes: null,
        },
      ],
    };

    const capture: { postBody: unknown } = { postBody: null };
    void page.route("**/api/medications**", async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname !== "/api/medications") {
        await route.fallback();
        return;
      }
      if (req.method() === "POST") {
        capture.postBody = JSON.parse(req.postData() ?? "null");
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ data: { ...listEntry }, error: null }),
        });
        return;
      }
      if (req.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [listEntry], error: null }),
        });
        return;
      }
      await route.fallback();
    });

    await openCreateWizard(page);

    // Steps 1-4 — medication-global.
    await fillStep1Name(page, { name: "Insulin" });
    await clickNext(page);
    await expectStep(page, 2);
    await pickTreatmentRow(page, "diabetes");
    await clickNext(page);
    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "10" });
    await clickNext(page);
    await expectStep(page, 4);
    await clickNext(page);

    // Steps 5-7 — first schedule, daily cadence.
    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "daily");
    await expectStep(page, 5, 7);
    await clickNext(page);
    await expectStep(page, 6, 7);
    await clickNext(page);

    // Step 8 — list view with the first schedule rendered. Tap
    // "Weiteren Zeitplan hinzufügen" to append a second draft.
    await expectStep(page, 7, 7);
    let cards = page.locator('[data-slot="wizard-schedule-card"]');
    await expect(cards).toHaveCount(1);
    await page.locator('[data-slot="wizard-schedule-add"]').click();

    // Second schedule — weekdays on Wednesday.
    await expectStep(page, 5);
    await pickCadenceRow(page, "weekdays");
    await clickNext(page);
    await expectStep(page, 6);
    const weChip = page.locator(
      '[data-slot="wizard-weekday-chip"][data-token="WE"]',
    );
    if ((await weChip.getAttribute("data-active")) === "false") {
      await weChip.click();
    }
    // Default MO chip — toggle off so the rrule is WE-only.
    const moChip = page.locator(
      '[data-slot="wizard-weekday-chip"][data-token="MO"]',
    );
    if ((await moChip.getAttribute("data-active")) === "true") {
      await moChip.click();
    }
    await clickNext(page);
    await expectStep(page, 7);
    await clickNext(page);

    // Back on Step 8 — both summary cards should land before save.
    await expectStep(page, 8);
    cards = page.locator('[data-slot="wizard-schedule-card"]');
    await expect(cards).toHaveCount(2);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Insulin",
      oneShot: false,
      schedules: [
        { rrule: "FREQ=DAILY" },
        { rrule: "FREQ=WEEKLY;BYDAY=WE" },
      ],
    });

    await expectMedicationOnList(page, {
      name: "Insulin",
      withNextDueChip: true,
    });
  });
});
