/**
 * v1.7.0 W6 — unit tests for the nightly insight pre-generation cron.
 *
 * Covers:
 *   - the discovery query selects stale-cache users who kept AI analysis
 *     (the `insights` module) on;
 *   - each half of the pass runs on its own capability (`briefing` for the
 *     comprehensive, `statusText` for the warm), resolved before any budget
 *     write or generation;
 *   - the per-user budget gate blocks a user already generated today;
 *   - the master assistant kill-switch short-circuits the whole run;
 *   - the generator outcomes tally correctly (generated / cached /
 *     unchanged / skipped / failed);
 *   - the warm pass is single-locale + refill-only (v1.16.8);
 *   - the forced single-user warm is idempotent (freshness re-check),
 *     backs off after a failure, and is capped per day (v1.16.8);
 *   - the queue is registered in `allQueues` AND scheduled in
 *     reminder-worker.ts (the v1.4.37 W10 unregistered-queue catch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const checkRateLimit = vi.fn();
const getAssistantFlags = vi.fn();
const annotateSpy = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
// v1.28.30 — spy on annotate so the no-silent-failure contract is pinned:
// every failure increment must emit a queryable action. Spread the actual
// module so `getEvent` (used by the feature-cache scope) stays real.
vi.mock("@/lib/logging/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logging/context")>(
    "@/lib/logging/context",
  );
  return {
    ...actual,
    annotate: (...a: unknown[]) => annotateSpy(...a),
  };
});
vi.mock("@/lib/feature-flags", async () =>
  (
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(() => getAssistantFlags()),
);
// Per-user capabilities, keyed by capability; every test starts with both
// halves available and overrides one or both.
type CapabilityState = {
  available: boolean;
  reason: string | null;
  onDeviceAllowed: boolean;
};
const AVAILABLE: CapabilityState = {
  available: true,
  reason: null,
  onDeviceAllowed: true,
};
function unavailable(reason: string): CapabilityState {
  return { available: false, reason, onDeviceAllowed: false };
}
let capabilities: Record<string, CapabilityState> = {};
const aiCapabilityForJob = vi.fn(
  async (_userId: string, key: string) => capabilities[key] ?? AVAILABLE,
);
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: (...a: [string, string]) => aiCapabilityForJob(...a),
  aiCapabilityForRecord: vi.fn(),
}));
// Never reach the real generator (which would import the provider chain).
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  generateComprehensiveInsight: vi.fn(),
}));
// The seven status generators import the provider chain transitively;
// stub the modules so the warm-pass never touches a live provider when
// the test does not inject its own generators.
vi.mock("@/lib/insights/blood-pressure-status", () => ({
  generateBloodPressureStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/pulse-status", () => ({
  generatePulseStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/weight-status", () => ({
  generateWeightStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/bmi-status", () => ({
  generateBmiStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/mood-status", () => ({
  generateMoodStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/medication-compliance-status", () => ({
  generateMedicationComplianceStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/general-status", () => ({
  generateGeneralStatusForUser: vi.fn(),
}));
// v1.18.7 (HIGH-1) — the batched status warm is the production default;
// every test here injects its own `statusGenerators`, so the batch is never
// exercised. Stub the module so its transitive `prepare*` imports of the
// mocked status modules above don't trip an incomplete-mock load error.
vi.mock("@/lib/insights/status-batch", () => ({
  generateStatusBatchForUser: vi.fn(async () => ({
    served: 0,
    batched: 0,
    fellBack: 0,
    batchCallMade: false,
  })),
}));
// v1.8.7.1 — the generic metric generator also imports the provider
// chain transitively; stub it so the default generic warm pass never
// touches a live provider when the test does not inject its own.
vi.mock("@/lib/insights/metric-status", () => ({
  generateMetricStatus: vi.fn(async () => ({
    hasProvider: true,
    text: "ok",
    cached: false,
    updatedAt: new Date().toISOString(),
  })),
}));

import {
  runInsightPregenerate,
  forceWarmUser,
  findPregenerateCandidates,
  comprehensiveWarmBudgetMs,
  PREGENERATE_STALE_MS,
  FORCE_WARM_DAILY_LIMIT,
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
} from "../insight-pregenerate";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

function makePrisma(
  users: Array<{
    id: string;
    locale: string | null;
    aiResponseTimeoutSeconds?: number | null;
  }>,
  optedOut: string[] = [],
) {
  const findMany = vi.fn().mockResolvedValue(users);
  const queryRaw = vi.fn().mockResolvedValue(optedOut.map((id) => ({ id })));
  // forceWarmUser reads `insightsCachedAt` / `insightsWarmFailedAt` at job
  // start and maintains the failure marker; default: never warmed, never
  // failed.
  const findUnique = vi.fn().mockResolvedValue({
    insightsCachedAt: null,
    insightsWarmFailedAt: null,
  });
  const update = vi.fn().mockResolvedValue({});
  return {
    prisma: { user: { findMany, findUnique, update }, $queryRaw: queryRaw },
    findMany,
    findUnique,
    update,
    queryRaw,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    briefing: true,
    insightStatus: true,
  });
  checkRateLimit.mockResolvedValue({ allowed: true });
  capabilities = {};
});

describe("findPregenerateCandidates", () => {
  it("filters on the insights opt-out + stale-or-null cache, oldest-first, capped", async () => {
    const { prisma, findMany, queryRaw } = makePrisma(
      [{ id: "u1", locale: "de" }],
      ["opted-out"],
    );
    const now = new Date("2026-05-31T04:30:00.000Z");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findPregenerateCandidates(prisma as any, now, 50);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0].slice(1)).toContain("insights");
    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    // Hiding the Coach is not an AI opt-out any more.
    expect(arg.where.disableCoach).toBeUndefined();
    expect(arg.where.id).toEqual({ notIn: ["opted-out"] });
    expect(arg.where.OR).toEqual([
      { insightsCachedAt: null },
      {
        insightsCachedAt: {
          lt: new Date(now.getTime() - PREGENERATE_STALE_MS),
        },
      },
    ]);
    expect(arg.orderBy).toEqual({ insightsCachedAt: "asc" });
    expect(arg.take).toBe(50);
  });

  it("adds no id filter when nobody opted out", async () => {
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findPregenerateCandidates(prisma as any, new Date(), 50);
    expect(findMany.mock.calls[0][0].where.id).toBeUndefined();
  });
});

describe("runInsightPregenerate — the job's time budget", () => {
  it("stops between candidates once the budget is spent and says so", async () => {
    capabilities = {
      briefing: unavailable("user_disabled"),
      statusText: unavailable("user_disabled"),
    };
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "de" },
      { id: "u3", locale: "de" },
    ]);
    let checks = 0;
    const result = await runInsightPregenerate(prisma as never, {
      generate: vi.fn(),
      statusGenerators: [],
      warmGenericMetrics: vi.fn().mockResolvedValue(0),
      // Spent after the first candidate.
      shouldStop: () => checks++ >= 1,
    });

    expect(result).toMatchObject({ total: 3, skipped: 1, stoppedEarly: true });
    expect(aiCapabilityForJob).toHaveBeenCalledTimes(2);
  });
});

describe("runInsightPregenerate — per-user capabilities", () => {
  it("skips a user with neither capability before any budget write or generation", async () => {
    capabilities = {
      briefing: unavailable("user_disabled"),
      statusText: unavailable("user_disabled"),
    };
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "briefing");
    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "statusText");
    expect(result).toMatchObject({ total: 1, skipped: 1, budgetBlocked: 0 });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    for (const g of statusGenerators) expect(g).not.toHaveBeenCalled();
    expect(warmGenericMetrics).not.toHaveBeenCalled();
    expect(annotateSpy).toHaveBeenCalledWith({
      action: { name: "insights.pregenerate.skipped" },
      meta: { briefing: "user_disabled", status_text: "user_disabled" },
    });
  });

  it("skips the comprehensive without a budget write when only briefing is unavailable, and still warms", async () => {
    capabilities = { briefing: unavailable("operator_disabled") };
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(4);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.budgetBlocked).toBe(0);
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result.assessmentsWarmed).toBe(7);
    expect(result.metricAssessmentsWarmed).toBe(4);
  });

  it("generates the comprehensive but warms nothing when only statusText is unavailable", async () => {
    capabilities = { statusText: unavailable("consent_required") };
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(4);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.generated).toBe(1);
    for (const g of statusGenerators) expect(g).not.toHaveBeenCalled();
    expect(warmGenericMetrics).not.toHaveBeenCalled();
    expect(result.assessmentsWarmed).toBe(0);
    expect(result.metricAssessmentsWarmed).toBe(0);
  });
});

describe("runInsightPregenerate — kill switch", () => {
  it("short-circuits when the briefing surface is disabled globally", async () => {
    getAssistantFlags.mockResolvedValue({ enabled: false, briefing: false });
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("runInsightPregenerate — budget gate", () => {
  it("skips the comprehensive for a budget-blocked user but never calls the generator for them", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "en" },
    ]);
    // u1 blocked, u2 allowed.
    checkRateLimit
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(2);
    expect(result.budgetBlocked).toBe(1);
    expect(result.generated).toBe(1);
    // The budget gate uses a dedicated bucket key, not the route bucket.
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate:u1",
      1,
      expect.any(Number),
    );
    // Only u2 reached the generator.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("u2", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("still runs the refill-only status warm for a budget-blocked user (v1.16.1)", async () => {
    // The 02:xx status crons skip every pregenerate candidate on the
    // assumption that the 04:30 pass warms their cards. A budget-blocked
    // candidate must therefore still get the warm — refill-only
    // (`force: false`), so a card already generated today is a cheap
    // cache read while a cold card generates behind its hash gate.
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    checkRateLimit.mockResolvedValue({ allowed: false });
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(2);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.budgetBlocked).toBe(1);
    // v1.16.8 — single-locale warm: only the user's resolved locale.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result.assessmentsWarmed).toBe(7);
    expect(result.metricAssessmentsWarmed).toBe(2);
  });
});

describe("runInsightPregenerate — force flag", () => {
  it("forces a fresh generation so the 20-24h cache window is not short-circuited to `cached`", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    await runInsightPregenerate(prisma as never, { generate });

    // The cron's discovery window (20 h) is shorter than the
    // generator's 24 h TTL; `force: true` bypasses the TTL re-check so
    // a 20-24h-old cache actually regenerates rather than returning
    // `cached` and wasting the budget bucket. The generator's own
    // content-hash gate is what prevents a same-data force from
    // reaching the provider. The nightly loop also threads an
    // AbortSignal so its bounded budget can cut a stalled generation off.
    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "de",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });
});

describe("runInsightPregenerate — outcome tally", () => {
  it("tallies generated / cached / unchanged / skipped / failed", async () => {
    const { prisma } = makePrisma([
      { id: "a", locale: "de" },
      { id: "b", locale: "de" },
      { id: "c", locale: "de" },
      { id: "d", locale: "de" },
      { id: "e", locale: null },
    ]);
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ status: "generated", providerType: "x" })
      .mockResolvedValueOnce({ status: "cached" })
      .mockResolvedValueOnce({ status: "unchanged" })
      .mockResolvedValueOnce({ status: "skipped", reason: "no-provider" })
      .mockResolvedValueOnce({ status: "failed", reason: "provider-error" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result).toMatchObject({
      total: 5,
      generated: 1,
      cached: 1,
      unchanged: 1,
      skipped: 1,
      failed: 1,
      budgetBlocked: 0,
    });
    // Locale defaulting: v1.15.20 — non-German (incl. null) → "en",
    // matching the no-key fallback routing.
    expect(generate).toHaveBeenLastCalledWith("e", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("tallies a comprehensive that exceeds its bounded budget as failed and aborts it (v1.16.1)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    let observedSignal: AbortSignal | undefined;
    const generate = vi.fn().mockImplementation(
      (_userId: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = opts.signal;
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            // v1.25.12 — above the default warm budget (~210 s = the 180 s
            // comprehensive provider budget + headroom) so the bounded budget
            // fires before this "slow" generation settles.
            260_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    vi.useFakeTimers();
    try {
      const promise = runInsightPregenerate(prisma as never, {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      await vi.advanceTimersByTimeAsync(230_000);
      const result = await promise;

      // The timeout fired, aborted the still-running generation (so its
      // late resolve cannot write a cache row the loop no longer expects),
      // and the refill-only warm still ran.
      expect(observedSignal?.aborted).toBe(true);
      expect(result.failed).toBe(1);
      expect(result.generated).toBe(0);
      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
      }
      expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// v1.28.30 — the recurring "no briefing today" chain started with a nightly
// failure that was invisible: a generator resolving `{ status: "failed" }`
// bumped the tally through a switch case with NO annotation (only the
// bounded timeout/error path was annotated), and the failed user was not
// re-attempted until the next night. These tests pin both halves of the
// fix: every failure path annotates `insights.pregenerate.comprehensive_failed`
// with a stage + cause, and every failure enqueues exactly one bounded
// intra-day retry for that user.
describe("runInsightPregenerate — failure visibility + intra-day retry (v1.28.30)", () => {
  function failureAnnotations() {
    return annotateSpy.mock.calls
      .map(
        (call) =>
          call[0] as {
            action?: { name?: string };
            meta?: Record<string, unknown>;
          },
      )
      .filter(
        (a) => a.action?.name === "insights.pregenerate.comprehensive_failed",
      );
  }

  it("annotates a generator-returned `failed` outcome (the previously silent switch case) and enqueues one retry", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "invalid-json" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);
    const enqueueRetry = vi.fn().mockResolvedValue(undefined);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
      enqueueRetry,
    });

    expect(result.failed).toBe(1);
    const failures = failureAnnotations();
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({
      locale: "de",
      stage: "nightly.generator",
      cause: "generator:invalid-json",
    });
    expect(enqueueRetry).toHaveBeenCalledTimes(1);
    expect(enqueueRetry).toHaveBeenCalledWith({ userId: "u1", locale: "de" });
  });

  it("annotates a thrown generator error with its message and enqueues one retry", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET upstream"));
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);
    const enqueueRetry = vi.fn().mockResolvedValue(undefined);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
      enqueueRetry,
    });

    expect(result.failed).toBe(1);
    const failures = failureAnnotations();
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({
      locale: "en",
      stage: "nightly.bound",
      cause: "error",
      message: "ECONNRESET upstream",
    });
    expect(enqueueRetry).toHaveBeenCalledWith({ userId: "u1", locale: "en" });
  });

  it("annotates a bounded-budget timeout and enqueues one retry", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            260_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);
    const enqueueRetry = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const promise = runInsightPregenerate(prisma as never, {
        generate,
        statusGenerators,
        warmGenericMetrics,
        enqueueRetry,
      });
      await vi.advanceTimersByTimeAsync(230_000);
      const result = await promise;

      expect(result.failed).toBe(1);
      const failures = failureAnnotations();
      expect(failures).toHaveLength(1);
      expect(failures[0].meta).toMatchObject({
        stage: "nightly.bound",
        cause: "timeout",
      });
      expect(enqueueRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT enqueue a retry for generated / cached / unchanged / skipped / budget-blocked users", async () => {
    const { prisma } = makePrisma([
      { id: "a", locale: "de" },
      { id: "b", locale: "de" },
      { id: "c", locale: "de" },
      { id: "d", locale: "de" },
      { id: "e", locale: "de" },
    ]);
    // e is budget-blocked; a-d run the generator.
    checkRateLimit
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ status: "generated", providerType: "x" })
      .mockResolvedValueOnce({ status: "cached" })
      .mockResolvedValueOnce({ status: "unchanged" })
      .mockResolvedValueOnce({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);
    const enqueueRetry = vi.fn().mockResolvedValue(undefined);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
      enqueueRetry,
    });

    expect(result.failed).toBe(0);
    expect(enqueueRetry).not.toHaveBeenCalled();
    expect(failureAnnotations()).toHaveLength(0);
  });
});

describe("runInsightPregenerate — per-metric warm pass", () => {
  function warmGen(result: { hasProvider: boolean; cached: boolean }) {
    return vi.fn().mockResolvedValue(result);
  }

  it("runs all seven status generators refill-only in the user's locale after a successful comprehensive generation", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    // v1.16.8 — single-locale, refill-only. The comprehensive write no
    // longer evicts the per-status rows, so there is nothing to force;
    // each generator's content-hash gate decides whether its data changed.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(result.assessmentsWarmed).toBe(7);
  });

  it("warms in the user's resolved locale, not both families (v1.16.8)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["en"]);
  });

  it("warms when the comprehensive pass returned `unchanged` (hash gate skipped the provider)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn().mockResolvedValue({ status: "unchanged" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    expect(result.unchanged).toBe(1);
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(result.assessmentsWarmed).toBe(7);
  });

  it("does NOT warm when the statusText capability has no provider", async () => {
    // The warm is gated on its own capability now, not on the comprehensive
    // outcome: no provider for the status notes → nothing to warm.
    capabilities = { statusText: unavailable("no_provider") };
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: false, cached: true }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).not.toHaveBeenCalled();
    }
    expect(result.assessmentsWarmed).toBe(0);
  });

  it("warms refill-only when the comprehensive pass failed (v1.16.1)", async () => {
    // A failed comprehensive leaves today's rows (if any) valid — the warm
    // refills only the cold cards. Before v1.16.1 this path skipped the
    // warm entirely, leaving every card of a 02:xx-skipped candidate cold
    // until the first on-visit generation.
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "provider-error" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(result.assessmentsWarmed).toBe(7);
  });

  it("warms refill-only when the comprehensive pass skipped for missing consent (v1.16.1)", async () => {
    // `skipped`/`no-consent` gates only the comprehensive briefing; the
    // per-card generators decide their own consent/provider posture, so
    // the warm still runs (the forced single-user warm already behaves
    // this way — "it is the generator, not the caller, that decides").
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-consent" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(result.assessmentsWarmed).toBe(7);
  });

  it("counts only fresh provider-backed assessments and survives a thrown generator", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = [
      warmGen({ hasProvider: true, cached: false }), // counts
      warmGen({ hasProvider: false, cached: true }), // no provider — skip
      warmGen({ hasProvider: true, cached: true }), // served cache — skip
      vi.fn().mockRejectedValue(new Error("boom")), // throws — swallowed
      warmGen({ hasProvider: true, cached: false }), // counts
    ];

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    // The throw must not abort the loop — every generator was attempted
    // once (single-locale warm).
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
    // Two counting generators × one locale = 2 fresh assessments.
    expect(result.assessmentsWarmed).toBe(2);
  });
});

describe("runInsightPregenerate — generic metric warm pass (v1.8.7.1)", () => {
  it("warms the generic metric caches after a successful comprehensive generation", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    // Stub the seven specialised generators so only the generic count
    // is under test.
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(9);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(warmGenericMetrics).toHaveBeenCalledTimes(1);
    // Single-locale, refill-only (v1.16.8) — no force mode left.
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result.metricAssessmentsWarmed).toBe(9);
  });

  it("does NOT warm the generic metric caches when the statusText capability has no provider", async () => {
    capabilities = { statusText: unavailable("no_provider") };
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: false, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(9);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(warmGenericMetrics).not.toHaveBeenCalled();
    expect(result.metricAssessmentsWarmed).toBe(0);
  });
});

describe("forceWarmUser — on-demand single-user warm (v1.8.7.1)", () => {
  it("warms the caller's locale only, under the daily forced-warm bucket", async () => {
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(5);

    const result = await forceWarmUser(prisma as never, "u1", "en", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    // Comprehensive forced once, in the caller's active locale, with an
    // AbortSignal so a timeout can cut the generation off.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
    // v1.16.8 — single-locale warm, refill-only: the comprehensive write
    // no longer evicts the per-status rows, and the second locale family
    // warms lazily through the read-path enqueue when actually read.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["en"]);
    // The 20 h nightly bucket is bypassed; the forced path consults its
    // own daily cap instead.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate-daily:u1",
      FORCE_WARM_DAILY_LIMIT,
      expect.any(Number),
    );
    expect(result).toMatchObject({
      comprehensive: "generated",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 5,
    });
  });

  it("carries a fr locale into the comprehensive and status warms instead of collapsing it", async () => {
    // The regression this pins: the warm typed its locale `de | en`, so a
    // French account's warm ran (and cached) in the wrong language — and the
    // prompt layer's output-language directive never saw `fr` to act on.
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(3);

    await forceWarmUser(prisma as never, "u1", "fr", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "fr",
      force: true,
      signal: expect.any(AbortSignal),
    });
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledWith("u1", { locale: "fr", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["fr"]);
  });

  it("skips the comprehensive when the cache was warmed within the freshness window (idempotent re-enqueue)", async () => {
    // A revalidation poll that outlives the enqueue singleton can stack
    // several force jobs; the job-start freshness re-check collapses the
    // stack into one real warm.
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, findUnique } = makePrisma([]);
    findUnique.mockResolvedValue({
      insightsCachedAt: new Date(now.getTime() - 10 * 60 * 1000),
      insightsWarmFailedAt: null,
    });
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
      now,
    });

    expect(generate).not.toHaveBeenCalled();
    // The daily cap is not consumed by a freshness skip.
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(result.comprehensive).toBe("fresh");
    // The refill-only card warm still runs (cheap cache reads).
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
  });

  it("a today warm runs past the freshness window, under the daily cap, and warms no card", async () => {
    // The weigh-in at 07:05 after the blood-pressure warm at 07:00: the
    // briefing is minutes old, and still has to read the new reading.
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, findUnique } = makePrisma([]);
    findUnique.mockResolvedValue({
      insightsCachedAt: new Date(now.getTime() - 5 * 60 * 1000),
      insightsWarmFailedAt: null,
    });
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "openai" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
      now,
      today: true,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.comprehensive).toBe("generated");
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate-daily:u1",
      FORCE_WARM_DAILY_LIMIT,
      expect.any(Number),
    );
    for (const g of statusGenerators) expect(g).not.toHaveBeenCalled();
    expect(warmGenericMetrics).not.toHaveBeenCalled();
  });

  it("a today warm stays inside the daily forced-warm cap", async () => {
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, findUnique } = makePrisma([]);
    findUnique.mockResolvedValue({
      insightsCachedAt: new Date(now.getTime() - 5 * 60 * 1000),
      insightsWarmFailedAt: null,
    });
    checkRateLimit.mockResolvedValue({ allowed: false });
    const generate = vi.fn();
    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators: [],
      warmGenericMetrics: vi.fn().mockResolvedValue(0),
      now,
      today: true,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(result.comprehensive).toBe("capped");
  });

  it("backs off after a recent failed attempt instead of re-driving the provider chain", async () => {
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, findUnique } = makePrisma([]);
    findUnique.mockResolvedValue({
      insightsCachedAt: null,
      insightsWarmFailedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
      now,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(result.comprehensive).toBe("backoff");
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
  });

  it("retries after the backoff window has elapsed and clears the marker on success", async () => {
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, findUnique, update } = makePrisma([]);
    findUnique.mockResolvedValue({
      insightsCachedAt: null,
      insightsWarmFailedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
      now,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.comprehensive).toBe("generated");
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { insightsWarmFailedAt: null },
    });
  });

  it("stamps the failure marker when the comprehensive fails so the next page-open backs off", async () => {
    const now = new Date("2026-06-10T12:00:00.000Z");
    const { prisma, update } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "all-providers-failed" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(4);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
      now,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { insightsWarmFailedAt: now },
    });
    // The per-status + generic passes still ran (decoupled sections).
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
    expect(result).toMatchObject({
      comprehensive: "failed",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 4,
    });
  });

  it("caps forced comprehensive attempts per day and still refills the cards", async () => {
    const { prisma } = makePrisma([]);
    checkRateLimit.mockResolvedValue({ allowed: false });
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate-daily:u1",
      FORCE_WARM_DAILY_LIMIT,
      expect.any(Number),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(result.comprehensive).toBe("capped");
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
  });

  it("still runs the per-status + generic warm even when the comprehensive pass skipped (no provider)", async () => {
    // v1.9.0 — the sections are decoupled. A skipped comprehensive
    // (no provider) must NOT short-circuit the per-status + generic passes:
    // each generator resolves its own provider chain and no-ops cheaply when
    // none is configured.
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: false, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result).toMatchObject({
      comprehensive: "skipped",
      assessmentsWarmed: 0,
      metricAssessmentsWarmed: 0,
    });
  });

  it("reports a timed-out comprehensive distinctly and still warms the rest", async () => {
    const { prisma, update } = makePrisma([]);
    const generate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          // Never settles within the bounded budget; the fake timers below
          // advance past it so the warm continues.
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            // v1.25.12 — above the default warm budget (~210 s = the 180 s
            // comprehensive provider budget + headroom) so the bounded budget
            // fires before this "slow" generation settles.
            260_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(3);

    vi.useFakeTimers();
    try {
      const promise = forceWarmUser(prisma as never, "u1", "de", {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      // Advance past the comprehensive budget so withTimeout fires.
      await vi.advanceTimersByTimeAsync(230_000);
      const result = await promise;

      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledTimes(1);
      }
      expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
      // A timeout counts as a failure for the backoff marker.
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { insightsWarmFailedAt: expect.any(Date) },
      });
      expect(result).toMatchObject({
        comprehensive: "timeout",
        assessmentsWarmed: 7,
        metricAssessmentsWarmed: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("short-circuits to a no-op when neither capability is available", async () => {
    capabilities = {
      briefing: unavailable("operator_disabled"),
      statusText: unavailable("operator_disabled"),
    };
    const { prisma, findUnique } = makePrisma([]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
    });

    expect(generate).not.toHaveBeenCalled();
    for (const g of statusGenerators) {
      expect(g).not.toHaveBeenCalled();
    }
    expect(result.comprehensive).toBe("skipped");
    expect(result.assessmentsWarmed).toBe(0);
    // Nothing read, nothing counted against the forced-warm bucket.
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("warms the per-status + generic caches when `briefing` is unavailable but `statusText` is available (L1)", async () => {
    // v1.9.0 — the route admits the job on the per-user status surface. An
    // unavailable briefing must not suppress the assessment cards; only the
    // comprehensive briefing belongs to the `briefing` capability.
    capabilities = { briefing: unavailable("operator_disabled") };
    const { prisma } = makePrisma([]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(2);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    // Comprehensive belongs to the `briefing` surface — skipped here.
    expect(generate).not.toHaveBeenCalled();
    // But the per-status + generic passes warm, in the caller's locale.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result).toMatchObject({
      comprehensive: "skipped",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 2,
    });
  });

  it("forces the comprehensive but warms no card when `statusText` is unavailable", async () => {
    capabilities = { statusText: unavailable("user_disabled") };
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(2);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    for (const g of statusGenerators) expect(g).not.toHaveBeenCalled();
    expect(warmGenericMetrics).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      comprehensive: "generated",
      assessmentsWarmed: 0,
      metricAssessmentsWarmed: 0,
    });
  });

  it("aborts the comprehensive on timeout so its late resolve cannot write a stale cache row (M-1)", async () => {
    // v1.9.0 race fix: `withTimeout` cannot cancel the detached generation,
    // so a comprehensive that resolves AFTER the timeout would still write
    // its cache row + timestamp. The forced path threads an AbortController;
    // on timeout it must abort, and the generation observes `signal.aborted`
    // before its cache write.
    const { prisma } = makePrisma([]);
    let observedSignal: AbortSignal | undefined;
    const generate = vi.fn().mockImplementation(
      (_userId: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = opts.signal;
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            // v1.25.12 — above the default warm budget (~210 s = the 180 s
            // comprehensive provider budget + headroom) so the bounded budget
            // fires before this "slow" generation settles.
            260_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(3);

    vi.useFakeTimers();
    try {
      const promise = forceWarmUser(prisma as never, "u1", "de", {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      await vi.advanceTimersByTimeAsync(230_000);
      const result = await promise;

      // The timeout fired and aborted the still-running generation.
      expect(observedSignal?.aborted).toBe(true);
      expect(result.comprehensive).toBe("timeout");
      // The warm passes ran and are not undone by the abandoned comprehensive.
      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledTimes(1);
      }
      expect(result.assessmentsWarmed).toBe(7);
      expect(result.metricAssessmentsWarmed).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("queue registration", () => {
  // v1.18.1 — the insight-pregenerate wiring moved out of the 2143-LOC
  // reminder-worker boot file into the status registrar. The dead-queue guard
  // follows the wiring there.
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder/register-status.ts"),
    "utf8",
  );

  it("registers the queue name in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bINSIGHT_PREGENERATE_QUEUE\b/);
  });

  it("schedules the cron in the schedules table (with retry policy)", () => {
    expect(workerSrc).toMatch(
      /\[\s*INSIGHT_PREGENERATE_QUEUE\s*,\s*INSIGHT_PREGENERATE_CRON\s*,\s*\{\s*\.\.\.insightRetryOptions\s*,\s*expireInSeconds:\s*INSIGHT_PREGENERATE_EXPIRE_SECONDS\s*,?\s*\}\s*,?\s*\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSrc).toMatch(
      /createAndWork[\s\S]{0,80}INSIGHT_PREGENERATE_QUEUE/,
    );
  });

  it("exposes a sane queue name + nightly cron", () => {
    expect(INSIGHT_PREGENERATE_QUEUE).toBe("insight-pregenerate");
    // Minute Hour … — nightly single tick.
    expect(INSIGHT_PREGENERATE_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe("comprehensiveWarmBudgetMs — warm budget scales with the response timeout (v1.25.3)", () => {
  const HEADROOM_MS = 30_000;
  const DEFAULT_MS = AI_BUDGETS.comprehensive.timeoutMs;

  it("falls back to the comprehensive surface budget + headroom for an unset value", () => {
    expect(comprehensiveWarmBudgetMs(null)).toBe(DEFAULT_MS + HEADROOM_MS);
    expect(comprehensiveWarmBudgetMs(undefined)).toBe(DEFAULT_MS + HEADROOM_MS);
    // A non-positive stored value is treated as unset.
    expect(comprehensiveWarmBudgetMs(0)).toBe(DEFAULT_MS + HEADROOM_MS);
  });

  it("scales the budget with a raised setting and stays above the old fixed 130 s cap", () => {
    // The regression: any account whose response timeout was >= ~130 s had its
    // comprehensive warm clipped by the old flat 130 s cap, never landing.
    const budget = comprehensiveWarmBudgetMs(300);
    expect(budget).toBe(300_000 + HEADROOM_MS);
    expect(budget).toBeGreaterThan(130_000);
  });

  it("clamps to an absolute ceiling that still sits above the 600 s write-time maximum", () => {
    // The 600 s max a user can configure is honoured (not clipped below it);
    // the ceiling adds the headroom so a legitimate 600 s setting fits.
    expect(comprehensiveWarmBudgetMs(600)).toBe(600_000 + HEADROOM_MS);
    // A value beyond the write-time bound can never reach here, but the clamp
    // is the structural backstop against a wedged call regardless.
    expect(comprehensiveWarmBudgetMs(100_000)).toBe(600_000 + HEADROOM_MS);
  });
});

describe("runInsightPregenerate — warm budget honours the response timeout (v1.25.3)", () => {
  it("does NOT clip a slow comprehensive for an account whose response timeout is raised past the old cap", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de", aiResponseTimeoutSeconds: 300 },
    ]);
    let observedSignal: AbortSignal | undefined;
    const generate = vi.fn().mockImplementation(
      (_userId: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = opts.signal;
          // 200 s: above the OLD fixed 130 s cap (which would have aborted it)
          // but well within the 330 s budget a 300 s setting now yields.
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            200_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    vi.useFakeTimers();
    try {
      const promise = runInsightPregenerate(prisma as never, {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      // Advance past the slow generation but below the 330 s warm budget.
      await vi.advanceTimersByTimeAsync(210_000);
      const result = await promise;

      // The generation landed instead of being clipped: counted as generated,
      // not failed, and the abort never fired.
      expect(result.generated).toBe(1);
      expect(result.failed).toBe(0);
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
