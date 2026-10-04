/**
 * CHARACTERISATION — which tool results reach `toolResults`, and why it matters.
 *
 * `toolResults` is not just a trace. The chat route derives
 * `activatingPayloads` from it, and the numeric grounding guard runs ONLY when
 * that array is non-empty (`insights/chat/route.ts`, the
 * `activatingPayloads.length > 0` gate). So whatever the loop drops here, the
 * guard never sees.
 *
 * Two shapes of empty read, from `availability.ts` `resolveEmptyRead`:
 *   - nothing recorded at all  -> `{ present: false, reason: "none" }`, no `available`
 *   - rows exist out of window -> `{ present: false, reason: "unavailable_in_scope", available }`
 *
 * Only the second survives `loop.ts`'s push condition. The first is dropped,
 * which disarms the grounding guard for that turn. This test pins the drop so
 * the consequence is visible at the seam where it happens.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { runCoachToolLoop } from "@/lib/ai/coach/tools/loop";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

const baseArgs = {
  userId: "u1",
  providers: [],
  system: "sys",
  messages: [{ role: "user" as const, content: "how did I sleep?" }],
  tools: COACH_TOOL_DEFS,
  reach: UNBOUNDED_REACH,
};

describe("coach tool loop — which results reach the grounding guard", () => {
  beforeEach(() => {
    executeCoachTool.mockReset();
    runRawCompletionWithFallback.mockReset();
  });

  it("a pure miss (present:false, no available) is dropped from toolResults", async () => {
    executeCoachTool.mockResolvedValue({ present: false, reason: "none" });
    runRawCompletionWithFallback
      .mockResolvedValueOnce({
        result: {
          content: "",
          tokensUsed: 30,
          model: "mock",
          providerType: "anthropic" as const,
          toolCalls: [
            { id: "t1", name: "get_sleep", arguments: JSON.stringify({}) },
          ],
          finishReason: "tool_calls",
        },
        workingProvider: { providerType: "anthropic" },
        fallbackHops: [],
      })
      .mockResolvedValueOnce({
        result: {
          content: "You averaged 7 h 12 min of sleep.",
          tokensUsed: 20,
          model: "mock",
          providerType: "anthropic" as const,
          finishReason: "stop",
        },
        workingProvider: { providerType: "anthropic" },
        fallbackHops: [],
      });

    const loop = await runCoachToolLoop(baseArgs);

    // The trace records that the tool ran and found nothing…
    expect(loop.toolTrace).toEqual([
      { name: "get_sleep", present: false, args: {} },
    ]);
    // …but the payload set the route grades against is empty, so the route's
    // `activatingPayloads.length > 0` gate is false and the numeric grounding
    // guard never runs for this turn.
    expect(loop.toolResults).toEqual([]);
  });

  it("an out-of-window miss WITH `available` is kept, so the guard stays armed", async () => {
    executeCoachTool.mockResolvedValue({
      present: false,
      reason: "unavailable_in_scope",
      available: { count: 12, reachableWithWindow: "lastYear" },
    } as unknown as CoachToolResult);
    runRawCompletionWithFallback
      .mockResolvedValueOnce({
        result: {
          content: "",
          tokensUsed: 30,
          model: "mock",
          providerType: "anthropic" as const,
          toolCalls: [
            { id: "t1", name: "get_sleep", arguments: JSON.stringify({}) },
          ],
          finishReason: "tool_calls",
        },
        workingProvider: { providerType: "anthropic" },
        fallbackHops: [],
      })
      .mockResolvedValueOnce({
        result: {
          content: "Nothing in the last 30 days.",
          tokensUsed: 20,
          model: "mock",
          providerType: "anthropic" as const,
          finishReason: "stop",
        },
        workingProvider: { providerType: "anthropic" },
        fallbackHops: [],
      });

    const loop = await runCoachToolLoop(baseArgs);
    expect(loop.toolResults).toHaveLength(1);
  });
});
