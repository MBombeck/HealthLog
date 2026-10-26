import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  criticalAccount,
  criticalStorageState,
  resetCriticalAccount,
} from "./setup/critical-fixture";
import { openMenu } from "./open-menu";

/**
 * Add-measurement flow, against the real server: the dashboard's quick-entry
 * menu, the dialog-mounted MeasurementForm, the real POST to
 * `/api/measurements`, and then every surface that has to agree about the
 * reading afterwards: the dashboard tile, the weight chart (through the data
 * table that lists exactly the points it drew) and the day view.
 *
 * Until v1.46 this spec answered its own POST and its own list read with a
 * route stub, so it proved that the list renders a row the test typed in.
 * Nothing here is stubbed now. The account is the measurement journey's own,
 * one per project (`critical-fixture.ts`), and is emptied of readings before
 * the test, so "the tile shows the weight" can only mean the weight this test
 * entered.
 *
 * Weight is the simplest type (single numeric input + datetime), so it keeps
 * the spec on the round trip rather than on the blood-pressure batch.
 */

/** Distinct from anything a fixture seeds, so a match is this reading. */
const WEIGHT_KG = "81.7";

/** Today in the browser's zone (`timezoneId` in `playwright.config.ts`). */
function todayInBerlin(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The account's weight readings, as the list route answers them. */
async function storedWeights(
  page: Page,
): Promise<Array<{ value: number; unit: string }>> {
  const res = await page.request.get("/api/measurements?type=WEIGHT");
  expect(res.status()).toBe(200);
  const { data } = (await res.json()) as {
    data: { measurements: Array<{ value: number; unit: string }> };
  };
  return data.measurements.map(({ value, unit }) => ({ value, unit }));
}

test.describe("add measurement flow", () => {
  test.use({ storageState: criticalStorageState("measurement") });

  // This journey lands on the dashboard, which is the most expensive page in
  // the product to render cold, and then reads three more surfaces. The
  // assertions stay as tight as they are; the budget is the pages'.
  test.setTimeout(90_000);

  test.beforeEach(async ({}, testInfo) => {
    // Fixture hygiene: what a previous run or a retry left on the account.
    await resetCriticalAccount(criticalAccount("measurement", testInfo), [
      "DELETE FROM measurement_rollups WHERE user_id = $1",
      "DELETE FROM measurements WHERE user_id = $1",
    ]);
  });

  test("a weight entered on the dashboard reaches the tile, the chart and the day view @critical", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The quick-entry trigger sits at the top of `<main>`. Waiting for it,
    // rather than for the route skeleton to go, is waiting for the thing the
    // next line clicks.
    const addTrigger = page
      .locator("main")
      .getByRole("button", { name: /^add$|hinzufügen|hinzufuegen/i })
      .first();
    await expect(addTrigger).toBeVisible({ timeout: 60_000 });
    // The account holds no weight yet, so whatever the surfaces below show
    // can only come from this reading.
    expect(await storedWeights(page)).toEqual([]);

    await openMenu(page, addTrigger);

    // The desktop rail opens a dropdown, the phone shell the capture sheet
    // the bottom nav's plus opens; the measurement entry is in either.
    await page
      .getByRole("menuitem", { name: /measurement|messung/i })
      .or(page.getByRole("button", { name: /^(measurement|messung)\b/i }))
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The type select defaults to blood pressure.
    await dialog.getByRole("combobox").first().click();
    await page
      .getByRole("option", { name: /weight|gewicht/i })
      .first()
      .click();
    await dialog.locator("#value").fill(WEIGHT_KG);

    const created = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/measurements" &&
        res.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: /save|speichern/i }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    await expect(dialog).toBeHidden();

    await test.step("the server stored exactly that reading", async () => {
      expect(await storedWeights(page)).toEqual([
        { value: Number(WEIGHT_KG), unit: "kg" },
      ]);
    });

    await test.step("the dashboard tile", async () => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tile = page.locator(
        '[data-slot="dashboard-tile-link"][data-tile-id="weight"]',
      );
      await expect(tile).toBeVisible({ timeout: 60_000 });
      await expect(tile.locator('[data-slot="trend-card-value"]')).toHaveText(
        WEIGHT_KG,
      );
    });

    await test.step("the weight chart", async () => {
      await page.goto("/insights/weight", { waitUntil: "domcontentloaded" });
      const table = page.locator('[data-slot="chart-data-table"]').first();
      await expect(table).toBeVisible({ timeout: 30_000 });
      await table.locator('[data-slot="chart-data-table-toggle"]').click();
      const rows = table.locator('[data-slot="chart-data-table-row"]');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(WEIGHT_KG);
    });

    await test.step("the day view", async () => {
      await page.goto(`/measurements?day=${todayInBerlin()}`, {
        waitUntil: "domcontentloaded",
      });
      const value = page.locator(
        '[data-slot="day-view"] [data-slot="day-value"][data-type="WEIGHT"]',
      );
      await expect(value).toBeVisible({ timeout: 30_000 });
      await expect(value).toContainText(WEIGHT_KG);
    });
  });
});
