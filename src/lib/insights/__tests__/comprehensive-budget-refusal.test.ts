/**
 * The briefing generator's behaviour when the day's token ceiling refuses it.
 *
 * `briefing-provider-budget.test.ts` pins the accounting itself. This pins the
 * WIRING: that `generateComprehensiveInsight` actually routes through the
 * metered chokepoint, and that an over-cap run is reported honestly.
 *
 * Load-bearing distinction: an over-cap run is `skipped`, NOT `failed`. No
 * provider was contacted, so there is no upstream fault to retry against. The
 * morning-refresh worker enqueues its 45-minute provider-failure retry on a
 * `failed` outcome and holds the day provisional — doing that for a ceiling
 * that will not move until the ledger rolls over would be a retry loop against
 * an accounting outcome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let ledgerTotal = 0;
/** …and of `coach_usage.operator_tokens`. */
let ledgerOperator = 0;

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();
const recordBriefingFailure = vi.fn();
const hasActiveConsentForSurface = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...v: unknown[]) => {
        // (userId, dateKey, reserved, operatorReserved, …).
        ledgerTotal += Number(v[2] ?? 0);
        ledgerOperator += Number(v[3] ?? 0);
        return [{ total_tokens: ledgerTotal, operator_tokens: ledgerOperator }];
      },
    ),
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const sql = strings.join("?");
        const amount = Number(v[0] ?? 0);
        // The operator-funded share moves in the same statement.
        const operatorAmount = Number(v[1] ?? 0);
        if (sql.includes("total_tokens + ")) {
          ledgerTotal += amount;
          ledgerOperator += operatorAmount;
        } else if (sql.includes("total_tokens - ")) {
          ledgerTotal -= amount;
          ledgerOperator -= operatorAmount;
        }
        ledgerTotal = Math.max(0, ledgerTotal);
        ledgerOperator = Math.max(0, ledgerOperator);
        return 1;
      },
    ),
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
vi.mock("@/lib/insights/briefing-failure-marker", () => ({
  recordBriefingFailure: (...a: unknown[]) => recordBriefingFailure(...a),
  readBriefingFailure: vi.fn(async () => null),
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
// Modelled truthfully rather than stubbed open: only an operator-credential
// chain needs a receipt, which is what lets the consent-ordering test below
// assert the real gate rather than a bypass.
vi.mock("@/lib/ai/consent-guard", () => ({
  chainRequiresServerManagedConsent: (chain: { providerType: string }[] = []) =>
    chain.some((c) => c.providerType.startsWith("admin-")),
  hasActiveConsentForSurface: (...a: unknown[]) =>
    hasActiveConsentForSurface(...a),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";
import { OPERATOR_COST_CAP, USER_PLAN_CAP } from "@/lib/ai/coach/budget";

const VALID = JSON.stringify({ dailyBriefing: { paragraph: "ok" } });

beforeEach(() => {
  vi.clearAllMocks();
  ledgerTotal = 0;
  ledgerOperator = 0;
  resolveProviderChain.mockResolvedValue([
    { providerType: "admin-openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue({
    weight: { count: 12, latest: 81.4, mean30: 82.1 },
  });
  userUpdate.mockResolvedValue({});
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
  });
  hasActiveConsentForSurface.mockResolvedValue(true);
  runRawCompletionWithFallback.mockResolvedValue({
    result: { content: VALID, tokensUsed: 900, model: "m" },
    workingProvider: { providerType: "admin-openai" },
    fallbackHops: [],
  });
});

describe("generateComprehensiveInsight — daily token ceiling", () => {
  it("lands the briefing's spend on the ledger", async () => {
    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome.status).toBe("generated");
    // The whole point: this path used to spend invisibly.
    expect(ledgerTotal).toBe(900);
  });

  it("refuses over-cap as `skipped: budget` without contacting a provider", async () => {
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "skipped", reason: "budget" });
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    // Not a provider failure: no marker, so the read path never claims the
    // refresh broke, and the morning-refresh worker does not enqueue its
    // provider-failure retry against a ceiling.
    expect(recordBriefingFailure).not.toHaveBeenCalled();
    // No cache row written, so the last good briefing stays intact.
    expect(userUpdate).not.toHaveBeenCalled();
    expect(ledgerTotal).toBe(OPERATOR_COST_CAP);
  });

  it("serves a BYOK account at the same spend that refuses an operator-key one", async () => {
    // A self-hoster on their own key pays their own bill; the operator's
    // ceiling is a category error for them.
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome.status).toBe("generated");
    expect(runRawCompletionWithFallback).toHaveBeenCalled();
  });

  it("still bounds a BYOK account at the user-plan ceiling", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    ledgerTotal = USER_PLAN_CAP;
    ledgerOperator = USER_PLAN_CAP;

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "skipped", reason: "budget" });
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("refunds in full when the provider fails, leaving no estimate parked", async () => {
    runRawCompletionWithFallback.mockRejectedValue(new Error("upstream down"));

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome.status).toBe("failed");
    expect(ledgerTotal).toBe(0);
  });

  it("never charges a consent-blocked user", async () => {
    // Ordering guarantee: the reservation lands AFTER the consent gate.
    // Reserving first would bill an operator-key user for a snapshot that is
    // never sent anywhere, and could lock them out of a tier they are not
    // even permitted to use.
    hasActiveConsentForSurface.mockResolvedValue(false);

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "skipped", reason: "no-consent" });
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(ledgerTotal).toBe(0);
  });

  it("charges the JSON-shape retry as its own generation", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce({
        result: { content: "not json", tokensUsed: 400, model: "m" },
        workingProvider: { providerType: "admin-openai" },
        fallbackHops: [],
      })
      .mockResolvedValueOnce({
        result: { content: VALID, tokensUsed: 900, model: "m" },
        workingProvider: { providerType: "admin-openai" },
        fallbackHops: [],
      });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome.status).toBe("generated");
    // Both passes billed. A retry that rode the first reservation would let a
    // user at the ceiling generate for free.
    expect(ledgerTotal).toBe(1300);
  });
});
