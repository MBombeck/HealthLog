/**
 * v1.39.4 — the loop's progress seam: every call that starts settles, the
 * trace keeps only schema-validated arguments, and a forced answer at the
 * round cap is reported as such.
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

import { HARD_CAP, runCoachToolLoop } from "@/lib/ai/coach/tools/loop";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

type Call = { id: string; name: string; arguments: string };

function round(content: string, toolCalls?: Call[]) {
  return {
    result: {
      content,
      tokensUsed: 5,
      model: "mock",
      providerType: "anthropic" as const,
      ...(toolCalls
        ? { toolCalls, finishReason: "tool_calls" as const }
        : { finishReason: "stop" as const }),
    },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
  };
}

const baseArgs = {
  userId: "u1",
  providers: [],
  system: "sys",
  messages: [{ role: "user" as const, content: "q" }],
  tools: COACH_TOOL_DEFS,
  reach: UNBOUNDED_REACH,
};

beforeEach(() => {
  executeCoachTool.mockReset();
  runRawCompletionWithFallback.mockReset();
});

describe("runCoachToolLoop — progress callbacks", () => {
  it("settles every call that started, misses and invalid calls included, with turn-wide indexes", async () => {
    executeCoachTool
      .mockResolvedValueOnce({ present: true, data: {} })
      .mockResolvedValueOnce({ present: false, reason: "invalid_arguments" })
      .mockResolvedValueOnce({ present: false, reason: "unknown_tool" });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          { id: "a", name: "get_metric_series", arguments: '{"metric":"bp"}' },
          { id: "b", name: "get_sleep", arguments: "{not json" },
        ]),
      )
      .mockResolvedValueOnce(
        round("", [{ id: "c", name: "get_everything", arguments: "{}" }]),
      )
      .mockResolvedValueOnce(round("answer"));

    const started: Array<[string, number]> = [];
    const settled: Array<[string, boolean, number]> = [];
    const out = await runCoachToolLoop({
      ...baseArgs,
      onCallStart: (call, index) => started.push([call.id, index]),
      onCallSettled: (call, result, index) =>
        settled.push([call.id, result.present, index]),
    });

    expect(started).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect([...settled].sort((x, y) => x[2] - y[2])).toEqual([
      ["a", true, 0],
      ["b", false, 1],
      ["c", false, 2],
    ]);
    expect(out.forcedFinal).toBe(false);
  });

  it("keeps only schema-validated arguments on the trace", async () => {
    executeCoachTool.mockResolvedValue({ present: false });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          { id: "a", name: "get_metric_series", arguments: '{"metric":"bp"}' },
          // Unknown key: the strict schema refuses it.
          {
            id: "b",
            name: "get_metric_series",
            arguments: '{"metric":"bp","userId":"someone-else"}',
          },
          { id: "c", name: "get_sleep", arguments: "{not json" },
        ]),
      )
      .mockResolvedValueOnce(round("answer"));

    const out = await runCoachToolLoop(baseArgs);
    const byArgs = out.toolTrace.map((t) => t.args ?? null);
    expect(byArgs).toContainEqual({ metric: "bp" });
    expect(byArgs.filter((a) => a === null)).toHaveLength(2);
    expect(JSON.stringify(out.toolTrace)).not.toContain("someone-else");
  });

  it("a throwing callback never breaks the turn", async () => {
    executeCoachTool.mockResolvedValue({ present: true, data: {} });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [{ id: "a", name: "get_sleep", arguments: "{}" }]),
      )
      .mockResolvedValueOnce(round("answer"));
    const out = await runCoachToolLoop({
      ...baseArgs,
      onCallStart: () => {
        throw new Error("closed stream");
      },
      onCallSettled: () => {
        throw new Error("closed stream");
      },
    });
    expect(out.result.content).toBe("answer");
    expect(out.toolTrace).toHaveLength(1);
  });

  it("reports a forced answer at the round cap", async () => {
    executeCoachTool.mockResolvedValue({ present: false });
    runRawCompletionWithFallback.mockImplementation(
      (args: { params: { toolChoice?: string } }) =>
        Promise.resolve(
          args.params.toolChoice === "none"
            ? round("forced")
            : round("", [{ id: "x", name: "get_sleep", arguments: "{}" }]),
        ),
    );
    const out = await runCoachToolLoop(baseArgs);
    expect(out.rounds).toBe(HARD_CAP);
    expect(out.forcedFinal).toBe(true);
  });
});
