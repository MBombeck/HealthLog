import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiReasoningEvent, CompletionParams } from "../types";

/**
 * v1.41 — the chain runner hands `reasoning` and `onReasoning` to every
 * candidate unchanged, reports reasoning as counts only, and the mock client
 * reasons deterministically for the loop's tests.
 */
const annotations = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: { meta?: Record<string, unknown> }) => {
    if (fields.meta) annotations.push(fields.meta);
  },
}));
vi.mock("../coach/budget", async () => {
  const actual =
    await vi.importActual<typeof import("../coach/budget")>("../coach/budget");
  return {
    ...actual,
    readDailySpend: vi.fn(async () => ({ total: 0, operator: 0 })),
  };
});

import { MockAIProvider } from "../mock-client";
import {
  clearLastWorkingProviderCache,
  runRawCompletionWithFallback,
} from "../provider-runner";
import { createInMemoryProviderHealthLedger } from "../provider-health-ledger";

function params(extra: Partial<CompletionParams> = {}): CompletionParams {
  return {
    system: "s",
    messages: [{ role: "user", content: "u" }],
    ...extra,
  };
}

beforeEach(() => {
  annotations.length = 0;
  clearLastWorkingProviderCache();
});

describe("MockAIProvider reasoning", () => {
  it("reasons deterministically when asked, with state for the next round", async () => {
    const mock = new MockAIProvider({ providerType: "codex", responses: "a" });
    const events: AiReasoningEvent[] = [];
    const first = await mock.generateCompletion(
      params({
        reasoning: { effort: "medium", summaries: true },
        onReasoning: (e) => events.push(e),
      }),
    );
    expect(events).toEqual([
      { kind: "title", text: "Reading the request" },
      {
        kind: "text",
        text: "**Reading the request**\nMock reasoning for call 1.",
      },
      { kind: "done", text: "" },
    ]);
    expect(first.reasoning).toEqual({
      summary: ["**Reading the request**\nMock reasoning for call 1."],
      tokens: 8,
    });
    expect(first.providerState).toEqual({
      providerType: "codex",
      model: "mock-model",
      items: [{ type: "mock-reasoning", call: 1 }],
    });
  });

  it("stays silent without a request, and reports nothing for off", async () => {
    const mock = new MockAIProvider({ responses: "a" });
    const onReasoning = vi.fn();
    const plain = await mock.generateCompletion(params({ onReasoning }));
    expect(onReasoning).not.toHaveBeenCalled();
    expect(plain.reasoning).toBeUndefined();
    const off = await mock.generateCompletion(
      params({ reasoning: { effort: "off", summaries: true }, onReasoning }),
    );
    expect(off.reasoning).toEqual({ summary: [], tokens: null });
    expect(off.providerState).toBeUndefined();
  });
});

describe("Chain runner reasoning pass-through", () => {
  it("hands the same reasoning request to the fallback hop and counts it", async () => {
    const failing = new MockAIProvider({
      providerType: "anthropic",
      rejectWith: Object.assign(new Error("down"), { httpStatus: 503 }),
    });
    const working = new MockAIProvider({
      providerType: "codex",
      responses: "ok",
    });
    const events: AiReasoningEvent[] = [];
    const onReasoning = (e: AiReasoningEvent) => events.push(e);
    const reasoning = { effort: "high" as const, summaries: true };

    const out = await runRawCompletionWithFallback({
      userId: "u1",
      providers: [
        { providerType: "anthropic", instance: failing },
        { providerType: "codex", instance: working },
      ],
      params: params({ reasoning, onReasoning }),
      surface: "coach",
      ledger: createInMemoryProviderHealthLedger(),
    });

    expect(failing.calls[0].reasoning).toBe(reasoning);
    expect(working.calls[0].reasoning).toBe(reasoning);
    expect(working.calls[0].onReasoning).toBe(onReasoning);
    expect(events.map((e) => e.kind)).toEqual(["title", "text", "done"]);
    expect(out.result.providerState?.items).toHaveLength(1);

    const success = annotations.find((m) => "ai_reasoning_spend" in m);
    expect(success).toMatchObject({
      ai_reasoning_spend: 8,
      ai_reasoning_summary_count: 1,
    });
    // Counts only: no model text, no provider state on the wide event.
    const flat = JSON.stringify(annotations);
    expect(flat).not.toContain("mock-reasoning");
    expect(flat).not.toContain("Reading the request");
  });
});
