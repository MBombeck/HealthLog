/**
 * A delegate who may write: what they are offered, and what they are not.
 *
 * The unit suite runs SSR-only, so it holds the PAINT and never the click: it
 * can prove an add button is absent, which is the property that matters most,
 * and it cannot prove that the one still standing submits. This spec is the
 * other half — a real form, a real POST, a real row in somebody else's record,
 * and the owner seeing it afterwards.
 *
 * ## Why it no longer gates itself
 *
 * It used to look for the invitation form's level control right after
 * `goto()` and skip every test when it found none. The count ran before the
 * form had painted, so it found none on every run, CI included, and the whole
 * journey skipped for as long as that guard stood. A quiet skip and a passing
 * suite look identical in a CI summary. The form is now awaited through its
 * own `data-slot`, and a missing level control fails the first test instead of
 * standing the file down. `e2e-conditional-skip-guard.test.ts` and
 * `scripts/check-e2e-skipped-specs.mjs` hold that line for every spec.
 *
 * ## Its own pair
 *
 * The journey invites `E2E_WRITE_DELEGATE` from `E2E_WRITE_OWNER`, accounts no
 * other spec uses. Only one live grant can stand between two accounts, so
 * sharing a pair with the account-sharing journey made whichever file invited
 * second meet a 409. The grant is revoked in `afterAll` so a local re-run
 * starts clean even before global setup resets the pair.
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

import { actWithReproof, useStaleSession } from "./setup/recent-proof";
import { expect, test } from "./setup/test";
import {
  E2E_WRITE_DELEGATE,
  E2E_WRITE_OWNER,
  E2E_WRITE_OWNER_FULL_NAME,
  WRITE_DELEGATE_STORAGE_STATE_PATH,
  WRITE_OWNER_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

/** The invitation form's grant-level control. One string, one place. */
const GRANT_LEVEL_SLOT = "grant-invite-access-option";

/** The value the level control carries for a grant that may add entries. */
const WRITE_LEVEL_VALUE = "WRITE";

test.describe("delegated writes", () => {
  // One journey in order, like the read-only sibling: each step is the next
  // one's precondition, and the invitation endpoint is rate-limited.
  // Desktop only: `playwright.config.ts` keeps it out of the mobile project,
  // because a second project would drive the same pair in parallel.
  test.describe.configure({ mode: "serial" });

  // The `page` fixture is the DELEGATE throughout, on its own account's jar.
  test.use({ storageState: WRITE_DELEGATE_STORAGE_STATE_PATH });

  let ownerContext: BrowserContext;
  let ownerPage: Page;
  let endOwnerSession: (() => Promise<void>) | null = null;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({
      storageState: WRITE_OWNER_STORAGE_STATE_PATH,
    });
    ownerPage = await ownerContext.newPage();
    // The invitation asks for a recent proof; see `useStaleSession`.
    endOwnerSession = await useStaleSession(
      ownerPage,
      E2E_WRITE_OWNER.username,
    );
  });

  test.afterAll(async () => {
    // End every live grant this journey minted, through the owner's own
    // session. Revocation needs no re-proof (reducing access is never gated),
    // and it clears the delegate's switch stamp in the same transaction.
    try {
      // On the app's origin, whatever step the journey stopped at.
      await ownerPage.goto("/settings/access");
      const revoked = await ownerPage.evaluate(async (grantee: string) => {
        const res = await fetch("/api/account/grants");
        if (!res.ok) return -res.status;
        const body = (await res.json()) as {
          data: {
            given: Array<{
              id: string;
              state: string;
              account: { username: string };
            }>;
          };
        };
        let count = 0;
        for (const grant of body.data.given) {
          if (grant.account.username !== grantee) continue;
          if (grant.state !== "ACTIVE" && grant.state !== "PENDING") continue;
          const del = await fetch(`/api/account/grants/${grant.id}`, {
            method: "DELETE",
          });
          if (!del.ok) return -del.status;
          count += 1;
        }
        return count;
      }, E2E_WRITE_DELEGATE.username);
      expect(revoked, "the journey's grant was revoked").toBeGreaterThanOrEqual(
        0,
      );
    } finally {
      await endOwnerSession?.();
      await ownerContext.close();
    }
  });

  /**
   * The invitation form, painted. The card's `data-slot` is on the server
   * render; the level control inside it is what the journey needs, so wait for
   * that and fail loudly when it is gone rather than standing the file down.
   */
  async function openInviteForm(): Promise<void> {
    await ownerPage.goto("/settings/access");
    await expect(
      ownerPage.locator('[data-slot="grant-invite-card"]'),
    ).toBeVisible();
    await expect(
      ownerPage.locator(
        `[data-slot="${GRANT_LEVEL_SLOT}"][data-access="${WRITE_LEVEL_VALUE}"]`,
      ),
      "the invitation form offers a level that may add entries",
    ).toBeVisible();
  }

  test("the owner invites at a level that may add entries", async () => {
    await openInviteForm();

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
      await identifier.fill(E2E_WRITE_DELEGATE.username);
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
    await actWithReproof(ownerPage, E2E_WRITE_OWNER.password, () =>
      submit.click(),
    );
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
    // The owner set a full name, so the banner names them by it.
    await expect(banner).toContainText(E2E_WRITE_OWNER_FULL_NAME);
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
    // The owner's list may be empty, in which case its empty state carries
    // the add action and the header drops its own.
    await page
      .locator(
        '[data-slot="measurement-add"], [data-slot="measurement-add-first"]',
      )
      .first()
      .click();
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
    await expect(rows.first()).toContainText(E2E_WRITE_DELEGATE.username);
  });
});
