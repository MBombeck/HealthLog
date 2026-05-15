import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 MB6 — `/measurements?add=<TYPE>` consumer.
 *
 * The insights empty-state CTAs link here with a `?add=<TYPE>` query
 * param. The page reads the param during render, opens the
 * Add-Measurement primitive, pre-selects the matching type, then
 * `router.replace("/measurements")` strips the query so the back
 * button drops the user on the bare list instead of re-opening the
 * dialog.
 *
 * Three contracts under test:
 *   1. The primitive opens on first paint.
 *   2. The form's type combobox shows the requested type.
 *   3. The URL settles on `/measurements` (no `?add=`).
 *
 * Pixel 5 is the load-bearing project — every CTA hop originates from
 * the mobile-first empty-state surfaces. Desktop Chrome covers the
 * regression path through the dashboard quick-entry.
 */
test.describe("v1.4.27 — /measurements?add= consumer", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
          error: null,
        }),
      }),
    );
    await page.route("**/api/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements: [], meta: { total: 0 } },
          error: null,
        }),
      }),
    );
  });

  for (const { param, label } of [
    { param: "WEIGHT", label: /weight|gewicht/i },
    { param: "BLOOD_PRESSURE", label: /blood pressure|blutdruck/i },
    { param: "PULSE", label: /pulse|puls|herzfrequenz/i },
  ]) {
    test(`?add=${param} opens the form pre-selected to ${param}`, async ({
      page,
    }) => {
      await page.goto(`/measurements?add=${param}`, {
        waitUntil: "domcontentloaded",
      });

      // Primitive opens on first paint — pin on the shared data-slot.
      const content = page.locator('[data-slot="responsive-sheet-content"]');
      await expect(content).toBeVisible({ timeout: 10_000 });

      // The type combobox label reflects the requested type.
      const combobox = content.getByRole("combobox").first();
      await expect(combobox).toBeVisible();
      await expect(combobox).toContainText(label);

      // URL settles on `/measurements` — the query was replaced away
      // so the back button leaves the user on the list.
      await expect.poll(() => new URL(page.url()).search).toBe("");
    });
  }

  test("unknown ?add value is dropped silently and the page renders empty", async ({
    page,
  }) => {
    await page.goto("/measurements?add=NOT_A_TYPE", {
      waitUntil: "domcontentloaded",
    });

    // Primitive must NOT open — unknown types are dropped silently.
    const content = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(content).toHaveCount(0, { timeout: 5_000 });

    // URL still settles on the bare list.
    await expect.poll(() => new URL(page.url()).search).toBe("");
  });
});
