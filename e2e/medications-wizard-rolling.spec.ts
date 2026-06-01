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
 * v1.5.4 — Medication wizard end-to-end — rolling cadence.
 *
 * Walks the 8-step recurring path with "Flexibel ab letzter
 * Einnahme" picked on Step 5 and rollingDays = 7 set on Step 6.
 * Emits `rollingIntervalDays: 7` (no rrule). The cadence row also
 * surfaces Marc's literal "Counter startet neu" copy directly below
 * the row label — the assertion below pins the phrase so a future
 * copy edit can't silently drop the rolling explainer.
 */
test.describe("medication wizard — rolling", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates an every-7-days-from-last-intake medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Mounjaro",
      dose: "5 mg",
      rrule: null,
      rollingIntervalDays: 7,
      oneShot: false,
    });

    await openCreateWizard(page);

    await fillStep1Name(page, { name: "Mounjaro" });
    await clickNext(page);

    await expectStep(page, 2);
    await pickTreatmentRow(page, "glp1");
    await clickNext(page);

    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "5" });
    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5, 8);
    // The rolling row surfaces the Counter-Reset explainer right
    // under the row label, not in a tooltip.
    const rollingRow = page.locator(
      '[data-slot="wizard-cadence-row"][data-row="rolling"]',
    );
    await expect(rollingRow).toContainText(/Counter/i);
    await pickCadenceRow(page, "rolling");
    await clickNext(page);

    await expectStep(page, 6, 8);
    await page.locator("#wizard-rolling-days").fill("7");
    await clickNext(page);

    await expectStep(page, 7, 8);
    await clickNext(page);

    await expectStep(page, 8, 8);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/letzten Einnahme/i);

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Mounjaro",
      oneShot: false,
      schedules: [{ rollingIntervalDays: 7 }],
    });

    await expectMedicationOnList(page, {
      name: "Mounjaro",
      withNextDueChip: true,
    });
  });
});
