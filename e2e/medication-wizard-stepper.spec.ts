import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  STUB_MEDICATION_ID,
  clickNext,
  expectStep,
  fillStep1Name,
  fillStep3Dose,
  mockMedicationsApi,
  openCreateWizard,
  pickCadenceRow,
  stubDashboardAnalytics,
} from "./medications-wizard-helpers";
import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The medication wizard's progress band: four phases (Medication, Dose,
 * Schedule, Review) of equal width, the same inset on both sides of the
 * sheet, a count that a cadence choice cannot change, the close button on a
 * title row of its own, and on edit a jump straight to Review.
 *
 * Both a phone and a desktop width, because the band and the sheet switch
 * shape at 768 px: a bottom sheet with the step's name above the band on a
 * phone, a dialog with the names under the segments on a desktop.
 */

/** Two boxes' widths agree to half a pixel. */
const TOLERANCE = 0.5;

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

async function expectBand(page: Page) {
  const sheet = page.locator('[data-slot="responsive-sheet-content"]');
  const band = sheet.locator('[data-slot="stepper"]');
  await expect(band).toBeVisible();
  // Measure the sheet at rest, not part-way through its opening slide or zoom.
  await sheet.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );

  const segments = band.locator('[data-slot="stepper-step"]');
  await expect(segments).toHaveCount(4);
  const widths = await Promise.all(
    [0, 1, 2, 3].map(async (i) => (await box(segments.nth(i))).width),
  );
  for (const w of widths) {
    expect(Math.abs(w - widths[0])).toBeLessThanOrEqual(TOLERANCE);
  }

  // The band starts and ends the same distance from the sheet's edges.
  const s = await box(sheet);
  const b = await box(band);
  const left = b.x - s.x;
  const right = s.x + s.width - (b.x + b.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(TOLERANCE);

  // The close button sits on the title row, above the band.
  const title = sheet.locator('[data-slot="responsive-sheet-header"] h2');
  await expect(title).toBeVisible();
  const close = sheet.getByRole("button", { name: /close|schließen/i }).last();
  const t = await box(title);
  const c = await box(close);
  expect(c.y + c.height / 2).toBeLessThan(b.y);
  expect(Math.abs(c.y + c.height / 2 - (t.y + t.height / 2))).toBeLessThan(
    c.height / 2,
  );

  // Nothing pans sideways.
  const overflow = await sheet.evaluate((el) => {
    const body = el.querySelector<HTMLElement>(
      '[data-slot="responsive-sheet-body"]',
    );
    return [el, body].some((n) => n && n.scrollWidth > n.clientWidth + 1);
  });
  expect(overflow).toBe(false);
}

async function expectPhase(
  page: Page,
  phase: string,
  index: number,
  fraction: number,
) {
  const root = page.locator('[data-slot="medication-wizard-dialog"]');
  await expect(root).toHaveAttribute("data-phase", phase);
  await expect(root).toHaveAttribute("data-phase-index", String(index));
  await expect(root).toHaveAttribute("data-phase-count", "4");
  await expect(root).toHaveAttribute("data-phase-fraction", String(fraction));
  const current = page.locator(
    '[data-slot="stepper-step"][aria-current="step"]',
  );
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-step-id", phase);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`medication wizard stepper at ${viewport.width} px`, () => {
    test.use({ storageState: STORAGE_STATE_PATH, viewport });

    test("four even phases whose count a cadence choice does not move", async ({
      page,
    }) => {
      test.slow();
      await stubDashboardAnalytics(page);
      mockMedicationsApi(page, {
        id: STUB_MEDICATION_ID,
        name: "Ramipril",
        dose: "5 mg",
        rrule: "FREQ=DAILY",
        rollingIntervalDays: null,
        oneShot: false,
      });

      await openCreateWizard(page);
      await expectPhase(page, "medication", 1, 0.5);
      await expectBand(page);

      await fillStep1Name(page, { name: "Ramipril" });
      await clickNext(page);
      await expectStep(page, 2);
      await expectPhase(page, "medication", 1, 1);
      // The step heading takes focus on a step change.
      await expect(
        page.locator('[data-slot="wizard-step-title"]'),
      ).toBeFocused();
      await clickNext(page);
      await expectStep(page, 3);
      await expectPhase(page, "dose", 2, 1);
      await fillStep3Dose(page, { amount: "5" });
      await clickNext(page);
      await expectStep(page, 4);
      await expectPhase(page, "schedule", 3, 0.25);
      await clickNext(page);

      await expectStep(page, 5, 8);
      await expectPhase(page, "schedule", 3, 0.5);
      await pickCadenceRow(page, "daily");
      await expectStep(page, 5, 7);
      await expectPhase(page, "schedule", 3, 0.5);
      await expectBand(page);

      // Done phases are a tap back; the current one is not a button.
      const band = page.locator('[data-slot="stepper"]');
      await expect(
        band.locator('[data-step-id="schedule"] button'),
      ).toHaveCount(0);
      await band.locator('[data-step-id="dose"] button').click();
      await expectStep(page, 3);
      await expectPhase(page, "dose", 2, 1);
    });

    test("editing a medication reaches Save in two taps", async ({ page }) => {
      test.slow();
      const name = `Stepper edit ${viewport.width} ${Date.now()}`;
      const created = await page.request.post("/api/medications", {
        data: {
          name,
          dose: "5 mg",
          schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
        },
      });
      expect(created.status()).toBeLessThan(300);
      const id = ((await created.json()) as { data: { id: string } }).data.id;

      let putBody: unknown = null;
      await page.route(`**/api/medications/${id}`, async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        putBody = JSON.parse(route.request().postData() ?? "null");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { id }, error: null }),
        });
      });

      try {
        await page.goto(`/medications/${id}?edit=1`, {
          waitUntil: "domcontentloaded",
        });
        const root = page.locator('[data-slot="medication-wizard-dialog"]');
        await expect(root).toHaveAttribute("data-mode", "edit", {
          timeout: 20_000,
        });
        await expect(root).toHaveAttribute("data-step", "1");
        await expectBand(page);

        await page.locator("#wizard-name").fill(`${name} renamed`);
        // Tap one: Review. Tap two: Save.
        await page
          .locator('[data-slot="stepper"] [data-step-id="review"] button')
          .click();
        await expect(root).toHaveAttribute("data-step", "8");
        await expectPhase(page, "review", 4, 1);
        await page.locator('[data-slot="wizard-save"]').click();
        await expect.poll(() => putBody).not.toBeNull();
        expect(putBody).toMatchObject({ name: `${name} renamed` });
      } finally {
        await page.request.delete(`/api/medications/${id}`);
      }
    });

    test("Cancel stands where Back stands, and asks before dropping input", async ({
      page,
    }) => {
      test.slow();
      await stubDashboardAnalytics(page);
      mockMedicationsApi(page, {
        id: STUB_MEDICATION_ID,
        name: "Ramipril",
        dose: "5 mg",
        rrule: "FREQ=DAILY",
        rollingIntervalDays: null,
        oneShot: false,
      });
      await openCreateWizard(page);
      const root = page.locator('[data-slot="medication-wizard-dialog"]');
      const cancel = page.locator('[data-slot="wizard-cancel"]');
      await expect(cancel).toBeEnabled();
      await expect(page.locator('[data-slot="wizard-back"]')).toHaveCount(0);
      // No sentence above the buttons: the reason a disabled Next waits is
      // for a screen reader only.
      const hint = page.locator('[data-slot="wizard-blocked-hint"]');
      await expect(hint).toHaveClass(/sr-only/);
      await expect(page.locator('[data-slot="wizard-next"]')).toHaveAttribute(
        "aria-describedby",
        "wizard-blocked-hint",
      );

      await fillStep1Name(page, { name: "Ramipril" });
      await expectBand(page);
      const footer = page.locator('[data-slot="responsive-sheet-footer"]');
      // Within the footer: a dialog is centred, so the footer itself moves
      // when the next step is taller.
      const cancelBox = await box(cancel);
      const cancelFooter = await box(footer);
      const cancelClass = await cancel.getAttribute("class");
      await clickNext(page);
      await expectStep(page, 2);
      const back = page.locator('[data-slot="wizard-back"]');
      await expect(page.locator('[data-slot="wizard-cancel"]')).toHaveCount(0);
      await expectBand(page);
      const backBox = await box(back);
      const backFooter = await box(footer);
      expect(
        Math.abs(backBox.x - backFooter.x - (cancelBox.x - cancelFooter.x)),
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(backBox.y - backFooter.y - (cancelBox.y - cancelFooter.y)),
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(backBox.height - cancelBox.height)).toBeLessThanOrEqual(
        TOLERANCE,
      );
      expect(await back.getAttribute("class")).toBe(cancelClass);

      // Back to step 1 with a name typed: Cancel asks, through the shared
      // discard dialog; keeping the input leaves the wizard where it was.
      await back.click();
      await expectStep(page, 1);
      await page.locator('[data-slot="wizard-cancel"]').click();
      const ask = page.getByRole("alertdialog");
      await expect(ask).toBeVisible();
      await ask.getByRole("button").first().click();
      await expect(ask).toBeHidden();
      await expect(root).toBeVisible();
      await expect(page.locator("#wizard-name")).toHaveValue("Ramipril");

      // With nothing typed it closes at once.
      await page.locator("#wizard-name").fill("");
      await page.locator('[data-slot="wizard-cancel"]').click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(root).toBeHidden();
    });
  });
}
