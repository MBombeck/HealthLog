import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * The tables and charts under a Coach answer, on a persisted conversation.
 *
 * Contracts under test:
 *
 *   1. A table the answer referenced opens under the prose as its chart: a
 *      figure whose plot is one image named after the table, pointing at
 *      the table view for every value.
 *   2. The chart/table toggle switches to the captioned table and back; the
 *      pressed segment follows.
 *   3. Two series (blood pressure) carry legend buttons that hide and show
 *      a series; the last visible one stays.
 *   4. A table the answer only used sits in the evidence disclosure under
 *      "Data used (1)", opening as a table, with its chart one tap away.
 *   5. axe finds nothing on either view, in the light and the dark theme.
 *
 * The conversation, its stored tables and the Coach side surfaces are
 * mocked; the charts are drawn by the real chart runtime.
 */

const CONVERSATION_ID = "coach-results-e2e";
const MESSAGE_ID = "coach-results-e2e-assistant";

const BP_VALUES: Array<[number, number] | null> = [
  [128, 84],
  [125, 82],
  null,
  [131, 85],
  [122, 80],
  [124, 81],
  null,
  [127, 83],
  [121, 79],
  [126, 82],
  [123, 80],
  [129, 84],
  [120, 78],
  [124, 81],
];

function dayKey(index: number): string {
  return new Date(Date.UTC(2026, 8, 10 + index)).toISOString().slice(0, 10);
}

const BP_TABLE = {
  ref: "r1",
  source: {
    tool: "get_metric_table",
    domain: "bp",
    window: "last30days",
    period: "current",
    granularity: "day",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.byDay",
  title: "Blood pressure by day",
  rowCount: BP_VALUES.length,
  chartKind: "line",
  displayed: true,
  columns: [
    {
      key: "day",
      kind: "period",
      labelKey: "coach.result.column.day",
      label: "Day",
    },
    {
      key: "systolic",
      kind: "number",
      labelKey: "coach.result.column.systolic",
      label: "Systolic",
      unit: "mmHg",
      decimals: 0,
    },
    {
      key: "diastolic",
      kind: "number",
      labelKey: "coach.result.column.diastolic",
      label: "Diastolic",
      unit: "mmHg",
      decimals: 0,
    },
    {
      key: "readings",
      kind: "count",
      labelKey: "coach.result.column.readings",
      label: "Readings",
    },
  ],
  rows: BP_VALUES.map((pair, index) =>
    pair
      ? [dayKey(index), pair[0], pair[1], 1]
      : [dayKey(index), null, null, null],
  ),
  truncated: false,
  chart: { kind: "line", x: "day", series: ["systolic", "diastolic"] },
};

const SPORTS: Array<[string, number]> = [
  ["Walking", 12],
  ["Cycling", 7],
  ["Running", 5],
  ["Swimming", 3],
  ["Yoga", 3],
  ["Hiking", 2],
  ["Rowing", 1],
];

const WORKOUT_TABLE = {
  ref: "r2",
  source: {
    tool: "get_workouts",
    domain: "workouts",
    window: "last30days",
    period: "current",
  },
  shape: "categoryCounts",
  titleKey: "coach.result.title.workoutsBySport",
  title: "Workouts by sport",
  rowCount: SPORTS.length,
  chartKind: "bar",
  displayed: false,
  columns: [
    {
      key: "sport",
      kind: "category",
      labelKey: "coach.result.column.sport",
      label: "Sport",
    },
    {
      key: "sessions",
      kind: "count",
      labelKey: "coach.result.column.sessions",
      label: "Sessions",
    },
    {
      key: "duration",
      kind: "number",
      labelKey: "coach.result.column.duration",
      label: "Duration",
      unit: "min",
      decimals: 0,
    },
  ],
  rows: SPORTS.map(([sport, count]) => [sport, count, count * 35]),
  truncated: false,
  chart: {
    kind: "bar",
    x: "sport",
    series: ["sessions"],
    orientation: "horizontal",
  },
};

function meta(table: typeof BP_TABLE | typeof WORKOUT_TABLE) {
  return {
    ref: table.ref,
    source: table.source,
    shape: table.shape,
    titleKey: table.titleKey,
    title: table.title,
    rowCount: table.rowCount,
    chartKind: table.chartKind,
    displayed: table.displayed,
  };
}

function fulfilJson(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

async function mockConversation(page: Page) {
  await page.route(
    /\/api\/insights\/chat(?:\/[^?]+)?(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      if (
        url.pathname ===
        `/api/insights/chat/${CONVERSATION_ID}/messages/${MESSAGE_ID}/results`
      ) {
        return fulfilJson(route, { results: [BP_TABLE, WORKOUT_TABLE] });
      }
      if (url.pathname === `/api/insights/chat/${CONVERSATION_ID}`) {
        return fulfilJson(route, {
          id: CONVERSATION_ID,
          title: "Blood pressure and workouts",
          createdAt: "2026-09-24T09:00:00.000Z",
          updatedAt: "2026-09-24T09:01:00.000Z",
          messageCount: 2,
          fenced: false,
          attachments: [],
          documentTitle: null,
          attachmentCount: 0,
          summary: null,
          messages: [
            {
              id: "coach-results-e2e-user",
              role: "user",
              content: "How was my blood pressure this month?",
              createdAt: "2026-09-24T09:00:00.000Z",
              metricSource: null,
              providerType: null,
              promptVersion: null,
              tokensUsed: null,
              model: null,
            },
            {
              id: MESSAGE_ID,
              role: "assistant",
              content:
                "Your readings stayed in a narrow band this month; the table below lists each day.",
              createdAt: "2026-09-24T09:01:00.000Z",
              metricSource: {
                windows: ["last30days"],
                metrics: ["bp", "workouts"],
                results: [meta(BP_TABLE), meta(WORKOUT_TABLE)],
              },
              providerType: "mock",
              promptVersion: "e2e",
              tokensUsed: 42,
              model: "mock",
            },
          ],
        });
      }
      return fulfilJson(route, {
        conversations: [
          {
            id: CONVERSATION_ID,
            title: "Blood pressure and workouts",
            createdAt: "2026-09-24T09:00:00.000Z",
            updatedAt: "2026-09-24T09:01:00.000Z",
            messageCount: 2,
            fenced: false,
            attachments: [],
            documentTitle: null,
          },
        ],
        nextCursor: null,
      });
    },
  );
  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
}

async function useTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value: string) => {
    window.localStorage.setItem("healthlog-theme", value);
  }, theme);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .include('[data-slot="coach-bubble-assistant"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
    `${label} accessibility violations`,
  ).toEqual([]);
}

test.describe("Coach result tables and charts", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await serveAiBlock(page, aiBlockAvailable());
    await mockConversation(page);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`theme=${theme}: chart first, table on toggle, data used in the steps list`, async ({
      page,
    }) => {
      await useTheme(page, theme);
      await page.goto(`/coach?c=${CONVERSATION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(^|\\s)${theme}(\\s|$)`),
      );

      const bubble = page.locator('[data-slot="coach-bubble-assistant"]');
      const figure = bubble.locator(
        '[data-slot="coach-result-chart"][data-ref="r1"]',
      );
      await expect(figure).toBeVisible({ timeout: 15_000 });
      await expect(figure).toHaveAttribute("data-chart-kind", "line");
      const plot = figure.getByRole("img", {
        name: "Blood pressure by day, shown as a chart. The table view lists every value.",
      });
      await expect(plot).toBeVisible();
      await expect(plot.locator(".recharts-line")).toHaveCount(2);

      // Legend buttons hide one series; the last visible one stays.
      const systolic = figure.getByRole("button", { name: "Systolic" });
      const diastolic = figure.getByRole("button", { name: "Diastolic" });
      await expect(systolic).toHaveAttribute("aria-pressed", "true");
      await diastolic.click();
      await expect(diastolic).toHaveAttribute("aria-pressed", "false");
      await expect(plot.locator(".recharts-line")).toHaveCount(1);
      await systolic.click();
      await expect(systolic).toHaveAttribute("aria-pressed", "true");
      await diastolic.click();
      await expect(plot.locator(".recharts-line")).toHaveCount(2);

      await expectNoAxeViolations(page, `${theme} chart view`);

      // The toggle opens the captioned table and comes back.
      await figure.locator('[data-slot="coach-result-view-table"]').click();
      const table = bubble.locator(
        '[data-slot="coach-result-table"][data-ref="r1"]',
      );
      await expect(table).toBeVisible();
      await expect(table.locator("caption")).toContainText(
        "Blood pressure by day",
      );
      await expect(
        table.locator('[data-slot="coach-result-view-table"]'),
      ).toHaveAttribute("aria-pressed", "true");
      await expectNoAxeViolations(page, `${theme} table view`);
      await table.locator('[data-slot="coach-result-view-chart"]').click();
      await expect(figure).toBeVisible();

      // The table the answer only used waits in the open steps list.
      await expect(
        bubble.locator('[data-slot="coach-result-table"][data-ref="r2"]'),
      ).toBeHidden();
      const stepsToggle = bubble.locator(
        '[data-slot="coach-turn-steps-toggle"]',
      );
      await expect(stepsToggle).toHaveAttribute("aria-expanded", "false");
      await stepsToggle.click();
      const dataUsed = bubble.locator(
        '[data-slot="coach-turn-steps-panel"] [data-slot="coach-data-used"]',
      );
      await expect(dataUsed).toContainText("Data used (1)");
      const workouts = dataUsed.locator(
        '[data-slot="coach-result-table"][data-ref="r2"]',
      );
      await expect(workouts).toBeVisible();
      await workouts.locator('[data-slot="coach-result-view-chart"]').click();
      const workoutChart = dataUsed.locator(
        '[data-slot="coach-result-chart"][data-ref="r2"]',
      );
      await expect(workoutChart).toHaveAttribute("data-chart-kind", "bar");
      await expect(workoutChart.locator(".recharts-bar-rectangle")).toHaveCount(
        SPORTS.length,
      );

      await expectNoAxeViolations(page, `${theme} data used`);
    });
  }
});
