import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Destination policy has its own suites; stub it so the wire can be asserted
// against the global fetch stub.
vi.mock("../local-host-allowlist", () => ({ aiEgressPolicyFor: () => ({}) }));
import {
  LocalOpenAICompatibleClient,
  resetLocalJsonDialectCache,
} from "../local-client";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import type { AiReasoningEvent, CompletionParams } from "../types";

/**
 * v1.41 — reasoning on local OpenAI-compatible servers. The reply shapes are
 * the documented ones: `reasoning_content` (llama.cpp, LiteLLM), `reasoning`
 * (vLLM, Ollama, LM Studio), on the message and on each streamed delta, and
 * an inline leading `<think>` block.
 */
const FIXTURES = join(__dirname, "fixtures/reasoning");

const BASE = "http://localhost:11434/v1";

function buffered(message: Record<string, unknown>) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message, finish_reason: "stop" }],
        usage: {
          total_tokens: 70,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function stream(deltas: Array<Record<string, string>>) {
  return async () => {
    const encoder = new TextEncoder();
    const frames = [
      ...deltas.map(
        (delta) =>
          `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
      ),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 55 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(encoder.encode(f));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
}

function params(extra: Partial<CompletionParams> = {}): CompletionParams {
  return {
    system: "s",
    messages: [{ role: "user", content: "u" }],
    maxTokens: 600,
    ...extra,
  };
}

const body = (mock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(mock.mock.calls[call][1].body);

const client = () =>
  new LocalOpenAICompatibleClient({ model: "qwen3:8b", baseUrl: BASE });

beforeEach(() => {
  vi.restoreAllMocks();
  resetLocalJsonDialectCache();
  resetReasoningDialectCache();
});

describe("Local reasoning request", () => {
  it("sends the call's level, off as none, and gives it room to think", async () => {
    const mock = vi.fn().mockImplementation(buffered({ content: "ok" }));
    vi.stubGlobal("fetch", mock);
    const c = client();
    c.reasoningEffort = "high";
    await c.generateCompletion(params());
    await c.generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    await c.generateCompletion(
      params({ reasoning: { effort: "off", summaries: true } }),
    );
    // No level on the call: the entry's own setting, as before.
    expect(body(mock, 0).reasoning_effort).toBe("high");
    expect(body(mock, 0).max_tokens).toBe(600);
    expect(body(mock, 1).reasoning_effort).toBe("medium");
    expect(body(mock, 1).max_tokens).toBe(600 + 4096);
    expect(body(mock, 2).reasoning_effort).toBe("none");
    expect(body(mock, 2).max_tokens).toBe(600);
  });

  it("retries once without the field when the server refuses it, and remembers", async () => {
    const refusal = readFileSync(
      join(FIXTURES, "gateway-reasoning-rejected.json"),
      "utf8",
    );
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(refusal, { status: 400 }),
      )
      .mockImplementation(buffered({ content: "ok" }));
    vi.stubGlobal("fetch", mock);
    const c = client();
    const result = await c.generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(result.content).toBe("ok");
    expect(body(mock, 1)).not.toHaveProperty("reasoning_effort");
    await c.generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(body(mock, 2)).not.toHaveProperty("reasoning_effort");
  });
});

describe("Local reasoning replies", () => {
  it.each([["reasoning_content"], ["reasoning"]])(
    "reads %s off the message",
    async (field) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(
            buffered({ content: "Answer.", [field]: "**Plan**\nThink." }),
          ),
      );
      const events: AiReasoningEvent[] = [];
      const result = await client().generateCompletion(
        params({
          reasoning: { effort: "low", summaries: true },
          onReasoning: (e) => events.push(e),
        }),
      );
      expect(result.content).toBe("Answer.");
      expect(result.reasoning).toEqual({
        summary: ["**Plan**\nThink."],
        tokens: 30,
      });
      expect(events).toEqual([
        { kind: "title", text: "Plan" },
        { kind: "text", text: "**Plan**\nThink." },
        { kind: "done", text: "" },
      ]);
    },
  );

  it("splits an inline think block only for a caller that asked for reasoning", async () => {
    const reply = "<think>check the window</think>\n\nThe answer.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(buffered({ content: reply })),
    );
    const asked = await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(asked.content).toBe("The answer.");
    expect(asked.reasoning?.summary).toEqual(["check the window"]);
    const unasked = await client().generateCompletion(params());
    expect(unasked.content).toBe(reply);
    expect(unasked.reasoning).toBeUndefined();
  });
});

describe("Local reasoning stream", () => {
  it("reports streamed reasoning live and keeps it out of the answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          stream([
            { reasoning_content: "**Choosing" },
            { reasoning_content: " the window**\n" },
            { reasoning_content: "Ninety days." },
            { content: "Your " },
            { content: "answer." },
          ]),
        ),
    );
    const events: AiReasoningEvent[] = [];
    const deltas: string[] = [];
    const result = await client().generateCompletionStream(
      params({
        reasoning: { effort: "medium", summaries: true },
        onReasoning: (e) => events.push(e),
      }),
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["Your ", "answer."]);
    expect(result.content).toBe("Your answer.");
    expect(events).toEqual([
      { kind: "title", text: "Choosing the window" },
      { kind: "text", text: "**Choosing the window**\nNinety days." },
      { kind: "done", text: "" },
    ]);
    expect(result.reasoning?.summary).toEqual([
      "**Choosing the window**\nNinety days.",
    ]);
  });

  it("routes an inline think block split across chunks to the reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          stream([
            { content: " <thi" },
            { content: "nk>weigh the" },
            { content: " two readings</th" },
            { content: "ink>\n\nThe " },
            { content: "answer." },
          ]),
        ),
    );
    const deltas: string[] = [];
    const result = await client().generateCompletionStream(
      params({ reasoning: { effort: "low", summaries: true } }),
      (d) => deltas.push(d),
    );
    expect(deltas.join("")).toBe("The answer.");
    expect(result.content).toBe("The answer.");
    expect(result.reasoning?.summary).toEqual(["weigh the two readings"]);
  });

  it("streams untouched for a caller that asked for no reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          stream([
            { reasoning: "ignored" },
            { content: "<think>x</think>" },
            { content: "y" },
          ]),
        ),
    );
    const deltas: string[] = [];
    const onReasoning = vi.fn();
    const result = await client().generateCompletionStream(
      params({ onReasoning }),
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["<think>x</think>", "y"]);
    expect(result.content).toBe("<think>x</think>y");
    expect(result.reasoning).toBeUndefined();
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it("passes a short reply that only looked like it might open a think block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(stream([{ content: "<t" }])),
    );
    const result = await client().generateCompletionStream(
      params({ reasoning: { effort: "low", summaries: true } }),
      () => {},
    );
    expect(result.content).toBe("<t");
  });
});
