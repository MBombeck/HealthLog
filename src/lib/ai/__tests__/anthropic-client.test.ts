import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicClient } from "../anthropic-client";

describe("AnthropicClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request shape with required headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: '{"summary":"ok"}' }],
          usage: { input_tokens: 30, output_tokens: 12 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-test-key",
      model: "claude-3-5-sonnet-latest",
    });

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this data.",
      temperature: 0.4,
      maxTokens: 800,
    });

    expect(result.content).toBe('{"summary":"ok"}');
    expect(result.tokensUsed).toBe(42);
    expect(result.model).toBe("claude-3-5-sonnet-latest");
    expect(result.providerType).toBe("anthropic");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    expect(init.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-3-5-sonnet-latest");
    expect(body.max_tokens).toBe(800);
    expect(body.temperature).toBe(0.4);
    // System prompt is a separate top-level field, NOT a message.
    expect(body.system).toBe("You are a doctor.");
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user" }),
    ]);
    // User message should be wrapped to coerce JSON output.
    expect(body.messages[0].content).toContain("Analyze this data.");
    expect(body.messages[0].content.toLowerCase()).toContain("json");
  });

  it("uses custom baseUrl when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-3-haiku-20240307",
      baseUrl: "https://api.anthropic.example/v1/",
    });

    await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.anthropic.example/v1/messages",
    );
  });

  it("captures structured error fields and redacts the API key on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 529,
        text: () =>
          Promise.resolve(
            'overloaded; debug=sk-ant-supersecretkey1234567890 leaked',
          ),
      }),
    );

    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-latest",
    });

    let caught: unknown;
    try {
      await client.generateCompletion({
        systemPrompt: "s",
        userPrompt: "u",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      httpStatus?: number;
      upstream?: string;
      bodyExcerpt?: string;
      model?: string;
    };
    expect(err.message).toBe("Anthropic request failed (529)");
    expect(err.httpStatus).toBe(529);
    expect(err.upstream).toBe("anthropic");
    expect(err.model).toBe("claude-3-5-sonnet-latest");
    expect(err.bodyExcerpt).toContain("sk-ant-***redacted***");
    expect(err.bodyExcerpt).not.toContain("supersecretkey");
  });

  it("throws when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: [], usage: {} }),
      }),
    );

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-3-5-sonnet-latest",
    });

    await expect(
      client.generateCompletion({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("Anthropic returned empty content");
  });
});
