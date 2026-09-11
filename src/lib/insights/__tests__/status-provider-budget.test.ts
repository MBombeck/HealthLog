/**
 * Cost accounting for the status/reference provider chokepoint.
 *
 * `runStatusCompletion` is the single provider entry for every status and
 * reference generator — the specialised status cards, the generic metric
 * cards, biomarker cards, the batched assessment, the derived scores, the
 * period narrative, and the off-request Coach memory workers. It previously
 * ran with NO budget accounting whatsoever: nothing reserved, nothing
 * recorded, no ceiling. Everything behind it spent invisibly, and on an
 * operator-key account that was unmetered operator spend.
 *
 * These tests drive the REAL budget module (`reserveBudget` / `reconcileSpend`
 * / `resolveDailyCap`) against a stateful in-memory stand-in for the
 * `coach_usage` row, so they exercise the actual atomic-upsert path rather
 * than merely asserting that a mock was called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** In-memory stand-in for the day's `coach_usage.total_tokens`. */
let ledgerTotal = 0;
/** …and of `coach_usage.operator_tokens`. */
let ledgerOperator = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    // `reserveBudget`'s atomic upsert-increment. Tagged-template call shape:
    // (strings, userId, dateKey, reserved, reserved).
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...v: unknown[]) => {
        // (userId, dateKey, reserved, operatorReserved, …).
        ledgerTotal += Number(v[2] ?? 0);
        ledgerOperator += Number(v[3] ?? 0);
        return [{ total_tokens: ledgerTotal, operator_tokens: ledgerOperator }];
      },
    ),
    // `reconcileSpend` (+delta) and `refundReservation` (-reserved).
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
      findUnique: vi.fn(async () => ({ aiResponseTimeoutSeconds: null })),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const { resolveProviderChain, resolveProvider } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({ resolveProviderChain, resolveProvider }));

const { runRawCompletionWithFallback } = vi.hoisted(() => ({
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback,
}));

// Consent gate is exercised by its own suite; keep it open here so the budget
// behaviour is what these tests isolate.
vi.mock("@/lib/ai/consent-guard", () => ({
  chainRequiresServerManagedConsent: vi.fn(() => false),
  hasActiveConsentForSurface: vi.fn(async () => true),
}));

import { runStatusCompletion } from "../status-provider";
import { annotate } from "@/lib/logging/context";
import { OPERATOR_COST_CAP, USER_PLAN_CAP } from "@/lib/ai/coach/budget";

const OPERATOR_CHAIN = [{ providerType: "admin-openai", instance: {} }];
const BYOK_CHAIN = [{ providerType: "anthropic", instance: {} }];

function completionArgs(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    cacheAction: "status:test",
    systemPrompt: "system",
    userPrompt: "user",
    consentSurface: "insights" as const,
    ...overrides,
  };
}

/** A successful provider reply reporting `tokensUsed`. */
function mockProviderReply(tokensUsed: number | null) {
  runRawCompletionWithFallback.mockResolvedValue({
    result: { content: '{"summary":"ok"}', model: "m", tokensUsed },
    workingProvider: { providerType: "admin-openai" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerTotal = 0;
  ledgerOperator = 0;
  resolveProviderChain.mockResolvedValue(OPERATOR_CHAIN);
  resolveProvider.mockResolvedValue({ type: "none" });
});

describe("runStatusCompletion — ledger accounting", () => {
  it("lands a successful generation on the day's ledger", async () => {
    mockProviderReply(1234);

    const result = await runStatusCompletion(completionArgs());

    expect(result.kind).toBe("ok");
    // Reserved an estimate, then reconciled down to what the provider
    // actually reported. Either way the spend is now ON the ledger — before
    // this wiring existed the total stayed at zero forever.
    expect(ledgerTotal).toBe(1234);
  });

  it("refuses a background generation that would eat the reserve while the chat still runs", async () => {
    // The automatic status/reference generators must stop while the interactive
    // reserve is still whole, so the chat has a day left when the jobs have had
    // theirs. One token past the point where only the reserve remains:
    ledgerTotal = 160_001;
    ledgerOperator = 160_001;
    mockProviderReply(500);

    const result = await runStatusCompletion(completionArgs());

    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(result.kind).toBe("error");

    // The same spend, reserved by the interactive coach ceiling, is admitted.
    const { reserveBudget, resolveDailyCap, resolveCostOwner } =
      await import("@/lib/ai/coach/budget");
    const chatChain = [{ providerType: "admin-openai" as const }];
    const chat = await reserveBudget(
      "u1",
      3_000,
      "2026-09-11",
      resolveDailyCap(chatChain),
      resolveCostOwner(chatChain),
      "coach",
    );
    expect(chat.allowed).toBe(true);
  });

  it("charges the reservation when the provider reports no token count", async () => {
    mockProviderReply(null);

    await runStatusCompletion(completionArgs());

    // An unreported generation must not bill as free.
    expect(ledgerTotal).toBeGreaterThan(0);
  });

  it("refuses a generation once the day's cap is already spent", async () => {
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    mockProviderReply(500);

    const result = await runStatusCompletion(completionArgs());

    // Refused BEFORE any provider egress, and reported as a transient miss
    // (`error`) rather than `none` — callers cache `none` as the settled
    // "no provider configured" assessment, which a budget refusal is not.
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(result.kind).toBe("error");
    // v1.38.19 — the refusal has to SAY which ceiling it
    // hit and whose. `{ totalAfter }` alone was the day's mixed total, which on
    // an operator refusal is not the counter that tripped; and the shared
    // `error` outcome cannot distinguish an exhausted background share from a
    // dead provider, so the annotation is the only place that can.
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "insights.status.budget_exceeded" },
        meta: expect.objectContaining({
          owner: "operator",
          surface: "job",
          limit: "owner-cap",
          cap: 160_000,
          operatorAfter: OPERATOR_COST_CAP,
        }),
      }),
    );
    // The refused reservation was refunded, not left on the row.
    expect(ledgerTotal).toBe(OPERATOR_COST_CAP);
  });

  it("refunds the reservation when the provider errors", async () => {
    runRawCompletionWithFallback.mockRejectedValue(new Error("upstream down"));

    const result = await runStatusCompletion(completionArgs());

    expect(result.kind).toBe("error");
    expect(ledgerTotal).toBe(0);
  });
});

describe("runStatusCompletion — cost owner decides the ceiling", () => {
  it("measures an operator-key chain against the operator ceiling", async () => {
    // Just under the operator ceiling: an operator-key user is refused here.
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    mockProviderReply(100);

    const result = await runStatusCompletion(completionArgs());

    expect(result.kind).toBe("error");
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("measures a BYOK chain against the user-plan ceiling, not the operator's", async () => {
    // Same spend that locked the operator-key user out above. A self-hoster on
    // their own key pays their own bill, so the operator's ceiling is a
    // category error for them — they must still be served.
    resolveProviderChain.mockResolvedValue(BYOK_CHAIN);
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: '{"summary":"ok"}', model: "m", tokensUsed: 100 },
      workingProvider: { providerType: "anthropic" },
    });

    const result = await runStatusCompletion(completionArgs());

    expect(result.kind).toBe("ok");
    expect(runRawCompletionWithFallback).toHaveBeenCalled();
  });

  it("still bounds a BYOK chain at the user-plan ceiling", async () => {
    resolveProviderChain.mockResolvedValue(BYOK_CHAIN);
    ledgerTotal = USER_PLAN_CAP;
    // Not one of those tokens was the operator's: the abuse ceiling on the
    // total is what must still refuse this generation.
    ledgerOperator = 0;
    mockProviderReply(100);

    const result = await runStatusCompletion(completionArgs());

    expect(result.kind).toBe("error");
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });
});
