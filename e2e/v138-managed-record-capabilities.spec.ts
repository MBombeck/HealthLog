/**
 * v1.38.12 — the controls a guardian sees inside a managed profile (#939).
 *
 * A person acting on a managed profile holds a MANAGE grant, and the server
 * has accepted their mood entries, screeners, visits, allergies and lab edits
 * since v1.37.0. The interface withheld every one of those controls anyway,
 * because the client answered `canManage: false` for every shared record. It
 * answers per section now, from the two lists `GET /api/auth/me` publishes.
 *
 * Two pages, one each way:
 *
 *   - Mood is a section whose create answers at MANAGE, so the add control
 *     is there and an entry can be added — asserted on the POST's status, not
 *     on the paint, because the paint is what lied before.
 *   - Documents is the section with no delegated write route, so the upload
 *     control is absent and the page says why, in a sentence, where the
 *     control would have been.
 *
 * A third journey reaches the profile's Settings from the navigation (#939).
 * The Settings shell has always listed a managed profile's own configuration,
 * and the section gate has always admitted it, but no navigation led there:
 * the utility entries disappeared for every shared record. It walks the
 * desktop sidebar and the mobile user menu to the Modules card.
 *
 * Modelled on `v137-sharing-managed-profiles.spec.ts`; the switch helpers are
 * the same ones, for the same reasons written there.
 */
import type { Page } from "@playwright/test";
import pg from "pg";

import { expect, test } from "./setup/test";
import {
  E2E_LEVEL_RECORDS,
  SCOPE_CAPABILITIES_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  await expect(
    page.locator('[data-slot="account-switcher-menu"]'),
  ).toBeVisible();
}

/**
 * Run `act` and wait for the document it replaces to be gone. See the
 * v1.37.0 spec for why waiting on the banner alone settles nothing.
 */
async function withDocumentReplacement(
  page: Page,
  act: () => Promise<void>,
): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __hlNavToken?: true }).__hlNavToken = true;
  });
  await act();
  await page.waitForFunction(
    () =>
      (window as Window & { __hlNavToken?: true }).__hlNavToken === undefined,
    undefined,
    { timeout: 30_000 },
  );
}

async function openRecord(page: Page, username: string) {
  await page.goto("/");
  await openSwitcher(page);
  const entry = page.locator(
    `[data-slot="account-switcher-entry"][data-account-username="${username}"]`,
  );
  await expect(entry).toHaveCount(1);
  await withDocumentReplacement(page, () => entry.click());
  await expect(page.locator('[data-slot="shared-record-banner"]')).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Leave the record and prove the own-record shell is back.
 *
 * Leaving replaces the document, and the protected shell renders its
 * hydration gate — no nav, no banner, no page body — until `/api/auth/me`
 * resolves. "The banner is gone" is true of that gate as well, so on its own
 * it is satisfied by the document on its way out and is not a wait at all.
 * The top bar only exists past the gate, so it is the anchor the absence
 * hangs on.
 */
async function leaveRecord(page: Page) {
  await withDocumentReplacement(page, () =>
    page.locator('[data-slot="shared-record-banner-exit"]').click(),
  );
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

test.describe.serial("a guardian's controls inside a managed profile", () => {
  // Its own session row: this journey moves the record selector, and the
  // scoped-sharing journey drives the same account from another worker.
  test.use({ storageState: SCOPE_CAPABILITIES_STORAGE_STATE_PATH });

  const managed = E2E_LEVEL_RECORDS.find(
    (record) => record.recordKind === "managed",
  );
  if (!managed) throw new Error("managed record fixture is missing");

  test("offers the mood add control and lands the entry", async ({ page }) => {
    // The profile starts every run without mood entries. The form stamps an
    // entry to the minute and `(user, date, moodLoggedAt)` is unique, so a
    // second run inside the same minute (a retry, a repeat) met a 409 for the
    // entry the first one wrote. An empty record also fixes which control the
    // page offers: the empty state's add, not the header's.
    const dbUrl = process.env.DATABASE_URL;
    test.skip(!dbUrl, "DATABASE_URL is required to reset the profile's mood");
    const pool = new pg.Pool({ connectionString: dbUrl });
    try {
      await pool.query(
        `DELETE FROM mood_entries
          WHERE user_id = (SELECT id FROM users WHERE username = $1)`,
        [managed.username],
      );
    } finally {
      await pool.end();
    }

    await openRecord(page, managed.username);
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-record-kind", "managed");
    await expect(banner).toHaveAttribute("data-access-level", "manage");

    await page.goto("/mood");
    // Since v1.42 an empty list carries the one add control in its empty
    // state and the header drops its own; the header's returns once there is
    // an entry to list. Both are asserted on their data-slots.
    const addFirst = page.locator('[data-slot="mood-add-first"]');
    const addHeader = page.locator('[data-slot="mood-add-entry"]');
    await expect(addFirst).toBeVisible({ timeout: 30_000 });
    await expect(addHeader).toHaveCount(0);
    await addFirst.click();

    const face = page.locator('[data-slot="mood-face"][data-mood="GUT"]');
    await expect(face).toBeVisible();
    await face.click();

    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/mood-entries(\?|$)/.test(response.url()),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const response = await posted;
    // The route, not the paint: a control that renders and 403s is the exact
    // failure this release ends.
    expect(response.status()).toBe(201);
    await expect(page.locator('[data-slot="mood-rows"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(addHeader).toBeVisible();
    await expect(addFirst).toHaveCount(0);

    await leaveRecord(page);
  });

  test("reaches the profile's Modules settings from the navigation on both widths", async ({
    page,
  }) => {
    await openRecord(page, managed.username);
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-record-kind", "managed");
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    const accountId = await banner.getAttribute("data-account-id");
    expect(accountId).toBeTruthy();

    // The banner renders from the same `/api/auth/me` answer the navigation
    // reads, and the shell paints nothing before it resolves. Waiting on it
    // above is what makes every presence and absence below a statement about
    // the loaded shell rather than about the hydration gate.
    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    const settings = sidebar.locator('[data-slot="nav-settings-link"]');
    await expect(settings).toHaveCount(1);
    await expect(settings).toHaveAttribute("href", "/settings/account");
    await expect(sidebar.locator('a[href="/notifications"]')).toHaveCount(0);

    await settings.click();
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(
      page.locator('[data-record-settings-family="profile"]'),
    ).toHaveAttribute("data-record-id", accountId as string, {
      timeout: 30_000,
    });

    await page
      .locator('a[href="/settings/modules"]')
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/settings\/modules$/);
    const modules = page.locator(
      '[data-record-settings-family="modules"][aria-busy="false"]',
    );
    await expect(modules).toBeVisible({ timeout: 30_000 });
    await expect(modules).toHaveAttribute(
      "data-record-id",
      accountId as string,
    );

    // The phone layout: the utilities live in the top-bar user menu there.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    const topBar = page.locator('[data-slot="top-bar"]');
    await expect(topBar).toBeVisible();
    await topBar.getByRole("button", { name: "User menu" }).click();
    const menu = page.getByRole("menu");
    const menuSettings = menu.locator('[data-slot="nav-settings-link"]');
    await expect(menuSettings).toHaveAttribute("href", "/settings/account");
    // The menu is open and populated, so this absence is the menu's answer.
    await expect(menu.locator('a[href="/notifications"]')).toHaveCount(0);
    await menuSettings.click();
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(
      page.locator('[data-record-settings-family="profile"]'),
    ).toHaveAttribute("data-record-id", accountId as string, {
      timeout: 30_000,
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await leaveRecord(page);
  });

  test("withholds the vault's upload control and says why", async ({
    page,
  }) => {
    await openRecord(page, managed.username);

    await page.goto("/documents");
    const note = page.locator('[data-slot="documents-owner-only"]');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toHaveText(
      "Documents can only be added by the record owner.",
    );
    await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    await leaveRecord(page);
  });
});
