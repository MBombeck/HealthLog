/**
 * GET /api/insights/generate — the read-only advisor briefing; POST — an
 * on-demand generation. Both live in `src/lib/insights/briefing-request/`;
 * this file keeps the gates, the body, the hourly quota and the statuses.
 *
 * Refs #786 — async-truth contract, server end (the client end lives in
 * `src/components/insights/use-insights-advisor.ts`, `AdvisorSettleState`):
 * the force POST generates INLINE and, on success, writes the fresh briefing
 * to the user cache (`insightsCachedAt` advances) — even when the client has
 * long since aborted its 45 s request. A failed inline generation writes a
 * failure marker the GET reports as `generationFailed`. The client relies on
 * exactly those two signals to settle a timed-out regenerate: it polls the
 * GET until `cachedAt` advances past its baseline (success) or a NEWER
 * failure marker appears (honest error). Renaming or short-circuiting either
 * write breaks that convergence — the settling seam tests pin the client
 * half, this comment and `briefing-request/commit.ts` the server half.
 */
import { NextRequest } from "next/server";

import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AI_PROVIDER_NONE_ERROR_CODE } from "@/lib/ai/capabilities/types";
import { withFeatureCacheScope } from "@/lib/insights/feature-cache";
import {
  briefingFromCache,
  serveCachedFallback,
} from "@/lib/insights/briefing-request/cache";
import {
  loadGenerationContext,
  type BriefingRefusal,
} from "@/lib/insights/briefing-request/context";
import {
  generateBriefing,
  resolveConsentedBriefingChain,
} from "@/lib/insights/briefing-request/generate";
import { readAdvisorBriefing } from "@/lib/insights/briefing-request/read";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR = 10;

/**
 * Reads `INSIGHTS_RATE_LIMIT_PER_HOUR` from the environment with a
 * sensible 10/hour default. A hard-coded 2/hour limit was too aggressive
 * for users iterating on settings or regenerating after adding
 * measurements. Operators who run on a
 * stricter LLM budget can dial it down via env without redeploying
 * code; values <1 fall back to the default.
 */
export function resolveInsightsRateLimit(): number {
  const raw = process.env.INSIGHTS_RATE_LIMIT_PER_HOUR;
  if (!raw) return DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR;
  }
  return parsed;
}

const PROVIDER_REJECTED =
  "AI provider rejected the request. Check your API key in Settings > AI";
const PROVIDER_UNAVAILABLE =
  "AI provider temporarily unavailable, try again in a moment";

/**
 * The answer for each way a generation ends without a briefing. A 502 from
 * a provider would be rewritten by Cloudflare into an HTML page the client
 * cannot parse, so provider failures answer 422 / 429 / 503 instead.
 */
const REFUSALS: Record<
  BriefingRefusal,
  { message: string; status: number; errorCode?: string }
> = {
  "payload-too-large": {
    message:
      "Your data exceeds the AI payload size limit. Reduce the data window or exclude optional blocks in Settings > AI.",
    status: 422,
  },
  // The day's token ceiling: no provider was contacted. The hourly rate
  // limit bounds request frequency; this bounds cost, with its own code so
  // the client can say so.
  "budget-exceeded": {
    message:
      "Daily AI token budget reached. Insights will be available again tomorrow.",
    status: 429,
    errorCode: "insights.generate.budgetExceeded",
  },
  "provider-rejected": { message: PROVIDER_REJECTED, status: 422 },
  "provider-rate-limited": {
    message: "AI provider rate-limited the request",
    status: 429,
  },
  "provider-unavailable": { message: PROVIDER_UNAVAILABLE, status: 503 },
  "provider-connection": {
    message: "AI provider connection failed. Check your AI settings",
    status: 422,
  },
  "response-truncated": {
    message:
      "AI response was cut off before the JSON completed. Raise the token limit (INSIGHTS_MAX_TOKENS)",
    status: 422,
    errorCode: "ai_response_truncated",
  },
  "response-invalid-json": {
    message: "AI response was not valid JSON",
    status: 422,
  },
  "outbound-screened": {
    message:
      "The generated insight did not pass the safety check and was discarded. Try regenerating.",
    status: 502,
    errorCode: "insights.generate.outboundScreened",
  },
  "profile-scope-changed": {
    message: "Profile scope changed during insight generation",
    status: 409,
    errorCode: "insights.generate.profileScopeChanged",
  },
  "scope-changed": {
    message: "Insight scope changed during generation",
    status: 409,
    errorCode: "insights.generate.scopeChanged",
  },
};

function refuse(refusal: BriefingRefusal) {
  const { message, status, errorCode } = REFUSALS[refusal];
  return errorCode
    ? apiError(message, status, { errorCode })
    : apiError(message, status);
}

/**
 * GET — read-only advisor read: the cached payload, never a provider call.
 *
 * A pure AI read: the payload is the model-written briefing and nothing
 * else, so it keeps a typed refusal rather than answering 200 with nothing.
 * The `briefing` capability is required (operator switch, the AI analysis
 * opt-out, provider presence, consent); an unavailable one refuses with the
 * capability envelope (`assistant.disabled.briefing`, `module.disabled`,
 * `consent.ai.required`, `ai.provider.none` 422, …) before the cache is read,
 * so stored briefing text is never served and no warm is enqueued.
 *
 * `userId` is narrowed from the session / Bearer — never a body field.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  // The briefing is its own capability, not the Coach's: a user with the
  // Coach hidden still reads their briefing, and one who opted out of AI
  // analysis does not.
  await requireAiCapability("briefing");
  return apiSuccess(
    await readAdvisorBriefing({
      request,
      userId: user.id,
      userLocale: user.locale ?? null,
    }),
  );
});

export const POST = apiHandler((request: NextRequest) =>
  // A request-scoped feature cache, so the bounded feature read is computed
  // once and reused across the downgrade ladder (and any sibling consumer)
  // for this request.
  withFeatureCacheScope(async () => {
    const { user } = await requireAuth();
    // The `briefing` capability, before any read or provider work. Refused
    // with the capability envelope; no provider is `ai.provider.none` on the
    // 422 this route has always used for it.
    await requireAiCapability("briefing");
    const userId = user.id;

    const ctx = await loadGenerationContext({
      request,
      userId,
      userLocale: user.locale ?? null,
    });

    const { data: body, error: jsonError } = await safeJson<{
      force?: unknown;
    }>(request, { maxBytes: 16 * 1024 });
    if (jsonError) return jsonError;
    const forceRefresh = body.force === true;

    const decision = await briefingFromCache(ctx, forceRefresh);
    if (decision.kind === "serve") return apiSuccess(decision.data);

    // The rate limit sits BELOW the cache return so a hit on the 24 h cache
    // never burns one of the generation tokens; otherwise a noisy reload
    // loop on the dashboard would lock out real refreshes for an hour.
    const limit = resolveInsightsRateLimit();
    const rl = await checkRateLimit(
      `insights:${userId}`,
      limit,
      60 * 60 * 1000,
    );
    if (!rl.allowed) {
      // A POST-as-read caller whose fresh-but-briefingless cache fell
      // through to regeneration degrades to the cached payload when the
      // hourly quota is exhausted, instead of surfacing a 429 it never used
      // to see. Explicit `force` keeps the honest 429.
      if (decision.fallback !== null) {
        return apiSuccess(await serveCachedFallback(ctx, decision.fallback));
      }
      return apiError(`Maximum ${limit} insight generations per hour.`, 429);
    }

    // The chain, with the consent gate on it (403 `consent.ai.required`
    // before any server-managed external egress).
    const chain = await resolveConsentedBriefingChain(userId);
    if (chain === null) {
      return apiError(
        "No AI provider configured. Connect ChatGPT in settings or ask your admin to set up an API key.",
        422,
        { errorCode: AI_PROVIDER_NONE_ERROR_CODE },
      );
    }

    const outcome = await generateBriefing({
      ctx,
      chain,
      ipAddress: getClientIp(request),
    });
    return outcome.ok ? apiSuccess(outcome.data) : refuse(outcome.refusal);
  }),
);
