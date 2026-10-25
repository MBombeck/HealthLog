/**
 * #1274 — a status run waits for every call it may make.
 *
 * A status run is one model call plus, on the Local and gateway clients, one
 * repeat when a thinking model answered with reasoning alone. Each has the
 * person's response timeout to itself. The run's outer bound used to be one
 * call, so a model that needs 300 s per answer under a 300 s setting, whose
 * first answer was reasoning only, was cut off in the middle of the repeat
 * that would have answered, and the card kept its fallback text.
 *
 * The provider runner is replaced by a clock-driven stand-in that answers
 * after the time the two calls take; everything else in the chokepoint runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { settings } = vi.hoisted(() => ({
  settings: { aiResponseTimeoutSeconds: 300 as number | null },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ total_tokens: 0, operator_tokens: 0 }]),
    $executeRaw: vi.fn(async () => 1),
    user: {
      findUnique: vi.fn(async () => ({
        aiResponseTimeoutSeconds: settings.aiResponseTimeoutSeconds,
      })),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(async () => [
    { providerType: "local", instance: {} },
  ]),
  resolveProvider: vi.fn(async () => ({ type: "none" })),
  probeProviderPresence: vi.fn(async () => true),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  })),
}));

vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));

const { runRawCompletionWithFallback } = vi.hoisted(() => ({
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback,
}));

import { runStatusCompletion, statusRunBoundMs } from "../status-provider";
import { STATUS_PROVIDER_TIMEOUT_MS } from "../with-timeout";
import { STATUS_MODEL_CALLS } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import {
  nextStatusPollInterval,
  statusPollMaxAttempts,
} from "@/hooks/use-insight-status";

/** A model that answers `afterMs` after the run starts. */
function answersAfter(afterMs: number) {
  runRawCompletionWithFallback.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              result: {
                content: '{"summary":"Steady."}',
                model: "slow-local",
                tokensUsed: 80,
              },
              workingProvider: { providerType: "local" },
              tokensSpent: 0,
            }),
          afterMs,
        ),
      ),
  );
}

function run() {
  return runStatusCompletion({
    userId: "u1",
    cacheAction: "status:test",
    systemPrompt: "system",
    userPrompt: "user",
    capability: "statusText",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  runRawCompletionWithFallback.mockReset();
  settings.aiResponseTimeoutSeconds = 300;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runStatusCompletion — the outer bound allows every call of a run", () => {
  it("lands a note whose reasoning-only first answer was repeated", async () => {
    // First call: the full 300 s, reasoning only. The repeat answers at 150 s.
    answersAfter(450_000);
    const pending = run();
    await vi.advanceTimersByTimeAsync(450_000);
    await expect(pending).resolves.toMatchObject({
      kind: "ok",
      content: '{"summary":"Steady."}',
    });
  });

  it("still gives up on a run that outlasts both calls", async () => {
    answersAfter(700_000);
    const pending = run();
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(pending).resolves.toEqual({ kind: "timeout" });
  });

  it("sizes the bound from the default when no setting is stored", () => {
    expect(statusRunBoundMs(60_000)).toBe(60_000 * STATUS_MODEL_CALLS);
    expect(STATUS_MODEL_CALLS).toBe(2);
  });
});

describe("the open card polls as long as the run may take", () => {
  it("outlasts the run's own bound for every setting", () => {
    // The page reads the published `responseTimeoutMs`: the setting in ms,
    // or the 60 s provider default when nothing is set.
    const cases: Array<[number | null, number]> = [
      [null, 60_000],
      [10, 10_000],
      [60, 60_000],
      [180, 180_000],
      [300, 300_000],
      [600, 600_000],
    ];
    for (const [seconds, published] of cases) {
      const attempts = statusPollMaxAttempts(published);
      let count = 1; // the read that enqueued the generation
      let watchedMs = 0;
      let interval = nextStatusPollInterval(true, count, false, attempts);
      while (interval !== false) {
        watchedMs += interval;
        count += 1;
        interval = nextStatusPollInterval(true, count, false, attempts);
      }
      const runBound = statusRunBoundMs(
        resolveEffectiveTimeoutMs(seconds, STATUS_PROVIDER_TIMEOUT_MS),
      );
      expect(watchedMs, `setting ${seconds ?? "unset"}`).toBeGreaterThan(
        runBound,
      );
    }
  });

  it("stays bounded at the largest setting", () => {
    // Twenty minutes of two model calls at 600 s, read every 15 s after the
    // first 48 s: about a hundred reads, not three hundred.
    expect(statusPollMaxAttempts(600_000)).toBeLessThanOrEqual(100);
  });
});
