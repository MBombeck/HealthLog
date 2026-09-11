/**
 * v1.25 — the comprehensive briefing generator honours the per-user
 * `aiResponseTimeoutSeconds` setting and keeps its last good text on failure.
 *
 * Before this, every generation call hardcoded `AI_BUDGETS.comprehensive
 * .timeoutMs`, so raising the timeout for a slow self-hosted backend had no
 * effect on the briefing. These tests pin: a set value is threaded onto the
 * provider call (seconds → ms); an unset value falls back to the budget; and a
 * terminal failure writes NO cache row (last good preserved) while recording a
 * failure marker the read path can surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const recordBriefingFailure = vi.fn();

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
    auditLog: { deleteMany: vi.fn(), create: vi.fn() },
  },
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
vi.mock("@/lib/insights/briefing-failure-marker", () => ({
  recordBriefingFailure: (...a: unknown[]) => recordBriefingFailure(...a),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };
const VALID = JSON.stringify({ dailyBriefing: { paragraph: "ok" } });

function mockUser(overrides: Record<string, unknown> = {}) {
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
    aiResponseTimeoutSeconds: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  mockUser();
});

describe("comprehensive timeout honouring", () => {
  it("threads the per-user timeout (seconds → ms) onto the provider call", async () => {
    mockUser({ aiResponseTimeoutSeconds: 300 });
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: VALID, tokensUsed: 10, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    await generateComprehensiveInsight("u1", { locale: "de" });

    const params = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(params.timeoutMs).toBe(300_000);
    expect(params.timeoutMs).not.toBe(AI_BUDGETS.comprehensive.timeoutMs);
  });

  it("falls back to the comprehensive budget when the setting is unset", async () => {
    mockUser({ aiResponseTimeoutSeconds: null });
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: VALID, tokensUsed: 10, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    await generateComprehensiveInsight("u1", { locale: "de" });

    const params = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(params.timeoutMs).toBe(AI_BUDGETS.comprehensive.timeoutMs);
  });

  it("keeps the last good text and records a failure marker on a provider error", async () => {
    mockUser({ aiResponseTimeoutSeconds: 300 });
    runRawCompletionWithFallback.mockRejectedValue(new Error("boom"));

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome.status).toBe("failed");
    // No cache row written → the prior `insightsCachedText` (last good) survives.
    expect(userUpdate).not.toHaveBeenCalled();
    // A dated failure marker is recorded so the read path can surface a hint.
    expect(recordBriefingFailure).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", locale: "de" }),
    );
  });
});
