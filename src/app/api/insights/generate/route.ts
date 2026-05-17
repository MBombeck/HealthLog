import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
} from "@/lib/insights/features";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { compactSections } from "@/lib/insights/prompt-compact";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/insights/prompt";
import { getStrictInsightsSystemPrompt } from "@/lib/ai/prompts/insight-generator";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  resolveDashboardLayout,
  type ComparisonBaseline,
} from "@/lib/dashboard-layout";
import type { MeasurementType } from "@/generated/prisma/client";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { isLegacyInsightPayload } from "@/lib/ai/legacy-payload";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

const DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR = 10;

/**
 * Reads `INSIGHTS_RATE_LIMIT_PER_HOUR` from the environment with a
 * sensible 10/hour default. The previous hard-coded 2/hour limit (from
 * v1.4 P13) was too aggressive for users iterating on settings or
 * regenerating after adding measurements. Operators who run on a
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

/**
 * Per-status insight cache rows live in `audit_logs` keyed by
 * `action = "insights.{scope}-status.{locale}"` (see
 * `src/lib/insights/memory.ts` for the canonical scope list and
 * `src/lib/insights/{general,blood-pressure,weight,pulse,bmi,
 * mood,medication-compliance}-status.ts` for the writers). Each scope
 * has its own per-day eviction, so before v1.4.16 a force-regeneration
 * of the comprehensive insight would leave yesterday's per-status
 * cards visible on the insights page until the next calendar day
 * flipped. Drop them here so the next status fetch has to call the
 * LLM again with the same fresh feature set the comprehensive blob
 * just used.
 */
async function evictPerStatusInsightCache(userId: string): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      userId,
      action: { startsWith: "insights." },
      // Keep the `insights.generate` row this request just wrote and
      // the `insights.settings.*` rows — only the per-status cache
      // entries (`insights.<scope>-status.<locale>`) carry stale text.
      AND: [{ action: { contains: "-status." } }],
    },
  });
}

/**
 * v1.4.16 phase B8 — fetch the user's persisted comparison toggle and
 * build a `ComparisonSnapshot` for the prompt builder. Returns null
 * when comparison is off (most users), so the prompt builder skips
 * the context block entirely.
 *
 * Snapshot construction reuses the analytics `summarize()` helper
 * (which now emits `avg30LastMonth` + `avg30LastYear`) so the numbers
 * the LLM sees match the numbers the dashboard tile renders — no
 * second source of truth for the comparison delta.
 */
async function buildComparisonSnapshotForUser(
  userId: string,
): Promise<ComparisonSnapshot | null> {
  // The features payload doesn't carry prior-period values — pulling
  // a fresh `summarize()` per metric below keeps the snapshot
  // self-contained without retrofitting features.ts.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const baseline: ComparisonBaseline = layout.comparisonBaseline ?? "none";
  if (baseline === "none") return null;

  // Pull every measurement type once and run summarize() so the
  // prior-period averages line up with what the dashboard analytics
  // computes. Only include rows where the LLM can sensibly narrate
  // a prior comparison (i.e. the metric exists in our snapshot type
  // mapping below).
  const typeToSnapshotKey: Record<string, string> = {
    WEIGHT: "weight",
    BLOOD_PRESSURE_SYS: "bloodPressureSys",
    BLOOD_PRESSURE_DIA: "bloodPressureDia",
    PULSE: "pulse",
    BODY_FAT: "bodyFat",
    SLEEP_DURATION: "sleep",
    ACTIVITY_STEPS: "steps",
  };
  const typeUnits: Record<string, string> = {
    WEIGHT: "kg",
    BLOOD_PRESSURE_SYS: "mmHg",
    BLOOD_PRESSURE_DIA: "mmHg",
    PULSE: "bpm",
    BODY_FAT: "%",
    SLEEP_DURATION: "h",
    ACTIVITY_STEPS: "",
  };
  const types = Object.keys(typeToSnapshotKey) as MeasurementType[];
  const rows = await Promise.all(
    types.map(async (type) => {
      const measurements = await prisma.measurement.findMany({
        where: { userId, type },
        orderBy: { measuredAt: "asc" },
        select: { measuredAt: true, value: true },
      });
      const summary = summarize(
        measurements.map(
          (m): DataPoint => ({ date: m.measuredAt, value: m.value }),
        ),
      );
      const baselineAvg =
        baseline === "lastMonth"
          ? (summary.avg30LastMonth ?? null)
          : (summary.avg30LastYear ?? null);
      const currentAvg = summary.avg30 ?? null;
      const delta =
        currentAvg !== null && baselineAvg !== null
          ? Math.round((currentAvg - baselineAvg) * 100) / 100
          : null;
      const deltaPercent =
        delta !== null && baselineAvg !== null && baselineAvg !== 0
          ? Math.round((delta / Math.abs(baselineAvg)) * 100 * 10) / 10
          : null;
      return {
        type: typeToSnapshotKey[type] ?? type,
        currentAvg,
        baselineAvg,
        delta,
        deltaPercent,
        unit: typeUnits[type] ?? "",
      };
    }),
  );

  // Drop fully-empty rows (current AND baseline missing) so the prompt
  // doesn't pad with noise. Keep partial rows (one side null) — the
  // block renderer flags them with "no prior-period data available"
  // which is useful context for the model.
  const metrics = rows.filter(
    (row) => row.currentAvg !== null || row.baselineAvg !== null,
  );

  return { baseline, metrics };
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  // v1.4.31 — the advisor + daily briefing surfaces ride this
  // endpoint. Operator disables Coach, every advisor consumer
  // (briefing card, recommendations grid, hero strip narration)
  // empties out.
  await requireAssistantSurface("coach");
  const userId = user.id;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      // v1.4.36 W3 T3 — per-user opt-out list mirroring the Coach
      // settings. Filtered off `features` before serialisation so the
      // LLM never sees the excluded blocks.
      insightsExcludeMetrics: true,
      locale: true,
    },
  });

  const locale = await resolveServerLocale({
    request,
    userLocale: dbUser?.locale ?? user.locale ?? null,
  });

  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  if (
    !forceRefresh &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText);
      // v1.4.16 B5c: detect legacy payloads (pre-rationale) so the UI
      // can show a "regenerate for new explainability features" CTA.
      // We don't auto-regenerate — that would burn rate-limit tokens
      // on a cache-hit silently. User-initiated only.
      const legacyPayload = isLegacyInsightPayload(cached);
      annotate({
        action: { name: "insights.generate" },
        meta: { cached: true, legacyPayload },
      });
      return apiSuccess({
        insights: cached,
        cached: true,
        cachedAt: dbUser.insightsCachedAt,
        legacyPayload,
      });
    } catch {
      // Invalid cache, regenerate
    }
  }

  // P13: rate-limit check moved BELOW the cache return so a hit on the
  // 24h cache never burns one of the LLM-generation tokens. Otherwise a
  // noisy reload loop on the dashboard would lock out real refreshes
  // for an hour for no benefit.
  //
  // v1.4.16 A7: limit raised from 2 → 10 per hour (env-configurable via
  // `INSIGHTS_RATE_LIMIT_PER_HOUR`). The 2/hour limit triggered too
  // aggressively when a user iterated on settings or regenerated after
  // adding a few measurements; 10/hour still cleanly bounds cost while
  // staying out of the way for legitimate use.
  const limit = resolveInsightsRateLimit();
  const rl = await checkRateLimit(`insights:${userId}`, limit, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError(`Maximum ${limit} insight generations per hour.`, 429);
  }

  // v1.4.16 phase B5b: resolve the user's full provider chain so a hard
  // failure on the primary (401, 5xx, network) cascades to the next
  // configured fallback rather than surfacing a 503/422 to the
  // dashboard. Falls back to the single-provider resolution when the
  // chain comes back empty AND the legacy `aiProvider` field still
  // points at something usable — preserving v1.4.15 behaviour for
  // accounts that haven't customised the chain.
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    // Try the legacy single-provider path one more time so users who
    // configured AI before v1.4.16 don't suddenly see the 422.
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      return apiError(
        "No AI provider configured. Connect ChatGPT in settings or ask your admin to set up an API key.",
        422,
      );
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  // v1.4.36 W3 T1 — `extractFeatures` enforces a 5 MB ceiling on the
  // serialised payload. If the raw (bucketed) shape ever blows past
  // it (regression watch — the v1.4.35 rawMeasurements shape hit
  // 25.9 MB on Marc's account), the helper throws
  // `FeaturesPayloadTooLargeError`. We downgrade to the aggregated
  // shape rather than 500-ing so the user still gets an insight; the
  // annotate event surfaces the regression to ops via the Logflare
  // pipeline.
  let features: Awaited<ReturnType<typeof extractFeatures>>;
  let payloadDowngraded = false;
  let payloadOversizeBytes: number | null = null;
  // v1.4.36 QA H1 — extra fallback when even the aggregated shape
  // crosses the 5 MB ceiling (very large medication history + multi-
  // year context). Strips anthropometrics + medications + every other
  // exclude-token-mapped block and tries one more time. On a third
  // failure we return 422 with an annotate event for ops visibility
  // rather than 500-ing out of an uncaught throw.
  const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
    "anthropometrics",
    "medications",
    "compliance",
    "sleep",
    "steps",
    "hrv",
    "resting_hr",
  ];
  let payloadHardDowngraded = false;
  try {
    features = await extractFeatures(userId, includeRaw);
  } catch (err) {
    if (err instanceof FeaturesPayloadTooLargeError) {
      payloadDowngraded = true;
      payloadOversizeBytes = err.sizeBytes;
      try {
        features = await extractFeatures(userId, false);
      } catch (retryErr) {
        if (retryErr instanceof FeaturesPayloadTooLargeError) {
          // Aggregated shape ALSO crossed the ceiling. Drop optional
          // context blocks (anthropometrics, medications, sleep,
          // steps, hrv, resting_hr) via the existing exclude filter
          // and try once more.
          payloadHardDowngraded = true;
          payloadOversizeBytes = retryErr.sizeBytes;
          try {
            const aggregated = await extractFeatures(userId, false);
            features = applyInsightsExcludeFilter(
              aggregated,
              MAX_DOWNGRADE_TOKENS,
            );
          } catch (finalErr) {
            // Even the aggregated read itself blew up. Annotate and
            // return 422 rather than let the uncaught throw 500 out.
            annotate({
              meta: {
                insights_payload_too_large: true,
                insights_payload_oversize_bytes:
                  finalErr instanceof FeaturesPayloadTooLargeError
                    ? finalErr.sizeBytes
                    : payloadOversizeBytes,
              },
            });
            return apiError(
              "Your data exceeds the AI payload size limit. Reduce the data window or exclude optional blocks in Settings > AI.",
              422,
            );
          }
        } else {
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  }
  // v1.4.36 W3 T3 — apply the user's exclude-metrics opt-out list
  // BEFORE serialisation so the model never sees the dropped blocks.
  const excludeList = dbUser?.insightsExcludeMetrics ?? [];
  features = applyInsightsExcludeFilter(features, excludeList);
  // v1.4.36 W3 T4 — drop zero-row blocks so the prompt never carries
  // labelled-empty sections (`"sleep": []`, `"medications": []`,
  // etc.). Prevents the model from narrating "there are no
  // medications in your data" when the user explicitly excluded the
  // block.
  const compactFeatures = compactSections(
    features as unknown as Record<string, unknown>,
  );
  const featuresJson = JSON.stringify(compactFeatures, null, 2);
  if (payloadDowngraded) {
    annotate({
      meta: {
        insights_features_downgraded: true,
        insights_features_oversize_bytes: payloadOversizeBytes,
        insights_features_hard_downgraded: payloadHardDowngraded,
      },
    });
  }

  // v1.4.16 phase B8 — pick up the user's persisted comparison toggle
  // and, when active, build a compact prior-period snapshot from the
  // `features` summaries that already include `avg30LastMonth` /
  // `avg30LastYear` (added in the analytics summarize() helper). The
  // narrative is default-on whenever the toggle is on per research §7
  // Q4 — the pulldown is the single affordance.
  const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
  // v1.4.25 W4d — GLP-1 plateau detector. Appends a SYSTEM CONTEXT
  // block to the user prompt when the active GLP-1 medication has been
  // on a stable dose for ≥21 days with weight delta within ±0.5 kg.
  // The block instructs the model to emit a glp1_plateau keyFinding
  // framed observationally (no dose recommendation per GROUND RULE 13).
  // Returns null when no GLP-1 is active OR no plateau condition;
  // 99% of users land in the null branch and pay zero token cost.
  const plateauContext = await detectGlp1Plateau(userId);
  let userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
    comparisonSnapshot ?? undefined,
  );
  if (plateauContext) {
    userPrompt += buildGlp1PlateauPrompt(plateauContext, locale);
  }

  let result;
  let workingProviderType: string;
  let fallbackHopCount = 0;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        // The strict prompt (PROMPT_VERSION 4.20.x) carries GROUND RULE 8
        // — emit a top-level `dailyBriefing` block when the snapshot has
        // analysable signal — plus the trendAnnotations and
        // storyboardAnnotations rules. The legacy `getInsightsSystemPrompt`
        // returned the v1.4.5 `{changed, stable, drivers, …}` shape and
        // never asked the model for dailyBriefing, so the hero strip's
        // "Re-run analysis" button kept producing a payload with no
        // briefing block (Issue 1, v1.4.20 post-deploy). The route already
        // tolerates the strict shape via `insightResultSchema.safeParse`'s
        // soft fallback to `parsed` and `passthrough()` on the strict
        // schema, so switching the prompt does not break legacy callers.
        systemPrompt: getStrictInsightsSystemPrompt(locale),
        userPrompt,
        temperature: 0.3,
        maxTokens: 1500,
      },
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
    fallbackHopCount = fallback.fallbackHops.length;
  } catch (e) {
    if (e instanceof AllProvidersFailedError) {
      annotate({
        meta: {
          insights_chain_outcome: "all-failed",
          insights_chain_attempts: e.attempts.length,
          insights_chain_first_provider: e.attempts[0]?.providerType ?? null,
          insights_chain_first_status: e.attempts[0]?.httpStatus ?? null,
        },
      });
      // Pick the most specific user-facing message we can. Auth-class
      // failures across the entire chain mean every provider's
      // credential is bad — keep the v1.4.5 "check your API key"
      // wording so the user knows where to act. 429 across the chain
      // is rate-limit; 5xx is upstream brown-out; transport-only
      // (ECONNRESET, no httpStatus) maps to the generic connection
      // hint so users on flaky networks don't see "rate-limited".
      const allAuth = e.attempts.every(
        (a) => a.httpStatus === 401 || a.httpStatus === 403,
      );
      if (allAuth) {
        return apiError(
          "AI provider rejected the request — check your API key in Settings > AI",
          422,
        );
      }
      const all429 = e.attempts.every((a) => a.httpStatus === 429);
      if (all429) {
        return apiError("AI provider rate-limited the request", 429);
      }
      const has5xx = e.attempts.some(
        (a) => a.httpStatus !== null && a.httpStatus >= 500,
      );
      if (has5xx) {
        return apiError(
          "AI provider temporarily unavailable, try again in a moment",
          503,
        );
      }
      const allTransport = e.attempts.every(
        (a) => a.httpStatus === null || a.httpStatus <= 0,
      );
      if (allTransport) {
        return apiError(
          "AI provider connection failed — check your AI settings",
          422,
        );
      }
      return apiError(
        "AI provider temporarily unavailable, try again in a moment",
        503,
      );
    }
    // v1.4.6 T5 mapped only the parse-error branch from 502→422. Non-
    // hard provider errors (e.g. a custom 4xx from a self-hosted local
    // model) still propagate here. Cloudflare rewrites 5xx to its own
    // HTML error page, which breaks `await res.json()` on the
    // dashboard. Mirror the v1.4.5 ai/test categorisation.
    const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
    annotate({
      meta: {
        insights_provider_error: err.message.slice(0, 500),
        insights_provider_status: err.httpStatus ?? null,
        insights_provider_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
      },
    });
    const status = err.httpStatus ?? 0;
    if (status === 401 || status === 403) {
      return apiError(
        "AI provider rejected the request — check your API key in Settings > AI",
        422,
      );
    }
    if (status === 429) {
      return apiError("AI provider rate-limited the request", 429);
    }
    if (status >= 500) {
      return apiError(
        "AI provider temporarily unavailable, try again in a moment",
        503,
      );
    }
    return apiError(
      "AI provider connection failed — check your AI settings",
      422,
    );
  }

  let insights: InsightResult | Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.content);
    // Try new schema first, fall back to raw parsed if validation fails
    const validated = insightResultSchema.safeParse(parsed);
    insights = validated.success ? validated.data : parsed;
  } catch {
    // Returning 502 here triggers Cloudflare's HTML error rewrite, which
    // breaks `await res.json()` on the client side. 422 stays passthrough
    // so the React Query mutation can read the JSON body and surface a
    // readable message. Same fix pattern as v1.4.5 ai/test.
    return apiError("AI response was not valid JSON", 422);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });

  // v1.4.16 A7: a fresh comprehensive insight always supersedes the
  // per-status cache. Otherwise the dashboard re-paints itself with the
  // newly generated comprehensive while the insights-page status cards
  // still show yesterday's text until midnight Berlin time.
  await evictPerStatusInsightCache(userId);

  await auditLog("insights.generate", {
    userId,
    ipAddress: getClientIp(request),
    details: {
      privacyMode: dbUser?.insightsPrivacyMode,
      tokensUsed: result.tokensUsed,
      providerType: result.providerType,
      chainProviderType: workingProviderType,
      fallbackHopCount,
      model: result.model,
    },
  });

  annotate({
    action: { name: "insights.generate" },
    meta: {
      cached: false,
      providerType: result.providerType,
      chainProviderType: workingProviderType,
      fallbackHopCount,
      model: result.model,
      tokensUsed: result.tokensUsed,
    },
  });

  return apiSuccess({ insights, cached: false, legacyPayload: false });
});
