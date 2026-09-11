/**
 * Daily-briefing grounding gate — what stands in place of a rejected briefing.
 *
 * The gate itself is absolute: a briefing carrying a number the server never
 * computed is discarded, always. These tests pin the DISPOSAL, which used to
 * fork on why the corrective retry failed — a transport failure fell back to
 * the previous cached briefing, a content failure left a hole and the reader
 * lost the paragraph, signals, findings and recommendations over one figure.
 * Both paths now fall back, and the hard strip survives only when there is
 * genuinely no previous briefing to show.
 *
 * They also pin the widened allow-set: the prompt hands the model the WHOLE
 * features object, so a figure from any block in it (here a medication
 * compliance rate) is grounded — while an invented number still is not.
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
  invalidateUserInsights: vi.fn(),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";

/**
 * A signals block (so the gate engages at all) plus a medications block. The
 * medication figures are server-computed and reach the prompt, but the old
 * hand-maintained allow-set never admitted them.
 */
const FEATURES = {
  signalsOfDay: [
    {
      sourceMetric: "weight",
      latest: 81.4,
      avg7: 82,
      avg30: 82.1,
      deltaVs7: -0.6,
      deltaVs30: -0.7,
      spread30: 1.2,
      recentAnomaly: null,
    },
  ],
  medications: [
    {
      name: "Ramipril",
      dose: "5 mg",
      category: "cardio",
      compliance7: 100,
      compliance30: 86,
      compliance90: 88,
      streak: 12,
      missedLast7: 0,
    },
  ],
};

/** A number that appears nowhere in the features payload. */
const FABRICATED = JSON.stringify({
  dailyBriefing: { paragraph: "Your weight is down 47.9 kg this week." },
});

/** Cites the medication compliance rate the server itself computed. */
const GROUNDED_VIA_MEDS = JSON.stringify({
  dailyBriefing: { paragraph: "Adherence sits at 86 % over the last 30 days." },
});

const PREVIOUS_PAYLOAD = JSON.stringify({
  dailyBriefing: { paragraph: "Yesterday's grounded briefing." },
  recommendations: [],
});

function cachedUser(over: Record<string, unknown> = {}) {
  return {
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    // Never equal to the freshly computed hash, so a full generation runs.
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
    ...over,
  };
}

function completion(content: string) {
  return {
    result: { content, tokensUsed: 10, model: "m" },
    workingProvider: { providerType: "openai" },
    fallbackHops: [],
  };
}

/** The `dailyBriefing` the generation persisted. */
function persistedBriefing(): unknown {
  const call = userUpdate.mock.calls.at(-1);
  const text = call?.[0]?.data?.insightsCachedText as string | undefined;
  if (!text) return undefined;
  return (JSON.parse(text) as Record<string, unknown>).dailyBriefing;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  findUnique.mockResolvedValue(cachedUser());
});

describe("briefing grounding — disposal", () => {
  it("keeps the previous briefing when the corrective retry fails on CONTENT", async () => {
    findUnique.mockResolvedValue(
      cachedUser({
        insightsCachedAt: new Date("2026-07-15T03:00:00.000Z"),
        insightsCachedText: PREVIOUS_PAYLOAD,
      }),
    );
    // Both passes carry the same fabricated figure: a content failure.
    runRawCompletionWithFallback.mockResolvedValue(completion(FABRICATED));

    await generateComprehensiveInsight("u1", { locale: "en" });

    // The fabricated text never persists...
    expect(JSON.stringify(persistedBriefing())).not.toContain("47.9");
    // ...and the reader keeps yesterday's grounded briefing rather than a hole.
    expect(persistedBriefing()).toEqual({
      paragraph: "Yesterday's grounded briefing.",
    });
  });

  it("still strips hard when there is no previous briefing to stand in", async () => {
    runRawCompletionWithFallback.mockResolvedValue(completion(FABRICATED));

    await generateComprehensiveInsight("u1", { locale: "en" });

    expect(persistedBriefing()).toBeNull();
  });

  it("admits a figure from a features block the old allow-set never listed", async () => {
    runRawCompletionWithFallback.mockResolvedValue(
      completion(GROUNDED_VIA_MEDS),
    );

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    // No corrective retry: the compliance rate is grounded, so the gate is
    // satisfied on the first pass and the briefing survives intact.
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(persistedBriefing()).toEqual({
      paragraph: "Adherence sits at 86 % over the last 30 days.",
    });
  });
});
