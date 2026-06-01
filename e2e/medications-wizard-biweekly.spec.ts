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
 * v1.5.4 — Medication wizard end-to-end — bi-weekly cadence (every N
 * weeks).
 *
 * Walks the 8-step recurring path with "Alle X Wochen" picked on
 * Step 5, then the interval input filled with 2 and Monday toggled
 * on the weekday chips of Step 6. Emits
 * `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`.
 */
test.describe("medication wizard — bi-weekly", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates an every-2-weeks Monday medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Methotrexat",
      dose: "10 mg",
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await openCreateWizard(page);

    await fillStep1Name(page, { name: "Methotrexat" });
    await clickNext(page);

    await expectStep(page, 2);
    await pickTreatmentRow(page, "other");
    await clickNext(page);

    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "10" });
    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "everyNWeeks");
    await clickNext(page);

    await expectStep(page, 6, 8);
    await page.locator("#wizard-interval-weeks").fill("2");
    const moChip = page.locator(
      '[data-slot="wizard-weekday-chip"][data-token="MO"]',
    );
    if ((await moChip.getAttribute("data-active")) === "false") {
      await moChip.click();
    }
    await clickNext(page);

    await expectStep(page, 7, 8);
    await clickNext(page);

    await expectStep(page, 8, 8);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/zwei Wochen/i);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Methotrexat",
      oneShot: false,
      schedules: [{ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" }],
    });

    await expectMedicationOnList(page, {
      name: "Methotrexat",
      withNextDueChip: true,
    });
  });
});
