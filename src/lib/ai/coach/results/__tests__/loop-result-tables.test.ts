/**
 * v1.39.4 — a result table rides the settled call to the turn, and never
 * the tool-result turn the model reads, nor the figures the reply is
 * checked against.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/run/types";
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
    tokensSpent: 0,
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

  it("adds the table rules to the rounds after the first table, not before, without touching the system prompt", async () => {
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
    // The loop hands every round the same growing message array, so record
    // what each round saw at the moment it was called.
    const seen: Array<{ system: string; messages: unknown[] }> = [];
    const replies = [
      round("", [call("a", "get_metric_series")]),
      round("", [call("b", "get_metric_table")]),
      round("answer"),
    ];
    runRawCompletionWithFallback.mockImplementation(async (arg: unknown) => {
      const { params } = arg as {
        params: { system: string; messages: unknown[] };
      };
      seen.push({ system: params.system, messages: [...params.messages] });
      return replies[seen.length - 1];
    });

    await runCoachToolLoop({
      userId: "u1",
      providers: [],
      system: "sys",
      tableRulesOnceShown: "TABLE RULES",
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
    // #1217 — one system prompt for every round, so the cached prefix holds.
    expect(seen.map((round) => round.system)).toEqual(["sys", "sys", "sys"]);
    const rulesIn = seen.map((round) =>
      round.messages.some(
        (m) =>
          (m as { role: string; content: unknown }).role === "user" &&
          (m as { content: unknown }).content === "TABLE RULES",
      ),
    );
    expect(rulesIn).toEqual([false, false, true]);
    // The rules follow the tool results that produced the table.
    const last = seen[2]!.messages as Array<{ role: string }>;
    expect(last.at(-1)).toEqual({ role: "user", content: "TABLE RULES" });
    expect(last.at(-2)?.role).toBe("tool");
    // Each round's messages extend the previous round's: a stable prefix.
    expect(seen[1]!.messages.slice(0, seen[0]!.messages.length)).toEqual(
      seen[0]!.messages,
    );
    expect(seen[2]!.messages.slice(0, seen[1]!.messages.length)).toEqual(
      seen[1]!.messages,
    );
  });
});
