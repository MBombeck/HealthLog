import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicClient } from "../anthropic-client";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import type {
  AiMessage,
  AiReasoningEvent,
  AiToolDef,
  CompletionParams,
  CompletionResult,
} from "../types";

// safeFetch's requirePublicHost path runs through undici's own `fetch`.
// Delegate it to the global stub these tests install.
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

/**
 * v1.41 — Anthropic thinking at the wire. The response fixtures follow the
 * documented Messages API shapes (thinking blocks with `signature`,
 * `redacted_thinking` with `data`, interleaved text and tool_use):
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking.
 * No health data; signatures are placeholders.
 */
const FIXTURES = join(__dirname, "fixtures/reasoning");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const ok = (name: string) => async () =>
  new Response(fixture(name), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const fail = (status: number, name: string) => async () =>
  new Response(fixture(name), { status });

const TOOLS: AiToolDef[] = [
  {
    name: "get_weather",
    description: "Weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

function params(extra: Partial<CompletionParams> = {}): CompletionParams {
  return {
    system: "You are terse.",
    messages: [{ role: "user", content: "Weather in the capital of France?" }],
    maxTokens: 600,
    ...extra,
  };
}

function sent(mock: ReturnType<typeof vi.fn>, call = 0) {
  const init = mock.mock.calls[call][1];
  return { body: JSON.parse(init.body), headers: init.headers };
}

const client = (model: string) =>
  new AnthropicClient({ apiKey: "sk-ant-test-key", model });

beforeEach(() => {
  vi.restoreAllMocks();
  resetReasoningDialectCache();
});

describe("Anthropic thinking dialects", () => {
  it("keeps today's wire when no reasoning is asked, on a model that takes sampling", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-sonnet-4-6").generateCompletion(params());
    const { body, headers } = sent(mock);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(600);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });

  it("never sends temperature from 4.7 on, reasoning or not", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-opus-5").generateCompletion(params());
    await client("claude-opus-4-7").generateCompletion(params());
    await client("claude-sonnet-5").generateCompletion(params());
    for (const call of [0, 1, 2]) {
      expect(sent(mock, call).body).not.toHaveProperty("temperature");
    }
  });

  it("asks a 4.5 model for a thinking budget and interleaves on tool rounds", async () => {
    const mock = vi
      .fn()
      .mockImplementation(ok("anthropic-thinking-tool-round.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-sonnet-4-5").generateCompletion(
      params({
        tools: TOOLS,
        toolChoice: "auto",
        reasoning: { effort: "medium", summaries: true },
      }),
    );
    const { body, headers } = sent(mock);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    // budget_tokens must stay below max_tokens: answer + budget.
    expect(body.max_tokens).toBe(600 + 4096);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("output_config");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });

  it("asks 4.6 and later for adaptive thinking with an effort", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-opus-5",
    ]) {
      await client(model).generateCompletion(
        params({
          tools: TOOLS,
          reasoning: { effort: "high", summaries: true },
        }),
      );
    }
    for (const call of [0, 1, 2]) {
      const { body, headers } = sent(mock, call);
      expect(body.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
      expect(body.output_config).toEqual({ effort: "high" });
      expect(body.max_tokens).toBe(600 + 12_000);
      expect(body).not.toHaveProperty("temperature");
      expect(headers).not.toHaveProperty("anthropic-beta");
    }
  });

  it("switches off where it can and falls to low effort where thinking is always on", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const off = { reasoning: { effort: "off" as const, summaries: true } };
    await client("claude-opus-4-7").generateCompletion(params(off));
    await client("claude-sonnet-4-5").generateCompletion(params(off));
    await client("claude-opus-5").generateCompletion(params(off));
    expect(sent(mock, 0).body).not.toHaveProperty("thinking");
    expect(sent(mock, 0).body).not.toHaveProperty("temperature");
    expect(sent(mock, 1).body).not.toHaveProperty("thinking");
    expect(sent(mock, 1).body.temperature).toBe(0.3);
    expect(sent(mock, 2).body.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(sent(mock, 2).body.output_config).toEqual({ effort: "low" });
  });

  it("does not ask a model that cannot think", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-3-5-sonnet-latest").generateCompletion(
      params({ reasoning: { effort: "high", summaries: true } }),
    );
    expect(sent(mock).body).not.toHaveProperty("thinking");
    expect(sent(mock).body.temperature).toBe(0.3);
  });
});

describe("Anthropic thinking replies", () => {
  it("returns the summary after the reply and keeps the whole reply as state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(ok("anthropic-thinking-tool-round.json")),
    );
    const events: AiReasoningEvent[] = [];
    const result = await client("claude-sonnet-4-5").generateCompletion(
      params({
        tools: TOOLS,
        reasoning: { effort: "medium", summaries: true },
        onReasoning: (e) => events.push(e),
      }),
    );
    const thought =
      "**Choosing the city**\nThe capital of France is Paris, so the weather lookup needs Paris.";
    expect(events).toEqual([
      { kind: "title", text: "Choosing the city" },
      { kind: "text", text: thought },
      { kind: "done", text: "" },
    ]);
    expect(result.reasoning).toEqual({ summary: [thought], tokens: null });
    expect(result.content).toBe("Let me look that up.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.providerState).toEqual({
      providerType: "anthropic",
      model: "claude-sonnet-4-5",
      items: JSON.parse(fixture("anthropic-thinking-tool-round.json")).content,
    });
  });

  it("joins every text block, not just the first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(ok("anthropic-after-tool.json")),
    );
    const result = await client("claude-sonnet-4-5").generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(result.content).toBe("Paris is at 18 °C and cloudy.");
    // A redacted block has no readable text, but it is state.
    expect(result.reasoning?.summary).toEqual([]);
    expect(result.providerState?.items[0]).toEqual({
      type: "redacted_thinking",
      data: "redacted-fixture-b1",
    });
  });

  it("no longer tells a prose request to answer in JSON", async () => {
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-sonnet-4-6").generateCompletion(params());
    await client("claude-sonnet-4-6").generateCompletion(
      params({ responseFormat: "json" }),
    );
    expect(sent(mock, 0).body.messages[0].content).toBe(
      "Weather in the capital of France?",
    );
    expect(sent(mock, 1).body.messages[0].content).toMatch(
      /single JSON object/,
    );
  });
});

describe("Anthropic thinking round trip", () => {
  async function firstRound(
    model = "claude-sonnet-4-5",
  ): Promise<CompletionResult> {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(ok("anthropic-thinking-tool-round.json")),
    );
    return client(model).generateCompletion(
      params({
        tools: TOOLS,
        reasoning: { effort: "medium", summaries: true },
      }),
    );
  }

  function next(
    first: CompletionResult,
    state = first.providerState,
  ): AiMessage[] {
    return [
      { role: "user", content: "Weather in the capital of France?" },
      {
        role: "assistant",
        content: first.content,
        toolCalls: first.toolCalls,
        providerState: state,
      },
      {
        role: "tool",
        toolCallId: first.toolCalls![0].id,
        content: '{"tempC":18}',
      },
    ];
  }

  it("hands the assistant reply back unchanged, signature included", async () => {
    const first = await firstRound();
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    await client("claude-sonnet-4-5").generateCompletion(
      params({
        messages: next(first),
        tools: TOOLS,
        reasoning: { effort: "medium", summaries: true },
      }),
    );
    const { body } = sent(mock);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: JSON.parse(fixture("anthropic-thinking-tool-round.json"))
        .content,
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("leads with the thinking blocks when the turn's calls changed", async () => {
    const first = await firstRound();
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const messages = next(first);
    messages[1] = {
      ...messages[1],
      toolCalls: [{ id: "toolu_other", name: "get_weather", arguments: "{}" }],
    };
    messages[2] = { ...messages[2], toolCallId: "toolu_other" };
    await client("claude-sonnet-4-5").generateCompletion(
      params({
        messages,
        tools: TOOLS,
        reasoning: { effort: "medium", summaries: true },
      }),
    );
    const content = sent(mock).body.messages[1].content;
    expect(content.map((b: { type: string }) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    expect(content[0].signature).toBe("sig-fixture-a1");
    expect(content[2].id).toBe("toolu_other");
  });

  it("turns thinking off for a tool round another provider started", async () => {
    const first = await firstRound();
    const mock = vi.fn().mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const fromCodex = {
      providerType: "codex" as const,
      model: "gpt-5.5",
      items: [{ type: "reasoning" }],
    };
    const result = await client("claude-sonnet-4-5").generateCompletion(
      params({
        messages: next(first, fromCodex),
        tools: TOOLS,
        reasoning: { effort: "medium", summaries: true },
      }),
    );
    const { body, headers } = sent(mock);
    expect(body).not.toHaveProperty("thinking");
    expect(headers).not.toHaveProperty("anthropic-beta");
    // The foreign state never reaches the wire.
    expect(JSON.stringify(body)).not.toContain('"reasoning"');
    expect(
      body.messages[1].content.map((b: { type: string }) => b.type),
    ).toEqual(["text", "tool_use"]);
    // Not a refusal by the provider: no downgrade reported.
    expect(result.reasoning?.downgradedTo).toBeUndefined();
  });
});

describe("Anthropic thinking refusals", () => {
  it("falls from adaptive to a budget on an unknown name, and remembers", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(fail(400, "anthropic-adaptive-rejected.json"))
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = client("my-claude-proxy");
    const result = await c.generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(sent(mock, 0).body.thinking.type).toBe("adaptive");
    expect(sent(mock, 1).body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
    expect(sent(mock, 1).body).not.toHaveProperty("output_config");
    expect(result.content).toBe("Paris is at 18 °C and cloudy.");
    expect(result.reasoning?.downgradedTo).toBeUndefined();

    await c.generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sent(mock, 2).body.thinking.type).toBe("enabled");
  });

  it("answers without thinking when every form is refused", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(fail(400, "anthropic-adaptive-rejected.json"))
      .mockImplementationOnce(fail(400, "anthropic-adaptive-rejected.json"))
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const result = await client("my-claude-proxy").generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sent(mock, 2).body).not.toHaveProperty("thinking");
    expect(result.reasoning?.downgradedTo).toBe("off");
  });

  it("drops temperature an unknown model refuses, and remembers", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(fail(400, "anthropic-temperature-rejected.json"))
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = client("my-claude-proxy");
    await c.generateCompletion(params());
    expect(sent(mock, 0).body.temperature).toBe(0.3);
    expect(sent(mock, 1).body).not.toHaveProperty("temperature");
    await c.generateCompletion(params());
    expect(mock).toHaveBeenCalledTimes(3);
    expect(sent(mock, 2).body).not.toHaveProperty("temperature");
  });

  it("raises a 400 that is about something else, once", async () => {
    const mock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages: too long",
            },
          }),
          { status: 400 },
        ),
    );
    vi.stubGlobal("fetch", mock);
    await expect(
      client("claude-opus-5").generateCompletion(
        params({ reasoning: { effort: "high", summaries: true } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400, upstream: "anthropic" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("Anthropic thinking refusals the client must not learn from", () => {
  const replay = async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`. When `thinking` is enabled, a final `assistant` message must start with a thinking block (preceeding the lastmost set of `tool_use` and `tool_result` blocks). We recommend you include thinking blocks from previous turns.",
        },
      }),
      { status: 400 },
    );

  it("raises a replay error once and keeps the thinking form", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(replay)
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = client("my-claude-proxy");
    const wanted = params({ reasoning: { effort: "low", summaries: true } });
    await expect(c.generateCompletion(wanted)).rejects.toMatchObject({
      httpStatus: 400,
      upstream: "anthropic",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    await c.generateCompletion(wanted);
    expect(sent(mock, 1).body.thinking.type).toBe("adaptive");
  });

  it("does not learn from a 429 that mentions thinking", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "rate_limit_error",
                message:
                  "Extended thinking output tokens per minute exceeded; not allowed until reset.",
              },
            }),
            { status: 429 },
          ),
      )
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = client("my-claude-proxy");
    const wanted = params({ reasoning: { effort: "low", summaries: true } });
    await expect(c.generateCompletion(wanted)).rejects.toMatchObject({
      httpStatus: 429,
    });
    await c.generateCompletion(wanted);
    expect(sent(mock, 1).body.thinking.type).toBe("adaptive");
  });

  it("tries the full thinking form again an hour after a refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const mock = vi
        .fn()
        .mockImplementationOnce(fail(400, "anthropic-adaptive-rejected.json"))
        .mockImplementation(ok("anthropic-after-tool.json"));
      vi.stubGlobal("fetch", mock);
      const c = client("my-claude-proxy");
      const wanted = params({ reasoning: { effort: "low", summaries: true } });
      await c.generateCompletion(wanted);
      await c.generateCompletion(wanted);
      expect(sent(mock, 2).body.thinking.type).toBe("enabled");
      vi.advanceTimersByTime(60 * 60 * 1000);
      await c.generateCompletion(wanted);
      expect(sent(mock, 3).body.thinking.type).toBe("adaptive");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Anthropic adaptive rounds that chose not to think", () => {
  it("keeps thinking on for the next round of its own turn", async () => {
    const noThought = {
      id: "msg_fixture_03",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_fixture_02",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 300, output_tokens: 20 },
    };
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify(noThought), { status: 200 }),
      )
      .mockImplementation(ok("anthropic-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = client("claude-opus-5");
    const reasoning = { effort: "medium" as const, summaries: true };
    const first = await c.generateCompletion(
      params({ tools: TOOLS, reasoning }),
    );
    expect(first.providerState?.items).toEqual(noThought.content);
    await c.generateCompletion(
      params({
        tools: TOOLS,
        reasoning,
        messages: [
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: first.content,
            toolCalls: first.toolCalls,
            providerState: first.providerState,
          },
          { role: "tool", toolCallId: "toolu_fixture_02", content: "{}" },
        ],
      }),
    );
    expect(sent(mock, 1).body.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });
});
