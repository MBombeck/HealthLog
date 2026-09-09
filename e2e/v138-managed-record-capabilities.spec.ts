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
 * Modelled on `v137-sharing-managed-profiles.spec.ts`; the switch helpers are
 * the same ones, for the same reasons written there.
 */
import type { Page } from "@playwright/test";

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

async function leaveRecord(page: Page) {
  await withDocumentReplacement(page, () =>
    page.locator('[data-slot="shared-record-banner-exit"]').click(),
  );
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
    await openRecord(page, managed.username);
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-record-kind", "managed");
    await expect(banner).toHaveAttribute("data-access-level", "manage");

    await page.goto("/mood");
    const add = page.locator('[data-slot="mood-add-entry"]');
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.click();

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
