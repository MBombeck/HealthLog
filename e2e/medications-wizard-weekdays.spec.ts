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
 * v1.5.4 — Medication wizard end-to-end — specific weekdays.
 *
 * Walks the 8-step recurring path through the modal dialog with
 * "Bestimmte Wochentage" picked on Step 5, then Mo / Mi / Fr toggled
 * on the weekday chips of Step 6. The emitted rrule is
 * `FREQ=WEEKLY;BYDAY=MO,WE,FR`.
 */
test.describe("medication wizard — weekdays", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a Mo/Mi/Fr medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Ibuprofen",
      dose: "400 mg",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await openCreateWizard(page);

    await fillStep1Name(page, { name: "Ibuprofen" });
    await clickNext(page);

    await expectStep(page, 2);
    await pickTreatmentRow(page, "painRelief");
    await clickNext(page);

    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "400" });
    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "weekdays");
    await clickNext(page);

    await expectStep(page, 6, 8);
    // The weekday default may already be [MO]; re-tick to make the
    // selection deterministic for the assertion below.
    const moChip = page.locator(
      '[data-slot="wizard-weekday-chip"][data-token="MO"]',
    );
    if ((await moChip.getAttribute("data-active")) === "false") {
      await moChip.click();
    }
    await page
      .locator('[data-slot="wizard-weekday-chip"][data-token="WE"]')
      .click();
    await page
      .locator('[data-slot="wizard-weekday-chip"][data-token="FR"]')
      .click();
    await clickNext(page);

    await expectStep(page, 7, 8);
    await clickNext(page);

    await expectStep(page, 8, 8);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/Wochentagen/i);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Ibuprofen",
      oneShot: false,
      schedules: [{ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }],
    });

    await expectMedicationOnList(page, {
      name: "Ibuprofen",
      withNextDueChip: true,
    });
  });
});
