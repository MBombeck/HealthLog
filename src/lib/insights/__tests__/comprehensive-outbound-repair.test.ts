/**
 * v1.42 — one bounded repair after the outbound safety screen withholds a
 * generated briefing.
 *
 * A screened generation used to fail outright, and the nightly pass then
 * queued its 45-minute provider retry, which asked the same model the same
 * question and was screened again (eight times a night on one account). Now
 * the generator asks once more with the broken contract named, and persists
 * the repair only when it passes the same parse, grounding and screen as a
 * first pass. These tests pin the repair, its correction text, and that a
 * repair which is screened again still persists nothing.
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
  // A once-queued reply must not leak from one case into the next.
  runRawCompletionWithFallback.mockReset();
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

const CAUSAL = JSON.stringify({
  summary: "Your weight fell because you slept more.",
  dailyBriefing: { paragraph: "ok" },
});
const CLEAN = JSON.stringify({
  summary: "Your weight was lower on days when you slept longer.",
  dailyBriefing: { paragraph: "ok" },
});

function reply(content: string) {
  return {
    result: { content, tokensUsed: 10, model: "m" },
    workingProvider: { providerType: "openai" },
    fallbackHops: [],
  };
}

describe("comprehensive outbound-screen repair", () => {
  it("persists a repair that passes the screen, after one corrective call", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(reply(CAUSAL))
      .mockResolvedValueOnce(reply(CLEAN));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
    const repairPrompt =
      runRawCompletionWithFallback.mock.calls[1][0].params.messages[0].content;
    expect(repairPrompt).toContain("withheld by the safety screen");
    expect(repairPrompt).toContain("CAUSES");
    // The repaired text is what lands in the cache, never the screened one.
    const written = JSON.stringify(userUpdate.mock.calls.at(-1));
    expect(written).toContain("on days when you slept longer");
    expect(written).not.toContain("because you slept more");
  });

  it("stays withheld when the repair is screened again, and asks only once", async () => {
    runRawCompletionWithFallback.mockResolvedValue(reply(CAUSAL));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "failed", reason: "outbound-screened" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it("stays withheld when the repair call itself fails", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(reply(CAUSAL))
      .mockRejectedValueOnce(new Error("upstream down"));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "failed", reason: "outbound-screened" });
  });
});
