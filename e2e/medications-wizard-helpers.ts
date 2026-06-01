import { expect, type Page, type Route } from "@playwright/test";

/**
 * v1.5.4 — shared helpers for the modal medication-wizard specs.
 *
 * The six specs (daily / weekdays / biweekly / monthly / rolling /
 * oneshot) walk the same dialog with different cadence-specific
 * inputs. The shared pieces — POST + GET stubs, list-page entry
 * check, dialog open + step-indicator assertions — live here so
 * the per-cadence specs only carry the cadence-specific selectors.
 *
 * The path counter follows the user's path:
 *   one-shot   = 5 steps (1, 2, 3, 4, 8)
 *   daily      = 7 steps (1, 2, 3, 4, 5, 7, 8)
 *   recurring  = 8 steps (1, 2, 3, 4, 5, 6, 7, 8)
 *
 * `expectStep(page, displayIndex, totalSteps)` pins the visible
 * "Schritt X von Y" string the dialog header renders.
 */

export const STUB_MEDICATION_ID = "med_e2e_wizard";

interface StubbedMedication {
  id: string;
  name: string;
  dose: string;
  rrule: string | null;
  rollingIntervalDays: number | null;
  oneShot: boolean;
}

export function mockMedicationsApi(page: Page, stubbed: StubbedMedication) {
  const capture: { postBody: unknown } = { postBody: null };

  const listEntry = {
    id: stubbed.id,
    name: stubbed.name,
    dose: stubbed.dose,
    category: "OTHER",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    startsOn: null,
    endsOn: null,
    oneShot: stubbed.oneShot,
    schedules: [
      {
        id: "sch_e2e_1",
        windowStart: "08:00",
        windowEnd: "09:00",
        label: null,
        dose: null,
        daysOfWeek: null,
        timesOfDay: ["08:00"],
        rrule: stubbed.rrule,
        rollingIntervalDays: stubbed.rollingIntervalDays,
        reminderGraceMinutes: null,
      },
    ],
  };

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
        body: JSON.stringify({
          data: { ...listEntry },
          error: null,
        }),
      });
      return;
    }
    if (req.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [listEntry],
          error: null,
        }),
      });
      return;
    }
    await route.fallback();
  });

  return capture;
}

export async function stubDashboardAnalytics(page: Page): Promise<void> {
  await page.route(/\/api\/analytics(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
        error: null,
      }),
    }),
  );
  await page.route("**/api/mood/analytics", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { entries: [], summary: { count: 0 } },
        error: null,
      }),
    }),
  );
}

/**
 * Open the wizard dialog by hitting `/medications/new` (which
 * redirects to `/medications?new=1` and opens the create dialog).
 */
export async function openCreateWizard(page: Page): Promise<void> {
  // Pin the German locale for the wizard flow. The app default locale is
  // English; these specs assert the "Schritt N von M" counter and other
  // German label surfaces, which only render when the `healthlog-locale`
  // cookie resolves to "de". Both the server layout and the client i18n
  // provider read this exact cookie name, so setting it before the first
  // navigation makes the dialog render German on first paint. Scoped here
  // rather than in the shared auth state so English-asserting specs keep
  // the default locale.
  await page.context().addCookies([
    {
      name: "healthlog-locale",
      value: "de",
      url: page.url().startsWith("http")
        ? new URL(page.url()).origin
        : "http://localhost:3000",
    },
  ]);
  await page.goto("/medications/new", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-slot="medication-wizard-dialog"]'),
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Fill the Step 1 name input. The dialog's first step asks only for
 * the medication name — the dose moved to Step 3.
 */
export async function fillStep1Name(
  page: Page,
  { name }: { name: string },
): Promise<void> {
  await expectStep(page, 1);
  await page.locator("#wizard-name").fill(name);
}

/** Pick a Step 2 treatment-class row by its row identifier. */
export async function pickTreatmentRow(
  page: Page,
  row:
    | "bloodPressure"
    | "diabetes"
    | "hormone"
    | "glp1"
    | "painRelief"
    | "allergy"
    | "vitamin"
    | "supplement"
    | "antibiotic"
    | "other",
): Promise<void> {
  await page
    .locator(`[data-slot="wizard-class-row"][data-row="${row}"]`)
    .click();
}

/** Fill the Step 3 dose amount input. */
export async function fillStep3Dose(
  page: Page,
  { amount }: { amount: string },
): Promise<void> {
  await page.locator("#wizard-dose-amount").fill(amount);
}

/** Pick a Step 5 cadence row by its row identifier. */
export async function pickCadenceRow(
  page: Page,
  row: "daily" | "weekdays" | "everyNWeeks" | "monthly" | "rolling" | "oneShot",
): Promise<void> {
  await page
    .locator(`[data-slot="wizard-cadence-row"][data-row="${row}"]`)
    .click();
}

/** Click Next. Pinned by data-slot. */
export async function clickNext(page: Page): Promise<void> {
  await page.locator('[data-slot="wizard-next"]').click();
}

/** Click Save (last step CTA on create + edit). */
export async function clickSave(page: Page): Promise<void> {
  await page.locator('[data-slot="wizard-save"]').click();
}

/**
 * Assert the wizard sits on a given visible step counter.
 * `displayIndex` is the visible 1-based index; `totalSteps` is the
 * path length for the active mode + cadence.
 */
export async function expectStep(
  page: Page,
  displayIndex: number,
  totalSteps?: number,
): Promise<void> {
  const pattern = totalSteps
    ? new RegExp(`Schritt ${displayIndex} von ${totalSteps}`, "i")
    : new RegExp(`Schritt ${displayIndex} von \\d+`, "i");
  await expect(page.getByText(pattern)).toBeVisible({ timeout: 5_000 });
}

/**
 * Verify the post-submit URL settles on `/medications/<id>` (create
 * path; the dialog navigates there on success).
 */
export async function expectRedirectToMedication(
  page: Page,
  id: string,
): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
    .toBe(`/medications/${id}`);
}

/**
 * Navigate to the list and assert the just-created medication
 * appears. The recurring variants surface a "Nächste Einnahme:" chip;
 * the one-shot variant does not.
 */
export async function expectMedicationOnList(
  page: Page,
  { name, withNextDueChip }: { name: string; withNextDueChip: boolean },
): Promise<void> {
  await page.goto("/medications", { waitUntil: "domcontentloaded" });
  const main = page.locator("main");
  await expect(main.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  if (withNextDueChip) {
    await expect(main.getByText(/Nächste Einnahme:/i).first()).toBeVisible();
  }
}
