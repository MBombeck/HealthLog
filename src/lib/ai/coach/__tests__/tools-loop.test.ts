/**
 * v1.20.0 (F1) — bounded Coach retrieval loop: tool dispatch round-trip, the
 * max-rounds cap with a forced-final answer, parallel tool execution, and the
 * summed-token accounting the budget reconcile depends on.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

const executeCoachTool = vi.fn<(args?: unknown) => Promise<CoachToolResult>>();
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: (args: unknown) => executeCoachTool(args),
}));

// The loop calls the real fallback runner; stub it to a deterministic
// per-round script so we exercise the loop control flow, not the chain.
const runRawCompletionWithFallback = vi.fn();
vi.mock("@/lib/ai/provider-runner", () => ({
  runRawCompletionWithFallback: (args: unknown) =>
    runRawCompletionWithFallback(args),
}));

import { runCoachToolLoop } from "@/lib/ai/coach/tools/loop";
import { createTurnBudget } from "@/lib/ai/coach/tools/turn-budget";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

function completion(opts: {
  content: string;
  tokensUsed?: number;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: "stop" | "tool_calls" | "length";
}) {
  return {
    result: {
      content: opts.content,
      tokensUsed: opts.tokensUsed ?? 10,
      model: "mock",
      providerType: "anthropic" as const,
      ...(opts.toolCalls ? { toolCalls: opts.toolCalls } : {}),
      finishReason: opts.finishReason,
    },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
  };
}

const baseArgs = {
  userId: "u1",
  providers: [],
  system: "sys",
  messages: [{ role: "user" as const, content: "how is my bp?" }],
  tools: COACH_TOOL_DEFS,
  reach: UNBOUNDED_REACH,
};

describe("runCoachToolLoop", () => {
  beforeEach(() => {
    executeCoachTool.mockReset();
    runRawCompletionWithFallback.mockReset();
  });

  it("runs one tool round then streams the final prose (happy path)", async () => {
    executeCoachTool.mockResolvedValue({ present: true, data: { x: 1 } });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          tokensUsed: 30,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c1",
              name: "get_metric_series",
              arguments: '{"metric":"bp"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({ content: "Your BP looks steady.", tokensUsed: 20 }),
      );

    const out = await runCoachToolLoop(baseArgs);

    expect(out.rounds).toBe(2);
    expect(out.result.content).toBe("Your BP looks steady.");
    expect(out.totalTokens).toBe(50); // summed across both rounds
    expect(out.toolTrace).toEqual([
      { name: "get_metric_series", present: true, args: { metric: "bp" } },
    ]);
    // v1.21.0 (P6) — the present result's payload is retained for the prose
    // number-verifier.
    expect(out.toolResults).toEqual([{ present: true, data: { x: 1 } }]);
    // The second call must forbid tools? No — round 2 still offers them
    // (round <= MAX_ROUNDS). It simply chose to answer.
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it("answers immediately when the model emits no tool calls", async () => {
    runRawCompletionWithFallback.mockResolvedValueOnce(
      completion({ content: "Here's what I can help with.", tokensUsed: 12 }),
    );
    const out = await runCoachToolLoop(baseArgs);
    expect(out.rounds).toBe(1);
    expect(out.toolTrace).toHaveLength(0);
    expect(executeCoachTool).not.toHaveBeenCalled();
  });

  it("executes parallel tool calls in one round", async () => {
    executeCoachTool.mockResolvedValue({ present: true });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "a",
              name: "get_metric_series",
              arguments: '{"metric":"bp"}',
            },
            { id: "b", name: "get_sleep", arguments: "{}" },
          ],
        }),
      )
      .mockResolvedValueOnce(completion({ content: "Combined view." }));

    const out = await runCoachToolLoop(baseArgs);
    expect(executeCoachTool).toHaveBeenCalledTimes(2);
    expect(out.toolTrace).toHaveLength(2);
    expect(out.result.content).toBe("Combined view.");
  });

  it("forces a final answer at the round cap (no infinite loop)", async () => {
    executeCoachTool.mockResolvedValue({ present: true, data: { v: 1 } });
    // The model asks for a new read every round. The loop must still
    // terminate: the round the cap allows last forbids tool calls
    // (toolChoice none), so the model is forced to produce prose.
    const metrics = ["bp", "weight", "pulse", "hrv", "steps", "sleep"];
    let n = 0;
    runRawCompletionWithFallback.mockImplementation(
      (args: { params: { toolChoice?: string } }) => {
        if (args.params.toolChoice === "none") {
          return Promise.resolve(
            completion({ content: "Final forced answer." }),
          );
        }
        n += 1;
        return Promise.resolve(
          completion({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `x${n}`,
                name: "get_metric_series",
                arguments: JSON.stringify({ metric: metrics[n] }),
              },
            ],
          }),
        );
      },
    );

    const out = await runCoachToolLoop({
      ...baseArgs,
      budget: createTurnBudget({
        payer: "operator",
        initialInputTokens: 10,
        limits: { tokens: 1e9, wallMs: 1e9, maxRounds: 6 },
      }),
    });
    expect(out.rounds).toBe(6);
    expect(out.result.content).toBe("Final forced answer.");
    expect(out.stop).toEqual({ reason: "cap", rounds: 6 });
    // The final round forbids calls with toolChoice "none" but still
    // carries the tool definitions: the history holds tool_use/tool_result
    // blocks, and Anthropic refuses those without `tools` (400).
    const lastCall =
      runRawCompletionWithFallback.mock.calls[
        runRawCompletionWithFallback.mock.calls.length - 1
      ][0];
    expect(lastCall.params.toolChoice).toBe("none");
    expect(lastCall.params.tools).toEqual(COACH_TOOL_DEFS);
    expect(lastCall.params.tools.length).toBeGreaterThan(0);
  });

  it("appends assistant(toolCalls) + tool turns to the message array", async () => {
    executeCoachTool.mockResolvedValue({ present: true, data: { v: 1 } });
    let secondCallMessages: unknown;
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "get_sleep", arguments: "{}" }],
        }),
      )
      .mockImplementationOnce((args: { params: { messages: unknown } }) => {
        secondCallMessages = args.params.messages;
        return Promise.resolve(completion({ content: "done" }));
      });

    await runCoachToolLoop(baseArgs);

    const msgs = secondCallMessages as Array<{
      role: string;
      toolCallId?: string;
      toolCalls?: unknown[];
    }>;
    // user, assistant(toolCalls), tool
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].toolCalls).toHaveLength(1);
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].toolCallId).toBe("c1");
  });
});

// v1.21.0 (D5-1) — the loop threads the turn's shared snapshot scope to every
// tool so each per-tool read lands one cache key (one snapshot build per turn).
describe("shared snapshot scope threading (D5-1)", () => {
  it("retains an out-of-window miss's availability payload for grounding", async () => {
    // A miss carries no `data`, so the pre-#648 filter (`if (present)`) dropped
    // it — and the figures the model is now told it MAY cite would have been
    // absent from the authoritative set, which is how a true sentence gets
    // elided as a hallucination. The miss rides `toolResults` when, and only
    // when, it actually delivered figures.
    executeCoachTool.mockResolvedValueOnce({
      present: false,
      reason: "outside_window",
      searchedWindow: "allTime",
      available: {
        count: 1597,
        firstDate: "2024-04-03",
        lastDate: "2024-04-17",
        reachableWithWindow: null,
      },
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "get_glucose_panel", arguments: "{}" }],
        }),
      )
      .mockResolvedValueOnce(completion({ content: "done" }));
    const out = await runCoachToolLoop(baseArgs);
    expect(out.toolResults).toHaveLength(1);
    expect(out.toolResults[0].available).toMatchObject({ count: 1597 });
    expect(out.toolTrace).toEqual([
      { name: "get_glucose_panel", present: false, args: {} },
    ]);
  });

  it("still drops a miss that delivered no figures", async () => {
    executeCoachTool.mockResolvedValueOnce({
      present: false,
      reason: "no_data",
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "get_glucose_panel", arguments: "{}" }],
        }),
      )
      .mockResolvedValueOnce(completion({ content: "done" }));
    const out = await runCoachToolLoop(baseArgs);
    expect(out.toolResults).toEqual([]);
  });

  it("passes sharedScope through to executeCoachTool", async () => {
    executeCoachTool.mockResolvedValue({ present: true, data: { x: 1 } });
    const shared = {
      sources: ["bp", "hrv"] as never,
      window: "last30days" as const,
    };
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        completion({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c1",
              name: "get_metric_series",
              arguments: '{"metric":"bp"}',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(completion({ content: "done" }));
    await runCoachToolLoop({ ...baseArgs, sharedScope: shared });
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({ sharedScope: shared }),
    );
  });
});
