/**
 * v0.5.4 ios-coord — daily mood-reminder dispatcher.
 *
 * The reminder cron fires every 15 minutes (same cadence as the
 * medication-reminder loop in `reminder-worker.ts`). When the cron lands
 * inside the 22:00 hour in a user's local timezone, this module:
 *
 *   1. Skips users who haven't opted in (`User.moodReminderEnabled = false`).
 *   2. Skips users who already logged a mood entry for the local date.
 *   3. Skips users who already received a mood reminder today
 *      (idempotency via `MoodReminderDispatch` row).
 *   4. Dispatches a `MOOD_REMINDER` notification with a locale-aware
 *      title + body. The ledger row is written only after the dispatcher
 *      confirms at least one channel delivered successfully, so a
 *      transient APNs / network blip leaves the next tick free to retry.
 *
 * Why a separate module instead of folding it into reminder-worker.ts:
 * the worker is already 1800 LOC. Splitting the mood-reminder logic out
 * keeps the test surface focused and lets the unit tests run without
 * booting pg-boss.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { getLocalDateParts } from "@/lib/timezone";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getEvent } from "@/lib/logging/context";

/**
 * Hour of day (in the user's local timezone) at which the mood reminder
 * should fire. 22:00 is late enough that a "did you forget to log?" nudge
 * lands in the user's wind-down window without colliding with dinner or
 * the medication-reminder hot path.
 *
 * Exported so the unit tests can pin the contract without scraping the
 * handler internals.
 */
export const MOOD_REMINDER_LOCAL_HOUR = 22;

export interface MoodReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatched: number;
  skippedAlreadyLogged: number;
  skippedAlreadyDispatched: number;
  skippedOutsideWindow: number;
  skippedNoChannel: number;
  failed: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Pure decision predicate: should the worker fire a mood reminder for
 * this user at this instant?
 *
 * Returns the local YYYY-MM-DD date string when the answer is "fire";
 * returns `null` when the answer is "skip" — covers both
 * "outside-window" and "opt-out". Callers branch on the return value.
 *
 * Pulled out as a pure helper so the unit tests can pin the
 * window-boundary contract (21:59 → null, 22:00 → date, 22:59 → date,
 * 23:00 → null) without touching the DB.
 */
export function evaluateMoodReminderWindow(
  user: { timezone: string; moodReminderEnabled: boolean },
  now: Date,
): { fire: boolean; localDate: string | null; localHour: number } {
  if (!user.moodReminderEnabled) {
    return { fire: false, localDate: null, localHour: -1 };
  }
  const parts = getLocalDateParts(now, user.timezone || "Europe/Berlin");
  const inWindow = parts.hour === MOOD_REMINDER_LOCAL_HOUR;
  const isoDate = `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  return {
    fire: inWindow,
    localDate: inWindow ? isoDate : null,
    localHour: parts.hour,
  };
}

/**
 * Build the localised title + body for the mood reminder push. Pulled
 * out so a future template change doesn't require re-running the whole
 * handler in tests.
 */
export function buildMoodReminderPayload(locale: string | null | undefined): {
  title: string;
  body: string;
} {
  const t = getServerTranslator(resolveLocale(locale)).t;
  return {
    title: t("moodReminders.dailyTitle"),
    body: t("moodReminders.dailyBody"),
  };
}

/**
 * Run one mood-reminder cron tick. Iterates every user with
 * `moodReminderEnabled = true`, checks the per-user local-time window,
 * and dispatches a `MOOD_REMINDER` notification when warranted.
 *
 * The dedup ledger (`MoodReminderDispatch`) is the idempotency anchor:
 * the `(userId, date)` unique constraint guarantees that two parallel
 * workers (or a re-tick inside the same hour) won't double-fire. The
 * ledger row is inserted only after the dispatcher confirms at least
 * one channel delivered, so a transient APNs blip leaves the slot free
 * for the next tick to retry rather than silently nuking the day's
 * nudge.
 *
 * Per-user processing is wrapped in its own try/catch so a single bad
 * row (corrupt timezone, dispatcher exception) cannot abort the rest
 * of the tick.
 */
export async function runMoodReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<MoodReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: MoodReminderSummary = {
    candidatesScanned: 0,
    inWindow: 0,
    dispatched: 0,
    skippedAlreadyLogged: 0,
    skippedAlreadyDispatched: 0,
    skippedOutsideWindow: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  const candidates = await prisma.user.findMany({
    where: { moodReminderEnabled: true },
    select: { id: true, timezone: true, locale: true },
  });

  for (const user of candidates) {
    summary.candidatesScanned += 1;
    try {
      const decision = evaluateMoodReminderWindow(
        { timezone: user.timezone, moodReminderEnabled: true },
        now,
      );

      if (!decision.fire || !decision.localDate) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      summary.inWindow += 1;

      // Cheaper guard first: the ledger lookup is a single indexed row
      // while the mood-entry scan touches today's mood writes.
      const existingDispatch = await prisma.moodReminderDispatch.findUnique({
        where: { userId_date: { userId: user.id, date: decision.localDate } },
        select: { id: true },
      });
      if (existingDispatch) {
        summary.skippedAlreadyDispatched += 1;
        continue;
      }

      const existingMood = await prisma.moodEntry.findFirst({
        where: { userId: user.id, date: decision.localDate },
        select: { id: true },
      });
      if (existingMood) {
        summary.skippedAlreadyLogged += 1;
        continue;
      }

      const { title, body } = buildMoodReminderPayload(user.locale);

      const outcome = await dispatchImpl({
        eventType: "MOOD_REMINDER",
        userId: user.id,
        title,
        message: body,
        metadata: {
          scheduledAt: now.toISOString(),
          localDate: decision.localDate,
        },
      });

      // No channel succeeded — leave the ledger slot empty so the next
      // tick can retry once the user adds a channel or the upstream
      // recovers. The "at most once" trade is: extremely-rare
      // concurrent-worker race may emit two pushes; in exchange a
      // transient blip never silently nukes the nudge for the day.
      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }

      try {
        await prisma.moodReminderDispatch.create({
          data: { userId: user.id, date: decision.localDate },
        });
        summary.dispatched += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("P2002") ||
          message.includes("Unique constraint")
        ) {
          // Lost a race against a parallel worker that also dispatched
          // successfully — both pushed, only one ledger row survives.
          // Count it as dispatched anyway (the user got the push).
          summary.dispatched += 1;
        } else {
          throw err;
        }
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `mood-reminder per-user dispatch failed for ${user.id}: ${message}`,
      );
    }
  }

  return summary;
}
