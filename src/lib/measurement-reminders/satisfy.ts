/**
 * v1.18.1 — the ONE shared satisfaction primitive for the Vorsorge /
 * measurement-reminder engine.
 *
 * Every path that marks a reminder's cadence fulfilled routes through
 * `satisfyReminder`: the manual "Erledigt" route, the cron auto-resolve,
 * and the eventful ingest-driven satisfaction worker. No duplicated
 * reschedule logic — one place stamps `lastSatisfiedAt` and recomputes the
 * server-authoritative `nextDueAt`.
 *
 * Invariants the primitive owns:
 *
 *   1. **Forward-only.** `lastSatisfiedAt` only ever moves forward. A
 *      cron poll and an ingest enqueue can both fire for the same reading;
 *      the second is a no-op (returns `false`) rather than re-stamping an
 *      older instant. This is what makes the cron a safe idempotent
 *      safety-net behind the eventful hook.
 *   2. **Re-anchored reschedule.** `nextDueAt` is recomputed via the
 *      canonical recurrence engine (`computeReminderNextDueAt`) from
 *      `max(satisfiedAt, lastSkippedAt)` — the satisfy instant, unless the
 *      user has since skipped, in which case a BACKDATED real result is
 *      recorded as `lastSatisfiedAt` but never drags the due date back
 *      behind the skip decision (v1.37.20, #223).
 *   3. **Ledger append.** A successful satisfy appends one
 *      `MeasurementReminderEvent` row (iOS #68) with `onTime` derived at
 *      write time against the pre-event `nextDueAt` — the only moment that
 *      value still exists.
 *   4. **Snooze clearing.** A satisfy recomputes `nextDueAt`, so it nulls
 *      `snoozedUntil` — the snooze cursor never outlives the cycle it
 *      pushed back.
 *
 * Pure-ish: it reads the row fields it is handed and issues one conditional
 * update plus one ledger insert. The caller supplies the reminder row, the
 * user's timezone, and which engine path it is (`source`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";

/**
 * Which engine path produced a ledger event. Closed set — the ledger's
 * `source` column is asserted here, not free text.
 *
 * Declared as a runtime tuple as well as a type (v1.37.20, #223 / iOS #68):
 * the backup payload schema validates the `source` a restore is handed
 * against this exact set, and a Zod enum needs the values at runtime. One
 * declaration, so the validator cannot drift from the engine.
 */
export const REMINDER_EVENT_SOURCES = [
  "manual",
  "auto_measurement",
  "auto_lab",
  "telegram",
  "vaccination",
  "encounter",
  "skip",
] as const;

export type ReminderEventSource = (typeof REMINDER_EVENT_SOURCES)[number];

/**
 * The reminder fields `satisfyReminder` needs. A subset of the Prisma row
 * so callers (and tests) can construct it without the full model.
 * `userId` and the pre-event `nextDueAt` feed the ledger append;
 * `lastSkippedAt` feeds the skip-aware re-anchor.
 */
export interface SatisfiableReminder {
  id: string;
  userId: string;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  nextDueAt: Date | null;
  lastSatisfiedAt: Date | null;
  lastSkippedAt: Date | null;
  createdAt: Date;
  /** Course-window end; without it a finite course reschedules forever. */
  endsOn: Date | null;
}

export interface SatisfyResult {
  /** True when the reminder was advanced; false when the event was older
   *  than (or equal to) the existing `lastSatisfiedAt` (forward-only
   *  no-op). */
  satisfied: boolean;
  /** The recomputed next-due instant when satisfied, else `null`. */
  nextDueAt: Date | null;
}

/**
 * `onTime` is derived at write time, against the reminder's `nextDueAt` as
 * it stood BEFORE this event re-anchored it: the event landed at or before
 * the due instant, or the cadence had no computable due (a one-shot whose
 * slot already fired counts as late only while a due instant exists to be
 * late against). After the write the pre-event value is gone, which is why
 * clients consume this resolved boolean and never re-derive it.
 */
function deriveOnTime(preEventNextDueAt: Date | null, occurredAt: Date) {
  return (
    preEventNextDueAt === null ||
    occurredAt.getTime() <= preEventNextDueAt.getTime()
  );
}

/**
 * Mark a reminder's cadence satisfied at `satisfiedAt` and reschedule.
 *
 * Forward-only: if `satisfiedAt` is not strictly after the existing
 * `lastSatisfiedAt`, nothing is written and `{ satisfied: false }` is
 * returned. Otherwise stamps `lastSatisfiedAt = satisfiedAt`, recomputes
 * `nextDueAt` anchored at `max(satisfiedAt, lastSkippedAt)`, clears any
 * snooze, appends the SATISFIED ledger row, and returns
 * `{ satisfied: true, nextDueAt }`.
 *
 * HARD INVARIANT (the mirror of the skip primitive's): only a satisfy ever
 * writes `lastSatisfiedAt`. Skip and snooze never touch it.
 */
export async function satisfyReminder(
  prisma: PrismaClient,
  reminder: SatisfiableReminder,
  timezone: string,
  satisfiedAt: Date,
  source: Exclude<ReminderEventSource, "skip">,
): Promise<SatisfyResult> {
  // Forward-only guard. A null `lastSatisfiedAt` always advances. Equal
  // instants are a no-op so a cron poll behind an already-applied ingest
  // hook doesn't churn the row.
  if (
    reminder.lastSatisfiedAt !== null &&
    satisfiedAt.getTime() <= reminder.lastSatisfiedAt.getTime()
  ) {
    return { satisfied: false, nextDueAt: null };
  }

  // v1.37.20 (#223) — skip-aware anchor: a backdated real result (an old
  // reading synced late, a corrected visit date) is honestly recorded as
  // `lastSatisfiedAt`, but the NEXT due date never lands behind a skip the
  // user made after that event. Without the max() a fresh skip's re-anchor
  // would be silently undone by any older reading arriving afterwards.
  const anchorAt =
    reminder.lastSkippedAt !== null &&
    reminder.lastSkippedAt.getTime() > satisfiedAt.getTime()
      ? reminder.lastSkippedAt
      : satisfiedAt;

  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: anchorAt,
    createdAt: reminder.createdAt,
    endsOn: reminder.endsOn,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, anchorAt);

  // v1.18.1 — close the forward-only TOCTOU: the in-memory guard above can
  // pass concurrently in the cron poll AND the eventful worker for the same
  // reading. Make the write itself conditional so exactly one wins. The
  // `updateMany` filter re-asserts the forward-only invariant against the
  // CURRENT row state; a racing writer that already advanced `lastSatisfiedAt`
  // to >= satisfiedAt yields `count === 0`, which we treat as a no-op rather
  // than re-stamping an older instant.
  const result = await prisma.measurementReminder.updateMany({
    where: {
      id: reminder.id,
      OR: [{ lastSatisfiedAt: null }, { lastSatisfiedAt: { lt: satisfiedAt } }],
    },
    // A recompute of `nextDueAt` clears the snooze cursor — the real event
    // ended the cycle the snooze was pushing back.
    data: { lastSatisfiedAt: satisfiedAt, nextDueAt, snoozedUntil: null },
  });
  if (result.count === 0) {
    return { satisfied: false, nextDueAt: null };
  }

  // Ledger append (iOS #68): exactly one row per applied satisfy, from
  // every path, because every path is this primitive. Written after the
  // conditional update so a forward-only no-op leaves no row.
  await prisma.measurementReminderEvent.create({
    data: {
      userId: reminder.userId,
      reminderId: reminder.id,
      kind: "SATISFIED",
      occurredAt: satisfiedAt,
      onTime: deriveOnTime(reminder.nextDueAt, satisfiedAt),
      source,
    },
  });

  return { satisfied: true, nextDueAt };
}

export interface SkipResult {
  /** True when the skip applied; false when it was a forward-only no-op
   *  (the row already advanced past the skip instant). */
  skipped: boolean;
  /** The recomputed next-due instant when skipped, else `null`. */
  nextDueAt: Date | null;
}

/**
 * v1.37.20 (#223) — honestly skip the current due cycle at `skippedAt`
 * (always the server clock; the route takes no body).
 *
 * The interval restarts from the skip instant: `nextDueAt` is recomputed
 * with the skip standing in as the rolling anchor (an rrule cadence walks
 * to its next occurrence strictly after the skip). `lastSkippedAt` is
 * stamped, `skipCount` incremented, any snooze cleared.
 *
 * HARD INVARIANT: `lastSatisfiedAt` is NEVER touched here. A skip is not a
 * completion — the ledger records it as `SKIPPED` and every surface that
 * shows "last done" keeps showing the last real result.
 *
 * Forward-only against BOTH cursors: a skip at/behind the last satisfy or
 * the last skip is a no-op, enforced in the conditional `updateMany` (the
 * same TOCTOU pattern `satisfyReminder` uses).
 */
export async function skipReminder(
  prisma: PrismaClient,
  reminder: SatisfiableReminder,
  timezone: string,
  skippedAt: Date,
): Promise<SkipResult> {
  const floor = Math.max(
    reminder.lastSatisfiedAt?.getTime() ?? 0,
    reminder.lastSkippedAt?.getTime() ?? 0,
  );
  if (floor > 0 && skippedAt.getTime() <= floor) {
    return { skipped: false, nextDueAt: null };
  }

  // The skip stands in as the rolling anchor: skip + interval at the notify
  // hour, or the next rrule occurrence strictly after the skip.
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: skippedAt,
    createdAt: reminder.createdAt,
    endsOn: reminder.endsOn,
  };
  const nextDueAt = computeReminderNextDueAt(
    scheduleInput,
    timezone,
    skippedAt,
  );

  const result = await prisma.measurementReminder.updateMany({
    where: {
      id: reminder.id,
      AND: [
        {
          OR: [
            { lastSatisfiedAt: null },
            { lastSatisfiedAt: { lt: skippedAt } },
          ],
        },
        {
          OR: [{ lastSkippedAt: null }, { lastSkippedAt: { lt: skippedAt } }],
        },
      ],
    },
    // `lastSatisfiedAt` is conspicuously absent — see the invariant above.
    data: {
      lastSkippedAt: skippedAt,
      skipCount: { increment: 1 },
      snoozedUntil: null,
      nextDueAt,
    },
  });
  if (result.count === 0) {
    return { skipped: false, nextDueAt: null };
  }

  await prisma.measurementReminderEvent.create({
    data: {
      userId: reminder.userId,
      reminderId: reminder.id,
      kind: "SKIPPED",
      occurredAt: skippedAt,
      onTime: deriveOnTime(reminder.nextDueAt, skippedAt),
      source: "skip",
    },
  });

  return { skipped: true, nextDueAt };
}
