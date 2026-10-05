/**
 * v1.39.4 — a result table rides the settled call to the turn, and never
 * the tool-result turn the model reads, nor the figures the reply is
 * checked against.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";
import type { CoachResultTable } from "@/lib/ai/coach/types";

const executeCoachTool = vi.fn<(args?: unknown) => Promise<CoachToolResult>>();
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: (args: unknown) => executeCoachTool(args),
}));
const runRawCompletionWithFallback = vi.fn();
vi.mock("@/lib/ai/provider-runner", () => ({
  runRawCompletionWithFallback: (args: unknown) =>
    runRawCompletionWithFallback(args),
}));

import { runCoachToolLoop } from "@/lib/ai/coach/tools/loop";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { createResultRefAllocator } from "../refs";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

function round(content: string, toolCalls?: unknown[]) {
  return {
    result: {
      content,
      tokensUsed: 5,
      model: "mock",
      ...(toolCalls
        ? { toolCalls, finishReason: "tool_calls" as const }
        : { finishReason: "stop" as const }),
    },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
  };
}

const TABLE = {
  ref: "r1",
  rows: [["2026-01-01", 987654]],
} as unknown as CoachResultTable;

beforeEach(() => {
  executeCoachTool.mockReset();
  runRawCompletionWithFallback.mockReset();
});

describe("runCoachToolLoop — result tables", () => {
  it("hands the table to the settled callback and strips it from the model's turn", async () => {
    executeCoachTool.mockResolvedValueOnce({
      present: true,
      resultRef: "r1",
      data: { periods: 1 },
      table: TABLE,
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(
        round("", [
          {
            id: "a",
            name: "get_metric_table",
            arguments: '{"metric":"pulse"}',
          },
        ]),
      )
      .mockResolvedValueOnce(round("answer"));

    const turn = {
      conversationId: "c1",
      locale: "en" as const,
      priorResults: [],
      refs: createResultRefAllocator(),
    };
    const settled: CoachToolResult[] = [];
    const out = await runCoachToolLoop({
      userId: "u1",
      providers: [],
      system: "sys",
      messages: [{ role: "user", content: "q" }],
      tools: COACH_TOOL_DEFS,
      reach: UNBOUNDED_REACH,
      turn,
      onCallSettled: (_call, result) => settled.push(result),
    });

    expect(executeCoachTool.mock.calls[0][0]).toMatchObject({ turn });
    expect(settled[0].table).toBe(TABLE);

    const second = runRawCompletionWithFallback.mock.calls[1][0].params
      .messages as Array<{ role: string; content: string }>;
    const toolTurn = second.find((m) => m.role === "tool");
    expect(toolTurn?.content).toBe(
      JSON.stringify({ present: true, resultRef: "r1", data: { periods: 1 } }),
    );
    expect(toolTurn?.content).not.toContain("987654");
    expect(JSON.stringify(out.toolResults)).not.toContain("987654");
  });

  it("adds the table rules to the rounds after the first table, not before", async () => {
    executeCoachTool
      .mockResolvedValueOnce({ present: true, data: { n: 1 } })
      .mockResolvedValueOnce({
        present: true,
        resultRef: "r1",
        data: { periods: 1 },
        table: TABLE,
      });
    const call = (id: string, name: string) => ({
      id,
      name,
      arguments: '{"metric":"pulse"}',
    });
    runRawCompletionWithFallback
      .mockResolvedValueOnce(round("", [call("a", "get_metric_series")]))
      .mockResolvedValueOnce(round("", [call("b", "get_metric_table")]))
      .mockResolvedValueOnce(round("answer"));

    await runCoachToolLoop({
      userId: "u1",
      providers: [],
      system: "sys",
      systemOnceTableShown: "sys+tables",
      messages: [{ role: "user", content: "q" }],
      tools: COACH_TOOL_DEFS,
      reach: UNBOUNDED_REACH,
      turn: {
        conversationId: "c1",
        locale: "en",
        priorResults: [],
        refs: createResultRefAllocator(),
      },
    });
    const systems = runRawCompletionWithFallback.mock.calls.map(
      ([arg]) => (arg as { params: { system: string } }).params.system,
    );
    expect(systems).toEqual(["sys", "sys", "sys+tables"]);
  });
});
