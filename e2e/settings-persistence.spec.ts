import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  criticalAccount,
  criticalStorageState,
  resetCriticalAccount,
} from "./setup/critical-fixture";

/**
 * A settings change is the server's, not the tab's.
 *
 * The time-format choice is changed through the account settings, then read
 * back three ways that a client-side cache could not fake: after a reload, in
 * a second browser context that shares the session but none of the first
 * one's storage, and on `/api/auth/me`, which every client renders from.
 *
 * The account is the settings journey's own, one per project
 * (`critical-fixture.ts`), and is put back to the default first.
 */

async function openTimeFormat(page: Page) {
  await page.goto("/settings/account");
  const select = page.getByTestId("settings-time-format-select");
  await expect(select).toBeVisible({ timeout: 30_000 });
  // The control is disabled until the account payload has landed.
  await expect(select).toBeEnabled();
  return select;
}

async function publishedTimeFormat(page: Page): Promise<string> {
  const res = await page.request.get("/api/auth/me");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { timeFormat: string } }).data
    .timeFormat;
}

test.describe("settings persistence", () => {
  test.use({ storageState: criticalStorageState("settings") });

  test.beforeEach(async ({}, testInfo) => {
    await resetCriticalAccount(criticalAccount("settings", testInfo), [
      "UPDATE users SET time_format = 'AUTO' WHERE id = $1",
    ]);
  });

  test("a time-format change survives a reload and reaches a second browser @critical", async ({
    page,
    browser,
  }, testInfo) => {
    const select = await openTimeFormat(page);
    await expect(select).toHaveValue("AUTO");

    const saved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/user/profile" &&
        res.request().method() === "PATCH",
    );
    await select.selectOption("H12");
    expect((await saved).status()).toBe(200);
    expect(await publishedTimeFormat(page)).toBe("H12");

    await page.reload();
    await expect(page.getByTestId("settings-time-format-select")).toHaveValue(
      "H12",
    );

    // Same session cookie, nothing else: no local storage, no IndexedDB
    // query snapshot, no in-memory cache.
    const other = await browser.newContext({
      storageState: criticalAccount("settings", testInfo).storageStatePath,
      baseURL: testInfo.project.use.baseURL,
    });
    try {
      const second = await other.newPage();
      await expect(await openTimeFormat(second)).toHaveValue("H12");
    } finally {
      await other.close();
    }
  });
});
