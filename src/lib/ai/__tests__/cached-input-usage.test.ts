/**
 * Cached input, per provider, end to end into the Coach turn budget.
 *
 * The turn budget counts cached input at a tenth (`CACHED_INPUT_WEIGHT`).
 * That only works when two things hold for every client:
 *
 *   1. `tokensUsed` is the gross count, cached input included, and
 *      `cachedInputTokens` is the cached share of it. The budget and the
 *      daily ledger both subtract the cached share from the gross.
 *   2. The cached count is read from where the provider puts it: Codex and
 *      the Responses wire under `usage.input_tokens_details.cached_tokens`,
 *      Chat Completions (OpenAI, gateways, local servers that report it)
 *      under `usage.prompt_tokens_details.cached_tokens`, Anthropic as
 *      `usage.cache_read_input_tokens` beside an `input_tokens` that does
 *      NOT include it.
 *
 * Each fixture below is a usage payload in the provider's own shape for the
 * same round: 20,000 tokens of input of which 18,000 came from the cache,
 * and 500 of output. Every client must turn it into gross 20,500 / cached
 * 18,000, which the budget weighs at 2,000 + 500 + 1,800 = 4,300.
 *
 * And the cache has to be hit at all: the Codex backend routes a request to
 * a cache by `prompt_cache_key` (the official client sets it to its thread
 * id), and `api.openai.com` documents the same field. A turn's rounds share
 * one key, so round two finds round one's prefix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../local-host-allowlist", () => ({ aiEgressPolicyFor: () => ({}) }));

import { AnthropicClient } from "../anthropic-client";
import { CodexClient } from "../codex-client";
import { OpenAIClient } from "../openai-client";
import { LocalOpenAICompatibleClient } from "../local-client";
import { singleUserTurn, type CompletionResult } from "../types";
import { weightedRoundTokens } from "@/lib/ai/coach/tools/turn-budget";

const INPUT = 20_000;
const CACHED = 18_000;
const OUTPUT = 500;
const GROSS = INPUT + OUTPUT;
const WEIGHTED = INPUT - CACHED + OUTPUT + CACHED / 10;

function expectDiscounted(result: CompletionResult) {
  expect(result.tokensUsed).toBe(GROSS);
  expect(result.cachedInputTokens).toBe(CACHED);
  expect(
    weightedRoundTokens({
      tokens: result.tokensUsed,
      cachedTokens: result.cachedInputTokens,
    }),
  ).toBe(WEIGHTED);
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) controller.enqueue(encoder.encode(ev));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function codexStream(): Response {
  return sse([
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp1",
        usage: {
          input_tokens: INPUT,
          input_tokens_details: { cached_tokens: CACHED },
          output_tokens: OUTPUT,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: GROSS,
        },
      },
    })}\n\n`,
  ]);
}

/** The Chat Completions usage block, as OpenAI and most gateways send it. */
const chatUsage = {
  prompt_tokens: INPUT,
  completion_tokens: OUTPUT,
  total_tokens: GROSS,
  prompt_tokens_details: { cached_tokens: CACHED },
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function codexClient() {
  return new CodexClient({
    accessToken: "t",
    accountId: "a",
    onTokenRefresh: vi
      .fn()
      .mockResolvedValue({ accessToken: "t", accountId: "a" }),
    slugChain: ["gpt-5-codex"],
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("cached input reaches the turn budget, per provider", () => {
  it("codex: input_tokens_details.cached_tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(codexStream()));
    const result = await codexClient().generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    expectDiscounted(result);
  });

  it("openai (Chat Completions): prompt_tokens_details.cached_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: chatUsage,
        }),
      ),
    );
    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });
    expectDiscounted(
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      ),
    );
  });

  it("gateway (OpenRouter and the like): the same Chat Completions block", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: chatUsage,
        }),
      ),
    );
    const client = new OpenAIClient({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      providerType: "openai-compatible",
    });
    expectDiscounted(
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      ),
    );
  });

  it("anthropic: cache reads ride beside input_tokens, not inside it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            // Anthropic's input_tokens counts only what came after the last
            // cache breakpoint; reads and writes are reported beside it.
            input_tokens: INPUT - CACHED,
            cache_read_input_tokens: CACHED,
            cache_creation_input_tokens: 0,
            output_tokens: OUTPUT,
          },
        }),
      ),
    );
    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-5",
    });
    expectDiscounted(
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      ),
    );
  });

  it("anthropic: a cache write counts in full", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 2_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 18_000,
            output_tokens: OUTPUT,
          },
        }),
      ),
    );
    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-5",
    });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    expect(result.tokensUsed).toBe(GROSS);
    expect(result.cachedInputTokens ?? 0).toBe(0);
  });

  it("local: prompt_tokens_details.cached_tokens where the server reports it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: chatUsage,
        }),
      ),
    );
    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });
    expectDiscounted(
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      ),
    );
  });

  it("local, streamed: the usage frame's cached count", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: chatUsage })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        ),
    );
    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });
    expectDiscounted(
      await client.generateCompletionStream(
        singleUserTurn({ system: "s", user: "u" }),
        () => {},
      ),
    );
  });
});

describe("a turn's rounds share one prompt cache key", () => {
  it("codex sends prompt_cache_key and one session id for every round with the same key", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(codexStream()));
    vi.stubGlobal("fetch", fetchMock);
    const client = codexClient();
    const params = {
      ...singleUserTurn({ system: "s", user: "u" }),
      cacheKey: "coach-turn-key",
    };
    await client.generateCompletion(params);
    await client.generateCompletion(params);

    const [first, second] = fetchMock.mock.calls.map(
      (call) => call[1] as { body: string; headers: Record<string, string> },
    );
    expect(JSON.parse(first.body).prompt_cache_key).toBe("coach-turn-key");
    expect(JSON.parse(second.body).prompt_cache_key).toBe("coach-turn-key");
    expect(first.headers.session_id).toBe(second.headers.session_id);
    expect(first.headers.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("codex without a key sends none and keeps a fresh session per call", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(codexStream()));
    vi.stubGlobal("fetch", fetchMock);
    const client = codexClient();
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
    const [first, second] = fetchMock.mock.calls.map(
      (call) => call[1] as { body: string; headers: Record<string, string> },
    );
    expect("prompt_cache_key" in JSON.parse(first.body)).toBe(false);
    expect(first.headers.session_id).not.toBe(second.headers.session_id);
  });

  it("api.openai.com gets prompt_cache_key; a gateway never does", async () => {
    const reply = () =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: chatUsage,
        }),
      );
    const fetchMock = vi.fn().mockImplementation(reply);
    vi.stubGlobal("fetch", fetchMock);
    const params = {
      ...singleUserTurn({ system: "s", user: "u" }),
      cacheKey: "coach-turn-key",
    };
    await new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    }).generateCompletion(params);
    await new OpenAIClient({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      providerType: "openai-compatible",
    }).generateCompletion(params);
    const [direct, gateway] = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1] as { body: string }).body),
    );
    expect(direct.prompt_cache_key).toBe("coach-turn-key");
    expect("prompt_cache_key" in gateway).toBe(false);
  });
});
