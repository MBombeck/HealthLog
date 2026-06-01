import { expect, test } from "@playwright/test";

import {
  STUB_MEDICATION_ID,
  clickNext,
  clickSave,
  expectMedicationOnList,
  expectRedirectToMedication,
  expectStep,
  fillStep1Name,
  fillStep3Dose,
  mockMedicationsApi,
  openCreateWizard,
  pickCadenceRow,
  pickTreatmentRow,
  stubDashboardAnalytics,
} from "./medications-wizard-helpers";
import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.5.4 — Medication wizard end-to-end — one-shot cadence.
 *
 * Picking "Einmalig" on Step 5 collapses the path onto the 5-step
 * one-shot route ([1, 2, 3, 4, 8]). The wizard skips Steps 6 + 7
 * because the dose date already lives in Step 4 (course window).
 * Step 4's CourseWindowRow locks endsOn to startsOn for one-shot.
 *
 * The list-page "Nächste Einnahme:" chip is suppressed because the
 * design-synthesis lifecycle deactivates one-shot medications once
 * the single intake is logged. The spec only asserts the row name
 * appears on the list.
 */
test.describe("medication wizard — one-shot", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a single-dose medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Grippeimpfung",
      dose: "0.5 ml",
      rrule: null,
      rollingIntervalDays: null,
      oneShot: true,
    });

    await openCreateWizard(page);

    await fillStep1Name(page, { name: "Grippeimpfung" });
    await clickNext(page);

    await expectStep(page, 2);
    await pickTreatmentRow(page, "other");
    await clickNext(page);

    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "0.5" });
    await page.locator("#wizard-dose-unit").click();
    await page.getByRole("option", { name: /^ml$/i }).click();
    await clickNext(page);

    // Step 4 — course window. Set startsOn to a deterministic date so
    // the post body assertion below is stable.
    await expectStep(page, 4);
    await page.locator('[data-slot="course-window-starts"]').fill("2026-10-15");
    await clickNext(page);

    // Step 5 — pick Einmalig. The path compresses to 5 steps the
    // moment the row is picked; the visible counter follows.
    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "oneShot");
    // After the pick the path is [1, 2, 3, 4, 8]; the cadence pick
    // step (raw step 5) sits between slots 4 and 5 of 5, so the
    // counter pins on slot 4 of 5 until Next.
    await expectStep(page, 4, 5);
    await clickNext(page);

    await expectStep(page, 5, 5);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/Einmaldosis/i);
    await expect(summary).toContainText(/2026-10-15/);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Grippeimpfung",
      oneShot: true,
      startsOn: "2026-10-15",
      endsOn: "2026-10-15",
    });

    await expectMedicationOnList(page, {
      name: "Grippeimpfung",
      withNextDueChip: false,
    });
  });
});
