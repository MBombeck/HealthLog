import type { Locator, Page } from "@playwright/test";

import { mockDay } from "./setup/day-mock";
import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * The installed iOS app's short layout viewport (`webkit-iphone` project).
 *
 * iOS 26 can hand a home-screen app a layout viewport that ends short of the
 * screen by the status bar's height; the shell, the bottom bar and the bottom
 * sheets then stopped above the screen's bottom edge, where Safari's toolbar
 * would sit in a tab. No browser under test does that, so the defect is
 * staged the way the page sees it: `navigator.standalone` is true, the
 * screen is taller than the window by the top inset, and the top inset is
 * set through `--safe-area-top` (no desktop engine reports one). The strip
 * then lies below the window, and the boxes that own the bottom edge must
 * reach into it by exactly that much; in a browser tab, nothing moves.
 *
 * The keyboard is staged too (a visual viewport shorter than the window):
 * a sheet standing on it keeps the inset alone, strip or not.
 */

const GAP = 47;

async function stageInstalledApp(page: Page, gap: number) {
  await page.addInitScript((gap) => {
    Object.defineProperty(Navigator.prototype, "standalone", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(Screen.prototype, "width", {
      configurable: true,
      get: () => window.innerWidth,
    });
    Object.defineProperty(Screen.prototype, "height", {
      configurable: true,
      get: () => window.innerHeight + gap,
    });
  }, gap);
}

/** Sets the top inset and lets the tracker measure again. */
async function setTopInset(page: Page, px: number) {
  await page.addStyleTag({
    content: `:root { --safe-area-top: ${px}px !important; }`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
}

const bottomOf = (locator: Locator) =>
  locator.evaluate((el) => el.getBoundingClientRect().bottom);
const innerHeight = (page: Page) => page.evaluate(() => window.innerHeight);

async function settled(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((el) =>
        el.getAnimations().every((a) => a.playState !== "running"),
      ),
    )
    .toBe(true);
}

async function openSymptomForm(page: Page) {
  await page.locator('[data-testid="bottom-nav-capture"]').tap();
  await page.locator('[data-testid="capture-picker-symptom"]').tap();
  const form = page.locator(
    '[data-slot="responsive-sheet-content"][data-state="open"]',
  );
  await expect(form).toBeVisible();
  await settled(form);
  return form;
}

test.describe("an installed app whose viewport ends short", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page, context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
    await mockDay(page);
  });

  test("in a browser tab the bar and a sheet end on the window's edge", async ({
    page,
  }) => {
    await page.goto("/mood");
    const nav = page.locator('[data-slot="bottom-nav"]');
    await expect(nav).toBeVisible();
    await setTopInset(page, GAP);
    const height = await innerHeight(page);
    expect(await bottomOf(nav)).toBeCloseTo(height, 0);
    const form = await openSymptomForm(page);
    expect(await bottomOf(form)).toBeCloseTo(height, 0);
  });

  test("the shell, the bar, a sheet and its backdrop reach the screen's bottom edge", async ({
    page,
  }) => {
    await stageInstalledApp(page, GAP);
    await page.goto("/mood");
    const nav = page.locator('[data-slot="bottom-nav"]');
    await expect(nav).toBeVisible();
    await setTopInset(page, GAP);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--viewport-bottom-gap",
          ),
        ),
      )
      .toBe(`${GAP}px`);

    const screenBottom = (await innerHeight(page)) + GAP;
    expect(await bottomOf(nav)).toBeCloseTo(screenBottom, 0);
    expect(
      await page
        .locator('[data-slot="bottom-nav"]')
        .evaluate(
          (el) =>
            (
              el.closest("[class*='shell-safe-area']") ?? document.body
            ).getBoundingClientRect().bottom,
        ),
    ).toBeCloseTo(screenBottom, 0);

    const form = await openSymptomForm(page);
    expect(await bottomOf(form)).toBeCloseTo(screenBottom, 0);
    expect(
      await bottomOf(page.locator('[data-slot="sheet-overlay"]').last()),
    ).toBeCloseTo(screenBottom, 0);
  });

  test("a sheet standing on the keyboard keeps the keyboard's inset alone", async ({
    page,
  }) => {
    await stageInstalledApp(page, GAP);
    await page.goto("/mood");
    await expect(page.locator('[data-slot="bottom-nav"]')).toBeVisible();
    await setTopInset(page, GAP);
    const form = await openSymptomForm(page);

    const KEYBOARD = 300;
    await page.evaluate((keyboard) => {
      const vv = window.visualViewport!;
      const height = window.innerHeight - keyboard;
      Object.defineProperty(vv, "height", {
        configurable: true,
        get: () => height,
      });
      vv.dispatchEvent(new Event("resize"));
    }, KEYBOARD);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
    const keyboardTop = (await innerHeight(page)) - KEYBOARD;
    expect(await bottomOf(form)).toBeCloseTo(keyboardTop, 0);
    await expect(page.locator('[data-slot="bottom-nav"]')).toBeHidden();
  });
});
