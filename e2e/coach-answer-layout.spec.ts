import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Route, TestInfo } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

/**
 * The geometry of a Coach answer, at 1440 x 900 (desktop project) and
 * 390 x 844 (mobile project).
 *
 * Contracts under test:
 *
 *   1. Under an answer there is exactly one action row, left-aligned on the
 *      bubble's left edge and no taller than one 44 px target: copy, read
 *      aloud, try again, details, then the time. The model and the tokens
 *      are not text on the row; the details icon shows them in a tooltip on
 *      keyboard focus (desktop) and on a tap (phone); Enter and Space keep it
 *      open, and a second tap or Escape closes it.
 *   2. The follow-up chips sit in the answer's column: their left edge is
 *      the bubble's, their text is the answer's size, and a chip is at most
 *      36 px tall beside a pointer and at least 44 px on a phone.
 *   3. Under a question, copy and remember share one row; nothing stacks
 *      below it.
 *   4. Scrolled away from the end, a round button appears; it brings the
 *      thread back to the end and goes away again.
 *   5. No thumbs, no evidence disclosure, no horizontal overflow.
 *
 * Screenshots are attached to the report (no pixel baselines) and, with
 * `COACH_SHOT_DIR` set, written there too.
 */

const CONVERSATION_ID = "coach-answer-layout-e2e";
const TITLE = "Blood pressure and sleep";

const ANSWERS = [
  "Your blood pressure stayed in a steady band over the last month. The morning readings sat a little higher than the evening ones, which is common, and none of the weeks stands out from the others.",
  "Sleep looked regular on most nights. The weekends ran about forty minutes later at both ends, so the total stayed much the same while the timing moved.",
  "Your resting heart rate held steady across the same weeks. Nothing in it lines up with the later weekend nights, so the two seem to move independently for now.",
  "The period before looked much the same for blood pressure. Two readings in the second week were higher than the rest, and both were taken shortly after a workout.",
  "Taken together, the month reads calm: steady blood pressure, regular sleep and a resting heart rate without surprises. Measuring at the same time each morning keeps the trend easy to read.",
];
const QUESTIONS = [
  "How was my blood pressure this month?",
  "And my sleep?",
  "What about my resting heart rate?",
  "Compare blood pressure with the period before",
  "Sum it up for me",
];

const STEPS = [
  {
    id: "s1",
    tool: "get_metric_series",
    labelKey: "coach.step.readWindow",
    label: "Checking: Blood pressure, last 30 days",
    domain: "bp",
    window: "last30days",
    status: "done",
    count: 28,
  },
  {
    id: "s2",
    tool: "get_sleep",
    labelKey: "coach.step.readWindow",
    label: "Checking: Sleep, last 30 days",
    domain: "sleep",
    window: "last30days",
    status: "done",
    count: 30,
  },
];

const FOLLOW_UPS = [
  {
    id: "f1",
    kind: "previous_period",
    labelKey: "coach.followUp.previousPeriod",
    label: "Compare with the period before",
    reuse: false,
    origin: "server",
  },
  {
    id: "f2",
    kind: "related_metric",
    labelKey: "coach.followUp.relatedMetric",
    label: "See also: Resting HR",
    reuse: false,
    origin: "server",
  },
];

function messages() {
  // Today, a few minutes apart, so the time reads as a bare clock.
  const base = Date.now() - 60 * 60 * 1000;
  const at = (minute: number) =>
    new Date(base + minute * 60 * 1000).toISOString();
  return ANSWERS.flatMap((answer, index) => [
    {
      id: `${CONVERSATION_ID}-u${index + 1}`,
      role: "user",
      content: QUESTIONS[index],
      createdAt: at(index * 2),
      metricSource: null,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    },
    {
      id: `${CONVERSATION_ID}-a${index + 1}`,
      role: "assistant",
      content: answer,
      createdAt: at(index * 2 + 1),
      metricSource: {
        windows: ["last30days"],
        metrics: ["bp", "sleep"],
        steps: STEPS,
        ...(index === ANSWERS.length - 1 ? { followUps: FOLLOW_UPS } : {}),
      },
      providerType: "mock",
      promptVersion: "e2e",
      tokensUsed: 1234,
      model: "gpt-4o-mini-2024-07-18",
    },
  ]);
}

function fulfilJson(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

async function mockConversation(page: Page) {
  const summary = {
    id: CONVERSATION_ID,
    title: TITLE,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: ANSWERS.length * 2,
    fenced: false,
    attachments: [],
    documentTitle: null,
  };
  await page.route(
    /\/api\/insights\/chat(?:\/[^?]+)?(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith(`/api/insights/chat/${CONVERSATION_ID}/`)) {
        return fulfilJson(route, { results: [] });
      }
      if (url.pathname === `/api/insights/chat/${CONVERSATION_ID}`) {
        return fulfilJson(route, {
          ...summary,
          attachmentCount: 0,
          summary: null,
          messages: messages(),
        });
      }
      return fulfilJson(route, { conversations: [summary], nextCursor: null });
    },
  );
  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element has a box").not.toBeNull();
  return b!;
}

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.screenshot({ fullPage: false });
  await testInfo.attach(name, { body, contentType: "image/png" });
  const dir = process.env.COACH_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${name}.png`) });
  }
}

const VIEWPORTS = {
  "chromium-desktop": { width: 1440, height: 900, label: "1440" },
  "chromium-mobile": { width: 390, height: 844, label: "390" },
} as const;

test.describe("Coach answer layout", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("one action row, chips in the answer column, jump to the latest", async ({
    page,
  }, testInfo) => {
    const viewport = VIEWPORTS[testInfo.project.name as keyof typeof VIEWPORTS];
    test.skip(!viewport, "measured in the desktop and the mobile project");
    const desktop = viewport.width >= 640;
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await serveAiBlock(page, aiBlockAvailable());
    await mockConversation(page);

    await page.goto(`/coach?c=${CONVERSATION_ID}`, {
      waitUntil: "domcontentloaded",
    });
    const thread = page.locator('[data-slot="coach-message-thread"]');
    const answers = page.locator('[data-slot="coach-bubble-assistant"]');
    await expect(answers).toHaveCount(ANSWERS.length, { timeout: 15_000 });
    const last = answers.last();
    await expect(last).toContainText(ANSWERS.at(-1)!.slice(0, 40));
    // The thread opens at its end.
    await expect
      .poll(() =>
        thread.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(2);

    if (desktop) await last.hover();
    await shoot(page, testInfo, `answer-${viewport.label}`);

    // 5. Nothing of the old furniture.
    await expect(
      page.locator('[data-slot^="coach-message-feedback"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-slot^="coach-evidence"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="coach-token-footer"]')).toHaveCount(
      0,
    );
    for (const el of [page.locator("#main-content"), thread]) {
      const overflow = await el.evaluate((n) => n.scrollWidth - n.clientWidth);
      expect(overflow, "no horizontal overflow").toBeLessThanOrEqual(0);
    }

    // 1. One action row under the answer.
    const bubble = last.locator('[data-slot="coach-answer-bubble"]');
    const column = last.locator('[data-slot="coach-answer-column"]');
    const row = last.locator('[data-slot="coach-answer-actions"]');
    const info = row.locator('[data-slot="coach-answer-info"]');
    const time = row.locator('[data-slot="coach-message-time"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveCSS("opacity", "1");
    await expect(row).not.toContainText("tokens");
    await expect(row.locator('[data-slot="coach-answer-meta"]')).toHaveCount(0);
    await expect(info).toHaveAttribute("aria-label", "Answer details");
    const [bubbleBox, columnBox, rowBox, answerCopyBox, infoBox, timeBox] =
      await Promise.all(
        [
          bubble,
          column,
          row,
          row.locator('[data-slot="coach-copy-message"]'),
          info,
          time,
        ].map(box),
      );
    expect(rowBox.height, "the row is one line").toBeLessThanOrEqual(44);
    expect(Math.abs(answerCopyBox.x - bubbleBox.x)).toBeLessThanOrEqual(1);
    expect(infoBox.x, "details follows the other icons").toBeGreaterThan(
      answerCopyBox.x,
    );
    expect(timeBox.x, "the time comes last").toBeGreaterThan(infoBox.x);
    expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(
      columnBox.x + columnBox.width + 1,
    );
    for (const [b, name] of [
      [infoBox, "details"],
      [timeBox, "time"],
    ] as const) {
      expect(
        Math.abs(
          b.y + b.height / 2 - (answerCopyBox.y + answerCopyBox.height / 2),
        ),
        `${name} shares the row's line`,
      ).toBeLessThanOrEqual(2);
    }

    // The details tooltip: focus opens it on a desktop, a tap on a phone.
    const tip = page.locator('[data-slot="coach-answer-info-content"]');
    await expect(tip).toHaveCount(0);
    if (desktop) await info.focus();
    else await info.tap();
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Model: gpt-4o-mini-2024-07-18");
    await expect(tip).toContainText("1,234 tokens");
    await expect(info).toHaveAttribute("aria-describedby", /.+/);
    await shoot(page, testInfo, `answer-info-${viewport.label}`);
    if (desktop) {
      // Enter and Space on the focused icon keep it open; Escape closes it.
      for (const key of ["Enter", "Space"]) {
        await page.keyboard.press(key);
        await expect(tip).toBeVisible();
      }
      await page.keyboard.press("Escape");
    } else await info.tap();
    await expect(tip).toHaveCount(0);

    // 2. The chips in the answer's column, at the answer's size.
    const chips = last.locator('[data-slot="coach-follow-up-chips"]');
    await expect(chips.locator("[data-follow-up-id]")).toHaveCount(2);
    const chipsBox = await box(chips);
    expect(Math.abs(chipsBox.x - bubbleBox.x)).toBeLessThanOrEqual(1);
    expect(chipsBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
    const answerSize = await bubble.evaluate(
      (el) => getComputedStyle(el).fontSize,
    );
    for (const chip of await chips.locator("[data-follow-up-id]").all()) {
      await expect(chip).toHaveCSS("font-size", answerSize);
      const chipBox = await box(chip);
      if (desktop) expect(chipBox.height).toBeLessThanOrEqual(36);
      else expect(chipBox.height).toBeGreaterThanOrEqual(44);
    }

    // 3. Copy and remember share the question's one row.
    const question = page.locator('[data-slot="coach-bubble-user"]').last();
    if (desktop) await question.hover();
    const userRow = question.locator('[data-slot="coach-user-actions"]');
    const remember = userRow.locator('[data-slot="coach-remember-message"]');
    const copy = userRow.locator('[data-slot="coach-copy-message"]');
    await expect(remember).toHaveAttribute("aria-label", "Remember");
    const [rememberBox, copyBox] = await Promise.all([remember, copy].map(box));
    expect(
      Math.abs(
        rememberBox.y +
          rememberBox.height / 2 -
          (copyBox.y + copyBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    // The question's column holds the bubble and its one row, nothing else.
    expect(
      await userRow.evaluate((el) => el.parentElement?.childElementCount),
    ).toBe(2);

    // 4. Away from the end, the button appears and brings the thread back.
    const jump = page.locator('[data-slot="coach-scroll-to-bottom"]');
    await expect(jump).toHaveAttribute("data-visible", "false");
    await expect(jump).toHaveCSS("opacity", "0");
    await thread.evaluate((el) => el.scrollTo({ top: 0, behavior: "auto" }));
    await expect(jump).toHaveAttribute("data-visible", "true");
    await expect(jump).toHaveCSS("opacity", "1");
    await shoot(page, testInfo, `scrolled-up-${viewport.label}`);
    const jumpBox = await box(jump);
    const threadBox = await box(thread);
    expect(
      Math.abs(
        jumpBox.x + jumpBox.width / 2 - (threadBox.x + threadBox.width / 2),
      ),
      "centred over the thread",
    ).toBeLessThanOrEqual(1);
    await jump.click();
    await expect
      .poll(() =>
        thread.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(2);
    await expect(jump).toHaveAttribute("data-visible", "false");
    await expect(jump).toHaveAttribute("tabindex", "-1");
    await expect(page.locator("#coach-composer-textarea")).toBeFocused();
  });
});
