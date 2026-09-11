/**
 * A comprehensive generation must never overwrite a cache after its
 * prompt-affecting scope has changed in flight.
 *
 * The guarded `updateMany` keys on `insightsPrivacyMode`, `insightsExcludeMetrics`,
 * `gender`, and `displayName` — the exact User columns this generation's
 * prompt was built from — rather than the broad `updatedAt` timestamp. A
 * zero-row result therefore proves a genuine change to one of THOSE columns;
 * an unrelated User write (e.g. `resolveProviderChain()`'s OAuth
 * token-refresh update) still advances `updatedAt` but can never collide
 * with this guard, since it touches none of the guarded columns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const invalidateUserInsights = vi.fn();
const annotate = vi.fn();
const getSelfContextTextForUser = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ total_tokens: 0, operator_tokens: 0 }]),
    $executeRaw: vi.fn(async () => 0),
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      // Controllable per test: `{ count: 0 }` emulates any User scope/version
      // change advancing the guarded token since the generation read it.
      updateMany: (...a: unknown[]) => userUpdateMany(...a),
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
  getSelfContextTextForUser: (...a: unknown[]) =>
    getSelfContextTextForUser(...a),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: (...a: unknown[]) => invalidateUserInsights(...a),
}));
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: (...a: unknown[]) => annotate(...a) };
});

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

const CACHED_WITH_BRIEFING = JSON.stringify({
  summary: "stable summary",
  dailyBriefing: {
    paragraph: "Yesterday's phrasing.",
    keyFindings: [{ headline: "BP steady", tone: "good" }],
  },
});

function annotatedScopeChange(): boolean {
  return annotate.mock.calls.some(([entry]) => {
    if (typeof entry !== "object" || entry === null || !("action" in entry)) {
      return false;
    }
    const action = entry.action;
    return (
      typeof action === "object" &&
      action !== null &&
      "name" in action &&
      action.name === "insights.generate.scope_changed"
    );
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
  getSelfContextTextForUser.mockResolvedValue(null);
});

describe("generateComprehensiveInsight — scope/version commit guard", () => {
  it("main commit: a token miss returns generic scope-changed, never a privacy-specific claim", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: "0".repeat(64), // changed → full generation
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
    // Some User update landed: the guarded commit matches zero rows.
    userUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "scope-changed",
    });
    // The generation reached the commit (provider was called) …
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // … the commit was the guarded update, keyed on the mode read …
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    const where = userUpdateMany.mock.calls[0][0].where as {
      insightsPrivacyMode: string;
    };
    expect(where.insightsPrivacyMode).toBe("aggregated");
    // … and it did NOT fall back to an unconditional write.
    expect(userUpdate).not.toHaveBeenCalled();
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotatedScopeChange()).toBe(true);
  });

  it("main commit: an unrelated User update (e.g. resolveProviderChain's token refresh) does not discard the generation", async () => {
    // Simulates the real-world race the guard must tolerate: between the
    // `dbUser` read and this commit, `resolveProviderChain()` refreshed an
    // OAuth token via `prisma.user.update`, which bumps `updatedAt` but
    // touches none of the prompt-scope columns. The guard must still commit.
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: ["sleep"],
      insightsSnapshotHash: "0".repeat(64),
      gender: "FEMALE",
      displayName: "Sam",
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
    // The real DB returns count: 1 here too, since the guarded predicate
    // never references `updatedAt` — the credential-refresh write cannot
    // make it miss.
    userUpdateMany.mockResolvedValue({ count: 1 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    const where = userUpdateMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where).not.toHaveProperty("updatedAt");
    expect(where).toMatchObject({
      insightsPrivacyMode: "aggregated",
      insightsExcludeMetrics: { equals: ["sleep"] },
      gender: "FEMALE",
      displayName: "Sam",
    });
    expect(invalidateUserInsights).toHaveBeenCalledWith("u1");
    expect(annotatedScopeChange()).toBe(false);
  });

  it("main commit: a genuine exclude-list / gender / display-name change mid-generation still discards", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: ["sleep"],
      insightsSnapshotHash: "0".repeat(64),
      gender: "FEMALE",
      displayName: "Sam",
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
    // Simulates a genuine concurrent settings/profile change (exclude list,
    // gender, or display name edited) between the read above and the
    // commit: the exact-field predicate now matches zero rows.
    userUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "skipped", reason: "scope-changed" });
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          insightsPrivacyMode: "aggregated",
          insightsExcludeMetrics: { equals: ["sleep"] },
          gender: "FEMALE",
          displayName: "Sam",
        }),
      }),
    );
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotatedScopeChange()).toBe(true);
  });

  it("main commit: refuses content built before the profile scope changed", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({ dailyBriefing: { p: "old" } }),
      insightsExcludeMetrics: [],
      insightsSnapshotHash: "0".repeat(64),
    });
    getSelfContextTextForUser
      .mockResolvedValueOnce("Chronic conditions: Asthma")
      .mockResolvedValueOnce(null);
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
    userUpdateMany.mockResolvedValue({ count: 1 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "profile-scope-changed",
    });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "insights.generate.profile_scope_changed" },
      }),
    );
  });

  it("reroll arm: a stale scope/version token refuses the paragraph write too", async () => {
    findUnique.mockResolvedValue({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      insightsCachedText: CACHED_WITH_BRIEFING,
      insightsExcludeMetrics: [],
      insightsSnapshotHash: FEATURES_HASH, // unchanged → reroll path
      insightsBriefingRerollDate: null,
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
    userUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({
      status: "skipped",
      reason: "scope-changed",
    });
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    expect(invalidateUserInsights).not.toHaveBeenCalled();
    expect(annotatedScopeChange()).toBe(true);
    // Not marked as a used-today reroll, since nothing committed.
    expect(todayKey).toBe(new Date().toISOString().slice(0, 10));
  });
});
