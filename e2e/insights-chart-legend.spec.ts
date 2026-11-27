import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * A metric chart's controls and legend, on the blood pressure page.
 *
 * The record is the phone-sweep account `globalSetup` seeds (a week of blood
 * pressure). The context around the readings (`GET /api/insights/context`) is
 * a route mock in the contract's shape: an illness over the last three days
 * and a dose change two days ago, so both sit inside the drawn days whatever
 * the range.
 *
 *   - the part-of-day choice sits in the time-of-day card's header, its four
 *     segments on one row, and no caption names it; the chart header keeps
 *     the range tabs;
 *   - the context is named in the legend row beside the series, at the same
 *     height, and an item opens its dates;
 *   - nothing about the context sits on a row of its own under the plot;
 *   - the chart card has no axe violations in either theme.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function dayKey(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function mockContext(page: Page) {
  await page.route(/\/api\/insights\/context(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          today: dayKey(0),
          medications: [
            {
              id: "m1",
              medicationId: "med-1",
              kind: "doseChange",
              date: dayKey(2),
              estimated: false,
              name: "Ramipril",
              dose: "10 mg",
              href: "/medications/med-1",
            },
          ],
          illnesses: [
            {
              id: "ill-1",
              start: dayKey(3),
              end: dayKey(1),
              label: "Stomach bug",
              href: "/illness/ill-1",
            },
          ],
          cyclePhases: [],
        },
        error: null,
      }),
    }),
  );
}

test.describe("metric chart legend and controls", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  for (const theme of ["light", "dark"] as const) {
    test(`blood pressure: controls top right, context in the legend (${theme})`, async ({
      page,
      context,
    }, testInfo) => {
      const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
      await context.addCookies([
        { name: "healthlog-locale", value: "en", url: baseURL },
      ]);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((th) => {
        try {
          localStorage.setItem("healthlog-theme", th);
        } catch {}
      }, theme);
      await mockContext(page);
      await page.goto("/insights/blood-pressure");

      // The part-of-day choice sits in the time-of-day card's header, not in
      // the chart's: the chart header keeps the range tabs and its settings.
      const controls = page.locator('[data-slot="chart-header-controls"]');
      await expect(
        controls.locator('[data-slot="chart-range-tab"]').first(),
      ).toBeVisible();
      await expect(
        controls.getByRole("radiogroup", { name: "Show in the chart" }),
      ).toHaveCount(0);
      const card = page.locator('[data-slot="bp-time-of-day"]');
      const partOfDay = card.getByRole("radiogroup", {
        name: "Show in the chart",
      });
      await expect(partOfDay).toBeVisible();
      // Its four segments stand on one row, at every width.
      const tops = await partOfDay
        .getByRole("radio")
        .evaluateAll((els) =>
          els.map((el) => Math.round(el.getBoundingClientRect().top)),
        );
      expect(tops).toHaveLength(4);
      expect(new Set(tops).size).toBe(1);
      // The caption is gone from the page; the group keeps its name.
      await expect(page.getByText("Show in the chart")).toHaveCount(0);

      const legend = page.locator('[data-slot="chart-legend"]');
      await expect(legend).toBeVisible();
      const series = legend.locator('[data-slot="chart-legend-series"]');
      await expect(series).toHaveCount(2);
      const illness = legend.locator(
        '[data-slot="chart-context-mark"][data-kind="illness"]',
      );
      await expect(illness).toContainText("Stomach bug");
      await expect(
        legend.locator(
          '[data-slot="chart-context-mark"][data-kind="medication"]',
        ),
      ).toContainText("Ramipril");
      // Same height as a series item.
      const [seriesBox, illnessBox] = await Promise.all([
        series.first().boundingBox(),
        illness.boundingBox(),
      ]);
      expect(Math.round(illnessBox!.height)).toBe(
        Math.round(seriesBox!.height),
      );
      await expect(page.locator('[data-slot="chart-context"]')).toHaveCount(0);

      await illness.click();
      await expect(
        page.locator('[data-slot="chart-context-popover"]'),
      ).toContainText("Stomach bug");
      await page.keyboard.press("Escape");

      const results = await new AxeBuilder({ page })
        .include('[data-slot="chart-header-controls"]')
        .include('[data-slot="bp-time-of-day"]')
        .include('[data-slot="chart-legend"]')
        .withTags(WCAG)
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }
});
