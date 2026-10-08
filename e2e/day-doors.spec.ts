import type { Locator, Page, TestInfo } from "@playwright/test";

import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import { DAY_DOORS_ANALYTE } from "./setup/day-doors-fixture";
import { mockDay } from "./setup/day-mock";
import {
  DAY_DOORS_STORAGE_STATE_PATH,
  MOBILE_ROUTES_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { expect, test } from "./setup/test";

/**
 * v1.42 — every chart drawn in days opens its days, the same way.
 *
 * The day view first reached six metric pages; the recovery page beside them
 * offered no day at all. These journeys walk the surfaces that came after,
 * each through the same doors: on a fine pointer a click on a point (or a
 * calendar cell) opens the day beside the page; on a touch screen the first
 * tap shows the value and the tooltip's "View the whole day" opens it as a
 * bottom sheet, the tapped value on top. A date in a list opens in one tap.
 * The dashed line (or outline) marks the open day, the row of dots and the
 * caption sit under every chart, and the data table's dates are the
 * keyboard way to the same days.
 *
 *   - recovery (the page the beta reported), sleep, a lab marker, a chart
 *     with its comparison period on and a dashboard chart: line charts;
 *   - the mood calendar: a heatmap;
 *   - a metric's "all values" list: a date in a row.
 *
 * The day itself is a route mock in the contract's shape, as in
 * `day-view.spec.ts`: these journeys pin the client's doors, not the day.
 * Stable data attributes only.
 */

const panel = (page: Page) => page.locator('[data-slot="day-panel"]');
const isPhone = (testInfo: TestInfo) =>
  testInfo.project.name === "chromium-mobile";

/** Open the day of the point at 80 % across a day-linked plot. */
async function openFromPlot(page: Page, plot: Locator, testInfo: TestInfo) {
  await plot.scrollIntoViewIfNeeded();
  await expect(plot).toHaveAttribute("data-day-links", "true");
  const box = (await plot.boundingBox())!;
  const x = box.x + box.width * 0.8;
  const y = box.y + box.height / 2;
  if (isPhone(testInfo)) {
    await page.touchscreen.tap(x, y);
    const open = page.locator('[data-slot="chart-tooltip-open-day"]:visible');
    await expect(open).toBeVisible();
    // A tap alone never opens a sheet: a point is a small target.
    await expect(panel(page)).toHaveCount(0);
    // The button is a calm, full 44 px row.
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.tap();
    await expect(panel(page)).toHaveAttribute("data-shell", "bottom");
  } else {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await expect(panel(page)).toHaveAttribute("data-shell", "docked");
  }
  await expect(page).toHaveURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
  await expect(page.locator('[data-slot="day-view"]')).toBeVisible();
}

test.describe("every chart drawn in days opens its days", () => {
  test.use({ storageState: DAY_DOORS_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page, context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
    await mockDay(page, { index: "full" });
  });

  test("recovery: a point opens its day, and the open day is marked", async ({
    page,
  }, testInfo) => {
    if (!isPhone(testInfo)) {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.goto("/insights/recovery");
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await expect(plot).toBeVisible();
    // Under the chart: the caption and the row of day dots, which draws the
    // days the index names, one of them ringed as notable.
    const rug = page.locator('[data-slot="day-rug"]').first();
    await expect(
      page.locator('[data-slot="chart-day-caption"]').first(),
    ).toBeVisible();
    await expect(rug.locator("[data-day]").first()).toBeAttached();
    await expect(rug.locator('[data-notable="true"]')).toHaveCount(1);

    await openFromPlot(page, plot, testInfo);
    const day = await page
      .locator('[data-slot="day-view"]')
      .getAttribute("data-day");
    // The value the person came from heads the day.
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
    // The open day's dot is the filled one.
    await expect(rug.locator(`[data-day="${day}"]`)).toHaveAttribute(
      "data-open",
      "true",
    );
  });

  test("recovery: the data table's dates are the keyboard way to a day", async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), "keyboard path");
    await page.goto("/insights/recovery");
    const toggle = page
      .locator('[data-slot="chart-data-table-toggle"]')
      .first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();
    await page.keyboard.press("Enter");
    const link = page
      .locator('[data-slot="chart-data-table-region"] [data-slot="day-link"]')
      .first();
    await link.focus();
    const day = await link.getAttribute("data-day");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day!,
    );
    // Escape closes the day and gives the keyboard back to the date.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
  });

  test("sleep: a night's point opens its day", async ({ page }, testInfo) => {
    await page.goto("/insights/sleep");
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await expect(plot).toBeVisible();
    await openFromPlot(page, plot, testInfo);
  });

  test("the mood calendar: a logged day's cell opens it", async ({
    page,
  }, testInfo) => {
    await page.goto("/insights/mood");
    // A logged, openable cell: it carries the pointer cursor.
    const cell = page.locator("rect.cursor-pointer[data-day]").last();
    await cell.scrollIntoViewIfNeeded();
    await expect(cell).toBeVisible();
    const day = await cell.getAttribute("data-day");
    if (isPhone(testInfo)) {
      await cell.tap();
      const open = page.locator(
        '[data-slot="heatmap-tooltip"] [data-slot="chart-tooltip-open-day"]',
      );
      await expect(open).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      await open.tap();
      await expect(panel(page)).toHaveAttribute("data-shell", "bottom");
    } else {
      await cell.click();
    }
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day!,
    );
    // The open day's cell is outlined.
    await expect(page.locator('[data-slot="heatmap-open-day"]')).toHaveCount(1);
  });

  test("a lab marker's reading opens the day it was taken", async ({
    page,
  }, testInfo) => {
    await page.goto("/labs");
    await page
      .locator('[data-slot="lab-list-analyte"]')
      .filter({ hasText: DAY_DOORS_ANALYTE })
      .first()
      .click();
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await expect(plot).toBeVisible();
    await openFromPlot(page, plot, testInfo);
    // The reading on top, with the one before it beside it.
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
  });

  test("a chart with its comparison period on still opens its days", async ({
    page,
  }, testInfo) => {
    await page.goto("/insights/weight");
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await expect(plot).toBeVisible();
    await page
      .locator('[data-slot="chart-overlay-controls-trigger"]')
      .first()
      .click();
    await page
      .locator('[data-slot="chart-overlay-comparison-lastMonth"]')
      .click();
    await page.keyboard.press("Escape");
    // The overlay menu is closed before the chart is touched, so the tap
    // lands on the chart and not on the menu's outside-dismiss.
    await expect(
      page.locator('[data-slot="chart-overlay-controls-content"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-slot="chart-compare-caption"]').first(),
    ).toBeAttached();
    await openFromPlot(page, plot, testInfo);
    await expect(page.locator('[data-slot="day-focus"]')).toBeVisible();
  });
});

test.describe("the dashboard and the list of all values", () => {
  test.use({ storageState: DAY_DOORS_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page, context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
    await mockDay(page, { index: "full" });
  });

  test("a dashboard chart opens its day; the today hero offers none", async ({
    page,
  }, testInfo) => {
    if (!isPhone(testInfo)) {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.goto("/");
    await expect(
      page.locator(
        '[data-slot^="today-hero"] [data-slot="day-link"], [data-slot^="today-hero"] [data-day-links="true"]',
      ),
    ).toHaveCount(0);
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await expect(plot).toBeVisible({ timeout: 20_000 });
    await openFromPlot(page, plot, testInfo);
    // Closing leaves the dashboard on today.
    await page.locator('[data-slot="day-close"]').click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test("a date in a metric's list of all values opens its day", async ({
    page,
  }, testInfo) => {
    await page.goto("/insights/values/WEIGHT");
    const link = page.locator('[data-slot="day-link"]:visible').first();
    await expect(link).toBeVisible();
    const day = await link.getAttribute("data-day");
    if (isPhone(testInfo)) await link.tap();
    else await link.click();
    await expect(page.locator('[data-slot="day-view"]')).toHaveAttribute(
      "data-day",
      day!,
    );
  });

  test("the docked day moves the Coach button off its footer", async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), "docked from 1280 px");
    await page.setViewportSize({ width: 1440, height: 900 });
    // The launcher follows the `coach` capability, which needs a provider
    // the suite cannot reach, so the capability reads available here; this
    // journey is about where the button sits, not what it opens.
    await serveAiBlock(page, aiBlockAvailable());
    await page.goto("/insights/weight");
    const fab = page.locator('[data-slot="coach-fab"]');
    await expect(fab).toBeVisible();
    const plot = page
      .locator('[data-slot="chart-plot"][data-day-links="true"]')
      .first();
    await openFromPlot(page, plot, testInfo);
    const panelBox = (await panel(page).boundingBox())!;
    // Wait out the 150 ms move, then the launcher sits left of the column.
    await expect
      .poll(async () => {
        const b = (await fab.boundingBox())!;
        return b.x + b.width;
      })
      .toBeLessThanOrEqual(panelBox.x);
  });
});

test.describe("the readiness link into a medication's edit form", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test("?edit=1 opens the medication's edit form and leaves the URL", async ({
    page,
  }) => {
    const res = await page.request.get("/api/medications");
    const body = (await res.json()) as {
      data: Array<{ id: string }> | { medications?: Array<{ id: string }> };
    };
    const list = Array.isArray(body.data)
      ? body.data
      : (body.data.medications ?? []);
    expect(list.length).toBeGreaterThan(0);
    await page.goto(`/medications/${list[0]!.id}?edit=1`);
    await expect(page.getByRole("dialog")).toBeVisible();
    // A reload after closing the form must not open it again.
    await expect(page).not.toHaveURL(/[?&]edit=1/);
  });
});
