/**
 * v1.41 — what the latest answer waits for (a clarifying question, a fact
 * proposal, a plan proposal) becomes reply pills, and a tap answers it.
 */
import { describe, expect, it, vi } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { CoachMessageDTO, CoachProvenance } from "@/lib/ai/coach/types";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));

import {
  decisionReplies,
  latestDecision,
  type CoachReplyIntent,
} from "../message-thread";
import type { CoachStreamingMessage } from "../use-coach";

const { t } = getServerTranslator("en");

function assistant(id: string, metricSource: Partial<CoachProvenance>) {
  return {
    id,
    role: "assistant",
    content: "…",
    createdAt: "2026-10-06T10:00:00.000Z",
    metricSource: { windows: [], metrics: [], ...metricSource },
    providerType: "mock",
    promptVersion: null,
    tokensUsed: null,
    model: null,
  } as unknown as CoachMessageDTO;
}
const user = (id: string) =>
  ({
    id,
    role: "user",
    content: "Yes",
    createdAt: "2026-10-06T10:01:00.000Z",
    metricSource: null,
  }) as unknown as CoachMessageDTO;

const CLARIFY = {
  kind: "metric" as const,
  freeText: true,
  assumption: "c2",
  choices: [
    {
      id: "c1",
      labelKey: "insights.coach.metric.pulse",
      label: "Pulse",
      value: { metric: "pulse" as const },
    },
    {
      id: "c2",
      labelKey: "insights.coach.metric.resting_hr",
      label: "Resting HR",
      value: { metric: "resting_hr" as const },
    },
  ],
};

function collect() {
  const sent: CoachReplyIntent[] = [];
  return { sent, onReply: (intent: CoachReplyIntent) => sent.push(intent) };
}

describe("latestDecision", () => {
  it("is the latest answer's open question or proposal", () => {
    const msgs = [
      assistant("a1", {
        memoryNote: {
          proposal: true,
          proposalId: "p1",
          category: "medication",
        },
      }),
    ];
    expect(latestDecision(msgs, undefined)).toEqual({
      messageId: "a1",
      clarification: null,
      memoryProposalId: "p1",
      planId: null,
    });
  });

  it("is gone once the person has answered", () => {
    const msgs = [assistant("a1", { clarification: CLARIFY }), user("u2")];
    expect(latestDecision(msgs, undefined)).toBeNull();
  });

  it("offers nothing while a turn runs, and nothing for a saved note", () => {
    const msgs = [assistant("a1", { clarification: CLARIFY })];
    expect(
      latestDecision(msgs, { inProgress: true } as CoachStreamingMessage),
    ).toBeNull();
    expect(
      latestDecision(
        [
          assistant("a1", {
            memoryNote: { proposal: false, factId: "f1", category: "goal" },
          }),
        ],
        undefined,
      ),
    ).toBeNull();
  });

  it("reads the just-streamed turn before its persisted copy lands", () => {
    const streaming = {
      inProgress: false,
      messageId: "a9",
      clarification: null,
      memoryNote: null,
      planProposal: {
        planId: "plan1",
        metric: "WEIGHT",
        reviewInDays: 14,
        ifCue: "after dinner",
        thenAction: "walk",
      },
    } as unknown as CoachStreamingMessage;
    expect(latestDecision([], streaming)?.planId).toBe("plan1");
  });
});

describe("decisionReplies", () => {
  it("puts the assumed choice first and sends it as a clarification", () => {
    const { sent, onReply } = collect();
    const replies = decisionReplies(
      {
        messageId: "a1",
        clarification: CLARIFY,
        memoryProposalId: null,
        planId: null,
      },
      t,
      onReply,
    );
    expect(replies.map((r) => r.label)).toEqual(["Resting HR", "Pulse"]);
    replies[0].onSelect();
    expect(sent[0]).toMatchObject({
      kind: "clarification",
      messageId: "a1",
      choice: { id: "c2" },
      label: "Resting HR",
    });
  });

  it("confirms a fact proposal with Yes and declines it with No", () => {
    const { sent, onReply } = collect();
    const replies = decisionReplies(
      {
        messageId: "a1",
        clarification: null,
        memoryProposalId: "p1",
        planId: null,
      },
      t,
      onReply,
    );
    expect(replies.map((r) => r.label)).toEqual(["Yes, remember it", "No"]);
    replies[0].onSelect();
    replies[1].onSelect();
    expect(sent).toEqual([
      {
        kind: "memory",
        messageId: "a1",
        proposalId: "p1",
        accept: true,
        label: "Yes, remember it",
      },
      {
        kind: "memory",
        messageId: "a1",
        proposalId: "p1",
        accept: false,
        label: "No",
      },
    ]);
  });

  it("takes on or postpones a plan", () => {
    const { sent, onReply } = collect();
    const replies = decisionReplies(
      {
        messageId: "a1",
        clarification: null,
        memoryProposalId: null,
        planId: "plan1",
      },
      getServerTranslator("de").t,
      onReply,
    );
    expect(replies.map((r) => r.label)).toEqual([
      "Plan übernehmen",
      "Nicht jetzt",
    ]);
    replies[1].onSelect();
    expect(sent[0]).toEqual({
      kind: "plan",
      messageId: "a1",
      planId: "plan1",
      accept: false,
      label: "Nicht jetzt",
    });
  });
});
