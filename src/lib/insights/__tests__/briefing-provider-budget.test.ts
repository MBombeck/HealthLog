/**
 * Cost accounting for the comprehensive-briefing provider chokepoint.
 *
 * `runBriefingCompletion` is the single provider entry for the briefing tier —
 * the shared generator's first pass, its JSON-shape retry, its
 * grounding-correction retry, the daily paragraph re-roll, and both calls in
 * the on-demand `POST /api/insights/generate` route. That tier previously ran
 * with NO budget accounting: nothing reserved, nothing recorded, no ceiling.
 * The briefing is the most expensive generation in the product and retries up
 * to twice, so an unmetered run could cost three full generations — and on an
 * operator-key account that was unmetered operator spend.
 *
 * These tests drive the REAL budget module (`reserveBudget` / `reconcileSpend`
 * / `resolveDailyCap`) against a stateful in-memory stand-in for the
 * `coach_usage` row, so they exercise the actual atomic-upsert path rather
 * than merely asserting that a mock was called. Mirrors the status tier's
 * `status-provider-budget.test.ts` deliberately: one accounting mechanism,
 * one set of guarantees, asserted the same way at both chokepoints.
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
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const { runRawCompletionWithFallback } = vi.hoisted(() => ({
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback,
}));

import {
  runBriefingCompletion,
  BriefingBudgetExceededError,
} from "../briefing-provider";
import { annotate } from "@/lib/logging/context";
import { OPERATOR_COST_CAP, USER_PLAN_CAP } from "@/lib/ai/coach/budget";

const OPERATOR_CHAIN = [
  { providerType: "admin-openai" as const, instance: {} as never },
];
const BYOK_CHAIN = [
  { providerType: "anthropic" as const, instance: {} as never },
];

function completionArgs(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    chain: OPERATOR_CHAIN,
    systemPrompt: "system",
    userPrompt: "user",
    temperature: 0.3,
    maxTokens: 2500,
    timeoutMs: 60_000,
    stage: "generate" as const,
    ...overrides,
  };
}

/** A successful provider reply reporting `tokensUsed`. */
function mockProviderReply(
  tokensUsed: number | null,
  cachedInputTokens?: number,
) {
  runRawCompletionWithFallback.mockResolvedValue({
    result: {
      content: '{"dailyBriefing":{"paragraph":"ok"}}',
      model: "m",
      tokensUsed,
      cachedInputTokens,
    },
    workingProvider: { providerType: "admin-openai" },
    fallbackHops: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerTotal = 0;
  ledgerOperator = 0;
});

describe("runBriefingCompletion — ledger accounting", () => {
  it("lands a successful generation on the day's ledger", async () => {
    mockProviderReply(1234);

    const outcome = await runBriefingCompletion(completionArgs());

    expect(outcome.result.tokensUsed).toBe(1234);
    // Reserved an estimate, then reconciled down to what the provider actually
    // reported. Either way the spend is now ON the ledger — before this wiring
    // existed the total stayed at zero forever, no matter how many briefings
    // the account generated.
    expect(ledgerTotal).toBe(1234);
  });

  it("charges the reservation when the provider reports no token count", async () => {
    mockProviderReply(null);

    await runBriefingCompletion(completionArgs());

    // An unreported generation must not bill as free.
    expect(ledgerTotal).toBeGreaterThan(0);
  });

  it("bills net of provider-cached input tokens", async () => {
    mockProviderReply(1000, 400);

    await runBriefingCompletion(completionArgs());

    // The gross count still includes input the prompt cache served cheaply;
    // charging the user's meter for input they did not re-pay for is an
    // over-charge.
    expect(ledgerTotal).toBe(600);
  });

  it("refuses a generation once the day's cap is already spent", async () => {
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    mockProviderReply(500);

    await expect(
      runBriefingCompletion(completionArgs()),
    ).rejects.toBeInstanceOf(BriefingBudgetExceededError);

    // Refused BEFORE any provider egress — the point of the whole exercise.
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "insights.briefing.budget_exceeded" },
      }),
    );
    // The refused reservation was refunded, not left on the row.
    expect(ledgerTotal).toBe(OPERATOR_COST_CAP);
  });

  it("refunds the reservation in full when the provider errors", async () => {
    runRawCompletionWithFallback.mockRejectedValue(new Error("upstream down"));

    await expect(runBriefingCompletion(completionArgs())).rejects.toThrow(
      "upstream down",
    );

    // A failed generation must not leave an estimate parked on the ledger,
    // which would ration the retry the user is entitled to.
    expect(ledgerTotal).toBe(0);
  });

  it("re-throws the provider error unchanged so callers keep their mapping", async () => {
    class AllProvidersFailedError extends Error {}
    runRawCompletionWithFallback.mockRejectedValue(
      new AllProvidersFailedError("chain exhausted"),
    );

    // The route maps `AllProvidersFailedError` to specific user-facing
    // statuses; swallowing or re-wrapping it here would silently degrade every
    // one of those branches to the generic error.
    await expect(
      runBriefingCompletion(completionArgs()),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it("meters each retry stage separately", async () => {
    mockProviderReply(1000);

    await runBriefingCompletion(completionArgs({ stage: "generate" }));
    await runBriefingCompletion(completionArgs({ stage: "json-retry" }));
    await runBriefingCompletion(completionArgs({ stage: "grounding-retry" }));

    // A correction pass is real spend. If retries rode the first pass's
    // reservation, a user at the ceiling would get free retries.
    expect(ledgerTotal).toBe(3000);
  });
});

describe("runBriefingCompletion — cost owner decides the ceiling", () => {
  it("measures an operator-key chain against the operator ceiling", async () => {
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    mockProviderReply(100);

    await expect(
      runBriefingCompletion(completionArgs()),
    ).rejects.toBeInstanceOf(BriefingBudgetExceededError);
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("measures a BYOK chain against the user-plan ceiling, not the operator's", async () => {
    // Same spend that locked the operator-key user out above. A self-hoster on
    // their own key pays their own bill, so the operator's ceiling is a
    // category error for them — they must still be served.
    ledgerTotal = OPERATOR_COST_CAP;
    ledgerOperator = OPERATOR_COST_CAP;
    mockProviderReply(100);

    const outcome = await runBriefingCompletion(
      completionArgs({ chain: BYOK_CHAIN }),
    );

    expect(outcome.result.tokensUsed).toBe(100);
    expect(runRawCompletionWithFallback).toHaveBeenCalled();
  });

  it("still bounds a BYOK chain at the user-plan ceiling", async () => {
    ledgerTotal = USER_PLAN_CAP;
    // Not one of those tokens was the operator's: the abuse ceiling on the
    // total is what must still refuse this generation.
    ledgerOperator = 0;
    mockProviderReply(100);

    await expect(
      runBriefingCompletion(completionArgs({ chain: BYOK_CHAIN })),
    ).rejects.toBeInstanceOf(BriefingBudgetExceededError);
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });
});
