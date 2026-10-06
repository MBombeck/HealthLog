import AxeBuilder from "@axe-core/playwright";
import type { Page, Request, Route } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * The interactive Coach dialog, over three streamed turns.
 *
 * Contracts under test:
 *
 *   1. A sent message streams `step` frames; the steps list under the
 *      answer names each step, settled to `done` by id.
 *   2. A `result` frame's table opens as its chart, the chart/table toggle
 *      switches to the captioned table and back, and the table's copy menu
 *      puts the table on the clipboard.
 *   3. A follow-up chip under the latest reply sends its label with
 *      `followUp: { messageId, id }`.
 *   4. A reply that ends in a clarifying question offers its choices as
 *      reply pills under it and no chips (as the server sends it); there is
 *      no card. A choice sends its label with
 *      `clarification: { messageId, choiceId }`, and the pills leave once a
 *      plain answer is the latest reply.
 *   5. axe finds nothing on the answer, the chips and the reply pills, in
 *      the light and the dark theme.
 *
 * The chat POST is a stubbed event stream in the documented frame order,
 * and the conversation detail it refetches after `done` returns the same
 * turns as persisted messages. The charts are drawn by the real runtime.
 */

const CONVERSATION_ID = "coach-dialog-e2e";
const TITLE = "Blood pressure this month";

const FIRST_QUESTION = "How was my blood pressure this month?";
const FIRST_ANSWER =
  "Your blood pressure stayed in a steady band this month, with most days close to the same values.";
const SECOND_ANSWER =
  "The period before looked much the same. Which heart rate should I set beside it?";
const THIRD_ANSWER =
  "Your resting heart rate held steady over the same weeks, so nothing stands out beside your blood pressure.";

const BP_VALUES: Array<[number, number] | null> = [
  [128, 84],
  [125, 82],
  null,
  [131, 85],
  [122, 80],
  [124, 81],
  [127, 83],
  [121, 79],
  [126, 82],
  [123, 80],
];

function dayKey(index: number): string {
  return new Date(Date.UTC(2026, 8, 14 + index)).toISOString().slice(0, 10);
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

const BP_META = {
  ref: BP_TABLE.ref,
  source: BP_TABLE.source,
  shape: BP_TABLE.shape,
  titleKey: BP_TABLE.titleKey,
  title: BP_TABLE.title,
  rowCount: BP_TABLE.rowCount,
  chartKind: BP_TABLE.chartKind,
  displayed: BP_TABLE.displayed,
};

function step(
  id: string,
  status: "running" | "done",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    tool: "get_metric_table",
    labelKey: "coach.step.readWindow",
    label: "Checking: Blood pressure, last 30 days",
    domain: "bp",
    window: "last30days",
    status,
    ...extra,
  };
}

interface Turn {
  userId: string;
  userText: string;
  assistantId: string;
  answer: string;
  metricSource: Record<string, unknown>;
  frames: unknown[];
}

const TURN_ONE_STEPS = [
  step("s1", "done", { granularity: "day", count: 9, resultRef: "r1" }),
  step("s2", "done", { period: "previous", count: 11 }),
];
const TURN_ONE_FOLLOW_UPS = [
  {
    id: "f1",
    kind: "as_chart",
    labelKey: "coach.followUp.asChart",
    label: "Show as a chart",
    anchor: { ref: "r1", domain: "bp", window: "last30days" },
    reuse: true,
    origin: "server",
  },
  {
    id: "f2",
    kind: "previous_period",
    labelKey: "coach.followUp.previousPeriod",
    label: "Compare with the period before",
    anchor: {
      ref: "r1",
      domain: "bp",
      window: "last30days",
      period: "previous",
    },
    reuse: false,
    origin: "server",
  },
];
const TURN_ONE_METHOD = {
  entries: [
    {
      domain: "bp",
      window: "last30days",
      granularity: "day",
      count: 9,
      aggregation: "mean",
    },
  ],
  text: "Blood pressure, last 30 days, 9 readings, daily averages.",
};
const TURN_ONE_SOURCE = {
  windows: ["last30days"],
  metrics: ["bp"],
  counts: { bp: 9 },
  steps: TURN_ONE_STEPS,
  method: TURN_ONE_METHOD,
  results: [BP_META],
  followUps: TURN_ONE_FOLLOW_UPS,
};

const TURN_TWO_STEPS = [
  step("s1", "done", {
    label: "Checking: Blood pressure, last 30 days",
    period: "previous",
    count: 11,
  }),
];
const TURN_TWO_CLARIFICATION = {
  kind: "metric",
  choices: [
    {
      id: "c1",
      labelKey: "insights.coach.metric.pulse",
      label: "Pulse",
      value: { metric: "pulse" },
    },
    {
      id: "c2",
      labelKey: "insights.coach.metric.resting_hr",
      label: "Resting HR",
      value: { metric: "resting_hr" },
    },
  ],
  freeText: true,
};
const TURN_TWO_SOURCE = {
  windows: ["last30days"],
  metrics: ["bp"],
  counts: { bp: 11 },
  steps: TURN_TWO_STEPS,
  // A question offers no chips: its choices are the next step.
  clarification: TURN_TWO_CLARIFICATION,
};

const TURN_THREE_STEPS = [
  {
    id: "s1",
    tool: "get_metric_series",
    labelKey: "coach.step.readWindow",
    label: "Checking: Resting HR, last 30 days",
    domain: "resting_hr",
    window: "last30days",
    status: "done",
    count: 28,
  },
];
const TURN_THREE_SOURCE = {
  windows: ["last30days"],
  metrics: ["resting_hr"],
  counts: { resting_hr: 28 },
  steps: TURN_THREE_STEPS,
};

function tokens(text: string) {
  return text.split(/(?<= )/).map((token) => ({ type: "token", token }));
}

const TURNS: Turn[] = [
  {
    userId: "coach-dialog-e2e-u1",
    userText: FIRST_QUESTION,
    assistantId: "coach-dialog-e2e-a1",
    answer: FIRST_ANSWER,
    metricSource: TURN_ONE_SOURCE,
    frames: [
      { type: "step", step: step("s1", "running") },
      { type: "step", step: TURN_ONE_STEPS[0] },
      { type: "step", step: step("s2", "running", { period: "previous" }) },
      { type: "step", step: TURN_ONE_STEPS[1] },
      ...tokens(FIRST_ANSWER),
      { type: "provenance", metricSource: TURN_ONE_SOURCE },
      { type: "result", result: BP_TABLE },
      { type: "followUps", followUps: TURN_ONE_FOLLOW_UPS },
    ],
  },
  {
    userId: "coach-dialog-e2e-u2",
    userText: "Compare with the period before",
    assistantId: "coach-dialog-e2e-a2",
    answer: SECOND_ANSWER,
    metricSource: TURN_TWO_SOURCE,
    frames: [
      { type: "step", step: step("s1", "running", { period: "previous" }) },
      { type: "step", step: TURN_TWO_STEPS[0] },
      ...tokens(SECOND_ANSWER),
      { type: "provenance", metricSource: TURN_TWO_SOURCE },
      { type: "clarification", clarification: TURN_TWO_CLARIFICATION },
    ],
  },
  {
    userId: "coach-dialog-e2e-u3",
    userText: "Resting HR",
    assistantId: "coach-dialog-e2e-a3",
    answer: THIRD_ANSWER,
    metricSource: TURN_THREE_SOURCE,
    frames: [
      { type: "step", step: { ...TURN_THREE_STEPS[0], status: "running" } },
      { type: "step", step: TURN_THREE_STEPS[0] },
      ...tokens(THIRD_ANSWER),
      { type: "provenance", metricSource: TURN_THREE_SOURCE },
    ],
  },
];

function fulfilJson(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

function eventStream(turn: Turn): string {
  const frames = [
    ...turn.frames,
    {
      type: "done",
      conversationId: CONVERSATION_ID,
      messageId: turn.assistantId,
      usage: { totalTokens: 420 },
    },
  ];
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

function persisted(completed: number) {
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 8, 24, 9, minute)).toISOString();
  return TURNS.slice(0, completed).flatMap((turn, index) => [
    {
      id: turn.userId,
      role: "user",
      content: turn.userText,
      createdAt: at(index * 2),
      metricSource: null,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    },
    {
      id: turn.assistantId,
      role: "assistant",
      content: turn.answer,
      createdAt: at(index * 2 + 1),
      metricSource: turn.metricSource,
      providerType: "mock",
      promptVersion: "e2e",
      tokensUsed: 420,
      model: "mock",
    },
  ]);
}

/**
 * Serves the conversation as the stubbed server would hold it: one more
 * persisted turn after every POST. Returns the parsed body of every POST.
 */
async function mockCoach(
  page: Page,
  opts: {
    /** Holds the first detail refetch after a turn until this resolves. */
    holdRefetch?: Promise<void>;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const posts: Array<Record<string, unknown>> = [];
  let completed = 0;

  const summary = () => ({
    id: CONVERSATION_ID,
    title: TITLE,
    createdAt: "2026-09-24T09:00:00.000Z",
    updatedAt: "2026-09-24T09:05:00.000Z",
    messageCount: completed * 2,
    fenced: false,
    attachments: [],
    documentTitle: null,
  });

  await page.route(
    /\/api\/insights\/chat(?:\/[^?]+)?(?:\?.*)?$/,
    async (route: Route, request: Request) => {
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        url.pathname === "/api/insights/chat"
      ) {
        const body = request.postDataJSON() as Record<string, unknown>;
        posts.push(body);
        const turn = TURNS[completed];
        if (!turn) return route.abort();
        completed += 1;
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: eventStream(turn),
        });
      }
      if (
        url.pathname ===
        `/api/insights/chat/${CONVERSATION_ID}/messages/${TURNS[0].assistantId}/results`
      ) {
        return fulfilJson(route, { results: [BP_TABLE] });
      }
      if (url.pathname.startsWith(`/api/insights/chat/${CONVERSATION_ID}/`)) {
        return fulfilJson(route, { results: [] });
      }
      if (url.pathname === `/api/insights/chat/${CONVERSATION_ID}`) {
        if (completed > 0 && opts.holdRefetch) await opts.holdRefetch;
        return fulfilJson(route, {
          ...summary(),
          attachmentCount: 0,
          summary: null,
          messages: persisted(completed),
        });
      }
      return fulfilJson(route, {
        conversations: completed > 0 ? [summary()] : [],
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
  return posts;
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
    .include('[data-slot="coach-follow-up-chips"]')
    .include('[data-slot="coach-suggested-replies"]')
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

/**
 * The streamed reply is replaced by its persisted copy once the detail
 * refetch after `done` lands. The copy takes over the same bubble, so what
 * the reader toggled survives the swap (pinned below); the steps wait for it
 * only to read the settled state.
 */
async function waitForPersistedTwin(page: Page) {
  await expect(
    page.locator('[role="log"] [data-slot="coach-bubble-assistant"]'),
  ).toHaveCount(0);
}

test.describe("Coach dialog", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const theme of ["light", "dark"] as const) {
    test(`theme=${theme}: steps, a result, a follow-up chip and a clarification`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-desktop",
        "the dialog flow is viewport-independent; desktop run suffices",
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await serveAiBlock(page, aiBlockAvailable());
      const posts = await mockCoach(page);
      await useTheme(page, theme);

      await page.goto("/coach", { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(^|\\s)${theme}(\\s|$)`),
      );

      // 1. The first question streams its steps.
      await page
        .locator('[data-slot="coach-input-textarea"]')
        .fill(FIRST_QUESTION);
      await page.locator('[data-slot="coach-input-send"]').click();

      const firstBubble = page
        .locator('[data-slot="coach-bubble-assistant"]')
        .filter({ hasText: FIRST_ANSWER });
      await expect(firstBubble).toBeVisible({ timeout: 15_000 });
      await waitForPersistedTwin(page);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ message: FIRST_QUESTION });
      expect(posts[0].followUp).toBeUndefined();
      expect(posts[0].clarification).toBeUndefined();

      const steps = firstBubble.locator('[data-slot="coach-turn-steps"]');
      await expect(steps).toBeVisible();
      await expect(
        steps.locator('[data-slot="coach-turn-steps-done"]'),
      ).toBeVisible();
      await steps.locator('[data-slot="coach-turn-steps-toggle"]').click();
      const stepRows = steps.locator('[data-slot="coach-turn-step"]');
      await expect(stepRows).toHaveCount(2);
      await expect(stepRows.nth(0)).toHaveAttribute("data-status", "done");
      await expect(stepRows.nth(1)).toHaveAttribute("data-status", "done");

      // 2. The result opens as its chart; the toggle switches to the table.
      const figure = firstBubble.locator(
        '[data-slot="coach-result-chart"][data-ref="r1"]',
      );
      await expect(figure).toBeVisible();
      await expect(figure).toHaveAttribute("data-chart-kind", "line");
      await expect(
        figure.locator('[data-slot="coach-result-view-chart"]'),
      ).toHaveAttribute("aria-pressed", "true");
      await figure.locator('[data-slot="coach-result-view-table"]').click();

      const table = firstBubble.locator(
        '[data-slot="coach-result-table"][data-ref="r1"]',
      );
      await expect(table).toBeVisible();
      await expect(figure).toBeHidden();
      await expect(table.locator("caption")).toContainText(BP_TABLE.title);
      await expect(
        table.locator('[data-slot="coach-result-view-table"]'),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(table.locator("tbody tr")).toHaveCount(BP_VALUES.length);

      // The copy menu puts the table on the clipboard as text.
      await table.locator('[data-slot="coach-copy-table"]').click();
      await page.locator('[data-slot="coach-copy-table-text"]').click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("Systolic");
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(BP_TABLE.title);
      expect(copied).toContain("128");

      await table.locator('[data-slot="coach-result-view-chart"]').click();
      await expect(figure).toBeVisible();
      await expect(table).toBeHidden();

      // The method line closes the open steps list.
      await expect(
        steps.locator(
          '[data-slot="coach-turn-steps-panel"] [data-slot="coach-method-line"]',
        ),
      ).toContainText(TURN_ONE_METHOD.text);

      // 3. A follow-up chip sends which chip it was.
      const chips = page.locator('[data-slot="coach-follow-up-chips"]');
      await expect(chips).toHaveAttribute(
        "data-message-id",
        TURNS[0].assistantId,
      );
      await expect(chips.locator("[data-follow-up-id]")).toHaveCount(2);
      // axe over the answer with its result and the chips.
      await expectNoAxeViolations(page, `${theme} chart view with chips`);
      await chips.locator('[data-follow-up-id="f2"]').click();

      const secondBubble = page
        .locator('[data-slot="coach-bubble-assistant"]')
        .filter({ hasText: SECOND_ANSWER });
      await expect(secondBubble).toBeVisible({ timeout: 15_000 });
      await waitForPersistedTwin(page);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({
        conversationId: CONVERSATION_ID,
        message: "Compare with the period before",
        followUp: { messageId: TURNS[0].assistantId, id: "f2" },
      });
      expect(posts[1].clarification).toBeUndefined();

      // 4. The reply asks; pills under it offer the choices, and the chips
      //    of the earlier reply are gone. No card.
      await expect(
        page.locator('[data-slot="coach-clarification-card"]'),
      ).toHaveCount(0);
      const pills = secondBubble.locator(
        '[data-slot="coach-suggested-replies"]',
      );
      await expect(pills).toBeVisible();
      await expect(pills).toHaveAttribute(
        "data-message-id",
        TURNS[1].assistantId,
      );
      await expect(pills.locator("[data-choice-id]")).toHaveCount(2);
      await expect(chips).toHaveCount(0);
      // The earlier result still renders under its own answer.
      await expect(figure).toBeVisible();

      // 5. axe over the answers, the result in both views and the pills.
      await expectNoAxeViolations(page, `${theme} chart view with a question`);
      await figure.locator('[data-slot="coach-result-view-table"]').click();
      await expect(table).toBeVisible();
      await expectNoAxeViolations(page, `${theme} table view with a question`);

      await pills.locator('[data-choice-id="c2"]').click();

      const thirdBubble = page
        .locator('[data-slot="coach-bubble-assistant"]')
        .filter({ hasText: THIRD_ANSWER });
      await expect(thirdBubble).toBeVisible({ timeout: 15_000 });
      await waitForPersistedTwin(page);
      expect(posts).toHaveLength(3);
      expect(posts[2]).toMatchObject({
        conversationId: CONVERSATION_ID,
        message: "Resting HR",
        clarification: { messageId: TURNS[1].assistantId, choiceId: "c2" },
      });
      expect(posts[2].followUp).toBeUndefined();

      // A plain answer closes the question and offers no chips.
      await expect(pills).toHaveCount(0);
      await expect(chips).toHaveCount(0);
      await expect(
        thirdBubble.locator('[data-slot="coach-turn-steps"]'),
      ).toBeVisible();
    });
  }

  test("keeps the reader's view when the persisted copy replaces the streamed reply", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-independent; desktop run suffices",
    );
    await serveAiBlock(page, aiBlockAvailable());
    let release: () => void = () => {};
    const holdRefetch = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockCoach(page, { holdRefetch });
    await useTheme(page, "light");

    await page.goto("/coach", { waitUntil: "domcontentloaded" });
    await page
      .locator('[data-slot="coach-input-textarea"]')
      .fill(FIRST_QUESTION);
    await page.locator('[data-slot="coach-input-send"]').click();

    // The streamed reply has settled; its persisted copy is held back.
    const streamed = page.locator(
      '[role="log"] [data-slot="coach-bubble-assistant"]',
    );
    await expect(streamed).toContainText(FIRST_ANSWER, { timeout: 15_000 });
    await streamed
      .locator('[data-slot="coach-result-view-table"]')
      .first()
      .click();
    await expect(
      streamed.locator('[data-slot="coach-result-table"][data-ref="r1"]'),
    ).toBeVisible();

    release();
    await waitForPersistedTwin(page);

    // The same bubble, still on the table the reader chose.
    const bubble = page
      .locator('[data-slot="coach-bubble-assistant"]')
      .filter({ hasText: FIRST_ANSWER });
    await expect(bubble).toHaveCount(1);
    const table = bubble.locator(
      '[data-slot="coach-result-table"][data-ref="r1"]',
    );
    await expect(table).toBeVisible();
    await expect(
      table.locator('[data-slot="coach-result-view-table"]'),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
