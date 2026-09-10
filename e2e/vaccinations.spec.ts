/**
 * The immunization log, proven end to end.
 *
 * Five flows, one script each, each assertion addressed to a stable
 * `data-slot` / `data-*` attribute and never to viewport text — the copy is
 * i18n-driven and the same slots paint at a different size on the mobile
 * project, so a text assertion would break for the wrong reason.
 *
 *   1. Transcribe — a catalogue pick plus a lot number saves and reads back in
 *      its antigen group with a resolved series label.
 *   2. Combination — one Tdap renders a row in each of its three component
 *      groups, the render-only duplication the series design exists for.
 *   3. Mint + satisfy — confirming the booster prompt writes an ordinary
 *      Vorsorge reminder that shows on `/checkups`; logging the next dose moves
 *      its due date forward through the real satisfy matcher.
 *   4. Module off — turning the module off in settings drops the nav entry and
 *      the direct visit lands on the module-off redirect, not a crash.
 *   5. a11y — axe over the list and the capture form, serious/critical only.
 *
 * The flows mutate the one seeded account, so — like `visits.spec.ts` — this
 * file runs in a single project (see `playwright.config.ts`) and serial, and
 * clears its own rows before each test so a grouped verdict counts only what
 * the test itself wrote.
 */
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import {
  ensureVaccinationsModuleOn,
  resetVaccinations,
} from "./setup/vaccination-fixture";

test.beforeEach(async () => {
  // Own the counts every grouped assertion reads, and undo whatever the
  // module-off flow left behind.
  await resetVaccinations();
  await ensureVaccinationsModuleOn();
});

// Serial and single-account: the reset above would race a sibling worker, and
// two tests clearing the same rows would each undo the other's setup.
test.describe.configure({ mode: "serial" });

/** One reminder as the list route publishes it. */
interface ReminderDTO {
  id: string;
  origin: string;
  nextDueAt: string | null;
}

async function listReminders(
  request: APIRequestContext,
): Promise<ReminderDTO[]> {
  const res = await request.get("/api/measurement-reminders");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: ReminderDTO[] }).data;
}

async function listVaccinationIds(
  request: APIRequestContext,
): Promise<string[]> {
  const res = await request.get("/api/vaccinations");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: { vaccinations: { id: string }[] };
  };
  return body.data.vaccinations.map((row) => row.id);
}

/**
 * Drive the capture sheet: open it, pick a catalogue antigen by its slug, set
 * the date and an optional lot, and save. `booster` says what to do with the
 * mint prompt a booster-bearing antigen raises after the save.
 */
async function captureDose(
  page: Page,
  opts: {
    catalogSlug: string;
    /** `YYYY-MM-DD`. Defaults to the form's own today. */
    date?: string;
    lot?: string;
    booster: "confirm" | "decline" | "none";
  },
): Promise<void> {
  // The header Add renders whether or not the list is empty, so clicking it
  // works in both states. click() auto-waits for the button to be actionable,
  // which avoids racing an instant visibility read against the client render
  // (an empty-state-only branch times out once a record already exists).
  await page.locator('[data-slot="vaccination-add"]').first().click();

  await expect(page.locator('[data-slot="vaccination-form"]')).toBeVisible();

  if (opts.date) {
    await page.getByTestId("vaccination-occurred-at").fill(opts.date);
  }

  await page.locator('[data-slot="vaccination-catalog-trigger"]').click();
  await page
    .locator('[data-slot="vaccination-catalog-search"]')
    .fill(opts.catalogSlug);
  await page
    .locator(
      `[data-slot="vaccination-catalog-option"][data-catalog-slug="${opts.catalogSlug}"]`,
    )
    .click();

  if (opts.lot) {
    await page.locator("#vaccination-lot").fill(opts.lot);
  }

  await page.locator('[data-slot="vaccination-save"]').click();

  if (opts.booster === "confirm") {
    await page.locator('[data-slot="vaccination-booster-confirm"]').click();
  } else if (opts.booster === "decline") {
    await page.locator('[data-slot="vaccination-booster-decline"]').click();
  }
  // The prompt (when raised) and the save button both leave the tree once the
  // flow settles; waiting on the save button's detachment keeps the next step
  // off a stale sheet.
  await expect(page.locator('[data-slot="vaccination-save"]')).toBeHidden();
}

test.describe("vaccinations", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("a dose transcribed with a catalogue pick and a lot reads back in its antigen group", async ({
    page,
    request,
  }) => {
    await page.goto("/vaccinations");

    // Polio carries no booster interval, so the capture completes without a
    // mint prompt — this flow is about the transcription, not the reminder.
    await captureDose(page, {
      catalogSlug: "polio",
      lot: "LOT-E2E-001",
      booster: "none",
    });

    const [id] = await listVaccinationIds(request);
    expect(id, "the dose was written").toBeTruthy();

    const group = page.locator(
      '[data-slot="vaccination-group"][data-antigen="polio"]',
    );
    await expect(group).toBeVisible({ timeout: 15_000 });

    const row = group.locator(`[data-vaccination-id="${id}"]`);
    await expect(row).toBeVisible();
    // The series label is resolved server-side and rendered as its own slot.
    await expect(row.locator('[data-slot="vaccination-series"]')).toBeVisible();
    // The lot rides the row's meta line under its own slot.
    await expect(row.locator('[data-slot="vaccination-lot"]')).toBeVisible();
  });

  test("a combination dose appears in each of its three component groups", async ({
    page,
    request,
  }) => {
    await page.goto("/vaccinations");

    // Tdap's primary component (tetanus) carries a booster interval, so the
    // mint prompt is raised — decline it; this flow is about the grouping.
    await captureDose(page, { catalogSlug: "tdap", booster: "decline" });

    const [id] = await listVaccinationIds(request);
    expect(id, "the Tdap dose was written").toBeTruthy();

    // One record, three appearances — once under each component antigen, each
    // its own group, each carrying the same record id.
    for (const antigen of ["tetanus", "diphtheria", "pertussis"] as const) {
      const row = page.locator(
        `[data-slot="vaccination-group"][data-antigen="${antigen}"] [data-vaccination-id="${id}"]`,
      );
      await expect(row, `Tdap appears under ${antigen}`).toBeVisible({
        timeout: 15_000,
      });
    }
  });

  test("confirming the booster prompt mints a reminder that a logged next dose re-anchors", async ({
    page,
    request,
  }) => {
    const before = new Set((await listReminders(request)).map((r) => r.id));

    await page.goto("/vaccinations");

    // The first dose sits years back, so the minted reminder's first due date
    // (dose + interval) is anchored in the past relative to a dose logged now —
    // which is what lets the re-anchor below prove a forward move.
    await captureDose(page, {
      catalogSlug: "tetanus",
      date: "2016-03-15",
      booster: "confirm",
    });

    // Confirming the prompt closes the sheet before the mint's write has
    // necessarily propagated to the list route, so poll for the new reminder
    // rather than reading once against an in-flight mutation.
    await expect
      .poll(
        async () =>
          (await listReminders(request)).filter((r) => !before.has(r.id))
            .length,
        { timeout: 15_000 },
      )
      .toBe(1);

    const minted = (await listReminders(request)).find(
      (r) => !before.has(r.id),
    );
    expect(minted, "the mint wrote exactly one new reminder").toBeDefined();
    expect(minted!.origin).toBe("VORSORGE");
    expect(minted!.nextDueAt).toBeTruthy();
    const dueBefore = new Date(minted!.nextDueAt!).getTime();

    // It presents on /checkups like every other Vorsorge reminder — the file-a
    // -visit affordance only paints on a rendered reminder card, so it standing
    // in for "a reminder card is here" is a stable per-card slot.
    await page.goto("/checkups");
    await expect(
      page.locator('[data-slot="vorsorge-file-visit"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Log the next dose today. The Phase 1 satisfy matcher re-anchors the
    // minted reminder on this dose during the create, so its due date moves
    // forward off the years-old anchor.
    await page.goto("/vaccinations");
    await captureDose(page, { catalogSlug: "tetanus", booster: "decline" });

    // The satisfy re-anchor runs inside the second dose's create transaction;
    // poll the reminder's due date forward rather than reading once, so a scan
    // that beats the commit does not read the pre-anchor value.
    await expect
      .poll(
        async () => {
          const row = (await listReminders(request)).find(
            (r) => r.id === minted!.id,
          );
          return row?.nextDueAt ? new Date(row.nextDueAt).getTime() : null;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(dueBefore);
  });

  test("turning the module off drops the nav entry and the direct visit redirects", async ({
    page,
  }) => {
    await page.goto("/vaccinations");
    // The surface is present to begin with.
    await expect(
      page.locator('[data-tour-id="vaccinations-hero"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Flip the real settings switch off and wait for the resolved module map to
    // repaint the shell.
    await page.goto("/settings/modules");
    const toggle = page.locator("#module-toggle-vaccinations");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // The nav entry is gone.
    await expect(page.locator('[data-tour-id="nav-vaccinations"]')).toHaveCount(
      0,
    );

    // A direct visit no longer renders the surface: the page redirects home,
    // so the hero never paints and the dashboard's own landmark does.
    await page.goto("/vaccinations");
    await expect(page).toHaveURL(/\/$|\/dashboard/, { timeout: 15_000 });
    await expect(
      page.locator('[data-tour-id="vaccinations-hero"]'),
    ).toHaveCount(0);
  });

  test("the list and the capture form carry no serious accessibility violations", async ({
    page,
  }) => {
    // Seed one dose so the list scans a populated surface rather than the empty
    // state, then scan both the list and the open capture form.
    //
    // Written from the page, not from a Playwright API context. Every API
    // context in the runner shares ONE process-wide keep-alive agent
    // (`httpHappyEyeballsAgent`), so a request can be handed a pooled socket the
    // server has already closed on its five-second idle timeout — and a POST,
    // unlike a GET, is never replayed on a fresh one. This seed died that way
    // twice, on this line, on all three attempts each time: `socket hang up`
    // and `read ECONNRESET`. The browser opens its own connection and the row
    // is still written by the real route, so nothing about the fixture changes
    // except which socket carries it.
    await page.goto("/vaccinations");
    const seededStatus = await page.evaluate(async () => {
      const res = await fetch("/api/vaccinations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt: "2019-05-01T00:00:00.000Z",
          antigenSlug: "polio",
        }),
      });
      return res.status;
    });
    expect(seededStatus).toBe(201);

    await page.reload();
    await expect(
      page.locator('[data-slot="vaccination-group"][data-antigen="polio"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoSeriousAxe(page);

    await page.locator('[data-slot="vaccination-add"]').first().click();
    await expect(page.locator('[data-slot="vaccination-form"]')).toBeVisible();
    await expectNoSeriousAxe(page);
  });
});

/**
 * Wait until every running CSS animation/transition on the page has settled.
 *
 * The capture sheet fades in, and axe reads computed colours: a scan that races
 * the fade measures a half-opacity blend of the muted foreground over the card
 * and reports phantom `color-contrast` failures that clear the instant the
 * animation lands. Settling first makes the scan read the real, final surface —
 * it never relaxes what axe asserts.
 */
async function waitForAnimationsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const anims = document
      .getAnimations()
      .map((a) => a.finished.catch(() => undefined));
    await Promise.all(anims);
  });
}

/** Fail only on serious/critical WCAG violations, the suite's a11y floor. */
async function expectNoSeriousAxe(page: Page): Promise<void> {
  await waitForAnimationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => v.id),
    "serious/critical accessibility violations",
  ).toEqual([]);
}
