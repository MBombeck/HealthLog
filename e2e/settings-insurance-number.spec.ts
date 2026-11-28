import { expect, test } from "./setup/test";

import {
  criticalAccount,
  criticalStorageState,
  resetCriticalAccount,
} from "./setup/critical-fixture";

/**
 * The insurance number follows the country chosen beside it: an Austrian
 * SVNR saves under AT and comes back after a reload, and only a US plan
 * offers the group number.
 */
test.describe("settings insurance number", () => {
  test.use({ storageState: criticalStorageState("settings") });

  test.beforeEach(async ({}, testInfo) => {
    await resetCriticalAccount(criticalAccount("settings", testInfo), [
      "UPDATE users SET insurance_number_encrypted = NULL, insurance_number_country = NULL, insurance_group_number = NULL WHERE id = $1",
    ]);
  });

  test("an Austrian number saves under its country and a US plan adds the group number", async ({
    page,
  }) => {
    await page.goto("/settings/account");
    const country = page.locator("#insurance-country");
    const number = page.locator("#insurance-number");
    await expect(number).toBeVisible({ timeout: 30_000 });
    const form = page.locator("form", { has: number });

    await country.selectOption("AT");
    await expect(page.locator("#insurance-group-number")).toHaveCount(0);
    await number.fill("1237 010180");
    const saved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/auth/profile" &&
        res.request().method() === "PUT",
    );
    await form.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);

    const me = await page.request.get("/api/auth/me");
    const data = (
      (await me.json()) as {
        data: { insuranceNumber: string; insuranceNumberCountry: string };
      }
    ).data;
    expect(data.insuranceNumber).toBe("1237010180");
    expect(data.insuranceNumberCountry).toBe("AT");

    await page.reload();
    await expect(page.locator("#insurance-country")).toHaveValue("AT");
    // Stored compact, shown the way Austria writes it.
    await expect(page.locator("#insurance-number")).toHaveValue("1237 010180");

    await page.locator("#insurance-country").selectOption("US");
    await expect(page.locator("#insurance-group-number")).toBeVisible();
  });
});
