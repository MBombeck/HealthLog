/**
 * v1.21.5 — the Codex client honours the caller's per-request timeout
 * override (`CompletionParams.timeoutMs`), falling back to the shared 60 s
 * default when unset. The comprehensive briefing is the one caller that
 * overrides it; the 60 s default was aborting its reasoning-heavy generation
 * mid-stream on large accounts, leaving the briefing blank.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const safeFetch = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));

import { CodexClient } from "../codex-client";
import { singleUserTurn } from "../types";

function sseResponse(): Response {
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
      response: { id: "r1", usage: { total_tokens: 10 } },
    })}\n\n`,
  ];
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

function makeClient() {
  return new CodexClient({
    credentialKey: "user:test",
    accessToken: "t",
    accountId: "acct",
    onTokenRefresh: vi
      .fn()
      .mockResolvedValue({ accessToken: "t", accountId: "acct" }),
    slugChain: ["gpt-5.5"],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeFetch.mockResolvedValue(sseResponse());
});

describe("CodexClient timeout override", () => {
  it("forwards an explicit timeoutMs to safeFetch", async () => {
    await makeClient().generateCompletion(
      singleUserTurn({ system: "s", user: "u", timeoutMs: 120_000 }),
    );
    expect(safeFetch.mock.calls[0][2].timeoutMs).toBe(120_000);
  });

  it("falls back to the 60 s default when no override is set", async () => {
    await makeClient().generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    expect(safeFetch.mock.calls[0][2].timeoutMs).toBe(60_000);
  });
});
