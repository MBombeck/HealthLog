/**
 * v1.42 — a provider that stopped offering the configured model says so.
 *
 * The operator's OAuth proxy reinstalled itself at a newer version, dropped
 * the configured model name, and answered every call with a bare HTTP 500.
 * The chain recorded a generic failure 1 766 times in a row. These cases pin
 * the diagnosis: after a 5xx from a non-canonical endpoint the client asks
 * the endpoint's free `/models` listing, and a listing without the model
 * turns the error into one that names the cause (`modelNotServed`), which
 * the chain's hop line carries as `model_not_served`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIClient } from "../openai-client";
import {
  clearModelListingCache,
  probeModelListing,
} from "../model-availability";
import { singleUserTurn } from "../types";

// safeFetch's requirePublicHost path runs through undici's own `fetch`;
// delegate it to the global stub so the interception still applies.
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
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
const emitSignal = vi.fn();
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));

const PROXY = "https://oauth-proxy.example.com/v1";

function listing(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
  };
}

function serverError() {
  return {
    ok: false,
    status: 500,
    text: () => Promise.resolve("Internal Server Error"),
  };
}

/** Route by method: the completion is a POST, the listing a GET. */
function stubEndpoint(models: string[] | "broken") {
  const fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) =>
    init?.method === "GET"
      ? models === "broken"
        ? { ok: false, status: 404, json: () => Promise.resolve({}) }
        : listing(models)
      : serverError(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const turn = () => singleUserTurn({ system: "s", user: "u" });

beforeEach(() => {
  clearModelListingCache();
  emitSignal.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeModelListing", () => {
  it("answers listed, not_listed, or unknown, and never guesses", async () => {
    stubEndpoint(["gpt-6", "gpt-5.6-mini"]);
    await expect(
      probeModelListing({ baseUrl: PROXY, apiKey: "k", model: "gpt-6" }),
    ).resolves.toBe("listed");
    await expect(
      probeModelListing({ baseUrl: PROXY, apiKey: "k", model: "gpt-5.4-mini" }),
    ).resolves.toBe("not_listed");

    clearModelListingCache();
    stubEndpoint("broken");
    await expect(
      probeModelListing({ baseUrl: PROXY, apiKey: "k", model: "gpt-5.4-mini" }),
    ).resolves.toBe("unknown");
  });

  it("asks the endpoint once per model for a burst of failures", async () => {
    const fetchMock = stubEndpoint(["gpt-6"]);
    for (let i = 0; i < 3; i += 1) {
      await probeModelListing({ baseUrl: PROXY, apiKey: "k", model: "x" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIClient — a 500 from an endpoint that dropped the model", () => {
  it("names the missing model and marks the error modelNotServed", async () => {
    stubEndpoint(["gpt-6", "gpt-5.6-mini"]);
    const client = new OpenAIClient({
      apiKey: "k",
      model: "gpt-5.4-mini",
      baseUrl: PROXY,
      providerType: "admin-key",
      operatorTrusted: true,
    });
    await expect(client.generateCompletion(turn())).rejects.toMatchObject({
      httpStatus: 500,
      modelNotServed: true,
      message: expect.stringContaining('model "gpt-5.4-mini" is not offered'),
    });
    expect(emitSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.provider.model_not_served",
        level: "error",
      }),
    );
  });

  it("leaves an ordinary 500 alone when the model is still listed", async () => {
    stubEndpoint(["gpt-5.4-mini"]);
    const client = new OpenAIClient({
      apiKey: "k",
      model: "gpt-5.4-mini",
      baseUrl: PROXY,
      providerType: "admin-key",
      operatorTrusted: true,
    });
    const error = await client.generateCompletion(turn()).catch((e) => e);
    expect(error.httpStatus).toBe(500);
    expect(error.modelNotServed).toBeUndefined();
  });

  it("never probes the canonical OpenAI endpoint", async () => {
    const fetchMock = stubEndpoint(["gpt-6"]);
    const client = new OpenAIClient({
      apiKey: "k",
      model: "gpt-5.4-mini",
      baseUrl: "https://api.openai.com/v1",
      providerType: "admin-key",
    });
    await client.generateCompletion(turn()).catch(() => undefined);
    expect(
      fetchMock.mock.calls.filter(
        (c) => (c[1] as { method?: string })?.method === "GET",
      ),
    ).toHaveLength(0);
  });
});
