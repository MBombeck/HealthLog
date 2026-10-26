import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodexClient, __test } from "../codex-client";
import { singleUserTurn } from "../types";
import {
  openAIModelFamily,
  type OpenAIReasoningFamily,
} from "../openai-model-family";
import { openAIOffEffort } from "../reasoning/support";
import { supportsVisionForConfig } from "../vision-capability";
import {
  clearCodexSlugCache,
  getCachedCodexSlug,
  setCachedCodexSlug,
  CODEX_SLUG_CACHE_TTL_MS,
} from "../codex-slug-cache";

/**
 * Slug-drift defence.
 *
 * The maintainer, verbatim 2026-05-09: "Die Integration des Slug Drift Risiko
 * darf halt immer überhaupt nicht sein."
 * ("Slug-drift risk must never happen.")
 *
 * Pattern from `docs/codex-protocol-spec.md` §7b:
 *   1. Walk the fallback chain on each fresh request series.
 *   2. Cache the working slug for 1 h.
 *   3. On all-failed: throw structured 503 "AI provider unreachable".
 *
 * These tests stub `fetch` deterministically per-slug and assert:
 *   - Walk happens on 400 + "not supported when using Codex with a
 *     ChatGPT account" (the exact body OpenAI returns).
 *   - Walk happens on 400 + model_not_found.
 *   - Walk happens on 404.
 *   - Walk does NOT happen on 5xx, 429, or 401 (auth flow).
 *   - Cache entry is dropped on the first slug-rejection walk.
 *   - Cache hit causes the working slug to come first on the next
 *     call.
 *   - All-rejected case throws 503.
 */

function sseSuccessResponse(text = '{"ok":true}'): Response {
  const encoder = new TextEncoder();
  const events = [
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp1", usage: { total_tokens: 10 } },
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

function rejectionResponse(
  status: number,
  body = '{"detail":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}',
): Response {
  // Use a real Response so .text() works, body returned once.
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const onTokenRefresh = vi
  .fn()
  .mockResolvedValue({ accessToken: "x", accountId: "acct-test" });

describe("Codex slug fallback chain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCodexSlugCache();
  });

  afterEach(() => {
    clearCodexSlugCache();
  });

  it("first slug succeeds — uses head-of-chain and caches it", async () => {
    const mockFetch = vi.fn().mockResolvedValue(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5.3-codex", "gpt-5-codex", "gpt-4o"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.model).toBe("gpt-5.3-codex");

    const diagnostics = client.getLastDiagnostics();
    expect(diagnostics?.attempted).toEqual(["gpt-5.3-codex"]);
    expect(diagnostics?.cacheState).toBe("miss");
    expect(diagnostics?.workingSlug).toBe("gpt-5.3-codex");

    expect(getCachedCodexSlug()).toBe("gpt-5.3-codex");
  });

  it("walks past first slug on 'not supported when using Codex with a ChatGPT account' 400", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rejectionResponse(400))
      .mockResolvedValueOnce(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5", "gpt-5.3-codex", "gpt-4o"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe("gpt-5");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).model).toBe(
      "gpt-5.3-codex",
    );

    const diagnostics = client.getLastDiagnostics();
    expect(diagnostics?.attempted).toEqual(["gpt-5", "gpt-5.3-codex"]);
    expect(diagnostics?.workingSlug).toBe("gpt-5.3-codex");

    // The working slug — not the rejected one — is now cached.
    expect(getCachedCodexSlug()).toBe("gpt-5.3-codex");
  });

  it("walks past first slug on 400 with model_not_found body", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        rejectionResponse(
          400,
          '{"error":{"code":"model_not_found","message":"unknown slug"}}',
        ),
      )
      .mockResolvedValueOnce(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["nonexistent-slug", "gpt-5.3-codex"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(client.getLastDiagnostics()?.workingSlug).toBe("gpt-5.3-codex");
  });

  it("walks past first slug on 404", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rejectionResponse(404, "Not found"))
      .mockResolvedValueOnce(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["dead-slug", "gpt-5.3-codex"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT walk on 500 — propagates immediately", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rejectionResponse(500, "Internal server error"));
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5.3-codex", "gpt-4o"],
    });

    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("Codex request failed (500)");

    expect(mockFetch).toHaveBeenCalledTimes(1); // no walk
  });

  it("does NOT walk on 429 — propagates immediately", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rejectionResponse(429, "Rate limited"));
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5.3-codex", "gpt-4o"],
    });

    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("Codex request failed (429)");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT walk on 401 — refreshes and retries same slug", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "expired",
      accountId: "acct",
      onTokenRefresh: vi
        .fn()
        .mockResolvedValue({ accessToken: "fresh", accountId: "acct" }),
      slugChain: ["gpt-5.3-codex", "gpt-4o"],
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    // Both calls hit the SAME slug — auth retry didn't walk to gpt-4o.
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe(
      "gpt-5.3-codex",
    );
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).model).toBe(
      "gpt-5.3-codex",
    );
    expect(client.getLastDiagnostics()?.attempted).toEqual(["gpt-5.3-codex"]);
  });

  it("all slugs rejected → throws structured 503 with attempted list", async () => {
    // mockImplementation returns a fresh Response each call — Response
    // bodies can only be read once, so a single shared object would
    // throw "body used already" on the second walk-step.
    const mockFetch = vi.fn(() => Promise.resolve(rejectionResponse(400)));
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["a", "b", "c"],
    });

    let caught: unknown;
    try {
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
    } catch (e) {
      caught = e;
    }

    const err = caught as Error & {
      httpStatus?: number;
      attempted?: string[];
    };
    expect(err.message).toMatch(/AI provider unreachable/);
    expect(err.httpStatus).toBe(503);
    expect(err.attempted).toEqual(["a", "b", "c"]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(client.getLastDiagnostics()?.workingSlug).toBeNull();
    expect(client.getLastDiagnostics()?.attempted).toEqual(["a", "b", "c"]);
  });

  it("cache hit — second call goes straight to the cached slug", async () => {
    setCachedCodexSlug("gpt-4o");
    const mockFetch = vi.fn().mockResolvedValue(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5.3-codex", "gpt-5-codex", "gpt-4o"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe("gpt-4o");
    expect(client.getLastDiagnostics()?.cacheState).toBe("hit");
  });

  it("cache invalidated when cached slug starts rejecting", async () => {
    setCachedCodexSlug("gpt-5-codex");
    expect(getCachedCodexSlug()).toBe("gpt-5-codex");

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(rejectionResponse(400))
      .mockResolvedValueOnce(sseSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test",
      accountId: "acct",
      onTokenRefresh,
      slugChain: ["gpt-5.3-codex", "gpt-5-codex"],
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    // After walking to "gpt-5.3-codex" (the next entry after the
    // cached one), the cache is updated to the new working slug.
    expect(getCachedCodexSlug()).toBe("gpt-5.3-codex");
  });

  it("isSlugRejection helper recognises canonical rejection bodies", () => {
    const helper = __test.isSlugRejection;
    expect(
      helper(
        400,
        '{"detail":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}',
      ),
    ).toBe(true);
    expect(helper(400, '{"error":{"code":"model_not_found"}}')).toBe(true);
    expect(helper(400, "model gpt-5 does not exist")).toBe(true);
    expect(helper(404, "anything")).toBe(true);
    expect(helper(500, "internal error")).toBe(false);
    expect(helper(429, "rate limited")).toBe(false);
    expect(helper(400, "unrelated 400")).toBe(false);
  });

  it("DEFAULT_SLUG_FALLBACK_CHAIN tracks the current ChatGPT-auth ladder", () => {
    // The backend rejected every slug from gpt-5.5 down on 2026-10-24 and
    // served the gpt-5.6 and gpt-6 lines. Terra, verified live, leads; its
    // upstream successor and the rest of the gpt-6 line follow before terra's
    // own siblings, which a line rotation would retire together with it.
    expect([...__test.DEFAULT_SLUG_FALLBACK_CHAIN]).toEqual([
      "gpt-5.6-terra",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
  });

  it("DEFAULT_SLUG_FALLBACK_CHAIN holds only slugs every family gate recognises", () => {
    // A slug whose family the gates do not know goes out with the wrong
    // reasoning parameters and is denied image input. Every rung, whatever
    // its generation, must be a recognised reasoning family with a real
    // "off" (the Codex client sends `effort: "none"` for it) that reads
    // images. Nothing is filtered out first: a new line joins the default
    // only together with its family support.
    expect(__test.DEFAULT_SLUG_FALLBACK_CHAIN.length).toBeGreaterThan(0);
    for (const slug of __test.DEFAULT_SLUG_FALLBACK_CHAIN) {
      const family = openAIModelFamily(slug);
      expect(family, slug).not.toBeNull();
      expect(family?.reasoning, slug).not.toBeNull();
      expect(
        openAIOffEffort(
          family!.reasoning as NonNullable<OpenAIReasoningFamily>,
        ),
        slug,
      ).toBe("none");
      expect(supportsVisionForConfig("codex", slug), slug).toBe(true);
    }
  });

  it("loadFallbackChain falls back to the default ladder with no env override", () => {
    const origModel = process.env.CODEX_MODEL;
    const origChain = process.env.CODEX_MODEL_FALLBACK_CHAIN;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_MODEL_FALLBACK_CHAIN;
    try {
      expect(__test.loadFallbackChain()).toEqual([
        "gpt-5.6-terra",
        "gpt-6-sol",
        "gpt-6.1-sol",
        "gpt-6-luna",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.5",
      ]);
    } finally {
      if (origModel === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = origModel;
      if (origChain === undefined)
        delete process.env.CODEX_MODEL_FALLBACK_CHAIN;
      else process.env.CODEX_MODEL_FALLBACK_CHAIN = origChain;
    }
  });

  it("loadFallbackChain folds CODEX_MODEL into position 0", () => {
    const orig = process.env.CODEX_MODEL;
    process.env.CODEX_MODEL = "custom-pinned-slug";
    try {
      const chain = __test.loadFallbackChain();
      expect(chain[0]).toBe("custom-pinned-slug");
      // Defaults still present after position 0.
      expect(chain).toContain("gpt-5.5");
      // No duplicates.
      const seen = new Set(chain);
      expect(seen.size).toBe(chain.length);
    } finally {
      if (orig === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = orig;
    }
  });

  it("CODEX_SLUG_CACHE_TTL_MS is exactly 1 hour per spec §7b", () => {
    expect(CODEX_SLUG_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });
});
