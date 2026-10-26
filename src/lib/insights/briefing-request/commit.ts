/**
 * The on-demand briefing's commit: the outbound safety screen, the two scope
 * guards, the cache write, and everything that follows a written briefing.
 *
 * Contract with the client (`AdvisorSettleState` in
 * `src/components/insights/use-insights-advisor.ts`, refs #786): on success
 * this writes the fresh briefing to the user cache (`insightsCachedAt`
 * advances) — even when the client has long since aborted its 45 s request —
 * and a failed inline generation leaves a failure marker the read reports as
 * `generationFailed`. The client settles a timed-out regenerate on exactly
 * those two signals, so renaming or short-circuiting either write breaks
 * that convergence.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSelfContextTextForUser } from "@/lib/ai/coach/about-me";
import { screenInsightPayloadProse } from "@/lib/ai/safety/insight-payload-screen";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { insightsPayloadForToday } from "@/lib/daily/briefing-today-read";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { withBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { applyBriefingShortForm } from "@/lib/insights/briefing-short-form";
import { insightsCacheWrite } from "@/lib/insights/cached-text-cipher";
import { enqueueStatusRefillForUser } from "@/lib/insights/comprehensive-generate";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { annotate } from "@/lib/logging/context";

import type { BriefingCall } from "./completion";
import type { BriefingRefusal } from "./context";
import type { PreparedFeatures } from "./features";
import type { GroundedReply } from "./grounding";

export type CommitOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: BriefingRefusal };

/** Write the briefing, guarded on the scope the prompt was built from. */
async function writeBriefing(
  call: BriefingCall,
  prepared: PreparedFeatures,
  stored: object,
): Promise<boolean> {
  const { ctx, prompt } = call;
  const { scope, locale } = ctx;
  const committed = await prisma.user.updateMany({
    where: {
      id: ctx.userId,
      insightsPrivacyMode: scope.mode,
      insightsExcludeMetrics: { equals: scope.excludeMetrics },
      locale: scope.locale,
      dateOfBirth: scope.dateOfBirth,
      gender: scope.gender,
      heightCm: scope.heightCm,
      displayName: scope.displayName,
    },
    data: {
      insightsCachedAt: new Date(),
      ...insightsCacheWrite(JSON.stringify(stored)),
      insightsCachedLocale: locale,
      insightsSnapshotHash: hashInsightSnapshot({
        features: prepared.compactFeatures,
        aboutMe: prompt.aboutMe ?? null,
        comparisonBaseline: prompt.comparisonSnapshot?.baseline ?? "none",
        generationLocale: locale,
        ...(prompt.briefingForm === "short"
          ? { briefingForm: prompt.briefingForm }
          : {}),
      }),
    },
  });
  return committed.count > 0;
}

/** What follows a written briefing: the marker, the cards, the audit row. */
async function afterWrite(
  call: BriefingCall,
  reply: GroundedReply,
  ipAddress: string | null,
  fallbackHopCount: number,
): Promise<void> {
  const { ctx } = call;
  const { userId, locale } = ctx;
  const { result, workingProviderType } = reply;
  // The grounding omission persists (marker AFTER the cache write so it is
  // newer than `insightsCachedAt`). The transient `briefingOmittedReason` on
  // the response only reached the caller that forced the regenerate; every
  // later read showed a generic "no briefing yet". The dated marker lets the
  // read surface the same honest "briefing withheld" state until the next
  // successful generation.
  if (reply.briefingOmittedReason === "ungrounded") {
    void recordBriefingFailure({
      userId,
      reason: "briefing-ungrounded",
      locale,
    });
  }

  // No blanket per-status eviction (nuking ~45 cache rows per manual
  // regenerate deleted every hash baseline and caused a card-regeneration
  // storm). The manual regenerate takes the cards along through the
  // hash-gated queue: every scope the user has data for is enqueued, the
  // worker forces each generator past its same-day cache read, and the
  // content-hash gate regenerates exactly the cards whose data changed while
  // refreshing the unchanged ones for free. This is the user's escape hatch
  // for a card they can SEE is stale — without it the cards had no refresh
  // path until the next nightly warm.
  const refillScopes = await enqueueStatusRefillForUser(
    userId,
    normalizeLocale(locale),
  );
  annotate({
    action: { name: "insights.generate.cards_refill" },
    meta: { scopes: refillScopes },
  });

  // The dashboard snapshot embeds the pre-generated daily briefing
  // read-only; drop it so the next snapshot carries the fresh briefing
  // instead of the stale one.
  invalidateUserInsights(userId);

  await auditLog("insights.generate", {
    userId,
    ipAddress,
    details: {
      privacyMode: ctx.dbUser?.insightsPrivacyMode,
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
}

export async function commitBriefing(
  call: BriefingCall,
  prepared: PreparedFeatures,
  reply: GroundedReply,
  options: { ipAddress: string | null; fallbackHopCount: number },
): Promise<CommitOutcome> {
  const { ctx, prompt } = call;
  const { userId, locale } = ctx;
  let { insights } = reply;

  // Outbound safety screen over the whole prose surface, before the
  // persist. This path is user-initiated but writes the SAME cached payload
  // the background generator writes, so a violation must not be persisted
  // here either. The user is waiting, so unlike the background path they get
  // an explicit error rather than silence — and because nothing was written,
  // the previous cached insight is still what the app renders.
  const screened = screenInsightPayloadProse(insights, locale);
  if (screened) {
    annotate({
      action: { name: "insights.generate.outbound_blocked" },
      meta: { locale, reason: screened },
    });
    return { ok: false, refusal: "outbound-screened" };
  }

  const currentSelfContext = await getSelfContextTextForUser(userId, locale);
  if (currentSelfContext !== prompt.aboutMe) {
    return { ok: false, refusal: "profile-scope-changed" };
  }
  if (prompt.briefingForm === "short") {
    insights = applyBriefingShortForm(insights);
  }
  const stored = withBriefingGeneratedAt(insights, new Date());
  if (!(await writeBriefing(call, prepared, stored))) {
    return { ok: false, refusal: "scope-changed" };
  }

  await afterWrite(call, reply, options.ipAddress, options.fallbackHopCount);

  return {
    ok: true,
    data: {
      insights: await insightsPayloadForToday(stored, {
        userId,
        timezone: ctx.timezone,
        language: locale,
      }),
      cached: false,
      legacyPayload: false,
      // Additive: non-null when the grounding gate stripped the briefing
      // from THIS generation, so the card can explain the hole (#470).
      briefingOmittedReason: reply.briefingOmittedReason,
    },
  };
}
