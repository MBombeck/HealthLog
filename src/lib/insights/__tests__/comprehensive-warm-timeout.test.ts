/**
 * v1.21.5 — comprehensive briefing warm-path robustness.
 *
 * Two guarantees, both regressions that left the daily briefing (and the
 * insights trend narrative that reads the same cached block) permanently
 * blank for a large account on a reasoning provider:
 *
 *   1. The generation call carries the wider per-surface upstream timeout
 *      (`AI_BUDGETS.comprehensive.timeoutMs`), so a reasoning-heavy single
 *      turn is no longer aborted at the client's 60 s default mid-stream.
 *   2. A provider failure does NOT silently persist an empty block: no cache
 *      row is written, and the failure is surfaced as a queryable wide-event
 *      annotation rather than swallowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const annotate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    // The briefing path now reserves against the day's token ledger before
    // egress and reconciles after (`reserveBudget` / `reconcileSpend`), both
    // over raw SQL. A zero prior total keeps every generation under the cap,
    // so these suites keep testing what they were written to test.
    $queryRaw: vi.fn(async () => [{ total_tokens: 0, operator_tokens: 0 }]),
    $executeRaw: vi.fn(async () => 0),
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      // v1.32.22 (M6) — the cache commit is now a privacy-mode-guarded
      // updateMany; record it on the same spy but return a matched count so the
      // guard proceeds (mode unchanged in these tests).
      updateMany: (...a: unknown[]) => {
        userUpdate(...a);
        return Promise.resolve({ count: 1 });
      },
    },
    auditLog: { deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
  resolveProvider: (...a: unknown[]) => resolveProvider(...a),
}));
vi.mock("@/lib/ai/provider-runner", () => {
  // Defined inside the factory: the mock is hoisted above the module body, so
  // a top-level class reference would hit the temporal dead zone.
  class AllProvidersFailedError extends Error {
    constructor() {
      super("All providers failed");
      this.name = "AllProvidersFailedError";
    }
  }
  return {
    AllProvidersFailedError,
    runRawCompletionWithFallback: (...a: unknown[]) =>
      runRawCompletionWithFallback(...a),
  };
});
vi.mock("@/lib/insights/features", () => ({
  FeaturesPayloadTooLargeError: class extends Error {
    sizeBytes = 0;
  },
  extractFeatures: (...a: unknown[]) => extractFeatures(...a),
  BRIEFING_FEATURE_WINDOW_DAYS: 400,
}));
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn().mockResolvedValue(null),
  buildBriefingIllnessCyclePrompt: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/insights/glp1-plateau", () => ({
  detectGlp1Plateau: vi.fn(async () => null),
  buildGlp1PlateauPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: (...a: unknown[]) => annotate(...a),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };
const VALID = JSON.stringify({ dailyBriefing: { paragraph: "ok" } });

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "codex", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
  });
});

describe("comprehensive warm-path timeout + failure observability", () => {
  it("threads the wider comprehensive timeout onto the provider call", async () => {
    // The budget must carry an override above the 60 s client default.
    expect(AI_BUDGETS.comprehensive.timeoutMs).toBeGreaterThan(60_000);

    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: VALID, tokensUsed: 10, model: "m" },
      workingProvider: { providerType: "codex" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "codex" });
    const params = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(params.timeoutMs).toBe(AI_BUDGETS.comprehensive.timeoutMs);
  });

  it("does not silently persist an empty block when every provider fails", async () => {
    // The mocked class ignores the argument; `[]` satisfies the real type.
    runRawCompletionWithFallback.mockRejectedValue(
      new AllProvidersFailedError([]),
    );

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "failed",
      reason: "all-providers-failed",
    });
    // No cache write — the briefing block is never persisted empty, so the
    // next warm / visit retries instead of serving a permanent blank.
    expect(userUpdate).not.toHaveBeenCalled();
    // The failure is queryable, not swallowed.
    const failAnnotation = annotate.mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "insights.generate.comprehensive_failed",
    );
    expect(failAnnotation).toBeDefined();
    expect(
      (failAnnotation![0] as { meta?: { reason?: string } }).meta?.reason,
    ).toBe("all-providers-failed");
  });
});
