import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  criticalAccount,
  criticalStorageState,
  resetCriticalAccount,
} from "./setup/critical-fixture";

/**
 * Lab results from a spreadsheet (#1215), against the real server: the
 * mapping is suggested from the headers, the check reports a refused row by
 * line and writes nothing, the import writes the rest, the imported row is on
 * the labs page, and a second import of the same file only finds duplicates.
 *
 * The account is the labs journey's own, one per project
 * (`critical-fixture.ts`), emptied of results first. Before v1.46 this ran on
 * the shared account in both projects, so the "only duplicates" verdict of
 * one project could be the other project's first import.
 */

const ANALYTE = "E2E Marker CSV";

function csv(): string {
  const day = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return [
    "Analyte;Value;Unit;Date",
    // A decimal comma, as a German lab export writes it.
    `${ANALYTE};5,4;mmol/L;${day}`,
    // Either 1.234 or 1234: refused as ambiguous rather than guessed.
    `${ANALYTE};1.234;mmol/L;${day}`,
  ].join("\n");
}

/** The account's lab results, as the list route answers them. */
async function storedResults(
  page: Page,
): Promise<Array<{ analyte: string; value: number | null; unit: string }>> {
  const res = await page.request.get("/api/labs");
  expect(res.status()).toBe(200);
  const { data } = (await res.json()) as {
    data: {
      results: Array<{ analyte: string; value: number | null; unit: string }>;
    };
  };
  return data.results.map(({ analyte, value, unit }) => ({
    analyte,
    value,
    unit,
  }));
}

test.describe("record CSV import", () => {
  test.use({ storageState: criticalStorageState("labs") });

  test.beforeEach(async ({}, testInfo) => {
    // Fixture hygiene: what a previous run or a retry left on the account.
    await resetCriticalAccount(criticalAccount("labs", testInfo), [
      "DELETE FROM lab_results WHERE user_id = $1",
    ]);
  });

  test("checks, imports, lists the result and then only finds duplicates @critical", async ({
    page,
  }) => {
    await page.goto("/settings/export");
    await page.locator('[data-slot="record-import-open-labs"]').click();
    const sheet = page.locator('[data-slot="record-import-sheet"]');
    await expect(sheet).toBeVisible();
    const file = {
      name: "labs.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv()),
    };
    await page.locator('[data-slot="record-import-file"]').setInputFiles(file);
    await expect(
      page.locator('[data-slot="record-import-map-analyte"]'),
    ).toHaveValue("0");
    await expect(
      page.locator('[data-slot="record-import-map-value"]'),
    ).toHaveValue("1");

    await page.locator('[data-slot="record-import-check"]').click();
    await expect(
      page.locator('[data-slot="record-import-checked"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="record-import-error-row"]'),
    ).toHaveCount(1);
    // The check is a dry run.
    expect(await storedResults(page)).toEqual([]);

    await page.locator('[data-slot="record-import-run"]').click();
    await expect(
      page.locator('[data-slot="record-import-done"]'),
    ).toBeVisible();
    expect(await storedResults(page)).toEqual([
      { analyte: ANALYTE, value: 5.4, unit: "mmol/L" },
    ]);

    await test.step("the result is on the labs page", async () => {
      await page.goto("/labs");
      const analyte = page
        .locator('[data-slot="lab-list-analyte"]')
        .filter({ hasText: ANALYTE })
        .filter({ visible: true });
      await expect(analyte).toHaveCount(1);
      // The cell the name heads carries the latest reading under it.
      await expect(analyte.locator("xpath=../..")).toContainText("5.4");
    });

    await test.step("a second run of the same file", async () => {
      await page.goto("/settings/export");
      await page.locator('[data-slot="record-import-open-labs"]').click();
      await page
        .locator('[data-slot="record-import-file"]')
        .setInputFiles(file);
      await page.locator('[data-slot="record-import-check"]').click();
      await expect(
        page.locator('[data-slot="record-import-checked"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="record-import-run"]'),
      ).toBeDisabled();
      expect(await storedResults(page)).toHaveLength(1);
    });
  });
});
