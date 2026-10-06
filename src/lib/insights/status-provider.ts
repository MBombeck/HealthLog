import {
  probeProviderPresence,
  resolveProvider,
  resolveProviderChain,
} from "@/lib/ai/provider";
import { aiCapabilityForRecord } from "@/lib/ai/capabilities/gate";
import type {
  AiCapabilityKey,
  AiUnavailableReason,
} from "@/lib/ai/capabilities/types";
import {
  runRawCompletionWithFallback,
  type ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
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
import {
  REASONING_THINKING_BUDGET,
  type BackgroundReasoningJob,
} from "@/lib/ai/reasoning/levels";
import { resolveJobReasoning } from "@/lib/ai/reasoning/controls";

/**
 * v1.41 — the fallback ceiling for a status-path call that reasons. Thinking
 * is spent before the first answer token, so the 60 s status budget would cut
 * a medium-effort narrative off mid-thought. A positive per-record setting
 * still wins, as everywhere.
 */
export const REASONING_JOB_TIMEOUT_MS = 90_000;

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
  /**
   * Nothing was sent: no provider, or the capability is unavailable for this
   * record (operator switch, opt-out, module, consent, …). Callers serve the
   * deterministic line and persist nothing; `reason` says which layer said no.
   */
  | { kind: "none"; reason: AiUnavailableReason }
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
   * The AI capability this generation serves (`statusText`, `periodNarrative`,
   * `workoutInsights`, `coach`, …). Required: the chokepoint re-checks it
   * immediately before anything leaves the machine, so a job enqueued before
   * an operator flipped a switch, or before the person withdrew consent or
   * turned AI analysis off, still stops here. The capability also names the
   * consent kinds an operator-held chain entry needs.
   */
  capability: AiCapabilityKey;
  /**
   * v1.41 — the background job this call is, when it is one of the few that
   * may reason (`BACKGROUND_REASONING_JOBS`: the period narratives and the
   * Coach memory passes). Absent for every status card, batch note, derived
   * score and workout line, which therefore send exactly what they sent
   * before reasoning existed; `background-reasoning-inventory.test.ts`
   * freezes which call sites set it. The operator's switch and cap apply.
   */
  reasoningJob?: BackgroundReasoningJob;
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
 * Whether any configured provider could serve text for `userId`: the one
 * presence probe (`probeProviderPresence`). No client construction, no token
 * refresh, no network.
 */
export async function hasUsableStatusProvider(
  userId: string,
): Promise<boolean> {
  return probeProviderPresence(userId, "text");
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

  // The capability, re-checked at the wire. Every caller resolved it earlier
  // (a worker before building its snapshot, a route before enqueueing), but
  // switches, opt-outs and consent can change between the enqueue and here.
  const capability = await aiCapabilityForRecord(userId, args.capability);
  if (!capability.available) {
    const reason = capability.reason ?? "check_failed";
    annotate({
      action: { name: "insights.status.capability_unavailable" },
      meta: { cacheAction, capability: args.capability, reason },
    });
    return { kind: "none", reason };
  }

  const chain = await resolveStatusChain(userId);
  if (chain === null) {
    return { kind: "none", reason: "no_provider" };
  }

  // The wire re-check for exactly this chain (`aiEgressRefusal`, the one
  // helper every chokepoint uses): the capability again, and whether sending
  // to these providers needs a consent receipt under the capability's rule
  // (the operator's key or the shared central Codex does; a person's own key
  // or a local model does not). Fails closed like the rest: a chain that
  // COULD cascade to an operator-held entry needs the receipt.
  const refusal = await aiEgressRefusal(
    args.capability,
    userId,
    chain.map((entry) => entry.providerType),
  );
  if (refusal) {
    annotate({
      action: { name: "insights.status.capability_unavailable" },
      meta: {
        cacheAction,
        capability: args.capability,
        reason: refusal.reason,
        at: "wire",
      },
    });
    return { kind: "none", reason: refusal.reason };
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
  // v1.41 — resolved once per call, after the capability and egress checks
  // so a refused call never reads the controls. `undefined` (the operator
  // switched reasoning off, or the job resolved off) is today's wire.
  const reasoning = args.reasoningJob
    ? await resolveJobReasoning(args.reasoningJob, chain)
    : undefined;
  const thinkingTokens =
    reasoning && reasoning.effort !== "off"
      ? REASONING_THINKING_BUDGET[reasoning.effort]
      : 0;

  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    settingsRow?.aiResponseTimeoutSeconds,
    thinkingTokens > 0 ? REASONING_JOB_TIMEOUT_MS : STATUS_PROVIDER_TIMEOUT_MS,
  );

  // The answer budget. Each client adds the thinking budget on top itself.
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
  // Thinking is billed as output, so a reasoning call reserves its thinking
  // budget too; the reconcile below settles on the reported count.
  const estimatedTokens =
    maxTokens +
    thinkingTokens +
    Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  // v1.38.19 — a background surface: half the day's ceiling when the
  // operator funds the chain.
  const jobCap = resolveDailyCapFor("job", chain);
  const reservation = await reserveBudget(
    userId,
    estimatedTokens,
    dateKey,
    jobCap,
    resolveCostOwner(chain),
    "job",
  );
  if (!reservation.allowed) {
    // Over the day's ceiling. Reported as `error` — a TRANSIENT miss the caller
    // serves the fallback for without persisting it — deliberately NOT `none`,
    // which callers cache as the settled "no provider configured" assessment.
    // The distinct annotation keeps the refusal observable even though the
    // result shape is shared.
    // v1.38.19 — the shared `error` outcome cannot say
    // WHY the generation stopped, so the annotation has to. `surface: "job"`
    // plus `cap` separates "this job used up the background share" from "the
    // whole day is spent", and `limit` says which counter tripped. The operator
    // sees the same split on the admin provider-health card.
    annotate({
      action: { name: "insights.status.budget_exceeded" },
      meta: {
        cacheAction,
        owner: reservation.owner,
        surface: "job",
        limit: reservation.limit,
        cap: jobCap,
        totalAfter: reservation.totalAfter,
        operatorAfter: reservation.operatorAfter,
      },
    });
    return { kind: "error" };
  }

  const raced = await withTimeout(
    () =>
      runRawCompletionWithFallback({
        userId,
        providers: chain,
        // A background generator: an operator-funded fallback hop is rationed
        // at the job share, exactly as the reservation above was.
        surface: "job",
        params: {
          ...singleUserTurn({
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
          // v1.41 — only a named job ever carries this; see `reasoningJob`.
          ...(reasoning ? { reasoning } : {}),
        },
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

  // Consent withdrawn while the call was in flight. The withdrawal purged the
  // stored text in its own transaction; a reply persisted after it would
  // bring that text back under a consent that no longer exists. So the rule
  // runs once more, against the provider that actually answered, with a fresh
  // receipt read, and a refused reply is dropped as if it had never arrived.
  // The tokens stay on the ledger: they were spent upstream.
  const late = await aiEgressRefusal(args.capability, userId, [
    workingProvider.providerType,
  ]);
  if (late) {
    annotate({
      action: { name: "insights.status.capability_unavailable" },
      meta: {
        cacheAction,
        capability: args.capability,
        reason: late.reason,
        at: "reply",
      },
    });
    return { kind: "none", reason: late.reason };
  }

  return {
    kind: "ok",
    content,
    providerType: workingProvider.providerType,
    model: result.model ?? "unknown",
    tokensUsed: result.tokensUsed ?? null,
  };
}
