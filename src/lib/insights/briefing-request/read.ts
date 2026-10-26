/**
 * The read-only advisor briefing: the cached payload, served immediately and
 * never generated here.
 *
 * The advisor consumers (hero strip, daily-briefing card, trends row) used
 * to mount against the generating POST, which blocked the page-load path on
 * the full provider chain. This read serves `User.insightsCachedTextEncrypted`
 * as it is and, when the cache is stale or missing AND a provider is
 * configured, enqueues an out-of-band warm (the same `insight-pregenerate`
 * queue the nightly cron and the "prepare assessments" button use). The next
 * read reflects the fresh briefing.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import {
  generatedOnLocalToday,
  insightsPayloadForToday,
} from "@/lib/daily/briefing-today-read";
import { isLegacyInsightPayload } from "@/lib/ai/legacy-payload";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { readBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import {
  INSIGHTS_CACHE_SELECT,
  openInsightsCachedText,
} from "@/lib/insights/cached-text-cipher";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
import { annotate } from "@/lib/logging/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * Briefing freshness window for the read. A cached briefing read this
 * recently is fresh and triggers no warm; older / missing enqueues an
 * out-of-band regeneration. Mirrors the 24 h cache-hit window the POST path
 * honours so the two stay consistent.
 */
const BRIEFING_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The honesty signals beside the payload: whether a provider exists, and
 * what the last generation attempt left behind.
 */
async function readGenerationSignals(userId: string, cachedAt: Date | null) {
  // Provider availability, resolved once. The read never blocks on or
  // generates through the provider, but it must REPORT whether one exists:
  // a provider-less account's cached briefing freezes at the last successful
  // generation (the pregenerate cron can't refill it), and the UI presented
  // that stale text as current. `hasProvider: false` lets the insights
  // surfaces pair the honest "Stand: vor X Tagen" age with a discreet
  // connect-an-AI-provider hint instead of implying the read is live.
  const hasProvider = await hasUsableStatusProvider(userId);

  // Whether the most recent generation attempt failed (a marker newer than
  // the last successful generation). The briefing keeps its last good text
  // on failure, so this is the only honest signal that a shown briefing is
  // held rather than freshly refreshed — and, when there is no last good
  // text, that the empty state should read "couldn't generate" with a retry
  // rather than the generic "no briefing yet".
  const briefingFailure = await readBriefingFailure({
    userId,
    since: cachedAt,
  });
  // A `briefing-ungrounded` marker is NOT a failure: the generation
  // succeeded but the grounding gate withheld the briefing (marker written
  // after the cache write, so it survives the `since` filter). It is the
  // persistent omission signal — the card's "briefing withheld" state used
  // to exist only on the transient POST response, so a nightly strip read as
  // a silent generic empty card.
  const briefingOmittedReason: "ungrounded" | null =
    briefingFailure?.reason === "briefing-ungrounded" ? "ungrounded" : null;
  const generationFailed =
    briefingFailure !== null && briefingOmittedReason === null;
  // The failure class lets the empty state point its hint at the right
  // lever (raise the response timeout vs re-check the provider).
  const generationFailureClass = generationFailed
    ? (briefingFailure?.failureClass ?? null)
    : null;
  return {
    hasProvider,
    generationFailed,
    generationFailureClass,
    briefingOmittedReason,
  };
}

export async function readAdvisorBriefing(args: {
  request: NextRequest;
  userId: string;
  userLocale: string | null;
}) {
  const { request, userId } = args;
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsCachedAt: true,
      ...INSIGHTS_CACHE_SELECT,
      insightsCachedLocale: true,
      locale: true,
      timezone: true,
    },
  });
  const cachedText = openInsightsCachedText(dbUser);

  // The locale the caller is actually reading (cookie / Accept-Language
  // fall-back when `User.locale` is unset), validated against the shipped
  // list — the same convention the nightly's `normalizeLocale` and the status
  // routes follow. Collapsing a NULL `User.locale` to German filled the wrong
  // cache family for a client reading the app in English.
  const readerLocale = normalizeLocale(
    await resolveServerLocale({
      request,
      userLocale: dbUser?.locale ?? args.userLocale ?? null,
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
    readBriefingGeneratedAt(cachedText),
    timezone,
    new Date(),
  );
  const isFresh =
    !languageMismatch &&
    cachedAt !== null &&
    generatedToday &&
    Date.now() - cachedAt.getTime() < BRIEFING_FRESH_MS;

  const signals = await readGenerationSignals(userId, cachedAt);
  const { hasProvider } = signals;

  // Never block on the provider. Warm out of band only when the cached
  // briefing is stale / missing AND a provider is configured (a
  // provider-less account costs one cheap chain-resolve and shows the
  // empty / connect-AI state instead of a wasted enqueue).
  let revalidating = false;
  if (!isFresh && hasProvider) {
    void enqueueForceWarm({ userId, locale: readerLocale });
    revalidating = true;
  }

  if (cachedText && !languageMismatch) {
    try {
      const cached = JSON.parse(cachedText);
      const legacyPayload = isLegacyInsightPayload(cached);
      annotate({
        action: { name: "insights.generate.read" },
        meta: { cached: true, legacyPayload, revalidating, hasProvider },
      });
      return {
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
        // Honest stale-serve marker: true while the out-of-band warm is in
        // flight, so the client can poll (bounded) until the fresh briefing
        // lands instead of sitting on the stale payload for the rest of the
        // session.
        revalidating,
        // False when no AI provider is configured anywhere: the served
        // briefing can never refresh, so the UI pairs its age with a
        // connect-provider affordance.
        hasProvider,
        // True when the last generation attempt failed (held text).
        generationFailed: signals.generationFailed,
        // Coarse failure class for the empty-state hint (null when the last
        // attempt succeeded).
        generationFailureClass: signals.generationFailureClass,
        // Persistent grounding-omission signal (see above), so a
        // nightly-stripped briefing renders "withheld", not "no briefing
        // yet".
        briefingOmittedReason: signals.briefingOmittedReason,
      };
    } catch {
      // Invalid cache row — fall through to the empty payload below. The
      // warm enqueue above (when a provider exists) repairs it for the next
      // read.
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
  return {
    insights: null,
    cached: false,
    legacyPayload: false,
    revalidating,
    hasProvider,
    // No last-good text AND the last attempt failed: the UI shows a
    // "couldn't generate" empty state with a retry instead of the generic
    // one.
    generationFailed: signals.generationFailed,
    generationFailureClass: signals.generationFailureClass,
    briefingOmittedReason: signals.briefingOmittedReason,
  };
}
