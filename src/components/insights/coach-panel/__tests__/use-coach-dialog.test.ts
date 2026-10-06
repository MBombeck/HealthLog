/**
 * v1.39.4 — the client end of the dialog frames: step upserts, the request
 * fields a chip or an answered question adds, and which message the chips
 * and the clarification belong to.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (k: string) => k }),
}));

import type {
  CoachMessageDTO,
  CoachStep,
  CoachStreamEvent,
} from "@/lib/ai/coach/types";

import {
  parseSseChunk,
  resolveCoachSendTarget,
  upsertStep,
  type CoachStreamingMessage,
} from "../use-coach";
import { latestClarification, latestFollowUps } from "../message-thread";

const STEP: CoachStep = {
  id: "s1",
  tool: "get_sleep",
  labelKey: "coach.step.read",
  label: "Reading Sleep",
  domain: "sleep",
  status: "running",
};

const CHIP = {
  id: "f1",
  kind: "as_table" as const,
  labelKey: "coach.followUp.asTable",
  label: "Show as a table",
  reuse: true,
  origin: "server" as const,
};

const CLARIFY = { kind: "window" as const, choices: [], freeText: true };

function streaming(
  partial: Partial<CoachStreamingMessage>,
): CoachStreamingMessage {
  return {
    content: "",
    metricSource: null,
    suggestion: null,
    suggestedAction: null,
    steps: [],
    results: [],
    followUps: [],
    clarification: null,
    activity: [],
    interimRefs: [],
    memoryNote: null,
    planProposal: null,
    stop: null,
    startedAt: null,
    endedAt: null,
    inProgress: false,
    messageId: null,
    errorCode: null,
    usage: null,
    ...partial,
  };
}

function message(partial: Partial<CoachMessageDTO>): CoachMessageDTO {
  return {
    id: "m1",
    role: "assistant",
    content: "reply",
    createdAt: "2026-09-26T00:00:00.000Z",
    metricSource: null,
    providerType: "anthropic",
    promptVersion: null,
    tokensUsed: null,
    model: null,
    ...partial,
  };
}

describe("dialog frames on the client", () => {
  it("parses the new frames like any other", () => {
    const frames: CoachStreamEvent[] = [
      { type: "step", step: STEP },
      { type: "followUps", followUps: [CHIP] },
      { type: "clarification", clarification: CLARIFY },
    ];
    const { events } = parseSseChunk(
      "",
      frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
    );
    expect(events).toEqual(frames);
  });

  it("upserts a step by id, keeping first-seen order", () => {
    const second = { ...STEP, id: "s2" };
    let steps = upsertStep([], STEP);
    steps = upsertStep(steps, second);
    steps = upsertStep(steps, { ...STEP, status: "done", count: 12 });
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ["s1", "done"],
      ["s2", "running"],
    ]);
  });
});

describe("resolveCoachSendTarget — chips and answers", () => {
  it("carries followUp and clarification on the tool route", () => {
    const target = resolveCoachSendTarget({
      conversationId: "c1",
      message: "Show as a table",
      followUp: { messageId: "m1", id: "f1" },
      clarification: { messageId: "m0", choiceId: "c2" },
    });
    expect(target.url).toBe("/api/insights/chat");
    expect(JSON.parse(target.body)).toMatchObject({
      followUp: { messageId: "m1", id: "f1" },
      clarification: { messageId: "m0", choiceId: "c2" },
    });
  });

  it("never carries them to the fenced route", () => {
    const target = resolveCoachSendTarget({
      conversationId: "c1",
      message: "x",
      fenced: true,
      followUp: { messageId: "m1", id: "f1" },
      clarification: { messageId: "m0" },
    });
    expect(target.url).toBe("/api/insights/chat/fenced");
    const body = JSON.parse(target.body);
    expect(body).not.toHaveProperty("followUp");
    expect(body).not.toHaveProperty("clarification");
  });
});

describe("which message the chips and the question belong to", () => {
  const withChips = message({
    metricSource: {
      windows: [],
      metrics: [],
      followUps: [CHIP],
      clarification: CLARIFY,
    },
  });

  it("offers the latest persisted assistant message's chips", () => {
    expect(latestFollowUps([withChips], undefined)).toEqual({
      messageId: "m1",
      followUps: [CHIP],
    });
    expect(latestClarification([withChips], undefined)).toEqual({
      messageId: "m1",
      clarification: CLARIFY,
    });
  });

  it("offers nothing once the person replied, and nothing mid-turn", () => {
    const answered = [withChips, message({ id: "m2", role: "user" })];
    expect(latestFollowUps(answered, undefined)).toBeNull();
    expect(latestClarification(answered, undefined)).toBeNull();
    expect(
      latestFollowUps([withChips], streaming({ inProgress: true })),
    ).toBeNull();
  });

  it("prefers the just-settled streamed turn over an older message", () => {
    const live = streaming({
      messageId: "m9",
      followUps: [{ ...CHIP, id: "f2" }],
      clarification: CLARIFY,
    });
    expect(latestFollowUps([withChips], live)?.messageId).toBe("m9");
    expect(latestClarification([withChips], live)?.messageId).toBe("m9");
    // A settled streamed turn without chips hides an older message's.
    expect(
      latestFollowUps([withChips], streaming({ messageId: "m9" })),
    ).toBeNull();
  });
});
