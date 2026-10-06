/**
 * v1.41 — the reply frames of a turn with a fact note, a plan proposal, a
 * forced stop and interim tables taken down again: each additive, in the
 * promised order, `done` carrying the stop and the withdrawal.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
}));

import type { CoachStreamEvent } from "@/lib/ai/coach/types";
import { coachStreamEventSchema } from "@/lib/ai/coach/stream-events";

import { emitReply } from "../sse";

function collect() {
  const frames: CoachStreamEvent[] = [];
  return {
    frames,
    emitter: {
      emit: (f: CoachStreamEvent) => frames.push(f),
      aborted: () => false,
    },
  };
}

const base = {
  ok: true as const,
  replyText: "Steady.",
  provenance: { windows: [], metrics: [] },
  suggestion: null,
  action: null,
  results: [],
  followUps: [],
  clarification: null,
  messageId: "m1",
  totalTokens: 10,
  model: "gpt",
};

describe("emitReply, v1.41 frames", () => {
  it("sends the note and the proposal after the cards, and the stop on done", async () => {
    const { frames, emitter } = collect();
    await emitReply(
      emitter,
      {
        ...base,
        memoryNote: {
          proposal: false,
          factId: "f1",
          category: "goal",
          fact: "Wants to reach 75 kg by December",
        },
        planProposal: {
          planId: "plan-1",
          metric: "WEIGHT",
          reviewInDays: 14,
          ifCue: "after dinner",
          thenAction: "walk for fifteen minutes",
        },
        stop: { reason: "time", rounds: 5 },
        withheldResults: true,
      },
      "c1",
    );
    expect(frames.map((f) => f.type)).toEqual([
      "token",
      "provenance",
      "memoryNote",
      "planProposal",
      "done",
    ]);
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      stop: { reason: "time", rounds: 5 },
      withheldResults: true,
    });
    // Every frame parses against the wire schema the clients share.
    for (const frame of frames) {
      expect(coachStreamEventSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("adds nothing to a plain reply", async () => {
    const { frames, emitter } = collect();
    await emitReply(emitter, { ...base, withheldResults: false }, "c1");
    expect(frames.map((f) => f.type)).toEqual(["token", "provenance", "done"]);
    expect(frames.at(-1)).not.toHaveProperty("stop");
    expect(frames.at(-1)).not.toHaveProperty("withheldResults");
  });
});
