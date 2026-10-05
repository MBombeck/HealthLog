/**
 * v1.7.0 — `force` bypasses the 24 h cache short-circuit.
 *
 * The nightly pre-generate cron discovers users on a 20 h window but
 * the generator's cache TTL is 24 h. Without `force` a user whose cache
 * is 20-24 h old short-circuits to `{status:"cached"}` and the cron's
 * budget bucket is wasted with no actual regeneration. These tests pin
 * that `force: true` skips the TTL re-check (and `force: false` still
 * honours a fresh cache).
 *
 * v1.16.8 — the content-hash gate sits behind the force flag: even a
 * forced generation skips the provider call (and only refreshes the
 * cache timestamp) when the compacted feature snapshot is unchanged
 * since the cached text was generated. These tests pin the skip, the
 * timestamp-only refresh, and that a changed snapshot still generates
 * and stores the new fingerprint without the old per-status eviction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const auditDeleteMany = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const aiCapabilityForRecord = vi.fn();

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
    auditLog: {
      deleteMany: (...a: unknown[]) => auditDeleteMany(...a),
    },
  },
}));
// The wire re-check (`aiEgressRefusal`) passes in these fixtures; its refusal
// arm has its own test in comprehensive-budget-refusal.test.ts.
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: (...a: unknown[]) => aiCapabilityForRecord(...a),
  aiCapabilityToServe: (...args: unknown[]) =>
    (aiCapabilityForRecord as (...a: unknown[]) => unknown)(...args),
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
// The post-gate prompt assembly reads GLP-1 + about-me context from the
// DB; stub both so the changed-hash path stays DB-free in this test.
vi.mock("@/lib/insights/glp1-plateau", () => ({
  detectGlp1Plateau: vi.fn(async () => null),
  buildGlp1PlateauPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";
import { hashInsightSnapshot } from "../snapshot-hash";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { featuresInReaderUnits } from "../features-units";
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";

/** A small data-bearing feature set that survives `compactSections`. */
const FEATURES = {
  weight: { count: 12, latest: 81.4, mean30: 82.1 },
};
// The fingerprint covers the compacted features, the about-me text
// (null here — the about-me module is mocked to no text), the
// comparison-baseline setting ("none" — the mocked user row carries no
// dashboardWidgetsJson) and the generation locale, matching the
// composite shape both the gate and the POST route hash. The features are
// hashed as the prompt reads them: in the reader's units (the mocked user
// row carries no preference, so the defaults).
const FEATURES_HASH = hashInsightSnapshot({
  features: compactSections(
    featuresInReaderUnits(
      FEATURES as never,
      DEFAULT_UNIT_PREFERENCES,
    ) as unknown as Record<string, unknown>,
  ),
  aboutMe: null,
  comparisonBaseline: "none",
  generationLocale: "de",
});

beforeEach(() => {
  vi.clearAllMocks();
  // No provider configured → the function returns `skipped` once it gets
  // past the cache short-circuit, which is enough to prove the branch.
  resolveProviderChain.mockResolvedValue([]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  aiCapabilityForRecord.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

describe("generateComprehensiveInsight — the briefing capability at the wire", () => {
  const STALE_USER = {
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
  };

  it.each([
    ["no_provider", "no-provider"],
    ["consent_required", "no-consent"],
    ["user_disabled", "unavailable"],
    ["operator_disabled", "unavailable"],
  ] as const)(
    "skips with %s → %s and never resolves the chain",
    async (reason, skipped) => {
      findUnique.mockResolvedValue(STALE_USER);
      aiCapabilityForRecord.mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: false,
      });

      const outcome = await generateComprehensiveInsight("u1", {
        locale: "de",
        force: true,
      });

      expect(outcome).toEqual({ status: "skipped", reason: skipped });
      expect(aiCapabilityForRecord).toHaveBeenCalledWith("u1", "briefing");
      expect(resolveProviderChain).not.toHaveBeenCalled();
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
      expect(extractFeatures).not.toHaveBeenCalled();
    },
  );

  it("still serves a fresh cache without asking the capability (cache short-circuit comes first)", async () => {
    findUnique.mockResolvedValue({
      ...STALE_USER,
      insightsCachedAt: new Date(Date.now() - 60 * 60 * 1000),
      insightsCachedText: "{}",
    });
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "user_disabled",
      onDeviceAllowed: false,
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "cached" });
    expect(aiCapabilityForRecord).not.toHaveBeenCalled();
  });
});

describe("generateComprehensiveInsight — cache short-circuit", () => {
  it("returns `cached` for a fresh (<24h) cache when not forced", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
      insightsCachedText: "{}",
      insightsExcludeMetrics: [],
      insightsSnapshotHash: null,
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
    });

    expect(outcome).toEqual({ status: "cached" });
    // Never reached the provider chain.
    expect(resolveProviderChain).not.toHaveBeenCalled();
  });

  it("bypasses the 24h cache when `force` is set (proceeds past the short-circuit)", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      // 21h old — inside the 24h TTL, so the un-forced path would cache.
      insightsCachedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
      insightsCachedText: "{}",
      insightsExcludeMetrics: [],
      insightsSnapshotHash: null,
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    // Forced past the cache → provider chain resolved → no provider →
    // skipped (NOT cached). The key assertion is that it did not
    // short-circuit on the fresh cache.
    expect(resolveProviderChain).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "skipped", reason: "no-provider" });
  });
});

describe("generateComprehensiveInsight — content-hash gate (v1.16.8)", () => {
  function makeByokChain() {
    // A BYOK chain never trips the server-managed consent gate.
    resolveProviderChain.mockResolvedValue([
      { providerType: "openai", instance: {} },
    ]);
  }

  it("skips the provider and refreshes only the timestamp when the snapshot is unchanged — even when forced", async () => {
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    expect(outcome).toEqual({ status: "unchanged" });
    // No completion ran.
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    // Timestamp-only refresh: no new text, no new hash, no eviction.
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const args = userUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.insightsCachedAt).toEqual(expect.any(Date));
    expect(args.data).not.toHaveProperty("insightsCachedText");
    expect(args.data).not.toHaveProperty("insightsSnapshotHash");
    expect(auditDeleteMany).not.toHaveBeenCalled();
  });

  it("generates when the snapshot hash differs, stores the new fingerprint, and runs no per-status eviction", async () => {
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      // Stored fingerprint from an older data state.
      insightsSnapshotHash: "0".repeat(64),
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // Find the cache write among the user updates.
    const write = userUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.insightsCachedText !==
        undefined,
    );
    expect(write).toBeTruthy();
    const data = (write![0] as { data: Record<string, unknown> }).data;
    expect(data.insightsSnapshotHash).toBe(FEATURES_HASH);
    // The cache row records the language it was generated in.
    expect(data.insightsCachedLocale).toBe("de");
    // New text carries the moment it was generated, which the "is this
    // briefing from today" check reads instead of insightsCachedAt.
    const stored = JSON.parse(data.insightsCachedText as string);
    expect(Date.parse(stored.briefingGeneratedAt)).toBeGreaterThan(
      Date.now() - 60_000,
    );
    // v1.16.8 — the blanket per-status eviction is gone.
    expect(auditDeleteMany).not.toHaveBeenCalled();
  });

  it("hands the model the feature set in the reader's units and fingerprints that", async () => {
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
      unitPreference: "imperial",
      glucoseUnit: "mmol/L",
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    // The kilogram fingerprint no longer matches: a unit switch regenerates.
    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });
    expect(outcome).toEqual({ status: "generated", providerType: "openai" });

    const prompt = JSON.stringify(runRawCompletionWithFallback.mock.calls[0]);
    expect(prompt).toContain('\\"unit\\": \\"lb\\"');
    expect(prompt).toContain("179.5");
    expect(prompt).not.toContain("81.4");

    const write = userUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.insightsCachedText !==
        undefined,
    );
    const data = (write![0] as { data: Record<string, unknown> }).data;
    expect(data.insightsSnapshotHash).toBe(
      hashInsightSnapshot({
        features: compactSections(
          featuresInReaderUnits(FEATURES as never, {
            system: "imperial",
            glucoseUnit: "mmol/L",
          }) as unknown as Record<string, unknown>,
        ),
        aboutMe: null,
        comparisonBaseline: "none",
        generationLocale: "de",
      }),
    );
  });

  it("a fresh cache tagged with another language does not short-circuit an unforced run", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "english" } }),
      insightsCachedLocale: "en",
      insightsExcludeMetrics: [],
      insightsSnapshotHash: null,
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
    });

    // Past the short-circuit → provider chain resolved → no provider.
    expect(resolveProviderChain).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "skipped", reason: "no-provider" });
  });

  it("generates when no fingerprint is stored yet (first run after the gate shipped)", async () => {
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: null,
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("regenerates when the hash matches but the cached payload carries NO briefing (v1.28.30)", async () => {
    // A grounding-stripped (or model-omitted) briefing left a briefingless
    // payload WITH a stored hash: on unchanged data every warm re-stamped
    // the timestamp and the briefing never came back. A briefingless cache
    // must not satisfy the unchanged gate.
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({
        dailyBriefing: null,
        recommendations: [],
      }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "recovered" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // A real cache write happened (not a timestamp-only refresh).
    const write = userUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.insightsCachedText !==
        undefined,
    );
    expect(write).toBeTruthy();
  });

  it("does not treat a matching hash as unchanged when there is no cached text to serve", async () => {
    makeByokChain();
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH,
    });
    runRawCompletionWithFallback.mockResolvedValue({
      result: {
        content: JSON.stringify({ dailyBriefing: { p: "new" } }),
        tokensUsed: 10,
        providerType: "openai",
        model: "m",
      },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", {
      locale: "de",
      force: true,
    });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
  });
});
