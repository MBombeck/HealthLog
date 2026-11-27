/**
 * One reminder before a treatment series runs out with sessions left.
 *
 * A prescription for six sessions is valid until a date; sessions not taken
 * by then are lost and need a new prescription. So a series with a
 * `validUntil`, a planned count and sessions still to take gets one push in
 * the week before that day.
 *
 * Not a mechanism of its own. It rides the check-up reminder's tick, event
 * type and per-channel preferences (`MEASUREMENT_REMINDER`), so a person who
 * routed or silenced their check-up reminders gets the same treatment here,
 * and it is claimed in the same `notification_events` ledger, once per series
 * and expiry date: moving the date is a new expiry and may remind again,
 * nothing else does. It goes out in the morning hour the check-up reminders
 * default to, on the owner's clock, so it never lands at night.
 *
 * Off when nothing is left to take: a series ended, completed, deleted,
 * without a planned count (nothing can be "left"), or past its last day.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { ownedByActiveAccount } from "@/lib/account-deletion/active-account";
import { treatmentSeriesPath } from "@/lib/encounters/visit-links";
import { coerceLocale, type Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { getEvent } from "@/lib/logging/context";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import {
  DEFAULT_TIMEZONE,
  daysBetweenDateKeys,
  shiftDateKey,
  userDayKey,
} from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

import { summarizeSessions } from "./derive";
import { decryptSeriesText } from "./dto";

/** Days before the last valid day the reminder may go out. */
export const SERIES_EXPIRY_LEAD_DAYS = 7;

/** Local hour it goes out in: the check-up reminders' default notify hour. */
export const SERIES_EXPIRY_NOTIFY_HOUR = 9;

export interface SeriesExpirySummary {
  candidates: number;
  dispatched: number;
  skippedNotDue: number;
  skippedNothingLeft: number;
  skippedAlreadyClaimed: number;
  skippedNoChannel: number;
  failed: number;
}

/**
 * Whether a series is due its reminder on `today` (the owner's day key):
 * inside the lead window, not past its last day, and with sessions left.
 */
export function seriesExpiryDue(
  series: { plannedSessions: number | null; validUntil: string | null },
  done: number,
  today: string,
): { due: boolean; remaining: number } {
  if (series.plannedSessions === null || series.validUntil === null) {
    return { due: false, remaining: 0 };
  }
  const remaining = Math.max(0, series.plannedSessions - done);
  const daysLeft = daysBetweenDateKeys(today, series.validUntil);
  const inWindow = daysLeft >= 0 && daysLeft <= SERIES_EXPIRY_LEAD_DAYS;
  return { due: inWindow && remaining > 0, remaining };
}

export function buildSeriesExpiryPayload(
  locale: string | null | undefined,
  title: string | null,
  remaining: number,
  validUntil: string,
): { title: string; message: string } {
  const resolved = coerceLocale(locale);
  const { t } = getServerTranslator(resolved);
  const date = new Intl.DateTimeFormat(resolved, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(dayKeyAsUtcMidnight(validUntil));
  return {
    title: t("treatmentSeries.expiryPushTitle"),
    message: t("treatmentSeries.expiryPushBody", {
      title: title ?? t("treatmentSeries.untitled"),
      count: remaining,
      date,
    }),
  };
}

export async function runTreatmentSeriesExpiryTick(
  prisma: PrismaClient,
  now: Date,
  options: { dispatch?: typeof dispatchNotification } = {},
): Promise<SeriesExpirySummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const summary: SeriesExpirySummary = {
    candidates: 0,
    dispatched: 0,
    skippedNotDue: 0,
    skippedNothingLeft: 0,
    skippedAlreadyClaimed: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  // Every zone's today lies within a day of the server's, so this window
  // holds every series that can be due anywhere; the exact day is decided
  // per owner below.
  const serverToday = userDayKey(now, "UTC");
  const rows = await prisma.treatmentSeries.findMany({
    where: ownedByActiveAccount({
      deletedAt: null,
      endedOn: null,
      plannedSessions: { not: null },
      validUntil: {
        gte: dayKeyAsUtcMidnight(shiftDateKey(serverToday, -1)),
        lte: dayKeyAsUtcMidnight(
          shiftDateKey(serverToday, SERIES_EXPIRY_LEAD_DAYS + 1),
        ),
      },
    }),
    select: {
      id: true,
      titleEncrypted: true,
      plannedSessions: true,
      validUntil: true,
      user: { select: { id: true, timezone: true, locale: true } },
      sessions: {
        where: { deletedAt: null },
        select: { id: true, occurredAt: true, status: true },
      },
    },
  });

  for (const row of rows) {
    summary.candidates += 1;
    try {
      const timezone = row.user.timezone || DEFAULT_TIMEZONE;
      if (wallClockInTz(now, timezone).hour !== SERIES_EXPIRY_NOTIFY_HOUR) {
        summary.skippedNotDue += 1;
        continue;
      }
      const validUntil = row.validUntil ? dateOnlyKey(row.validUntil) : null;
      const { done } = summarizeSessions(row.sessions, now);
      const { due, remaining } = seriesExpiryDue(
        { plannedSessions: row.plannedSessions, validUntil },
        done,
        userDayKey(now, timezone),
      );
      if (!due || validUntil === null) {
        if (remaining === 0) summary.skippedNothingLeft += 1;
        else summary.skippedNotDue += 1;
        continue;
      }

      const claim = {
        recordUserId: row.user.id,
        eventType: "MEASUREMENT_REMINDER",
        dedupKey: `series-expiry:${row.id}:${validUntil}`,
      };
      // The claim covers the whole lead time, so a send that went nowhere
      // gives it back: the next hour tries again instead of never.
      const release = () =>
        prisma.notificationEvent.deleteMany({ where: claim }).catch(() => {});
      const claimed = await claimNotificationEvent(prisma, {
        ...claim,
        since: new Date(
          now.getTime() - (SERIES_EXPIRY_LEAD_DAYS + 2) * 86_400_000,
        ),
      });
      if (!claimed) {
        summary.skippedAlreadyClaimed += 1;
        continue;
      }

      const title = decryptSeriesText(row.titleEncrypted, "title");
      const render = (locale: Locale | string | null) =>
        buildSeriesExpiryPayload(locale, title, remaining, validUntil);
      const own = render(await resolveJobLocale(row.user.locale));
      // No Done / Later: there is no reminder row to complete or postpone,
      // and the push opens the series itself.
      let outcome: Awaited<ReturnType<typeof dispatchImpl>>;
      try {
        outcome = await dispatchImpl({
          eventType: "MEASUREMENT_REMINDER",
          userId: row.user.id,
          title: own.title,
          message: own.message,
          renderForRecipient: (locale: Locale) => render(locale),
          suppressActions: true,
          metadata: {
            scheduledAt: now.toISOString(),
            treatmentSeriesId: row.id,
            url: treatmentSeriesPath(row.id),
          },
        });
      } catch (err) {
        await release();
        throw err;
      }
      if (outcome.dispatched) summary.dispatched += 1;
      else {
        if (outcome.channelsAttempted > 0) await release();
        summary.skippedNoChannel += 1;
      }
    } catch (err: unknown) {
      summary.failed += 1;
      getEvent()?.addWarning(
        `treatment-series expiry reminder failed for ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return summary;
}
