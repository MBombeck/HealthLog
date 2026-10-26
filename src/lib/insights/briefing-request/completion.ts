/**
 * The on-demand briefing's provider calls, and what a failed call means for
 * the person waiting on it.
 */
import { resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { providerFailureKind } from "@/lib/ai/failure-kind";
import { buildSystemPromptWithReferences } from "@/lib/ai/prompts/insight-generator";
import {
  AllProvidersFailedError,
  type ProviderChainResolved,
  type RunRawWithFallbackResult,
} from "@/lib/ai/provider-runner";
import {
  BriefingBudgetExceededError,
  runBriefingCompletion,
} from "@/lib/insights/briefing-provider";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { annotate } from "@/lib/logging/context";

import type { BriefingRefusal, GenerationContext } from "./context";
import type { BriefingPrompt } from "./prompt";

export interface BriefingCall {
  ctx: GenerationContext;
  chain: ProviderChainResolved[];
  prompt: BriefingPrompt;
}

/** One briefing completion with the route's fixed parameters. */
export function runBriefingCall(
  call: BriefingCall,
  options: {
    userPrompt: string;
    stage: "generate" | "grounding-retry";
    reasoning: boolean;
  },
): Promise<RunRawWithFallbackResult> {
  const { ctx, chain, prompt } = call;
  return runBriefingCompletion({
    userId: ctx.userId,
    chain,
    // The strict prompt carries GROUND RULE 8 — emit a top-level
    // `dailyBriefing` block when the snapshot has analysable signal — plus
    // the trendAnnotations and storyboardAnnotations rules. The legacy
    // `getInsightsSystemPrompt` returned the old `{changed, stable, drivers,
    // …}` shape and never asked the model for dailyBriefing, so the hero
    // strip's "Re-run analysis" button kept producing a payload with no
    // briefing block. `insightResultSchema` is loose, so a reply that
    // validates keeps these blocks, and one that does not is kept as parsed.
    systemPrompt: buildSystemPromptWithReferences(
      ctx.locale,
      prompt.referenceMetrics,
    ),
    userPrompt: options.userPrompt,
    temperature: 0.3,
    // Env-tunable output ceiling (INSIGHTS_MAX_TOKENS, default 2500, #470).
    // A fixed 1500 truncated verbose models' briefing JSON mid-string →
    // generic invalid-JSON 422.
    maxTokens: resolveInsightsMaxTokens(),
    // A wide upstream budget, honouring the per-user response-timeout
    // setting, so the reasoning-heavy briefing generation is not aborted at
    // the client's 60 s default on large accounts.
    timeoutMs: ctx.effectiveTimeoutMs,
    stage: options.stage,
    // The person who pressed "Re-run analysis" is waiting on this call.
    interactive: true,
    // A briefing asked for by hand reasons exactly like the scheduled one;
    // the retries repair a reply and do not.
    ...(options.reasoning ? { reasoningJob: "daily_briefing" as const } : {}),
  });
}

export type FirstCompletion =
  | {
      ok: true;
      result: RunRawWithFallbackResult["result"];
      workingProviderType: string;
      fallbackHopCount: number;
    }
  | { ok: false; refusal: BriefingRefusal };

/** The refusal for a chain on which every provider failed. */
function chainRefusal(e: AllProvidersFailedError): BriefingRefusal {
  annotate({
    meta: {
      insights_chain_outcome: "all-failed",
      insights_chain_attempts: e.attempts.length,
      insights_chain_first_provider: e.attempts[0]?.providerType ?? null,
      insights_chain_first_status: e.attempts[0]?.httpStatus ?? null,
    },
  });
  // The most specific user-facing message available. Auth-class failures
  // across the entire chain mean every provider's credential is bad — the
  // "check your API key" wording tells the user where to act. 429 across the
  // chain is rate-limit; 5xx is upstream brown-out; transport-only
  // (ECONNRESET, no httpStatus) maps to the generic connection hint so users
  // on flaky networks don't see "rate-limited".
  if (e.attempts.every((a) => a.httpStatus === 401 || a.httpStatus === 403)) {
    return "provider-rejected";
  }
  if (e.attempts.every((a) => a.httpStatus === 429)) {
    return "provider-rate-limited";
  }
  if (e.attempts.some((a) => a.httpStatus !== null && a.httpStatus >= 500)) {
    return "provider-unavailable";
  }
  if (e.attempts.every((a) => a.httpStatus === null || a.httpStatus <= 0)) {
    return "provider-connection";
  }
  return "provider-unavailable";
}

/**
 * The refusal for a single provider error that did not cascade (e.g. a
 * custom 4xx from a self-hosted local model). Cloudflare rewrites 5xx to its
 * own HTML error page, which breaks `await res.json()` on the dashboard, so
 * the statuses map onto the ai/test categorisation.
 */
function providerRefusal(e: unknown): BriefingRefusal {
  const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
  annotate({
    meta: {
      insights_provider_error: err.message.slice(0, 500),
      insights_provider_status: err.httpStatus ?? null,
      insights_provider_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
    },
  });
  const status = err.httpStatus ?? 0;
  if (status === 401 || status === 403) return "provider-rejected";
  if (status === 429) return "provider-rate-limited";
  if (status >= 500) return "provider-unavailable";
  return "provider-connection";
}

export async function runFirstCompletion(
  call: BriefingCall,
): Promise<FirstCompletion> {
  try {
    const fallback = await runBriefingCall(call, {
      userPrompt: call.prompt.userPrompt,
      stage: "generate",
      reasoning: true,
    });
    return {
      ok: true,
      result: fallback.result,
      workingProviderType: fallback.workingProvider.providerType,
      fallbackHopCount: fallback.fallbackHops.length,
    };
  } catch (e) {
    // The day's token ceiling refused the reservation — no provider was
    // contacted, so this is NOT a provider failure and must not record a
    // briefing-failure marker (which would make the read path claim the
    // refresh broke). The hourly rate limit bounds request frequency; this
    // bounds cost.
    if (e instanceof BriefingBudgetExceededError) {
      return { ok: false, refusal: "budget-exceeded" };
    }
    // A dated failure marker (no cache row is written on this path, so the
    // last good briefing stays intact). The read path pairs the preserved
    // text with a discreet "couldn't refresh" hint, or shows a retry empty
    // state when there is no last good text. The upstream status rides
    // along so the hint can tell an auth / rate-limit failure apart from a
    // plain timeout: for an all-providers-failed error the first hop's
    // status is the most representative; a single provider error exposes its
    // own `httpStatus`.
    const failureHttpStatus =
      e instanceof AllProvidersFailedError
        ? (e.attempts[0]?.httpStatus ?? null)
        : typeof (e as { httpStatus?: number }).httpStatus === "number"
          ? (e as { httpStatus?: number }).httpStatus
          : null;
    void recordBriefingFailure({
      userId: call.ctx.userId,
      reason:
        e instanceof AllProvidersFailedError
          ? "all-providers-failed"
          : "provider-error",
      locale: call.ctx.locale,
      httpStatus: failureHttpStatus,
      failureKind:
        e instanceof AllProvidersFailedError
          ? (e.attempts[0]?.failureKind ?? null)
          : providerFailureKind(e).failure,
    });
    return {
      ok: false,
      refusal:
        e instanceof AllProvidersFailedError
          ? chainRefusal(e)
          : providerRefusal(e),
    };
  }
}
