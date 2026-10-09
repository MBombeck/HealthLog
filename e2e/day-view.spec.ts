import type { Page, TestInfo } from "@playwright/test";

import { mockDay } from "./setup/day-mock";
import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import { MOBILE_ROUTES_ANALYTE } from "./setup/mobile-routes-fixture";

/**
 * v1.42 — the day view and its doors.
 *
 * The record is the phone-sweep account `globalSetup` seeds: a week of blood
 * pressure, two lab readings, mood and an episode. The day itself
 * (`GET /api/day/{date}`, `GET /api/day/index`) is answered by a route mock in
 * the contract's shape, so the journeys pin the client: which door opens which
 * day, what the history does, and where no door is.
 *
 *   - a chart point opens the day beside the chart (desktop);
 *   - on a touch screen the first tap shows the value and the tooltip offers
 *     the day, the second opens it as a bottom sheet;
 *   - a date in a list opens the day while the row keeps its own target;
 *   - `?day=` opens the layer on any page, Back and Escape close it, a date in
 *     the future is dropped;
 *   - stepping to the neighbouring days never adds history entries;
 *   - docked, the day collapses to a narrow edge that brings it back on any
 *     page; a sheet closes for good;
 *   - the dashboard's today area offers no door; its charts below do.
 *
 * Stable data attributes only: `day-panel` (+ `data-shell`), `day-link`,
 * the header's `day-date-button` and its `day-date-picker` (days keyed by
 * `data-date-key`, dotted by `data-entries`, and `day-date-today`),
 * `chart-plot[data-day-links]`, `chart-tooltip-open-day`, `day-prev` /
 * `day-next` / `day-close`, and the collapsed edge `day-rail` (+ `data-day`)
 * with its `day-expand`.
 */

const panel = (page: Page) => page.locator('[data-slot="day-panel"]');

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const dir = process.env.DAY_SHOTS_DIR;
  if (dir) {
    await page.screenshot({
      path: `${dir}/${name}-${testInfo.project.name}.png`,
    });
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

test.describe("the day view", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page, context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
    await mockDay(page);
  });

  test("a chart point opens its day beside the chart; Back closes it", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "desktop click");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/insights/blood-pressure");
    const plot = page.locator(
      '[data-slot="chart-plot"][data-day-links="true"]',
    );
    await expect(plot).toBeVisible();
    // The plot's right half holds the most recent points.
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);

    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute("data-shell", "docked");
    // A landmark beside the page, named by its date.
    await expect(panel(page)).toHaveJSProperty("tagName", "ASIDE");
    await expect(page).toHaveURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
    // The chart beside it stays usable: the panel is not modal.
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);

    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]day=/);
  });

  test("a date in a list opens the day; the row keeps its own target", async ({
    page,
  }) => {
    await page.goto("/labs");
    await page
      .locator('[data-slot="lab-list-analyte"]')
      .filter({ hasText: MOBILE_ROUTES_ANALYTE })
      .first()
      .click();
    // The marker's readings, each dated.
    await page.locator('a[href$="/values"]').first().click();
    const link = page.locator('[data-slot="day-link"]:visible').first();
    await expect(link).toBeVisible();
    const day = await link.getAttribute("data-day");
    const before = page.url();
    await link.click();
    await expect(panel(page)).toBeVisible();
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day!,
    );
    // Same page underneath: the click opened the day, not the reading.
    expect(new URL(page.url()).pathname).toBe(new URL(before).pathname);
    // The reading the person came from sits on top, with the one before it.
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
  });

  test("?day= opens the layer on any page; Escape closes it", async ({
    page,
  }) => {
    const day = isoDaysAgo(3);
    await page.goto(`/mood?day=${day}`);
    await expect(panel(page)).toBeVisible();
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day,
    );
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/mood$/);
  });

  test("the docked day collapses to an edge and comes back on another page", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "docked from 1280 px",
    );
    const day = isoDaysAgo(3);
    await page.goto(`/mood?day=${day}`);
    await expect(panel(page)).toHaveAttribute("data-shell", "docked");

    await page.locator('[data-slot="day-close"]').click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/mood$/);
    // A narrow edge stays, holding the day, and focus waits on its button.
    const rail = page.locator('[data-slot="day-rail"]');
    const expand = page.locator('[data-slot="day-expand"]');
    await expect(rail).toHaveAttribute("data-day", day);
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(await expand.getAttribute("aria-label")).toMatch(/^Show /);
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(48);

    // Another page: the edge is still there and brings the same day back,
    // from the keyboard too.
    await page.goto("/labs");
    await expect(rail).toHaveAttribute("data-day", day);
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveAttribute("data-shell", "docked");
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day,
    );
    await expect(page).toHaveURL(new RegExp(`/labs\\?day=${day}$`));
    await expect(panel(page).locator("h2").first()).toBeFocused();
    await expect(rail).toHaveCount(0);
  });

  test("the date opens a calendar; a picked day opens, Today goes to today", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "chromium-desktop";
    // The days of the month that hold anything carry a dot.
    await mockDay(page, { index: "full" });
    const day = isoDaysAgo(5);
    await page.goto(`/mood?day=${day}`);
    await expect(panel(page)).toHaveAttribute(
      "data-shell",
      desktop ? "docked" : "bottom",
    );
    const date = panel(page).locator('[data-slot="day-date-button"]');
    const picker = page.locator('[data-slot="day-date-picker"]');
    // The date stays one line in the header, the arrows beside it.
    await expect(date).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page).locator('[data-slot="day-prev"]')).toBeVisible();
    await shot(page, testInfo, "day-date-closed");

    await date.click();
    await expect(picker).toBeVisible();
    await expect(date).toHaveAttribute("aria-expanded", "true");
    await expect(picker.locator(`[data-date-key="${day}"]`)).toHaveAttribute(
      "data-selected-single",
      "true",
    );
    await expect(picker.locator('[data-entries="true"]').first()).toBeVisible();
    // Nothing past today can be picked.
    const tomorrow = picker.locator(`[data-date-key="${isoDaysAgo(-2)}"]`);
    if ((await tomorrow.count()) > 0) await expect(tomorrow).toBeDisabled();
    await shot(page, testInfo, "day-date-open");

    // Another day of the same month: the 1st, or the 2nd when the open day
    // is the 1st itself.
    const first = `${day.slice(0, 8)}01`;
    const target = first === day ? isoDaysAgo(4) : first;
    const start = await page.evaluate(() => window.history.length);
    await picker.locator(`[data-date-key="${target}"]`).click();
    await expect(picker).toHaveCount(0);
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      target,
    );
    await expect(page).toHaveURL(new RegExp(`[?&]day=${target}`));
    // Like a step: no new history entry, and focus back on the date.
    expect(await page.evaluate(() => window.history.length)).toBe(start);
    await expect(date).toBeFocused();

    // The keyboard: Enter opens, Escape closes the calendar only.
    await page.keyboard.press("Enter");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(date).toBeFocused();

    // Today.
    await page.keyboard.press("Space");
    await expect(picker).toBeVisible();
    await picker.locator('[data-slot="day-date-today"]').click();
    await expect(picker).toHaveCount(0);
    await expect(panel(page).locator('[data-slot="day-next"]')).toBeDisabled();
  });

  test("a sheet closes for good and leaves no edge behind", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "chromium-desktop";
    // Below 1280 px the day is a sheet from the right; on a phone, from the
    // bottom. Neither collapses.
    if (desktop) await page.setViewportSize({ width: 1024, height: 800 });
    const day = isoDaysAgo(3);
    await page.goto(`/mood?day=${day}`);
    await expect(panel(page)).toHaveAttribute(
      "data-shell",
      desktop ? "sheet" : "bottom",
    );
    await expect(page.locator('[data-slot="day-close"]')).toHaveAttribute(
      "aria-label",
      "Close day",
    );
    await page.locator('[data-slot="day-close"]').click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/mood$/);
    await expect(page.locator('[data-slot="day-rail"]')).toHaveCount(0);
  });

  test("a future or malformed ?day= is dropped without a word", async ({
    page,
  }) => {
    await page.goto("/mood?day=2999-01-01");
    await expect(page).toHaveURL(/\/mood$/);
    await expect(panel(page)).toHaveCount(0);
    await page.goto("/mood?day=2026-02-30");
    await expect(page).toHaveURL(/\/mood$/);
    await expect(panel(page)).toHaveCount(0);
  });

  test("stepping between days never adds a history entry", async ({ page }) => {
    await page.goto("/mood");
    await page.locator('[data-slot="day-link"]:visible').first().click();
    await expect(panel(page)).toBeVisible();
    const start = await page.evaluate(() => window.history.length);
    const first = await page
      .locator('[data-slot="day-view"]')
      .getAttribute("data-day");
    for (let i = 0; i < 3; i += 1) {
      await page.locator('[data-slot="day-prev"]').click();
    }
    await expect(page.locator('[data-slot="day-view"]')).not.toHaveAttribute(
      "data-day",
      first!,
    );
    expect(await page.evaluate(() => window.history.length)).toBe(start);
    // One Back leaves the layer, however far it stepped.
    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/mood$/);
  });

  test("on a phone the first tap shows the value, the second opens the day", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "touch only");
    await page.goto("/insights/blood-pressure");
    const plot = page.locator(
      '[data-slot="chart-plot"][data-day-links="true"]',
    );
    await plot.scrollIntoViewIfNeeded();
    await expect(plot).toBeVisible();
    const box = (await plot.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.8, box.y + box.height / 2);
    const open = page.locator('[data-slot="chart-tooltip-open-day"]');
    await expect(open).toBeVisible();
    // A tap alone never opens a sheet.
    await expect(panel(page)).toHaveCount(0);
    await open.tap();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute("data-shell", "bottom");
    // The tapped value heads the day.
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
  });

  test("the dashboard's today area offers no day door", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator('[data-slot="main-content-wrapper"]'),
    ).toBeVisible();
    // The hero is today: nothing in it opens another day. (The charts
    // further down do; `day-doors.spec.ts` walks one.)
    await expect(
      page.locator('[data-slot^="today-hero"]').first(),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-slot^="today-hero"] [data-slot="day-link"], [data-slot^="today-hero"] [data-day-links="true"]',
      ),
    ).toHaveCount(0);
  });
});
