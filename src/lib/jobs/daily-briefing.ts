/**
 * The daily-briefing fallback cron.
 *
 * The PRIMARY trigger for the morning push is event-driven: the S4
 * morning-refresh worker dispatches it the instant last night's sleep lands and
 * the digest finalises (see `register-status.ts`). This cron is the FALLBACK
 * slot for the honest-degradation case — a user whose sleep never synced, so no
 * finalisation ever fired. It ticks every 15 minutes (the mood- /
 * measurement-reminder cadence) and, for each OPTED-IN user whose local wall
 * clock is at the fixed fallback hour, funnels through the same
 * `maybeDispatchDailyBriefing` decision seam. The `push_attempts` frequency cap
 * means a user who already got the finalisation push earlier this morning is
 * suppressed here — one push per user per local day, no matter which trigger
 * won the race.
 *
 * The opted-in cohort is small (DAILY_BRIEFING defaults OFF), and the per-user
 * work is gated on the exact local fallback hour, so the tick is cheap: it only
 * loads a digest for the handful of users at their fallback minute-window this
 * tick.
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { PrismaClient } from "@/generated/prisma/client";

import { getEvent } from "@/lib/logging/context";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import {
  DAILY_BRIEFING_FALLBACK_HOUR,
  maybeDispatchDailyBriefing,
  type DailyBriefingDispatchDeps,
} from "@/lib/daily/daily-briefing-push";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export interface DailyBriefingTickSummary {
  candidatesScanned: number;
  inSlot: number;
  sent: number;
  suppressedFrequency: number;
  noDigest: number;
  optedOut: number;
  noChannel: number;
  outsideWindow: number;
  failed: number;
}

/**
 * Run one fallback-cron tick. Injectable `dispatch` / `maybeDispatch` so the
 * unit tests pin the slot-gating + result accounting without a running boss,
 * provider, or DB.
 */
export async function runDailyBriefingTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
    /** Injectable decision seam (defaults to the real one). */
    maybeDispatch?: typeof maybeDispatchDailyBriefing;
    dispatchDeps?: DailyBriefingDispatchDeps;
  } = {},
): Promise<DailyBriefingTickSummary> {
  const maybeDispatch = options.maybeDispatch ?? maybeDispatchDailyBriefing;
  const dispatchDeps: DailyBriefingDispatchDeps = {
    ...(options.dispatchDeps ?? {}),
    ...(options.dispatch ? { dispatch: options.dispatch } : {}),
  };

  const summary: DailyBriefingTickSummary = {
    candidatesScanned: 0,
    inSlot: 0,
    sent: 0,
    suppressedFrequency: 0,
    noDigest: 0,
    optedOut: 0,
    noChannel: 0,
    outsideWindow: 0,
    failed: 0,
  };

  // The opted-in cohort: users with at least one enabled DAILY_BRIEFING
  // preference row. Deduped by userId (a user may have opted several channels
  // in) and carrying the timezone so the slot gate needs no extra read.
  const prefs = await prisma.notificationPreference.findMany({
    where: {
      eventType: "DAILY_BRIEFING",
      enabled: true,
      channel: OWNED_BY_ACTIVE_ACCOUNT,
    },
    select: {
      channel: {
        select: { userId: true, user: { select: { timezone: true } } },
      },
    },
  });

  const cohort = new Map<string, string>();
  for (const pref of prefs) {
    const userId = pref.channel?.userId;
    if (!userId) continue;
    cohort.set(userId, pref.channel.user?.timezone || DEFAULT_TIMEZONE);
  }

  for (const [userId, tz] of cohort) {
    summary.candidatesScanned += 1;
    try {
      // Fire only at the fixed fallback hour; the earlier part of the morning
      // window belongs to the event-driven finalisation push.
      if (wallClockInTz(now, tz).hour !== DAILY_BRIEFING_FALLBACK_HOUR) {
        continue;
      }
      summary.inSlot += 1;

      const result = await maybeDispatch(prisma, userId, now, dispatchDeps);
      switch (result) {
        case "sent":
          summary.sent += 1;
          break;
        case "suppressed-frequency":
          summary.suppressedFrequency += 1;
          break;
        case "no-digest":
          summary.noDigest += 1;
          break;
        case "opted-out":
          summary.optedOut += 1;
          break;
        case "no-channel":
          summary.noChannel += 1;
          break;
        case "outside-window":
          summary.outsideWindow += 1;
          break;
        default:
          summary.failed += 1;
      }
    } catch (err) {
      summary.failed += 1;
      getEvent()?.addWarning(
        `daily-briefing tick failed for ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}
