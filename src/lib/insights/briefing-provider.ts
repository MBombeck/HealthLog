/**
 * Metered provider chokepoint for the comprehensive-briefing tier.
 *
 * The status/reference tier funnels every generation through
 * `runStatusCompletion`, which reserves against the day's token ledger before
 * egress and reconciles after. The comprehensive briefing did not: both the
 * shared generator (`comprehensive-generate.ts`) and the on-demand
 * `POST /api/insights/generate` route called `runRawCompletionWithFallback`
 * directly, so none of that spend reached `coach_usage` and no daily ceiling
 * applied to it. The briefing is the single most expensive generation in the
 * product — a full feature snapshot in, a multi-section JSON payload out — and
 * it retries up to twice per run (JSON-shape retry, grounding-correction
 * retry), so an unmetered run could cost three full generations.
 *
 * This is the same accounting the status tier uses, not a second mechanism:
 * `reserveBudget` (one atomic upsert-increment, no read-then-write window) +
 * `resolveDailyCapFor("job", chain)` for the cost owner + `reconcileSpend` against the
 * provider's reported count. Every provider call on the briefing path routes
 * through here, so a retry is reserved and charged like any other call — a
 * user at the ceiling does not get a free correction pass.
 *
 * The cap follows the COST OWNER. `resolveDailyCapFor` charges
 * the operator ceiling only when the chain's primary is the operator's own
 * credential (`admin-openai` / `admin-codex`); a self-hoster on their own key,
 * their own ChatGPT plan, or a local model is measured against the generous
 * user-plan ceiling, so their hardware is never rationed by the operator's
 * bill.
 *
 * Callers own the consent gate and MUST apply it before calling in — a
 * consent-blocked user must never have budget reserved against them, because
 * nothing is ever sent upstream on their behalf.
 */
import {
  runRawCompletionWithFallback,
  type ProviderChainResolved,
  type RunRawWithFallbackResult,
} from "@/lib/ai/provider-runner";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCapFor,
} from "@/lib/ai/coach/budget";
import { singleUserTurn } from "@/lib/ai/types";
import { annotate } from "@/lib/logging/context";

/**
 * Which call on the briefing path this was. Threaded onto the refusal
 * annotation so an operator can tell a first-pass refusal (the whole briefing
 * is missing) apart from a retry refusal (the first pass landed, the
 * correction did not).
 */
export type BriefingCompletionStage =
  "generate" | "json-retry" | "grounding-retry" | "reroll";

/**
 * Thrown when the reservation would push the user past the day's ceiling.
 *
 * Deliberately a distinct type rather than a generic provider error: the
 * callers map it to their own honest outcome (a typed `skipped` for the
 * off-request generator, a 429 for the on-demand route) instead of reporting
 * an upstream failure that never happened. No provider was contacted.
 */
export class BriefingBudgetExceededError extends Error {
  constructor(
    readonly stage: BriefingCompletionStage,
    readonly totalAfter: number,
  ) {
    super("insights.briefing.budget_exceeded");
    this.name = "BriefingBudgetExceededError";
  }
}

export interface RunBriefingCompletionArgs {
  userId: string;
  /** The resolved provider chain. Its primary decides the daily cap. */
  chain: ProviderChainResolved[];
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Upstream per-request timeout, already resolved from the user's setting. */
  timeoutMs: number;
  stage: BriefingCompletionStage;
  /**
   * Deterministic seed. Omitted by the daily-briefing re-roll on purpose —
   * a pinned seed would reproduce the phrasing the re-roll exists to vary.
   */
  seed?: number;
  /** UTC day-key override; defaults to today. Tests pin it. */
  dateKey?: string;
}

/**
 * Reserve, run the chain, reconcile. Returns the runner's result untouched so
 * every existing caller keeps its own parsing, grounding, and error mapping.
 *
 * Failure semantics:
 *   - over the ceiling  → `BriefingBudgetExceededError`, nothing reserved
 *     (the reservation is refunded inside `reserveBudget`), no egress.
 *   - provider threw    → the reservation is refunded IN FULL and the original
 *     error re-thrown, so `AllProvidersFailedError` still reaches the callers
 *     that map it to a user-facing status.
 *   - provider returned → charged the reported count, net of cached input
 *     tokens; falls back to the reservation when the provider reports no
 *     count, so an unreported generation is never billed as free.
 */
export async function runBriefingCompletion(
  args: RunBriefingCompletionArgs,
): Promise<RunRawWithFallbackResult> {
  const dateKey = args.dateKey ?? buildDateKey();

  // Reserve an ESTIMATE up front — the output ceiling plus a ~4-chars-per-token
  // approximation of the prompt about to be sent — and reconcile against the
  // provider's reported count afterwards. Same shape as the status tier.
  const estimatedTokens =
    args.maxTokens +
    Math.ceil((args.systemPrompt.length + args.userPrompt.length) / 4);

  // v1.38.19 — a background surface: half the day's ceiling when the
  // operator funds the chain.
  const jobCap = resolveDailyCapFor("job", args.chain);
  const reservation = await reserveBudget(
    args.userId,
    estimatedTokens,
    dateKey,
    jobCap,
    resolveCostOwner(args.chain),
    "job",
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "insights.briefing.budget_exceeded" },
      meta: {
        stage: args.stage,
        owner: reservation.owner,
        surface: "job",
        limit: reservation.limit,
        cap: jobCap,
        totalAfter: reservation.totalAfter,
        operatorAfter: reservation.operatorAfter,
      },
    });
    throw new BriefingBudgetExceededError(args.stage, reservation.totalAfter);
  }

  let outcome: RunRawWithFallbackResult;
  try {
    outcome = await runRawCompletionWithFallback({
      userId: args.userId,
      // A background generator: an operator-funded fallback hop is rationed at
      // the job share, exactly as the reservation above was.
      surface: "job",
      providers: args.chain,
      params: singleUserTurn({
        system: args.systemPrompt,
        user: args.userPrompt,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        seed: args.seed,
        timeoutMs: args.timeoutMs,
        // Every briefing call parses its reply with `JSON.parse`, so opt the
        // chains with a native JSON mode into it.
        responseFormat: "json",
      }),
    });
  } catch (err) {
    // No usable reply: refund the whole reservation rather than bill an
    // invented figure. A partially-burned upstream call is possible here, but
    // we have no reported count to charge, and over-charging a failed
    // generation would ration the retry the user is entitled to.
    await reconcileSpend(args.userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    }).catch(() => {
      // Best-effort: a failed refund leaves the conservative reservation in
      // place (never an undercount) and must not mask the provider error.
    });
    throw err;
  }

  const actualTokens = outcome.result.tokensUsed ?? reservation.reserved;
  await reconcileSpend(
    args.userId,
    reservation.reserved,
    actualTokens,
    dateKey,
    outcome.result.cachedInputTokens ?? 0,
    {
      servedBy: outcome.workingProvider.providerType,
      reservedOwner: reservation.owner,
    },
  ).catch(() => {
    // Ledger reconcile is best-effort; a failure leaves the reservation in
    // place and never breaks a generation that already succeeded.
  });

  return outcome;
}
