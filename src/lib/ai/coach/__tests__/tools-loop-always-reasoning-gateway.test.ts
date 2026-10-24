/**
 * #1276 — a Coach turn on an OpenAI-compatible gateway whose model always
 * reasons and cannot be told not to (a GLM model behind vLLM). The loop runs
 * through the real gateway client onto a fake upstream that answers the way
 * the reported wire capture shows:
 *
 *  - `reasoning_effort` is accepted and ignored: the model reasons on every
 *    request, `none` included;
 *  - reasoning tokens count against `max_tokens`; a budget that runs out
 *    inside the reasoning ends with `finish_reason: "length"`;
 *  - with a reasoning parser the thought arrives twice, in `reasoning` and in
 *    `reasoning_content`, and `content` is null beside a tool call;
 *  - without one, `content` carries the raw output: the reasoning, then
 *    `</think>` (the chat template opened the block in the prompt), then the
 *    answer; a model that opens the block itself emits `<think>` too.
 *
 * What must hold, however the upstream is set up: reasoning never becomes the
 * answer, tool calls run, and a reply with no answer at all fails as
 * `reasoning_only` instead of showing the thought.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/run/types";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});
vi.mock("@/lib/ai/local-host-allowlist", () => ({
  aiEgressPolicyFor: () => ({}),
}));
const emitSignal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));
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
import { createTurnBudget } from "@/lib/ai/coach/tools/turn-budget";
import { COACH_TOOL_DEFS } from "@/lib/ai/coach/tools/definitions";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { OpenAIClient } from "@/lib/ai/openai-client";
import { resetReasoningDialectCache } from "@/lib/ai/reasoning/dialect-cache";
import type { ReasoningLevel } from "@/lib/ai/reasoning/levels";
import { singleUserTurn, type CompletionParams } from "@/lib/ai/types";

const BASE = "http://vllm.lan:8000/v1";
const MODEL = "glm-5.3";
const ARGS = JSON.stringify({ metric: "bp", window: "last30days" });
const ANSWER =
  "Dein Blutdruck lag in den letzten 30 Tagen im Mittel bei 128 zu 82.";

/** One reasoning token per word, the way the fake counts. */
const PLAN_WORDS = (
  "The user asks about their blood pressure. I need to fetch data with " +
  "get_metric_table for the last thirty days before I can answer, then " +
  "compare the readings with the earlier month and keep it short."
).split(" ");

function thought(words: number): string {
  return Array.from(
    { length: words },
    (_, i) => PLAN_WORDS[i % PLAN_WORDS.length],
  ).join(" ");
}

/** How the server hands the reasoning back. */
type Parser =
  /** A reasoning parser: `reasoning` and `reasoning_content`, content null. */
  | "fielded"
  /** No parser, the template opened the block: `…</think>answer`. */
  | "template-opened"
  /** No parser, the model opens the block itself: `<think>…</think>answer`. */
  | "raw";

let parser: Parser = "fielded";
/** What the model reasons on every round, whatever it is asked. */
let reasoningWords = 1200;
/** The finish reason the server puts beside a tool call. */
let toolFinish: "tool_calls" | "stop" = "tool_calls";
/** Tokens a tool call or the answer takes after the reasoning. */
const ACT_TOKENS = 20;

type Body = {
  max_tokens?: number;
  reasoning_effort?: string;
  messages?: Array<{ role: string; content?: unknown }>;
};

function reply(message: Record<string, unknown>, finish: string, n: number) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1276",
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: {
        prompt_tokens: 3000,
        completion_tokens: n,
        total_tokens: 3000 + n,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function withReasoning(
  text: string,
  after: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  switch (parser) {
    case "fielded":
      return {
        role: "assistant",
        content: after === "" ? null : after,
        reasoning: text,
        reasoning_content: text,
        ...extra,
      };
    case "template-opened":
      return {
        role: "assistant",
        content: `${text}\n</think>\n\n${after}`,
        ...extra,
      };
    case "raw":
      return {
        role: "assistant",
        content: `<think>${text}</think>\n\n${after}`,
        ...extra,
      };
  }
}

const upstream = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as Body;
  const budget = body.max_tokens ?? 0;
  if (budget < reasoningWords + ACT_TOKENS) {
    // The budget runs out inside the reasoning, mid-sentence.
    const partial = thought(Math.min(budget, reasoningWords));
    const message =
      parser === "fielded"
        ? {
            role: "assistant",
            content: null,
            reasoning: partial,
            reasoning_content: partial,
          }
        : parser === "raw"
          ? { role: "assistant", content: `<think>${partial}` }
          : { role: "assistant", content: partial };
    return reply(message, "length", budget);
  }
  const used = reasoningWords + ACT_TOKENS;
  const toolHistory = (body.messages ?? []).some((m) => m.role === "tool");
  if (!toolHistory) {
    return reply(
      withReasoning(thought(reasoningWords), "", {
        tool_calls: [
          {
            id: "chatcmpl-tool-1",
            type: "function",
            function: { name: "get_metric_table", arguments: ARGS },
          },
        ],
      }),
      toolFinish,
      used,
    );
  }
  return reply(withReasoning(thought(reasoningWords), ANSWER), "stop", used);
});

function bodies(): Body[] {
  return upstream.mock.calls.map((c) => JSON.parse(c[1].body) as Body);
}

function gateway() {
  return new OpenAIClient({
    apiKey: "",
    model: MODEL,
    baseUrl: BASE,
    providerType: "openai-compatible",
  });
}

/** One Coach turn as `turn/model.ts` runs it, on this gateway alone. */
async function turn(level: ReasoningLevel) {
  const client = gateway();
  runRawCompletionWithFallback.mockImplementation(
    async ({ params }: { params: CompletionParams }) => ({
      result: await client.generateCompletion(params),
      workingProvider: { providerType: "openai-compatible" },
      fallbackHops: [],
    }),
  );
  return runCoachToolLoop({
    userId: "u1",
    providers: [],
    system: "You are the Coach.",
    messages: [{ role: "user", content: "Wie ist mein Blutdruck?" }],
    tools: COACH_TOOL_DEFS,
    reach: UNBOUNDED_REACH,
    maxTokens: AI_BUDGETS.coach.maxTokens,
    reasoning: { effort: level, summaries: level !== "off" },
    budget: createTurnBudget({
      payer: "user",
      initialInputTokens: 10,
      limits: { tokens: 1e9, wallMs: 1e9, maxRounds: 4 },
    }),
  });
}

beforeEach(() => {
  upstream.mockClear();
  executeCoachTool.mockReset();
  runRawCompletionWithFallback.mockReset();
  emitSignal.mockClear();
  executeCoachTool.mockResolvedValue({ present: true, data: { mean: 128 } });
  resetReasoningDialectCache();
  vi.stubGlobal("fetch", upstream);
  parser = "fielded";
  reasoningWords = 1200;
  toolFinish = "tool_calls";
});

describe("#1276: a gateway model that always reasons", () => {
  it("runs the tool and answers when its reasoning fits, with the thought kept once", async () => {
    const out = await turn("medium");
    expect(out.result.content).toBe(ANSWER);
    expect(executeCoachTool).toHaveBeenCalledTimes(1);
    // `reasoning` and `reasoning_content` carry the same text: one copy.
    expect(out.result.reasoning?.summary).toEqual([thought(1200)]);
  });

  it.each<Parser>(["fielded", "template-opened", "raw"])(
    "keeps room to reason after one answerless reply taught it `none` (%s)",
    async (mode) => {
      parser = mode;
      // A long round reasons past the whole ceiling once; the #1267 rule
      // learns that the model answers only unreasoned and asks again with
      // `none`. This model ignores `none`, so that ask fails as well.
      reasoningWords = 6000;
      const first = await gateway()
        .generateCompletion({
          ...singleUserTurn({
            system: "You are the Coach.",
            user: "Wie ist mein Blutdruck?",
            maxTokens: AI_BUDGETS.coach.maxTokens,
          }),
          reasoning: { effort: "medium", summaries: true },
        })
        .then(
          (r) => ({ ok: true as const, content: r.content }),
          (e: { kind?: string }) => ({ ok: false as const, kind: e.kind }),
        );
      // Never the thought as an answer.
      expect(first).toEqual({ ok: false, kind: "reasoning_only" });

      // The next turn reasons a normal amount.
      reasoningWords = 1200;
      upstream.mockClear();
      const out = await turn("medium");
      expect(out.result.content).toBe(ANSWER);
      expect(executeCoachTool).toHaveBeenCalledTimes(1);
      for (const body of bodies()) {
        expect(body.reasoning_effort).toBe("none");
        // `none` is a request, not a promise: the thinking room stays.
        expect(body.max_tokens).toBe(600 + 4096);
      }
    },
  );

  it("gives a turn set to Off room to reason, since the wire cannot promise off", async () => {
    const out = await turn("off");
    expect(out.result.content).toBe(ANSWER);
    expect(executeCoachTool).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({
      reasoning_effort: "none",
      max_tokens: 600 + 1024,
    });
  });

  it.each<Parser>(["template-opened", "raw"])(
    "keeps inline reasoning out of the answer and the history (%s)",
    async (mode) => {
      parser = mode;
      const out = await turn("medium");
      expect(out.result.content).toBe(ANSWER);
      expect(out.result.reasoning?.summary).toEqual([thought(1200)]);
      // The assistant turn handed back on round two carries no thought.
      const history = bodies()[1].messages ?? [];
      const assistant = history.find((m) => m.role === "assistant");
      expect(assistant?.content ?? "").toBe("");
    },
  );

  it("fails as reasoning_only, never with the thought, when no answer ever comes", async () => {
    parser = "raw";
    reasoningWords = 20_000;
    const err = await turn("medium").then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ httpStatus: 0, kind: "reasoning_only" });
  });
});
