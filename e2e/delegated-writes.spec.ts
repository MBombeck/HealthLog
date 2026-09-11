/**
 * A delegate who may write: what they are offered, and what they are not.
 *
 * The unit suite runs SSR-only, so it holds the PAINT and never the click: it
 * can prove an add button is absent, which is the property that matters most,
 * and it cannot prove that the one still standing submits. This spec is the
 * other half — a real form, a real POST, a real row in somebody else's record,
 * and the owner seeing it afterwards.
 *
 * ## Why it gates itself instead of seeding a WRITE grant directly
 *
 * The grant level is chosen in the invitation form. Rather than mint a WRITE
 * row behind the UI's back — which would prove the journey works for a grant
 * no person can create — the journey looks for the level control and stands
 * down when it is not there yet.
 *
 * That guard was written against a `data-slot` the form never shipped under
 * (`grant-invite-level`; the control landed as `grant-invite-access-option`),
 * so from the day the control arrived until 2026-08-03 every test in this file
 * skipped and the whole delegated-write journey ran nowhere. The file said out
 * loud what to change and nobody changed it, which is the standing lesson
 * about a check that cannot fail: the skip is quiet, and a quiet skip and a
 * passing suite look identical in a CI summary.
 *
 * The constant is the real one now. If it moves again, change that one string:
 * nothing else here assumes anything about the control except that choosing
 * WRITE and submitting mints a WRITE grant.
 *
 * ## What this spec cannot cover
 *
 * The owner's activity view is asserted at the level of "a row appeared for
 * something the delegate did", not at the level of the per-verb sentence. The
 * verb lines live in `src/lib/record-activity/activity-verb.ts` with their own
 * unit test; the one line that binds them into the activity card belongs to
 * the file this chunk was told not to touch.
 */
import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  DELEGATE_STORAGE_STATE_PATH,
  E2E_OWNER_FULL_NAME,
  E2E_USER,
  OWNER_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

/**
 * The invitation form's grant-level control. The journey runs when this is on
 * the page and stands down when it is not. One string, one place.
 */
const GRANT_LEVEL_SLOT = "grant-invite-access-option";

/** The value the level control carries for a grant that may add entries. */
const WRITE_LEVEL_VALUE = "WRITE";

test.describe("delegated writes", () => {
  // One journey in order, like the read-only sibling: each step is the next
  // one's precondition, and the invitation endpoint is rate-limited.
  test.describe.configure({ mode: "serial" });

  // The `page` fixture is the DELEGATE throughout, on this journey's own
  // cookie jar — the switch is stamped on the session row, so switching a
  // shared jar would switch it for every spec holding the same cookie.
  test.use({ storageState: DELEGATE_STORAGE_STATE_PATH });

  // Desktop only: the journey mutates shared rows between two seeded accounts,
  // so two projects running it at once race each other and the second
  // invitation is refused as a duplicate.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "shared-fixture journey — runs once",
    );
  });

  let ownerContext: BrowserContext;
  let ownerPage: Page;
  let levelControlPresent = false;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({
      storageState: OWNER_STORAGE_STATE_PATH,
    });
    ownerPage = await ownerContext.newPage();
    await ownerPage.goto("/settings/access");
    levelControlPresent =
      (await ownerPage.locator(`[data-slot="${GRANT_LEVEL_SLOT}"]`).count()) >
      0;
  });

  test.afterAll(async () => {
    await ownerContext.close();
  });

  test.beforeEach(() => {
    test.skip(
      !levelControlPresent,
      `no [data-slot="${GRANT_LEVEL_SLOT}"] in the invitation form — a WRITE grant cannot be created through the UI yet`,
    );
  });

  test("the owner invites at a level that may add entries", async () => {
    await ownerPage.goto("/settings/access");

    const identifier = ownerPage.locator(
      '[data-slot="grant-invite-identifier"]',
    );
    const submit = ownerPage.locator('[data-slot="grant-invite-submit"]');

    // The scope question preselects nothing, so the form blocks until the owner
    // picks one. This invitation is unscoped — choose the whole record.
    const wholeRecord = ownerPage.locator(
      '[data-slot="grant-invite-scope-option"][data-scope="all"]',
    );
    await wholeRecord.click();
    await expect(wholeRecord).toHaveAttribute("data-selected", "true");

    // The controlled input keeps the submit disabled until React has attached,
    // so retry the pair rather than waiting a fixed time and hoping.
    await expect(async () => {
      await identifier.fill(E2E_USER.username);
      await expect(submit).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    const writeOption = ownerPage.locator(
      `[data-slot="${GRANT_LEVEL_SLOT}"][data-access="${WRITE_LEVEL_VALUE}"]`,
    );
    await writeOption.click();
    await expect(writeOption).toHaveAttribute("data-selected", "true");

    // Read the posted body: a level control that renders and sends a hardcoded
    // level would pass every render assertion and ship a read-only grant.
    const invitePost = ownerPage.waitForRequest(
      (req) =>
        req.method() === "POST" && req.url().endsWith("/api/account/grants"),
    );
    await submit.click();
    const posted = JSON.parse((await invitePost).postData() ?? "{}") as {
      access?: string;
    };
    expect(
      posted.access,
      "the invitation must carry the level the owner chose",
    ).toBe(WRITE_LEVEL_VALUE);
  });

  test("the delegate accepts and opens the record", async ({ page }) => {
    await page.goto("/settings/access");
    await page.locator('[data-slot="grant-accept"]').first().click();

    // The switcher lives inside the user menu, like its read-only sibling.
    await page.getByRole("button", { name: "User menu" }).first().click();
    await page.locator('[data-slot="account-switcher-trigger"]').click();
    await expect(
      page.locator('[data-slot="account-switcher-menu"]'),
    ).toBeVisible();
    await page.locator('[data-slot="account-switcher-entry"]').click();

    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toBeVisible();
    // v1.37.2 — the owner set a full name, so the banner names them by it.
    await expect(banner).toContainText(E2E_OWNER_FULL_NAME);
    // The banner drops its read-only clause on its own once the level says so.
    await expect(banner).not.toContainText("read it, not change it");
  });

  test("the reading they add lands in the owner's record", async ({ page }) => {
    await page.goto("/measurements");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();

    // The add path survives at WRITE. This is the click an SSR test cannot
    // make: the button rendering and the button working are two facts.
    const post = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().endsWith("/api/measurements"),
    );
    // Stable attributes and the form's real fields, neither of which this
    // step had. It looked for a button named "Add measurement" (the header
    // reads "Add") and then for a `value` input (the form opens on blood
    // pressure, which has three). Both were wrong from the day they were
    // written and nobody found out, because the whole file was skipping.
    await page.locator('[data-slot="measurement-add"]').click();
    await page.locator("#sys").fill("124");
    await page.locator("#dia").fill("78");
    await page.getByRole("button", { name: /^save$/i }).click();
    expect((await post).status(), "the write must be accepted").toBeLessThan(
      300,
    );

    // And the row it created is not theirs to change. Absent, not disabled:
    // a `toBeDisabled()` assertion here would pass against the exact design
    // this release exists to avoid.
    //
    // The list has to have painted the reading first. Both layouts stamp
    // `measurement-row` and only the mounted one exists, so this holds at
    // either viewport and says the rows really arrived — without it every
    // count below is a statement about an empty or still-loading list.
    const rows = page.getByTestId("measurement-row");
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });

    // The selection column is the gate. `canManage` is false below MANAGE, so
    // no row carries a checkbox — which is what makes the bulk bar
    // unreachable rather than merely unrendered. The bar on its own proved
    // nothing here: it renders on `count > 0`, and with nothing selected an
    // owner meets no bar either, so that assertion could not fail for the
    // reason this comment gives.
    await expect(rows.getByRole("checkbox")).toHaveCount(0);
    await expect(
      page.locator('[data-slot="selection-action-bar"]'),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(
      0,
    );
  });

  test("a deep link opens exactly what the level admits", async ({ page }) => {
    // The gate binds to the level the server resolved, not to a blanket
    // "somebody else's record" flag. Both halves matter and only a browser
    // can show either: the SSR suite holds a component's paint, never a URL.
    //
    // Admitted: entering a reading, so `?add=` opens the same sheet the
    // header button opens.
    await page.goto("/measurements?add=WEIGHT");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="responsive-sheet-content"]').first(),
    ).toBeVisible();

    // Also admitted: adding a medication with its schedule.
    await page.goto("/medications?new=1");
    await expect(
      page.locator('[data-slot="medication-wizard-dialog"]'),
    ).toBeVisible();
  });

  test("the owner sees that somebody else was in their record", async () => {
    await ownerPage.goto("/settings/access");
    const rows = ownerPage.locator('[data-slot="record-activity-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(E2E_USER.username);
  });
});
