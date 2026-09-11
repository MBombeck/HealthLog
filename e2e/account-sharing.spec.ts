/**
 * Account sharing, end to end: invite → accept → switch → banner → revoke.
 *
 * Two browser contexts, two real accounts, one real database. The owner
 * invites, the delegate accepts and opens the record, and the owner takes it
 * back — each step through the shipped UI rather than through the API, because
 * the half of this feature that can go wrong is the half a person touches.
 *
 * ## The stale-paint check
 *
 * The assertion this spec exists for is a NEGATIVE one, and it is deliberately
 * not "the new record's data arrives". A check that waits for the new data
 * proves nothing about what was on screen while it was arriving, and the
 * failure being guarded against is exactly that in-between frame: a dashboard
 * hydrated from the previous record's IndexedDB snapshot, painted under a
 * banner naming somebody else.
 *
 * So an init script installs a MutationObserver before any page script runs,
 * on every navigation including the full reload the switch performs, and it
 * latches the moment the delegate's own marker weight appears in the document.
 * The spec then reads the latch. Nothing about it is sampled or timed.
 *
 * The observer's positive control runs first: with the same script installed,
 * the delegate's own measurements page must trip the latch. Without that, "the
 * marker never appeared" and "the observer never worked" are the same sentence.
 *
 * ### How much this assertion can be made to fail, measured rather than assumed
 *
 * Three controls stand behind it, and they were removed one at a time and
 * together against a real build to see which of them this spec can actually
 * detect. The honest answer is: none of them individually, and that is worth
 * writing down rather than leaving as an implication.
 *
 *   - Delete the switch-time cache wipe, the persister's restore guard and the
 *     record-scoped query hash — all three at once — and this spec stays
 *     GREEN. The reason is a rule that predates this feature: the restore
 *     refuses to clobber a query the live cache already holds, and the
 *     dashboard's own query is created during render, before any effect runs.
 *     So the IndexedDB snapshot never reaches the screen on this route at all.
 *   - Delete the full reload and the spec goes RED, but on the banner line
 *     rather than the marker line: without a reload the account payload never
 *     re-resolves and the banner never paints, so the run stops before the
 *     latch is read.
 *
 * What that means, plainly: this spec is a regression net over the whole
 * journey, not a proof of any single control. The controls are proven where
 * they can be broken and observed — `query-persister-shared-record.test.ts`
 * for the two disk guards, `record-scope.test.ts` for the cache dimension —
 * and each of those was verified red before being kept.
 *
 * ## What this spec cannot cover, stated rather than implied
 *
 * - **The service worker.** The Playwright context runs with
 *   `serviceWorkers: "block"` (see `playwright.config.ts`), so the worker's
 *   `healthlog-data-*` cache — the other layer that survives a reload — is not
 *   exercised here at all. The switch wipes it through the same helper the
 *   IndexedDB snapshot goes through, and that helper is covered in
 *   `src/lib/pwa/__tests__/query-persister-shared-record.test.ts`.
 * - **The owner's data appearing.** No route declares the delegable mode yet,
 *   so every read inside a shared record is refused by design. That is the
 *   current, correct state of the tree; the pages a delegate can open show
 *   their refusal state and, crucially, still show nothing of the delegate's
 *   own. The positive half of that assertion belongs with the route migration.
 */
import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  DELEGATE_STORAGE_STATE_PATH,
  E2E_DELEGATE_MARKER_KG,
  E2E_OWNER,
  E2E_OWNER_FULL_NAME,
  E2E_USER,
  OWNER_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

const DELEGATE_MARKER = String(E2E_DELEGATE_MARKER_KG);

/**
 * Latch the first appearance of a string anywhere in the document, from before
 * the first script of every page load.
 *
 * A MutationObserver rather than a poll: a poll samples, and the frame this is
 * looking for can be one paint long. `characterData` is on because a hydration
 * pass can fill an existing text node in place rather than inserting one.
 */
async function watchForText(page: Page, needle: string): Promise<void> {
  await page.addInitScript((text: string) => {
    const w = window as unknown as { __sawText?: boolean };
    w.__sawText = false;
    const seen = () => document.body?.innerText?.includes(text) ?? false;
    const check = () => {
      if (seen()) w.__sawText = true;
    };
    const start = () => {
      check();
      new MutationObserver(check).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }, needle);
}

async function sawText(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __sawText?: boolean }).__sawText === true,
  );
}

/** Open the user menu and the switcher inside it. */
async function openSwitcher(page: Page): Promise<void> {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  await expect(
    page.locator('[data-slot="account-switcher-menu"]'),
  ).toBeVisible();
}

test.describe("account sharing", () => {
  // One journey, in order: each step is the precondition of the next, so
  // splitting them into independent tests would mean re-running the invitation
  // three times against a rate-limited endpoint.
  test.describe.configure({ mode: "serial" });

  // The `page` fixture throughout is the DELEGATE. The owner gets an explicit
  // context below, because a grant needs two signed-in sides at once and the
  // login endpoint is IP-rate-limited.
  //
  // The delegate's jar is this journey's OWN, not the shared one every other
  // authenticated spec reads, and that is load-bearing rather than tidy. The
  // switch is stamped on the session row (see "the nav offers only what
  // sharing covers" below, which relies on exactly that), so switching the
  // shared jar would switch it for every spec holding the same cookie — and
  // the suite runs fully parallel. The damage lands somewhere else entirely:
  // a settings surface painting "Not part of shared access", an axe scan
  // reading a banner its spec never asked for. Same account, different
  // session, no reach outside this file.
  test.use({ storageState: DELEGATE_STORAGE_STATE_PATH });

  // Desktop only, and for a reason that is about the fixture rather than the
  // layout: this journey mutates shared rows — one grant between two seeded
  // accounts — so two projects running it at once race each other, and the
  // second one's invitation is refused as a duplicate of the first's. Running
  // it once keeps every step's precondition true. The mobile bar reads the
  // same destination model as the sidebar, and that agreement is a unit
  // contract (`nav-model-shared-record.test.ts`) rather than something two
  // browser runs of the same script would establish.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "shared-fixture journey — runs once",
    );
  });

  let ownerContext: BrowserContext;
  let ownerPage: Page;

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({
      storageState: OWNER_STORAGE_STATE_PATH,
    });
    ownerPage = await ownerContext.newPage();
  });

  test.afterAll(async () => {
    await ownerContext.close();
  });

  /** A `YYYY-MM-DD` day the date input accepts, N days from now. */
  function isoDayFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  test("the owner invites, and the invitation confers nothing yet", async () => {
    await ownerPage.goto("/settings/access");

    // The submit button is disabled until the controlled input holds a value,
    // so a `fill()` that lands before React has attached its listeners leaves
    // the form looking filled and behaving empty. Retry the pair until the
    // button agrees, rather than waiting a fixed time and hoping.
    const identifier = ownerPage.locator(
      '[data-slot="grant-invite-identifier"]',
    );
    const submit = ownerPage.locator('[data-slot="grant-invite-submit"]');

    // Nothing under the scope question is preselected now, so the form blocks
    // until the owner picks one. This invitation is unscoped, so choose the
    // whole record before asserting the button can enable.
    const wholeRecord = ownerPage.locator(
      '[data-slot="grant-invite-scope-option"][data-scope="all"]',
    );
    await wholeRecord.click();
    await expect(wholeRecord).toHaveAttribute("data-selected", "true");

    await expect(async () => {
      await identifier.fill(E2E_USER.username);
      await expect(submit).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    // The lapse date, through the real form and onto the real wire.
    //
    // `expiresAt` was accepted, stored and annotated on by the route from the
    // day the grant model shipped, while the card sent a hardcoded `null`. The
    // component test cannot see that: it renders the control and checks the
    // date mapping, and BOTH still pass with the card wired back to `null`.
    // Only reading the posted body proves the value a person typed is the
    // value the server receives, which is the half that was missing.
    // The VISIBLE overlay, not the hidden ISO mirror: `data-slot` rides
    // `{...rest}` onto `DateField`'s hidden input, so the old selector resolved
    // to an element that can never be visible and typed into nothing.
    const lapse = ownerPage.getByTestId("grant-invite-expires-input");
    await expect(lapse).toBeVisible();
    const chosenDay = isoDayFromNow(30);
    await lapse.fill(chosenDay);
    // The overlay commits on blur; without it the ISO text sits in local state
    // and the hidden mirror still holds the old value when the form submits.
    await lapse.blur();
    await expect(
      ownerPage.locator('input[data-slot="grant-invite-expires"]'),
    ).toHaveValue(chosenDay);

    // The level, through the real control and onto the real wire.
    //
    // Same class of gap as the lapse date above, and the reason it is checked
    // here rather than in a component test is worth stating: the project's
    // component convention is SSR-only, so no test under `src/` can run this
    // form's submit path at all. Wire the radio back to a constant and every
    // one of those stays green. Only the posted body can tell the level a
    // person picked from the level the card sends.
    const writeOption = ownerPage.locator(
      '[data-slot="grant-invite-access-option"][data-access="WRITE"]',
    );
    await expect(writeOption).toBeVisible();
    await writeOption.click();
    await expect(writeOption).toHaveAttribute("data-selected", "true");

    const invitePost = ownerPage.waitForRequest(
      (req) =>
        req.method() === "POST" && req.url().endsWith("/api/account/grants"),
    );
    await submit.click();
    const posted = JSON.parse((await invitePost).postData() ?? "{}") as {
      expiresAt?: string | null;
      access?: string;
    };
    expect(
      posted.expiresAt,
      "the invitation must carry the day the owner chose",
    ).toBeTruthy();
    // End of the chosen day, not the midnight that starts it.
    expect(posted.expiresAt).toContain(chosenDay.slice(0, 8));
    expect(
      posted.access,
      "the invitation must carry the level the owner chose",
    ).toBe("WRITE");

    const row = ownerPage
      .locator('[data-slot="grants-given-list"] [data-slot="grant-row"]')
      .first();
    await expect(row).toBeVisible();
    // Pending, not active. The state is the server's answer, rendered.
    await expect(row).toHaveAttribute("data-grant-state", "PENDING");
    // And the level came back from the database on the list read, which is the
    // far end of the same wire: form → POST → row → GET → attribute.
    await expect(row).toHaveAttribute("data-grant-access", "WRITE");
  });

  test("the delegate is offered nothing until they accept", async ({
    page,
  }) => {
    await page.goto("/settings/access");

    const row = page
      .locator('[data-slot="grants-received-list"] [data-slot="grant-row"]')
      .first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-grant-state", "PENDING");
    // The delegate's half of the consent: what they are being offered, and
    // what accepting it will mean, on the screen where they accept it.
    await expect(row).toHaveAttribute("data-grant-access", "WRITE");
    await expect(
      row.locator('[data-slot="grant-write-consent"]'),
    ).toBeVisible();

    // No switcher yet: `accountAccess.canSwitch` is false while the only
    // grant is pending, and the menu binds that boolean.
    await page.getByRole("button", { name: "User menu" }).first().click();
    await expect(
      page.locator('[data-slot="account-switcher-trigger"]'),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The positive control for the shell-door assertion further down: the
    // delegate, in their OWN record, is offered the Coach launcher like anyone
    // else. Without this line the later "it is gone" check would also pass on
    // a build where the launcher had stopped rendering for everybody.
    await page.goto("/");
    await expect(page.locator('[data-slot="coach-fab"]')).toBeVisible({
      timeout: 10_000,
    });

    // Back to where the rest of this journey happens. The check above leaves
    // the browser on the dashboard, and Accept lives on the access page.
    await page.goto("/settings/access");
    await expect(row).toBeVisible();

    await page.locator('[data-slot="grant-accept"]').click();
    await expect(row).toHaveAttribute("data-grant-state", "ACTIVE");
  });

  test("the switcher appears once the grant is live", async ({ page }) => {
    await page.goto("/settings/access");
    await openSwitcher(page);

    const entry = page.locator('[data-slot="account-switcher-entry"]');
    await expect(entry).toHaveCount(1);
    // v1.37.2 — the owner set a full name, so a delegate sees them by it
    // rather than by the greeting name or the login handle. This is the
    // record-owner's full name crossing to a read-only delegate, which is the
    // deliberate disclosure the maintainer decided on. The username stays on
    // the row as an attribute, which is the positive control for the label
    // assertion — without it, a renamed slot would make this read green.
    await expect(entry).toContainText(E2E_OWNER_FULL_NAME);
    await expect(entry).toHaveAttribute(
      "data-account-username",
      E2E_OWNER.username,
    );
    // Two lines: the name and the kind of record. The access level used to
    // take a third and was truncated more often than it was read; it is what
    // the banner says once you are inside. The row still CARRIES the level as
    // an attribute, which is the positive control for the absence below —
    // without it, a renamed slot would make this read green.
    await expect(entry).toHaveAttribute("data-access-level", /.+/);
    await expect(entry).not.toContainText("Read only");
    await expect(entry).not.toContainText("Can add entries");
    await expect(entry).not.toContainText("change or remove what is in it");
    // The way home is in the same menu as the way in.
    await expect(
      page.locator('[data-slot="account-switcher-own"]'),
    ).toBeVisible();
  });

  test("switching shows the banner and never the delegate's own data", async ({
    page,
  }) => {
    await watchForText(page, DELEGATE_MARKER);

    // Positive control. If the observer cannot see the marker on the page
    // that definitely shows it, its silence later means nothing.
    await page.goto("/measurements");
    await expect(page.getByText(DELEGATE_MARKER).first()).toBeVisible();
    expect(await sawText(page)).toBe(true);

    // Let the offline persister flush the delegate's own dashboard to
    // IndexedDB (1 s debounce). That snapshot is the stale-paint source this
    // whole assertion is aimed at — without it the check would pass against a
    // disk that was empty anyway. Poll the persister's own store for the
    // written snapshot instead of sleeping past the debounce (C3): the
    // condition IS the flush, so a slow CI box waits exactly as long as it
    // needs to and a fast one moves on immediately.
    await page.goto("/");
    // Gate on rendered content first (the dashboard must actually mount and
    // populate the query cache before there is anything to persist).
    await expect(page.locator('[data-slot="coach-fab"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<boolean>((resolve) => {
                const req = indexedDB.open("healthlog-query-cache", 1);
                req.onerror = () => resolve(false);
                req.onsuccess = () => {
                  const db = req.result;
                  try {
                    const get = db
                      .transaction("kv", "readonly")
                      .objectStore("kv")
                      .get("react-query");
                    get.onsuccess = () => {
                      db.close();
                      resolve(get.result !== undefined);
                    };
                    get.onerror = () => {
                      db.close();
                      resolve(false);
                    };
                  } catch {
                    db.close();
                    resolve(false);
                  }
                };
              }),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await openSwitcher(page);
    await page.locator('[data-slot="account-switcher-entry"]').click();

    // Wait for CONTENT, and for content the assertion is not about: the
    // banner naming the owner. A skeleton does not satisfy it, and it says
    // nothing about the marker either way. The owner set a full name, so the
    // banner names them by it (v1.37.2) — the same label the switcher used.
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(E2E_OWNER_FULL_NAME);

    // The document showing the banner has never shown the delegate's own
    // number. The latch was armed by that document's own init script, so this
    // covers its whole life rather than the instant it is read. See the
    // header for what this line can and cannot be made to fail on.
    expect(await sawText(page)).toBe(false);

    // And it stays false across a navigation inside the record.
    await page.goto("/measurements");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();
    expect(await sawText(page)).toBe(false);
  });

  test("the nav offers only what sharing covers", async ({ page }) => {
    // A fresh page fixture, and still inside the record: the switch lives on
    // the session row rather than in the tab, so every tab of that browser is
    // switched at once. That is the property this navigation quietly proves.
    await page.goto("/");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();

    // The record itself is still there…
    await expect(page.locator('a[href="/measurements"]').first()).toBeVisible();
    // …and everything that configures the account around it is not.
    await expect(page.locator('a[href="/settings/account"]')).toHaveCount(0);
    await expect(page.locator('a[href="/coach"]')).toHaveCount(0);
    await expect(page.locator('a[href="/insights"]')).toHaveCount(0);

    // And neither is the door that stood beside the removed entries. The Coach
    // launcher hangs off the shell rather than off a route, so dropping the
    // nav entry left it floating over every page in the record — one tap from
    // a drawer whose every action resolves `requireAuth()` and refuses.
    await expect(page.locator('[data-slot="coach-fab"]')).toHaveCount(0);
  });

  test("a surface sharing does not cover says so", async ({ page }) => {
    // Reached by bookmark: the nav entry is gone, the URL still resolves.
    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="shared-record-unavailable-leave"]'),
    ).toBeVisible();
  });

  test("revoking from the owner's browser drops the delegate out", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toBeVisible();

    // The owner ends it from their own session, in their own context.
    await ownerPage.goto("/settings/access");
    await ownerPage.locator('[data-slot="grant-revoke"]').first().click();
    await ownerPage
      .getByRole("button", { name: "End access", exact: true })
      .last()
      .click();
    await expect(
      ownerPage
        .locator('[data-slot="grants-given-list"] [data-slot="grant-row"]')
        .first(),
    ).toHaveAttribute("data-grant-state", "REVOKED");

    // The delegate's next navigation lands back in their own account rather
    // than on a wall of refusals: the revoke cleared their acting session in
    // the same transaction that stamped the row.
    await page.goto("/measurements");
    // Their own record, back. This goes first: the protected shell holds
    // every child — nav, banner, page body — behind its hydration gate until
    // `/api/auth/me` resolves, so "no banner" straight after a navigation is
    // satisfied by the page still loading and would stay green if the revoke
    // had left the acting session standing. The delegate's own marker only
    // exists once the record really resolved to theirs.
    await expect(page.getByText(DELEGATE_MARKER).first()).toBeVisible();
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toHaveCount(0);
  });

  test("the ended grant stays on the record as history", async () => {
    await ownerPage.goto("/settings/access");
    const row = ownerPage
      .locator('[data-slot="grants-given-list"] [data-slot="grant-row"]')
      .first();
    // Revocation never deletes. "Who had access, from when to when, and who
    // ended it" is the question the panel exists to answer.
    await expect(row).toHaveAttribute("data-grant-state", "REVOKED");
    await expect(row).toContainText("You ended it");
  });
});
