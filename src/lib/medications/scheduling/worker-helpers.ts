/**
 * v1.5.0 — worker-side adapters for the canonical recurrence engine.
 *
 * Bridges the Prisma `Medication` + `MedicationSchedule` row shape the
 * reminder worker reads against `src/lib/medications/scheduling/recurrence.ts`'s
 * `CanonicalSchedule` + `RecurrenceContext` shapes. Keeps the worker file
 * focused on phase math + dispatch and concentrates the cadence-decoding
 * surface in one small, easily unit-testable module.
 *
 * Closes the pre-existing `intervalWeeks` bi-weekly bug
 * (`grep intervalWeeks src/lib/jobs/reminder-worker.ts` returned zero
 * hits before v1.5) by routing every "does today emit a slot?"
 * decision through the canonical engine. The engine prefers the new
 * `rrule` field, falls back to the legacy `daysOfWeek` string only
 * when neither `rrule` nor `rollingIntervalDays` are populated — and
 * the legacy fallback path now honours `intervalWeeks > 1`, which the
 * pre-v1.5 worker did not.
 */
import {
  type CanonicalSchedule,
  type RecurrenceContext,
  type ScheduleType,
  occurrencesBetween,
} from "@/lib/medications/scheduling/recurrence";

/**
 * Minimal Prisma-shape projection used by the worker. Mirrors the
 * fields the canonical engine consumes from a `MedicationSchedule`
 * row — kept narrow so a caller can `select` exactly these columns
 * without pulling the full Prisma type.
 */
export interface WorkerScheduleRow {
  id: string;
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  timesOfDay: string[];
  reminderGraceMinutes: number | null;
  rrule: string | null;
  rollingIntervalDays: number | null;
  /**
   * v1.7.0 — schedule-type + cyclic phase. The Prisma column is the
   * `MedicationScheduleType` enum (string-valued at runtime), so a plain
   * string assignment matches `ScheduleType`. Rows selected before the
   * v1.7.0 read-flip that omit these fields default to SCHEDULED via the
   * adapter below.
   */
  scheduleType?: ScheduleType | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
}

/** Minimal `Medication` projection used by the worker. */
export interface WorkerMedicationRow {
  id: string;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
}

/**
 * Adapt a Prisma `MedicationSchedule` row to the canonical engine's
 * `CanonicalSchedule` shape. Pure / synchronous; no DB access.
 */
export function buildCanonicalSchedule(
  schedule: WorkerScheduleRow,
): CanonicalSchedule {
  return {
    id: schedule.id,
    rrule: schedule.rrule,
    rollingIntervalDays: schedule.rollingIntervalDays,
    timesOfDay: schedule.timesOfDay,
    daysOfWeek: schedule.daysOfWeek,
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    reminderGraceMinutes: schedule.reminderGraceMinutes,
    scheduleType: schedule.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: schedule.cyclicOnWeeks ?? null,
    cyclicOffWeeks: schedule.cyclicOffWeeks ?? null,
  };
}

/** Build the canonical engine context from worker-loop state. */
export function buildRecurrenceContext(input: {
  medication: WorkerMedicationRow;
  userTz: string;
  lastIntakeAt: Date | null;
}): RecurrenceContext {
  return {
    medication: {
      id: input.medication.id,
      startsOn: input.medication.startsOn,
      endsOn: input.medication.endsOn,
      oneShot: input.medication.oneShot,
      createdAt: input.medication.createdAt,
    },
    timeZone: input.userTz,
    lastIntakeAt: input.lastIntakeAt,
  };
}

/**
 * Does the schedule emit at least one occurrence somewhere in
 * `[todayStart, todayEnd]`? The reminder worker calls this once per
 * `(medication, schedule)` pair on each 15-minute tick — replaces the
 * legacy weekday-only filter (`recurrence.daysOfWeek.length > 0 &&
 * !recurrence.daysOfWeek.includes(todayDow)`) at
 * `src/lib/jobs/reminder-worker.ts:514`.
 *
 * Honours every cadence the canonical engine supports:
 *   - one-shot (only true on the medication's `startsOn` day)
 *   - rolling (true when `lastIntakeAt + N days` lands inside today)
 *   - RRULE (true when today is a matching weekday/monthday/etc.)
 *   - legacy `daysOfWeek` string (with `intervalWeeks > 1` honoured —
 *     the pre-v1.5 worker silently dropped this; v1.5 closes the bug)
 *   - `endsOn` cap (false after the course ends)
 *
 * Pure; no DB access. The caller threads `lastIntakeAt` and `userTz`
 * in via `buildRecurrenceContext`.
 */
export function scheduleEmitsInWindow(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return occurrencesBetween(schedule, windowStart, windowEnd, ctx).length > 0;
}

/**
 * Minimal Prisma surface the missed-dose guard needs — just a `count`
 * over `MedicationIntakeEvent`. Keeps the helper unit-testable with a
 * tiny fake and the worker passing its real client.
 */
interface IntakeCountClient {
  medicationIntakeEvent: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
}

/**
 * v1.8.2 — decide whether the reminder worker should mint a RED-phase
 * pending `REMINDER` row for the given slot.
 *
 * Returns `false` (skip the mint) when the slot already carries either:
 *   - an existing pending `REMINDER` row (P2002-collision avoidance; the
 *     `deletedAt: null` filter is intentionally omitted because a
 *     tombstoned REMINDER row still occupies the `(userId, medicationId,
 *     scheduledFor, source)` unique slot), OR
 *   - an ACTIONED row — `takenAt` set OR `skipped` — from ANY source,
 *     restricted to live rows (`deletedAt: null`). The intake write
 *     paths snap a "Genommen" / "Übersprungen" write onto this exact
 *     canonical slot instant via a source-agnostic update, so a dose the
 *     user acted on before the RED phase opens already has a live
 *     taken/skipped row here. Without this arm the worker would mint a
 *     pending REMINDER row alongside the user's WEB/API taken row — the
 *     duplicate-intake bug — because the two differ by `source` and the
 *     unique index would not collide.
 *
 * `scheduledFor` must be the canonical `localHmAsUtc` slot instant the
 * projector + write paths use, so the existence probes match byte-for-byte.
 */
export async function shouldMintMissedDoseRow(
  client: IntakeCountClient,
  slot: { userId: string; medicationId: string; scheduledFor: Date },
): Promise<boolean> {
  const existingPendingReminder = await client.medicationIntakeEvent.count({
    where: {
      medicationId: slot.medicationId,
      userId: slot.userId,
      scheduledFor: slot.scheduledFor,
      takenAt: null,
      source: "REMINDER",
    },
  });
  if (existingPendingReminder > 0) return false;

  const existingActioned = await client.medicationIntakeEvent.count({
    where: {
      medicationId: slot.medicationId,
      userId: slot.userId,
      scheduledFor: slot.scheduledFor,
      deletedAt: null,
      OR: [{ takenAt: { not: null } }, { skipped: true }],
    },
  });
  return existingActioned === 0;
}
