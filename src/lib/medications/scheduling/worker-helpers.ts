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
  type DoseWindowEntry,
  type RecurrenceContext,
  type ScheduleType,
  occurrencesBetween,
} from "@/lib/medications/scheduling/recurrence";
import {
  hhmmToMinutes,
  hhmmToMinutesOrNull,
} from "@/lib/medications/scheduling/hhmm";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import { localHmAsUtc } from "@/lib/tz/local-day";

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
  /**
   * v1.15.18 — per-dose on-time windows. The Prisma column is `Json?`, so a
   * selected row surfaces it as `Prisma.JsonValue` (or `null`). The adapter
   * normalises it to a `DoseWindowEntry[]` (dropping malformed entries) so the
   * band minter never has to defend against an arbitrary JSON shape.
   */
  doseWindows?: unknown;
}

/** Minimal `Medication` projection used by the worker. */
export interface WorkerMedicationRow {
  id: string;
  startsOn: Date | null;
  endsOn: Date | null;
  /** #1280 — the instant "End course" ended the course (see the engine). */
  endedAt: Date | null;
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
  const scheduleType = schedule.scheduleType ?? "SCHEDULED";
  const isEmptyLegacyDaily =
    scheduleType !== "PRN" &&
    schedule.timesOfDay.length === 0 &&
    schedule.rrule === null &&
    schedule.rollingIntervalDays === null &&
    (schedule.daysOfWeek === null || schedule.daysOfWeek.trim() === "");

  return {
    id: schedule.id,
    rrule: schedule.rrule,
    rollingIntervalDays: schedule.rollingIntervalDays,
    timesOfDay: isEmptyLegacyDaily
      ? [schedule.windowStart]
      : schedule.timesOfDay,
    daysOfWeek: schedule.daysOfWeek,
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    reminderGraceMinutes: schedule.reminderGraceMinutes,
    scheduleType,
    cyclicOnWeeks: schedule.cyclicOnWeeks ?? null,
    cyclicOffWeeks: schedule.cyclicOffWeeks ?? null,
    doseWindows: normaliseDoseWindows(schedule.doseWindows),
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * v1.15.18 — coerce the persisted `dose_windows` JSON into a clean
 * `DoseWindowEntry[]`. Drops anything that isn't an `{ timeOfDay, start, end }`
 * triple of well-formed HH:mm strings with `start <= end` — the column is
 * Zod-validated on write, but a hand-edited or legacy row must never crash the
 * read/write band paths. Returns `null` (the default-derivation signal) when
 * nothing usable survives.
 */
export function normaliseDoseWindows(raw: unknown): DoseWindowEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DoseWindowEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { timeOfDay, start, end } = item as Record<string, unknown>;
    if (
      typeof timeOfDay !== "string" ||
      typeof start !== "string" ||
      typeof end !== "string" ||
      !HHMM_RE.test(timeOfDay) ||
      !HHMM_RE.test(start) ||
      !HHMM_RE.test(end) ||
      hhmmToMinutes(start) > hhmmToMinutes(end)
    ) {
      continue;
    }
    out.push({ timeOfDay, start, end });
  }
  return out.length > 0 ? out : null;
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
      endedAt: input.medication.endedAt,
      oneShot: input.medication.oneShot,
      createdAt: input.medication.createdAt,
    },
    timeZone: input.userTz,
    lastIntakeAt: input.lastIntakeAt,
    // v1.40 (#1024) — a medication: `startsOn` is a course start.
    rollingAnchor: "courseStart",
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
 * Resolve one slot's phase bounds as real instants.
 *
 * Explicit dose windows and a containing legacy single-slot window are
 * configured as wall-clock HH:mm values, so their endpoints are materialised
 * independently in the user's timezone and overnight bounds select the
 * adjacent local date around the slot. Deriving them as minute offsets from
 * the slot would drift across a DST transition. When a first-class one-slot
 * time has moved outside stale legacy clocks, their duration is instead
 * anchored at the actual slot. A configured reminder grace remains an elapsed
 * duration from the slot. Multi-slot defaults use the shared grace and are
 * capped at the next sibling's wall-clock instant.
 *
 * Intake suppression deliberately does not use these bounds.
 */
export interface SlotPhaseWindow {
  start: Date;
  end: Date;
}

export function resolveSlotPhaseWindow(
  schedule: Pick<
    WorkerScheduleRow,
    "windowStart" | "windowEnd" | "timesOfDay" | "reminderGraceMinutes"
  >,
  slotTime: string,
  doseWindows: DoseWindowEntry[] | null,
  slotInstant: Date,
  userTz: string,
): SlotPhaseWindow {
  const slotMinute = hhmmToMinutesOrNull(slotTime);
  const explicit = doseWindows?.find((window) => window.timeOfDay === slotTime);
  if (explicit) {
    const startMinute = hhmmToMinutesOrNull(explicit.start);
    const endMinute = hhmmToMinutesOrNull(explicit.end);
    if (
      startMinute !== null &&
      endMinute !== null &&
      startMinute <= endMinute
    ) {
      const start = localMinuteAsUtc(slotInstant, userTz, startMinute);
      const end = localMinuteAsUtc(slotInstant, userTz, endMinute);
      return {
        start,
        end: end.getTime() < start.getTime() ? start : end,
      };
    }
  }

  const configuredGrace = schedule.reminderGraceMinutes;
  if (
    typeof configuredGrace === "number" &&
    Number.isFinite(configuredGrace) &&
    configuredGrace > 0
  ) {
    return {
      start: slotInstant,
      end: new Date(slotInstant.getTime() + configuredGrace * 60_000),
    };
  }

  const slots = schedule.timesOfDay
    .map(hhmmToMinutesOrNull)
    .filter((minute): minute is number => minute !== null)
    .sort((a, b) => a - b);
  if (slots.length <= 1 || slotMinute === null) {
    const startMinute = hhmmToMinutesOrNull(schedule.windowStart);
    const endMinute = hhmmToMinutesOrNull(schedule.windowEnd);
    if (slotMinute === null || startMinute === null || endMinute === null) {
      return { start: slotInstant, end: slotInstant };
    }

    const wrapsMidnight = endMinute < startMinute;
    const slotIsInsideConfiguredWindow = wrapsMidnight
      ? slotMinute >= startMinute || slotMinute <= endMinute
      : slotMinute >= startMinute && slotMinute <= endMinute;

    // A first-class single slot may outlive stale legacy windowStart/windowEnd
    // clocks. Preserve that legacy span as a duration, but anchor it at the
    // actual slot instead of opening a phase at unrelated wall-clock times.
    if (schedule.timesOfDay.length > 0 && !slotIsInsideConfiguredWindow) {
      const durationMinutes =
        (((endMinute - startMinute) % (24 * 60)) + 24 * 60) % (24 * 60);
      return {
        start: slotInstant,
        end: new Date(slotInstant.getTime() + durationMinutes * 60_000),
      };
    }

    if (!wrapsMidnight) {
      const start = localMinuteAsUtc(slotInstant, userTz, startMinute);
      const end = localMinuteAsUtc(slotInstant, userTz, endMinute);
      return {
        start,
        end: end.getTime() < start.getTime() ? start : end,
      };
    }

    const localNoon = localHmAsUtc(slotInstant, userTz, 12, 0);

    if (slotMinute >= startMinute) {
      return {
        start: localMinuteAsUtc(slotInstant, userTz, startMinute),
        end: localMinuteAsUtc(
          new Date(localNoon.getTime() + 24 * 60 * 60_000),
          userTz,
          endMinute,
        ),
      };
    }

    return {
      start: localMinuteAsUtc(
        new Date(localNoon.getTime() - 24 * 60 * 60_000),
        userTz,
        startMinute,
      ),
      end: localMinuteAsUtc(slotInstant, userTz, endMinute),
    };
  }

  const currentIndex = slots.indexOf(slotMinute);
  const nextMinute =
    currentIndex >= 0 && currentIndex < slots.length - 1
      ? slots[currentIndex + 1]
      : slots[0];
  const nextReference =
    nextMinute > slotMinute
      ? slotInstant
      : new Date(
          localHmAsUtc(slotInstant, userTz, 12, 0).getTime() + 24 * 60 * 60_000,
        );
  const nextSlot = localMinuteAsUtc(nextReference, userTz, nextMinute);
  const defaultEnd = new Date(
    slotInstant.getTime() + DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes * 60_000,
  );
  const cappedEnd = Math.min(defaultEnd.getTime(), nextSlot.getTime());
  return {
    start: slotInstant,
    end: new Date(Math.max(slotInstant.getTime(), cappedEnd)),
  };
}

function localMinuteAsUtc(
  dayReference: Date,
  userTz: string,
  minuteOfDay: number,
): Date {
  return localHmAsUtc(
    dayReference,
    userTz,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );
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
