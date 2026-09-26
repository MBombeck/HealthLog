/**
 * v1.17.1 — Vorsorge (measurement) reminder dispatcher.
 *
 * Mirrors the mood-reminder cron (`mood-reminder.ts`): a separate module,
 * a pure due-predicate, a `runMeasurementReminderTick(prisma, now)`
 * runner. The cron fires every 15 minutes so it picks up every IANA
 * timezone crossing the reminder's `notifyHour` without one cron entry
 * per zone.
 *
 * Differences from the mood reminder:
 *
 *   1. What a delivered reminder does to the row depends on its cycle.
 *      A reminder whose next slot is more than a week away (a fortnightly
 *      questionnaire, a yearly check-up) or that has no next slot at all (a
 *      one-shot) stays due until it is satisfied, skipped or snoozed, so the
 *      start page and the check-up card keep showing it as due and then
 *      overdue; rolling it on silently filed an open task under a later
 *      slot. While it stays open it is reminded again at most once a week,
 *      gated on `lastNotifiedAt` (see `isCheckupRepeatHeld`). A reminder on
 *      a weekly or shorter cycle rolls on to its next slot, which is the
 *      next nudge anyway, and an appointment (`origin: ENCOUNTER`) is
 *      one-shot and closes (see `staysDueAfterReminder`). The per-day claim
 *      in `notification_events` stays the guard against a second send on
 *      the same local day.
 *   2. Auto-resolve from an incoming measurement. Before deciding to
 *      fire, the runner checks whether a matching reading of the
 *      reminder's `measurementType` has landed since the last satisfy
 *      (BP matched on `BLOOD_PRESSURE_SYS`). If so it advances
 *      `lastSatisfiedAt` + recomputes `nextDueAt` and skips the nudge —
 *      the user who already measured today never gets nagged. This is a
 *      query in the cron, NOT a hook on the hot iOS batch-ingest path.
 *      Free-text reminders (no `measurementType`) never auto-resolve;
 *      they advance only on a manual satisfy.
 *   3. `notificationPrefs.measurementReminder.clientManaged` suppresses the
 *      server-side APNs send only, and it does so in the dispatcher — the
 *      tick dispatches for every user and lets the cascade decide.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { MeasurementType } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { coerceLocale, type Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import {
  claimNotificationEvent,
  REMINDER_DEDUP_LOOKBACK_MS,
} from "@/lib/notifications/reminder-dedup";
import { getEvent } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { ModuleKey } from "@/lib/modules/registry";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { findSatisfyingEvent } from "@/lib/measurement-reminders/resolve";
import { satisfyReminder } from "@/lib/measurement-reminders/satisfy";
import { evaluateCoachContextReminders } from "@/lib/ai/coach/context-reminders";
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";

/**
 * v1.18.0 — map a reminder's `measurementType` to the toggleable module
 * that owns it, or `null` when the type is a CORE domain (weight, blood
 * pressure, pulse, body composition) or has no module of its own. A
 * `null` reminder type (free-text Vorsorge entry) also yields `null`.
 *
 * Only the secondary-domain types carry a gate: glucose, sleep, and the
 * mental-wellbeing screenings (v1.27.6 — the PHQ-9 / GAD-7 module is
 * opt-in, so a screening reminder must fall silent the moment the module
 * is off). Everything else is core and dispatches regardless — disabling
 * a module must never silence a core-vital reminder.
 */
function moduleForMeasurementType(
  type: MeasurementType | null,
): ModuleKey | null {
  switch (type) {
    case "BLOOD_GLUCOSE":
      return "glucose";
    case "SLEEP_DURATION":
      return "sleep";
    case "PHQ9_SCORE":
    case "GAD7_SCORE":
    case "WHO5_SCORE":
    case "SCI_SCORE":
      return "mentalHealth";
    default:
      return null;
  }
}

/**
 * Slack added to `now` when scanning for due reminders, so a `nextDueAt`
 * stamped just ahead of a tick still falls inside the same hour window.
 * One tick interval (15 min) — small enough that the in-Node hour gate stays
 * the authoritative fire decision.
 */
const DUE_QUERY_SLACK_MS = 15 * 60_000;

/**
 * Calendar days an open reminder waits before it is sent again, and the cycle
 * length at or under which a reminder rolls on instead of staying due: a
 * weekly or daily reminder's own next slot comes round at least as soon as the
 * repeat would.
 */
export const CHECKUP_REPEAT_DAYS = 7;

/**
 * v1.39.2 — whether a delivered reminder leaves the row due.
 *
 * Decided by the cycle length, not by what the reminder asks for. A reminder
 * whose next slot is more than a week away stays due until it is satisfied (a
 * matching reading or lab result, or "done"), skipped or snoozed: rolling it
 * on would file an open task under a slot weeks or a year away. That held for
 * free-text check-ups and for measurement reminders alike; the report that
 * led here was a fortnightly PHQ-9 and GAD-7 pair that each rolled two weeks
 * forward the morning they were reminded, without either questionnaire being
 * filled. A one-shot (no interval, no rule) has no next slot and also stays
 * due. A reminder on a weekly or shorter cycle rolls on as before, because its
 * next slot is the next reminder anyway; holding a daily course on a missed
 * slot would stall it. A cadence with no next slot left rolls to nothing as
 * before. An appointment (`ENCOUNTER`) always stays one-shot.
 */
export function staysDueAfterReminder(
  reminder: {
    origin?: string | null;
    intervalDays: number | null;
    rrule: string | null;
  },
  rolledTo: Date | null,
  timezone: string,
  now: Date,
): boolean {
  if (reminder.origin === "ENCOUNTER") return false;
  if (reminder.intervalDays === null && reminder.rrule === null) return true;
  if (rolledTo === null) return false;
  return calendarDaysUntil(rolledTo, now, timezone) > CHECKUP_REPEAT_DAYS;
}

/**
 * v1.39.2 — whether an open check-up's repeat nudge is still being held.
 *
 * Held when the last delivered nudge was for THIS slot (`lastNotifiedAt` at
 * or after `nextDueAt`) and fewer than {@link CHECKUP_REPEAT_DAYS} calendar
 * days have passed in the person's timezone. Calendar days rather than a
 * 7 × 24 h gap, because the tick fires within the notify hour and the next
 * week's tick can land a few seconds earlier on the clock than the first
 * send did.
 *
 * A slot that moved after the last nudge — a snooze to a named day, a
 * Telegram "later", a skip, a satisfy — is a new slot and is never held.
 */
export function isCheckupRepeatHeld(
  reminder: { nextDueAt: Date | null; lastNotifiedAt?: Date | null },
  timezone: string,
  now: Date,
): boolean {
  const { nextDueAt, lastNotifiedAt } = reminder;
  if (!nextDueAt || !lastNotifiedAt) return false;
  if (lastNotifiedAt.getTime() < nextDueAt.getTime()) return false;
  return calendarDaysUntil(now, lastNotifiedAt, timezone) < CHECKUP_REPEAT_DAYS;
}

export interface MeasurementReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatched: number;
  autoResolved: number;
  skippedNotDue: number;
  skippedOutsideWindow: number;
  skippedModuleDisabled: number;
  skippedNoChannel: number;
  /** v1.37.19 (A6-7) — slot already claimed for this local day (racing worker or crash-recovery replay). */
  skippedAlreadyClaimed: number;
  /** v1.39.2 — open check-up already reminded for this slot within the week. */
  skippedRepeatHeld: number;
  /** v1.18.1 — expired COACH course-window reminders soft-deleted this tick. */
  expiredCleaned: number;
  failed: number;
}

/**
 * v1.18.1 — soft-delete COACH course-window reminders whose finite window
 * has elapsed. A Coach-suggested protocol (the ESH/AHA 7-day BP cadence)
 * carries a non-NULL `endsOn`; once the recurrence engine walks past it the
 * row's `nextDueAt` is stamped NULL (no future occurrence). Such a row can
 * never fire again, so it would otherwise linger forever in the Vorsorge
 * list as a dead "completed course". Tombstone it so the surface stays
 * clean. Scoped to `origin: COACH` so a user's open-ended VORSORGE row with
 * a one-shot `endsOn` is never touched without intent.
 */
async function cleanupExpiredCoachReminders(
  prisma: PrismaClient,
  now: Date,
): Promise<number> {
  const result = await prisma.measurementReminder.updateMany({
    where: {
      deletedAt: null,
      origin: "COACH",
      endsOn: { not: null, lt: now },
      nextDueAt: null,
    },
    data: { deletedAt: now },
  });
  return result.count;
}

/**
 * Pure due-predicate: at this instant, is the reminder due AND inside its
 * local notify-hour window?
 *
 * "Due" = `nextDueAt != null` and `now >= nextDueAt`. The hour gate keeps
 * a reminder that became overdue overnight from firing at 03:00 — it
 * waits for the user's chosen `notifyHour` to come round in their local
 * timezone. Pulled out so the unit tests can pin the window boundary
 * (08:59 → no, 09:00 → yes, 09:59 → yes, 10:00 → no) without the DB.
 */
export function evaluateMeasurementReminderDue(
  reminder: {
    enabled: boolean;
    nextDueAt: Date | null;
    notifyHour: number;
  },
  timezone: string,
  now: Date,
): { fire: boolean; inHourWindow: boolean; isDue: boolean } {
  if (!reminder.enabled || reminder.nextDueAt === null) {
    return { fire: false, inHourWindow: false, isDue: false };
  }
  const isDue = now.getTime() >= reminder.nextDueAt.getTime();
  const parts = wallClockInTz(now, timezone || "Europe/Berlin");
  const inHourWindow = parts.hour === reminder.notifyHour;
  return { fire: isDue && inHourWindow, inHourWindow, isDue };
}

/**
 * Build the localised title + body for the Vorsorge push.
 */
export function buildMeasurementReminderPayload(
  locale: string | null | undefined,
  label: string,
  location: string | null,
): { title: string; body: string } {
  const t = getServerTranslator(coerceLocale(locale)).t;
  const base = t("measurementReminders.pushBody", { label });
  const body = location
    ? `${base} ${t("measurementReminders.pushLocation", { location })}`
    : base;
  return { title: t("measurementReminders.pushTitle"), body };
}

/**
 * Run one Vorsorge-reminder cron tick. Iterates every live, enabled
 * reminder, auto-resolves the typed ones against incoming readings,
 * and dispatches a `MEASUREMENT_REMINDER` push for any that are due
 * inside the user's local notify-hour window.
 */
export async function runMeasurementReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
    /**
     * v1.18.0 module gate — injectable so the unit tests pin the
     * disabled-module skip without the gate's DB reads. Defaults to the
     * real `isModuleEnabled` resolver.
     */
    isModuleEnabled?: typeof isModuleEnabled;
  } = {},
): Promise<MeasurementReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const moduleGate = options.isModuleEnabled ?? isModuleEnabled;

  const summary: MeasurementReminderSummary = {
    candidatesScanned: 0,
    inWindow: 0,
    dispatched: 0,
    autoResolved: 0,
    skippedNotDue: 0,
    skippedOutsideWindow: 0,
    skippedModuleDisabled: 0,
    skippedNoChannel: 0,
    skippedAlreadyClaimed: 0,
    skippedRepeatHeld: 0,
    expiredCleaned: 0,
    failed: 0,
  };

  // v1.18.1 — sweep expired COACH course-window reminders before scanning
  // the due set, so a self-expired protocol drops out of the list and the
  // dispatch loop never re-evaluates a row that can never fire again.
  summary.expiredCleaned = await cleanupExpiredCoachReminders(prisma, now);

  // Bound the scan to reminders that could plausibly fire this tick so Postgres
  // uses `measurement_reminders_user_id_next_due_at_idx` instead of loading the
  // whole cross-tenant enabled set 4×/hour. `nextDueAt` is stamped at the
  // notify-hour boundary, so anything due is already <= now; the small slack
  // (one tick interval) covers a stamp landing just ahead of a :00 tick. A
  // null `nextDueAt` is a non-recurring reminder that can never fire — the
  // in-Node `evaluateMeasurementReminderDue` short-circuits it anyway, so
  // excluding it here is parity. Reminders satisfied early re-anchor once they
  // cross due, before any nudge fires, so dropping future rows is safe.
  const dueFloor = new Date(now.getTime() + DUE_QUERY_SLACK_MS);
  const reminders = await prisma.measurementReminder.findMany({
    where: {
      deletedAt: null,
      enabled: true,
      nextDueAt: { not: null, lte: dueFloor },
    },
    include: {
      user: {
        select: {
          id: true,
          timezone: true,
          locale: true,
        },
      },
    },
  });

  for (const reminder of reminders) {
    summary.candidatesScanned += 1;
    try {
      const timezone = reminder.user.timezone || "Europe/Berlin";

      // ── Auto-resolve from an incoming event ────────────────────────
      // Cheap safety-net poll, in the cron (the eventful `reminder-satisfy`
      // worker is the fast path). A typed reminder resolves from a matching
      // Measurement; a free-text reminder resolves from a LabResult (the
      // Lab↔Vorsorge link). Both go through the shared `findSatisfyingEvent`
      // + `satisfyReminder` primitives so the cron and the worker can never
      // diverge. A reading inside the current due cycle means the user
      // already measured — re-anchor + skip the nudge.
      const satisfiedAt = await findSatisfyingEvent(
        prisma,
        reminder.user.id,
        reminder,
      );
      if (satisfiedAt) {
        const result = await satisfyReminder(
          prisma,
          reminder,
          timezone,
          satisfiedAt,
          // Which arm of `findSatisfyingEvent` matched: a typed reminder
          // resolves from a Measurement, a free-text one from a LabResult.
          reminder.measurementType !== null ? "auto_measurement" : "auto_lab",
        );
        if (result.satisfied) {
          summary.autoResolved += 1;
          continue;
        }
      }

      const decision = evaluateMeasurementReminderDue(
        {
          enabled: reminder.enabled,
          nextDueAt: reminder.nextDueAt,
          notifyHour: reminder.notifyHour,
        },
        timezone,
        now,
      );

      if (!decision.isDue) {
        summary.skippedNotDue += 1;
        continue;
      }
      if (!decision.inHourWindow) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      // v1.39.2 — an open check-up stays due after its nudge, so without
      // this it would qualify again at every notify hour. Once a week is the
      // repeat; the per-day claim below is not enough on its own.
      if (
        reminder.origin !== "ENCOUNTER" &&
        isCheckupRepeatHeld(reminder, timezone, now)
      ) {
        summary.skippedRepeatHeld += 1;
        continue;
      }

      summary.inWindow += 1;

      // v1.18.0 module gate — a reminder whose measurement type belongs to
      // a toggleable module (glucose / sleep) must not fire once the user
      // turns that module off. Core-vital reminders (weight / BP / pulse /
      // body comp) and free-text reminders map to no module and are never
      // gated. Checked after the due + window gates so the gate read only
      // fires for reminders that would otherwise dispatch this tick.
      const gatedModule = moduleForMeasurementType(reminder.measurementType);
      if (
        gatedModule !== null &&
        !(await moduleGate(reminder.user.id, gatedModule))
      ) {
        getEvent()?.addMeta(
          "measurement_reminder.skipped_module_disabled",
          `${reminder.id}:${gatedModule}`,
        );
        summary.skippedModuleDisabled += 1;
        // Advance past this cycle so a disabled-module reminder does not pin
        // the server tick re-evaluating the same overdue slot every 15
        // minutes for the rest of the day. The user turned the module off,
        // so there is nothing this reminder could still deliver.
        await advanceNextDue(prisma, reminder, timezone, now);
        continue;
      }

      // `measurementReminder.clientManaged` is NOT consulted here. It
      // suppresses the server's APNs send only — the dispatcher's APNs
      // branch owns that decision and emits the
      // `measurement_reminder.suppressed_client_managed` annotation per
      // skip. The tick used to suppress every channel AND advance
      // `nextDueAt`, so a preventive-care reminder that never reached the
      // user was filed as handled and vanished from the card and the digest.
      // Now, when nothing delivers, the no-channel branch below leaves the
      // reminder overdue and visible.
      // v1.37.19 (A6-7) — claim the slot BEFORE provider egress, the
      // documented claim-first pattern from `reminder-dedup.ts`. The old
      // order (dispatch, then advance `nextDueAt`) double-sent when the
      // worker crashed between the two; the claim is the durable record
      // that this reminder's due cycle went out today. The trade is the
      // same one the medication tick accepts: a crash mid-dispatch burns
      // the slot for this local day rather than risking a repeat, and the
      // next local day starts clean.
      const localDate = new Date(now).toLocaleDateString("sv-SE", {
        timeZone: timezone,
      });
      const claimed = await claimNotificationEvent(prisma, {
        recordUserId: reminder.user.id,
        eventType: "MEASUREMENT_REMINDER",
        dedupKey: `measurement:${reminder.id}:${localDate}`,
        since: new Date(now.getTime() - REMINDER_DEDUP_LOOKBACK_MS),
      });
      if (!claimed) {
        summary.skippedAlreadyClaimed += 1;
        continue;
      }

      const { title, body } = buildMeasurementReminderPayload(
        await resolveJobLocale(reminder.user.locale),
        reminder.label,
        reminder.location,
      );
      const renderForRecipient = (locale: Locale) => {
        const rendered = buildMeasurementReminderPayload(
          locale,
          reminder.label,
          reminder.location,
        );
        return { title: rendered.title, message: rendered.body };
      };

      // An appointment nudge is dispatched without its Done / Later
      // affordance. It rides the same event type as a checkup — one engine,
      // one cron, deliberately — but every by-id reminder surface refuses an
      // ENCOUNTER-origin row: satisfying one would mark an appointment
      // attended from a notification, and postponing one would move a date the
      // visit record still believes it owns. The channels each drop their own
      // affordance from this flag rather than re-deriving the origin.
      const outcome = await dispatchImpl({
        eventType: "MEASUREMENT_REMINDER",
        userId: reminder.user.id,
        title,
        message: body,
        renderForRecipient,
        ...(reminder.origin === "ENCOUNTER" ? { suppressActions: true } : {}),
        metadata: {
          scheduledAt: now.toISOString(),
          reminderId: reminder.id,
        },
      });

      // No channel succeeded — leave `nextDueAt` where it is. The claim
      // above holds for the rest of the local day (claim-first burns the
      // slot rather than re-flooding a failing channel — see
      // reminder-dedup.ts); the reminder stays overdue and visible on the
      // surface, and the next local day retries with a fresh key.
      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }

      // Dispatch succeeded. Record the delivery; a check-up keeps its due
      // date (it is still open, and `lastNotifiedAt` holds the repeat to a
      // week), everything else rolls on past this slot.
      const rolledTo = nextSlotAfterReminder(reminder, timezone, now);
      await prisma.measurementReminder.update({
        where: { id: reminder.id },
        data: staysDueAfterReminder(reminder, rolledTo, timezone, now)
          ? { lastNotifiedAt: now }
          : { nextDueAt: rolledTo, lastNotifiedAt: now },
      });
      summary.dispatched += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `measurement-reminder per-reminder dispatch failed for ${reminder.id}: ${message}`,
      );
    }
  }

  return summary;
}

export interface ReminderSatisfySummary {
  candidatesScanned: number;
  satisfied: number;
  skippedModuleDisabled: number;
  skippedNoEvent: number;
  /** Coach context-cue reminders the same ingest event surfaced. */
  coachContextSurfaced: number;
  failed: number;
}

/**
 * v1.18.1 — eventful satisfaction for one user. Called by the
 * `reminder-satisfy` worker right after a measurement / lab write lands
 * (from any ingest path: manual create, batch, or a device sync). The
 * 15-min cron remains the idempotent safety-net behind this.
 *
 * Loads the user's live, enabled reminders that could auto-resolve (typed
 * → a Measurement; free-text → a LabResult), and for each runs the SAME
 * `findSatisfyingEvent` + `satisfyReminder` primitives the cron uses, so
 * "I just weighed myself, stop reminding me" resolves immediately instead
 * of waiting up to 15 minutes.
 *
 * Respects the module toggle: a reminder whose measurement type belongs to
 * a disabled module produces no engine activity (the same gate the cron
 * dispatch applies). Forward-only `satisfyReminder` makes a duplicate
 * enqueue + the trailing cron poll converge without double-stamping.
 */
export async function runReminderSatisfyForUser(
  prisma: PrismaClient,
  userId: string,
  now: Date,
  options: { isModuleEnabled?: typeof isModuleEnabled } = {},
): Promise<ReminderSatisfySummary> {
  const moduleGate = options.isModuleEnabled ?? isModuleEnabled;

  const summary: ReminderSatisfySummary = {
    candidatesScanned: 0,
    satisfied: 0,
    skippedModuleDisabled: 0,
    skippedNoEvent: 0,
    coachContextSurfaced: 0,
    failed: 0,
  };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone || "Europe/Berlin";

  const reminders = await prisma.measurementReminder.findMany({
    where: { userId, deletedAt: null, enabled: true },
  });

  for (const reminder of reminders) {
    summary.candidatesScanned += 1;
    try {
      // Module toggle — no engine activity for a reminder whose type
      // belongs to a disabled module. Core-vital + free-text reminders map
      // to no module and are never gated.
      const gatedModule = moduleForMeasurementType(reminder.measurementType);
      if (gatedModule !== null && !(await moduleGate(userId, gatedModule))) {
        summary.skippedModuleDisabled += 1;
        continue;
      }

      const satisfiedAt = await findSatisfyingEvent(prisma, userId, reminder);
      if (!satisfiedAt) {
        summary.skippedNoEvent += 1;
        continue;
      }

      const result = await satisfyReminder(
        prisma,
        reminder,
        timezone,
        satisfiedAt,
        reminder.measurementType !== null ? "auto_measurement" : "auto_lab",
      );
      if (result.satisfied) {
        summary.satisfied += 1;
        getEvent()?.addMeta(
          "measurement_reminder.satisfied_eventful",
          reminder.id,
        );
      } else {
        // Forward-only no-op — the cron or a prior enqueue already
        // advanced this row past the event.
        summary.skippedNoEvent += 1;
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `reminder-satisfy per-reminder resolve failed for ${reminder.id}: ${message}`,
      );
    }
  }

  // Coach context-cue reminders ("next time you log X") ride the same
  // eventful hook: the measurement that satisfies a Vorsorge cadence is
  // the same evidence a NEXT_*_LOGGED cue waits for. Fault-isolated — a
  // context failure never costs the Vorsorge resolution above.
  try {
    const outcome = await evaluateCoachContextReminders(
      prisma,
      userId,
      "measurement",
      now,
    );
    summary.coachContextSurfaced = outcome.surfaced;
    summary.failed += outcome.errored;
  } catch (err: unknown) {
    summary.failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `reminder-satisfy coach context evaluation failed for ${userId}: ${message}`,
    );
  }

  return summary;
}

type RollableReminder = {
  id: string;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  lastSatisfiedAt: Date | null;
  createdAt: Date;
};

/**
 * The slot a reminder rolls on to after it fired at `now`: the next
 * occurrence strictly after `now`, or `null` when there is none (a one-shot,
 * or a course window that has ended). Does NOT touch `lastSatisfiedAt` — a
 * fired reminder is not "satisfied", it just rolls to its next slot.
 */
function nextSlotAfterReminder(
  reminder: RollableReminder,
  timezone: string,
  now: Date,
): Date | null {
  // The slot must move strictly forward. For an `rrule` the engine already
  // walks to the next strictly-after-now occurrence, so passing the row
  // as-is is correct. For a ROLLING reminder the engine anchors the
  // first-due slot AT `anchorDate ?? createdAt` when never satisfied, which
  // stays ≤ now and would re-fire every tick — so re-anchor the rolling
  // cadence on `now` (a fire is the rhythm restarting from this dispatch) to
  // roll it forward by exactly one interval.
  const rolling = reminder.intervalDays !== null;
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: rolling ? now : reminder.lastSatisfiedAt,
    createdAt: reminder.createdAt,
  };
  return computeReminderNextDueAt(scheduleInput, timezone, now);
}

/**
 * Advance `nextDueAt` past the current slot. Used after a disabled-module
 * skip, where nothing the reminder could deliver is left for this cycle.
 */
async function advanceNextDue(
  prisma: PrismaClient,
  reminder: RollableReminder,
  timezone: string,
  now: Date,
): Promise<void> {
  const nextDueAt = nextSlotAfterReminder(reminder, timezone, now);
  await prisma.measurementReminder.update({
    where: { id: reminder.id },
    data: { nextDueAt },
  });
}
