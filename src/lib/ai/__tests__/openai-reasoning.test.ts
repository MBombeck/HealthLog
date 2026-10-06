import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIClient } from "../openai-client";
import { resetJsonModeDialectCache, jsonModeDialectFor } from "../json-dialect";
import { resetReasoningDialectCache } from "../reasoning/dialect-cache";
import type { AiReasoningEvent, AiToolDef, CompletionParams } from "../types";

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
 * v1.41 — reasoning on the Chat Completions wire. The OpenRouter fixtures
 * were recorded on 2026-10-06 with a throwaway prompt (no health data);
 * signatures and encrypted payloads are placeholders. The gateway refusal is
 * the standard OpenAI error envelope.
 */
const FIXTURES = join(__dirname, "fixtures/reasoning");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const ok = (name: string) => async () =>
  new Response(fixture(name), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const plain =
  (content: string, extra: Record<string, unknown> = {}) =>
  async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content, ...extra },
            finish_reason: "stop",
          },
        ],
        usage: {
          total_tokens: 90,
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
      { status: 200 },
    );

const TOOLS: AiToolDef[] = [
  {
    name: "get_weather",
    description: "Weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
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

const body = (mock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(mock.mock.calls[call][1].body);

const openai = (model: string) =>
  new OpenAIClient({
    apiKey: "sk-test",
    model,
    baseUrl: "https://api.openai.com/v1",
  });
const gateway = (baseUrl: string, model: string) =>
  new OpenAIClient({
    apiKey: "sk-test",
    model,
    baseUrl,
    providerType: "openai-compatible",
  });

beforeEach(() => {
  vi.restoreAllMocks();
  resetReasoningDialectCache();
  resetJsonModeDialectCache();
});

describe("OpenAI reasoning", () => {
  it("sends nothing new when the call asks for no reasoning", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    const result = await openai("gpt-5.5").generateCompletion(params());
    expect(body(mock)).not.toHaveProperty("reasoning_effort");
    expect(body(mock).max_completion_tokens).toBe(600);
    expect(result.reasoning).toBeUndefined();
  });

  it("sends the effort on a round without tools, with room to think", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    const result = await openai("gpt-5.5").generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(body(mock).reasoning_effort).toBe("medium");
    expect(body(mock).max_completion_tokens).toBe(600 + 4096);
    expect(body(mock)).not.toHaveProperty("temperature");
    expect(result.reasoning).toEqual({ summary: [], tokens: 40 });
  });

  it("sends no effort on a tool round", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    await openai("gpt-5.5").generateCompletion(
      params({ tools: TOOLS, reasoning: { effort: "high", summaries: true } }),
    );
    expect(body(mock)).not.toHaveProperty("reasoning_effort");
    expect(body(mock).max_completion_tokens).toBe(600);
  });

  it("maps off onto each family's lowest effort, and skips non-reasoning models", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    const off = { reasoning: { effort: "off" as const, summaries: false } };
    await openai("gpt-5.5").generateCompletion(params(off));
    await openai("gpt-5-mini").generateCompletion(params(off));
    await openai("o3").generateCompletion(params(off));
    await openai("gpt-4o").generateCompletion(params(off));
    expect(body(mock, 0).reasoning_effort).toBe("none");
    expect(body(mock, 1).reasoning_effort).toBe("minimal");
    expect(body(mock, 2).reasoning_effort).toBe("low");
    expect(body(mock, 3)).not.toHaveProperty("reasoning_effort");
  });
});

describe("Gateway reasoning", () => {
  it("lets the call's level win over the entry's stored setting", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    const c = gateway("https://litellm.example.com/v1", "qwen3");
    c.reasoningEffort = "high";
    await c.generateCompletion(params());
    await c.generateCompletion(
      params({ reasoning: { effort: "low", summaries: true } }),
    );
    expect(body(mock, 0).reasoning_effort).toBe("high");
    expect(body(mock, 1).reasoning_effort).toBe("low");
  });

  it("reads reasoning_content as the summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          plain("Paris.", { reasoning_content: "**Capital**\nIt is Paris." }),
        ),
    );
    const events: AiReasoningEvent[] = [];
    const result = await gateway(
      "https://litellm.example.com/v1",
      "qwen3",
    ).generateCompletion(
      params({
        reasoning: { effort: "medium", summaries: true },
        onReasoning: (e) => events.push(e),
      }),
    );
    expect(result.content).toBe("Paris.");
    expect(result.reasoning?.summary).toEqual(["**Capital**\nIt is Paris."]);
    expect(events.map((e) => e.kind)).toEqual(["title", "text", "done"]);
  });

  it("speaks OpenRouter's dialect and carries reasoning_details to the next round", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(ok("openrouter-claude-tool-round.json"))
      .mockImplementation(ok("openrouter-claude-after-tool.json"));
    vi.stubGlobal("fetch", mock);
    const c = gateway(
      "https://openrouter.ai/api/v1",
      "anthropic/claude-haiku-4.5",
    );
    const first = await c.generateCompletion(
      params({ tools: TOOLS, reasoning: { effort: "low", summaries: true } }),
    );
    expect(body(mock, 0).reasoning).toEqual({ effort: "low" });
    expect(body(mock, 0)).not.toHaveProperty("reasoning_effort");
    expect(first.finishReason).toBe("tool_calls");
    expect(first.reasoning?.tokens).toBe(58);
    expect(first.reasoning?.summary[0]).toMatch(/capital of France is Paris/);
    const details = JSON.parse(fixture("openrouter-claude-tool-round.json"))
      .choices[0].message.reasoning_details;
    expect(first.providerState).toEqual({
      providerType: "openai-compatible",
      model: "anthropic/claude-haiku-4.5",
      items: [{ reasoning_details: details }],
    });

    await c.generateCompletion(
      params({
        tools: TOOLS,
        reasoning: { effort: "low", summaries: true },
        messages: [
          { role: "user", content: "Weather in the capital of France?" },
          {
            role: "assistant",
            content: first.content,
            toolCalls: first.toolCalls,
            providerState: first.providerState,
          },
          { role: "tool", toolCallId: first.toolCalls![0].id, content: "{}" },
        ],
      }),
    );
    const assistant = body(mock, 1).messages[2];
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_details).toEqual(details);
  });

  it("does not hand state to a different model", async () => {
    const mock = vi.fn().mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    await gateway(
      "https://openrouter.ai/api/v1",
      "openai/gpt-5-mini",
    ).generateCompletion(
      params({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "get_weather", arguments: "{}" }],
            providerState: {
              providerType: "openai-compatible",
              model: "anthropic/claude-haiku-4.5",
              items: [{ reasoning_details: [{ type: "reasoning.text" }] }],
            },
          },
          { role: "tool", toolCallId: "c1", content: "{}" },
        ],
      }),
    );
    expect(body(mock).messages[2]).not.toHaveProperty("reasoning_details");
  });

  it("retries once without reasoning when the gateway refuses it, and remembers", async () => {
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(fixture("gateway-reasoning-rejected.json"), {
            status: 400,
          }),
      )
      .mockImplementation(plain("ok"));
    vi.stubGlobal("fetch", mock);
    const c = gateway("https://litellm.example.com/v1", "llama3");
    const result = await c.generateCompletion(
      params({
        responseFormat: "json",
        reasoning: { effort: "medium", summaries: true },
      }),
    );
    expect(body(mock, 0).reasoning_effort).toBe("medium");
    expect(body(mock, 1)).not.toHaveProperty("reasoning_effort");
    // The JSON flag survives: the refusal named the reasoning field.
    expect(body(mock, 1).response_format).toEqual({ type: "json_object" });
    expect(jsonModeDialectFor("https://litellm.example.com/v1")).toBe(
      "response_format",
    );
    expect(result.reasoning?.downgradedTo).toBe("off");

    await c.generateCompletion(
      params({ reasoning: { effort: "medium", summaries: true } }),
    );
    expect(mock).toHaveBeenCalledTimes(3);
    expect(body(mock, 2)).not.toHaveProperty("reasoning_effort");
  });
});
