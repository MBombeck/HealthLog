/**
 * v1.41 — the budgeted loop: every stop reason forces a final round with
 * `toolChoice: "none"` (the tool definitions stay) and the reason line, the ledger is reserved and settled round
 * by round, a repeated call is never run, a question ends the turn, the
 * reasoning level and the provider state reach the provider, and the trail
 * opens its thinking entry before the provider is called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

const executeCoachTool = vi.fn<(args?: unknown) => Promise<CoachToolResult>>();
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: (args: unknown) => executeCoachTool(args),
}));
const runRawCompletionWithFallback = vi.fn();
vi.mock("@/lib/ai/provider-runner", () => ({
  runRawCompletionWithFallback: (args: unknown) =>
    runRawCompletionWithFallback(args),
}));
const runDialogTool = vi.fn();
vi.mock("@/lib/ai/coach/tools/dialog-tools", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDialogTool: (args: unknown) => runDialogTool(args),
}));
const runCompareSeries = vi.fn();
vi.mock("@/lib/ai/coach/tools/compare-series", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runCompareSeries: (args: unknown) => runCompareSeries(args),
}));

import { runCoachToolLoop, type RoundSpend } from "@/lib/ai/coach/tools/loop";
import { createTurnBudget } from "@/lib/ai/coach/tools/turn-budget";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { createActivityRecorder } from "@/lib/ai/coach/activity/recorder";
import type { CoachActivity, CoachClarification } from "@/lib/ai/coach/types";

type Call = { id: string; name: string; arguments: string };

function round(
  content: string,
  toolCalls?: Call[],
  extra: Record<string, unknown> = {},
) {
  return {
    result: {
      content,
      tokensUsed: 100,
      model: "mock",
      providerType: "codex" as const,
      ...(toolCalls
        ? { toolCalls, finishReason: "tool_calls" as const }
        : { finishReason: "stop" as const }),
      ...extra,
    },
    workingProvider: { providerType: "codex" },
    fallbackHops: [],
  };
}

const table = (metric: string, window = "last30days"): Call => ({
  id: `${metric}-${window}`,
  name: "get_metric_table",
  arguments: JSON.stringify({ metric, window }),
});

const roomy = () =>
  createTurnBudget({
    payer: "user",
    initialInputTokens: 10,
    limits: { tokens: 1e9, wallMs: 1e9, maxRounds: 12 },
  });

const baseArgs = {
  userId: "u1",
  providers: [],
  system: "sys",
  messages: [{ role: "user" as const, content: "why?" }],
  tools: COACH_TOOL_DEFS,
  reach: UNBOUNDED_REACH,
};

function spend(admit: boolean[] = []): RoundSpend & {
  reserveRound: ReturnType<typeof vi.fn>;
  settleRound: ReturnType<typeof vi.fn>;
} {
  const reserveRound = vi.fn(async () => admit.shift() ?? true);
  const settleRound = vi.fn(async () => {});
  return { reserveRound, settleRound };
}

/** Every stop ends on a round that forbids calls but keeps the definitions. */
function expectFinalRoundKeepsTools() {
  expect(lastParams().toolChoice).toBe("none");
  expect(lastParams().tools).toEqual(COACH_TOOL_DEFS);
}

function lastParams() {
  const calls = runRawCompletionWithFallback.mock.calls;
  return calls[calls.length - 1][0].params as {
    system: string;
    toolChoice?: string;
    tools?: unknown[];
  };
}

beforeEach(() => {
  executeCoachTool.mockReset();
  runRawCompletionWithFallback.mockReset();
  runDialogTool.mockReset();
  runCompareSeries.mockReset();
  executeCoachTool.mockResolvedValue({ present: true, data: { mean: 1 } });
});

describe("stop reasons", () => {
  it("answers from the reserve when the token budget runs out", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")]))
      .mockResolvedValueOnce(round("Answer from what I have."));
    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: createTurnBudget({
        payer: "operator",
        initialInputTokens: 10,
        limits: { tokens: 500, wallMs: 1e9, maxRounds: 12 },
      }),
    });
    expect(out.stop).toEqual({ reason: "budget", rounds: 2 });
    expect(out.forcedFinal).toBe(true);
    expect(lastParams().toolChoice).toBe("none");
    // The tools stay on the final round: the history holds the calls, and
    // Anthropic refuses tool_use/tool_result blocks without `tools` (400).
    expect(lastParams().tools).toEqual(COACH_TOOL_DEFS);
    expect(lastParams().system).toMatch(
      /FINAL ROUND: this turn's token budget/,
    );
    expect(out.result.content).toBe("Answer from what I have.");
  });

  it("answers when the wall time would run out", async () => {
    let now = 0;
    runRawCompletionWithFallback.mockImplementation(async () => {
      now += 50_000;
      return lastParamsSafe() === "none"
        ? round("late answer")
        : round("", [table("bp")]);
    });
    function lastParamsSafe() {
      const calls = runRawCompletionWithFallback.mock.calls;
      return calls.length > 0
        ? (calls[calls.length - 1][0].params.toolChoice as string)
        : "auto";
    }
    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: createTurnBudget({
        payer: "operator",
        initialInputTokens: 10,
        now: () => now,
        limits: { tokens: 1e9, wallMs: 90_000, maxRounds: 12 },
      }),
    });
    expect(out.stop?.reason).toBe("time");
    expect(out.forcedFinal).toBe(true);
    expectFinalRoundKeepsTools();
  });

  it("answers when the daily ledger refuses the next round", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")]))
      .mockResolvedValueOnce(round("", [table("weight")]))
      .mockResolvedValueOnce(round("Ledger closed, here is what I have."));
    const ledger = spend([true, false]);
    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: roomy(),
      spend: ledger,
    });
    expect(out.stop).toEqual({ reason: "budget", rounds: 3 });
    expect(ledger.reserveRound).toHaveBeenCalledTimes(2);
    expectFinalRoundKeepsTools();
    // Three rounds settled; only the last against the final reserve.
    expect(ledger.settleRound.mock.calls.map((c) => c[0].final)).toEqual([
      false,
      false,
      true,
    ]);
    expect(ledger.settleRound.mock.calls[0][0]).toMatchObject({
      tokens: 100,
      cachedTokens: 0,
      servedBy: "codex",
    });
  });

  it("does not offer to keep looking after a no-progress stop", async () => {
    executeCoachTool.mockResolvedValue({ present: false, reason: "no_data" });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")]))
      .mockResolvedValueOnce(round("", [table("weight")]))
      .mockResolvedValueOnce(round("Nothing recorded for those."));
    const out = await runCoachToolLoop({ ...baseArgs, budget: roomy() });
    expect(out.stop).toEqual({ reason: "no_progress", rounds: 3 });
    expect(out.forcedFinal).toBe(false);
    expectFinalRoundKeepsTools();
    expect(lastParams().system).toMatch(/brought nothing new/);
  });
});

describe("repeated calls", () => {
  it("never runs a call twice and tells the model which call it repeats", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")]))
      .mockResolvedValueOnce(
        round("", [{ ...table("bp"), id: "again" }, table("weight")]),
      )
      .mockResolvedValueOnce(round("done"));
    const out = await runCoachToolLoop({ ...baseArgs, budget: roomy() });
    expect(executeCoachTool).toHaveBeenCalledTimes(2);
    const third = runRawCompletionWithFallback.mock.calls[2][0].params
      .messages as Array<{
      role: string;
      toolCallId?: string;
      content: string;
    }>;
    const repeat = third.find(
      (m) => m.role === "tool" && m.toolCallId === "again",
    );
    expect(JSON.parse(repeat!.content)).toEqual({
      present: false,
      reason: "duplicate",
      duplicateOf: "bp-last30days",
    });
    expect(out.toolTrace.map((t) => t.name)).toEqual([
      "get_metric_table",
      "get_metric_table",
    ]);
  });

  it("brakes when a whole round only repeats", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")]))
      .mockResolvedValueOnce(round("", [{ ...table("bp"), id: "x" }]))
      .mockResolvedValueOnce(round("enough"));
    const out = await runCoachToolLoop({ ...baseArgs, budget: roomy() });
    expect(out.stop).toEqual({ reason: "no_progress", rounds: 3 });
    expect(executeCoachTool).toHaveBeenCalledTimes(1);
    expectFinalRoundKeepsTools();
  });
});

describe("dialog and comparison tools", () => {
  const CLARIFY: CoachClarification = {
    kind: "metric",
    choices: [
      {
        id: "c1",
        labelKey: "insights.coach.metric.resting_hr",
        label: "Resting heart rate",
        value: { metric: "resting_hr" },
      },
      {
        id: "c2",
        labelKey: "insights.coach.metric.walking_hr",
        label: "Walking heart rate",
        value: { metric: "walking_hr" },
      },
    ],
    freeText: true,
    assumption: "c1",
  };

  it("ends the turn on a question, with no prose round", async () => {
    runDialogTool.mockResolvedValue({
      kind: "ask",
      result: { asked: true },
      question: "Resting or walking pulse? Otherwise I'll use resting.",
      clarification: CLARIFY,
    });
    runRawCompletionWithFallback.mockResolvedValueOnce(
      round("", [
        {
          id: "q",
          name: "ask_clarification",
          arguments: JSON.stringify({ kind: "metric", question: "x?" }),
        },
      ]),
    );
    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: roomy(),
      dialog: {
        userId: "u1",
        conversationId: "c1",
        locale: "en",
        userMessage: "how is my pulse?",
        inventory: [],
        conversationWindowSet: false,
      },
    });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(out.clarification?.clarification).toEqual(CLARIFY);
    expect(out.result.content).toBe(
      "Resting or walking pulse? Otherwise I'll use resting.",
    );
    expect(out.stop).toBeUndefined();
  });

  it("keeps a question the brake declined as an assumption and goes on", async () => {
    runDialogTool.mockResolvedValue({
      kind: "declined",
      result: { declined: "rate", assume: "Resting heart rate" },
      clarification: CLARIFY,
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          {
            id: "q",
            name: "ask_clarification",
            arguments: JSON.stringify({ kind: "metric", question: "x?" }),
          },
        ]),
      )
      .mockResolvedValueOnce(round("Assumed resting pulse: steady."));
    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: roomy(),
      dialog: {
        userId: "u1",
        conversationId: "c1",
        locale: "en",
        userMessage: "how is my pulse?",
        inventory: [],
        conversationWindowSet: false,
      },
    });
    expect(out.clarification).toBeUndefined();
    expect(out.declinedClarifications).toEqual([CLARIFY]);
    expect(out.result.content).toBe("Assumed resting pulse: steady.");
  });

  it("declines every dialog tool when the turn gives the loop no dialog context", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          {
            id: "r",
            name: "remember_fact",
            arguments: JSON.stringify({
              category: "goal",
              fact: "x",
              why: "y",
            }),
          },
        ]),
      )
      .mockResolvedValueOnce(round("ok"));
    const out = await runCoachToolLoop({ ...baseArgs, budget: roomy() });
    expect(runDialogTool).not.toHaveBeenCalled();
    expect(out.memoryNote).toBeUndefined();
  });

  it("runs compare_series outside the executor", async () => {
    runCompareSeries.mockResolvedValue({
      present: true,
      data: { mode: "periods" },
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          {
            id: "cmp",
            name: "compare_series",
            arguments: JSON.stringify({ mode: "periods", metric: "bp" }),
          },
        ]),
      )
      .mockResolvedValueOnce(round("Higher than last month."));
    const out = await runCoachToolLoop({ ...baseArgs, budget: roomy() });
    expect(runCompareSeries).toHaveBeenCalledTimes(1);
    expect(executeCoachTool).not.toHaveBeenCalled();
    expect(out.toolTrace).toEqual([
      {
        name: "compare_series",
        present: true,
        args: { mode: "periods", metric: "bp" },
      },
    ]);
  });
});

describe("reasoning, provider state and the trail", () => {
  it("sends the reasoning level and hands the provider state back on the next round", async () => {
    const state = {
      providerType: "codex",
      model: "gpt",
      items: [{ enc: "x" }],
    };
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [table("bp")], { providerState: state }))
      .mockResolvedValueOnce(round("done"));
    await runCoachToolLoop({
      ...baseArgs,
      budget: roomy(),
      reasoning: { effort: "medium", summaries: true },
    });
    const first = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(first.reasoning).toEqual({ effort: "medium", summaries: true });
    expect(typeof first.onReasoning).toBe("function");
    const second = runRawCompletionWithFallback.mock.calls[1][0].params
      .messages as Array<{ role: string; providerState?: unknown }>;
    expect(second.find((m) => m.role === "assistant")?.providerState).toEqual(
      state,
    );
  });

  it("opens the thinking entry before the provider is called, and fills it from the reasoning", async () => {
    const events: string[] = [];
    const frames: CoachActivity[] = [];
    const activity = createActivityRecorder({
      emit: (a) => {
        frames.push(a);
        events.push(`${a.phase}:${a.status}`);
      },
      screen: { locale: "en", figures: () => [] },
    });
    runRawCompletionWithFallback.mockImplementationOnce(
      async (args: {
        params: { onReasoning?: (e: { kind: string; text: string }) => void };
      }) => {
        events.push("provider");
        args.params.onReasoning?.({
          kind: "title",
          text: "**Weighing the weeks**",
        });
        args.params.onReasoning?.({
          kind: "text",
          text: "Sleep first, then the pulse.",
        });
        return round("Steady.");
      },
    );
    await runCoachToolLoop({
      ...baseArgs,
      budget: roomy(),
      activity,
      locale: "en",
      reasoning: { effort: "low", summaries: true },
    });
    expect(events[0]).toBe("thinking:running");
    expect(events[1]).toBe("provider");
    const done = frames.filter((f) => f.phase === "thinking").at(-1)!;
    expect(done.status).toBe("done");
    expect(done.title).toBe("Weighing the weeks");
    expect(done.text).toBe("Sleep first, then the pulse.");
    // The persisted metadata carries no model text.
    expect(JSON.stringify(activity.meta())).not.toContain("Weighing");
    expect(activity.trail()?.entries[0]).toMatchObject({
      title: "Weighing the weeks",
    });
  });
});
