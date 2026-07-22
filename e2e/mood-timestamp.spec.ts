import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

test.describe("mood timestamp capture", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("keeps Time visible while details are collapsed and submits the selected instant", async ({
    page,
  }) => {
    let submitted: Record<string, unknown> | null = null;

    await page.route("**/api/mood-entries*", async (route) => {
      if (route.request().method() === "POST") {
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ data: { id: "created-mood" }, error: null }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], meta: { total: 0, limit: 50, offset: 0 } },
          error: null,
        }),
      });
    });

    await page.goto("/mood", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add", exact: true }).click();
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

    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect.poll(() => submitted).not.toBeNull();
    expect(submitted).toMatchObject({
      mood: "SUPER_GUT",
      moodLoggedAt: "2026-01-15T08:45:00.000Z",
    });
  });
});
