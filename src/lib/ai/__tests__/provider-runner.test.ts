import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  singleUserTurn,
  type AIProvider,
  type CompletionParams,
  type CompletionResult,
} from "../types";

// v1.11.0 W1 — the runner now defaults to the Postgres-backed
// provider-health ledger. These pure chain tests do not stand up a DB,
// so swap the default for a no-op; the dedicated ledger-aware cases
// below inject an in-memory ledger explicitly.
// v1.37.19 (A7-2) — the runner consults the day's recorded spend before an
// operator-funded hop. These pure chain tests do not stand up a DB, so the
// ledger read is swapped for a controllable in-memory figure.
const budgetState = vi.hoisted(() => ({ spent: 0, operatorSpent: 0 }));
vi.mock("../coach/budget", async () => {
  const actual =
    await vi.importActual<typeof import("../coach/budget")>("../coach/budget");
  return {
    ...actual,
    readDailySpend: vi.fn(async () => ({
      total: budgetState.spent,
      operator: budgetState.operatorSpent,
    })),
  };
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

import {
  AllProvidersFailedError,
  clearLastWorkingProviderCache,
  getLastWorkingProvider,
  isHardProviderFailure,
  runRawCompletionWithFallback,
  runStreamingRawCompletionWithFallback,
} from "../provider-runner";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  createInMemoryProviderHealthLedger,
} from "../provider-health-ledger";

const VALID_RESPONSE = JSON.stringify({
  summary: "ok",
  recommendations: [],
  citations: [],
  warnings: [],
});

interface ScriptedCall {
  ok: boolean;
  content?: string;
  error?: Error & { httpStatus?: number };
}

class ScriptedProvider implements AIProvider {
  readonly type: AIProvider["type"];
  readonly model: string;
  readonly calls: CompletionParams[] = [];
  private readonly script: ScriptedCall[];
  private cursor = 0;

  constructor(opts: {
    type?: AIProvider["type"];
    model?: string;
    script: ScriptedCall[];
  }) {
    this.type = opts.type ?? "local";
    this.model = opts.model ?? "scripted-model";
    this.script = opts.script;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    this.calls.push(params);
    const step = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    if (!step.ok) {
      throw step.error ?? new Error("scripted-fail");
    }
    return {
      content: step.content ?? VALID_RESPONSE,
      tokensUsed: 1,
      model: this.model,
      providerType: this.type,
    };
  }

  get callCount(): number {
    return this.calls.length;
  }
}

function err(status: number, msg = "boom"): Error & { httpStatus: number } {
  return Object.assign(new Error(msg), { httpStatus: status });
}

beforeEach(() => {
  clearLastWorkingProviderCache();
  budgetState.spent = 0;
  budgetState.operatorSpent = 0;
});

afterEach(() => {
  clearLastWorkingProviderCache();
  vi.useRealTimers();
});

describe("isHardProviderFailure", () => {
  it("flags 401 (auth-class) as hard", () => {
    expect(isHardProviderFailure(err(401))).toBe(true);
  });

  it("flags 403 (auth-class) as hard", () => {
    expect(isHardProviderFailure(err(403))).toBe(true);
  });

  it("flags 5xx (server-class) as hard after retry exhaustion", () => {
    expect(isHardProviderFailure(err(500))).toBe(true);
    expect(isHardProviderFailure(err(503))).toBe(true);
  });

  it("flags a raw provider-wire 4xx (e.g. a Codex 400 rejecting the tool-call request) as hard so it cascades and is wrapped rather than bubbling into a 500", () => {
    // v1.21.3 — a 4xx surfaced by a provider wire is a provider failure, not a
    // caller bug. It must cascade so the chain runner wraps it in
    // AllProvidersFailedError; the route then surfaces a graceful provider
    // frame instead of rethrowing into an HTTP 500.
    expect(isHardProviderFailure(err(400))).toBe(true);
    expect(isHardProviderFailure(err(422))).toBe(true);
    expect(isHardProviderFailure(err(404))).toBe(true);
  });

  it("flags network errors (no httpStatus) as hard", () => {
    expect(isHardProviderFailure(new Error("ECONNRESET"))).toBe(true);
  });

  it("flags zero / sentinel httpStatus as hard (transport-level)", () => {
    expect(isHardProviderFailure(err(0, "ECONNRESET"))).toBe(true);
  });

  it("flags 429 rate-limit as hard so we walk to the next provider rather than starve out", () => {
    expect(isHardProviderFailure(err(429))).toBe(true);
  });
});

describe("runRawCompletionWithFallback — last-working cache", () => {
  it("caches the working provider so the next call starts there", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }, { ok: true }],
    });

    // First call: codex fails, openai succeeds.
    await runRawCompletionWithFallback({
      userId: "u-cache",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });

    expect(getLastWorkingProvider("u-cache")).toBe("openai");

    // Second call: cache reorders so openai is tried first; codex is
    // never re-invoked even though it appears first in the input chain.
    await runRawCompletionWithFallback({
      userId: "u-cache",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });

    // codex was called exactly once (first call's failure); the cache
    // skipped it on the second call.
    expect(codex.callCount).toBe(1);
    expect(openai.callCount).toBe(2);
  });

  it("expires the cache after 1 hour", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-05-09T12:00:00Z");
    vi.setSystemTime(t0);

    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }, { ok: true }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });

    // First call: codex fails, openai succeeds, cache = openai.
    await runRawCompletionWithFallback({
      userId: "u-ttl",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(getLastWorkingProvider("u-ttl")).toBe("openai");

    // 61 minutes later — cache should have expired.
    vi.setSystemTime(new Date(t0.getTime() + 61 * 60_000));
    expect(getLastWorkingProvider("u-ttl")).toBeNull();

    // Next call walks the original priority order again (codex first,
    // and this time codex's second scripted entry succeeds).
    await runRawCompletionWithFallback({
      userId: "u-ttl",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(getLastWorkingProvider("u-ttl")).toBe("codex");
  });

  it("clearLastWorkingProviderCache wipes the cache", async () => {
    const ok = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });
    await runRawCompletionWithFallback({
      userId: "u-clear",
      surface: "coach",
      providers: [{ providerType: "openai", instance: ok }],
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(getLastWorkingProvider("u-clear")).toBe("openai");
    clearLastWorkingProviderCache();
    expect(getLastWorkingProvider("u-clear")).toBeNull();
  });
});

describe("runRawCompletionWithFallback — legacy route shim", () => {
  it("returns the first non-hard-failure response", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(503) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true, content: '{ "legacy": true }' }],
    });
    const result = await runRawCompletionWithFallback({
      userId: "u-raw",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "admin-openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(result.result.content).toBe('{ "legacy": true }');
    expect(result.workingProvider.providerType).toBe("admin-openai");
    expect(result.fallbackHops).toHaveLength(1);
    expect(result.fallbackHops[0].providerType).toBe("codex");
  });

  it("advances past an auth-class (401) failure to the next provider and counts the fallback", async () => {
    // Generation routes consume this raw shim. An invalidated credential
    // on the primary (401/403, or a 5xx whose body signals an
    // invalidated session) must not abort the run — it advances to the
    // next enabled provider and bumps the fallback count.
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401, "token invalidated") }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true, content: '{ "ok": true }' }],
    });
    const result = await runRawCompletionWithFallback({
      userId: "u-raw-auth-advance",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
    });
    expect(result.result.content).toBe('{ "ok": true }');
    expect(result.workingProvider.providerType).toBe("openai");
    expect(result.fallbackHops).toHaveLength(1);
    expect(result.fallbackHops[0].providerType).toBe("codex");
    expect(result.fallbackHops[0].httpStatus).toBe(401);
    expect(codex.callCount).toBe(1);
    expect(openai.callCount).toBe(1);
  });

  it("throws AllProvidersFailedError when every entry fails hard", async () => {
    const a = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }],
    });
    const b = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: false, error: err(503) }],
    });
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-raw-allfail",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: a },
          { providerType: "admin-openai", instance: b },
        ],
        params: singleUserTurn({ system: "s", user: "u" }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).attempts).toHaveLength(2);
  });

  it("wraps a sole-provider Codex 400 (tool-call request rejected) in AllProvidersFailedError instead of bubbling the raw error", async () => {
    // v1.21.3 — RCA for the live 500. A Codex 400 on the richer tool-call
    // request used to escape `isHardProviderFailure` (a non-401/403/429/5xx
    // 4xx) and bubble OUT of the chain runner un-wrapped. The Coach route's
    // catch only handled AllProvidersFailedError, so the raw error rethrew as
    // an HTTP 500 — exactly the incident. The 400 must now cascade and, with no
    // healthy provider left, be wrapped so the route can surface a graceful
    // provider frame (httpStatus classifies to 503 → coach.provider.unavailable).
    const codex = new ScriptedProvider({
      type: "codex",
      script: [
        {
          ok: false,
          error: Object.assign(new Error("Codex request failed (400): {…}"), {
            httpStatus: 400,
            upstream: "codex",
          }),
        },
      ],
    });
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-raw-codex400",
        surface: "coach",
        providers: [{ providerType: "codex", instance: codex }],
        params: singleUserTurn({ system: "s", user: "u" }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    const wrapped = caught as AllProvidersFailedError;
    expect(wrapped.attempts).toHaveLength(1);
    expect(wrapped.attempts[0].httpStatus).toBe(400);
    expect(wrapped.primaryCredentialExpired).toBe(false);
    // No 5xx / auth in the mix → generic unavailability (503) surface.
    expect(wrapped.httpStatus).toBe(503);
  });
});

describe("runRawCompletionWithFallback — empty input", () => {
  it("throws AllProvidersFailedError with httpStatus 422 when zero providers configured", async () => {
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-empty",
        surface: "coach",
        providers: [],
        params: singleUserTurn({ system: "s", user: "u" }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).httpStatus).toBe(422);
  });
});

// ── v1.11.0 W1 — durable provider-health ledger integration ──────────

describe("provider-health ledger — auth-failure negative cache", () => {
  it("records the auth failure and deprioritises the dead provider on the next call", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const codex = new ScriptedProvider({
      type: "codex",
      // First call 401, then (if ever re-tried) it would succeed — but
      // the negative cache must keep it benched.
      script: [{ ok: false, error: err(401, "OAuth expired") }, { ok: true }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true, content: '{ "ok": true }' }, { ok: true }],
    });
    const providers = [
      { providerType: "codex" as const, instance: codex },
      { providerType: "openai" as const, instance: openai },
    ];

    // First call: codex 401 → openai succeeds. Ledger now benches codex.
    await runRawCompletionWithFallback({
      userId: "u-neg",
      surface: "coach",
      providers,
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    });
    expect((await ledger.getSkipHints("u-neg")).get("codex")?.reason).toBe(
      "credential_expired",
    );

    // Reset the per-worker last-working cache so the ONLY thing steering
    // order on the second call is the durable ledger.
    clearLastWorkingProviderCache();

    // Second call: codex is benched to the tail by the negative cache,
    // so openai is tried first and codex is never re-invoked.
    const codexCallsBefore = codex.callCount;
    await runRawCompletionWithFallback({
      userId: "u-neg",
      surface: "coach",
      providers,
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    });
    expect(codex.callCount).toBe(codexCallsBefore); // not re-burned
  });

  it("clears the negative cache after a provider succeeds again", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    await ledger.recordFailure("u-clear-neg", "codex", 401);
    expect((await ledger.getSkipHints("u-clear-neg")).size).toBe(1);

    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: true }],
    });
    // A direct success on codex (e.g. user re-linked) clears the row.
    await runRawCompletionWithFallback({
      userId: "u-clear-neg",
      surface: "coach",
      providers: [{ providerType: "codex", instance: codex }],
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    });
    expect((await ledger.getSkipHints("u-clear-neg")).size).toBe(0);
  });

  it("lets the benched provider back to the front once the cooldown lapses", async () => {
    vi.useFakeTimers();
    const ledger = createInMemoryProviderHealthLedger();
    await ledger.recordFailure("u-lapse", "codex", 401);
    expect((await ledger.getSkipHints("u-lapse")).has("codex")).toBe(true);

    vi.advanceTimersByTime(AUTH_FAILURE_COOLDOWN_MS + 1);
    expect((await ledger.getSkipHints("u-lapse")).has("codex")).toBe(false);
  });
});

describe("provider-health ledger — local model as guaranteed floor", () => {
  it("still reaches the local provider even when every keyed provider is benched", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    // Pre-bench every remote provider with an auth failure.
    await ledger.recordFailure("u-floor", "codex", 401);
    await ledger.recordFailure("u-floor", "openai", 401);
    await ledger.recordFailure("u-floor", "anthropic", 401);

    const dead = (type: AIProvider["type"]) =>
      new ScriptedProvider({ type, script: [{ ok: false, error: err(401) }] });
    const local = new ScriptedProvider({
      type: "local",
      script: [{ ok: true, content: '{ "floor": true }' }],
    });

    const result = await runRawCompletionWithFallback({
      userId: "u-floor",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: dead("codex") },
        { providerType: "openai", instance: dead("admin-key") },
        { providerType: "anthropic", instance: dead("anthropic") },
        { providerType: "local", instance: local },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    });

    // The local floor is never benched by the negative cache and is
    // reached even though every other provider is in an auth cooldown.
    expect(result.result.content).toBe('{ "floor": true }');
    expect(result.workingProvider.providerType).toBe("local");
    expect(local.callCount).toBe(1);
  });

  it("never benches the local provider in the ledger even on a hard failure", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const local = new ScriptedProvider({
      type: "local",
      script: [{ ok: false, error: err(503) }, { ok: true }],
    });
    // A 503 on local records a hard failure but the runner must keep it
    // in the chain — there is no remote credential to "expire".
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-local-hard",
        surface: "coach",
        providers: [{ providerType: "local", instance: local }],
        params: singleUserTurn({ system: "s", user: "u" }),
        ledger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);

    // Even after a recorded hard failure, the next call still tries
    // local (NEVER_SKIP) and this time it succeeds.
    clearLastWorkingProviderCache();
    const result = await runRawCompletionWithFallback({
      userId: "u-local-hard",
      surface: "coach",
      providers: [{ providerType: "local", instance: local }],
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    });
    expect(result.workingProvider.providerType).toBe("local");
  });
});

describe("AllProvidersFailedError — primaryCredentialExpired", () => {
  it("flags primaryCredentialExpired when the first hop is auth-class", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: false, error: err(503) }],
    });
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-primary-auth",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: openai },
        ],
        params: singleUserTurn({ system: "s", user: "u" }),
        ledger,
      });
    } catch (e) {
      caught = e;
    }
    const e = caught as AllProvidersFailedError;
    expect(e.primaryCredentialExpired).toBe(true);
  });

  it("does NOT flag primaryCredentialExpired when the first hop is a 5xx", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(503) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: false, error: err(401) }],
    });
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-primary-5xx",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: openai },
        ],
        params: singleUserTurn({ system: "s", user: "u" }),
        ledger,
      });
    } catch (e) {
      caught = e;
    }
    const e = caught as AllProvidersFailedError;
    expect(e.primaryCredentialExpired).toBe(false);
  });
});

// ── v1.22 (#89) — streaming runner ───────────────────────────────────
/** A provider that streams: emits each char of `text` through onDelta. */
class StreamingProvider implements AIProvider {
  readonly type: AIProvider["type"] = "local";
  streamCalls = 0;
  bufferedCalls = 0;
  lastStreamParams: CompletionParams | null = null;
  constructor(private readonly text: string) {}
  async generateCompletion(): Promise<CompletionResult> {
    this.bufferedCalls += 1;
    return {
      content: this.text,
      tokensUsed: 1,
      model: "stream-model",
      providerType: this.type,
    };
  }
  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (d: string) => void,
  ): Promise<CompletionResult> {
    this.streamCalls += 1;
    this.lastStreamParams = params;
    for (const ch of this.text) onDelta(ch);
    return {
      content: this.text,
      tokensUsed: 3,
      model: "stream-model",
      providerType: this.type,
    };
  }
}

describe("runStreamingRawCompletionWithFallback", () => {
  it("drives a streaming provider via generateCompletionStream + onDelta and forwards timeoutMs", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const provider = new StreamingProvider("Hi");
    const deltas: string[] = [];
    const result = await runStreamingRawCompletionWithFallback({
      userId: "u-stream",
      surface: "coach",
      providers: [{ providerType: "local", instance: provider }],
      params: singleUserTurn({ system: "s", user: "u", timeoutMs: 12345 }),
      onDelta: (d) => deltas.push(d),
      ledger,
    });
    expect(deltas).toEqual(["H", "i"]);
    expect(result.result.content).toBe("Hi");
    expect(provider.streamCalls).toBe(1);
    expect(provider.bufferedCalls).toBe(0);
    // Per-request timeout is threaded through to the provider call.
    expect(provider.lastStreamParams?.timeoutMs).toBe(12345);
  });

  it("falls back to generateCompletion for a provider that does not stream", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    // ScriptedProvider has no generateCompletionStream → buffered path.
    const provider = new ScriptedProvider({
      script: [{ ok: true, content: "x" }],
    });
    const deltas: string[] = [];
    const result = await runStreamingRawCompletionWithFallback({
      userId: "u-nostream",
      surface: "coach",
      providers: [{ providerType: "local", instance: provider }],
      params: singleUserTurn({ system: "s", user: "u" }),
      onDelta: (d) => deltas.push(d),
      ledger,
    });
    expect(result.result.content).toBe("x");
    expect(provider.callCount).toBe(1);
    expect(deltas).toEqual([]); // no streaming → no deltas
  });

  it("cascades past a hard failure to the next (streaming) provider", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const broken = new ScriptedProvider({
      script: [{ ok: false, error: err(503) }],
    });
    const good = new StreamingProvider("ok");
    const result = await runStreamingRawCompletionWithFallback({
      userId: "u-cascade",
      surface: "coach",
      providers: [
        { providerType: "openai", instance: broken },
        { providerType: "local", instance: good },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
      onDelta: () => {},
      ledger,
    });
    expect(result.workingProvider.providerType).toBe("local");
    expect(result.fallbackHops.map((h) => h.providerType)).toEqual(["openai"]);
  });
});

// v1.37.19 (A7-2) — hop-time operator-cost guard.
//
// Watched red: with the `isOperatorFundedProvider` check removed from
// `runRawChain` (the pre-fix walker), the exhausted-cap case below fails —
// the admin-openai fallback was invoked and spent operator money although
// the request had only been reserved under the user-plan ceiling.
describe("runRawCompletionWithFallback — operator-cost cap at hop time", () => {
  const params: CompletionParams = singleUserTurn({ system: "s", user: "u" });

  it("refuses the admin-* fallback hop once the operator cap is exhausted", async () => {
    budgetState.spent = 200_000; // OPERATOR_COST_CAP
    budgetState.operatorSpent = 200_000;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    await expect(
      runRawCompletionWithFallback({
        userId: "u-cap",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: adminOpenai },
        ],
        params,
      }),
    ).rejects.toMatchObject({
      attempts: [
        expect.objectContaining({ providerType: "codex" }),
        expect.objectContaining({
          providerType: "admin-openai",
          failureReason: "operator-cost-cap-exhausted",
        }),
      ],
    });
    // The operator-funded provider was never invoked.
    expect(adminOpenai.callCount).toBe(0);
  });

  it("lets the admin-* fallback run while the operator cap has headroom", async () => {
    budgetState.spent = 100;
    budgetState.operatorSpent = 100;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    const outcome = await runRawCompletionWithFallback({
      userId: "u-headroom",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "admin-openai", instance: adminOpenai },
      ],
      params,
    });
    expect(outcome.workingProvider.providerType).toBe("admin-openai");
    expect(adminOpenai.callCount).toBe(1);
  });

  // v1.38.19 — the guard reads the OPERATOR-funded share.
  //
  // Production evidence (2026-09-11): the operator's day held ~1.2 M tokens,
  // nearly all served by `codex` on his own ChatGPT plan. Comparing the day's
  // TOTAL against the operator ceiling closed the operator's own fallback hop
  // on money he had never spent.
  it("lets the admin-* hop run on a big day the user's own plan paid for", async () => {
    budgetState.spent = 1_200_000;
    budgetState.operatorSpent = 150_000;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    const outcome = await runRawCompletionWithFallback({
      userId: "u-owner-split",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "admin-openai", instance: adminOpenai },
      ],
      params,
    });
    expect(outcome.workingProvider.providerType).toBe("admin-openai");
    expect(adminOpenai.callCount).toBe(1);
  });

  it("refuses the admin-* hop once the OPERATOR-funded share is exhausted", async () => {
    budgetState.spent = 1_200_000;
    budgetState.operatorSpent = 250_000;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    await expect(
      runRawCompletionWithFallback({
        userId: "u-owner-exhausted",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: adminOpenai },
        ],
        params,
      }),
    ).rejects.toMatchObject({
      attempts: [
        expect.objectContaining({ providerType: "codex" }),
        expect.objectContaining({
          providerType: "admin-openai",
          failureReason: "operator-cost-cap-exhausted",
        }),
      ],
    });
    expect(adminOpenai.callCount).toBe(0);
  });

  // v1.38.19 — the hop guard knows which SURFACE asked.
  //
  // Without this the job share was enforced at reservation time only: a
  // background reservation admitted under `resolveDailyCapFor("job", …)` could
  // then reach an operator-funded FALLBACK hop and spend against the full
  // 200 000. That is the original defect by another route — chain
  // `[codex, admin-openai]` reserves under the user-plan ceiling, `codex` 429s,
  // every job falls back onto the shared key, and background work fills the
  // operator's ceiling before the user opens the chat.
  it("refuses a JOB's admin-* fallback hop once only the reserve is left", async () => {
    budgetState.spent = 160_000;
    budgetState.operatorSpent = 160_000;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    await expect(
      runRawCompletionWithFallback({
        userId: "u-job-share",
        surface: "job",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: adminOpenai },
        ],
        params,
      }),
    ).rejects.toMatchObject({
      attempts: [
        expect.objectContaining({ providerType: "codex" }),
        expect.objectContaining({
          providerType: "admin-openai",
          failureReason: "operator-cost-cap-exhausted",
        }),
      ],
    });
    expect(adminOpenai.callCount).toBe(0);
  });

  it("still lets the interactive chat take that same hop", async () => {
    // The whole point of the reserve: at 160 000 operator tokens the background
    // work is done for the day and the person waiting is not.
    budgetState.spent = 160_000;
    budgetState.operatorSpent = 160_000;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    const outcome = await runRawCompletionWithFallback({
      userId: "u-job-share-chat",
      surface: "coach",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "admin-openai", instance: adminOpenai },
      ],
      params,
    });
    expect(outcome.workingProvider.providerType).toBe("admin-openai");
    expect(adminOpenai.callCount).toBe(1);
  });

  it("bounds the operator hop on the day's mixed total as well", async () => {
    // `operator_tokens` returns to ~0 on every reconcile the user's own plan
    // settled, so the operator arm alone leaves a runaway loop unbounded. The
    // abuse ceiling on the total is checked at the hop for the same reason it
    // is checked at reservation time.
    budgetState.spent = 2_000_000;
    budgetState.operatorSpent = 0;
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(500) }],
    });
    const adminOpenai = new ScriptedProvider({ script: [{ ok: true }] });

    await expect(
      runRawCompletionWithFallback({
        userId: "u-total-ceiling",
        surface: "coach",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "admin-openai", instance: adminOpenai },
        ],
        params,
      }),
    ).rejects.toMatchObject({
      attempts: [
        expect.objectContaining({ providerType: "codex" }),
        expect.objectContaining({
          providerType: "admin-openai",
          failureReason: "operator-cost-cap-exhausted",
        }),
      ],
    });
    expect(adminOpenai.callCount).toBe(0);
  });

  it("never consults the ledger for a user-funded chain", async () => {
    budgetState.spent = 999_999_999;
    const openai = new ScriptedProvider({ script: [{ ok: true }] });
    const outcome = await runRawCompletionWithFallback({
      userId: "u-own-key",
      surface: "coach",
      providers: [{ providerType: "openai", instance: openai }],
      params,
    });
    // The user's own key is not the operator's money — the cap does not
    // apply and the call proceeds regardless of the recorded spend.
    expect(outcome.workingProvider.providerType).toBe("openai");
  });
});
