import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  runRawCompletionWithFallback,
  type ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
  type ConsentSurface,
} from "@/lib/ai/consent-guard";
import { annotate } from "@/lib/logging/context";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCapFor,
} from "@/lib/ai/coach/budget";
import { AI_BUDGETS, REFERENCE_AI_SEED } from "@/lib/ai/ai-budgets";
import { singleUserTurn } from "@/lib/ai/types";
import { STATUS_PROVIDER_TIMEOUT_MS, withTimeout } from "./with-timeout";
import { prisma } from "@/lib/db";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";

/**
 * Shared provider plumbing for the seven `*-status.ts` generators.
 *
 * Before this, each generator resolved a single provider via
 * `resolveProvider()` and raced one `generateCompletion()` call against
 * a 20 s cap. A degraded primary provider could not cascade, and the
 * cap fired below the providers' own 60 s floor — converting healthy-
 * but-slow generations into the generic fallback.
 *
 * This helper mirrors the Coach (`chat/route.ts`): resolve the user's
 * provider chain, fall back to the legacy single provider when the chain
 * is empty, and run `runRawCompletionWithFallback` so a degraded provider
 * cascades to the next. The whole thing is still wrapped in
 * `withTimeout` at the aligned 60 s budget so a total stall can't pin the
 * card — but a timeout / error is reported as a transient miss (the
 * caller serves the fallback for this render without persisting it),
 * never as the day's cached assessment.
 */

export type StatusProviderResult =
  | { kind: "none" }
  | { kind: "timeout" }
  | { kind: "error" }
  | {
      kind: "ok";
      content: string;
      providerType: string;
      model: string;
      tokensUsed: number | null;
    };

interface RunStatusCompletionArgs {
  userId: string;
  cacheAction: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * v1.18.7 — optional deterministic seed override. Defaults to
   * `REFERENCE_AI_SEED` for every status/reference surface (reproducible
   * QA); the period narrative passes the same constant explicitly.
   */
  seed?: number;
  /**
   * v1.18.7 — output contract of this generation. The per-metric status
   * cards return a JSON `{ "summary": ... }` (the default), so they opt the
   * non-OpenAI chains into their strongest JSON mode. The period narrative
   * returns PLAIN TEXT and passes `"text"` to suppress that.
   */
  responseFormat?: "json" | "text";
  /**
   * v1.12.1 — which AI surface this generation serves, for the consent gate.
   * `insights` for the per-metric status cards + period narrative; `coach`
   * for the off-budget Coach memory workers (rolling summary + fact
   * extraction). When the resolved chain would egress via the operator's
   * server-managed key and no active receipt of the matching kind exists,
   * the run short-circuits to `{ kind: "none" }` (the no-key fallback) so no
   * PHI leaves the server. BYOK / local / ChatGPT-OAuth chains are ungated.
   */
  consentSurface: ConsentSurface;
}

/**
 * Resolve the provider chain for `userId`, falling back to the legacy
 * single provider. Returns `null` when the user has no usable provider
 * anywhere (the caller surfaces the no-key fallback with
 * `hasProvider:false`).
 */
async function resolveStatusChain(
  userId: string,
): Promise<ProviderChainResolved[] | null> {
  const chain = await resolveProviderChain(userId);
  if (chain.length > 0) return chain;

  const legacy = await resolveProvider(userId);
  if (legacy.type === "none") return null;
  return [{ providerType: "admin-openai", instance: legacy }];
}

/**
 * Cheap provider-availability probe for the read-only status path.
 *
 * v1.8.3 — when a status route runs in read-only mode (serve cache, never
 * block on the LLM) it still has to tell the difference between "no
 * provider — show the no-key fallback" and "provider configured but the
 * assessment isn't warm yet — show preparing + enqueue a generation". This
 * resolves the same chain `runStatusCompletion` would, but does NOT run a
 * completion, so the navigation request never awaits an LLM round-trip.
 */
export async function hasUsableStatusProvider(
  userId: string,
): Promise<boolean> {
  return (await resolveStatusChain(userId)) !== null;
}

/**
 * v1.16.8 — true when a status generation for `userId` would be blocked
 * by the server-managed consent gate (the same check `runStatusCompletion`
 * applies before egress). The content-hash gate
 * (`refreshUnchangedStatusInsight`) consults this BEFORE re-stamping a
 * cached assessment as current: after a consent revocation the unchanged-
 * data refresh must fall through to the generator, whose own gate then
 * serves the no-key fallback instead of presenting old AI text as fresh.
 * `false` when no provider is configured at all — that path already
 * resolves to the fallback via `{ kind: "none" }`.
 */
export async function statusConsentBlocksGeneration(
  userId: string,
  surface: ConsentSurface,
): Promise<boolean> {
  const chain = await resolveStatusChain(userId);
  if (chain === null) return false;
  return (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, surface))
  );
}

/**
 * Run a status generation across the user's provider chain, bounded by the
 * per-user response-timeout setting (falling back to `STATUS_PROVIDER_TIMEOUT_MS`
 * when unset). The result discriminates between
 * no-provider / timeout / provider-error / success so the caller can
 * decide what to persist — only `ok` is ever cached as the day's
 * assessment.
 */
export async function runStatusCompletion(
  args: RunStatusCompletionArgs,
): Promise<StatusProviderResult> {
  const { userId, cacheAction, systemPrompt, userPrompt } = args;

  const chain = await resolveStatusChain(userId);
  if (chain === null) {
    return { kind: "none" };
  }

  // v1.12.1 — consent gate before server-managed external egress. A chain
  // that could egress via the operator's global key requires an active
  // receipt of the surface's mapped kind (or master `ai_full`). Without one,
  // surface the no-key fallback (`none`) rather than egress the snapshot —
  // identical to a missing provider from the caller's perspective, so no
  // generator branch needs to change. BYOK / local / ChatGPT-OAuth chains
  // never trip this.
  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, args.consentSurface))
  ) {
    annotate({
      action: { name: "insights.status.consent_required" },
      meta: { cacheAction, surface: args.consentSurface },
    });
    return { kind: "none" };
  }

  // Honour the per-user response-timeout setting the operator dials in for a
  // slow self-hosted / local backend (Settings → AI). This is the single
  // chokepoint every status / reference surface funnels through — per-metric
  // cards, the batched assessment, the derived assessments, and the period
  // narratives — so resolving it here threads the setting onto all of them at
  // once. A positive stored value wins (seconds → ms); unset falls back to the
  // status-path budget. Applied to BOTH the upstream call's own `timeoutMs`
  // and the outer `withTimeout` cap so a raised value is not silently clipped
  // by the 60 s wall-clock that previously bounded the path.
  const settingsRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiResponseTimeoutSeconds: true },
  });
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    settingsRow?.aiResponseTimeoutSeconds,
    STATUS_PROVIDER_TIMEOUT_MS,
  );

  const maxTokens = args.maxTokens ?? AI_BUDGETS.status.maxTokens;

  // The day's token ledger. Until now this chokepoint — the provider entry for
  // EVERY status/reference family (the specialised cards, the generic metric
  // cards, biomarker cards, the batched assessment, the derived scores, the
  // period narrative, and the off-request Coach memory workers: rolling
  // summary, fact extraction, plan proposals) — ran with no accounting at all,
  // so none of that spend appeared in `coach_usage` and no ceiling applied.
  //
  // The reservation is atomic (single upsert-increment), matching the Coach and
  // document paths: a read-then-write check would let concurrent generations
  // each observe a sub-cap total and all proceed. We reserve an ESTIMATE up
  // front — the output ceiling plus a ~4-chars-per-token approximation of the
  // prompt we are about to send — and reconcile against the provider's reported
  // count afterwards, refunding in full when nothing was generated.
  //
  // The cap follows the COST OWNER: `resolveDailyCapFor` charges
  // the operator ceiling only when the chain's primary is the operator's own
  // credential (`admin-openai` / `admin-codex`). A self-hoster on their own key
  // or a local model is measured against the generous user-plan ceiling, so
  // their own hardware/plan is never rationed by the operator's bill.
  const dateKey = buildDateKey();
  const estimatedTokens =
    maxTokens + Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const reservation = await reserveBudget(
    userId,
    estimatedTokens,
    dateKey,
    // v1.38.19 (Wave E) — a background surface: half the day's ceiling.
    resolveDailyCapFor("job", chain),
    resolveCostOwner(chain),
  );
  if (!reservation.allowed) {
    // Over the day's ceiling. Reported as `error` — a TRANSIENT miss the caller
    // serves the fallback for without persisting it — deliberately NOT `none`,
    // which callers cache as the settled "no provider configured" assessment.
    // The distinct annotation keeps the refusal observable even though the
    // result shape is shared.
    annotate({
      action: { name: "insights.status.budget_exceeded" },
      meta: { cacheAction, totalAfter: reservation.totalAfter },
    });
    return { kind: "error" };
  }

  const raced = await withTimeout(
    () =>
      runRawCompletionWithFallback({
        userId,
        providers: chain,
        params: singleUserTurn({
          system: systemPrompt,
          user: userPrompt,
          temperature: args.temperature ?? AI_BUDGETS.status.temperature,
          maxTokens,
          // v1.18.7 — status/reference output is reproducible: pin the
          // deterministic seed unless a caller overrides it.
          seed: args.seed ?? REFERENCE_AI_SEED,
          // Status cards are JSON by default; the narrative opts out via
          // `"text"`.
          responseFormat: args.responseFormat === "text" ? undefined : "json",
          timeoutMs: effectiveTimeoutMs,
        }),
      }),
    effectiveTimeoutMs,
    null,
  );

  if (raced.timedOut) {
    // A timed-out generation may still have burned upstream tokens, but we have
    // no reported count to charge — refund the reservation rather than bill an
    // invented figure.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    return { kind: "timeout" };
  }
  if (raced.errored || raced.value === null) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    return { kind: "error" };
  }

  const { result, workingProvider } = raced.value;
  // Reconcile against what the provider actually reported. This runs for the
  // empty-content branch too: those tokens were burned upstream even though the
  // reply was unusable, so they stay on the ledger rather than being refunded
  // into a free retry loop. Falls back to the reservation when the provider
  // reports no count, so an unreported generation is never billed as zero.
  const actualTokens = result.tokensUsed ?? reservation.reserved;
  await reconcileSpend(userId, reservation.reserved, actualTokens, dateKey, 0, {
    servedBy: workingProvider.providerType,
    reservedOwner: reservation.owner,
  });

  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    annotate({
      action: { name: "insights.status.empty_content" },
      meta: { cacheAction, providerType: workingProvider.providerType },
    });
    return { kind: "error" };
  }

  return {
    kind: "ok",
    content,
    providerType: workingProvider.providerType,
    model: result.model ?? "unknown",
    tokensUsed: result.tokensUsed ?? null,
  };
}
