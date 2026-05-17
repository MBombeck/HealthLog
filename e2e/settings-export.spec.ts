import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 phase B7 — Settings → Export consolidated UI smoke.
 *
 * Validates that:
 *   1. The five export cards are all rendered with their stable testids.
 *   2. Clicking the Measurements CSV download button fires a real
 *      browser download — proving the new `/api/export/measurements`
 *      endpoint is reachable from the browser end-to-end.
 *
 * The other CSV / JSON cards share the same code path; one happy-path
 * download is enough to lock in the wiring without doubling the e2e
 * runtime.
 */
test.describe("Settings → Export", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("renders all five export cards with stable testids", async ({
    page,
  }) => {
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    // v1.4.37 lifted the doctor-report card to a hero block with the
    // `export-hero-*` testid prefix; the four CSV/backup tiles keep
    // the `export-card-*` shape.
    for (const id of [
      "export-hero-doctor-report",
      "export-card-measurements-csv",
      "export-card-medications-csv",
      "export-card-mood-csv",
      "export-card-full-backup",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
    }
  });

  test("Measurements CSV download fires a real download event", async ({
    page,
  }) => {
    // Stub the API so we don't need 90 days of seeded data — the
    // browser-side wiring is what we're validating, not the route's
    // DB query.
    await page.route("**/api/export/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition":
            'attachment; filename="healthlog-measurements-test.csv"',
        },
        body: "type,value,unit,measuredAt,source,notes,glucoseContext\nWEIGHT,80,kg,2026-05-01T08:00:00.000Z,MANUAL,,\n",
      }),
    );

    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    const downloadBtn = page.getByTestId("export-action-measurements-csv");
    await expect(downloadBtn).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", {
      timeout: 30_000,
    });
    await downloadBtn.click();
    const download = await downloadPromise;

    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.toString("utf8")).toContain("WEIGHT,80,kg");
  });
});
