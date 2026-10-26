import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  criticalAccount,
  criticalStorageState,
  resetCriticalAccount,
} from "./setup/critical-fixture";

/**
 * Logging a mood through the form, against the real server: the time stays
 * visible while the details are collapsed, the instant typed into it is the
 * instant stored, and the entry is in the list afterwards.
 *
 * Until v1.46 this spec answered the POST and the list read itself, so the
 * list was always empty and the POST always succeeded. The account is now the
 * mood journey's own, one per project (`critical-fixture.ts`), emptied before
 * the test; the empty state the form opens from is the account's real one.
 */

/** The account's mood entries, as the list route answers them. */
async function storedMoods(
  page: Page,
): Promise<Array<{ mood: string; moodLoggedAt: string }>> {
  const res = await page.request.get("/api/mood-entries");
  expect(res.status()).toBe(200);
  const { data } = (await res.json()) as {
    data: { entries: Array<{ mood: string; moodLoggedAt: string }> };
  };
  return data.entries.map(({ mood, moodLoggedAt }) => ({ mood, moodLoggedAt }));
}

test.describe("mood timestamp capture", () => {
  test.use({ storageState: criticalStorageState("mood") });

  test.beforeEach(async ({}, testInfo) => {
    // Fixture hygiene: what a previous run or a retry left on the account.
    await resetCriticalAccount(criticalAccount("mood", testInfo), [
      "DELETE FROM mood_entry_rollups WHERE user_id = $1",
      "DELETE FROM mood_entries WHERE user_id = $1",
    ]);
  });

  test("a mood logged at a chosen time is stored at that instant and listed @critical", async ({
    page,
  }) => {
    await page.goto("/mood", { waitUntil: "domcontentloaded" });
    // An empty list carries the add action in its empty state (the header
    // drops its own while there is nothing to list).
    await page.getByRole("button", { name: "Log your first mood" }).click();
    await page.getByRole("radio", { name: "Amazing" }).click();

    const details = page.getByRole("button", { name: "Note & details" });
    await expect(details).toHaveAttribute("aria-expanded", "false");

    const timestamp = page.locator('[data-slot="date-time-field"]');
    await expect(timestamp).toBeVisible();
    const dateInput = timestamp.locator(
      '[data-slot="date-field"] input[type="text"]',
    );
    const timeInput = timestamp.locator(
      '[data-slot="time-field"] input[type="text"]',
    );
    await dateInput.fill("2026-01-15");
    await dateInput.blur();
    await timeInput.fill("09:45");
    await timeInput.blur();

    const created = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/mood-entries" &&
        res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await created).status()).toBe(201);

    // 09:45 in Berlin in January is 08:45 UTC.
    expect(await storedMoods(page)).toEqual([
      { mood: "SUPER_GUT", moodLoggedAt: "2026-01-15T08:45:00.000Z" },
    ]);

    // The list shows it, at either width (the table and the phone cards each
    // carry the marker; one of them is on screen).
    const rows = page.locator('[data-slot="mood-rows"]').filter({
      visible: true,
    });
    await expect(rows).toBeVisible();
    await expect(rows).toContainText("Amazing");
    await expect(rows).toContainText("09:45");

    // And still after a reload, which reads the list from the server again
    // rather than from the cache the mutation updated.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(rows).toContainText("Amazing");
    await expect(rows).toContainText("09:45");
  });
});
