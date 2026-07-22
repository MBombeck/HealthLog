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
 * Open the wizard directly on `/medications?new=1`. The redirect from the
 * legacy `/medications/new` route is a separate concern; these cadence specs
 * exercise the wizard without racing that server navigation.
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
      url: new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").origin,
    },
  ]);
  await page.goto("/medications?new=1", { waitUntil: "load" });
  await page.waitForURL(
    (url) => url.pathname === "/medications" && !url.searchParams.has("new"),
    { timeout: 10_000 },
  );
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
  // The "Schritt X von Y" caption is mobile-only (`sm:hidden`) since the dot
  // stepper landed, so it is hidden on the desktop e2e viewport. Assert the
  // viewport-independent root data-attributes the dialog always carries.
  const root = page.locator('[data-slot="medication-wizard-dialog"]');
  // Each step advance waits on per-step form validation; on a loaded CI runner
  // that settle can exceed the default 5s expect timeout (the dialog sits at
  // the prior step when the assertion first samples). Give the step-transition
  // assertion room so a slow runner doesn't read a mid-transition frame.
  await expect(root).toHaveAttribute(
    "data-display-step",
    String(displayIndex),
    {
      timeout: 20_000,
    },
  );
  if (totalSteps != null) {
    await expect(root).toHaveAttribute("data-total-steps", String(totalSteps));
  }
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
  // Pin the clock to a fixed afternoon before rendering the list. The
  // recurring stub schedules an 08:00–09:00 window; the card derives its
  // header from the real clock, so when CI happens to run inside that
  // window the card shows the "take now" (in_window) pill and the
  // "Nächste Einnahme:" next-due line is correctly suppressed — making the
  // chip assertion below depend on the wall-clock. A fixed afternoon puts
  // the morning window in the past so the next-due line always renders.
  await page.clock.setFixedTime(new Date("2026-06-04T13:00:00Z"));
  await page.goto("/medications", { waitUntil: "domcontentloaded" });
  const main = page.locator("main");
  await expect(main.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  if (withNextDueChip) {
    await expect(main.getByText(/Nächste Einnahme:/i).first()).toBeVisible({
      timeout: 10_000,
    });
  }
}
