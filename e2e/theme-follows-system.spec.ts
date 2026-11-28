import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";

/**
 * The theme follows the device unless a person chose one.
 *
 * The suite runs every project with a dark scheme; this spec sets its own.
 * The sign-in page carries the same boot script and provider as every other
 * page, and needs no session. Nothing is stored at the start, as on a first
 * visit.
 */
test.use({
  storageState: { cookies: [], origins: [] },
  colorScheme: "light",
});

const html = (page: Page) => page.locator("html");

test("a light device with nothing stored paints light, and switches live", async ({
  page,
}) => {
  await page.goto("/auth/login");
  await expect(html(page)).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(html(page)).not.toHaveClass(/(^|\s)dark(\s|$)/);
  const barColours = await page
    .locator('meta[name="theme-color"]')
    .evaluateAll((tags) => tags.map((t) => t.getAttribute("content")));
  expect(new Set(barColours)).toEqual(new Set(["#f2f0eb"]));

  // The device turns dark: the page follows without a reload.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html(page)).not.toHaveClass(/(^|\s)light(\s|$)/);
  expect(
    await page.evaluate(() => localStorage.getItem("healthlog-theme")),
  ).toBeNull();
});

test("an explicit dark choice is kept on a light device", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("healthlog-theme", "dark");
  });
  await page.goto("/auth/login");
  await expect(html(page)).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html(page)).not.toHaveClass(/(^|\s)light(\s|$)/);
});
