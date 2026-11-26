/**
 * The background generation stores a briefing only when the card can render
 * it (#1499).
 *
 * A reply that parsed as JSON was stored as a success whatever its
 * `dailyBriefing` held; the Insights hook then ran `dailyBriefingSchema` on
 * it, dropped it without a word, and the card read "no briefing yet" after a
 * generation that had "succeeded". The reply now passes the shared reader
 * before the commit: a slip it can repair is repaired, and a briefing it
 * cannot read gets one corrective retry and then fails the generation, with
 * the failure marker recorded and nothing written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const auditCreate = vi.fn(async (..._a: unknown[]) => ({}));

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
      // the cache commit is now a privacy-mode-guarded
      // updateMany; record it on the same spy but return a matched count so the
      // guard proceeds (mode unchanged in these tests).
      updateMany: (...a: unknown[]) => {
        userUpdate(...a);
        return Promise.resolve({ count: 1 });
      },
    },
    auditLog: {
      deleteMany: vi.fn(),
      create: (...a: unknown[]) => auditCreate(...a),
    },
    // the operator's reasoning controls; an untouched instance.
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

import { dailyBriefingSchema } from "@/lib/ai/schema";
import {
  withAiJobWitness,
  type AiJobWitness,
} from "@/lib/ai/job-failure/witness";
import { openInsightsCachedText } from "@/lib/insights/cached-text-cipher";

import { generateComprehensiveInsight } from "../comprehensive-generate";

// The cached payload is sealed at rest, so its writes need a key.
vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  // No cached text / hash → always runs a full generation (no gate hit).
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedTextEncrypted: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
  });
});

/** A top level that satisfies the loose insight schema. */
const TOP = {
  summary: "Steady week.",
  classification: "gut",
  findings: [],
  correlations: [],
  recommendations: [],
  dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
  disclaimer: "Not a diagnosis.",
};

const SIGNAL = {
  metric: "weight",
  label: "Weight",
  latest: 81.4,
  latestDaysAgo: 0,
  avg7: 82,
  avg30: 82.1,
  deltaVs7: -0.6,
  deltaVs30: -0.7,
  spread30: 1.2,
  outsideNormalSwing: false,
  emergingTrend: null,
  recentAnomaly: null,
};

function reply(content: unknown) {
  return {
    result: { content: JSON.stringify(content), tokensUsed: 10, model: "m" },
    workingProvider: { providerType: "openai" },
    fallbackHops: [],
    tokensSpent: 0,
  };
}

/** Every cache write the generation made. */
function cacheWrites(): unknown[] {
  return userUpdate.mock.calls
    .map(([arg]) => (arg as { data?: Record<string, unknown> }).data ?? {})
    .filter((data) => "insightsCachedTextEncrypted" in data);
}

/** The stored payload of the one cache write. */
function storedPayload(): Record<string, unknown> {
  const writes = cacheWrites();
  expect(writes).toHaveLength(1);
  const text = openInsightsCachedText(
    writes[0] as { insightsCachedTextEncrypted: Uint8Array<ArrayBuffer> },
  );
  return JSON.parse(text as string) as Record<string, unknown>;
}

function failureMarkers(): Array<Record<string, unknown>> {
  return auditCreate.mock.calls
    .map(([arg]) => (arg as { data: { action: string; details: string } }).data)
    .filter((data) => data.action === "insights.briefing-failure")
    .map((data) => JSON.parse(data.details) as Record<string, unknown>);
}

/** A valid JSON reply whose briefing the card cannot render. */
const MALFORMED = {
  ...TOP,
  dailyBriefing: { keyFindings: "steady", signalsOfDay: [] },
};

const GOOD = {
  ...TOP,
  dailyBriefing: {
    paragraph: "Your weight held steady this week.",
    keyFindings: [],
  },
};

describe("comprehensive briefing gate", () => {
  it("records a failure and writes nothing when the briefing stays unreadable", async () => {
    runRawCompletionWithFallback.mockResolvedValue(reply(MALFORMED));

    // The nightly job runs the generation under a witness; the provider
    // answered, so without a note the AI settings card would read the night
    // as a success.
    const witness: AiJobWitness = { events: [] };
    const outcome = await withAiJobWitness(witness, () =>
      generateComprehensiveInsight("u1", { locale: "en" }),
    );

    expect(outcome).toEqual({ status: "failed", reason: "invalid-briefing" });
    expect(witness.events.at(-1)).toEqual({
      type: "code",
      capability: null,
      code: "provider_error",
      providerType: "openai",
    });
    // One corrective retry, and it names the block that missed.
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
    const retryParams = runRawCompletionWithFallback.mock.calls[1][0].params;
    expect(retryParams.messages[0].content).toContain(
      "dailyBriefing block did not match its schema",
    );
    expect(cacheWrites()).toHaveLength(0);
    expect(failureMarkers()).toEqual([
      expect.objectContaining({ reason: "invalid-briefing" }),
    ]);
  });

  it("stores the corrected reply when the retry repairs the briefing", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce(reply(MALFORMED))
      .mockResolvedValueOnce(reply(GOOD));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    const stored = storedPayload();
    expect(dailyBriefingSchema.safeParse(stored.dailyBriefing).success).toBe(
      true,
    );
    expect(failureMarkers()).toHaveLength(0);
  });

  it("repairs the slips that cost a usable briefing nothing", async () => {
    const finding = {
      tone: "info",
      headline: "Weight steady",
      detail: "Within your usual range.",
      sourceMetric: "weight",
    };
    runRawCompletionWithFallback.mockResolvedValue(
      reply({
        ...TOP,
        dailyBriefing: {
          paragraph: "Your weight held steady this week.",
          // No `delta`, an unknown metric, one row over the cap.
          signalsOfDay: [
            {
              sourceMetric: "ketones",
              tone: "info",
              headline: "Ketones steady",
              nudge: "Keep logging.",
              delta: null,
            },
            {
              sourceMetric: "weight",
              tone: "good",
              headline: "Weight steady",
              nudge: "Keep it up.",
            },
          ],
          keyFindings: Array.from({ length: 6 }, () => finding),
        },
        trendAnnotations: { weight: "Flat.", bp: "" },
      }),
    );

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    const stored = storedPayload();
    const parsed = dailyBriefingSchema.safeParse(stored.dailyBriefing);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.signalsOfDay).toEqual([
      expect.objectContaining({ sourceMetric: "weight", delta: null }),
    ]);
    expect(parsed.data?.keyFindings).toHaveLength(5);
    expect(stored.trendAnnotations).toEqual({ weight: "Flat." });
  });

  it("fails a reply without a briefing when the snapshot had signals", async () => {
    extractFeatures.mockResolvedValue({ ...FEATURES, signalsOfDay: [SIGNAL] });
    runRawCompletionWithFallback.mockResolvedValue(reply(TOP));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "failed", reason: "invalid-briefing" });
    expect(cacheWrites()).toHaveLength(0);
    expect(failureMarkers()).toEqual([
      expect.objectContaining({ reason: "invalid-briefing" }),
    ]);
  });

  it("accepts a reply without a briefing when the snapshot had no signals", async () => {
    runRawCompletionWithFallback.mockResolvedValue(reply(TOP));

    const outcome = await generateComprehensiveInsight("u1", { locale: "en" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(failureMarkers()).toHaveLength(0);
  });
});
