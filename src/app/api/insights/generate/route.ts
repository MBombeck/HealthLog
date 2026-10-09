/**
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
 * half, this comment is the server half of the contract.
 */
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import {
  generatedOnLocalToday,
  insightsPayloadForToday,
} from "@/lib/daily/briefing-today-read";
import { withBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
  BRIEFING_FEATURE_WINDOW_DAYS,
} from "@/lib/insights/features";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import {
  getCachedFeatures,
  withFeatureCacheScope,
} from "@/lib/insights/feature-cache";
import {
  buildBriefingIllnessCycleContext,
  buildBriefingIllnessCyclePrompt,
} from "@/lib/insights/illness-cycle-briefing";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  detectDerivedBriefingSignals,
  buildDerivedBriefingPrompt,
} from "@/lib/insights/derived-briefing";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { buildUserPrompt } from "@/lib/ai/prompts/insight-system-prompt";
import {
  buildSystemPromptWithReferences,
  buildBriefingPersonalisationBlock,
} from "@/lib/ai/prompts/insight-generator";
import {
  buildAboutMeInsightBlock,
  getSelfContextTextForUser,
} from "@/lib/ai/coach/about-me";
import { metricsFromPresentSections } from "@/lib/ai/medical-references";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { AI_BUDGETS, resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import {
  recordBriefingFailure,
  readBriefingFailure,
} from "@/lib/insights/briefing-failure-marker";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";
import {
  BriefingBudgetExceededError,
  runBriefingCompletion,
} from "@/lib/insights/briefing-provider";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import { screenInsightPayloadProse } from "@/lib/ai/safety/insight-payload-screen";
import {
  findUngroundedBriefingNumbers,
  readBriefingBlock,
  buildBriefingGroundingCorrection,
} from "@/lib/ai/briefing-grounding";
import { isLegacyInsightPayload } from "@/lib/ai/legacy-payload";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AI_PROVIDER_NONE_ERROR_CODE } from "@/lib/ai/capabilities/types";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { toProfileSex } from "@/lib/profile/sex";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { featuresInReaderUnits } from "@/lib/insights/features-units";
import { resolveUnitPreferences } from "@/lib/measurements/display-transform";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
// v1.28.25 — the comparison-snapshot builder was a private near-copy of
// the lib export (drifted only in comments); the route now shares the
// one implementation the nightly warm pass uses.
import {
  buildComparisonSnapshotForUser,
  enqueueStatusRefillForUser,
} from "@/lib/insights/comprehensive-generate";
import { cachedPayloadCarriesBriefing } from "@/lib/insights/briefing-payload";

export const dynamic = "force-dynamic";

/**
 * Briefing freshness window for the read-only GET. A cached briefing read
 * this recently is fresh and triggers no warm; older / missing enqueues an
 * out-of-band regeneration. Mirrors the 24 h cache-hit window the POST path
 * honours so the two stay consistent.
 */
const BRIEFING_FRESH_MS = 24 * 60 * 60 * 1000;

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
 * GET /api/insights/generate — read-only advisor read.
 *
 * The advisor consumers (hero strip, daily-briefing card, trends row) used
 * to mount against the POST handler, which generates inline on a cache miss
 * and blocks the page-load path on the full provider chain (up to the
 * client's 8 s abort). This read-only GET serves the cached payload from
 * `User.insightsCachedText` immediately — NEVER calling the provider — and,
 * when the cache is stale / missing AND a provider is configured, enqueues
 * an out-of-band warm (the same `insight-pregenerate` queue the nightly
 * cron and the "prepare assessments" button use). The next read reflects
 * the fresh briefing. User-initiated regeneration stays on the POST path.
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
  // The briefing is its own capability now, not the Coach's: a user with the
  // Coach hidden still reads their briefing, and one who opted out of AI
  // analysis does not.
  await requireAiCapability("briefing");
  const userId = user.id;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsCachedAt: true,
      insightsCachedText: true,
      insightsCachedLocale: true,
      locale: true,
      timezone: true,
    },
  });

  // Resolve the locale the caller is actually reading (cookie /
  // Accept-Language fall-back when `User.locale` is unset) and validate it
  // against the shipped list — the same convention the nightly's
  // `normalizeLocale` and the status routes follow. The previous
  // `(locale) === "en" ? "en" : "de"` collapsed a NULL `User.locale`
  // to German even for a client reading the app in English, so the
  // visit-triggered warm filled the wrong cache family.
  const readerLocale = normalizeLocale(
    await resolveServerLocale({
      request,
      userLocale: dbUser?.locale ?? user.locale ?? null,
    }),
  );

  // The cache is one slot per user. Text written in another language is
  // never the reader's briefing, however fresh: treat the slot as empty for
  // prose, and re-warm in the reader's language below. An untagged row
  // predates the tag and is served as before.
  const languageMismatch =
    dbUser?.insightsCachedLocale != null &&
    dbUser.insightsCachedLocale !== readerLocale;

  const cachedAt = dbUser?.insightsCachedAt ?? null;
  const timezone = dbUser?.timezone ?? DEFAULT_TIMEZONE;
  // Fresh means written today on the reader's calendar, by the moment the
  // text was generated: `insightsCachedAt` also moves when an unchanged
  // warm only re-stamps yesterday's text.
  const generatedToday = generatedOnLocalToday(
    readBriefingGeneratedAt(dbUser?.insightsCachedText ?? null),
    timezone,
    new Date(),
  );
  const isFresh =
    !languageMismatch &&
    cachedAt !== null &&
    generatedToday &&
    Date.now() - cachedAt.getTime() < BRIEFING_FRESH_MS;

  // v1.18.9 (#4) — resolve provider availability once, up front. The
  // read path never blocks on or generates through the provider, but it
  // must REPORT whether one exists: a provider-less account's cached
  // briefing freezes at the last successful generation (the pregenerate
  // cron can't refill it), and the UI presented that stale text as
  // current. Surfacing `hasProvider: false` lets the insights surfaces
  // pair the honest "Stand: vor X Tagen" age with a discreet
  // connect-an-AI-provider hint instead of implying the read is live.
  const hasProvider = await hasUsableStatusProvider(userId);

  // v1.25 — surface whether the most recent generation attempt failed (a
  // marker newer than the last successful generation). The briefing keeps its
  // last good text on failure, so this is the only honest signal that a shown
  // briefing is held rather than freshly refreshed — and, when there is no
  // last good text, that the empty state should read "couldn't generate" with
  // a retry rather than the generic "no briefing yet".
  const briefingFailure = await readBriefingFailure({
    userId,
    since: cachedAt,
  });
  // v1.28.30 — a `briefing-ungrounded` marker is NOT a failure: the
  // generation succeeded but the grounding gate withheld the briefing
  // (marker written after the cache write, so it survives the `since`
  // filter). Surface it as the persistent omission signal — the card's
  // "briefing withheld" state used to exist only on the transient POST
  // response, so a nightly strip read as a silent generic empty card.
  const briefingOmittedReason: "ungrounded" | null =
    briefingFailure?.reason === "briefing-ungrounded" ? "ungrounded" : null;
  const generationFailed =
    briefingFailure !== null && briefingOmittedReason === null;
  // v1.25.3 — the failure class lets the empty state point its hint at the
  // right lever (raise the response timeout vs re-check the provider).
  const generationFailureClass = generationFailed
    ? (briefingFailure?.failureClass ?? null)
    : null;

  // Read-only: never block on the provider. Warm out of band only when the
  // cached briefing is stale / missing AND a provider is configured (a
  // provider-less account costs one cheap chain-resolve and shows the
  // empty / connect-AI state instead of a wasted enqueue).
  let revalidating = false;
  if (!isFresh && hasProvider) {
    void enqueueForceWarm({ userId, locale: readerLocale });
    revalidating = true;
  }

  if (dbUser?.insightsCachedText && !languageMismatch) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText);
      const legacyPayload = isLegacyInsightPayload(cached);
      annotate({
        action: { name: "insights.generate.read" },
        meta: { cached: true, legacyPayload, revalidating, hasProvider },
      });
      return apiSuccess({
        // The briefing as every surface serves it: today's text only, its
        // signals measured today, its deltas at display precision.
        insights: await insightsPayloadForToday(cached, {
          userId,
          timezone,
          language: readerLocale,
        }),
        cached: true,
        cachedAt,
        legacyPayload,
        // Honest stale-serve marker: true while the out-of-band warm is
        // in flight, so the client can poll (bounded) until the fresh
        // briefing lands instead of sitting on the stale payload for the
        // rest of the session.
        revalidating,
        // v1.18.9 (#4) — false when no AI provider is configured anywhere:
        // the served briefing can never refresh, so the UI pairs its age
        // with a connect-provider affordance.
        hasProvider,
        // v1.25 — true when the last generation attempt failed (held text).
        generationFailed,
        // v1.25.3 — coarse failure class for the empty-state hint (null when
        // the last attempt succeeded).
        generationFailureClass,
        // v1.28.30 — persistent grounding-omission signal (see above), so a
        // nightly-stripped briefing renders "withheld", not "no briefing yet".
        briefingOmittedReason,
      });
    } catch {
      // Invalid cache row — fall through to the empty payload below. The
      // warm enqueue above (when a provider exists) repairs it for the
      // next read.
    }
  }

  annotate({
    action: { name: "insights.generate.read" },
    meta: {
      cached: false,
      revalidating,
      hasProvider,
      languageMismatch,
      readerLocale,
    },
  });
  return apiSuccess({
    insights: null,
    cached: false,
    legacyPayload: false,
    revalidating,
    // v1.18.9 (#4) — see the cached branch above.
    hasProvider,
    // v1.25 — no last-good text AND the last attempt failed: the UI shows a
    // "couldn't generate" empty state with a retry instead of the generic one.
    generationFailed,
    // v1.25.3 — coarse failure class for the empty-state hint.
    generationFailureClass,
    // v1.28.30 — see the cached branch above.
    briefingOmittedReason,
  });
});

export const POST = apiHandler((request: NextRequest) =>
  // v1.18.11 P3 — open a request-scoped feature cache so the bounded feature
  // read is computed once and reused across the downgrade ladder (and any
  // sibling consumer) for this request.
  withFeatureCacheScope(async () => {
    const { user } = await requireAuth();
    // The `briefing` capability, before any read or provider work. Refused
    // with the capability envelope; no provider is `ai.provider.none` on the
    // 422 this route has always used for it.
    await requireAiCapability("briefing");
    const userId = user.id;

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        insightsPrivacyMode: true,
        insightsCachedAt: true,
        insightsCachedText: true,
        insightsCachedLocale: true,
        timezone: true,
        // v1.4.36 W3 T3 — per-user opt-out list mirroring the Coach
        // settings. Filtered off `features` before serialisation so the
        // LLM never sees the excluded blocks.
        insightsExcludeMetrics: true,
        locale: true,
        // v1.10.0 — profile for the derived-signal briefing detector.
        dateOfBirth: true,
        gender: true,
        heightCm: true,
        // v1.22 (W6) — first name for the sparse, hash-gated briefing opener.
        displayName: true,
        // v1.25 — per-user response-timeout (seconds), threaded onto the
        // generation calls so a slow self-hosted backend honours the setting.
        aiResponseTimeoutSeconds: true,
        // The reader's units; the feature set is converted into them before
        // it is serialised, hashed and checked for grounding.
        unitPreference: true,
        glucoseUnit: true,
      },
    });
    const modeAtRead = dbUser?.insightsPrivacyMode ?? "aggregated";
    // v1.34 — the commit guard below (line ~966) matches on these exact
    // columns instead of the broad `updatedAt` timestamp. Every User write
    // bumps `updatedAt`, including `resolveProviderChain()`'s OAuth
    // token-refresh update later in this same request — keying the
    // optimistic-concurrency check on it produced a false 409 whenever a
    // provider credential happened to refresh mid-generation. These are
    // exactly the columns selected above that feed the prompt built below;
    // capturing them here and requiring an exact match at commit still
    // catches a genuine privacy-mode / exclude-list / locale / profile
    // change without colliding on unrelated column writes.
    const excludeMetricsAtRead = dbUser?.insightsExcludeMetrics ?? [];
    const localeAtRead = dbUser?.locale ?? null;
    const dateOfBirthAtRead = dbUser?.dateOfBirth ?? null;
    const genderAtRead = dbUser?.gender ?? null;
    const heightCmAtRead = dbUser?.heightCm ?? null;
    const displayNameAtRead = dbUser?.displayName ?? null;

    const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
      dbUser?.aiResponseTimeoutSeconds,
      AI_BUDGETS.comprehensive.timeoutMs,
    );

    const locale = await resolveServerLocale({
      request,
      userLocale: dbUser?.locale ?? user.locale ?? null,
    });
    const postTimezone = dbUser?.timezone ?? DEFAULT_TIMEZONE;

    const { data: body, error: jsonError } = await safeJson<{
      force?: unknown;
    }>(request, { maxBytes: 16 * 1024 });
    if (jsonError) return jsonError;
    const forceRefresh = body.force === true;

    // v1.28.30 — a fresh cache WITHOUT a briefing must not satisfy a
    // briefing-expecting caller: after a failed nightly warm the cached
    // payload can sit inside the 24 h window all day, and the old
    // unconditional short-circuit served it to every POST (three
    // regenerate attempts, three `cached: true` responses, zero
    // generations). The short-circuit now holds only when the cached
    // payload actually carries a briefing OR the account has no usable
    // provider (regenerating would be futile — serve what exists). The
    // read-only GET is untouched: it never generates and its out-of-band
    // revalidation behaviour stays as-is. When the briefingless fall-
    // through is rate-limited below, the cached payload is served after
    // all so a POST-as-read client degrades to the old behaviour instead
    // of a 429.
    let briefinglessCacheFallback: {
      cached: unknown;
      legacyPayload: boolean;
      cachedAt: Date;
    } | null = null;
    // A cache tagged with another language is not this reader's cache and
    // never short-circuits; the generation below writes the reader's own.
    const cachedLocaleMatches =
      dbUser?.insightsCachedLocale == null ||
      dbUser.insightsCachedLocale === locale;
    if (
      !forceRefresh &&
      dbUser?.insightsCachedAt &&
      dbUser.insightsCachedText &&
      cachedLocaleMatches &&
      Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
    ) {
      try {
        const cached = JSON.parse(dbUser.insightsCachedText);
        // v1.4.16 B5c: detect legacy payloads (pre-rationale) so the UI
        // can show a "regenerate for new explainability features" CTA.
        // We don't auto-regenerate — that would burn rate-limit tokens
        // on a cache-hit silently. User-initiated only.
        const legacyPayload = isLegacyInsightPayload(cached);
        // A briefing generated on an earlier day is not today's read: like
        // a briefingless cache, it does not short-circuit a provider-backed
        // account, and degrades to the cached payload on a 429 below.
        const carriesBriefing =
          cachedPayloadCarriesBriefing(dbUser.insightsCachedText) &&
          generatedOnLocalToday(
            readBriefingGeneratedAt(dbUser.insightsCachedText),
            postTimezone,
            new Date(),
          );
        if (carriesBriefing || !(await hasUsableStatusProvider(userId))) {
          annotate({
            action: { name: "insights.generate" },
            meta: {
              cached: true,
              legacyPayload,
              briefingless: !carriesBriefing,
            },
          });
          return apiSuccess({
            insights: await insightsPayloadForToday(cached, {
              userId,
              timezone: postTimezone,
              language: locale,
            }),
            cached: true,
            cachedAt: dbUser.insightsCachedAt,
            legacyPayload,
          });
        }
        briefinglessCacheFallback = {
          cached,
          legacyPayload,
          cachedAt: dbUser.insightsCachedAt,
        };
        annotate({
          action: { name: "insights.generate.briefingless_cache_bypassed" },
          meta: { locale },
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
    const rl = await checkRateLimit(
      `insights:${userId}`,
      limit,
      60 * 60 * 1000,
    );
    if (!rl.allowed) {
      // v1.28.30 — a POST-as-read caller whose fresh-but-briefingless cache
      // fell through to regeneration degrades to the cached payload when
      // the hourly quota is exhausted, instead of surfacing a 429 it never
      // used to see. Explicit `force` keeps the honest 429.
      if (briefinglessCacheFallback !== null) {
        annotate({
          action: { name: "insights.generate" },
          meta: { cached: true, rate_limited_fallback: true },
        });
        return apiSuccess({
          insights: await insightsPayloadForToday(
            briefinglessCacheFallback.cached,
            { userId, timezone: postTimezone, language: locale },
          ),
          cached: true,
          cachedAt: briefinglessCacheFallback.cachedAt,
          legacyPayload: briefinglessCacheFallback.legacyPayload,
        });
      }
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
          { errorCode: AI_PROVIDER_NONE_ERROR_CODE },
        );
      }
      chain.push({ providerType: "admin-openai", instance: legacy });
    }

    // v1.12.1 — consent gate before any server-managed external egress.
    // Required for the operator's global key (`admin-openai`); BYOK / local /
    // ChatGPT-OAuth chains stay ungated. Throws ConsentRequiredError →
    // apiHandler returns 403 + `consent.ai.required`.
    await assertConsentForChain({ userId, chain, surface: "insights" });

    const includeRaw = dbUser?.insightsPrivacyMode === "raw";
    // v1.4.36 W3 T1 — `extractFeatures` enforces a 5 MB ceiling on the
    // serialised payload. If the raw (bucketed) shape ever blows past
    // it (regression watch — the v1.4.35 rawMeasurements shape hit
    // 25.9 MB on the largest tenant), the helper throws
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
    // v1.18.11 P1 — bound the briefing's bulk feature read to a recent window
    // (all-time extremes are sourced separately, see features.ts). The downgrade
    // ladder below stays as the safety net for the rare oversize payload.
    const featureWindow = { sinceDays: BRIEFING_FEATURE_WINDOW_DAYS };
    try {
      // v1.18.11 P3 — compute-once-per-request: the scope opened around this
      // handler shares the bounded feature read across the downgrade ladder.
      features = await getCachedFeatures({
        userId,
        includeRaw,
        sinceDays: featureWindow.sinceDays,
        compute: () => extractFeatures(userId, includeRaw, featureWindow),
      });
    } catch (err) {
      if (err instanceof FeaturesPayloadTooLargeError) {
        payloadDowngraded = true;
        payloadOversizeBytes = err.sizeBytes;
        try {
          features = await getCachedFeatures({
            userId,
            includeRaw: false,
            sinceDays: featureWindow.sinceDays,
            compute: () => extractFeatures(userId, false, featureWindow),
          });
        } catch (retryErr) {
          if (retryErr instanceof FeaturesPayloadTooLargeError) {
            // Aggregated shape ALSO crossed the ceiling. Drop optional
            // context blocks (anthropometrics, medications, sleep,
            // steps, hrv, resting_hr) via the existing exclude filter
            // and try once more.
            payloadHardDowngraded = true;
            payloadOversizeBytes = retryErr.sizeBytes;
            try {
              const aggregated = await getCachedFeatures({
                userId,
                includeRaw: false,
                sinceDays: featureWindow.sinceDays,
                compute: () => extractFeatures(userId, false, featureWindow),
              });
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
    // The reader's units, after all canonical arithmetic: the prompt, the
    // stored hash and the grounding check read the same converted figures.
    const units = resolveUnitPreferences({
      unitPreference: dbUser?.unitPreference,
      glucoseUnit: dbUser?.glucoseUnit,
    });
    features = featuresInReaderUnits(features, units);
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
      userPrompt += buildGlp1PlateauPrompt(
        plateauContext,
        locale,
        units.system,
      );
    }
    // v1.15.20 — fold the user-authored "about me" self-description
    // (Settings → AI) into the briefing as a delimited, user-provided
    // SYSTEM CONTEXT block. Null (no text / undecryptable) costs nothing.
    const aboutMe = await getSelfContextTextForUser(userId, locale);
    if (aboutMe) {
      userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
    }
    // v1.10.0 — fold a notable derived wellness signal (readiness / recovery
    // shift, confidence-gated) into the briefing as a SYSTEM CONTEXT block.
    // Reads the one derived contract; null (the common case) costs nothing.
    const derivedSex = toProfileSex(dbUser?.gender);
    const derivedBriefing = await detectDerivedBriefingSignals(userId, {
      ageYears: getAgeFromDateOfBirth(dbUser?.dateOfBirth ?? null),
      sex: derivedSex,
      heightCm: dbUser?.heightCm ?? null,
    });
    if (derivedBriefing) {
      userPrompt += buildDerivedBriefingPrompt(derivedBriefing, locale);
    }

    // v1.18.11 P5 — fold illness-episode + cycle state into the briefing so a
    // mid-illness or mid-cycle user gets context-aware prose. Reuses the same
    // server-authoritative builders the Coach assembles; both are module-gated
    // and short-circuit to null (zero token cost) for users without them.
    const illnessCycleCtx = await buildBriefingIllnessCycleContext(
      userId,
      dbUser?.gender ?? null,
      await resolveUserTimezone(userId),
    );
    if (illnessCycleCtx) {
      userPrompt += buildBriefingIllnessCyclePrompt(illnessCycleCtx, locale);
    }

    // v1.22 (W6) — opener-archetype rotation + sparse first-name personalization
    // (deterministic per user+day; omitted for unnamed accounts).
    userPrompt += buildBriefingPersonalisationBlock(
      userId,
      dbUser?.displayName ?? null,
      locale,
      await resolveUserTimezone(userId),
    );

    // v1.12.7 (B5) — inject the curated SOURCES block for the metric sections
    // this briefing actually carries, so a normative claim can cite a real
    // `referenceId` the schema + UI footnote already support. Returns the plain
    // prompt unchanged when no applicable metric section is present.
    const referenceMetrics = metricsFromPresentSections({
      bloodPressure: features.bloodPressure != null,
      weight: features.weight != null,
      pulse: features.pulse != null,
      mood: features.mood != null,
      medication: (features.medications?.length ?? 0) > 0,
    });

    let result;
    let workingProviderType: string;
    let fallbackHopCount = 0;
    try {
      const fallback = await runBriefingCompletion({
        userId,
        chain,
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
        systemPrompt: buildSystemPromptWithReferences(locale, referenceMetrics),
        userPrompt,
        temperature: 0.3,
        // v1.28.28 (#470) — env-tunable output ceiling (INSIGHTS_MAX_TOKENS,
        // default 2500). The old fixed 1500 truncated verbose models'
        // briefing JSON mid-string → generic invalid-JSON 422.
        maxTokens: resolveInsightsMaxTokens(),
        // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
        // generation is not aborted at the client's 60 s default on large
        // accounts (which returned an empty briefing + trend narrative).
        // v1.25 — honours the per-user response-timeout setting.
        timeoutMs: effectiveTimeoutMs,
        stage: "generate",
        // v1.41 — a briefing asked for by hand reasons exactly like the
        // scheduled one; the retries below repair a reply and do not.
        reasoningJob: "daily_briefing",
      });
      result = fallback.result;
      workingProviderType = fallback.workingProvider.providerType;
      fallbackHopCount = fallback.fallbackHops.length;
    } catch (e) {
      // The day's token ceiling refused the reservation — no provider was
      // contacted, so this is NOT a provider failure and must not record a
      // briefing-failure marker (which would make the read path claim the
      // refresh broke). The hourly rate limit bounds request frequency; this
      // bounds cost. 429 with a distinct code so the client can say so.
      if (e instanceof BriefingBudgetExceededError) {
        return apiError(
          "Daily AI token budget reached. Insights will be available again tomorrow.",
          429,
          { errorCode: "insights.generate.budgetExceeded" },
        );
      }
      // v1.25 — record a dated failure marker (no cache row is written on this
      // path, so the last good briefing stays intact). The read path pairs the
      // preserved text with a discreet "couldn't refresh" hint, or shows a
      // retry empty state when there is no last good text.
      // v1.25.3 — carry the upstream status so the read-path hint can tell an
      // auth / rate-limit failure apart from a plain timeout. For an
      // all-providers-failed error the first hop's status is the most
      // representative; a single provider error exposes its own `httpStatus`.
      const failureHttpStatus =
        e instanceof AllProvidersFailedError
          ? (e.attempts[0]?.httpStatus ?? null)
          : typeof (e as { httpStatus?: number }).httpStatus === "number"
            ? (e as { httpStatus?: number }).httpStatus
            : null;
      void recordBriefingFailure({
        userId,
        reason:
          e instanceof AllProvidersFailedError
            ? "all-providers-failed"
            : "provider-error",
        locale,
        httpStatus: failureHttpStatus,
      });
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
            "AI provider rejected the request. Check your API key in Settings > AI",
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
            "AI provider connection failed. Check your AI settings",
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
          insights_provider_body_excerpt:
            err.bodyExcerpt?.slice(0, 500) ?? null,
        },
      });
      const status = err.httpStatus ?? 0;
      if (status === 401 || status === 403) {
        return apiError(
          "AI provider rejected the request. Check your API key in Settings > AI",
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
        "AI provider connection failed. Check your AI settings",
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
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      // v1.28.28 (#470) — truncation-aware: `finishReason === "length"` means
      // the model hit the output-token ceiling and the JSON was cut off
      // mid-string, which is a budget problem, not a model-quality one. Say
      // so with a distinct errorCode instead of the generic invalid-JSON line.
      if (result.finishReason === "length") {
        annotate({ meta: { insights_response_truncated: true } });
        return apiError(
          "AI response was cut off before the JSON completed. Raise the token limit (INSIGHTS_MAX_TOKENS)",
          422,
          { errorCode: "ai_response_truncated" },
        );
      }
      return apiError("AI response was not valid JSON", 422);
    }

    // v1.18.10 (HIGH-1) — daily-briefing number-grounding gate, mirroring the
    // recommendations citation cross-check next door. The schema only checks the
    // briefing's SHAPE; this asserts every number the briefing prose restates
    // traces to a `features.signalsOfDay` figure. On a miss: one corrective
    // retry, then drop the briefing block rather than ship a fabricated number.
    //
    // v1.28.28 (#470) — when the gate strips the briefing, SAY SO: the 200
    // used to carry a silently-null briefing, the card showed "no briefing
    // yet", and the regenerate button read as doing nothing. The additive
    // `briefingOmittedReason` field lets the card render an honest "a figure
    // couldn't be verified, so the briefing wasn't shown" state instead.
    let briefingOmittedReason: "ungrounded" | null = null;
    {
      const signals = features.signalsOfDay ?? null;
      let ungrounded = findUngroundedBriefingNumbers(
        readBriefingBlock(insights),
        signals,
        features,
        comparisonSnapshot,
      );
      if (ungrounded.length > 0) {
        annotate({
          action: { name: "insights.generate.briefing_grounding_retry" },
          meta: { ungroundedCount: ungrounded.length },
        });
        try {
          const retry = await runBriefingCompletion({
            userId,
            chain,
            systemPrompt: buildSystemPromptWithReferences(
              locale,
              referenceMetrics,
            ),
            userPrompt: `${userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
            temperature: 0.3,
            // v1.28.28 (#470) — same env-tunable ceiling as the first call.
            maxTokens: resolveInsightsMaxTokens(),
            // v1.21.5 — wider upstream budget; see the first generation call.
            // v1.25 — honours the per-user response-timeout setting.
            timeoutMs: effectiveTimeoutMs,
            stage: "grounding-retry",
          });
          const parsedRetry = JSON.parse(retry.result.content);
          const validatedRetry = insightResultSchema.safeParse(parsedRetry);
          const retryInsights = validatedRetry.success
            ? validatedRetry.data
            : parsedRetry;
          ungrounded = findUngroundedBriefingNumbers(
            readBriefingBlock(retryInsights),
            signals,
            features,
            comparisonSnapshot,
          );
          if (ungrounded.length === 0) {
            insights = retryInsights;
            result = retry.result;
            workingProviderType = retry.workingProvider.providerType;
          }
        } catch {
          // Retry failed to produce parseable JSON, or the day's ceiling
          // refused the correction pass — either way fall through to the
          // strip. An ungrounded figure is never persisted.
        }
      }
      // Still ungrounded after the retry: the freshly generated briefing is
      // discarded rather than shipped — the anti-fabrication guarantee is
      // absolute here too. But rather than leave a hole, stand the PREVIOUS
      // cached briefing in its place: it passed this identical gate when it
      // was written, so it carries no fabricated figure, and a day-old
      // grounded briefing beats a vanished one. This mirrors the background
      // generator, which is the path that writes the same cached payload;
      // the two must not disagree on disposal.
      //
      // `briefingOmittedReason` is set ONLY when no previous briefing exists
      // to stand in, so the card's honest "a figure couldn't be verified"
      // state still fires exactly when the user really has no briefing.
      if (ungrounded.length > 0 && insights && typeof insights === "object") {
        let fallbackBriefing: unknown = null;
        if (dbUser?.insightsCachedText) {
          try {
            const prev = JSON.parse(dbUser.insightsCachedText) as Record<
              string,
              unknown
            >;
            fallbackBriefing = prev.dailyBriefing ?? null;
          } catch {
            // Unparseable previous payload — nothing safe to stand in.
          }
        }
        (insights as Record<string, unknown>).dailyBriefing = fallbackBriefing;
        briefingOmittedReason = fallbackBriefing == null ? "ungrounded" : null;
        annotate({
          action: { name: "insights.generate.briefing_grounding_stripped" },
          meta: {
            ungroundedCount: ungrounded.length,
            briefing_fallback:
              fallbackBriefing != null ? "previous-cached" : "stripped",
          },
        });
      }
    }

    // Outbound safety screen over the whole prose surface, before the persist.
    //
    // This route is user-initiated but writes the SAME cached payload the
    // background generator writes, so a violation must not be persisted here
    // either. The user is waiting, so unlike the background path they get an
    // explicit error rather than silence -- and because nothing was written,
    // the previous cached insight is still what the app renders.
    const screened = screenInsightPayloadProse(insights, locale);
    if (screened) {
      annotate({
        action: { name: "insights.generate.outbound_blocked" },
        meta: { locale, reason: screened },
      });
      return apiError(
        "The generated insight did not pass the safety check and was discarded. Try regenerating.",
        502,
        { errorCode: "insights.generate.outboundScreened" },
      );
    }

    const currentSelfContext = await getSelfContextTextForUser(userId, locale);
    if (currentSelfContext !== aboutMe) {
      return apiError("Profile scope changed during insight generation", 409, {
        errorCode: "insights.generate.profileScopeChanged",
      });
    }
    const stored = withBriefingGeneratedAt(insights, new Date());
    const committed = await prisma.user.updateMany({
      where: {
        id: userId,
        insightsPrivacyMode: modeAtRead,
        insightsExcludeMetrics: { equals: excludeMetricsAtRead },
        locale: localeAtRead,
        dateOfBirth: dateOfBirthAtRead,
        gender: genderAtRead,
        heightCm: heightCmAtRead,
        displayName: displayNameAtRead,
      },
      data: {
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify(stored),
        insightsCachedLocale: locale,
        insightsSnapshotHash: hashInsightSnapshot({
          features: compactFeatures,
          aboutMe: aboutMe ?? null,
          comparisonBaseline: comparisonSnapshot?.baseline ?? "none",
          generationLocale: locale,
        }),
      },
    });
    if (committed.count === 0) {
      return apiError("Insight scope changed during generation", 409, {
        errorCode: "insights.generate.scopeChanged",
      });
    }

    // v1.28.30 — persist the grounding omission (marker AFTER the cache
    // write so it is newer than `insightsCachedAt`). The transient
    // `briefingOmittedReason` on this response only reached the caller that
    // forced the regenerate; every later read showed a generic "no briefing
    // yet". The dated marker lets the GET surface the same honest
    // "briefing withheld" state until the next successful generation.
    if (briefingOmittedReason === "ungrounded") {
      void recordBriefingFailure({
        userId,
        reason: "briefing-ungrounded",
        locale,
      });
    }

    // v1.16.8 — no blanket per-status eviction here any more (nuking ~45
    // cache rows per manual regenerate deleted every hash baseline and was
    // the source of the post-regenerate card-regeneration storm). Instead,
    // the manual regenerate takes the cards along through the hash-gated
    // queue: every scope the user has data for is enqueued, the worker
    // forces each generator past its same-day cache read, and the content-
    // hash gate regenerates exactly the cards whose data changed while
    // refreshing the unchanged ones for free. This is the user's escape
    // hatch for a card they can SEE is stale — without it the cards had no
    // refresh path until the next nightly warm.
    const refillScopes = await enqueueStatusRefillForUser(
      userId,
      normalizeLocale(locale),
    );
    annotate({
      action: { name: "insights.generate.cards_refill" },
      meta: { scopes: refillScopes },
    });

    // v1.7.0 W6 — the dashboard snapshot embeds the pre-generated daily
    // briefing read-only; drop it so the next snapshot carries the fresh
    // briefing instead of the stale one.
    invalidateUserInsights(userId);

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

    return apiSuccess({
      insights: await insightsPayloadForToday(stored, {
        userId,
        timezone: postTimezone,
        language: locale,
      }),
      cached: false,
      legacyPayload: false,
      // v1.28.28 (#470) — additive: non-null when the grounding gate stripped
      // the briefing from THIS generation, so the card can explain the hole.
      briefingOmittedReason,
    });
  }),
);
