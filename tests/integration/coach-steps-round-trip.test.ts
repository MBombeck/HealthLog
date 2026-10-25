/**
 * The steps of a long Coach answer survive a reload against a real Postgres.
 *
 * The turn records up to `MAX_TURN_STEPS` steps on `metricSource.steps`; the
 * read path restores them from `coach_messages.metric_source_json`. Both ends
 * read the one constant, so a full turn's worth comes back whole and an
 * over-long stored blob is cut at that cap, not before it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_TURN_STEPS } from "@/lib/ai/coach/activity/contract";
import {
  appendMessage,
  createConversation,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";
import type { CoachStep } from "@/lib/ai/coach/types";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

function step(n: number): CoachStep {
  return {
    id: `s${n}`,
    tool: "get_metric_series",
    labelKey: "coach.step.readWindow",
    label: "Read the last 30 days",
    domain: "bp",
    window: "last30days",
    status: "done",
    count: n,
  };
}

const RECORDED = Array.from({ length: MAX_TURN_STEPS }, (_, i) => step(i + 1));

async function seedConversation(): Promise<{
  userId: string;
  conversationId: string;
}> {
  const user = await getPrismaClient().user.create({
    data: { username: "steps-owner", role: "USER" },
  });
  const convo = await createConversation({ userId: user.id, title: "long" });
  return { userId: user.id, conversationId: convo.id };
}

describe("Coach steps across a reload", () => {
  it("restores every step of a full turn", async () => {
    const { userId, conversationId } = await seedConversation();
    const reply = await appendMessage({
      conversationId,
      role: "assistant",
      content: "A long answer.",
      metricSource: { windows: [], metrics: [], steps: RECORDED },
    });

    const reloaded = await fetchConversationWithMessages(
      userId,
      conversationId,
    );
    const message = reloaded?.messages.find((m) => m.id === reply.id);
    expect(message?.metricSource?.steps).toHaveLength(MAX_TURN_STEPS);
    expect(message?.metricSource?.steps).toEqual(RECORDED);
  });

  it("cuts an over-long stored blob at the cap, not before it", async () => {
    const { userId, conversationId } = await seedConversation();
    const reply = await appendMessage({
      conversationId,
      role: "assistant",
      content: "An over-long blob.",
      metricSource: { windows: [], metrics: [] },
    });
    await getPrismaClient().coachMessage.update({
      where: { id: reply.id },
      data: {
        metricSourceJson: JSON.stringify({
          windows: [],
          metrics: [],
          steps: [...RECORDED, step(MAX_TURN_STEPS + 1)],
        }),
      },
    });

    const reloaded = await fetchConversationWithMessages(
      userId,
      conversationId,
    );
    const message = reloaded?.messages.find((m) => m.id === reply.id);
    expect(message?.metricSource?.steps).toEqual(RECORDED);
  });
});
