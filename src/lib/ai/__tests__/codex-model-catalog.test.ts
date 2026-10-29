/**
 * The account's Codex model list: parsing the `/models` body, the bounded
 * read, and the per-sign-in cache around it.
 *
 * The fixture is the upstream catalog bundle (openai/codex
 * `codex-rs/models-manager/models.json`) cut to the models a ChatGPT
 * sign-in was offered on 2026-10-24, plus one hidden review model and one
 * hidden specialist model, every field as upstream ships it except the
 * instruction templates, which are trimmed. The live endpoint answers in the
 * same `ModelsResponse` shape (`codex-rs/protocol/src/openai_models.rs`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));
const emitSignal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));

import { SafeFetchError } from "@/lib/safe-fetch";
import {
  CODEX_MODELS_CLIENT_VERSION,
  cachedCodexModels,
  fetchCodexModelList,
  parseCodexModelList,
  readCodexModelCatalog,
} from "../codex-model-catalog";
import {
  CODEX_CATALOG_RETRY_MS,
  CODEX_CATALOG_TTL_MS,
  clearCodexSlugCache,
  codexCredentialKey,
} from "../codex-slug-cache";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures/codex/models-response.json"),
  "utf8",
);

const AUTH = { accessToken: "access-token", accountId: "acct-plus" };
const PERSONAL = { key: codexCredentialKey.user("u1"), accountId: "acct-plus" };

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  safeFetch.mockReset();
  emitSignal.mockReset();
  clearCodexSlugCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseCodexModelList", () => {
  it("reads the upstream shape: slug, visibility, priority, modalities, specialty", () => {
    const models = parseCodexModelList(JSON.parse(FIXTURE));
    expect(models?.map((m) => m.slug)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "codex-auto-review",
    ]);
    const luna = models?.find((m) => m.slug === "gpt-6-luna");
    expect(luna).toEqual({
      slug: "gpt-6-luna",
      listed: true,
      priority: 4,
      inputModalities: ["text", "image"],
      specialty: null,
    });
    expect(models?.find((m) => m.slug === "codex-auto-review")?.listed).toBe(
      false,
    );
    expect(
      models?.find((m) => m.slug === "gpt-daybreak-blue-latest")?.specialty,
    ).toBe("cyber");
  });

  it("refuses a body that is not the documented envelope", () => {
    for (const body of [
      null,
      "models",
      42,
      [],
      {},
      { models: "gpt-6-sol" },
      { data: [{ id: "gpt-6-sol" }] },
    ]) {
      expect(parseCodexModelList(body), JSON.stringify(body)).toBeNull();
    }
  });

  it("skips entries without a usable slug and keeps the rest", () => {
    const models = parseCodexModelList({
      models: [
        null,
        "gpt-6-sol",
        { slug: 7 },
        { slug: "" },
        { slug: "has spaces" },
        { slug: "gpt-6-sol\nInjected: header" },
        { slug: "x".repeat(200) },
        { slug: "gpt-6-luna", visibility: "list" },
        { slug: "gpt-6-luna", visibility: "list" },
      ],
    });
    expect(models).toEqual([
      {
        slug: "gpt-6-luna",
        listed: true,
        priority: null,
        inputModalities: null,
        specialty: null,
      },
    ]);
  });

  it("reads missing or odd fields conservatively", () => {
    const [model] = parseCodexModelList({
      models: [
        {
          slug: "gpt-7-sol",
          visibility: "LIST",
          priority: "1",
          input_modalities: "text",
        },
      ],
    })!;
    // Not "list" exactly → not listed; a non-array modality field says nothing.
    expect(model).toEqual({
      slug: "gpt-7-sol",
      listed: false,
      priority: null,
      inputModalities: null,
      specialty: null,
    });
  });

  it("returns an empty array for an empty list", () => {
    expect(parseCodexModelList({ models: [] })).toEqual([]);
  });
});

describe("fetchCodexModelList", () => {
  it("asks the endpoint the Codex CLI asks, with the responses call's sign-in", async () => {
    safeFetch.mockResolvedValue(jsonResponse(FIXTURE));
    const result = await fetchCodexModelList(AUTH);
    expect(result.ok).toBe(true);
    const [url, init, options] = safeFetch.mock.calls[0];
    expect(url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(init.headers["ChatGPT-Account-ID"]).toBe("acct-plus");
    expect(init.headers.originator).toBe("healthlog");
    // Bounded: the Codex CLI's own 5 s, and no redirect following.
    expect(options).toEqual({ timeoutMs: 5_000 });
  });

  it.each([
    ["a timeout", new SafeFetchError("timed out", "timeout"), "timeout"],
    ["a network error", new SafeFetchError("reset", "network"), "network"],
  ])("maps %s to its reason", async (_label, error, reason) => {
    safeFetch.mockRejectedValue(error);
    expect(await fetchCodexModelList(AUTH)).toEqual({
      ok: false,
      reason,
      status: null,
    });
  });

  it("maps refusals, bad bodies and empty lists to closed reasons", async () => {
    const cases: Array<[Response, string]> = [
      [jsonResponse("unauthorized", 401), "auth"],
      [jsonResponse("forbidden", 403), "auth"],
      [jsonResponse("bad gateway", 502), "http_error"],
      [new Response(null, { status: 302 }), "http_error"],
      [jsonResponse("<html>not json</html>"), "unparsable"],
      [jsonResponse('{"data":[]}'), "unparsable"],
      [jsonResponse('{"models":[]}'), "empty"],
      [jsonResponse('{"models":[{"slug":""}]}'), "empty"],
    ];
    for (const [response, reason] of cases) {
      safeFetch.mockResolvedValueOnce(response);
      const result = await fetchCodexModelList(AUTH);
      expect(result.ok, reason).toBe(false);
      expect(!result.ok && result.reason, reason).toBe(reason);
    }
  });

  it("stops reading a body past the size bound", async () => {
    const huge = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(1024 * 1024).fill(32);
          for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200 },
    );
    safeFetch.mockResolvedValue(huge);
    expect(await fetchCodexModelList(AUTH)).toEqual({
      ok: false,
      reason: "too_large",
      status: 200,
    });
  });

  it("reports a body that stalls past the timeout as a timeout", async () => {
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
      }),
      { status: 200 },
    );
    safeFetch.mockResolvedValue(stalled);
    const result = await fetchCodexModelList(AUTH);
    expect(!result.ok && result.reason).toBe("timeout");
  });
});

describe("readCodexModelCatalog", () => {
  it("reads once, then answers from the cache until the TTL passes", async () => {
    vi.useFakeTimers();
    safeFetch.mockImplementation(async () => jsonResponse(FIXTURE));

    const first = await readCodexModelCatalog(PERSONAL, AUTH);
    expect(first.from).toBe("live");
    expect(first.models).toHaveLength(9);
    const second = await readCodexModelCatalog(PERSONAL, AUTH);
    expect(second.from).toBe("cache");
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(cachedCodexModels(PERSONAL.key)).toHaveLength(9);

    vi.advanceTimersByTime(CODEX_CATALOG_TTL_MS + 1);
    expect((await readCodexModelCatalog(PERSONAL, AUTH)).from).toBe("live");
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent requests on a sign-in", async () => {
    let release: (r: Response) => void = () => {};
    safeFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const reads = [
      readCodexModelCatalog(PERSONAL, AUTH),
      readCodexModelCatalog(PERSONAL, AUTH),
      readCodexModelCatalog(PERSONAL, AUTH),
    ];
    release(jsonResponse(FIXTURE));
    const results = await Promise.all(reads);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.models?.length === 9)).toBe(true);
  });

  it("remembers a failed read for the retry window and signals it once", async () => {
    vi.useFakeTimers();
    safeFetch.mockImplementation(async () => jsonResponse("down", 503));

    const first = await readCodexModelCatalog(PERSONAL, AUTH);
    expect(first).toEqual({
      models: null,
      from: "live",
      failure: "http_error",
    });
    const again = await readCodexModelCatalog(PERSONAL, AUTH);
    expect(again).toEqual({
      models: null,
      from: "cache",
      failure: "http_error",
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);

    // Past the retry window the list is asked again; still failing, the
    // stretch has already been reported.
    vi.advanceTimersByTime(CODEX_CATALOG_RETRY_MS + 1);
    await readCodexModelCatalog(PERSONAL, AUTH);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(emitSignal).toHaveBeenCalledTimes(1);
    expect(emitSignal).toHaveBeenCalledWith({
      action: "ai.codex.models_unreadable",
      level: "warn",
      meta: { connection: "personal", reason: "http_error", status: 503 },
    });
  });

  it("signals again after the list answered in between", async () => {
    vi.useFakeTimers();
    safeFetch
      .mockResolvedValueOnce(jsonResponse("down", 503))
      .mockResolvedValueOnce(jsonResponse(FIXTURE))
      .mockResolvedValueOnce(new Response("{", { status: 200 }));
    await readCodexModelCatalog(PERSONAL, AUTH);
    vi.advanceTimersByTime(CODEX_CATALOG_RETRY_MS + 1);
    await readCodexModelCatalog(PERSONAL, AUTH);
    vi.advanceTimersByTime(CODEX_CATALOG_TTL_MS + 1);
    await readCodexModelCatalog(PERSONAL, AUTH);
    expect(emitSignal).toHaveBeenCalledTimes(2);
    expect(emitSignal.mock.calls[1][0].meta.reason).toBe("unparsable");
  });

  it("signals once per sign-in, naming which connection without naming whose", async () => {
    safeFetch.mockImplementation(async () => {
      throw new SafeFetchError("timed out", "timeout");
    });
    const central = { key: codexCredentialKey.central, accountId: "acct-op" };
    await readCodexModelCatalog(PERSONAL, AUTH);
    await readCodexModelCatalog(central, { ...AUTH, accountId: "acct-op" });
    await readCodexModelCatalog(PERSONAL, AUTH);
    await readCodexModelCatalog(central, { ...AUTH, accountId: "acct-op" });
    expect(emitSignal.mock.calls.map((c) => c[0].meta)).toEqual([
      { connection: "personal", reason: "timeout", status: null },
      { connection: "central", reason: "timeout", status: null },
    ]);
    expect(JSON.stringify(emitSignal.mock.calls)).not.toContain("u1");
  });

  it("does not remember an expired token, so the next request reads again", async () => {
    safeFetch
      .mockResolvedValueOnce(jsonResponse("unauthorized", 401))
      .mockResolvedValueOnce(jsonResponse(FIXTURE));
    const refused = await readCodexModelCatalog(PERSONAL, AUTH);
    expect(refused.failure).toBe("auth");
    const next = await readCodexModelCatalog(PERSONAL, {
      ...AUTH,
      accessToken: "refreshed",
    });
    expect(next.models).toHaveLength(9);
    expect(emitSignal).not.toHaveBeenCalled();
  });

  it("keeps each sign-in's list to itself", async () => {
    const plus = JSON.parse(FIXTURE) as { models: { slug: string }[] };
    const other = {
      models: plus.models.filter((m) => m.slug.startsWith("gpt-6")),
    };
    safeFetch
      .mockResolvedValueOnce(jsonResponse(FIXTURE))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(other)));
    const second = { key: codexCredentialKey.user("u2"), accountId: "acct-b" };
    await readCodexModelCatalog(PERSONAL, AUTH);
    await readCodexModelCatalog(second, { ...AUTH, accountId: "acct-b" });
    expect(cachedCodexModels(PERSONAL.key)).toHaveLength(9);
    expect(cachedCodexModels(second.key)?.map((m) => m.slug)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
  });
});
