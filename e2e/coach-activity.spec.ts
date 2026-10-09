import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import {
  FIXED_NOW,
  done,
  end,
  feed,
  installLiveCoachStream,
  posts,
  serveConversation,
  tokens,
  applyTheme,
  type StubConversation,
} from "./setup/coach-live-stream";

/**
 * The thinking row of a Coach turn: one quiet row at the top of the answer.
 *
 * Contracts under test, at 1440 and 390 px, light and dark:
 *
 *   1. While the turn runs the row says what is happening right now and
 *      moves with the frames: Thinking… → Fetching blood pressure… →
 *      Summarising 214 readings… → Writing the answer…, with the words
 *      shimmering and no clock.
 *   2. A table the turn has read shows nothing of its own while the turn
 *      runs: no second row, no preview, no sparkline.
 *   3. Nothing opens by itself: the row stays closed (`aria-expanded`
 *      false) in every state, after the answer and after a reload; a row
 *      opened during the run closes when the answer is done.
 *   4. After the answer the row reads "Thought process (4 steps)" and the
 *      table the answer points at renders as its chart.
 *   5. A tap opens the steps; a reasoning round shows its summary under
 *      its title.
 *   6. No horizontal scroll, a 44 px tap target on phones, axe clean.
 *
 * The chat stream is fed frame by frame from the spec
 * (`installLiveCoachStream`), so every live state is observed rather than
 * flashing by. Set COACH_SCREENSHOTS_DIR to also write screenshots of each
 * state; those runs keep motion on so the shimmer shows mid-sweep.
 */

const CONVERSATION_ID = "coach-activity-e2e";
const QUESTION = "How was my blood pressure this month?";
const ANSWER =
  "Your blood pressure held a steady band this month, around 126/82 mmHg on most days. Nothing stands out against your usual range.";

const BP_VALUES: Array<[number, number]> = [
  [128, 84],
  [125, 82],
  [131, 85],
  [122, 80],
  [124, 81],
  [127, 83],
  [121, 79],
  [126, 82],
  [123, 80],
  [126, 81],
];

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
  displayed: false,
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
  rows: BP_VALUES.map(([sys, dia], i) => [
    new Date(Date.UTC(2026, 8, 7 + i)).toISOString().slice(0, 10),
    sys,
    dia,
    i === 0 ? 205 : 1,
  ]),
  truncated: false,
  chart: { kind: "line", x: "day", series: ["systolic", "diastolic"] },
};
const BP_SHOWN = { ...BP_TABLE, displayed: true };
const BP_META = {
  ref: "r1",
  source: BP_TABLE.source,
  shape: BP_TABLE.shape,
  titleKey: BP_TABLE.titleKey,
  title: BP_TABLE.title,
  rowCount: BP_TABLE.rowCount,
  chartKind: "line",
  displayed: true,
};

const STEP = {
  id: "s1",
  tool: "get_metric_table",
  labelKey: "coach.step.readWindow",
  label: "Checking: Blood pressure, last 30 days",
  domain: "bp",
  window: "last30days",
  granularity: "day",
};

function entry(
  id: string,
  phase: string,
  status: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "activity",
    activity: {
      id,
      phase,
      status,
      round: phase === "answer" ? 2 : 1,
      labelKey: `insights.coach.activity.${phase}`,
      label,
      ...extra,
    },
  };
}

const THINK_TITLE = "Looking at the whole month";
const THINK_TEXT =
  "The month has daily readings; a daily table answers this best.";

const ACTIVITY_META = [
  {
    id: "a1",
    phase: "thinking",
    status: "done",
    round: 1,
    labelKey: "insights.coach.activity.thinking",
    label: "Thinking…",
    durationMs: 2_400,
  },
  {
    id: "a2",
    phase: "fetch",
    status: "done",
    round: 1,
    labelKey: "insights.coach.activity.fetching",
    label: "Fetching blood pressure, last 30 days…",
    stepRef: "s1",
    count: 214,
    durationMs: 900,
  },
  {
    id: "a3",
    phase: "digest",
    status: "done",
    round: 1,
    labelKey: "insights.coach.activity.digestDone",
    label: "214 readings from 1 area",
    count: 214,
    durationMs: 400,
  },
  {
    id: "a4",
    phase: "answer",
    status: "done",
    round: 2,
    labelKey: "insights.coach.activity.answer",
    label: "Writing the answer…",
    durationMs: 3_000,
  },
];

const METRIC_SOURCE = {
  windows: ["last30days"],
  metrics: ["bp"],
  counts: { bp: 214 },
  steps: [{ ...STEP, status: "done", count: 214, resultRef: "r1" }],
  activity: ACTIVITY_META,
  results: [BP_META],
  method: {
    entries: [
      {
        domain: "bp",
        window: "last30days",
        granularity: "day",
        count: 214,
        aggregation: "mean",
      },
    ],
    text: "Blood pressure, last 30 days, 214 readings, daily averages.",
  },
};

function conversation(): StubConversation {
  return {
    id: CONVERSATION_ID,
    title: "Blood pressure this month",
    messages: [],
    results: { "coach-activity-e2e-a1": [BP_SHOWN] },
    trails: {
      "coach-activity-e2e-a1": {
        entries: [{ id: "a1", title: THINK_TITLE, text: THINK_TEXT }],
      },
    },
  };
}

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

const SHOTS = process.env.COACH_SCREENSHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The pointer off the row and the open/rotate transitions done, so the
  // picture shows the resting state; the shimmer keeps running.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Coach live trail", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  for (const viewport of VIEWPORTS) {
    for (const theme of ["light", "dark"] as const) {
      test(`${viewport.name} px, ${theme}: one quiet line that never opens by itself`, async ({
        page,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "chromium-desktop",
          "sets its own viewports; one project suffices",
        );
        const label = `${viewport.name}-${theme}`;
        await page.setViewportSize(viewport);
        await page.clock.setFixedTime(FIXED_NOW);
        await serveAiBlock(page, aiBlockAvailable());
        const stub = conversation();
        await serveConversation(page, stub);
        await installLiveCoachStream(page);
        await applyTheme(page, theme);
        if (SHOTS) await page.emulateMedia({ reducedMotion: "no-preference" });

        await page.goto("/coach", { waitUntil: "domcontentloaded" });
        await page.locator('[data-slot="coach-input-textarea"]').fill(QUESTION);
        await page.locator('[data-slot="coach-input-send"]').click();

        const turn = page.locator(
          '[role="log"] [data-slot="coach-bubble-assistant"]',
        );
        const line = turn.locator('[data-slot="coach-turn-steps"]');
        const toggle = line.locator('[data-slot="coach-turn-steps-toggle"]');
        const current = line.locator('[data-slot="coach-turn-steps-active"]');
        const chevron = line.locator('[data-slot="coach-turn-steps-chevron"]');
        const column = turn.locator('[data-slot="coach-answer-column"]');

        // 1. Before any frame: Thinking…, shimmering, nothing to open yet.
        await expect(line).toHaveAttribute("data-state", "running");
        await expect(current).toHaveAttribute("data-text", "Thinking…");
        await expect(current.locator(".text-shimmer")).toHaveText("Thinking");
        await expect(current.locator(".waiting-dot")).toHaveCount(3);
        await expect(chevron).toHaveCount(0);
        await expect(toggle).toHaveCount(0);

        await feed(page, [entry("a1", "thinking", "running", "Thinking…")]);
        await feed(page, [
          entry("a1", "thinking", "running", "Thinking…", {
            title: THINK_TITLE,
          }),
        ]);
        await expect(current).toHaveAttribute("data-text", `${THINK_TITLE}…`);
        await expect(chevron).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");

        await feed(page, [
          entry("a1", "thinking", "done", "Thinking…", {
            title: THINK_TITLE,
            text: THINK_TEXT,
            durationMs: 2_400,
          }),
          { type: "step", step: { ...STEP, status: "running" } },
          entry(
            "a2",
            "fetch",
            "running",
            "Fetching blood pressure, last 30 days…",
            {
              stepRef: "s1",
            },
          ),
        ]);
        await expect(current).toHaveAttribute(
          "data-text",
          "Fetching blood pressure, last 30 days…",
        );

        // 2. The table it read shows nothing of its own while the turn runs.
        await feed(page, [
          { type: "result", result: BP_TABLE, interim: true },
          { type: "step", step: { ...STEP, status: "done", count: 214 } },
          entry(
            "a2",
            "fetch",
            "done",
            "Fetching blood pressure, last 30 days…",
            {
              stepRef: "s1",
              count: 214,
              durationMs: 900,
            },
          ),
          entry("a3", "digest", "running", "Summarising 214 readings…", {
            count: 214,
          }),
        ]);
        await expect(current).toHaveAttribute(
          "data-text",
          "Summarising 214 readings…",
        );
        // One row and nothing else in the answer's column: no table title,
        // no sparkline, no clock.
        await expect(column.locator(":scope > *")).toHaveCount(1);
        await expect(turn).not.toContainText("Blood pressure by day");
        await expect(turn.locator("svg polyline")).toHaveCount(0);
        await expect(line).not.toContainText(/\d\s?s\b/);
        await expect(
          turn.locator('[data-slot="coach-answer-bubble"]'),
        ).toHaveCount(0);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await noHorizontalScroll(page);
        await shot(page, `${label}-1-running`);

        // A tap opens the steps while the turn runs...
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(line.locator('[data-slot="coach-turn-step"]')).toHaveCount(
          3,
        );
        await expect(
          line.locator('[data-slot="coach-turn-step"]').nth(2),
        ).toHaveAttribute("data-status", "running");
        await noHorizontalScroll(page);
        await shot(page, `${label}-2-running-open`);

        await feed(page, [
          entry("a3", "digest", "done", "214 readings from 1 area", {
            count: 214,
            durationMs: 400,
          }),
          entry("a4", "answer", "running", "Writing the answer…"),
          ...tokens(ANSWER),
        ]);
        await expect(current).toHaveAttribute(
          "data-text",
          "Writing the answer…",
        );
        await expect(
          turn.locator('[data-slot="coach-answer-bubble"]'),
        ).toContainText(ANSWER);
        // ...and stays as the person left it until the turn ends.
        await expect(toggle).toHaveAttribute("aria-expanded", "true");

        // The persisted copy lands with the refetch after `done`.
        stub.messages.push(
          { id: "coach-activity-e2e-u1", role: "user", content: QUESTION },
          {
            id: "coach-activity-e2e-a1",
            role: "assistant",
            content: ANSWER,
            metricSource: METRIC_SOURCE,
          },
        );
        await feed(page, [
          entry("a4", "answer", "done", "Writing the answer…", {
            durationMs: 3_000,
          }),
          { type: "provenance", metricSource: METRIC_SOURCE },
          { type: "result", result: BP_SHOWN },
          done(CONVERSATION_ID, "coach-activity-e2e-a1"),
        ]);
        await end(page);

        // 4. The thought process and its steps, closed again; the table the
        //    answer points at is its chart.
        const bubble = page
          .locator('[data-slot="coach-bubble-assistant"]')
          .filter({ hasText: ANSWER });
        const settled = bubble.locator('[data-slot="coach-turn-steps"]');
        await expect(settled).toHaveAttribute("data-state", "done");
        await expect(
          settled.locator('[data-slot="coach-turn-steps-done"]'),
        ).toHaveText("Thought process (4 steps)");
        await expect(settled.locator(".text-shimmer")).toHaveCount(0);
        const settledToggle = settled.locator(
          '[data-slot="coach-turn-steps-toggle"]',
        );
        await expect(settledToggle).toHaveAttribute("aria-expanded", "false");
        await expect(
          settled.locator('[data-slot="coach-turn-steps-panel"]'),
        ).toHaveCount(0);
        await expect(
          bubble.locator('[data-slot="coach-result-chart"][data-ref="r1"]'),
        ).toBeVisible();
        await expect(
          bubble.locator('[data-slot="coach-result-chart-plot"]'),
        ).toBeVisible();
        expect((await posts(page))[0]).toMatchObject({ message: QUESTION });
        await noHorizontalScroll(page);
        await shot(page, `${label}-3-settled`);

        // 6. A 44 px tap target on phones.
        if (viewport.width < 640) {
          const box = await settledToggle.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }

        // 5. A tap opens the steps; the reasoning round shows its summary
        //    under its title.
        await settledToggle.click();
        await expect(settledToggle).toHaveAttribute("aria-expanded", "true");
        const panel = settled.locator('[data-slot="coach-turn-steps-panel"]');
        await expect(panel).toBeVisible();
        const rows = panel.locator('[data-slot="coach-turn-step"]');
        await expect(rows).toHaveCount(4);
        await expect(rows.nth(0)).toHaveAttribute("data-phase", "thinking");
        await expect(rows.nth(1)).toHaveAttribute("data-phase", "fetch");
        await expect(
          panel.locator('[data-slot="coach-method-line"]'),
        ).toContainText(METRIC_SOURCE.method.text);
        await expect(rows.nth(0)).toContainText(THINK_TITLE);
        await expect(
          rows.nth(0).locator('[data-slot="coach-turn-step-detail"]'),
        ).toHaveText(THINK_TEXT);
        await expect(
          panel.locator('[data-slot="coach-turn-step-connector"]'),
        ).toHaveCount(3);
        await noHorizontalScroll(page);
        await shot(page, `${label}-4-settled-open`);

        const axe = await new AxeBuilder({ page })
          .include('[data-slot="coach-bubble-assistant"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(
          axe.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target.join(" ")),
          })),
        ).toEqual([]);

        // 3. After a reload the trail is closed again, and opening it reads
        //    the stored titles and texts.
        await page.goto(`/coach?c=${CONVERSATION_ID}`, {
          waitUntil: "domcontentloaded",
        });
        const reloaded = page
          .locator('[data-slot="coach-bubble-assistant"]')
          .filter({ hasText: ANSWER })
          .locator('[data-slot="coach-turn-steps"]');
        await expect(reloaded).toHaveAttribute("data-state", "done");
        await expect(
          reloaded.locator('[data-slot="coach-turn-steps-done"]'),
        ).toHaveText("Thought process (4 steps)");
        const reloadedToggle = reloaded.locator(
          '[data-slot="coach-turn-steps-toggle"]',
        );
        await expect(reloadedToggle).toHaveAttribute("aria-expanded", "false");
        await expect(
          reloaded.locator('[data-slot="coach-turn-steps-panel"]'),
        ).toHaveCount(0);
        await reloadedToggle.click();
        const first = reloaded.locator('[data-slot="coach-turn-step"]').nth(0);
        await expect(first).toContainText(THINK_TITLE);
        await expect(first).toContainText(THINK_TEXT);
      });
    }
  }
});
