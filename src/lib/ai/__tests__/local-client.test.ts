import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalOpenAICompatibleClient } from "../local-client";

describe("LocalOpenAICompatibleClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // These tests cover the operator-opt-in path (LM Studio / Ollama on
    // an RFC1918 host). The safeFetch wrapper enforces the SSRF guard
    // unless the operator explicitly accepts a private host.
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets the configured baseUrl + /chat/completions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"local"}' } }],
          usage: { total_tokens: 17 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletion({
      systemPrompt: "system",
      userPrompt: "user-input",
    });

    expect(result.content).toBe('{"summary":"local"}');
    expect(result.tokensUsed).toBe(17);
    expect(result.model).toBe("llama3:8b");
    expect(result.providerType).toBe("local");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("llama3:8b");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    // User message should be prefixed with the strict-JSON instruction.
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("user-input");
    expect(body.messages[1].content.toLowerCase()).toContain("json");

    // CRUCIAL: do not send response_format because many local servers reject it.
    expect(body).not.toHaveProperty("response_format");
  });

  it("omits Authorization header when no API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "",
      model: "phi3",
      baseUrl: "http://localhost:11434/v1",
    });

    await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends Bearer Authorization when an API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "lm-studio-secret",
      model: "phi3",
      baseUrl: "http://192.168.1.20:1234/v1",
    });

    await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer lm-studio-secret");
  });

  it("captures structured error fields and redacts bearer tokens on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () =>
          Promise.resolve(
            "upstream rejected: Bearer sk-localabcdef12345 hit /v1",
          ),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: "sk-local-test",
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    let caught: unknown;
    try {
      await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      httpStatus?: number;
      upstream?: string;
      bodyExcerpt?: string;
      baseUrl?: string;
    };
    expect(err.message).toBe("Local AI request failed (500)");
    expect(err.httpStatus).toBe(500);
    expect(err.upstream).toBe("local");
    expect(err.baseUrl).toBe("http://localhost:11434/v1");
    expect(err.bodyExcerpt).toContain("Bearer ***redacted***");
    expect(err.bodyExcerpt).not.toContain("sk-localabcdef12345");
  });

  it("throws when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "" } }] }),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    await expect(
      client.generateCompletion({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("Local AI returned empty content");
  });
});
