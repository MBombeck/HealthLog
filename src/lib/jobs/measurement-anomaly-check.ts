/**
 * "Your resting heart rate has stayed higher since 3 Nov": the
 * `MEASUREMENT_ANOMALY` push.
 *
 * The signal is the health-status changepoint scan
 * (`buildExtendedChangepointSignals`), the one deviation in the codebase with
 * a firing bar high enough to push on: a sustained level shift in a stable
 * vital, validated against the metric's own spread and its device floors,
 * that has held for at least ten days, that a straight-line drift does not
 * explain better. A single high reading never qualifies, and nothing here
 * diagnoses: the push says what changed and since when, and opens Insights.
 *
 * It is opt-in twice over and built not to nag:
 *
 *   - The event is off by default (`EVENT_DEFAULT_ENABLED`), so only a person
 *     who switched it on for a channel at /notifications is scanned at all.
 *   - It is sent in the person's local 10 o'clock hour, never at night.
 *   - Only a fresh shift is news: its break must lie within the last
 *     `FRESH_BREAK_DAYS`. A shift that settled months ago is on the health
 *     status card already and is not pushed.
 *   - A shift is sent once: the metric and direction are claimed for
 *     `SAME_SHIFT_QUIET_DAYS`, so the break date moving by a day as more
 *     readings arrive never sends it again.
 *   - At most one such push a week, whatever else shifted.
 *   - Not during an open illness episode: a resting heart rate that rises
 *     with a flu is expected, and the person knows they are ill.
 *
 * A metric whose module is switched off is not scanned. On a managed
 * profile the dispatcher's own rules decide whether a guardian hears it; the
 * event is not on the guardian fan-out list, so it reaches the record's own
 * channels only.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import type { Job } from "pg-boss";

import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { activeAccount } from "@/lib/account-deletion/active-account";
import { prisma as defaultPrisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { buildExtendedChangepointSignals } from "@/lib/insights/derived/changepoint";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import { resolveModuleMap } from "@/lib/modules/gate";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { resolveIntlLocale } from "@/lib/format-locale";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

export const MEASUREMENT_ANOMALY_EVENT = "MEASUREMENT_ANOMALY";
/** The local hour the push may go out in. */
export const ANOMALY_LOCAL_HOUR = 10;
/** A break further back than this is not news. */
export const FRESH_BREAK_DAYS = 21;
/** One metric and direction is sent once in this long. */
export const SAME_SHIFT_QUIET_DAYS = 60;
/** At most one anomaly push in this many days. */
export const ANOMALY_WEEKLY_CAP_DAYS = 7;

const DAY_MS = 86_400_000;

export interface AnomalyShift {
  metric: MeasurementType;
  breakDate: string;
  direction: "up" | "down";
  magnitude: number;
}

/**
 * The shift worth a push, or null: the strongest fresh one. Pure, so the
 * freshness rule is pinned without a database.
 */
export function pickFreshShift(
  shifts: readonly AnomalyShift[],
  today: string,
): AnomalyShift | null {
  const fresh = shifts.filter((s) => {
    const age =
      (Date.parse(`${today}T12:00:00Z`) -
        Date.parse(`${s.breakDate}T12:00:00Z`)) /
      DAY_MS;
    return age >= 0 && age <= FRESH_BREAK_DAYS;
  });
  fresh.sort((a, b) => b.magnitude - a.magnitude);
  return fresh[0] ?? null;
}

/** Everyone who switched the event on for at least one live channel. */
async function optedInUserIds(prisma: PrismaClient): Promise<string[]> {
  // account-deletion: only ids come back, and the user read below filters
  // them through `activeAccount`.
  const rows = await prisma.notificationPreference.findMany({
    where: {
      eventType: MEASUREMENT_ANOMALY_EVENT,
      enabled: true,
      channel: { enabled: true },
    },
    select: { channel: { select: { userId: true } } },
  });
  return [...new Set(rows.map((r) => r.channel.userId))];
}

export interface AnomalyTickResult {
  scanned: number;
  sent: number;
}

/** One tick: scan the opted-in people whose local hour it is. */
export async function runMeasurementAnomalyTick(
  now: Date = new Date(),
  prisma: PrismaClient = defaultPrisma,
): Promise<AnomalyTickResult> {
  const ids = await optedInUserIds(prisma);
  if (ids.length === 0) return { scanned: 0, sent: 0 };
  const users = await prisma.user.findMany({
    where: activeAccount({ id: { in: ids } }),
    select: { id: true, timezone: true, locale: true },
  });

  let scanned = 0;
  let sent = 0;
  for (const user of users) {
    const tz = user.timezone || DEFAULT_TIMEZONE;
    if (wallClockInTz(now, tz).hour !== ANOMALY_LOCAL_HOUR) continue;
    scanned += 1;
    try {
      if (await notifyUser(prisma, user, tz, now)) sent += 1;
    } catch (err) {
      logCaught("notification.measurementAnomaly.failed", err);
    }
  }
  annotate({
    action: { name: "notification.measurementAnomaly.tick" },
    meta: { scanned, sent },
  });
  return { scanned, sent };
}

async function notifyUser(
  prisma: PrismaClient,
  user: { id: string; locale: string | null },
  tz: string,
  now: Date,
): Promise<boolean> {
  const ill = await prisma.illnessEpisode.findFirst({
    where: { userId: user.id, deletedAt: null, resolvedAt: null },
    select: { id: true },
  });
  if (ill) return false;

  const modules = await resolveModuleMap(user.id);
  const shifts = await buildExtendedChangepointSignals(user.id, now, modules);
  const shift = pickFreshShift(shifts, userDayKey(now, tz));
  if (!shift) return false;

  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  // A shift already told is never told again within its quiet window; read
  // first, so a shift that was sent does not use up the week below.
  const shiftKey = `shift:${shift.metric}:${shift.direction}`;
  const told = await prisma.notificationEvent.findFirst({
    where: {
      recordUserId: user.id,
      eventType: MEASUREMENT_ANOMALY_EVENT,
      dedupKey: shiftKey,
      createdAt: { gte: since(SAME_SHIFT_QUIET_DAYS) },
    },
    select: { id: true },
  });
  if (told) return false;
  // The week is the atomic claim: two workers on one tick send once.
  const weekFree = await claimNotificationEvent(prisma, {
    recordUserId: user.id,
    eventType: MEASUREMENT_ANOMALY_EVENT,
    dedupKey: "week",
    since: since(ANOMALY_WEEKLY_CAP_DAYS),
  });
  if (!weekFree) return false;
  await claimNotificationEvent(prisma, {
    recordUserId: user.id,
    eventType: MEASUREMENT_ANOMALY_EVENT,
    dedupKey: shiftKey,
    since: since(SAME_SHIFT_QUIET_DAYS),
  });

  const render = (locale: Locale) => {
    const { t } = getServerTranslator(locale);
    const date = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${shift.breakDate}T12:00:00Z`));
    const params = {
      metric: t(MEASUREMENT_TYPE_LABEL_KEYS[shift.metric]),
      date,
    };
    return {
      title: t("notifications.measurementAnomaly.title"),
      message: t(
        shift.direction === "up"
          ? "notifications.measurementAnomaly.bodyUp"
          : "notifications.measurementAnomaly.bodyDown",
        params,
      ),
    };
  };
  const own = render(await resolveJobLocale(user.locale));
  await dispatchNotification({
    eventType: MEASUREMENT_ANOMALY_EVENT,
    userId: user.id,
    title: own.title,
    message: own.message,
    renderForRecipient: render,
    metadata: { metric: shift.metric, breakDate: shift.breakDate },
  });
  return true;
}

/** The pg-boss handler. */
export async function handleMeasurementAnomalyCheck(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.measurement_anomaly_check", async () => {
    const { scanned, sent } = await runMeasurementAnomalyTick();
    return jobDone({ users_scanned: scanned, sent });
  });
}
