import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { mockDay } from "./setup/day-mock";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import { mockTimeline } from "./utils/mock-timeline";

/**
 * v1.42 — the keyboard shortcuts.
 *
 *   - `g t` opens the timeline while its module is on, and does nothing while
 *     it is off;
 *   - keys typed into a field stay in the field;
 *   - `?` opens the list: a titled dialog that keeps focus inside and closes
 *     on Escape; the account menu opens the same list;
 *   - `n` opens the add menu;
 *   - `[` and `]` step the open day, never past today.
 *
 * The module map is the account's real `/api/auth/me` with only `timeline`
 * rewritten, so the switch is never moved on a shared account. Desktop only:
 * a phone has no keyboard to press these on.
 */

test.use({ storageState: STORAGE_STATE_PATH });

const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function shiftDay(key: string, delta: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function withTimelineModule(page: Page, on: boolean): Promise<void> {
  await page.route("**/api/auth/me", async (route) => {
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (!json?.data?.modules) return route.fulfill({ response: res });
    json.data.modules.timeline = on;
    return route.fulfill({
      response: res,
      body: JSON.stringify(json),
      headers: { ...res.headers(), "content-type": "application/json" },
    });
  });
}

/** The shell is up and its listener registered. */
async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();
}

const helpDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Keyboard shortcuts" });

test.describe("keyboard shortcuts", () => {
  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "keyboard journeys run on the desktop project",
    );
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
  });

  test("g t opens the timeline while its module is on", async ({ page }) => {
    await withTimelineModule(page, true);
    await mockTimeline(page, "ready", TODAY);
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page).toHaveURL(/\/timeline$/);
  });

  test("g t does nothing while the timeline module is off", async ({
    page,
  }) => {
    await withTimelineModule(page, false);
    // Every client navigation, in order, so "nothing happened" is a fact
    // rather than a wait.
    await page.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __pushed: string[] }).__pushed = log;
      const push = history.pushState.bind(history);
      history.pushState = (state, unused, url) => {
        if (url != null) log.push(String(url));
        push(state, unused, url);
      };
    });
    await page.goto("/insights");
    await shellReady(page);
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    // The positive control: the same reader opens a page that is on.
    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await expect(page).toHaveURL(/\/$/);
    const pushed = await page.evaluate(
      () => (window as unknown as { __pushed: string[] }).__pushed,
    );
    expect(pushed.some((url) => url.includes("/timeline"))).toBe(false);
  });

  test("keys typed into a field stay in the field", async ({ page }) => {
    await withTimelineModule(page, true);
    await page.goto("/");
    await shellReady(page);
    // A plain field in the page: the rule is about the focused element, not
    // about which page carries it.
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.setAttribute("data-testid", "probe-field");
      field.setAttribute("aria-label", "Probe");
      document.getElementById("main-content")?.prepend(field);
    });
    const field = page.getByTestId("probe-field");
    await field.focus();
    await page.keyboard.type("gt n ? [");
    await expect(field).toHaveValue("gt n ? [");
    await expect(page).toHaveURL(/\/$/);
    await expect(helpDialog(page)).toHaveCount(0);
    await expect(page.getByTestId("capture-picker-options")).toHaveCount(0);
  });

  test("? opens a titled list that keeps focus and closes on Escape", async ({
    page,
  }) => {
    await page.goto("/");
    await shellReady(page);
    await page.keyboard.press("Shift+?");
    const dialog = helpDialog(page);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator('[data-slot="keyboard-shortcuts"] [data-group]'),
    ).toHaveCount(3);
    await expect(dialog.locator('[data-shortcut="go-d"] kbd')).toHaveText([
      "g",
      "d",
    ]);

    // Focus trap: Tab and Shift+Tab never leave the dialog.
    for (const step of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(step);
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }

    // While the list is open, the page's shortcuts are off.
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).toHaveURL(/\/$/);

    const axe = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the account menu opens the same list", async ({ page }) => {
    await page.goto("/");
    await shellReady(page);
    await page
      .getByRole("button", { name: "User menu" })
      .locator("visible=true")
      .first()
      .click();
    await page.locator('[data-slot="open-keyboard-shortcuts"]').click();
    await expect(helpDialog(page)).toBeVisible();
  });

  test("n opens the add menu", async ({ page }) => {
    await page.goto("/insights");
    await shellReady(page);
    await page.keyboard.press("n");
    await expect(page.getByTestId("capture-picker-options")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("capture-picker-options")).toHaveCount(0);
  });

  test("[ and ] step the open day, never past today", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockDay(page);
    const yesterday = shiftDay(TODAY, -1);
    await page.goto(`/insights?day=${yesterday}`);
    await shellReady(page);
    const panel = page.locator('[data-slot="day-panel"]');
    await expect(panel).toHaveAttribute("data-shell", "docked");
    // Focus on the page, not in the panel: docked, the keys still reach it.
    await page.locator("#main-content").focus();

    await page.keyboard.press("[");
    await expect(page).toHaveURL(new RegExp(`[?&]day=${shiftDay(TODAY, -2)}`));
    await page.keyboard.press("]");
    await page.keyboard.press("]");
    await expect(page).toHaveURL(new RegExp(`[?&]day=${TODAY}`));
    await page.keyboard.press("]");
    await expect(page).toHaveURL(new RegExp(`[?&]day=${TODAY}`));
  });
});
