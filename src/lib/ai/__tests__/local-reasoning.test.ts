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
    // #1276 — `none` is a request a model may ignore: Off keeps the low room.
    expect(body(mock, 2).max_tokens).toBe(600 + 1024);
  });

  it("keeps the level's room when it asks with none after a reasoning-only reply", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: null, reasoning: "Thinking on and on" },
                  finish_reason: "length",
                },
              ],
            }),
            { status: 200 },
          ),
      )
      .mockImplementation(buffered({ content: "ok" }));
    vi.stubGlobal("fetch", mock);
    const c = client();
    const wanted = params({ reasoning: { effort: "medium", summaries: true } });
    expect((await c.generateCompletion(wanted)).content).toBe("ok");
    await c.generateCompletion(wanted);
    // A call without a level of its own, once the model reasons unasked.
    await c.generateCompletion(params());
    expect(
      [0, 1, 2, 3].map((i) => [
        body(mock, i).reasoning_effort,
        body(mock, i).max_tokens,
      ]),
    ).toEqual([
      ["medium", 600 + 4096],
      ["none", 600 + 4096],
      ["none", 600 + 4096],
      ["none", 600 + 1024],
    ]);
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

  it("splits an inline think block for every caller, and reports it only to one that asked", async () => {
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
    // #1276 — reasoning is never an answer, asked for or not.
    const unasked = await client().generateCompletion(params());
    expect(unasked.content).toBe("The answer.");
    expect(unasked.reasoning).toBeUndefined();
  });

  it("splits reasoning whose opening tag the chat template sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        buffered({
          content: "The user asks about sleep.\n</think>\n\nDein Schlaf.",
        }),
      ),
    );
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(result.content).toBe("Dein Schlaf.");
    expect(result.reasoning?.summary).toEqual(["The user asks about sleep."]);
  });

  it("never answers with unlabelled text that filled the reasoning ceiling", async () => {
    const cut = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "The user asks about sleep. I need to" },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200 },
      );
    const mock = vi.fn().mockImplementation(cut);
    vi.stubGlobal("fetch", mock);
    await expect(
      client().generateCompletion(
        params({ reasoning: { effort: "medium", summaries: true } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 0, kind: "reasoning_only" });
    // Asked once more with `none` (#1267), which this model ignores.
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("keeps a cut answer when the ceiling held no room for reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: "A long answer that ran" },
                  finish_reason: "length",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await client().generateCompletion(params());
    expect(result.content).toBe("A long answer that ran");
    expect(result.finishReason).toBe("length");
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

  it("keeps reasoning out of the answer for a caller that asked for none, and tells it nothing", async () => {
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
    expect(deltas).toEqual(["y"]);
    expect(result.content).toBe("y");
    expect(result.reasoning).toBeUndefined();
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it("splits a closing-only think block at the end of the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          stream([
            { content: "The user asks" },
            { content: " about sleep.\n</thi" },
            { content: "nk>\n\nDein " },
            { content: "Schlaf." },
          ]),
        ),
    );
    const result = await client().generateCompletionStream(
      params({ reasoning: { effort: "low", summaries: true } }),
      () => {},
    );
    expect(result.content).toBe("Dein Schlaf.");
    expect(result.reasoning?.summary).toEqual(["The user asks about sleep."]);
  });

  it("reads a vLLM stream: empty first content, both reasoning fields, usage on every chunk", async () => {
    const encoder = new TextEncoder();
    const usage = (n: number) => ({
      prompt_tokens: 100,
      completion_tokens: n,
      total_tokens: 100 + n,
    });
    const frames = [
      {
        choices: [{ delta: { role: "assistant", content: "" } }],
        usage: usage(0),
      },
      {
        choices: [
          { delta: { reasoning: "Plan the ", reasoning_content: "Plan the " } },
        ],
        usage: usage(2),
      },
      {
        choices: [
          { delta: { reasoning: "answer.", reasoning_content: "answer." } },
        ],
        usage: usage(3),
      },
      { choices: [{ delta: { content: "Hallo." } }], usage: usage(5) },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: usage(6) },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (const f of frames) {
                  c.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
                }
                c.enqueue(encoder.encode("data: [DONE]\n\n"));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const result = await client().generateCompletionStream(
      params({ reasoning: { effort: "low", summaries: true } }),
      () => {},
    );
    expect(result.content).toBe("Hallo.");
    // The two fields carry the same text: one copy.
    expect(result.reasoning?.summary).toEqual(["Plan the answer."]);
    // A usage block on every chunk is not an end: the last one counts.
    expect(result.tokensUsed).toBe(106);
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

describe("local reasoning refusals the client must not learn from", () => {
  const err = (status: number, message: string) => async () =>
    new Response(JSON.stringify({ error: { message } }), { status });

  it.each([
    [401, "Unauthorized: thinking models require a key; not allowed."],
    [429, "Too many requests to the reasoning queue; not permitted."],
    [500, "reasoning_effort: unsupported value (internal error)."],
  ])("raises HTTP %i once and keeps the field", async (status, message) => {
    const mock = vi
      .fn()
      .mockImplementationOnce(err(status, message))
      .mockImplementation(buffered({ content: "ok" }));
    vi.stubGlobal("fetch", mock);
    const wanted = params({ reasoning: { effort: "low", summaries: true } });
    await expect(client().generateCompletion(wanted)).rejects.toMatchObject({
      httpStatus: status,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    await client().generateCompletion(wanted);
    expect(body(mock, 1).reasoning_effort).toBe("low");
  });

  it("does not learn from a 400 whose only match is the model name", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(
        err(400, "model 'qwen3-thinking' is not supported by this runner"),
      )
      .mockImplementation(buffered({ content: "ok" }));
    vi.stubGlobal("fetch", mock);
    const c = new LocalOpenAICompatibleClient({
      model: "qwen3-thinking",
      baseUrl: BASE,
    });
    const wanted = params({ reasoning: { effort: "low", summaries: true } });
    await expect(c.generateCompletion(wanted)).rejects.toMatchObject({
      httpStatus: 400,
    });
    await c.generateCompletion(wanted);
    expect(body(mock, 1).reasoning_effort).toBe("low");
  });

  it("sends the field again an hour after a refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
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
      const wanted = params({ reasoning: { effort: "low", summaries: true } });
      await client().generateCompletion(wanted);
      expect(body(mock, 1)).not.toHaveProperty("reasoning_effort");
      vi.advanceTimersByTime(60 * 60 * 1000);
      await client().generateCompletion(wanted);
      expect(body(mock, 2).reasoning_effort).toBe("low");
    } finally {
      vi.useRealTimers();
    }
  });
});
