import type { Page, Route } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * A saved conversation opens at its last answer, and stays there after that
 * answer's chart arrives.
 *
 * Before: on a wide screen the thread opened at the top (scroll 0), and on a
 * phone it stopped about 70 px short of the end, because the answer's chart
 * loaded after the jump. The conversation here is long enough to scroll on
 * both widths, and the stored table under the last answer is served late on
 * purpose, so the end moves after the thread first paints.
 */

const CONVERSATION_ID = "coach-open-at-end-e2e";
const LAST_ID = "coach-open-at-end-last";

const TABLE = {
  ref: "r1",
  source: {
    tool: "get_metric_table",
    domain: "pulse",
    window: "last30days",
    period: "current",
    granularity: "day",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.byDay",
  title: "Pulse by day",
  rowCount: 14,
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
      key: "pulse",
      kind: "number",
      labelKey: "coach.result.column.value",
      label: "Pulse",
      unit: "bpm",
      decimals: 0,
    },
  ],
  rows: Array.from({ length: 14 }, (_, i) => [
    new Date(Date.UTC(2026, 8, 10 + i)).toISOString().slice(0, 10),
    60 + (i % 5),
  ]),
  truncated: false,
  chart: { kind: "line", x: "day", series: ["pulse"] },
};

const PARAGRAPH =
  "Your resting pulse held steady across the fortnight, with the usual small dip after the longer nights and a slight rise on the two days you logged a cold.";

function messages() {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i += 1) {
    const at = `2026-09-24T09:${String(i * 2).padStart(2, "0")}:00.000Z`;
    out.push({
      id: `u-${i}`,
      role: "user",
      content: `Question ${i + 1}: how did my pulse look?`,
      createdAt: at,
      metricSource: null,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    });
    const last = i === 7;
    out.push({
      id: last ? LAST_ID : `a-${i}`,
      role: "assistant",
      content: `${PARAGRAPH} ${PARAGRAPH}`,
      createdAt: at,
      metricSource: last
        ? {
            windows: ["last30days"],
            metrics: ["pulse"],
            results: [
              {
                ref: TABLE.ref,
                source: TABLE.source,
                shape: TABLE.shape,
                titleKey: TABLE.titleKey,
                title: TABLE.title,
                rowCount: TABLE.rowCount,
                chartKind: TABLE.chartKind,
                displayed: TABLE.displayed,
              },
            ],
          }
        : null,
      providerType: "mock",
      promptVersion: "e2e",
      tokensUsed: 42,
      model: "mock",
    });
  }
  return out;
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
        `/api/insights/chat/${CONVERSATION_ID}/messages/${LAST_ID}/results`
      ) {
        // Late on purpose: the chart lands after the thread has painted.
        await new Promise((resolve) => setTimeout(resolve, 900));
        return fulfilJson(route, { results: [TABLE] });
      }
      if (url.pathname.startsWith(`/api/insights/chat/${CONVERSATION_ID}/`)) {
        return fulfilJson(route, { results: [] });
      }
      if (url.pathname === `/api/insights/chat/${CONVERSATION_ID}`) {
        return fulfilJson(route, {
          id: CONVERSATION_ID,
          title: "Pulse over two weeks",
          createdAt: "2026-09-24T09:00:00.000Z",
          updatedAt: "2026-09-24T09:14:00.000Z",
          messageCount: 16,
          fenced: false,
          attachments: [],
          documentTitle: null,
          attachmentCount: 0,
          summary: null,
          messages: messages(),
        });
      }
      return fulfilJson(route, { conversations: [], nextCursor: null });
    },
  );
  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
}

/** Distance from the thread's current view to its end, in px. */
async function distanceFromEnd(page: Page): Promise<number> {
  return page
    .locator('[data-slot="coach-message-thread"]')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test.describe("Coach: a saved conversation opens at its end", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await serveAiBlock(page, aiBlockAvailable());
    await mockConversation(page);
  });

  for (const width of [390, 1440] as const) {
    test(`at ${width} px it lands on the last answer and stays after its chart loads`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 900,
      });
      await page.goto(`/coach?c=${CONVERSATION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const thread = page.locator('[data-slot="coach-message-thread"]');
      await expect(thread).toBeVisible({ timeout: 15_000 });
      // The thread scrolls at all: otherwise "at the end" proves nothing.
      expect(
        await thread.evaluate((el) => el.scrollHeight > el.clientHeight + 200),
      ).toBe(true);

      const chart = page.locator(
        '[data-slot="coach-result-chart"][data-ref="r1"]',
      );
      await expect(chart).toBeVisible({ timeout: 15_000 });
      // The chart grew the thread after the first jump; the view followed.
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(2);
      await expect(
        page.locator(`[data-slot="coach-assistant-turn"]`).last(),
      ).toBeInViewport();
    });
  }
});
