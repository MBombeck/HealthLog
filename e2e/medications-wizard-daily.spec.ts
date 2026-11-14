import { expect, test } from "./setup/test";

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
 * v1.5.4 — Medication wizard end-to-end — daily cadence.
 *
 * Walks the 7-step daily path through the modal dialog. The shared helper
 * opens `/medications?new=1` directly so cadence coverage is independent of
 * the legacy `/medications/new` redirect.
 * The DE label surface (the maintainer's primary locale) is the assertion
 * surface — "Schritt N von 7" tracks the visible counter.
 */
test.describe("medication wizard — daily", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a daily medication end-to-end", async ({ page }) => {
    // Multi-step wizard with per-step validation gating the Next button;
    // under a loaded CI runner the validation settle can lag the default
    // 30s, so this legitimately-long flow earns the tripled timeout.
    test.slow();
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Vitamin D",
      dose: "1000 I.E.",
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      oneShot: false,
      note: "Mit dem Frühstück",
    });

    await openCreateWizard(page);

    // Step 1 — name.
    await fillStep1Name(page, { name: "Vitamin D" });
    await clickNext(page);

    // Step 2 — treatment class.
    await expectStep(page, 2);
    await pickTreatmentRow(page, "vitamin");
    await clickNext(page);

    // Step 3 — dose.
    await expectStep(page, 3);
    await fillStep3Dose(page, { amount: "1000" });
    await page.locator("#wizard-dose-unit").click();
    await page.getByRole("option", { name: /I\.E\./ }).click();
    await clickNext(page);

    // Step 4 — course window (today by default).
    await expectStep(page, 4);
    // `DateField` keeps the ISO value on a hidden native date input
    // (data-slot), while the visible overlay paints the locale-formatted
    // string. Assert the committed ISO value on the hidden input.
    await expect(
      page.locator('[data-slot="course-window-starts"]'),
    ).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await clickNext(page);

    // Step 5 — cadence: "Täglich".
    await expectStep(page, 5, 8);
    await pickCadenceRow(page, "daily");
    // After picking daily, the path compresses to 7 steps; step 5
    // sits at slot 5 of 7.
    await expectStep(page, 5, 7);
    await clickNext(page);

    // Step 7 — times of day (08:00 default chip).
    await expectStep(page, 6, 7);
    await expect(
      page.locator('[data-slot="times-of-day-chip"][data-time="08:00"]'),
    ).toBeVisible();
    await clickNext(page);

    // Step 8 — summary + create.
    await expectStep(page, 7, 7);
    const summary = page.locator('[data-slot="wizard-summary"]');
    await expect(summary).toContainText(/Jeden Tag/i);
    // #1371 — the medication's own note, typed on the last step.
    await page.locator("#wizard-note").fill("  Mit dem Frühstück ");

    await clickSave(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Vitamin D",
      oneShot: false,
      // Trimmed on the way out.
      note: "Mit dem Frühstück",
      schedules: [{ rrule: "FREQ=DAILY" }],
    });

    await expectMedicationOnList(page, {
      name: "Vitamin D",
      withNextDueChip: true,
    });
    // The note sits on the card, above the dose actions.
    await expect(
      page.locator('main [data-slot="medication-card-note"]').first(),
    ).toHaveText(/Mit dem Frühstück/);
  });
});
