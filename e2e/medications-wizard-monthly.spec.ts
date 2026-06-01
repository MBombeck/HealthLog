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
 * v1.5.4 — Medication wizard end-to-end — monthly cadence.
 *
 * Walks the 8-step recurring path with "Monatlich" picked on Step 5
 * and dayOfMonth = 15 set on Step 6. Emits
 * `FREQ=MONTHLY;BYMONTHDAY=15`.
 */
test.describe("medication wizard — monthly", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a monthly-on-day-15 medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Vitamin B12",
      dose: "1000 µg",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await openCreateWizard(page);

    await fillStep1Name(page, { name: "Vitamin B12" });
    await clickNext(page);

    await expectStep(page, 2);
    await pickTreatmentRow(page, "vitamin");
    await clickNext(page);

    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "1000" });
    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "monthly");
    await clickNext(page);

    await expectStep(page, 6, 8);
    await page.locator("#wizard-day-of-month").fill("15");
    await clickNext(page);

    await expectStep(page, 7, 8);
    await clickNext(page);

    await expectStep(page, 8, 8);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/Monatlich/i);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Vitamin B12",
      oneShot: false,
      schedules: [{ rrule: "FREQ=MONTHLY;BYMONTHDAY=15" }],
    });

    await expectMedicationOnList(page, {
      name: "Vitamin B12",
      withNextDueChip: true,
    });
  });
});
