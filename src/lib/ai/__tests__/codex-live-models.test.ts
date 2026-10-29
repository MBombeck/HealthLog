/**
 * The Codex client end to end against a stubbed backend: the account's model
 * list read the way the Codex CLI reads it, the walk built from it, and the
 * working model kept per sign-in (#1287).
 *
 * Every request goes through the real `safeFetch` into a stubbed `fetch`
 * that answers `/codex/models` and `/codex/responses` per account, so the
 * list read, the cache around it and the walk are all the production code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexClient } from "../codex-client";
import { singleUserTurn } from "../types";
import {
  CODEX_SLUG_CACHE_TTL_MS,
  clearCodexSlugCache,
  codexCredentialKey,
  getCachedCodexSlug,
} from "../codex-slug-cache";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures/codex/models-response.json"), "utf8"),
) as { models: Array<{ slug: string }> };

/** The fixture cut to `slugs`, as a plan that offers only those would see it. */
function planList(...slugs: string[]): string {
  return JSON.stringify({
    models: FIXTURE.models.filter((m) => slugs.includes(m.slug)),
  });
}

function sse(text = '{"ok":true}'): Response {
  const body = [
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { total_tokens: 3 } },
    })}\n\n`,
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function retired(slug: string): Response {
  return new Response(
    JSON.stringify({
      detail: `The '${slug}' model is not supported when using Codex with a ChatGPT account.`,
      error: { type: "invalid_request_error", code: "model_not_found" },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

interface Account {
  /** The `/models` answer, or a function standing in for a failure. */
  models: string | (() => Response | Promise<Response>);
  /** The models the responses endpoint accepts for this account. */
  accepts: string[];
}

/**
 * A backend with one entry per ChatGPT account id. Records every request as
 * `<account> models` or `<account> responses:<slug>`.
 */
function stubBackend(accounts: Record<string, Account>) {
  const log: string[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const account = accounts[headers["ChatGPT-Account-ID"]];
    if (!account) return new Response("unknown account", { status: 401 });
    const name = headers["ChatGPT-Account-ID"];
    if (url.includes("/codex/models")) {
      log.push(`${name} models`);
      return typeof account.models === "string"
        ? new Response(account.models, { status: 200 })
        : account.models();
    }
    const slug = JSON.parse(String(init.body)).model as string;
    log.push(`${name} responses:${slug}`);
    return account.accepts.includes(slug) ? sse() : retired(slug);
  });
  vi.stubGlobal("fetch", fetchMock);
  return log;
}

function client(userKey: string, accountId: string) {
  return new CodexClient({
    accessToken: `token-${accountId}`,
    accountId,
    credentialKey: userKey,
    onTokenRefresh: vi.fn(),
  });
}

const ask = (c: CodexClient) =>
  c.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

const ENV_KEYS = ["CODEX_MODEL", "CODEX_MODEL_FALLBACK_CHAIN"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  clearCodexSlugCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Codex reads the account's live model list", () => {
  it("goes straight to an offered model after a retirement the built-in order does not know about", async () => {
    // The 2026-10-14 shape: nothing on the built-in order's head is offered.
    const log = stubBackend({
      plus: {
        models: planList("gpt-6.1-sol", "gpt-6-luna"),
        accepts: ["gpt-6.1-sol", "gpt-6-luna"],
      },
    });
    const c = client(codexCredentialKey.user("u1"), "plus");
    await ask(c);
    expect(log).toEqual(["plus models", "plus responses:gpt-6.1-sol"]);
    expect(c.getLastDiagnostics()?.attempted).toEqual(["gpt-6.1-sol"]);
  });

  it("does not read the list again while the working model holds", async () => {
    const log = stubBackend({
      plus: { models: planList("gpt-6-sol"), accepts: ["gpt-6-sol"] },
    });
    const c = client(codexCredentialKey.user("u1"), "plus");
    await ask(c);
    await ask(c);
    await ask(c);
    expect(log.filter((l) => l.endsWith("models"))).toHaveLength(1);
    expect(c.getLastDiagnostics()?.cacheState).toBe("hit");
  });

  it("a models call that fails still reaches a working model through the static walk", async () => {
    for (const failure of [
      () => new Response("bad gateway", { status: 502 }),
      () => new Response("<html>", { status: 200 }),
      () => new Response('{"models":[]}', { status: 200 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      clearCodexSlugCache();
      const log = stubBackend({
        plus: { models: failure, accepts: ["gpt-6-sol"] },
      });
      const c = client(codexCredentialKey.user("u1"), "plus");
      await ask(c);
      // Today's walk: terra refused, gpt-6-sol answers.
      expect(log).toEqual([
        "plus models",
        "plus responses:gpt-5.6-terra",
        "plus responses:gpt-6-sol",
      ]);
    }
  });

  it("a models call that never answers is cut off and the walk goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const log = stubBackend({
      plus: {
        // Resolves only when the 5 s bound aborts it.
        models: () =>
          new Promise<Response>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new DOMException("The operation timed out.", "TimeoutError"),
                ),
              5_000,
            ),
          ),
        accepts: ["gpt-5.6-terra"],
      },
    });
    const c = client(codexCredentialKey.user("u1"), "plus");
    const answer = ask(c);
    await vi.advanceTimersByTimeAsync(5_000);
    await answer;
    expect(log).toEqual(["plus models", "plus responses:gpt-5.6-terra"]);
  });

  it("an explicit CODEX_MODEL still goes first, ahead of the list", async () => {
    process.env.CODEX_MODEL = "gpt-6-astra";
    const log = stubBackend({
      plus: {
        models: planList("gpt-6-astra", "gpt-6-sol"),
        accepts: ["gpt-6-astra", "gpt-6-sol"],
      },
    });
    await ask(client(codexCredentialKey.user("u1"), "plus"));
    expect(log).toEqual(["plus models", "plus responses:gpt-6-astra"]);
  });

  it("CODEX_MODEL_FALLBACK_CHAIN replaces the order and the list is not read", async () => {
    process.env.CODEX_MODEL_FALLBACK_CHAIN = "gpt-6-luna";
    const log = stubBackend({
      plus: { models: planList("gpt-6-sol"), accepts: ["gpt-6-luna"] },
    });
    await ask(client(codexCredentialKey.user("u1"), "plus"));
    expect(log).toEqual(["plus responses:gpt-6-luna"]);
  });
});

describe("Codex keeps the working model per sign-in", () => {
  it("two sign-ins on different plans do not overwrite each other", async () => {
    const log = stubBackend({
      // One plan still has terra; the other only the gpt-6 line.
      pro: {
        models: planList("gpt-5.6-terra", "gpt-6-sol"),
        accepts: ["gpt-5.6-terra", "gpt-6-sol"],
      },
      edu: {
        models: planList("gpt-6.1-sol", "gpt-6-luna"),
        accepts: ["gpt-6.1-sol", "gpt-6-luna"],
      },
    });
    const a = client(codexCredentialKey.user("a"), "pro");
    const b = client(codexCredentialKey.user("b"), "edu");
    const central = client(codexCredentialKey.central, "edu");

    await ask(a);
    await ask(b);
    await ask(central);
    await ask(a);
    await ask(b);

    expect(getCachedCodexSlug(codexCredentialKey.user("a"))).toBe(
      "gpt-5.6-terra",
    );
    expect(getCachedCodexSlug(codexCredentialKey.user("b"))).toBe(
      "gpt-6.1-sol",
    );
    expect(getCachedCodexSlug(codexCredentialKey.central)).toBe("gpt-6.1-sol");
    // Not one refused request: each sign-in only ever asked what it is offered.
    expect(log.filter((l) => l.includes("responses"))).toEqual([
      "pro responses:gpt-5.6-terra",
      "edu responses:gpt-6.1-sol",
      "edu responses:gpt-6.1-sol",
      "pro responses:gpt-5.6-terra",
      "edu responses:gpt-6.1-sol",
    ]);
  });

  it("a listed model that answers model_not_found is skipped for that sign-in only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const both = planList("gpt-5.6-terra", "gpt-6-sol");
    const log = stubBackend({
      // The list still offers terra, but the backend already retired it.
      stale: { models: both, accepts: ["gpt-6-sol"] },
      fresh: { models: both, accepts: ["gpt-5.6-terra", "gpt-6-sol"] },
    });
    const stale = client(codexCredentialKey.user("s"), "stale");
    const fresh = client(codexCredentialKey.user("f"), "fresh");

    await ask(stale);
    await ask(fresh);
    expect(log).toEqual([
      "stale models",
      "stale responses:gpt-5.6-terra",
      "stale responses:gpt-6-sol",
      "fresh models",
      "fresh responses:gpt-5.6-terra",
    ]);

    // Past the working model's TTL the stale sign-in walks again, and terra
    // is at the back of its line even though the list still offers it.
    log.length = 0;
    vi.setSystemTime(Date.now() + CODEX_SLUG_CACHE_TTL_MS + 1);
    await ask(stale);
    expect(log).toEqual(["stale models", "stale responses:gpt-6-sol"]);
  });

  it("the working model that stops answering is dropped and the walk goes on", async () => {
    const accepts = ["gpt-5.6-terra", "gpt-6-sol"];
    const log = stubBackend({
      plus: { models: planList("gpt-5.6-terra", "gpt-6-sol"), accepts },
    });
    const c = client(codexCredentialKey.user("u1"), "plus");
    await ask(c);
    expect(getCachedCodexSlug(codexCredentialKey.user("u1"))).toBe(
      "gpt-5.6-terra",
    );

    // terra retires between two requests.
    accepts.splice(0, 1);
    log.length = 0;
    await ask(c);
    expect(log).toEqual([
      "plus responses:gpt-5.6-terra",
      "plus responses:gpt-6-sol",
    ]);
    expect(c.getLastDiagnostics()).toMatchObject({
      cacheState: "hit",
      attempted: ["gpt-5.6-terra", "gpt-6-sol"],
      workingSlug: "gpt-6-sol",
    });
  });
});
