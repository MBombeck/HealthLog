/**
 * v1.18.7 (MEDIUM-5) — comprehensive JSON-retry robustness.
 *
 * The comprehensive path used to fail cold to `invalid-json` on a first-pass
 * parse miss. It now reuses `buildRetryCorrectionMessage` for ONE corrective
 * retry before declaring failure. These tests pin: a first-pass miss followed
 * by a valid retry succeeds; two misses fail; and a first-pass success runs
 * no retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();

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
    // v1.41 — the operator's reasoning controls; an untouched instance.
    appSettings: { findUnique: vi.fn(async () => null) },
  },
}));
// The `briefing` capability is available in these fixtures; the refusal
// path has its own test in comprehensive-generate-force.test.ts.
// The wire re-check (`aiEgressRefusal`) passes in these fixtures; its refusal
// arm has its own test in comprehensive-budget-refusal.test.ts.
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  })),
  aiCapabilityToServe: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
  resolveProvider: (...a: unknown[]) => resolveProvider(...a),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback: (...a: unknown[]) =>
    runRawCompletionWithFallback(...a),
}));
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

import { generateComprehensiveInsight } from "../comprehensive-generate";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  // No cached text / hash → always runs a full generation (no gate hit).
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
  });
});

const VALID = JSON.stringify({ dailyBriefing: { paragraph: "ok" } });

describe("comprehensive JSON-retry", () => {
  it("recovers via one corrective retry after a first-pass JSON miss", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce({
        result: {
          content: "I'm sorry, here is the data:",
          tokensUsed: 5,
          model: "m",
        },
        workingProvider: { providerType: "openai" },
        fallbackHops: [],
      })
      .mockResolvedValueOnce({
        result: { content: VALID, tokensUsed: 10, model: "m" },
        workingProvider: { providerType: "openai" },
        fallbackHops: [],
      });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
    // The retry call appends the correction to the user message.
    const retryParams = runRawCompletionWithFallback.mock.calls[1][0].params;
    expect(retryParams.messages[0].content).toContain(
      "did not satisfy the required",
    );
    // v1.41 — the generation reasons as the daily-briefing job; the JSON
    // repair does not.
    const firstParams = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(firstParams.reasoning).toEqual({
      effort: "medium",
      summaries: false,
    });
    expect(retryParams.reasoning).toBeUndefined();
  });

  it("fails with invalid-json when both attempts miss", async () => {
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: "still not json", tokensUsed: 5, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "failed", reason: "invalid-json" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it("runs no retry when the first pass is valid", async () => {
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: VALID, tokensUsed: 10, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
  });
});
