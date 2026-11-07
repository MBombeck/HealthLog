import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The tobacco section's typed fields take what a person types one key at a
 * time. Through v1.47.0 neither did: "When you stopped" only accepted text
 * that was already a whole YYYY-MM month, so every keystroke was thrown away
 * and only a paste got in, and the start year clamped each keystroke into
 * 1900..this year, so the first digit became 1900.
 *
 * The test types and leaves the fields without saving, so the shared
 * account keeps whatever answers it had.
 */
test.describe("life circumstances typed fields", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("start year and quit month take keystrokes", async ({ page }) => {
    await page.goto("/settings/anamnesis", { waitUntil: "domcontentloaded" });
    const section = page.locator('[data-slot="life-section-tobacco"]');
    await section.locator("summary").click();

    await section.locator("#life-tobacco-status").selectOption("FORMER");

    const start = section.locator("#life-tobacco-start");
    await start.fill("");
    await start.pressSequentially("1985");
    await expect(start).toHaveValue("1985");
    await start.blur();
    await expect(start).toHaveValue("1985");

    const quit = section.locator("#life-tobacco-quit");
    await quit.fill("");
    await quit.pressSequentially("2019-03");
    await expect(quit).toHaveValue("2019-03");
    await quit.blur();
    await expect(quit).toHaveValue("2019-03");

    // A single-digit month is padded when the field is left.
    await quit.fill("");
    await quit.pressSequentially("2018-7");
    await expect(quit).toHaveValue("2018-7");
    await quit.blur();
    await expect(quit).toHaveValue("2018-07");
  });
});
