import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexClient } from "../codex-client";
import { clearCodexSlugCache } from "../codex-slug-cache";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import type {
  AiMessage,
  AiReasoningEvent,
  CompletionParams,
  CompletionResult,
} from "../types";

/**
 * v1.41 — Codex reasoning at the wire. The SSE fixtures were recorded against
 * the live backend on 2026-10-06 with throwaway prompts (no health data) and
 * sanitised: encrypted reasoning content replaced by placeholders, account
 * identifiers and echoed instructions removed. The 400 bodies are the
 * backend's own answers to an unsupported effort and summary value.
 */
const FIXTURES = join(__dirname, "fixtures/reasoning");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  // Split into uneven chunks so event boundaries fall mid-chunk, as on a
  // real connection.
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += 173)
    chunks.push(body.slice(i, i + 173));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function client() {
  return new CodexClient({
    accessToken: "test-token",
    accountId: "acct-test",
    onTokenRefresh: vi
      .fn()
      .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    slugChain: ["gpt-5.5"],
  });
}

function params(extra: Partial<CompletionParams> = {}): CompletionParams {
  return {
    system: "You are a terse assistant.",
    messages: [{ role: "user", content: "How long was the train moving?" }],
    ...extra,
  };
}

function sentBody(mock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(mock.mock.calls[call][1].body);
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearCodexSlugCache();
  resetReasoningDialectCache();
});

describe("Codex reasoning request", () => {
  it("sends today's wire when the call asks for no reasoning", async () => {
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const onReasoning = vi.fn();
    const result = await client().generateCompletion(params({ onReasoning }));
    const body = sentBody(mock);
    expect(body.reasoning).toBeNull();
    expect(body.include).toEqual([]);
    // No reasoning asked → no events, no reasoning block, no state.
    expect(onReasoning).not.toHaveBeenCalled();
    expect(result.reasoning).toBeUndefined();
    expect(result.providerState).toBeUndefined();
  });

  it("asks for effort, a summary and the encrypted items", async () => {
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    await client().generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    const body = sentBody(mock);
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  it("leaves the summary out when none is wanted", async () => {
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    await client().generateCompletion(
      params({ reasoning: { effort: "high", summaries: false } }),
    );
    expect(sentBody(mock).reasoning).toEqual({ effort: "high" });
  });

  it("switches reasoning off with effort none, without encrypted items", async () => {
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-after-tool.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "off", summaries: true } }),
    );
    const body = sentBody(mock);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.include).toEqual([]);
    expect(result.reasoning?.downgradedTo).toBeUndefined();
  });
});

describe("Codex reasoning stream", () => {
  it("reports the title live, then the text, then done", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          sseResponse(fixture("codex-summary.sse")),
        ),
    );
    const events: AiReasoningEvent[] = [];
    const result = await client().generateCompletion(
      params({
        reasoning: { effort: "medium", summaries: true },
        onReasoning: (e) => events.push(e),
      }),
    );
    expect(events).toEqual([
      { kind: "title", text: "Calculating elapsed time minus offset" },
      { kind: "text", text: "**Calculating elapsed time minus offset**" },
      { kind: "done", text: "" },
    ]);
    expect(result.content).toBe(
      "The train was moving for 3 hours and 10 minutes.",
    );
    expect(result.reasoning).toEqual({
      summary: ["**Calculating elapsed time minus offset**"],
      tokens: 33,
    });
    // Reasoning tokens are inside the billed total.
    expect(result.tokensUsed).toBe(101);
  });

  it("keeps the reasoning items of a tool round as provider state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          sseResponse(fixture("codex-tool-round.sse")),
        ),
    );
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_edjM3le4GcXAsF7vywK4kQgY",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
    ]);
    expect(result.reasoning).toEqual({ summary: [], tokens: 16 });
    expect(result.providerState?.providerType).toBe("codex");
    expect(result.providerState?.model).toBe("gpt-5.5");
    expect(result.providerState?.items).toHaveLength(1);
    expect(result.providerState?.items[0]).toMatchObject({
      type: "reasoning",
      id: "rs_03743ca81429e023016ac52522f51c87d297ef373ae4b945c9",
      encrypted_content: expect.stringMatching(/^enc-fixture-/),
    });
  });
});

describe("Codex reasoning round trip", () => {
  async function firstRound(): Promise<CompletionResult> {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          sseResponse(fixture("codex-tool-round.sse")),
        ),
    );
    return client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
  }

  function secondRoundMessages(first: CompletionResult): AiMessage[] {
    return [
      { role: "user", content: "What is the weather in the capital?" },
      {
        role: "assistant",
        content: first.content,
        toolCalls: first.toolCalls,
        providerState: first.providerState,
      },
      {
        role: "tool",
        toolCallId: first.toolCalls![0].id,
        content: '{"tempC":18,"sky":"cloudy"}',
      },
    ];
  }

  it("hands the reasoning item back unchanged before the call it led to", async () => {
    const first = await firstRound();
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-after-tool.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const second = await client().generateCompletion(
      params({
        messages: secondRoundMessages(first),
        reasoning: { effort: "low", summaries: true },
      }),
    );
    const input = sentBody(mock).input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type)).toEqual([
      "message",
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(input[1]).toEqual(first.providerState!.items[0]);
    expect(second.content).toBe("Paris weather: 18°C, cloudy.");
  });

  it("drops state made for another slug or by another provider", async () => {
    const first = await firstRound();
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-after-tool.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const messages = secondRoundMessages(first);
    messages[1] = {
      ...messages[1],
      providerState: { ...first.providerState!, model: "gpt-5.4" },
    };
    await client().generateCompletion(params({ messages }));
    messages[1] = {
      ...messages[1],
      providerState: { ...first.providerState!, providerType: "anthropic" },
    };
    await client().generateCompletion(params({ messages }));
    for (const call of [0, 1]) {
      const types = (sentBody(mock, call).input as Array<{ type: string }>).map(
        (i) => i.type,
      );
      expect(types).not.toContain("reasoning");
    }
  });
});

describe("Codex reasoning refusals", () => {
  it("retries without the summary the backend refused, and remembers", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(400, fixture("codex-summary-rejected.json")),
      )
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const c = client();
    const result = await c.generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(result.content).toBe(
      "The train was moving for 3 hours and 10 minutes.",
    );
    expect(sentBody(mock, 0).reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(sentBody(mock, 1).reasoning).toEqual({ effort: "medium" });
    // Same level, only the summary went: not a downgrade.
    expect(result.reasoning?.downgradedTo).toBeUndefined();

    await c.generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sentBody(mock, 2).reasoning).toEqual({ effort: "medium" });
  });

  it("steps down to the nearest effort the slug names, and remembers", async () => {
    // The recorded refusal, with the slug's list narrowed to below "high".
    const refusal = fixture("codex-effort-rejected.json")
      .replace("'minimal'", "'high'")
      .replace(
        "'none', 'low', 'medium', 'high', and 'xhigh'",
        "'none', 'low', and 'medium'",
      );
    const mock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400, refusal))
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const c = client();
    const result = await c.generateCompletion(
      params({ reasoning: { effort: "high", summaries: true } }),
    );
    expect(sentBody(mock, 1).reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(result.reasoning?.downgradedTo).toBe("medium");

    const again = await c.generateCompletion(
      params({ reasoning: { effort: "high", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sentBody(mock, 2).reasoning.effort).toBe("medium");
    expect(again.reasoning?.downgradedTo).toBe("medium");
  });

  it("drops reasoning entirely when the refusal names no alternative", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(
          400,
          JSON.stringify({
            error: {
              message: "Reasoning is not supported for this model.",
              type: "invalid_request_error",
              param: "reasoning",
            },
          }),
        ),
      )
      .mockImplementation(async () =>
        sseResponse(fixture("codex-after-tool.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: false } }),
    );
    expect(sentBody(mock, 1).reasoning).toBeNull();
    expect(sentBody(mock, 1).include).toEqual([]);
    expect(result.reasoning?.downgradedTo).toBe("off");
    expect(result.content).toBe("Paris weather: 18°C, cloudy.");
  });

  it("does not learn from a 400 that is not about reasoning", async () => {
    const mock = vi.fn().mockResolvedValue(
      errorResponse(
        400,
        JSON.stringify({
          error: { message: "Invalid schema for function 'get_weather'." },
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    await expect(
      client().generateCompletion(
        params({ reasoning: { effort: "low", summaries: true } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not learn from a replay error about a reasoning item", async () => {
    const replay = JSON.stringify({
      error: {
        message:
          "Item 'rs_123' of type 'reasoning' was provided without its required following item.",
        type: "invalid_request_error",
        param: "input",
      },
    });
    const mock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400, replay))
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    await expect(
      client().generateCompletion(
        params({ reasoning: { effort: "low", summaries: true } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(mock).toHaveBeenCalledTimes(1);
    // The slug still reasons on the next call.
    await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(sentBody(mock, 1).reasoning).toEqual({
      effort: "low",
      summary: "auto",
    });
  });

  it("does not learn from a 401 or 429 that mentions reasoning", async () => {
    for (const status of [401, 429]) {
      resetReasoningDialectCache();
      const mock = vi
        .fn()
        .mockResolvedValueOnce(
          errorResponse(
            status,
            JSON.stringify({
              error: { message: "Reasoning model quota: unsupported plan." },
            }),
          ),
        )
        .mockImplementation(async () =>
          sseResponse(fixture("codex-summary.sse")),
        );
      vi.stubGlobal("fetch", mock);
      await client()
        .generateCompletion(
          params({ reasoning: { effort: "low", summaries: false } }),
        )
        .catch(() => undefined);
      await client().generateCompletion(
        params({ reasoning: { effort: "low", summaries: false } }),
      );
      const last = sentBody(mock, mock.mock.calls.length - 1);
      expect(last.reasoning).toEqual({ effort: "low" });
    }
  });

  it("forgets a learned refusal after an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const refusal = JSON.stringify({
        error: {
          message: "Reasoning is not supported for this model.",
          type: "invalid_request_error",
          param: "reasoning",
        },
      });
      const mock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(400, refusal))
        .mockImplementation(async () =>
          sseResponse(fixture("codex-after-tool.sse")),
        );
      vi.stubGlobal("fetch", mock);
      const wanted = params({ reasoning: { effort: "low", summaries: false } });
      await client().generateCompletion(wanted);
      await client().generateCompletion(wanted);
      expect(sentBody(mock, 2).reasoning).toBeNull();
      vi.advanceTimersByTime(60 * 60 * 1000);
      await client().generateCompletion(wanted);
      expect(sentBody(mock, 3).reasoning).toEqual({ effort: "low" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Codex reasoning items kept for the next round", () => {
  it("keeps none when the request sent no reasoning wire", async () => {
    // The slug refused reasoning, so the retry runs with `reasoning: null`
    // and `include: []`; the server may still emit reasoning items, but
    // without encrypted content they cannot be replayed under store:false.
    const refusal = JSON.stringify({
      error: {
        message: "Reasoning is not supported for this model.",
        type: "invalid_request_error",
        param: "reasoning",
      },
    });
    const withoutContent = fixture("codex-summary.sse").replace(
      /,"encrypted_content":"enc-fixture-\d+"/g,
      "",
    );
    const mock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400, refusal))
      .mockImplementation(async () => sseResponse(withoutContent));
    vi.stubGlobal("fetch", mock);
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(sentBody(mock, 1).reasoning).toBeNull();
    expect(sentBody(mock, 1).include).toEqual([]);
    expect(result.providerState).toBeUndefined();
  });

  it("keeps none when the request asked for effort none", async () => {
    const mock = vi
      .fn()
      .mockImplementation(async () =>
        sseResponse(fixture("codex-summary.sse")),
      );
    vi.stubGlobal("fetch", mock);
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "off", summaries: false } }),
    );
    expect(sentBody(mock).reasoning).toEqual({ effort: "none" });
    expect(sentBody(mock).include).toEqual([]);
    expect(result.providerState).toBeUndefined();
  });

  it("drops an item without encrypted content even when it was asked for", async () => {
    const withoutContent = fixture("codex-summary.sse").replace(
      /,"encrypted_content":"enc-fixture-\d+"/g,
      "",
    );
    const mock = vi
      .fn()
      .mockImplementation(async () => sseResponse(withoutContent));
    vi.stubGlobal("fetch", mock);
    const result = await client().generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(sentBody(mock).include).toEqual(["reasoning.encrypted_content"]);
    expect(result.providerState).toBeUndefined();
    // The summary still reaches the trail.
    expect(result.reasoning?.summary.length).toBeGreaterThan(0);
  });
});
