import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAIProvider } from "../mock-client";
import { OpenAIClient } from "../openai-client";
import { AnthropicClient } from "../anthropic-client";
import { LocalOpenAICompatibleClient } from "../local-client";
import { CodexClient } from "../codex-client";
import type { AIProvider, CompletionResult } from "../types";

/**
 * Provider-contract tests: every concrete AIProvider implementation must
 * satisfy the same shape — return a `CompletionResult` with the four
 * required fields populated. This is the "consolidated behind one
 * interface" guarantee from Phase C1 acceptance criterion #1.
 *
 * Each test stubs the provider's network dependency and asserts the
 * shape on a happy path. Error paths live in each provider's dedicated
 * test file (codex-client.test.ts, openai-client.test.ts, …).
 */

function assertCompletionResult(result: CompletionResult): void {
  expect(typeof result.content).toBe("string");
  expect(result.content.length).toBeGreaterThan(0);
  expect(["codex", "admin-key", "anthropic", "local"]).toContain(
    result.providerType,
  );
  expect(typeof result.model).toBe("string");
  expect(
    result.tokensUsed === null || typeof result.tokensUsed === "number",
  ).toBe(true);
}

describe("AIProvider contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The local-provider contract test points at a localhost OpenAI-
    // compatible server (Ollama / LM Studio). safeFetch enforces the
    // SSRF guard unless the operator explicitly opts in.
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("MockAIProvider — default response satisfies CompletionResult shape", async () => {
    const provider: AIProvider = new MockAIProvider();
    const result = await provider.generateCompletion({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    assertCompletionResult(result);
    expect(result.providerType).toBe("local");
    expect(result.model).toBe("mock-model");
  });

  it("MockAIProvider — records calls and walks the response queue", async () => {
    const mock = new MockAIProvider({
      responses: ['{"a":1}', '{"a":2}'],
      tokensUsed: [10, 20],
      providerType: "codex",
    });
    const r1 = await mock.generateCompletion({
      systemPrompt: "s",
      userPrompt: "u1",
    });
    const r2 = await mock.generateCompletion({
      systemPrompt: "s",
      userPrompt: "u2",
    });
    const r3 = await mock.generateCompletion({
      systemPrompt: "s",
      userPrompt: "u3",
    });
    expect(r1.content).toBe('{"a":1}');
    expect(r1.tokensUsed).toBe(10);
    expect(r2.content).toBe('{"a":2}');
    expect(r2.tokensUsed).toBe(20);
    // Last entry repeats once the queue is exhausted.
    expect(r3.content).toBe('{"a":2}');
    expect(mock.callCount).toBe(3);
    expect(mock.calls.map((c) => c.userPrompt)).toEqual(["u1", "u2", "u3"]);
  });

  it("MockAIProvider — rejectWith causes generateCompletion to throw", async () => {
    const mock = new MockAIProvider({ rejectWith: new Error("boom") });
    await expect(
      mock.generateCompletion({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("boom");
  });

  it("OpenAIClient — happy path returns CompletionResult shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"summary":"ok"}' } }],
            usage: { total_tokens: 17 },
          }),
      }),
    );

    const provider: AIProvider = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });
    const result = await provider.generateCompletion({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    assertCompletionResult(result);
    expect(result.providerType).toBe("admin-key");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.tokensUsed).toBe(17);
  });

  it("AnthropicClient — happy path returns CompletionResult shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: '{"summary":"ok"}' }],
            usage: { input_tokens: 5, output_tokens: 9 },
          }),
      }),
    );
    const provider: AIProvider = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-latest",
    });
    const result = await provider.generateCompletion({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    assertCompletionResult(result);
    expect(result.providerType).toBe("anthropic");
    expect(result.tokensUsed).toBe(14);
  });

  it("LocalOpenAICompatibleClient — happy path returns CompletionResult shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"summary":"ok"}' } }],
            usage: { total_tokens: 11 },
          }),
      }),
    );
    const provider: AIProvider = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });
    const result = await provider.generateCompletion({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    assertCompletionResult(result);
    expect(result.providerType).toBe("local");
  });

  it("CodexClient — happy path returns CompletionResult shape", async () => {
    const encoder = new TextEncoder();
    const events = [
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"summary":"ok"}' }],
        },
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp1", usage: { total_tokens: 23 } },
      })}\n\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) controller.enqueue(encoder.encode(ev));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const provider: AIProvider = new CodexClient({
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });
    const result = await provider.generateCompletion({
      systemPrompt: "sys",
      userPrompt: "user",
    });
    assertCompletionResult(result);
    expect(result.providerType).toBe("codex");
    expect(result.tokensUsed).toBe(23);
  });
});
