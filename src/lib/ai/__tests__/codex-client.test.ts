import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexClient } from "../codex-client";
import { singleUserTurn } from "../types";

/** A model list that cannot be read: the client walks its static order. */
const NO_MODEL_LIST = async () =>
  ({ models: null, from: "live", failure: "network" }) as const;

/**
 * Build a `Response` whose `.body` streams a list of SSE event strings.
 * Mirrors the wire format the Codex backend emits (each event terminated
 * with `\n\n`).
 */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const messageDoneEvent = (text: string) =>
  `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  })}\n\n`;

const completedEvent = (totalTokens = 50) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp1", usage: { total_tokens: totalTokens } },
  })}\n\n`;

describe("CodexClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles assistant text from output_item.done events", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([messageDoneEvent('{"summary":"ok"}'), completedEvent(50)]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "You are a doctor.", user: "Analyze this." }),
    );

    expect(result.content).toBe('{"summary":"ok"}');
    expect(result.providerType).toBe("codex");
    expect(result.tokensUsed).toBe(50);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.stream).toBe(true);
    expect(Array.isArray(sentBody.input)).toBe(true);
    expect(sentBody.input[0].content[0]).toEqual({
      type: "input_text",
      text: "Analyze this.",
    });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("falls back to concatenated output_text deltas when no done event arrived", async () => {
    const deltaEvent = (delta: string) =>
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta,
      })}\n\n`;
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          deltaEvent("Hello "),
          deltaEvent("world"),
          completedEvent(),
        ]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test" }),
    );
    expect(result.content).toBe("Hello world");
  });

  it("calls onTokenRefresh on 401 and retries", async () => {
    const newToken = "refreshed-token";
    const onRefresh = vi.fn().mockResolvedValue(newToken);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("unauthorized"),
      })
      .mockResolvedValueOnce(
        sseResponse([messageDoneEvent('{"test":true}'), completedEvent()]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "expired-token",
      accountId: "acct-test",
      onTokenRefresh: async () => {
        const t = await onRefresh();
        return { accessToken: t, accountId: "acct-test" };
      },
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test" }),
    );

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(result.content).toBe('{"test":true}');
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${newToken}`,
    );
  });

  it("throws after retry if still 401", async () => {
    const onRefresh = vi.fn().mockResolvedValue("still-bad");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "bad",
      accountId: "acct-test",
      onTokenRefresh: async () => {
        const t = await onRefresh();
        return { accessToken: t, accountId: "acct-test" };
      },
    });

    await expect(
      client.generateCompletion(
        singleUserTurn({ system: "test", user: "test" }),
      ),
    ).rejects.toThrow("Codex request failed after token refresh (401)");
  });

  it("throws on non-401 errors without retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      }),
    );

    const onRefresh = vi.fn();
    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test",
      accountId: "acct-test",
      onTokenRefresh: async () => {
        const t = await onRefresh();
        return { accessToken: t, accountId: "acct-test" };
      },
    });

    await expect(
      client.generateCompletion(
        singleUserTurn({ system: "test", user: "test" }),
      ),
    ).rejects.toThrow("Codex request failed (500)");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("emits input_image content blocks when images are present", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([messageDoneEvent('{"summary":"ok"}'), completedEvent(50)]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "Transcribe.",
        user: "Read this report.",
        images: [{ mediaType: "image/png", dataBase64: "QUJD" }],
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const content = body.input[0].content;
    expect(content[0]).toEqual({
      type: "input_text",
      text: "Read this report.",
    });
    expect(content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,QUJD",
      detail: "high",
    });
  });

  it("keeps the text-only content shape when no images are present", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([messageDoneEvent('{"summary":"ok"}'), completedEvent(50)]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });

    await client.generateCompletion(
      singleUserTurn({ system: "Answer.", user: "Plain text only." }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "Plain text only." },
    ]);
  });

  it("maps tool defs and parses function_call items + cached tokens", async () => {
    const functionCallEvent = `event: response.output_item.done\ndata: ${JSON.stringify(
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "fc_1",
          name: "fetch_glucose",
          arguments: '{"window":"last30days"}',
        },
      },
    )}\n\n`;
    const completedWithCache = `event: response.completed\ndata: ${JSON.stringify(
      {
        type: "response.completed",
        response: {
          id: "resp1",
          usage: {
            total_tokens: 30,
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      },
    )}\n\n`;
    const mockFetch = vi
      .fn()
      .mockResolvedValue(sseResponse([functionCallEvent, completedWithCache]));
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
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
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // v1.21.3 — the Responses-API function tool carries an explicit `strict`
    // field; omitting it is a documented 400 cause on a client-supplied tools
    // array (the live Coach tool-call regression).
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "fetch_glucose",
        description: "Fetch glucose readings",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(result.toolCalls).toEqual([
      {
        id: "fc_1",
        name: "fetch_glucose",
        arguments: '{"window":"last30days"}',
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.cachedInputTokens).toBe(20);
  });

  it("replays a prior assistant turn as output_text, not input_text (Responses API multi-round contract)", async () => {
    // v1.21.3 — assistant message replays MUST use `output_text`. Sending
    // `input_text` for an assistant turn is a spec violation the Coach tool
    // loop hit on round 2+, surfacing as a 400. User turns keep input_text.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([messageDoneEvent("final"), completedEvent(10)]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });

    await client.generateCompletion({
      system: "s",
      messages: [
        { role: "user", content: "how is my bp?" },
        { role: "assistant", content: "Let me check." },
        { role: "user", content: "thanks" },
      ],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const messageItems = body.input.filter(
      (i: { type: string }) => i.type === "message",
    );
    const userItem = messageItems.find(
      (i: { role: string }) => i.role === "user",
    );
    const assistantItem = messageItems.find(
      (i: { role: string }) => i.role === "assistant",
    );
    expect(userItem.content[0].type).toBe("input_text");
    expect(assistantItem.content[0].type).toBe("output_text");
    expect(assistantItem.content[0].text).toBe("Let me check.");
  });

  it("folds the redacted upstream body into the thrown 400 message for diagnosability", async () => {
    // v1.21.3 — the 400 body names the rejected field/param. It must reach the
    // error message (the chain runner's summariseError reads err.message) so
    // the live failure is diagnosable, with bearer/sk- secrets redacted.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        'Bearer secret-token-here {"error":{"message":"Unknown parameter: tools[0].strict"}}',
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      credentialKey: "user:test",
      readModels: NO_MODEL_LIST,
      accessToken: "test-token",
      accountId: "acct-test",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "x", accountId: "acct-test" }),
    });

    let caught: unknown;
    try {
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
    } catch (e) {
      caught = e;
    }
    const e = caught as Error & { httpStatus?: number; bodyExcerpt?: string };
    expect(e.httpStatus).toBe(400);
    expect(e.message).toContain("Codex request failed (400)");
    expect(e.message).toContain("Unknown parameter");
    // Secret redacted in both the message and the side property.
    expect(e.message).not.toContain("secret-token-here");
    expect(e.bodyExcerpt).toContain("Bearer ***redacted***");
  });
});
