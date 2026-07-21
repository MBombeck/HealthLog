import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIClient } from "../openai-client";
import { singleUserTurn } from "../types";

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher). Delegate it to the global `fetch`
// stub these tests install so the existing interception still applies.
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

describe("OpenAIClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"test"}' } }],
          usage: { total_tokens: 42 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "You are a doctor.",
        user: "Analyze this data.",
        responseFormat: "json",
      }),
    );

    expect(result.content).toBe('{"summary":"test"}');
    expect(result.tokensUsed).toBe(42);
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.providerType).toBe("admin-key");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.response_format).toEqual({ type: "json_object" });
    // No seed passed → field omitted from the body entirely.
    expect(body).not.toHaveProperty("seed");
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.3);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("forces JSON mode only when responseFormat is json AND no tools (M-1)", async () => {
    const replyContent = (content: string) =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content } }],
            usage: { total_tokens: 1 },
          }),
      });

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    // 1. Prose Coach path (no responseFormat, no tools) → NO json_object. This
    //    is the F1 forced-final round contract: JSON mode would corrupt prose.
    const proseFetch = replyContent("Here is a plain-prose reply.");
    vi.stubGlobal("fetch", proseFetch);
    await client.generateCompletion(
      singleUserTurn({ system: "coach", user: "how am I doing?" }),
    );
    expect(JSON.parse(proseFetch.mock.calls[0][1].body)).not.toHaveProperty(
      "response_format",
    );

    // 2. responseFormat:"json" but tools present → still NO json_object (a tool
    //    round must not be coerced into a JSON object).
    const toolFetch = replyContent("{}");
    vi.stubGlobal("fetch", toolFetch);
    await client.generateCompletion({
      system: "s",
      messages: [{ role: "user", content: "u" }],
      responseFormat: "json",
      tools: [
        {
          name: "t",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(JSON.parse(toolFetch.mock.calls[0][1].body)).not.toHaveProperty(
      "response_format",
    );

    // 3. responseFormat:"json" with no tools → json_object IS sent (insight /
    //    extraction callers keep strict JSON).
    const jsonFetch = replyContent('{"summary":"x"}');
    vi.stubGlobal("fetch", jsonFetch);
    await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );
    expect(JSON.parse(jsonFetch.mock.calls[0][1].body).response_format).toEqual(
      { type: "json_object" },
    );
  });

  it("threads a deterministic seed onto the request body when supplied", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"x"}' } }],
          usage: { total_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test", seed: 1234 }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.seed).toBe(1234);
  });

  it.each([
    ["gpt-5.4-nano", 1000, "https://api.openai.com/v1"],
    ["gpt-5-2025-08-07", 321, "https://api.openai.com/v1"],
    ["o1", 321, "https://api.openai.com/v1"],
    ["o3-mini", 321, "https://api.openai.com/v1"],
    ["o4-mini-2025-04-16", 321, "https://api.openai.com/v1"],
    ["gpt-5.4-mini", 321, "https://API.OPENAI.COM:443/v1/"],
  ])(
    "uses the canonical modern token wire for %s",
    async (model, expectedBudget, baseUrl) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "ok" } }],
            usage: { total_tokens: 5 },
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = new OpenAIClient({
        apiKey: "sk-test",
        model,
        baseUrl,
      });

      await client.generateCompletion(
        singleUserTurn({
          system: "test",
          user: "test",
          temperature: 0.7,
          ...(expectedBudget === 1000 ? {} : { maxTokens: expectedBudget }),
          seed: 1234,
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_completion_tokens).toBe(expectedBudget);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("seed");
    },
  );

  it("keeps the legacy sampling wire for canonical GPT-4 models", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "test",
        user: "test",
        temperature: 0.7,
        maxTokens: 321,
        seed: 1234,
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(321);
    expect(body.temperature).toBe(0.7);
    expect(body.seed).toBe(1234);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps the legacy sampling wire for GPT-5-named models on compatible gateways", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-5.4-nano",
      baseUrl: "https://gateway.example.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "test",
        user: "test",
        temperature: 0.7,
        maxTokens: 321,
        seed: 1234,
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(321);
    expect(body.temperature).toBe(0.7);
    expect(body.seed).toBe(1234);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await expect(
      client.generateCompletion(
        singleUserTurn({ system: "test", user: "test" }),
      ),
    ).rejects.toThrow("OpenAI request failed (429)");
  });

  it("uses custom base URL for OpenRouter", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"test":true}' } }],
          usage: { total_tokens: 10 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test" }),
    );

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("maps tool defs onto the function wire and parses tool_calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "fetch_glucose",
                      arguments: '{"window":"last30days"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        tools: [
          {
            name: "fetch_glucose",
            description: "Fetch glucose readings",
            parameters: { type: "object", properties: {} },
          },
        ],
        toolChoice: "auto",
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "fetch_glucose",
          description: "Fetch glucose readings",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "fetch_glucose",
        arguments: '{"window":"last30days"}',
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.cachedInputTokens).toBe(8);
  });

  it("folds image parts into the multimodal content array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"rows":[]}' } }],
          usage: { total_tokens: 3 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "transcribe",
        images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userTurn = body.messages[1];
    expect(userTurn.role).toBe("user");
    // Text-first, then image (matches the pre-refactor OpenAI vision wire).
    expect(userTurn.content[0]).toEqual({ type: "text", text: "transcribe" });
    expect(userTurn.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("tags an empty-content reply with sentinel httpStatus 0 + kind for the chain classifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "" } }],
            usage: { total_tokens: 5 },
          }),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await client
      .generateCompletion(singleUserTurn({ system: "s", user: "u" }))
      .then(
        () => {
          throw new Error("expected an empty-content throw");
        },
        (err: unknown) => {
          // The throw distinguishes an empty 200-OK reply from ECONNRESET:
          // sentinel httpStatus 0 (still classified as a hard failure, so the
          // cascade is unchanged) + a `kind` discriminator for observability.
          expect((err as Error).message).toContain("empty content");
          expect((err as { httpStatus?: number }).httpStatus).toBe(0);
          expect((err as { kind?: string }).kind).toBe("empty_response");
        },
      );
  });

  // v1.28.28 (#470) — LiteLLM shims Anthropic JSON mode as a synthesized tool
  // call: finish_reason "tool_calls", empty / "{}" content, the actual JSON in
  // tool_calls[0].function.arguments. In JSON mode (never combined with real
  // tools) the arguments string becomes the content instead of silently
  // emptying the insight.
  it("falls back to tool_calls[0].function.arguments when JSON mode returns empty content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "json_response",
                        arguments: '{"summary":"via tool shim"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { total_tokens: 9 },
          }),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://litellm.example.com/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );
    expect(result.content).toBe('{"summary":"via tool shim"}');
  });

  it("also applies the tool-call shim when JSON-mode content is a bare '{}'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: "{}",
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "json_response",
                        arguments: '{"summary":"real payload"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://litellm.example.com/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );
    expect(result.content).toBe('{"summary":"real payload"}');
  });

  it("leaves the normal JSON-mode content path untouched by the tool-call shim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: '{"summary":"prose content wins"}',
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "json_response",
                        arguments: '{"summary":"never used"}',
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              },
            ],
          }),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );
    expect(result.content).toBe('{"summary":"prose content wins"}');
  });

  it("threads the caller's abort signal onto the upstream fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const ctrl = new AbortController();
    await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", signal: ctrl.signal }),
    );

    // safeFetch composes the caller signal with the timeout via AbortSignal.any,
    // so a signal lands on the dispatched fetch init.
    const init = mockFetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // Aborting the caller's controller propagates to the composed signal.
    ctrl.abort();
    expect(init.signal.aborted).toBe(true);
  });
});
