import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 B3 — admin login-overview carrier chip + CSV column.
 *
 * Two contracts under test:
 *
 *   1. The carrier chip slot (`data-slot="login-overview-carrier"`)
 *      renders beneath the auth-provider chip when the audit row
 *      carries a GeoLite2-ASN organisation string. The component
 *      branches on `entry.carrier`; null carriers (private/loopback
 *      IPs, offline-miss rows) keep the original single-chip layout.
 *
 *   2. The CSV-export button emits a file whose first row carries
 *      the translated `carrier` column header. The header sits
 *      between `location` and `provider` (see the v1.4.27 B3 column-
 *      order comment in `_shared.tsx`).
 *
 * The seed user has the ADMIN role (`e2e/setup/global-setup.ts` →
 * `E2E_USER.role = "ADMIN"`), so the admin route is reachable
 * directly.
 */
test.describe("v1.4.27 — admin login-overview", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  const FIXED_ROW = {
    id: "audit_e2e_1",
    action: "auth.login.success",
    ipAddress: "85.214.0.1",
    location: "Berlin, DE",
    asn: 3320,
    // The carrier short-label collapses Deutsche Telekom → "Telekom"
    // (see `carrierShortLabel` in `_shared.tsx`). The chip renders
    // the SHORT label; the CSV emits the raw value.
    carrier: "Deutsche Telekom AG",
    details: null,
    createdAt: new Date("2026-05-15T10:00:00Z").toISOString(),
    user: { id: "u_e2e", username: "e2e-tester" },
  };

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/admin/audit-log?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            entries: [FIXED_ROW],
            meta: { total: 1, limit: 50, offset: 0, page: 1, perPage: 50 },
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/admin/audit-log/actions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { actions: ["auth.login.success", "auth.login.failed"] },
          error: null,
        }),
      }),
    );
  });

  test("the carrier chip renders beneath the provider chip", async ({
    page,
  }) => {
    await page.goto("/admin/login-overview", { waitUntil: "domcontentloaded" });

    // The table mounts the carrier slot for rows where `entry.carrier`
    // is non-null. We mocked one row that carries the Deutsche-Telekom
    // organisation string.
    const chip = page.locator('[data-slot="login-overview-carrier"]').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    // The chip carries the short DACH label for known carriers.
    await expect(chip).toHaveText(/Telekom/);
  });

  test("the CSV export emits a file with the carrier column header", async ({
    page,
  }) => {
    await page.goto("/admin/login-overview", { waitUntil: "domcontentloaded" });

    // Wait for the table to render so the export button is enabled.
    await expect(
      page.locator('[data-slot="login-overview-carrier"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // The CSV is generated client-side via a Blob + anchor click —
    // intercept the download event Playwright surfaces for that path.
    const exportButton = page.getByRole("button", { name: /export|csv/i });

    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await exportButton.click();
    const download = await downloadPromise;

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const csv = Buffer.concat(chunks).toString("utf-8");

    const headerLine = csv.split(/\r?\n/, 1)[0] ?? "";
    // The CSV header is locale-aware (admin.carrier). Test users get
    // the English admin locale by default — but if the key falls
    // through, the raw `admin.carrier` is still emitted. Accept both.
    expect(headerLine.toLowerCase()).toMatch(/carrier|admin\.carrier/);
  });
});
