/**
 * v1.18.7 (MEDIUM-3) — daily-briefing phrasing re-roll on unchanged data.
 *
 * The content-hash gate keeps the FINDINGS byte-stable when the snapshot is
 * unchanged, but the daily-briefing PARAGRAPH is re-rolled at most once per
 * calendar day at a higher, seedless temperature so the prose reads fresh.
 * These tests pin: the re-roll fires when today's date has not been stamped,
 * it preserves every cached field except the paragraph, it is seedless +
 * higher-temperature, and it does NOT fire a second time the same day.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const invalidateUserInsights = vi.fn();

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
  invalidateUserInsights: (...a: unknown[]) => invalidateUserInsights(...a),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";
import { hashInsightSnapshot } from "../snapshot-hash";
import { compactSections } from "@/lib/ai/prompts/compact-sections";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };
const FEATURES_HASH = hashInsightSnapshot({
  features: compactSections(FEATURES as unknown as Record<string, unknown>),
  aboutMe: null,
  comparisonBaseline: "none",
  generationLocale: "de",
});

const todayKey = new Date().toISOString().slice(0, 10);

/** A cached payload carrying a real briefing paragraph + sibling findings. */
const CACHED = JSON.stringify({
  summary: "stable summary",
  dailyBriefing: {
    paragraph: "Yesterday's phrasing.",
    keyFindings: [{ headline: "BP steady", tone: "good" }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
});

describe("daily-briefing re-roll on unchanged data", () => {
  it("re-rolls only the paragraph, preserves findings, seedless + 0.6 temp", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: CACHED,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
      insightsBriefingRerollDate: null, // never re-rolled today
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({
          dailyBriefing: { paragraph: "Today's fresh phrasing." },
        }),
        tokensUsed: 50,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "rerolled", providerType: "openai" });

    // Seedless + higher temperature.
    const params = runRawCompletionWithFallback.mock.calls[0][0].params;
    expect(params.temperature).toBe(0.6);
    expect(params.seed).toBeUndefined();

    // The cache write swaps only the paragraph; findings + summary preserved.
    const write = userUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.insightsCachedText !==
        undefined,
    );
    expect(write).toBeTruthy();
    const data = (write![0] as { data: Record<string, unknown> }).data;
    const stored = JSON.parse(data.insightsCachedText as string);
    expect(stored.dailyBriefing.paragraph).toBe("Today's fresh phrasing.");
    expect(stored.dailyBriefing.keyFindings).toEqual([
      { headline: "BP steady", tone: "good" },
    ]);
    expect(stored.summary).toBe("stable summary");
    expect(data.insightsBriefingRerollDate).toBe(todayKey);
    expect(invalidateUserInsights).toHaveBeenCalledWith("u1");
  });

  it("does NOT re-roll a second time the same calendar day", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: CACHED,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
      insightsBriefingRerollDate: todayKey, // already re-rolled today
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "unchanged" });
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("falls back to a plain refresh (still stamps the day) when the re-roll JSON is unusable", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: CACHED,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
      insightsBriefingRerollDate: null,
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: "not json at all", tokensUsed: 5, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "unchanged" });
    // The day is stamped so a broken provider can't be re-driven all day.
    const write = userUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data
          .insightsBriefingRerollDate !== undefined,
    );
    expect(write).toBeTruthy();
  });
});
