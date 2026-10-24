/**
 * #1279 — background work and a provider the health ledger has benched.
 *
 * A chain whose only entry answered every call with reasoning and no answer
 * was called by every background job: the ledger counted the failures and
 * paused the provider, but a paused provider only moved to the tail of the
 * chain, and the tail is still walked. A job now leaves a benched provider
 * out (the local floor only once it is paused), says so once per window, and
 * a person's own call still reaches it and reports its error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitSignal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));

import {
  singleUserTurn,
  type AIProvider,
  type CompletionParams,
  type CompletionResult,
} from "../types";
import {
  AllProvidersFailedError,
  clearLastWorkingProviderCache,
  runRawCompletionWithFallback,
} from "../provider-runner";
import {
  HARD_FAILURE_SKIP_THRESHOLD,
  PROVIDER_PAUSE_THRESHOLD,
  createInMemoryProviderHealthLedger,
} from "../provider-health-ledger";
import type { ProviderChainType } from "../provider-chain";

/** Answers every call with reasoning and no answer, as the clients report it. */
class AnswerlessProvider implements AIProvider {
  readonly type: AIProvider["type"];
  calls = 0;
  constructor(type: AIProvider["type"] = "openai-compatible") {
    this.type = type;
  }
  async generateCompletion(_: CompletionParams): Promise<CompletionResult> {
    this.calls += 1;
    throw Object.assign(new Error("returned empty content"), {
      httpStatus: 0,
      kind: "reasoning_only",
      tokensUsed: 2700,
    });
  }
}

function walk(
  surface: "job" | "coach",
  userId: string,
  providerType: ProviderChainType,
  instance: AIProvider,
  ledger: ReturnType<typeof createInMemoryProviderHealthLedger>,
) {
  return runRawCompletionWithFallback({
    userId,
    surface,
    providers: [{ providerType, instance }],
    params: singleUserTurn({ system: "s", user: "u" }),
    ledger,
  });
}

function signals(action: string) {
  return emitSignal.mock.calls
    .map((c) => c[0] as { action: string; meta: Record<string, unknown> })
    .filter((s) => s.action === action);
}

beforeEach(() => {
  clearLastWorkingProviderCache();
  emitSignal.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#1279: background work and a benched provider", () => {
  it("stops calling the only provider once the ledger benches it, for jobs", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const gateway = new AnswerlessProvider();
    for (let i = 0; i < HARD_FAILURE_SKIP_THRESHOLD; i += 1) {
      await expect(
        walk("job", "u-bench", "openai-compatible", gateway, ledger),
      ).rejects.toBeInstanceOf(AllProvidersFailedError);
    }
    expect(gateway.calls).toBe(HARD_FAILURE_SKIP_THRESHOLD);

    // Ten more jobs inside the window: none of them sends a request.
    for (let i = 0; i < 10; i += 1) {
      const err = await walk(
        "job",
        "u-bench",
        "openai-compatible",
        gateway,
        ledger,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(AllProvidersFailedError);
      expect((err as AllProvidersFailedError).attempts).toEqual([
        expect.objectContaining({
          providerType: "openai-compatible",
          failureKind: "paused",
          httpStatus: null,
        }),
      ]);
    }
    expect(gateway.calls).toBe(HARD_FAILURE_SKIP_THRESHOLD);
    // One line for the window, not one per job.
    expect(signals("ai.chain.background_paused")).toHaveLength(1);
    expect(signals("ai.chain.background_paused")[0].meta).toMatchObject({
      provider: "openai-compatible",
      reason: "backoff",
    });
  });

  it("still sends a person's own call to the benched provider and reports its error", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const gateway = new AnswerlessProvider();
    for (let i = 0; i < PROVIDER_PAUSE_THRESHOLD; i += 1) {
      await walk("job", "u-coach", "openai-compatible", gateway, ledger).catch(
        () => undefined,
      );
    }
    const before = gateway.calls;
    const err = await walk(
      "coach",
      "u-coach",
      "openai-compatible",
      gateway,
      ledger,
    ).catch((e) => e);
    expect(gateway.calls).toBe(before + 1);
    expect((err as AllProvidersFailedError).attempts[0].failureKind).toBe(
      "reasoning_only",
    );
  });

  it("logs once more when a new window opens", async () => {
    vi.useFakeTimers();
    const ledger = createInMemoryProviderHealthLedger();
    const gateway = new AnswerlessProvider();
    for (let i = 0; i < HARD_FAILURE_SKIP_THRESHOLD; i += 1) {
      await walk("job", "u-window", "openai-compatible", gateway, ledger).catch(
        () => undefined,
      );
    }
    await walk("job", "u-window", "openai-compatible", gateway, ledger).catch(
      () => undefined,
    );
    // The five-minute backoff lifts; the next job tries, fails, re-arms.
    vi.advanceTimersByTime(6 * 60 * 1000);
    await walk("job", "u-window", "openai-compatible", gateway, ledger).catch(
      () => undefined,
    );
    await walk("job", "u-window", "openai-compatible", gateway, ledger).catch(
      () => undefined,
    );
    expect(gateway.calls).toBe(HARD_FAILURE_SKIP_THRESHOLD + 1);
    expect(signals("ai.chain.background_paused")).toHaveLength(2);
  });

  it("keeps the local floor through a short backoff and leaves it out once paused", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const local = new AnswerlessProvider("local");
    for (let i = 0; i < HARD_FAILURE_SKIP_THRESHOLD; i += 1) {
      await walk("job", "u-local", "local", local, ledger).catch(
        () => undefined,
      );
    }
    // Backoff: the floor is still called.
    await walk("job", "u-local", "local", local, ledger).catch(() => undefined);
    expect(local.calls).toBe(HARD_FAILURE_SKIP_THRESHOLD + 1);
    while (local.calls < PROVIDER_PAUSE_THRESHOLD) {
      await walk("job", "u-local", "local", local, ledger).catch(
        () => undefined,
      );
    }
    // Paused: background work leaves it alone.
    await walk("job", "u-local", "local", local, ledger).catch(() => undefined);
    await walk("job", "u-local", "local", local, ledger).catch(() => undefined);
    expect(local.calls).toBe(PROVIDER_PAUSE_THRESHOLD);
  });

  it("sums what the failed hops reported spending", async () => {
    const ledger = createInMemoryProviderHealthLedger();
    const err = await runRawCompletionWithFallback({
      userId: "u-spend",
      surface: "job",
      providers: [
        {
          providerType: "openai-compatible",
          instance: new AnswerlessProvider(),
        },
        { providerType: "local", instance: new AnswerlessProvider("local") },
      ],
      params: singleUserTurn({ system: "s", user: "u" }),
      ledger,
    }).catch((e) => e);
    expect((err as AllProvidersFailedError).tokensSpent).toBe(5400);
  });
});
