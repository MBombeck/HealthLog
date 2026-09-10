/**
 * Medication adherence, proven end to end.
 *
 * The percentage on a medication card is the number this product is for, and
 * until now nothing in the browser suite walked the path that produces it: the
 * wizard specs stub `/api/medications` and stop at the POST body, and the
 * compliance engine's own tests are unit tests over pure functions. So the one
 * thing nobody checked was the join — that a tap on "Genommen" reaches the
 * engine, and that the engine's answer reaches every surface that shows it.
 *
 * Three flows:
 *
 *   1. Journey — a twice-daily medication created through the real wizard, one
 *      dose taken and one skipped from the card, and the resulting figure read
 *      back on the card, in the intake history and on the dashboard tile.
 *   2. Refusal — an intake against a medication this account does not own, and
 *      one against a slot its schedule does not have, are both refused and the
 *      rate is exactly what it was before.
 *   3. Cadence — a medication due on two weekdays does not count the other
 *      five as missed. Its daily twin, given the identical doses, does.
 *
 * Every assertion addresses a `data-slot` / `data-*` attribute rather than
 * viewport text: the copy is i18n-driven and the wizard runs in German, so
 * addressing a control by its label would assert the translation.
 *
 * The flows write rows and read counts back off them, so they run on their own
 * account (`E2E_MEDICATION`) — the rate a card shows is a percentage over one
 * cabinet, and a sibling spec mounting `/medications` in the other worker
 * would otherwise be spending the same per-actor read allowance and sitting in
 * the same dashboard denominator. The file still runs serial and in a single
 * project (see `playwright.config.ts`), because its three tests share that one
 * cabinet with each other.
 *
 * Why the medications are aged (`ageMedication`): compliance is reconstructed
 * from the medication's creation stamp forward, so a medication created a
 * second ago has expected no dose yet and reads the empty-set 100 %. A number
 * that cannot move is a number this spec cannot check, so each flow puts a few
 * days of unlogged history behind its medication first — which is also the
 * only state in which "missed" means anything.
 */
import type { Page } from "@playwright/test";

import { MEDICATION_STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ageMedication,
  resetMedications,
  type MedicationAgeStamps,
} from "./setup/medication-fixture";
import { expect, test } from "./setup/test";
import {
  clickNext,
  clickSave,
  expectStep,
  fillStep1Name,
  fillStep3Dose,
  openCreateWizard,
  pickCadenceRow,
  pickTreatmentRow,
} from "./medications-wizard-helpers";

/** One `{ data, error }` envelope as the browser sees it. */
interface ApiResult<T> {
  status: number;
  data: T | null;
}

/** The slice of `GET /api/medications/{id}/compliance` these flows read. */
interface CompliancePayload {
  compliance7: {
    totalExpected: number;
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
  };
  complianceDisplay: {
    shortDays: number;
    short: { rate: number; taken: number; expected: number; missed: number };
  };
}

/**
 * Call the API the way the app does: from the page's own `fetch`, on the
 * page's origin, with the session cookie the browser already holds. A
 * request issued from the test process would carry a different jar and would
 * not exercise the same-origin path every client write takes.
 */
async function api<T>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      // Read the body as text first: a refusal is allowed to answer with no
      // body at all, and a bare `res.json()` would then throw a parse error
      // over the status code the assertion is actually about.
      const raw = await res.text();
      const envelope = raw ? (JSON.parse(raw) as { data: unknown }) : null;
      return { status: res.status, data: (envelope?.data ?? null) as never };
    },
    { method, path, body },
  );
}

/** One schedule entry as `POST /api/medications` accepts it. */
interface SeedSchedule {
  windowStart: string;
  windowEnd: string;
  timesOfDay: string[];
  rrule: string;
}

/** Create a medication through the page's own fetch. Returns its id. */
async function seedMedication(
  page: Page,
  input: {
    name: string;
    dose: string;
    startsOn: string;
    schedule: SeedSchedule;
  },
): Promise<string> {
  const created = await api<{ id: string }>(page, "POST", "/api/medications", {
    name: input.name,
    dose: input.dose,
    startsOn: input.startsOn,
    schedules: [input.schedule],
  });
  expect(created.status, `create ${input.name}`).toBe(201);
  const id = created.data?.id;
  expect(id, `created ${input.name} carries an id`).toBeTruthy();
  return id as string;
}

/**
 * The two stamps `ageMedication` writes, computed in the browser's clock.
 *
 * Deliberately not in SQL: `CURRENT_DATE` resolves in the database session's
 * zone, the plan dates every flow sends are computed here, and between
 * midnight and 02:00 Berlin those are different calendar days.
 */
async function ageStamps(
  page: Page,
  days: number,
): Promise<MedicationAgeStamps> {
  return page.evaluate((days) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const at = new Date();
    at.setDate(at.getDate() - days);
    return {
      createdAt: at.toISOString(),
      startsOn: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    };
  }, days);
}

/**
 * The write `ageMedication` uses to flush the server's memoised compliance
 * cells after it has edited the row underneath them: an ordinary update that
 * re-sends the dose the medication already has.
 */
function cacheFlusher(page: Page, medicationId: string, dose: string) {
  return async () => {
    const saved = await api<{ id: string }>(
      page,
      "PUT",
      `/api/medications/${medicationId}`,
      { dose },
    );
    expect(saved.status, "cache-flushing update").toBe(200);
  };
}

/** The compliance block on a medication card, as the card renders it. */
function complianceBlock(page: Page, medicationId: string) {
  return page
    .locator(`[data-medication-id="${medicationId}"]`)
    .locator('[data-slot="medication-card-compliance"]')
    .first();
}

/**
 * Read the card's short-window adherence percentage.
 *
 * The rate's presence is the gate: the skeleton and the quiet error fallback
 * reserve the same footprint as the loaded bars and carry no rates, so an
 * attribute that is there is a figure the card really painted. Twenty seconds
 * is the list's own load-plus-fetch budget and nothing more — the account is
 * this spec's own, so a card with no figure on it is a defect rather than a
 * neighbour's spent read allowance.
 */
async function readCardRate(page: Page, medicationId: string): Promise<number> {
  const block = complianceBlock(page, medicationId);
  await expect(
    block,
    "the card never painted an adherence figure",
  ).toHaveAttribute("data-rate-short", /^\d+$/, { timeout: 20_000 });
  return Number(await block.getAttribute("data-rate-short"));
}

/** The dashboard tile's most recent day, as the tile itself computed it. */
async function readTileLatestRate(page: Page): Promise<number> {
  const tile = page.locator('[data-slot="medication-compliance-chart"]');
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await expect(tile).toHaveAttribute("data-latest-rate", /^\d+$/, {
    timeout: 15_000,
  });
  return Number(await tile.getAttribute("data-latest-rate"));
}

/**
 * Open a surface the reset and the seeding calls can run from.
 *
 * Both go out as the page's own `fetch`, so the page has to be on the app's
 * origin first. Deliberately NOT the medications list: the reset that follows
 * deletes rows, and a list mount would first fetch compliance for every one of
 * them.
 */
async function openSeedingSurface(page: Page): Promise<void> {
  await page.goto("/profile");
  // The shell's own main region, not `main` — the profile page nests a second
  // one inside it and a bare tag selector is ambiguous there.
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 15_000 });
}

/**
 * The two dose times the journey's medication runs on: now, and twelve hours
 * from now.
 *
 * They are derived from the clock rather than picked from the wizard's
 * suggestion chips, and that is the whole reason the flow is stable. The card
 * offers exactly one dose — the open window, else the next one due — so with
 * fixed times there is always an hour of the day at which the dose it offers
 * belongs to yesterday or to tomorrow, and the day the write lands on decides
 * what the dashboard tile reads. A slot anchored at "now" is inside its own
 * on-time window by construction, so the take is always today's, whenever the
 * suite runs. Its twin twelve hours away is the second dose of the day.
 */
async function clockAnchoredDoseTimes(
  page: Page,
): Promise<{ open: string; other: string }> {
  return page.evaluate(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    return {
      open: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      other: `${pad((now.getHours() + 12) % 24)}:${pad(now.getMinutes())}`,
    };
  });
}

/**
 * Add one `HH:mm` to the wizard's times-of-day chips.
 *
 * The Enter press is the commit, not a flourish: the field's overlay input
 * holds what is being typed and only hands it to the form on Enter or on blur
 * (`src/components/ui/time-field.tsx:175-184`). Until then the draft is empty,
 * and the add button is `disabled` on exactly that
 * (`times-of-day-chips.tsx:267`) — so a fill followed straight by a click
 * waits out the actionability timeout on a button that never enables.
 */
async function addDoseTime(page: Page, time: string): Promise<void> {
  const chips = page.locator('[data-slot="times-of-day-chips"]');
  const draft = chips.getByTestId("times-of-day-draft-input");
  await draft.fill(time);
  await draft.press("Enter");
  await chips.locator('[data-slot="times-of-day-add"]').click();
  await expect(
    chips.locator(`[data-slot="times-of-day-chip"][data-time="${time}"]`),
  ).toBeVisible();
}

/**
 * Walk the create wizard for a twice-daily medication and return its id.
 * Reuses the cadence specs' step helpers; unlike those specs it leaves
 * `/api/medications` unstubbed, so the medication is really written.
 */
async function createTwiceDailyMedication(
  page: Page,
  name: string,
): Promise<{ id: string; times: { open: string; other: string } }> {
  await openCreateWizard(page);
  const times = await clockAnchoredDoseTimes(page);

  await fillStep1Name(page, { name });
  await clickNext(page);

  await expectStep(page, 2);
  await pickTreatmentRow(page, "other");
  await clickNext(page);

  await expectStep(page, 3);
  await fillStep3Dose(page, { amount: "500" });
  await clickNext(page);

  await expectStep(page, 4);
  await clickNext(page);

  await expectStep(page, 5, 8);
  await pickCadenceRow(page, "daily");
  // Picking a daily cadence compresses the path from eight steps to seven.
  await expectStep(page, 5, 7);
  await clickNext(page);

  // Times of day — the step arrives with 08:00 already on it. Add the two the
  // journey needs, then drop 08:00 unless it is one of them, so the plan is
  // exactly twice daily.
  await expectStep(page, 6, 7);
  const chips = page.locator('[data-slot="times-of-day-chips"]');
  await addDoseTime(page, times.open);
  await addDoseTime(page, times.other);
  if (times.open !== "08:00" && times.other !== "08:00") {
    await chips
      .locator('[data-slot="times-of-day-chip"][data-time="08:00"]')
      .locator('[data-slot="times-of-day-chip-remove"]')
      .click();
  }
  await expect(chips.locator('[data-slot="times-of-day-chip"]')).toHaveCount(2);
  await clickNext(page);

  await expectStep(page, 7, 7);
  await clickSave(page);

  await page.waitForURL(/\/medications\/[^/?]+$/, { timeout: 15_000 });
  const id = new URL(page.url()).pathname.split("/").pop();
  expect(id, "the create flow lands on the new medication").toBeTruthy();
  return { id: id as string, times };
}

// Serial: the three tests share one cabinet, and two of them clearing it at
// once would each undo the other's setup.
test.describe.configure({ mode: "serial" });

test.describe("medication adherence journey", () => {
  test.use({ storageState: MEDICATION_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Own every row the rates count. The dashboard tile sums the expected
    // doses of every active medication on the account, so a leftover from a
    // previous run would sit in its denominator. The removal goes out as the
    // app's own DELETE so the server's memoised medication cells go with it.
    await openSeedingSurface(page);
    await resetMedications(async (id) => {
      const removed = await api(page, "DELETE", `/api/medications/${id}`);
      expect(removed.status, "clearing a leftover medication").toBe(200);
    });
  });

  test("a taken and a skipped dose move the card, the history and the dashboard tile", async ({
    page,
  }) => {
    // The wizard is a seven-step dialog with per-step validation gating Next;
    // on a loaded runner that settle earns the tripled timeout.
    test.slow();

    // The tile reads THE LATEST day, and a day boundary crossed mid-flow moves
    // that day out from under both tile assertions: a fresh day has two doses
    // scheduled, none taken, and answers 0 where 50 is asserted. The flow is a
    // couple of minutes long, so declining to start in the last ten of the day
    // is enough. The clock is the browser's, which the config pins to the zone
    // the compliance engine falls back to.
    const minutesLeftInDay = await page.evaluate(
      () => 24 * 60 - (new Date().getHours() * 60 + new Date().getMinutes()),
    );
    test.skip(
      minutesLeftInDay < 10,
      "starts inside the last ten minutes of the day — the dashboard tile's latest day would change under the flow",
    );

    const { id: medicationId } = await createTwiceDailyMedication(
      page,
      "E2E Adhärenz",
    );
    // Four days of plan behind it, none of it logged: the engine expects two
    // doses a day and nobody took any, so the starting rate is a real 0 %.
    await ageMedication(
      medicationId,
      await ageStamps(page, 4),
      cacheFlusher(page, medicationId, "500 mg"),
    );

    // --- before ------------------------------------------------------------
    await page.goto("/");
    expect(await readTileLatestRate(page)).toBe(0);

    await page.goto("/medications");
    expect(await readCardRate(page, medicationId)).toBe(0);

    // --- the two gestures --------------------------------------------------
    const card = page.locator(`[data-medication-id="${medicationId}"]`);
    const intakePath = `/api/medications/${medicationId}/intake`;

    const takeWritten = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === intakePath &&
        res.request().method() === "POST",
    );
    await card.locator('[data-slot="medication-intake-take"]').click();
    expect((await takeWritten).status(), "the take is written").toBe(201);

    // The skip must land on the OTHER dose, so it has to wait for the card to
    // re-read its schedule: the card binds each write to the slot it is
    // currently showing, and a skip fired against a stale render would flip
    // the dose just taken instead of recording a second one. The rate leaving
    // zero is the card's own confirmation that the refetch landed.
    await expect
      .poll(
        () =>
          complianceBlock(page, medicationId).getAttribute("data-rate-short"),
        {
          timeout: 30_000,
          message: "the card never re-read its schedule after the take",
        },
      )
      .toMatch(/^[1-9]\d*$/);
    const skipWritten = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === intakePath &&
        res.request().method() === "POST",
    );
    await card.locator('[data-slot="medication-intake-skip"]').click();
    expect((await skipWritten).status(), "the skip is written").toBe(201);

    // --- the card agrees with the engine -----------------------------------
    const payload = await api<CompliancePayload>(
      page,
      "GET",
      `/api/medications/${medicationId}/compliance`,
    );
    expect(payload.status).toBe(200);
    const compliance = payload.data as CompliancePayload;

    // One dose taken, one deliberately skipped, and the four days of plan
    // nobody logged still counting against the rate.
    expect(compliance.compliance7.taken).toBe(1);
    expect(compliance.compliance7.missed).toBeGreaterThanOrEqual(6);
    expect(compliance.complianceDisplay.shortDays).toBe(7);
    expect(compliance.complianceDisplay.short.taken).toBe(1);

    // A skip is a decision, not a failure: it never enters the denominator.
    // So the rate has moved off zero and is nowhere near a hundred — one dose
    // taken against at least six missed.
    const rateAfter = await readCardRate(page, medicationId);
    expect(rateAfter).toBe(compliance.complianceDisplay.short.rate);
    expect(rateAfter).toBeGreaterThan(0);
    expect(rateAfter).toBeLessThanOrEqual(20);

    // --- the intake history shows both events, each as what it was ----------
    // The 90-day ledger beside it is a view of the SCHEDULE and stops at now,
    // so a dose skipped ahead of its window is not in it. The intake history
    // is the view of what was recorded, and both gestures belong there.
    await page.goto(`/medications/${medicationId}?tab=verlauf`);
    await page
      .locator('[data-slot="medication-verlauf-view-toggle-all"]')
      .click();
    const history = page.locator('[data-slot="intake-history-row"]');
    await expect(history).toHaveCount(2, { timeout: 15_000 });
    await expect(
      page.locator('[data-slot="intake-history-row"][data-status="taken"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-slot="intake-history-row"][data-status="skipped"]'),
    ).toHaveCount(1);

    // --- and the dashboard tile, which answers the skip the same way -------
    // Today expected two doses; one was taken and one deliberately skipped.
    //
    // A skip is a pause, not a miss, on every surface: the card's engine
    // (`src/lib/analytics/compliance.ts`, the documented single source of the
    // percentage) drops a skip from the denominator outright
    // (`src/lib/analytics/compliance/ledger.ts`), and the tile's
    // schedule-anchored engine (`src/lib/analytics/schedule-anchored-compliance.ts`)
    // subtracts the day's skips from its expected slots for the same reason,
    // so the one taken dose over the one remaining slot reads 100 here as it
    // does on the card. The two engines are held to one figure by
    // `src/lib/analytics/__tests__/compliance-skip-parity.test.ts`; this read
    // proves the tile actually paints it.
    await page.goto("/");
    expect(await readTileLatestRate(page)).toBe(100);
  });

  test("an intake against an unowned medication, and one against a slot the schedule does not have, are both refused", async ({
    page,
  }) => {
    // Two full list loads either side of the refusals, plus a seed and an age;
    // on a loaded runner that settle earns the tripled timeout.
    test.slow();

    const stamps = await ageStamps(page, 4);
    // An instant the schedule below does not have a slot for. Computed here,
    // before the first navigation, so the whole test body reads as one setup
    // step followed by assertions on it.
    const unscheduled = await page.evaluate(() => {
      const at = new Date();
      at.setHours(3, 17, 0, 0);
      return at.toISOString();
    });
    const medicationId = await seedMedication(page, {
      name: "E2E Ablehnung",
      dose: "10 mg",
      startsOn: stamps.startsOn,
      schedule: {
        windowStart: "08:00",
        windowEnd: "09:00",
        timesOfDay: ["08:00", "22:00"],
        rrule: "FREQ=DAILY",
      },
    });
    await ageMedication(
      medicationId,
      stamps,
      cacheFlusher(page, medicationId, "10 mg"),
    );

    await page.goto("/medications");
    const before = await readCardRate(page, medicationId);

    // A medication id nothing on this account owns. The privacy gate answers
    // before the body is even read, so the 404 is about ownership and says
    // nothing about the medication existing elsewhere.
    const unowned = await api(
      page,
      "POST",
      "/api/medications/med_e2e_does_not_exist/intake",
      { skipped: false },
    );
    expect(unowned.status, "an unowned medication is refused").toBe(404);

    // And the schedule's own boundary: this medication doses at 08:00 and
    // 22:00, so 03:17 is not one of its slots and the pin is refused rather
    // than silently recorded as an ad-hoc dose.
    const offSlot = await api(
      page,
      "POST",
      `/api/medications/${medicationId}/intake`,
      {
        skipped: false,
        forceSlotInstant: unscheduled,
      },
    );
    expect(offSlot.status, "an instant that is not a slot is refused").toBe(
      422,
    );

    // Nothing was written, so nothing moved — including on the engine's own
    // read, which neither refused call had an opportunity to invalidate.
    const payload = await api<CompliancePayload>(
      page,
      "GET",
      `/api/medications/${medicationId}/compliance`,
    );
    expect(payload.status).toBe(200);
    expect((payload.data as CompliancePayload).compliance7.taken).toBe(0);

    await page.goto("/medications");
    expect(await readCardRate(page, medicationId)).toBe(before);
  });

  test("a two-weekday plan does not count the other five days as missed", async ({
    page,
  }) => {
    // Two medications seeded, aged and dosed three times apiece before the
    // first assertion; on a loaded runner that earns the tripled timeout.
    test.slow();

    // Both dose days are behind us and neither is today, so the plan's whole
    // realised history is closed and the verdicts do not depend on the hour
    // the suite runs at. The 08:00 dose eight days back falls on the same
    // weekday as yesterday's, which is what keeps the longer window's answer
    // the same as the short one's.
    const plan = await page.evaluate(() => {
      const TOKENS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      const at8 = (daysAgo: number) => {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        d.setHours(8, 0, 0, 0);
        return d;
      };
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const doseDays = [at8(8), at8(2), at8(1)];
      return {
        byday: [TOKENS[at8(2).getDay()], TOKENS[at8(1).getDay()]].join(","),
        startsOn: iso(at8(8)),
        slots: doseDays.map((d) => d.toISOString()),
      };
    });

    const weekdayId = await seedMedication(page, {
      name: "E2E Wochentage",
      dose: "5 mg",
      startsOn: plan.startsOn,
      schedule: {
        windowStart: "08:00",
        windowEnd: "09:00",
        timesOfDay: ["08:00"],
        rrule: `FREQ=WEEKLY;BYDAY=${plan.byday}`,
      },
    });
    // The control: the same doses on the same days, on a plan that expects one
    // every day. Without it "100 %" proves nothing — an engine that counted no
    // days at all would also read 100 %.
    const dailyId = await seedMedication(page, {
      name: "E2E Täglich",
      dose: "5 mg",
      startsOn: plan.startsOn,
      schedule: {
        windowStart: "08:00",
        windowEnd: "09:00",
        timesOfDay: ["08:00"],
        rrule: "FREQ=DAILY",
      },
    });

    const stamps = await ageStamps(page, 8);
    for (const id of [weekdayId, dailyId]) {
      await ageMedication(id, stamps, cacheFlusher(page, id, "5 mg"));
      for (const slot of plan.slots) {
        const written = await api(
          page,
          "POST",
          `/api/medications/${id}/intake`,
          {
            skipped: false,
            scheduledFor: slot,
            takenAt: slot,
          },
        );
        expect(written.status, "a backdated dose is written").toBe(201);
      }
    }

    const read = async (id: string) => {
      const res = await api<CompliancePayload>(
        page,
        "GET",
        `/api/medications/${id}/compliance`,
      );
      expect(res.status).toBe(200);
      return (res.data as CompliancePayload).compliance7;
    };
    const weekday = await read(weekdayId);
    const daily = await read(dailyId);

    // Two dose days in the trailing week, both taken, none missed. If the five
    // non-dose weekdays reached the denominator this would read seven.
    expect(weekday.totalExpected).toBe(2);
    expect(weekday.taken).toBe(2);
    expect(weekday.missed).toBe(0);
    expect(weekday.rate).toBe(100);

    // The daily twin, given exactly the same doses, is missing the rest.
    expect(daily.totalExpected).toBeGreaterThanOrEqual(6);
    expect(daily.missed).toBeGreaterThanOrEqual(4);
    expect(daily.rate).toBeLessThan(100);

    // And the two cards say the same thing side by side.
    await page.goto("/medications");
    expect(await readCardRate(page, weekdayId)).toBe(100);
    expect(await readCardRate(page, dailyId)).toBeLessThan(100);
  });
});
