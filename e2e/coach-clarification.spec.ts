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
 * A clarifying question is a conversation, not a form.
 *
 *   1. The question is a normal Coach message; its choices are quiet reply
 *      pills under it, the assumed one first. There is no card.
 *   2. A pill sends its label as the person's own message, with
 *      `clarification: { messageId, choiceId }`.
 *   3. A typed answer works too, with `clarification: { messageId }`.
 *   4. The trail above the question stays closed.
 */

const CONVERSATION_ID = "coach-clarify-e2e";
const QUESTION = "Is my heart rate okay?";
const ASKS =
  "Do you mean your resting heart rate or your heart rate while walking? Otherwise I'll look at your resting heart rate.";
const ANSWER =
  "Your walking heart rate sat around 98 bpm over the last 30 days, close to your usual level.";

const CLARIFICATION = {
  kind: "metric",
  freeText: true,
  assumption: "c1",
  choices: [
    {
      id: "c1",
      labelKey: "insights.coach.metric.resting_hr",
      label: "Resting HR",
      value: { metric: "resting_hr" },
    },
    {
      id: "c2",
      labelKey: "insights.coach.metric.walking_hr",
      label: "Walking HR",
      value: { metric: "walking_hr" },
    },
  ],
};
const ASK_SOURCE = {
  windows: ["last30days"],
  metrics: ["resting_hr"],
  activity: [
    {
      id: "a1",
      phase: "thinking",
      status: "done",
      round: 1,
      labelKey: "insights.coach.activity.thinking",
      label: "Thinking…",
      durationMs: 1_200,
    },
    {
      id: "a2",
      phase: "asking",
      status: "done",
      round: 1,
      labelKey: "insights.coach.activity.asking",
      label: "Asking you…",
      durationMs: 300,
    },
  ],
  clarification: CLARIFICATION,
};

async function ask(
  page: import("@playwright/test").Page,
  stub: StubConversation,
) {
  await page.locator('[data-slot="coach-input-textarea"]').fill(QUESTION);
  await page.locator('[data-slot="coach-input-send"]').click();
  const live = page.locator(
    '[role="log"] [data-slot="coach-turn-steps-active"]',
  );
  await feed(page, [
    {
      type: "activity",
      activity: {
        ...ASK_SOURCE.activity[0],
        status: "running",
        durationMs: undefined,
      },
    },
    {
      type: "activity",
      activity: {
        ...ASK_SOURCE.activity[1],
        status: "running",
        durationMs: undefined,
      },
    },
  ]);
  await expect(live).toHaveText("Asking you…");
  stub.messages.push(
    { id: "coach-clarify-e2e-u1", role: "user", content: QUESTION },
    {
      id: "coach-clarify-e2e-a1",
      role: "assistant",
      content: ASKS,
      metricSource: ASK_SOURCE,
    },
  );
  await feed(page, [
    ...tokens(ASKS),
    { type: "activity", activity: ASK_SOURCE.activity[1] },
    { type: "provenance", metricSource: ASK_SOURCE },
    { type: "clarification", clarification: CLARIFICATION },
    done(CONVERSATION_ID, "coach-clarify-e2e-a1"),
  ]);
  await end(page);
}

test.describe("Coach clarifying question", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("pills in the conversation, the assumed one first, and a tap answers", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "the flow is viewport-independent; the activity spec covers 390 px",
    );
    await page.clock.setFixedTime(FIXED_NOW);
    await serveAiBlock(page, aiBlockAvailable());
    const stub: StubConversation = {
      id: CONVERSATION_ID,
      title: "Heart rate",
      messages: [],
      results: {},
      trails: {},
    };
    await serveConversation(page, stub);
    await installLiveCoachStream(page);
    await applyTheme(page, "light");
    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    await ask(page, stub);

    const asked = page
      .locator('[data-slot="coach-bubble-assistant"]')
      .filter({ hasText: ASKS });
    await expect(asked).toHaveCount(1);
    // 1. No card anywhere; the pills sit in the answer's own column.
    await expect(
      page.locator('[data-slot="coach-clarification-card"]'),
    ).toHaveCount(0);
    const pills = asked.locator('[data-slot="coach-suggested-replies"]');
    await expect(pills).toBeVisible();
    await expect(pills).toHaveAttribute(
      "data-message-id",
      "coach-clarify-e2e-a1",
    );
    const choices = pills.locator("[data-choice-id]");
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toHaveAttribute("data-choice-id", "c1");
    // 4. The trail stays closed.
    await expect(
      asked.locator('[data-slot="coach-turn-steps-toggle"]'),
    ).toHaveAttribute("aria-expanded", "false");

    // 2. A tap sends the label as the person's message.
    const walking = choices.nth(1);
    const label = (await walking.textContent())?.trim() ?? "";
    await walking.click();
    await expect(
      page
        .locator('[data-slot="coach-bubble-user"]')
        .filter({ hasText: label }),
    ).toBeVisible();
    await expect(pills).toHaveCount(0);
    const sent = await posts(page);
    expect(sent[1]).toMatchObject({
      conversationId: CONVERSATION_ID,
      message: label,
      clarification: { messageId: "coach-clarify-e2e-a1", choiceId: "c2" },
    });

    stub.messages.push(
      { id: "coach-clarify-e2e-u2", role: "user", content: label },
      {
        id: "coach-clarify-e2e-a2",
        role: "assistant",
        content: ANSWER,
        metricSource: { windows: ["last30days"], metrics: ["walking_hr"] },
      },
    );
    await feed(page, [
      ...tokens(ANSWER),
      done(CONVERSATION_ID, "coach-clarify-e2e-a2"),
    ]);
    await end(page);
    await expect(
      page
        .locator('[data-slot="coach-bubble-assistant"]')
        .filter({ hasText: ANSWER }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="coach-suggested-replies"]'),
    ).toHaveCount(0);
  });

  test("a typed answer answers the question too", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-independent; desktop run suffices",
    );
    await page.clock.setFixedTime(FIXED_NOW);
    await serveAiBlock(page, aiBlockAvailable());
    const stub: StubConversation = {
      id: CONVERSATION_ID,
      title: "Heart rate",
      messages: [],
      results: {},
      trails: {},
    };
    await serveConversation(page, stub);
    await installLiveCoachStream(page);
    await applyTheme(page, "dark");
    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    await ask(page, stub);
    await expect(
      page.locator('[data-slot="coach-suggested-replies"]'),
    ).toBeVisible();

    await page
      .locator('[data-slot="coach-input-textarea"]')
      .fill("the walking one");
    await page.locator('[data-slot="coach-input-send"]').click();
    await expect(
      page
        .locator('[data-slot="coach-bubble-user"]')
        .filter({ hasText: "the walking one" }),
    ).toBeVisible();
    const sent = await posts(page);
    expect(sent[1]).toMatchObject({
      message: "the walking one",
      clarification: { messageId: "coach-clarify-e2e-a1" },
    });
    expect(
      (sent[1].clarification as Record<string, unknown>).choiceId,
    ).toBeUndefined();
    await end(page);
  });
});
