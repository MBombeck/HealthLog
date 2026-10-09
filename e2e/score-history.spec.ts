import type { Page, Route } from "@playwright/test";

import { mockDay } from "./setup/day-mock";
import { mockPopulatedInsights } from "./utils/mock-populated-insights";
import { SCORE_HISTORY_STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";
import type { DailyDigest } from "@/lib/daily/digest";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

/**
 * v1.42 — the score histories and the dashboard's top card switch.
 *
 *   - The health score's page charts its daily course with the range tabs
 *     every chart offers; a tab asks the server for its window, the choice
 *     survives a reload, and a point opens its day.
 *   - Readiness, recovery, the sleep score and strain carry the same four
 *     tabs in the same component.
 *   - The top card goes away when the layout settings switch it off, and
 *     comes back when they switch it on.
 *
 * The score history and the derived scores are route mocks in the
 * contract's shape (the server's answers are pinned by the integration
 * suite); the range preference and the layout are this account's own, saved
 * for real. Stable data attributes only.
 */

test.use({ storageState: SCORE_HISTORY_STORAGE_STATE_PATH });
// Every test writes this one account's layout blob, a Serializable
// read-modify-write; run in parallel they would abort each other's write.
test.describe.configure({ mode: "serial" });

const RANGES = ["7", "30", "90", "0"];

function dayKey(offset: number): string {
  const now = new Date();
  const local = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
  );
  local.setDate(local.getDate() + offset);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Answer the score history with one point per day of the window, max 40. */
async function mockScoreHistory(page: Page): Promise<number[]> {
  const asked: number[] = [];
  await page.route(/\/api\/insights\/score-history\?/, (route: Route) => {
    const url = new URL(route.request().url());
    const days = Number(url.searchParams.get("days"));
    asked.push(days);
    const count = Math.min(days, 40);
    const points = Array.from({ length: count }, (_, i) => ({
      day: dayKey(i - count + 1),
      value: 60 + ((i * 7) % 25),
      seamBreak: false,
    }));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          score: url.searchParams.get("score"),
          days,
          points,
          band: { lo: 64, hi: 76, n: 30 },
        },
        error: null,
      }),
    });
  });
  return asked;
}

/** An `ok` derived score, so the score page draws its history under it. */
async function mockDerived(page: Page) {
  await page.route(/\/api\/insights\/derived\?/, (route: Route) => {
    const metric = new URL(route.request().url()).searchParams.get("metric");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          metric,
          status: "ok",
          value: {
            score: 72,
            band: "green",
            components: [],
            subScores: [],
            night: dayKey(0),
            asleepMinutes: 420,
            inBedMinutes: 450,
            windowNights: 20,
          },
          coverage: {
            requiredInputs: 1,
            presentInputs: 1,
            historyDays: 30,
            missing: [],
          },
          confidence: "high",
          provenance: {
            inputs: [],
            source: "rollup",
            windowDays: 30,
            computedAt: new Date().toISOString(),
          },
          reason: null,
          assessment: null,
        },
        error: null,
      }),
    });
  });
}

async function resetRange(page: Page, chartKey: string) {
  const res = await page.request.put("/api/dashboard/chart-overlay-prefs", {
    data: {
      chartKey,
      prefs: {
        showTrendIndicator: false,
        showTrendArrow: false,
        showTargetRange: false,
        comparisonBaseline: "none",
        rangePoints: 30,
      },
    },
  });
  expect(res.status()).toBe(200);
}

async function expectSharedTabs(page: Page, chart: string, pressed: string) {
  const tabs = page.locator(`${chart} [data-slot="chart-range-tab"]`);
  await expect(tabs).toHaveCount(4);
  expect(
    await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-range")),
    ),
  ).toEqual(RANGES);
  await expect(
    page.locator(`${chart} [data-slot="chart-range-tab"][aria-pressed="true"]`),
  ).toHaveAttribute("data-range", pressed);
}

test.describe("score histories", () => {
  test.beforeEach(async ({ page, context }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "en", url: baseURL },
    ]);
    await mockDay(page, { index: "full" });
  });

  test("the health score's range tabs switch the window and are remembered", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await resetRange(page, "scoreHealth");
    const asked = await mockScoreHistory(page);

    await page.goto("/insights/health-score");
    const chart = page.locator('[data-slot="score-trend-chart"]');
    await expect(chart).toHaveAttribute("data-score", "HEALTH_SCORE");
    await expectSharedTabs(page, '[data-slot="score-trend-chart"]', "30");
    await expect(chart.locator('[data-slot="chart-plot"]')).toBeVisible();
    await expect(chart.locator('[data-slot="score-trend-band"]')).toBeVisible();
    expect(asked).toContain(30);

    await chart
      .locator('[data-slot="chart-range-tab"][data-range="7"]')
      .click();
    await expect(chart).toHaveAttribute("data-range", "7");
    await expect.poll(() => asked.at(-1)).toBe(7);
    // The table lists exactly the window's days.
    await chart.locator('[data-slot="chart-data-table-toggle"]').click();
    await expect(
      chart.locator('[data-slot="chart-data-table-row"]'),
    ).toHaveCount(7);

    // Remembered: a reload opens on seven days again.
    await page.reload();
    await expect(chart).toHaveAttribute("data-range", "7");

    await chart
      .locator('[data-slot="chart-range-tab"][data-range="0"]')
      .click();
    await expect(chart).toHaveAttribute("data-range", "0");
    await expect.poll(() => asked.at(-1)).toBe(3650);

    // A point opens its day beside the page.
    const plot = chart.locator('[data-slot="chart-plot"]');
    await expect(plot).toHaveAttribute("data-day-links", "true");
    const box = (await plot.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await expect(page.locator('[data-slot="day-panel"]')).toHaveAttribute(
      "data-shell",
      "docked",
    );
    await expect(page).toHaveURL(/[?&]day=\d{4}-\d{2}-\d{2}/);

    await resetRange(page, "scoreHealth");
  });

  test("the score panel leads to the health score page and back", async ({
    page,
  }) => {
    await mockPopulatedInsights(page);
    await mockScoreHistory(page);
    await page.goto("/insights");
    const link = page.locator('[data-slot="health-score-history-link"]');
    await expect(link).toHaveAttribute("href", "/insights/health-score");
    await link.click();
    await expect(page).toHaveURL(/\/insights\/health-score$/);
    await expect(
      page.locator('[data-slot="health-score-back"]'),
    ).toHaveAttribute("href", "/insights");
  });

  test("readiness and the sleep score offer the same tabs, and switching asks for the window", async ({
    page,
  }) => {
    await resetRange(page, "scoreReadiness");
    await mockDerived(page);
    const asked = await mockScoreHistory(page);

    await page.goto("/insights/scores/readiness");
    const chart = page.locator('[data-slot="score-trend-chart"]');
    await expect(chart).toHaveAttribute("data-score", "READINESS");
    await expectSharedTabs(page, '[data-slot="score-trend-chart"]', "30");
    await chart
      .locator('[data-slot="chart-range-tab"][data-range="90"]')
      .click();
    await expect(chart).toHaveAttribute("data-range", "90");
    await expect.poll(() => asked.at(-1)).toBe(90);
    await resetRange(page, "scoreReadiness");

    await page.goto("/insights/scores/sleep");
    await expect(
      page.locator('[data-slot="score-trend-chart"]'),
    ).toHaveAttribute("data-score", "SLEEP_SCORE");
    await expectSharedTabs(page, '[data-slot="score-trend-chart"]', "30");
  });

  test("recovery and strain carry the same tabs on their stored-score chart", async ({
    page,
  }) => {
    await resetRange(page, "scoreRecovery");
    await mockDerived(page);

    await page.goto("/insights/scores/recovery");
    const chart = '[data-slot="score-history-chart"]';
    await expect(page.locator(chart)).toHaveAttribute(
      "data-type",
      "RECOVERY_SCORE",
    );
    await expectSharedTabs(page, chart, "30");
    // A score history remembers its range, and mounts no overlay dropdown.
    await expect(
      page.locator(`${chart} [data-slot="chart-overlay-controls-trigger"]`),
    ).toHaveCount(0);
    await page
      .locator(`${chart} [data-slot="chart-range-tab"][data-range="7"]`)
      .click();
    await expectSharedTabs(page, chart, "7");
    await page.reload();
    await expectSharedTabs(page, chart, "7");
    await resetRange(page, "scoreRecovery");

    await page.goto("/insights/scores/strain");
    await expectSharedTabs(page, chart, "30");
  });
});

const DIGEST: DailyDigest = {
  generatedAt: new Date().toISOString(),
  ai: DIGEST_AI_AVAILABLE,
  phase: "final",
  sleepPending: false,
  score: {
    value: 82,
    band: "green",
    delta: null,
    deltaReason: "first_eligibility_window",
    steadyWeeks: 2,
  },
  topSignal: null,
  signalLine: null,
  briefingLead: null,
  lead: null,
  today: [],
  restMode: null,
  line: "Your health score today is 82.",
  worthALook: [],
  justIn: null,
  reactionLine: null,
};

test.describe("the dashboard's top card", () => {
  test.afterEach(async ({ page }) => {
    // Leave the account's layout at its defaults for the next run.
    await page.request.delete("/api/dashboard/widgets");
  });

  test("switches off and on from the layout settings", async ({ page }) => {
    await page.request.delete("/api/dashboard/widgets");
    await page.route(/\/api\/daily\/digest(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: DIGEST, error: null }),
      }),
    );

    const hero = page.locator('[data-slot="today-hero"]');
    await page.goto("/");
    await expect(hero.first()).toBeVisible();

    async function flip(expected: "checked" | "unchecked") {
      await page.goto("/settings/layout/dashboard");
      const toggle = page.locator('[data-slot="today-card-switch"]');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute("data-state", expected);
      const saved = page.waitForResponse(
        (res) =>
          res.url().includes("/api/dashboard/widgets") &&
          res.request().method() === "PUT",
      );
      await page
        .locator('[data-slot="settings-dashboard-layout-save"]')
        .click();
      const response = await saved;
      expect(response.status()).toBe(200);
      const body = response.request().postDataJSON() as {
        todayCardVisible?: boolean;
      };
      expect(body.todayCardVisible).toBe(expected === "checked");
    }

    await flip("unchecked");
    await page.goto("/");
    await expect(page.locator("main").first()).toBeVisible();
    await expect(hero).toHaveCount(0);
    await expect(page.locator('[data-slot="today-hero-skeleton"]')).toHaveCount(
      0,
    );

    // A phone width shows no card either.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(hero).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await flip("checked");
    await page.goto("/");
    await expect(hero.first()).toBeVisible();
  });
});
