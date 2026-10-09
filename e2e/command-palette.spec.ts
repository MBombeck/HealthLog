import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

/**
 * v1.42 — the command palette.
 *
 *   - Cmd/Ctrl+K, "sleep", Enter lands on the sleep page;
 *   - a settings card is a link with its anchor, and the page scrolls to it;
 *   - a module's entry is a switch: Enter sends the module write and the
 *     palette stays open (the write is answered by a route mock, so the
 *     shared account's modules never move);
 *   - the top bar carries the search field on a wide desktop and a
 *     magnifier on a phone, which opens a full-height sheet with the field
 *     focused;
 *   - the open palette passes axe.
 *
 * Stable hooks only: `command-palette` (+ `data-variant`),
 * `command-palette-input`, `command-palette-trigger` (+ `data-variant`),
 * options by `data-entry`.
 */

test.use({ storageState: STORAGE_STATE_PATH });

const palette = (page: Page) => page.locator('[data-slot="command-palette"]');
const input = (page: Page) =>
  page.locator('[data-slot="command-palette-input"]');

async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();
}

test.describe("command palette", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "palette journeys run on the desktop project (the phone case resizes)",
    );
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
  });

  test("Cmd/Ctrl+K, sleep, Enter opens the sleep page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette(page)).toHaveAttribute("data-variant", "dialog");
    await expect(input(page)).toBeFocused();
    await input(page).fill("sleep");
    // The best hit is the highlighted option.
    const active = await input(page).getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${active}"]`)).toHaveAttribute(
      "data-entry",
      "insights:sleep",
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/insights\/sleep$/);
    await expect(palette(page)).toHaveCount(0);
  });

  test("a settings card opens at its anchor", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("passkeys");
    await page.locator('[data-entry="settings:security#passkeys"]').click();
    await expect(page).toHaveURL(/\/settings\/security#passkeys$/);
    await expect(page.locator("#passkeys")).toBeInViewport({ timeout: 10_000 });
  });

  test("a module is a switch; Enter flips it and the palette stays", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const writes: unknown[] = [];
    await page.route("**/api/auth/me/modules", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      writes.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            modules: { timeline: true },
            updatedAt: new Date().toISOString(),
          },
          error: null,
        }),
      });
    });
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("ControlOrMeta+k");
    await input(page).fill("timeline");
    const option = page.locator('[data-entry="module:timeline"]');
    await expect(option).toHaveAttribute("aria-checked", "false");
    await option.hover();
    await page.keyboard.press("Enter");
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ timeline: true });
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toHaveValue("timeline");
  });

  test("the top bar: a search field on a wide desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await shellReady(page);
    const field = page.locator(
      '[data-slot="command-palette-trigger"][data-variant="field"]',
    );
    await expect(field).toBeVisible();
    await expect(
      page.locator(
        '[data-slot="command-palette-trigger"][data-variant="icon"]',
      ),
    ).toBeHidden();
    await field.click();
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();

    const axe = await new AxeBuilder({ page })
      .include('[data-slot="command-palette"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
  });

  test("on a phone: the magnifier opens a full-height sheet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await shellReady(page);
    const magnifier = page.locator(
      '[data-slot="command-palette-trigger"][data-variant="icon"]',
    );
    await expect(magnifier).toBeVisible();
    await magnifier.click();
    await expect(palette(page)).toHaveAttribute("data-variant", "sheet");
    await expect(input(page)).toBeFocused();
    const box = await palette(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(844 - 1);
    await input(page).fill("weight");
    await expect(page.locator('[data-entry="insights:weight"]')).toBeVisible();
  });
});
