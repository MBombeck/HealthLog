import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Doctor-report PDF flow. The real flow:
 *   1. User clicks "Configure & generate" on `/settings/export`
 *      (relocated from `/settings/advanced` in v1.4.16 phase B7)
 *   2. The dialog opens; user picks dates and submits.
 *   3. Frontend POSTs `/api/doctor-report` to fetch aggregated data
 *   4. Frontend dynamic-imports `src/lib/doctor-report-pdf.ts` and
 *      generates the PDF client-side via jsPDF; calls `doc.save(...)`
 *      which triggers a download.
 *
 * This spec mocks step 3 (so we don't need 90 days of seeded data) and
 * captures step 4's download via Playwright's download API. We then
 * confirm the file is non-empty and starts with `%PDF` magic bytes.
 */
test.describe("doctor report PDF generation", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("button click triggers a non-empty PDF download", async ({ page }) => {
    // Mock the data endpoint with a minimal-but-shape-correct payload.
    // The shape below mirrors the `ReportData` interface in
    // `src/lib/doctor-report-pdf.ts` — empty stats / medications / mood
    // is enough to exercise the table-rendering path without 90 days
    // of seeded readings.
    await page.route("**/api/doctor-report", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            period: {
              days: 90,
              since: new Date(Date.now() - 90 * 86_400_000).toISOString(),
            },
            patient: {
              username: "e2e-tester",
              dateOfBirth: "1985-06-15T00:00:00.000Z",
              gender: "MALE",
              heightCm: 180,
            },
            stats: {},
            bmi: null,
            compliance: {},
            medications: [],
            mood: null,
          },
          error: null,
        }),
      }),
    );

    // Capture page errors so a failed dynamic-import surfaces in the
    // test output instead of timing out silently.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error")
        pageErrors.push(`console.error: ${msg.text()}`);
    });

    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });

    // v1.4.37 renamed the trigger testid from `export-action-doctor-report`
    // to `export-hero-doctor-report-action` when the card was lifted to a
    // hero block on the export page.
    const reportBtn = page.getByTestId("export-hero-doctor-report-action");
    await expect(reportBtn).toBeVisible({ timeout: 10_000 });

    // Click opens the dialog; the dialog's submit button triggers the PDF
    // generation. Trigger the download and capture the resulting Download
    // object once the user confirms.
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await reportBtn.click();
    // Submit the dialog with the default dates (last 90 days).
    const submitBtn = page.getByRole("button", {
      name: /generate pdf|pdf generieren/i,
    });
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await submitBtn.click();
    const download = await downloadPromise.catch((err) => {
      throw new Error(
        `Download did not fire. Page errors:\n${pageErrors.join("\n")}\n\nOriginal: ${err}`,
      );
    });

    const path = await download.path();
    expect(path).toBeTruthy();

    // Read first 4 bytes — a valid PDF starts with `%PDF`.
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(path!);
    expect(buf.byteLength).toBeGreaterThan(1024);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});
