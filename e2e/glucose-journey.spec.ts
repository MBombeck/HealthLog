/**
 * Blood glucose, from the first reading to the tile — one journey.
 *
 * The flow this file is checked against, in one script:
 *
 *   1. a reading arrives with no meal-time context, the way a meter export or
 *      a device sync delivers one;
 *   2. a person captures a reading by hand in mg/dL;
 *   3. the list shows both in mg/dL;
 *   4. they switch the account's display unit to mmol/L in settings;
 *   5. the capture form now ASKS in mmol/L, and a reading typed there is
 *      stored canonically — the list shows all three in mmol/L, each one
 *      converted, none of them reinterpreted;
 *   6. the dashboard paints the blood-glucose tile in the same unit.
 *
 * Refusing control: a value outside the accepted mg/dL band is refused by the
 * server, the capture stays open with an error, and the list is exactly what
 * it was. A journey that only ever writes acceptable numbers proves the happy
 * path and nothing about the boundary.
 *
 * Every assertion addresses a stable attribute — `data-testid`,
 * `data-measurement-type`, `data-display-unit`, `data-slot`, a placeholder —
 * never rendered copy: the labels are i18n-driven, and the same rows paint
 * through a different subtree on the card list.
 *
 * The flows mutate the one seeded account (its glucose rows AND its display
 * unit), so — like `visits.spec.ts` and `vaccinations.spec.ts` — this file
 * runs in a single project (see `playwright.config.ts`), runs serial, and
 * resets both before each test.
 */
import type { Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { resetGlucose } from "./setup/glucose-fixture";
import { expect, test } from "./setup/test";

/** Every blood-glucose row the list is currently painting. */
const GLUCOSE_ROWS =
  '[data-testid="measurement-row"][data-measurement-type="BLOOD_GLUCOSE"]';

/** The list has finished its read — rows, or the honest empty state. */
const LIST_SETTLED =
  '[data-slot="measurement-rows"], [data-slot="empty-state"]';

/**
 * Canonical mg/dL in, display mmol/L out (18.0182 mg/dL per mmol/L, rounded
 * to one fraction digit). Written out rather than imported so the spec pins
 * the numbers a reader sees instead of re-running the app's own arithmetic
 * and agreeing with itself.
 */
const READINGS = {
  /** Delivered with no meal-time context. */
  untagged: { mgdl: 112, mmol: "6.2" },
  /** Typed by hand while the account reads mg/dL. */
  typedAsMgdl: { mgdl: 95, mmol: "5.3" },
  /** Typed by hand once the account reads mmol/L; stored as 130 mg/dL. */
  typedAsMmol: { typed: "7.2", mmol: "7.2" },
} as const;

/** A locale-tolerant matcher for a decimal the formatter may render "5,3". */
function decimal(value: string): RegExp {
  return new RegExp(value.replace(".", "[.,]"));
}

async function openList(page: Page): Promise<void> {
  await page.goto("/measurements");
  await expect(page.locator(LIST_SETTLED).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Deliver a reading the way a meter export does: through the batch ingest,
 * which is the one write surface that accepts a glucose row with no
 * meal-time context. The hand-entry schema requires one — a person at the
 * reading knows the answer — so this row cannot be produced by the form, and
 * producing it any other way would be testing a fixture rather than a
 * contract.
 *
 * The POST rides the PAGE's own `fetch`, not a shared Playwright request
 * context: a pooled context can hand a POST to a keep-alive socket the server
 * has already closed, and the retry lands as a second row.
 */
async function deliverUntaggedReading(page: Page, mgdl: number): Promise<void> {
  const result = await page.evaluate(async (value: number) => {
    const at = new Date().toISOString();
    const res = await fetch("/api/measurements/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierBloodGlucose",
            value,
            unit: "mg/dL",
            startDate: at,
            endDate: at,
            externalId: `e2e-glucose-untagged-${at}`,
            source: "MANUAL",
          },
        ],
      }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { data?: { inserted?: number } },
    };
  }, mgdl);

  expect(result.status, "the batch ingest accepted the untagged row").toBe(200);
  expect(result.body.data?.inserted).toBe(1);
}

/**
 * Fold the account's measurement rollups, synchronously, through the app's own
 * operator endpoint.
 *
 * The dashboard's glucose tiles ride the snapshot's THICK phase, and that
 * phase refuses to run until the rollup tier is warm for the types the account
 * holds — a cold tier would drop the whole strip into a live-SQL fallback and
 * make every tile wait on the slowest read. Rows seeded straight into Postgres
 * by `global-setup` are never folded (nothing hooks a raw INSERT), so on a
 * freshly created database the phase is cold, `extras` comes back null, and
 * the tile a person would see on their own instance is simply absent here.
 *
 * That is a property of the harness, not of the feature, so the journey warms
 * the tier rather than asserting around it: one call, awaited, before the
 * dashboard read.
 */
async function warmRollupTier(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const me = (await (await fetch("/api/auth/me")).json()) as {
      data: { id: string };
    };
    const res = await fetch("/api/admin/rollups/recompute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: me.data.id }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { data?: { rowsUpserted?: number } },
    };
  });

  expect(result.status, "the rollup fold ran").toBe(200);
  expect(result.body.data?.rowsUpserted ?? 0).toBeGreaterThan(0);
}

/** The ISO day before the one the capture form seeded itself with. */
function previousDay(isoDay: string): string {
  const day = new Date(`${isoDay}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Drive the capture sheet through the `?add=` deep link the Insights actions
 * already use, fill the single value field, and save. Returns the status the
 * server answered the write with, so a caller can assert the refusal without
 * reading it back off the copy in the banner.
 */
async function captureReading(
  page: Page,
  opts: {
    typed: string;
    context?: string;
    expectPlaceholder?: string;
    /** Backdate to `HH:mm` on the day before the form's own default. */
    yesterdayAt?: string;
  },
): Promise<number> {
  await page.goto("/measurements?add=BLOOD_GLUCOSE");

  const sheet = page.locator('[data-slot="responsive-sheet-content"]');
  await expect(sheet).toBeVisible({ timeout: 30_000 });

  const valueField = sheet.locator("#value");
  await expect(valueField).toBeVisible();
  if (opts.expectPlaceholder) {
    // The placeholder is the form saying which unit it is asking in, in an
    // attribute rather than in copy.
    await expect(valueField).toHaveAttribute(
      "placeholder",
      opts.expectPlaceholder,
    );
  }
  await valueField.fill(opts.typed);

  if (opts.yesterdayAt) {
    // Two readings that share a minute share a row identity — `(user, type,
    // measuredAt)` is unique and the second one is refused — so a journey
    // that captures twice has to place them, exactly as a person would.
    // Yesterday rather than an earlier hour today: any hour is in the past on
    // a past day, so the picker's no-future clamp cannot pull the instant
    // back onto the same minute as the other reading whatever the hour the
    // suite happens to run at.
    const dateField = page.locator(
      '[data-slot="date-time-field"] [data-slot="date-field"]',
    );
    const seededDay = await dateField
      .locator('input[type="hidden"]')
      .inputValue();
    const day = previousDay(seededDay);
    // The overlay parses a clean ISO string ahead of the account's own
    // date-format preference, so the spec does not have to know it.
    await dateField.locator('input[type="text"]').fill(day);
    await dateField.locator('input[type="text"]').blur();
    await expect(dateField.locator('input[type="hidden"]')).toHaveValue(day);

    const timeField = page.locator(
      '[data-slot="date-time-field"] [data-slot="time-field"]',
    );
    await timeField.locator('input[type="text"]').fill(opts.yesterdayAt);
    await timeField.locator('input[type="text"]').blur();
    await expect(timeField.locator('input[type="hidden"]')).toHaveValue(
      opts.yesterdayAt,
    );
  }

  if (opts.context) {
    // The meal-time context defaults to fasting; anything else is a choice
    // the person makes, addressed by the enum the option carries.
    await sheet.locator("#glucose-context").click();
    const option = page.locator(
      `[data-slot="select-item"][data-glucose-context="${opts.context}"]`,
    );
    await expect(option).toBeVisible();
    await option.click();
    await expect(option).toHaveCount(0);
  }

  const write = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/measurements" &&
      res.request().method() === "POST",
  );
  await sheet
    .locator('[data-slot="responsive-sheet-footer"] button[type="submit"]')
    .click();
  return (await write).status();
}

/** Switch the account's blood-glucose display unit through settings. */
async function chooseGlucoseUnit(page: Page, unit: string): Promise<void> {
  await page.goto("/settings/account");

  const select = page.getByTestId("settings-glucose-unit-select");
  await expect(select).toBeVisible({ timeout: 30_000 });
  // The control disables itself until the account payload has landed; a
  // change dispatched before that is dropped by its own guard.
  await expect(select).toBeEnabled();

  const saved = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === "/api/auth/me/glucose-unit" &&
      res.request().method() === "PATCH",
  );
  await select.selectOption(unit);
  expect((await saved).status()).toBe(200);
  await expect(select).toHaveValue(unit);
}

test.beforeEach(async () => {
  // Own every row the counts below read, and undo the switch the journey
  // itself performs — the unit is a column on the shared account, so a run
  // that left it on mmol/L would start the next one past the half it means
  // to prove.
  await resetGlucose();
});

// Serial and single-account: the reset above would race a sibling worker, and
// two tests clearing the same rows would each undo the other's setup.
test.describe.configure({ mode: "serial" });

test.describe("blood glucose", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  // The dashboard is the most expensive page in the product to render cold,
  // and this journey ends there after four navigations. The budget is the
  // page's; the assertions stay exactly as tight as they were.
  test.setTimeout(120_000);

  test("readings captured either side of a unit switch all read in the chosen unit", async ({
    page,
  }) => {
    await openList(page);
    await deliverUntaggedReading(page, READINGS.untagged.mgdl);
    await warmRollupTier(page);

    // Hand entry, while the account still reads mg/dL.
    expect(
      await captureReading(page, {
        typed: String(READINGS.typedAsMgdl.mgdl),
        yesterdayAt: "07:30",
        expectPlaceholder: "95",
      }),
    ).toBe(201);

    await openList(page);
    const rows = page.locator(GLUCOSE_ROWS);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-display-unit", "mg/dL");
    await expect(
      page.locator(`${GLUCOSE_ROWS}[data-display-unit="mg/dL"]`),
    ).toHaveCount(2);

    // The switch.
    await chooseGlucoseUnit(page, "mmol/L");

    // The form now ASKS in mmol/L — its placeholder says so — and what it
    // stores is still canonical mg/dL, which is what the read-back proves.
    // Bedtime rather than fasting, so each hand-entered reading owns a tile
    // and each tile's "latest" names exactly one of them — a strip where two
    // readings share a bucket would prove only that one of them won.
    expect(
      await captureReading(page, {
        typed: READINGS.typedAsMmol.typed,
        context: "BEDTIME",
        expectPlaceholder: "5.3",
      }),
    ).toBe(201);

    await openList(page);
    await expect(rows).toHaveCount(3);
    await expect(
      page.locator(`${GLUCOSE_ROWS}[data-display-unit="mmol/L"]`),
    ).toHaveCount(3);

    // Each reading converted, none reinterpreted: 112 → 6.2, 95 → 5.3, and
    // the 7.2 typed in mmol/L comes back as the 7.2 it was.
    for (const expected of [
      READINGS.untagged.mmol,
      READINGS.typedAsMgdl.mmol,
      READINGS.typedAsMmol.mmol,
    ]) {
      await expect(
        rows
          .locator('[data-slot="measurement-row-value"]')
          .filter({ hasText: decimal(expected) }),
      ).toHaveCount(1);
    }

    // The dashboard reads the same account preference: one tile per meal-time
    // context, each carrying its own reading in mmol/L.
    await page.goto("/");
    for (const [tileId, value] of [
      ["glucose-FASTING", READINGS.typedAsMgdl.mmol],
      ["glucose-BEDTIME", READINGS.typedAsMmol.mmol],
    ] as const) {
      const tile = page.locator(
        `[data-slot="dashboard-tile-link"][data-tile-id="${tileId}"]`,
      );
      await expect(tile).toBeVisible({ timeout: 60_000 });
      await expect(tile.locator('[data-slot="trend-card-value"]')).toHaveText(
        decimal(value),
      );
    }
  });

  test("a reading with no meal-time context gets a tile of its own", async ({
    page,
  }) => {
    test.skip(
      true,
      "#943 — tile eligibility filters the four named meal-time contexts " +
        "against the per-context summaries, so an account whose source records " +
        "no meal time matches none of them and the strip is silently short one " +
        "card. The fix names the untagged bucket and walks it with the rest; it " +
        "is not on main yet. Unskip with it, do not weaken the assertion — a " +
        "check that cannot fail is worse than none.",
    );

    await openList(page);
    await deliverUntaggedReading(page, READINGS.untagged.mgdl);
    await warmRollupTier(page);

    await page.goto("/");
    const tile = page.locator(
      '[data-slot="dashboard-tile-link"][data-tile-id="glucose-UNSPECIFIED"]',
    );
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await expect(tile.locator('[data-slot="trend-card-value"]')).toHaveText(
      decimal(String(READINGS.untagged.mgdl)),
    );
  });

  test("a value outside the accepted band is refused and the list is unchanged", async ({
    page,
  }) => {
    await openList(page);
    await deliverUntaggedReading(page, READINGS.untagged.mgdl);

    await openList(page);
    await expect(page.locator(GLUCOSE_ROWS)).toHaveCount(1);

    // 900 mg/dL is past the plausible ceiling (20–800). The field carries no
    // min/max of its own, so the refusal is the server's and this is a real
    // round trip, not a browser-side block.
    expect(await captureReading(page, { typed: "900" })).toBe(422);

    // The capture stays open, carrying the error and the entered value: a
    // refusal must not cost the person what they typed.
    const sheet = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(sheet.getByRole("alert")).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("#value")).toHaveValue("900");

    // And the list behind it is exactly what it was.
    await openList(page);
    const rows = page.locator(GLUCOSE_ROWS);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-display-unit", "mg/dL");
    await expect(
      rows.locator('[data-slot="measurement-row-value"]'),
    ).toHaveText(decimal(String(READINGS.untagged.mgdl)));
  });
});
