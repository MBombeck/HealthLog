/**
 * Visits — the incidental-linking promise, proven end to end once.
 *
 * The flow this milestone is checked against, in one script:
 *
 *   1. create a visit with ONLY a date — nothing else touched, Save enabled;
 *   2. it appears in the list;
 *   3. open a document dated inside the ±7-day window;
 *   4. the suggestion offers that visit;
 *   5. take the offer;
 *   6. the document's detail names the visit it now belongs to.
 *
 * Every assertion addresses a stable `data-slot`, never viewport text: the
 * copy is i18n-driven and the mobile project renders the same slots at a
 * different size, so a text assertion would break for the wrong reason.
 *
 * The visit is created through the API rather than by driving the sheet twice:
 * step 1 is about the SAVE being possible with only a date, which the sheet
 * assertion below covers, and the linking half needs a visit whose instant is
 * pinned relative to the seeded document's date.
 */
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

import {
  ensureVaultFixture,
  MRT_DOC_ID,
  resetEncounters,
} from "./setup/vault-fixture";

test.beforeEach(async () => {
  // Own the window the linking case counts against: clear the account's visits
  // before each test so a retry or a prior run cannot leave a second candidate
  // in the ±7-day window and flip the single-candidate verdict to the picker.
  await resetEncounters();
  await ensureVaultFixture();
});

// Serial, and single-project below: the two tests share one account, and the
// reset above would race a sibling running in parallel — the linking test would
// clear the visit the save test is still asserting. In order, in one worker,
// each test owns the account for its span.
test.describe.configure({ mode: "serial" });

test.describe("visits", () => {
  // The seeded account owns the visits and the document this flow drives, and
  // both the `page` and the `request` fixture read them under its session.
  // Without this the whole file runs anonymous: `/care` redirects to login
  // and every `/api/*` read answers 401, which is a test-setup gap, not a
  // product one.
  test.use({ storageState: STORAGE_STATE_PATH });

  test("a visit saves with a date and nothing else", async ({ page }) => {
    await page.goto("/care");
    await page.getByTestId("checkups-tab-visits").click();

    const add = page.locator('[data-slot="visits-add"]').first();
    await expect(add).toBeVisible();
    await add.click();

    // The date is pre-filled with now, and NOTHING else has been touched.
    const save = page.locator('[data-slot="encounter-save"]').first();
    await expect(save).toBeVisible();
    // The whole product constraint: not disabled, with no practitioner, no
    // reason, no outcome and no link chosen.
    await expect(save).toBeEnabled();

    await save.click();

    // It appears in the list. A visit dated now is in the past arm.
    await expect(page.locator('[data-slot="visit-card"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a document offers the visit its date falls near, and files itself against it", async ({
    page,
    request,
  }) => {
    // The seeded MRI report carries a fixed filing date; the visit is placed
    // two days before it so the ±7-day window resolves to exactly one
    // candidate — the branch that pre-selects.
    const document = await request
      .get(`/api/documents/inbound/${MRT_DOC_ID}`)
      .then((res) => res.json());
    const anchorDay: string =
      document.data.reportDate ?? document.data.documentDate;
    expect(
      anchorDay,
      "the fixture document carries a filing date",
    ).toBeTruthy();
    const occurredAt = new Date(`${anchorDay}T09:00:00.000Z`);
    occurredAt.setUTCDate(occurredAt.getUTCDate() - 2);

    const created = await request.post("/api/encounters", {
      data: {
        occurredAt: occurredAt.toISOString(),
        status: "DONE",
        kind: "SPECIALIST",
      },
    });
    expect(created.status()).toBe(201);

    await page.goto(`/documents?doc=${MRT_DOC_ID}`);

    const suggestion = page
      .locator('[data-slot="document-encounter-suggestion"]')
      .first();
    await expect(suggestion).toBeVisible({ timeout: 15_000 });
    // One candidate, so the single-candidate branch: a pre-selectable offer
    // rather than a picker.
    await expect(suggestion).toHaveAttribute("data-verdict", "one");

    await page
      .locator('[data-slot="document-encounter-suggestion-option"]')
      .first()
      .click();

    // The filing landed: the visit is a chip in the document's link row.
    await expect(
      page
        .locator('[data-slot="document-links-chips"] [data-kind="encounter"]')
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // Treatment series (D1113): a series starts with a name and a count, and a
  // session added from it arrives with the series picked and moves the count.
  // Here rather than in a file of its own because the sessions are visits of
  // this same account, and the reset above clears them.
  test("a treatment series counts the session filed into it", async ({
    page,
  }) => {
    await page.goto("/care?view=visits");

    await page.locator('[data-slot="treatment-series-add"]').click();
    const save = page.locator('[data-slot="treatment-series-save"]');
    // Nothing typed yet: a series nobody can name is not saved.
    await expect(save).toBeDisabled();
    await page.getByTestId("series-title").fill("Physiotherapy, left knee");
    await page.getByTestId("series-planned").fill("6");
    await expect(save).toBeEnabled();
    await save.click();

    const card = page.locator('[data-slot="treatment-series-card"]');
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await expect(card).toHaveAttribute("data-done", "0");
    await expect(card.locator("[data-series-status]")).toHaveAttribute(
      "data-series-status",
      "PLANNED",
    );

    // Open it and add the first session: the visit form arrives with the
    // series picked.
    await card.locator('[data-slot="treatment-series-open"]').click();
    await page.locator('[data-slot="treatment-series-add-session"]').click();
    await expect(page.getByTestId("encounter-series")).not.toHaveValue("");
    await page.locator('[data-slot="encounter-save"]').click();

    // Dated now, so it took place: one of six, and the series runs.
    await expect(card).toHaveAttribute("data-done", "1", { timeout: 15_000 });
    await expect(card.locator("[data-series-status]")).toHaveAttribute(
      "data-series-status",
      "ACTIVE",
    );
    await expect(
      page.locator('[data-slot="visit-card-series"]').first(),
    ).toBeVisible();
  });
});
