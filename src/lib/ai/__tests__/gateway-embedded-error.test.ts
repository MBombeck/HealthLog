import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A gateway that refuses inside a 200.
 *
 * OpenRouter — and every gateway that copies its wire — answers a
 * provider-side refusal with HTTP 200 and the failure in the body: a
 * top-level `error` object and no `choices`, or `choices[0].error` beside
 * `finish_reason: "error"` when a generation dies mid-flight. Both used to
 * reach the empty-content throw, so "no credits", "blocked by the account's
 * data policy" and "the model is down" all surfaced identically: status 0,
 * reason "returned empty content", no excerpt. Nobody reading the provider
 * card could act on that.
 *
 * These cases pin the whole path: the client raises the shape a non-2xx reply
 * raises, the chain runner carries the real status into the hop, the health
 * ledger records it, and the pinned `api.openai.com` tags parse exactly as
 * they did.
 */

// safeFetch's requirePublicHost path runs through undici's own `fetch`.
// Delegate it to the global stub so the interception still applies.
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

// The chain runner reaches for Postgres on both of these at import time; the
// chain semantics under test need neither.
vi.mock("../coach/budget", async () => {
  const actual =
    await vi.importActual<typeof import("../coach/budget")>("../coach/budget");
  return { ...actual, readDailySpend: vi.fn(async () => 0) };
});
vi.mock("../provider-health-ledger", async () => {
  const actual = await vi.importActual<
    typeof import("../provider-health-ledger")
  >("../provider-health-ledger");
  return {
    ...actual,
    postgresProviderHealthLedger: {
      async getSkipHints() {
        return new Map();
      },
      async recordSuccess() {},
      async recordFailure() {},
    },
  };
});

import { OpenAIClient } from "../openai-client";
import { LocalOpenAICompatibleClient } from "../local-client";
import { resetJsonModeDialectCache } from "../json-dialect";
import {
  singleUserTurn,
  type AIProvider,
  type CompletionResult,
} from "../types";
import {
  AllProvidersFailedError,
  clearLastWorkingProviderCache,
  runRawCompletionWithFallback,
} from "../provider-runner";
import { createInMemoryProviderHealthLedger } from "../provider-health-ledger";
import { annotate } from "@/lib/logging/context";

function reply200(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
  });
}

const turn = () => singleUserTurn({ system: "s", user: "u" });
const jsonTurn = () =>
  singleUserTurn({ system: "s", user: "u", responseFormat: "json" });

function gateway(baseUrl = "https://gateway.example.com/api/v1") {
  return new OpenAIClient({
    apiKey: "gateway-secret",
    model: "vendor/model-5",
    baseUrl,
    providerType: "openai-compatible",
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetJsonModeDialectCache();
  clearLastWorkingProviderCache();
  vi.mocked(annotate).mockClear();
});

describe("gateway 200 with a top-level error", () => {
  it("surfaces the embedded code as the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({ error: { code: 402, message: "Insufficient credits" } }),
    );

    await expect(gateway().generateCompletion(turn())).rejects.toMatchObject({
      httpStatus: 402,
      kind: "embedded_error",
      upstream: "openai-compatible",
      model: "vendor/model-5",
    });
  });

  it("leads the message with the gateway's own words", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({ error: { code: 402, message: "Insufficient credits" } }),
    );

    await expect(gateway().generateCompletion(turn())).rejects.toThrow(
      /^Insufficient credits \(OpenAI-compatible gateway\)$/,
    );
  });

  it("carries a bounded, key-redacted excerpt of the body", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({
        error: {
          code: 403,
          message: `blocked ${"x".repeat(400)}`,
          metadata: { key: "sk-abcdefghijklmnop", reasons: ["data policy"] },
        },
      }),
    );

    const err = (await gateway()
      .generateCompletion(turn())
      .catch((e) => e)) as Error & { bodyExcerpt?: string };

    expect(err.bodyExcerpt).toBeTypeOf("string");
    expect(err.bodyExcerpt!.length).toBeLessThanOrEqual(500);
    expect(err.bodyExcerpt).not.toContain("sk-abcdefghijklmnop");
    // The thrown message is bounded independently of the excerpt.
    expect(err.message.length).toBeLessThanOrEqual(240);
  });

  it("keeps the 0 sentinel when the embedded code is not an HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({
        error: { code: "insufficient_quota", message: "Out of quota" },
      }),
    );

    await expect(gateway().generateCompletion(turn())).rejects.toMatchObject({
      httpStatus: 0,
      message: "Out of quota (OpenAI-compatible gateway)",
    });
  });
});

describe("gateway 200 with choices[0].error", () => {
  it("surfaces the partial-generation failure with its status", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({
        choices: [
          {
            error: {
              code: 403,
              message:
                "No endpoints found matching your data policy (Free model publication)",
            },
            finish_reason: "error",
          },
        ],
      }),
    );

    await expect(gateway().generateCompletion(turn())).rejects.toMatchObject({
      httpStatus: 403,
      kind: "embedded_error",
    });
    await expect(gateway().generateCompletion(turn())).rejects.toThrow(
      /^No endpoints found matching your data policy/,
    );
  });
});

describe("what the fix must not touch", () => {
  it("leaves a genuine empty reply as empty_response with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({ choices: [{ message: { content: "" } }] }),
    );

    await expect(gateway().generateCompletion(turn())).rejects.toMatchObject({
      message: "OpenAI-compatible gateway returned empty content",
      httpStatus: 0,
      kind: "empty_response",
    });
  });

  it("leaves a normal reply alone", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      }),
    );

    const result = await gateway().generateCompletion(turn());
    expect(result.content).toBe("hello");
    expect(result.tokensUsed).toBe(5);
  });

  it("does not read an embedded error on api.openai.com", async () => {
    // The shape is gateway-only: the pinned vendor endpoint signals every
    // failure with a non-2xx status, so its parsing must be unchanged.
    vi.stubGlobal(
      "fetch",
      reply200({ error: { code: 402, message: "Insufficient credits" } }),
    );

    await expect(
      new OpenAIClient({
        apiKey: "sk-user-openai-key",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({
      message: "OpenAI returned empty content",
      httpStatus: 0,
      kind: "empty_response",
    });
  });
});

describe("the chain runner and the health ledger", () => {
  class ThrowingProvider implements AIProvider {
    readonly type = "openai-compatible" as const;
    constructor(private readonly error: Error) {}
    async generateCompletion(): Promise<CompletionResult> {
      throw this.error;
    }
  }
  class OkProvider implements AIProvider {
    readonly type = "local" as const;
    async generateCompletion(): Promise<CompletionResult> {
      return {
        content: "second provider answered",
        tokensUsed: 1,
        model: "m",
        providerType: "local",
      };
    }
  }

  async function embeddedErrorFrom(body: unknown): Promise<Error> {
    vi.stubGlobal("fetch", reply200(body));
    return (await gateway()
      .generateCompletion(turn())
      .catch((e) => e)) as Error;
  }

  it("records a 402 hop as HTTP 402 with the gateway's reason", async () => {
    const error = await embeddedErrorFrom({
      error: { code: 402, message: "Insufficient credits" },
    });
    const ledger = createInMemoryProviderHealthLedger();
    const recordFailure = vi.spyOn(ledger, "recordFailure");

    const failure = (await runRawCompletionWithFallback({
      userId: "u1",
      providers: [
        {
          providerType: "openai-compatible",
          instance: new ThrowingProvider(error),
        },
      ],
      params: turn(),
      ledger,
    }).catch((e) => e)) as AllProvidersFailedError;

    expect(failure).toBeInstanceOf(AllProvidersFailedError);
    expect(failure.attempts[0].httpStatus).toBe(402);
    expect(failure.attempts[0].failureReason).toBe(
      "HTTP 402: Insufficient credits (OpenAI-compatible gateway)",
    );
    expect(recordFailure).toHaveBeenCalledWith("u1", "openai-compatible", 402);

    const hopMeta = vi
      .mocked(annotate)
      .mock.calls.map(([arg]) => arg?.meta)
      .find((m) => m && "ai_chain_hop_1_status" in m);
    expect(hopMeta?.ai_chain_hop_1_status).toBe(402);
    expect(hopMeta?.ai_chain_hop_1_body).toBe("classified:quota_or_billing");
  });

  it("benches the provider as a dead credential on an embedded 403", async () => {
    const error = await embeddedErrorFrom({
      choices: [
        {
          error: { code: 403, message: "Blocked by your data policy" },
          finish_reason: "error",
        },
      ],
    });
    const ledger = createInMemoryProviderHealthLedger();

    const failure = (await runRawCompletionWithFallback({
      userId: "u2",
      providers: [
        {
          providerType: "openai-compatible",
          instance: new ThrowingProvider(error),
        },
      ],
      params: turn(),
      ledger,
    }).catch((e) => e)) as AllProvidersFailedError;

    expect(failure.attempts[0].httpStatus).toBe(403);
    expect(failure.primaryCredentialExpired).toBe(true);
    expect(ledger.inspect("u2").get("openai-compatible")?.reason).toBe(
      "credential_expired",
    );

    const hopMeta = vi
      .mocked(annotate)
      .mock.calls.map(([arg]) => arg?.meta)
      .find((m) => m && "ai_chain_hop_1_body" in m);
    expect(hopMeta?.ai_chain_hop_1_body).toBe(
      "classified:no_eligible_provider",
    );
  });

  it("still advances to the next provider", async () => {
    const error = await embeddedErrorFrom({
      error: { code: 503, message: "No provider is available for this model" },
    });

    const outcome = await runRawCompletionWithFallback({
      userId: "u3",
      providers: [
        {
          providerType: "openai-compatible",
          instance: new ThrowingProvider(error),
        },
        { providerType: "local", instance: new OkProvider() },
      ],
      params: turn(),
      ledger: createInMemoryProviderHealthLedger(),
    });

    expect(outcome.result.content).toBe("second provider answered");
    expect(outcome.fallbackHops[0].httpStatus).toBe(503);
  });
});

describe("the local provider has the same hole", () => {
  function local() {
    return new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "https://gateway.example.com/api/v1",
    });
  }

  it("surfaces an embedded error on the buffered path", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({ error: { code: 402, message: "Insufficient credits" } }),
    );

    await expect(local().generateCompletion(turn())).rejects.toMatchObject({
      httpStatus: 402,
      kind: "embedded_error",
      upstream: "local",
      message: "Insufficient credits (local AI endpoint)",
    });
  });

  it("surfaces an embedded error the server sent instead of a stream", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({
        choices: [
          {
            error: { code: 429, message: "Rate limited" },
            finish_reason: "error",
          },
        ],
      }),
    );

    await expect(
      local().generateCompletionStream(turn(), () => {}),
    ).rejects.toMatchObject({ httpStatus: 429, kind: "embedded_error" });
  });

  it("surfaces an error frame that arrived before any token", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k === "content-type" ? "text/event-stream" : null,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"code":502,"message":"Model is down"}}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
      }),
    );

    await expect(
      local().generateCompletionStream(turn(), () => {}),
    ).rejects.toMatchObject({
      httpStatus: 502,
      kind: "embedded_error",
      message: "Model is down (local AI endpoint)",
    });
  });

  it("leaves a genuine empty local reply as empty_response", async () => {
    vi.stubGlobal(
      "fetch",
      reply200({ choices: [{ message: { content: "" } }] }),
    );

    await expect(local().generateCompletion(turn())).rejects.toMatchObject({
      message: "Local AI returned empty content",
      httpStatus: 0,
      kind: "empty_response",
    });
  });
});
