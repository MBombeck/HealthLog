/**
 * The generating POST's cache short-circuit, and the cached payload it
 * degrades to when the hour's generation quota is spent.
 *
 * A fresh cache WITHOUT a briefing must not satisfy a briefing-expecting
 * caller: after a failed nightly warm the cached payload can sit inside the
 * 24 h window all day, and an unconditional short-circuit served it to every
 * POST (three regenerate attempts, three `cached: true` responses, zero
 * generations). The short-circuit holds only when the cached payload carries
 * today's briefing OR the account has no usable provider (regenerating would
 * be futile — serve what exists). When the briefingless fall-through is
 * rate-limited, the cached payload is served after all, so a POST-as-read
 * client degrades to the old behaviour instead of a 429.
 */
import { isLegacyInsightPayload } from "@/lib/ai/legacy-payload";
import {
  generatedOnLocalToday,
  insightsPayloadForToday,
} from "@/lib/daily/briefing-today-read";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { cachedPayloadCarriesBriefing } from "@/lib/insights/briefing-payload";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import { annotate } from "@/lib/logging/context";

import type { GenerationContext } from "./context";

/** A fresh cached payload kept aside for the quota fallback. */
export interface CachedFallback {
  cached: unknown;
  legacyPayload: boolean;
  cachedAt: Date;
}

export type CacheDecision =
  | { kind: "serve"; data: Record<string, unknown> }
  | { kind: "generate"; fallback: CachedFallback | null };

export async function briefingFromCache(
  ctx: GenerationContext,
  forceRefresh: boolean,
): Promise<CacheDecision> {
  const { dbUser, cachedText, userId, locale } = ctx;
  // A cache tagged with another language is not this reader's cache and
  // never short-circuits; the generation writes the reader's own.
  const cachedLocaleMatches =
    dbUser?.insightsCachedLocale == null ||
    dbUser.insightsCachedLocale === locale;
  if (
    !forceRefresh &&
    dbUser?.insightsCachedAt &&
    cachedText &&
    cachedLocaleMatches &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(cachedText);
      // Legacy payloads (pre-rationale) are flagged so the UI can show a
      // "regenerate for new explainability features" CTA. No automatic
      // regeneration: that would burn rate-limit tokens on a cache hit
      // silently. User-initiated only.
      const legacyPayload = isLegacyInsightPayload(cached);
      // A briefing generated on an earlier day is not today's read: like a
      // briefingless cache, it does not short-circuit a provider-backed
      // account, and degrades to the cached payload on a 429.
      const carriesBriefing =
        cachedPayloadCarriesBriefing(cachedText) &&
        generatedOnLocalToday(
          readBriefingGeneratedAt(cachedText),
          ctx.timezone,
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
        return {
          kind: "serve",
          data: {
            insights: await insightsPayloadForToday(cached, {
              userId,
              timezone: ctx.timezone,
              language: locale,
            }),
            cached: true,
            cachedAt: dbUser.insightsCachedAt,
            legacyPayload,
          },
        };
      }
      annotate({
        action: { name: "insights.generate.briefingless_cache_bypassed" },
        meta: { locale },
      });
      return {
        kind: "generate",
        fallback: {
          cached,
          legacyPayload,
          cachedAt: dbUser.insightsCachedAt,
        },
      };
    } catch {
      // Invalid cache, regenerate
    }
  }
  return { kind: "generate", fallback: null };
}

/** The cached payload, served when the hour's quota refused a generation. */
export async function serveCachedFallback(
  ctx: GenerationContext,
  fallback: CachedFallback,
): Promise<Record<string, unknown>> {
  annotate({
    action: { name: "insights.generate" },
    meta: { cached: true, rate_limited_fallback: true },
  });
  return {
    insights: await insightsPayloadForToday(fallback.cached, {
      userId: ctx.userId,
      timezone: ctx.timezone,
      language: ctx.locale,
    }),
    cached: true,
    cachedAt: fallback.cachedAt,
    legacyPayload: fallback.legacyPayload,
  };
}
