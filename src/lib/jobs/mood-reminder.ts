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
 *      title + body and records the dispatch ledger row in the same
 *      transaction so a concurrent worker can't double-fire.
 *
 * Why a separate module instead of folding it into reminder-worker.ts:
 * the worker is already 1800 LOC. Splitting the mood-reminder logic out
 * keeps the test surface focused and lets the unit tests run without
 * booting pg-boss.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale } from "@/lib/i18n/config";
import { getLocalDateParts } from "@/lib/timezone";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

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

/**
 * Minimal user shape needed to decide whether to dispatch. Defined
 * explicitly so the handler can run against either the global Prisma
 * client or the per-worker singleton without re-deriving the type.
 */
export interface MoodReminderCandidate {
  id: string;
  timezone: string;
  locale: string | null;
  moodReminderEnabled: boolean;
}

export interface MoodReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatched: number;
  skippedAlreadyLogged: number;
  skippedAlreadyDispatched: number;
  skippedOutsideWindow: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locale === "en" || locale === "de" ? locale : defaultLocale;
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
  user: Pick<MoodReminderCandidate, "timezone" | "moodReminderEnabled">,
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
 * workers (or a re-tick inside the same hour) won't double-fire.
 *
 * Returns a summary so the worker can attach it to the wide-event for
 * the observability dashboards.
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
  };

  const candidates = await prisma.user.findMany({
    where: { moodReminderEnabled: true },
    select: {
      id: true,
      timezone: true,
      locale: true,
      moodReminderEnabled: true,
    },
  });

  for (const user of candidates) {
    summary.candidatesScanned += 1;
    const decision = evaluateMoodReminderWindow(
      {
        timezone: user.timezone,
        moodReminderEnabled: user.moodReminderEnabled,
      },
      now,
    );

    if (!decision.fire || !decision.localDate) {
      summary.skippedOutsideWindow += 1;
      continue;
    }

    summary.inWindow += 1;

    // Already nudged today? The dedup row is the source of truth — if
    // a previous tick succeeded, this branch swallows the work. We
    // check before the MoodEntry lookup because the ledger query is
    // strictly cheaper (single indexed row) than scanning today's
    // mood entries.
    const existingDispatch = await prisma.moodReminderDispatch.findUnique({
      where: { userId_date: { userId: user.id, date: decision.localDate } },
      select: { id: true },
    });
    if (existingDispatch) {
      summary.skippedAlreadyDispatched += 1;
      continue;
    }

    // Skip when the user already logged a mood for the local date. Same
    // anchoring convention as `MoodEntry.date` (YYYY-MM-DD in the user's
    // current timezone). Legacy rows that pre-date the `tz` column are
    // already pinned to Europe/Berlin via the storage convention; here
    // we accept whatever `date` string the row carries because the
    // user-experience contract is "I logged today, don't nudge me".
    const existingMood = await prisma.moodEntry.findFirst({
      where: { userId: user.id, date: decision.localDate },
      select: { id: true },
    });
    if (existingMood) {
      summary.skippedAlreadyLogged += 1;
      continue;
    }

    // Reserve the dedup row FIRST so a parallel worker that races us
    // hits the unique-constraint violation and bails before fanning a
    // duplicate push. We catch the P2002 unique-violation path
    // explicitly because a "lost the race" outcome is not a worker
    // error — it's the idempotency contract doing its job.
    try {
      await prisma.moodReminderDispatch.create({
        data: { userId: user.id, date: decision.localDate },
      });
    } catch (err: unknown) {
      // Prisma encodes unique-violation as `code === 'P2002'`. Detect
      // by string-includes rather than instanceof so this module
      // doesn't pull in the Prisma runtime types just for the guard.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("P2002") || message.includes("Unique constraint")) {
        summary.skippedAlreadyDispatched += 1;
        continue;
      }
      throw err;
    }

    const { title, body } = buildMoodReminderPayload(user.locale);

    await dispatchImpl({
      eventType: "MOOD_REMINDER",
      userId: user.id,
      title,
      message: body,
      metadata: {
        scheduledAt: now.toISOString(),
        localDate: decision.localDate,
      },
    });

    summary.dispatched += 1;
  }

  return summary;
}
