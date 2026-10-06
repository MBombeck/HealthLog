/**
 * v1.39.4 — "keep looking" through the turn pipeline: a forced answer offers
 * the chip first; tapping it runs a normal model turn (the budget gate
 * applies) with the continuation lines, records what it continues, and
 * offers no second "keep looking" even when it is forced again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  annotate: vi.fn(),
  resolveTurnConversation: vi.fn(),
  persistUserTurn: vi.fn(),
  assembleTurnContext: vi.fn(),
  resolveTurnChain: vi.fn(),
  reserveTurnBudget: vi.fn(),
  runTurnModel: vi.fn(),
  guardReply: vi.fn(),
  surfaceCards: vi.fn(),
  persistAssistantReply: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { coachMessage: { findMany: m.findMany } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: m.annotate }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  encryptToBytes: vi.fn(),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock("../conversation", () => ({
  resolveTurnConversation: m.resolveTurnConversation,
  persistUserTurn: m.persistUserTurn,
}));
vi.mock("../context", () => ({ assembleTurnContext: m.assembleTurnContext }));
vi.mock("../chain", () => ({ resolveTurnChain: m.resolveTurnChain }));
vi.mock("../budget", () => ({
  reserveTurnBudget: m.reserveTurnBudget,
}));
vi.mock("../model", () => ({ runTurnModel: m.runTurnModel }));
vi.mock("../reply-guards", () => ({ guardReply: m.guardReply }));
vi.mock("../cards", () => ({ surfaceCards: m.surfaceCards }));
vi.mock("../persist", () => ({
  persistAssistantReply: m.persistAssistantReply,
}));

import type { CoachProvenance, CoachStreamEvent } from "@/lib/ai/coach/types";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

import { runCoachTurn } from "../pipeline";
import { STUB_PROMPT_CONTEXT, modelExtras, stubLedger } from "./turn-test-kit";
import type { TurnInput } from "../types";

const bytes = (text: string) => new TextEncoder().encode(text);

function input(over: Partial<TurnInput> = {}): TurnInput {
  return {
    userId: "u1",
    locale: "en",
    signal: new AbortController().signal,
    conversationId: "c1",
    message: "Keep looking",
    scope: undefined,
    guidedQuestion: undefined,
    workoutId: undefined,
    followUp: undefined,
    clarification: undefined,
    recheckCapability: async () => null,
    ...over,
  };
}

async function frames(res: Response): Promise<CoachStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as CoachStreamEvent);
}

function modelPath(forcedFinal: boolean) {
  m.assembleTurnContext.mockResolvedValue({
    ...STUB_PROMPT_CONTEXT,
    coachPrefs: DEFAULT_COACH_PREFS,
    snapshot: { provenance: { windows: [], metrics: [] } },
  });
  m.resolveTurnChain.mockResolvedValue({ ok: true, chain: [], toolMode: true });
  m.reserveTurnBudget.mockResolvedValue({ ok: true, ledger: stubLedger() });
  m.runTurnModel.mockResolvedValue({
    ...modelExtras(),
    ok: true,
    result: { content: "x", model: "gpt" },
    workingProviderType: "openai",
    toolTrace: [],
    totalTokens: 12,
    cachedTokens: 0,
    steps: [],
    results: [],
    forcedFinal,
    inventory: [],
  });
  m.guardReply.mockResolvedValue({
    ok: true,
    reply: {
      replyText: "Partial.",
      outboundBlocked: false,
      referencedResults: [],
      followUpProposals: [],
      clarification: null,
      keyValuesSentinel: {
        keyValues: [],
        malformed: false,
        malformedEntries: [],
      },
      groundedFigures: [],
      unverifiedStripped: 0,
    },
  });
  m.surfaceCards.mockResolvedValue({ suggestion: null, action: null });
  m.persistAssistantReply.mockResolvedValue({ messageId: "m-new" });
}

function persistedProvenance(): CoachProvenance {
  return m.persistAssistantReply.mock.calls[0][0].provenance;
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resolveTurnConversation.mockResolvedValue({
    conversation: {
      conversationId: "c1",
      priorTurns: [],
      priorUserMessages: [],
      priorToolFigures: [],
      priorSummary: null,
      priorResults: [],
    },
  });
});

describe("a forced answer", () => {
  it("offers 'keep looking' first", async () => {
    modelPath(true);
    const out = await frames(await runCoachTurn(input()));
    const chips = out.find((f) => f.type === "followUps");
    expect(chips?.type === "followUps" && chips.followUps[0]).toMatchObject({
      id: "f1",
      kind: "continue",
      label: "Keep looking",
    });
    expect(persistedProvenance().forcedFinal).toBe(true);
  });

  it("offers nothing to continue when the answer was not forced", async () => {
    modelPath(false);
    const out = await frames(await runCoachTurn(input()));
    expect(out.some((f) => f.type === "followUps")).toBe(false);
  });
});

describe("the continued turn", () => {
  beforeEach(() => {
    m.findMany.mockResolvedValue([
      {
        id: "m-forced",
        role: "assistant",
        providerType: "openai",
        encryptedContent: bytes("Partial."),
        metricSourceJson: JSON.stringify({
          windows: [],
          metrics: [],
          forcedFinal: true,
          followUps: [
            {
              id: "f1",
              kind: "continue",
              labelKey: "coach.followUp.continue",
              label: "Keep looking",
              reuse: false,
              origin: "server",
            },
          ],
        }),
      },
      {
        id: "m-q",
        role: "user",
        providerType: null,
        encryptedContent: bytes("Why is my pulse up?"),
        metricSourceJson: null,
      },
    ]);
  });

  it("runs the model under the budget gate with the continuation lines", async () => {
    modelPath(false);
    await frames(
      await runCoachTurn(
        input({ followUp: { messageId: "m-forced", id: "f1" } }),
      ),
    );
    expect(m.reserveTurnBudget).toHaveBeenCalledTimes(1);
    const { turnHints } = m.runTurnModel.mock.calls[0][0];
    expect(turnHints).toEqual([
      expect.stringContaining("The unfinished question is their message"),
    ]);
    // The question itself stays in the transcript, never in the hint.
    expect(turnHints[0]).not.toContain("Why is my pulse up?");
    expect(persistedProvenance().continuationOf).toBe("m-forced");
  });

  it("offers no second 'keep looking' when forced again", async () => {
    modelPath(true);
    const out = await frames(
      await runCoachTurn(
        input({ followUp: { messageId: "m-forced", id: "f1" } }),
      ),
    );
    const chips = out.find((f) => f.type === "followUps");
    expect(
      chips?.type === "followUps" &&
        chips.followUps.some((c) => c.kind === "continue"),
    ).toBeFalsy();
    expect(persistedProvenance()).toMatchObject({
      forcedFinal: true,
      continuationOf: "m-forced",
    });
  });

  it("stops at the budget gate like any turn", async () => {
    modelPath(false);
    m.reserveTurnBudget.mockResolvedValue({
      ok: false,
      response: new Response("budget", { status: 200 }),
    });
    const res = await runCoachTurn(
      input({ followUp: { messageId: "m-forced", id: "f1" } }),
    );
    expect(await res.text()).toBe("budget");
    expect(m.runTurnModel).not.toHaveBeenCalled();
  });
});
