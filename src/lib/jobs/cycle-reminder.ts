/**
 * v1.15 — cycle reminder dispatcher (period-soon + period-start-confirm).
 *
 * Mirrors `mood-reminder.ts` and the medication-reminder cron: a cron tick
 * fires every 15 minutes, and when it lands inside the user's reminder hour
 * in their local timezone this module loads only the in-window cohort —
 * cycle-tracking-enabled users whose cached `CyclePrediction.nextPeriodStart`
 * falls inside the reminder window — decides who is in-window, and dispatches
 * at most
 * one push per event per local day through the existing
 * APNs → Telegram → ntfy → Web-Push cascade (`dispatchNotification`), which
 * records every attempt in `push_attempts`.
 *
 * Two events, both default-OFF and gated TWICE (per-event default + the
 * `CycleProfile.cycleTrackingEnabled` flag):
 *
 *   - CYCLE_PERIOD_SOON   — a couple of days before the predicted next-period
 *                           start (`PERIOD_SOON_LEAD_DAYS`).
 *   - CYCLE_PERIOD_CONFIRM — a gentle "did your period start?" on/after the
 *                           predicted start while no observed cycle is logged,
 *                           for up to `PERIOD_CONFIRM_GRACE_DAYS`.
 *
 * Two suppression rules ride on top of the dispatcher cascade:
 *
 *   - `notificationPrefs.cycle.clientManaged` — when true, iOS owns the local
 *     reminders, so the server skips its push and emits a
 *     `cycle_reminder.suppressed_client_managed` wide-event annotation (the
 *     medication `clientManaged` precedent).
 *   - `CycleProfile.discreetNotifications` — when true, the push body is the
 *     generic "HealthLog reminder" so no cycle event is named on the lock
 *     screen. The decision is made here, where the localised body is composed.
 *
 * Idempotency is anchored on the `push_attempts` ledger itself (no new table):
 * before dispatching, the runner checks whether an `ok` attempt for the same
 * event already landed for the user's local day. The cron worker runs
 * single-flight (`localConcurrency: 1`) so two ticks never race the
 * fire-and-forget ledger write.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { coerceLocale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { dayDiff } from "@/lib/cycle/day-math";
import { isModuleEnabled } from "@/lib/modules/gate";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import type { EventType } from "@/lib/notifications/types";
import { isCycleReminderClientManaged } from "@/lib/validations/notification-prefs";
import { getEvent } from "@/lib/logging/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { logCaught } from "@/lib/logging/signal";

/**
 * Local-time hour (0–23) at which the daily cycle reminder fires. 09:00 is
 * a calm morning slot that does not collide with the medication-reminder
 * hot path (top of the hour) or the mood reminder (22:00). Fixed for v1.15
 * (no per-user override yet); exported so the tests can pin the window.
 */
export const CYCLE_REMINDER_LOCAL_HOUR = 9;

/** Days before the predicted next-period start that PERIOD_SOON fires. */
export const PERIOD_SOON_LEAD_DAYS = 2;

/**
 * Days before the predicted fertile-window start that FERTILE_SOON fires.
 * Same calm two-day lead as PERIOD_SOON — enough notice to act on the
 * conception goal without nagging. Only ever reached for the
 * `TRYING_TO_CONCEIVE` goal (gated in `runCycleReminderTick`).
 */
export const FERTILE_SOON_LEAD_DAYS = 2;

/**
 * Days on/after the predicted next-period start that PERIOD_CONFIRM keeps
 * nudging while no period is logged. Day 0 (the predicted start) through
 * this many days inclusive; after that the runner gives up for the cycle.
 */
export const PERIOD_CONFIRM_GRACE_DAYS = 3;

export type CycleReminderEvent =
  "CYCLE_PERIOD_SOON" | "CYCLE_PERIOD_CONFIRM" | "CYCLE_FERTILE_SOON";

export interface CycleReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatchedPeriodSoon: number;
  dispatchedPeriodConfirm: number;
  dispatchedFertileSoon: number;
  suppressedClientManaged: number;
  suppressedDiscreet: number;
  skippedAlreadyNotified: number;
  skippedNoChannel: number;
  skippedOutsideWindow: number;
  skippedPredictionDisabled: number;
  skippedModuleDisabled: number;
  skippedAlreadyLogged: number;
  failed: number;
}

/**
 * `YYYY-MM-DD` for `now + offsetDays` in UTC. Used only to bound the
 * `nextPeriodStart` query window generously across timezones; the exact
 * per-user-local window is applied by `evaluateCycleReminder`.
 */
function utcDateString(now: Date, offsetDays: number): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return `${d.getUTCFullYear().toString().padStart(4, "0")}-${(
    d.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

function emptySummary(): CycleReminderSummary {
  return {
    candidatesScanned: 0,
    inWindow: 0,
    dispatchedPeriodSoon: 0,
    dispatchedPeriodConfirm: 0,
    dispatchedFertileSoon: 0,
    suppressedClientManaged: 0,
    suppressedDiscreet: 0,
    skippedAlreadyNotified: 0,
    skippedNoChannel: 0,
    skippedOutsideWindow: 0,
    skippedPredictionDisabled: 0,
    skippedModuleDisabled: 0,
    skippedAlreadyLogged: 0,
    failed: 0,
  };
}

/**
 * Compute the user's local `YYYY-MM-DD` date when `now` falls inside the
 * cycle-reminder hour; `null` otherwise (outside the window). Pulled out so
 * the unit tests can pin the boundary (08:59 → null, 09:00 → date,
 * 09:59 → date, 10:00 → null) without a DB.
 */
export function cycleReminderLocalDate(
  now: Date,
  timezone: string,
): string | null {
  const parts = wallClockInTz(now, timezone || DEFAULT_TIMEZONE);
  if (parts.hour !== CYCLE_REMINDER_LOCAL_HOUR) return null;
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

/**
 * Pure decision predicate: given the user's local date and their cached
 * forecast, which cycle reminder (if any) should fire today?
 *
 * Returns the event to dispatch, or `null` to skip. Kept DB-free so the
 * windowing contract is unit-testable in isolation:
 *
 *   - PERIOD_SOON   when `dayDiff(nextPeriodStart, today) === lead` and no
 *     period has already been logged near the prediction.
 *   - PERIOD_CONFIRM when today is on/after the predicted start and within
 *     the grace window AND no observed cycle has been logged yet
 *     (`periodAlreadyLogged === false`).
 *
 * Either nudge is suppressed once a period IS logged near the prediction —
 * an early period makes the "soon" nudge stale and the "confirm" nudge moot.
 */
export function evaluateCycleReminder(
  args: {
    today: string;
    nextPeriodStart: string;
    periodAlreadyLogged: boolean;
  },
  leadDays: number = PERIOD_SOON_LEAD_DAYS,
  graceDays: number = PERIOD_CONFIRM_GRACE_DAYS,
): CycleReminderEvent | null {
  // A logged period near the prediction silences both nudges — the forecast
  // is already confirmed (the cache regenerates to the next cycle shortly).
  if (args.periodAlreadyLogged) return null;

  const daysUntil = dayDiff(args.nextPeriodStart, args.today);

  if (daysUntil === leadDays) {
    return "CYCLE_PERIOD_SOON";
  }

  // On/after the predicted start (daysUntil <= 0), within the grace window
  // → nudge to confirm (the already-logged case returned null above).
  if (daysUntil <= 0 && daysUntil >= -graceDays) {
    return "CYCLE_PERIOD_CONFIRM";
  }

  return null;
}

/**
 * Pure decision predicate for the fertile-window reminder: fire when the
 * user's local date is exactly `leadDays` before the predicted fertile
 * window start. DB-free + goal-agnostic by design — the TTC goal gate and
 * the `fertileWindowStart != null` check both live in the runner, where the
 * profile and forecast are loaded; this only owns the lead-day windowing so
 * the boundary (08:59 → no, the lead day → yes) stays unit-testable.
 */
export function evaluateFertileReminder(
  args: { today: string; fertileWindowStart: string },
  leadDays: number = FERTILE_SOON_LEAD_DAYS,
): boolean {
  return dayDiff(args.fertileWindowStart, args.today) === leadDays;
}

/**
 * Build the localised title + body for a cycle reminder push. When
 * `discreet` is true, both collapse to the generic "HealthLog reminder"
 * copy so no cycle event is named on the lock screen (the §6.4 discreet
 * mode). Pulled out so a template change is testable without the runner.
 */
export function buildCycleReminderPayload(
  event: CycleReminderEvent,
  locale: string | null | undefined,
  discreet: boolean,
): { title: string; body: string } {
  const t = getServerTranslator(coerceLocale(locale)).t;
  if (discreet) {
    return {
      title: t("cycleReminders.discreetTitle"),
      body: t("cycleReminders.discreetBody"),
    };
  }
  if (event === "CYCLE_PERIOD_SOON") {
    return {
      title: t("cycleReminders.periodSoonTitle"),
      body: t("cycleReminders.periodSoonBody"),
    };
  }
  if (event === "CYCLE_FERTILE_SOON") {
    return {
      title: t("cycleReminders.fertileSoonTitle"),
      body: t("cycleReminders.fertileSoonBody"),
    };
  }
  return {
    title: t("cycleReminders.periodConfirmTitle"),
    body: t("cycleReminders.periodConfirmBody"),
  };
}

/**
 * Has an `ok` push attempt for `event` already landed for the user today
 * (their local day window)? The `push_attempts` ledger doubles as the
 * idempotency anchor so no extra table is needed. Best-effort: a DB error
 * biases toward "not yet notified" so a transient blip never silently nukes
 * the day's nudge (the at-most-once trade the mood reminder also makes).
 */
async function alreadyNotifiedToday(
  prisma: PrismaClient,
  userId: string,
  event: EventType,
  localDayStartUtc: Date,
  localDayEndUtc: Date,
): Promise<boolean> {
  try {
    const row = await prisma.pushAttempt.findFirst({
      where: {
        userId,
        eventType: event,
        result: "ok",
        createdAt: { gte: localDayStartUtc, lt: localDayEndUtc },
      },
      select: { id: true },
    });
    return row !== null;
  } catch (err) {
    // Fail toward "not yet notified": a read failure must not silence the
    // reminder for the day, but it has to be visible.
    logCaught("cycle.reminder.dedupe_read_failed", err);
    return false;
  }
}

/**
 * Run one cycle-reminder cron tick. Iterates every user whose cycle
 * tracking is enabled and who has a cached forecast, checks the local-time
 * window + the prediction window, and dispatches at most one push per event
 * per local day, honouring `clientManaged` and `discreetNotifications`.
 *
 * `dispatch` is injectable so the unit tests exercise the decision +
 * suppression logic without a live dispatcher.
 */
export async function runCycleReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
    /**
     * v1.18.0 module gate — injectable so the unit tests pin the
     * operator/user disabled-module skip without booting the gate's DB
     * reads. Defaults to the real `isModuleEnabled` resolver. The `cycle`
     * ModuleKey resolves the per-user toggle AND the operator server-wide
     * kill-switch, mirroring the mood / measurement reminder crons.
     */
    isModuleEnabled?: typeof isModuleEnabled;
  } = {},
): Promise<CycleReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const moduleGate = options.isModuleEnabled ?? isModuleEnabled;
  const summary = emptySummary();

  // Push the gating into the query so the per-tick cost scales with the
  // in-window cohort, not the whole `CyclePrediction` table. Three filters
  // run server-side:
  //
  //   1. the user's `cycleProfile` must have `cycleTrackingEnabled` (an
  //      account that never opted in can never receive a cycle push), and
  //      `predictionEnabled` must not be explicitly off,
  //   2. either `nextPeriodStart` OR `fertileWindowStart` (both `YYYY-MM-DD`
  //      strings) must fall inside its reminder window [today − grace,
  //      today + lead]. The string range is computed against a tz-generous
  //      span (±1 day past the exact lead/grace) so a user whose local date
  //      differs from UTC by a day is never excluded at the query layer —
  //      `evaluateCycleReminder` / `evaluateFertileReminder` still apply the
  //      exact per-user-timezone window below. The fertile window sits ~2
  //      weeks ahead of the period start, so it needs its own date range
  //      rather than riding the period-start filter.
  //
  // The pure-string `gte`/`lte` range is correct because `YYYY-MM-DD`
  // ordering is lexicographic-equals-chronological.
  const windowFloor = utcDateString(now, -(PERIOD_CONFIRM_GRACE_DAYS + 1));
  const windowCeil = utcDateString(now, PERIOD_SOON_LEAD_DAYS + 1);
  const fertileCeil = utcDateString(now, FERTILE_SOON_LEAD_DAYS + 1);
  const fertileFloor = utcDateString(now, -1);

  const predictions = await prisma.cyclePrediction.findMany({
    where: {
      OR: [
        { nextPeriodStart: { gte: windowFloor, lte: windowCeil } },
        { fertileWindowStart: { gte: fertileFloor, lte: fertileCeil } },
      ],
      user: {
        cycleProfile: {
          cycleTrackingEnabled: true,
          NOT: { predictionEnabled: false },
        },
      },
    },
    select: {
      userId: true,
      nextPeriodStart: true,
      fertileWindowStart: true,
      user: {
        select: {
          id: true,
          gender: true,
          timezone: true,
          locale: true,
          notificationPrefs: true,
          cycleProfile: {
            select: {
              goal: true,
              cycleTrackingEnabled: true,
              predictionEnabled: true,
              discreetNotifications: true,
            },
          },
        },
      },
    },
  });

  for (const pred of predictions) {
    summary.candidatesScanned += 1;
    const user = pred.user;
    try {
      const profile = user.cycleProfile;

      // Gate on the FULLY-resolved cycle module — the per-user toggle
      // (gender-derived or explicit opt-in) AND the operator server-wide
      // kill-switch. v1.18.0: the `cycle` ModuleKey resolves through
      // `isModuleEnabled`, so an operator who disables the Cycle module
      // (`AppSettings.moduleAvailabilityJson.cycle = false`) suppresses
      // every CYCLE_PERIOD push for every account — the same two-layer gate
      // the routes and the coach cycle block read. A per-user-disabled
      // account is likewise skipped. The `profile` row read below still
      // applies the `predictionEnabled` opt-out.
      if (!(await moduleGate(user.id, "cycle"))) {
        summary.skippedModuleDisabled += 1;
        getEvent()?.addMeta("cycle_reminder.skipped_module_disabled", user.id);
        continue;
      }

      // No predictions when the user opted out of algorithmic interpretation.
      if (profile && profile.predictionEnabled === false) {
        summary.skippedPredictionDisabled += 1;
        continue;
      }

      const timezone = user.timezone || DEFAULT_TIMEZONE;
      const today = cycleReminderLocalDate(now, timezone);
      if (!today) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      summary.inWindow += 1;

      const timezoneForBounds = timezone;
      // Local day's UTC bounds for the ledger idempotency lookup, computed
      // once and shared by every event we may fire for this user this tick.
      // `end` is the last millisecond of the day, so add 1 ms for half-open.
      const { start: dayStartUtc, end: dayEndInclusive } = getUserTodayBounds(
        now,
        timezoneForBounds,
      );
      const dayEndExclusive = new Date(dayEndInclusive.getTime() + 1);

      // Shared dispatch tail: clientManaged suppression → idempotency →
      // discreet body → dispatch → counter. Reused verbatim by the
      // period-soon / period-confirm nudge and the fertile-window nudge so a
      // change to the suppression cascade can never drift between them.
      const dispatchEvent = async (
        event: CycleReminderEvent,
      ): Promise<void> => {
        // clientManaged suppression — iOS owns the local reminders. Mirror
        // the medication path: skip the server push, emit the annotation.
        if (isCycleReminderClientManaged(user.notificationPrefs)) {
          summary.suppressedClientManaged += 1;
          getEvent()?.addMeta(
            "cycle_reminder_suppressed_client_managed",
            `${event}:${today}`,
          );
          getEvent()?.addMeta("cycle_reminder_suppressed_meta", {
            user_id: user.id,
            event,
            local_date: today,
          });
          return;
        }

        // Idempotency: one push per event per local day.
        const seen = await alreadyNotifiedToday(
          prisma,
          user.id,
          event,
          dayStartUtc,
          dayEndExclusive,
        );
        if (seen) {
          summary.skippedAlreadyNotified += 1;
          return;
        }

        const discreet = profile?.discreetNotifications === true;
        if (discreet) summary.suppressedDiscreet += 1;

        const { title, body } = buildCycleReminderPayload(
          event,
          await resolveJobLocale(user.locale),
          discreet,
        );

        const outcome = await dispatchImpl({
          eventType: event,
          userId: user.id,
          title,
          message: body,
          // In discreet mode the senders mask the lock-screen routing
          // metadata so no cycle event is named on the lock screen.
          discreet,
          metadata: {
            scheduledAt: now.toISOString(),
            localDate: today,
          },
        });

        if (!outcome.dispatched) {
          summary.skippedNoChannel += 1;
          return;
        }

        if (event === "CYCLE_PERIOD_SOON") summary.dispatchedPeriodSoon += 1;
        else if (event === "CYCLE_FERTILE_SOON")
          summary.dispatchedFertileSoon += 1;
        else summary.dispatchedPeriodConfirm += 1;
      };

      // Has the user already logged an observed (non-predicted) cycle
      // starting on/around the predicted day? If so, the confirm nudge is
      // moot. We look for any observed cycle whose start is within the
      // grace window of the prediction.
      const periodAlreadyLogged = await hasObservedPeriodNearPrediction(
        prisma,
        user.id,
        pred.nextPeriodStart,
      );

      const periodEvent = evaluateCycleReminder({
        today,
        nextPeriodStart: pred.nextPeriodStart,
        periodAlreadyLogged,
      });

      // Fertile-window nudge — TWICE gated: the conception goal AND a
      // non-null `fertileWindowStart` (the engine only populates it for the
      // TTC goal). Never surfaces fertile language to AVOID_PREGNANCY /
      // GENERAL_HEALTH / PERIMENOPAUSE (the inclusive-framing rule).
      const fertileDue =
        profile?.goal === "TRYING_TO_CONCEIVE" &&
        pred.fertileWindowStart != null &&
        evaluateFertileReminder({
          today,
          fertileWindowStart: pred.fertileWindowStart,
        });

      if (!periodEvent && !fertileDue) {
        if (periodAlreadyLogged) summary.skippedAlreadyLogged += 1;
        else summary.skippedOutsideWindow += 1;
        continue;
      }

      if (periodEvent) await dispatchEvent(periodEvent);
      if (fertileDue) await dispatchEvent("CYCLE_FERTILE_SOON");
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `cycle-reminder per-user dispatch failed for ${user.id}: ${message}`,
      );
    }
  }

  return summary;
}

/**
 * Observed (non-predicted, non-deleted) period logged within the grace
 * window of the predicted start? Used to suppress the confirm nudge once
 * the user has logged their period. A query failure biases toward "not
 * logged" so the nudge still fires rather than silently going quiet.
 */
async function hasObservedPeriodNearPrediction(
  prisma: PrismaClient,
  userId: string,
  predictedStart: string,
): Promise<boolean> {
  try {
    const candidates = await prisma.menstrualCycle.findMany({
      where: { userId, isPredicted: false, deletedAt: null },
      select: { startDate: true },
      orderBy: { startDate: "desc" },
      take: 12,
    });
    return candidates.some((c) => {
      const delta = dayDiff(c.startDate, predictedStart);
      return (
        delta >= -PERIOD_CONFIRM_GRACE_DAYS && delta <= PERIOD_SOON_LEAD_DAYS
      );
    });
  } catch (err) {
    logCaught("cycle.reminder.period_read_failed", err);
    return false;
  }
}
